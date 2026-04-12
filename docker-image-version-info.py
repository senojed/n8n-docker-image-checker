#!/usr/bin/env python3
import base64
import json
import platform
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


VERSION_LABEL_KEYS = (
    "org.opencontainers.image.version",
    "org.label-schema.version",
)

VERSION_ENV_KEYS = (
    "IMMICH_SOURCE_REF",
    "IMMICH_BUILD_IMAGE",
    "NEXTCLOUD_VERSION",
    "APP_VERSION",
    "VERSION",
)

FLOATING_TAGS = {
    "latest",
    "release",
    "stable",
    "main",
    "master",
    "nightly",
    "edge",
}

CACHE_FILE = Path("/opt/docker/docker-image-version-info-cache.json")
CACHE_TTL_SECONDS = 6 * 60 * 60


def run_command(args):
    completed = subprocess.run(args, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "command failed").strip())
    return completed.stdout


def load_cache():
    if not CACHE_FILE.exists():
        return {}
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_cache(cache):
    try:
        CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def get_cached_entry(cache, key, max_age=None):
    entry = (cache or {}).get(key)
    if not entry:
        return None

    fetched_at = entry.get("fetchedAt")
    if max_age is not None and fetched_at:
        try:
            age = max(0, int(time.time() - float(fetched_at)))
        except Exception:
            age = None
        if age is None or age > max_age:
            return None

    data = dict(entry.get("data") or {})
    if not data:
        return None

    return data


def cache_age_note(cache, image_ref):
    entry = (cache or {}).get(image_ref) or {}
    fetched_at = entry.get("fetchedAt")
    if not fetched_at:
        return "Registry je rate limited, pouzita starsi cache target metadata."
    try:
        age_seconds = max(0, int(time.time() - float(fetched_at)))
    except Exception:
        return "Registry je rate limited, pouzita starsi cache target metadata."

    age_minutes = age_seconds // 60
    if age_minutes < 60:
        return f"Registry je rate limited, pouzita cache target metadata stara asi {age_minutes} min."

    age_hours = age_minutes // 60
    return f"Registry je rate limited, pouzita cache target metadata stara asi {age_hours} h."


def fetch_json(url):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "codex-docker-update-inspector/1.0",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def short_digest(value):
    if not value:
        return None
    if value.startswith("sha256:"):
        value = value[7:]
    return value[:12]


def image_tag(image_ref):
    image_ref = (image_ref or "").strip()
    if not image_ref or "@" in image_ref:
        return None

    slash_index = image_ref.rfind("/")
    colon_index = image_ref.rfind(":")
    if colon_index <= slash_index:
        return None

    return image_ref[colon_index + 1 :]


def version_from_tag(image_ref):
    tag = image_tag(image_ref)
    if not tag:
        return None, None
    if tag.lower() in FLOATING_TAGS:
        return None, None
    return tag, "tag"


def sanitize_release_tag(tag):
    value = (tag or "").strip()
    value = value.replace("refs/tags/", "")
    if value.lower().startswith("v") and len(value) > 1 and value[1].isdigit():
        return value[1:]
    return value or None


def comparable_version(value):
    raw = (value or "").strip()
    if raw.lower().startswith("v") and len(raw) > 1 and raw[1].isdigit():
        return raw[1:]
    return raw


def env_to_dict(env_list):
    env_map = {}
    for item in env_list or []:
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        env_map[key] = value
    return env_map


def pick_version(labels, env_map, image_ref):
    for key in VERSION_LABEL_KEYS:
        value = (labels or {}).get(key)
        if value:
            return value, f"label:{key}"

    for key in VERSION_ENV_KEYS:
        value = (env_map or {}).get(key)
        if value:
            return value, f"env:{key}"

    return version_from_tag(image_ref)


def platform_key():
    machine = platform.machine().lower()
    arch_map = {
        "x86_64": "amd64",
        "amd64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }
    arch = arch_map.get(machine, machine)
    return f"linux/{arch}"


def choose_remote_image(image_map):
    desired = platform_key()
    if desired in image_map:
        return image_map[desired]

    for key, value in image_map.items():
        if key.startswith("linux/"):
            return value

    for value in image_map.values():
        return value

    return {}


def inspect_current(service):
    container_id = run_command(
        [
            "docker",
            "ps",
            "-q",
            "--filter",
            f"label=com.docker.compose.service={service}",
        ]
    ).strip()

    if not container_id:
        return {
            "currentVersion": None,
            "currentVersionSource": None,
            "currentDigest": None,
            "currentDigestShort": None,
            "currentImageRef": None,
            "note": "Sluzba aktualne nema bezici container, current verze se neda precist.",
        }

    raw = run_command(["docker", "inspect", container_id])
    data = json.loads(raw)[0]
    labels = ((data.get("Config") or {}).get("Labels")) or {}
    env_map = env_to_dict(((data.get("Config") or {}).get("Env")) or [])
    image_ref = (data.get("Config") or {}).get("Image")
    version, version_source = pick_version(labels, env_map, image_ref)
    digest = labels.get("com.docker.compose.image") or data.get("Image")

    return {
        "currentVersion": version,
        "currentVersionSource": version_source,
        "currentDigest": digest,
        "currentDigestShort": short_digest(digest),
        "currentImageRef": image_ref,
    }


def inspect_target(image_ref, cache):
    cached = get_cached_entry(cache, image_ref, CACHE_TTL_SECONDS)
    if cached:
        return cached

    raw = run_command(
        ["docker", "buildx", "imagetools", "inspect", image_ref, "--format", "{{json .}}"]
    )
    data = json.loads(raw)
    remote_image = choose_remote_image((data.get("image") or {}))
    config = (remote_image or {}).get("config") or {}
    labels = config.get("Labels") or {}
    env_map = env_to_dict(config.get("Env") or [])
    version, version_source = pick_version(labels, env_map, image_ref)
    digest = (data.get("manifest") or {}).get("digest")

    result = {
        "targetVersion": version,
        "targetVersionSource": version_source,
        "targetDigest": digest,
        "targetDigestShort": short_digest(digest),
    }
    cache[image_ref] = {
        "fetchedAt": time.time(),
        "data": result,
    }
    return result


def github_latest_release_version(release_url, cache):
    release_url = (release_url or "").strip()
    match = release_url.replace("https://github.com/", "").replace("http://github.com/", "")
    match = match.strip("/")
    parts = match.split("/")
    if len(parts) < 3 or parts[2] != "releases":
        return None

    owner, repo = parts[0], parts[1]
    cache_key = f"release:{owner}/{repo}"
    cached = get_cached_entry(cache, cache_key, CACHE_TTL_SECONDS)
    if cached:
        return cached

    data = fetch_json(f"https://api.github.com/repos/{owner}/{repo}/releases/latest")
    tag_name = sanitize_release_tag(data.get("tag_name"))
    if not tag_name:
        return None

    result = {
        "targetVersion": tag_name,
        "targetVersionSource": f"github-release:{owner}/{repo}",
    }
    cache[cache_key] = {
        "fetchedAt": time.time(),
        "data": result,
    }
    return result


def build_note(current_info, target_info):
    current_digest = current_info.get("currentDigest")
    target_digest = target_info.get("targetDigest")
    current_version = comparable_version(current_info.get("currentVersion"))
    target_version = comparable_version(target_info.get("targetVersion"))

    if current_digest and target_digest and current_digest == target_digest:
        return "Remote digest uz odpovida aktualnimu image."

    if (
        current_version
        and target_version
        and current_version == target_version
        and current_digest
        and target_digest
        and current_digest != target_digest
    ):
        return "Version label zustal stejny, ale digest se zmenil. U floating tagu je to bezne."

    if not target_version:
        return "Cilovou verzi se nepodarilo precist z OCI metadata, k dispozici je jen tag nebo digest."

    return None


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"items": [], "error": "Expected single base64 payload argument"}))
        return 1

    try:
        raw_arg = sys.argv[1]
        if raw_arg.startswith("url:"):
            payload = json.loads(urllib.parse.unquote(raw_arg[4:]))
        else:
            payload = json.loads(base64.b64decode(raw_arg).decode("utf-8"))
    except Exception as exc:
        print(json.dumps({"items": [], "error": f"Invalid payload: {exc}"}))
        return 1

    cache = load_cache()
    items = []
    for entry in payload:
        service = entry.get("service")
        image_ref = entry.get("image")
        release_url = entry.get("releaseUrl")
        result = {
            "service": service,
            "image": image_ref,
            "label": entry.get("label"),
        }

        try:
            current_info = inspect_current(service)
            try:
                target_info = inspect_target(image_ref, cache)
            except Exception as exc:
                error_text = str(exc)
                if "429 Too Many Requests" in error_text or "toomanyrequests" in error_text.lower():
                    cached_target = get_cached_entry(cache, image_ref, None)
                    if cached_target:
                        target_info = dict(cached_target)
                        target_info["note"] = cache_age_note(cache, image_ref)
                    else:
                        raise
                else:
                    raise
            if not target_info.get("targetVersion") and release_url:
                release_fallback = github_latest_release_version(release_url, cache)
                if release_fallback:
                    target_info.update(release_fallback)
            result.update(current_info)
            result.update(target_info)
            result["isAlreadyCurrent"] = bool(
                result.get("currentDigest")
                and result.get("targetDigest")
                and result["currentDigest"] == result["targetDigest"]
            )
            result["note"] = build_note(current_info, target_info) or target_info.get("note") or current_info.get("note")
        except Exception as exc:
            result["error"] = str(exc)

        items.append(result)

    save_cache(cache)
    print(json.dumps({"items": items}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
