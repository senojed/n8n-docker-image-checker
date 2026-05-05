#!/usr/bin/env python3
import base64
import json
import os
import platform
import re
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


def default_cache_file():
    env_path = os.environ.get("DOCKER_IMAGE_VERSION_INFO_CACHE")
    if env_path:
        return Path(env_path)

    candidates = [
        Path(__file__).resolve().parent / "docker-image-version-info-cache.json",
        Path("/opt/docker/docker-image-version-info-cache.json"),
        Path("/tmp/docker-image-version-info-cache.json"),
    ]
    for candidate in candidates:
        parent = candidate.parent
        if parent.exists() and os.access(parent, os.W_OK):
            return candidate

    return Path("/tmp/docker-image-version-info-cache.json")


CACHE_FILE = default_cache_file()
CACHE_TTL_SECONDS = 6 * 60 * 60


def run_command(args):
    completed = subprocess.run(args, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "command failed").strip())
    return completed.stdout


def try_run_command(args):
    completed = subprocess.run(args, capture_output=True, text=True)
    if completed.returncode != 0:
        return None
    return ((completed.stdout or "") + (completed.stderr or "")).strip()


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
    if "@" in value:
        value = value.rsplit("@", 1)[1]
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


def version_sort_key(value):
    raw = comparable_version(value)
    if not raw:
        return None

    parts = []
    for token in re.split(r"([0-9]+)", raw):
        if not token:
            continue
        if token.isdigit():
            parts.append((0, int(token)))
        else:
            parts.append((1, token.lower()))

    return tuple(parts) or None


def version_is_newer(lhs, rhs):
    left = version_sort_key(lhs)
    right = version_sort_key(rhs)
    if not left or not right:
        return False

    try:
        return left > right
    except TypeError:
        return False


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


def image_repo_digest_for_ref(image_ref, running_image_id):
    if not image_ref or "@" in image_ref or not running_image_id:
        return None

    raw = try_run_command(["docker", "image", "inspect", image_ref])
    if not raw:
        return None

    try:
        image_data = json.loads(raw)[0]
    except Exception:
        return None

    if image_data.get("Id") != running_image_id:
        return None

    repo_digests = image_data.get("RepoDigests") or []
    if not repo_digests:
        return None

    normalized_image = image_ref.rsplit(":", 1)[0] if ":" in image_ref.rsplit("/", 1)[-1] else image_ref
    for repo_digest in repo_digests:
        if repo_digest.startswith(f"{normalized_image}@"):
            return repo_digest.rsplit("@", 1)[1]

    return repo_digests[0].rsplit("@", 1)[1] if "@" in repo_digests[0] else repo_digests[0]


def parse_first_version(text):
    match = re.search(r"v?([0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9_.-]+)?)", text or "")
    return match.group(1) if match else None


def runtime_version(container_id, image_ref):
    image = (image_ref or "").lower()
    probes = []

    if "grafana/" in image:
        probes.append((["docker", "exec", container_id, "grafana", "cli", "--version"], "runtime:grafana-cli"))
    elif "portainer/" in image:
        probes.append((["docker", "exec", container_id, "/portainer", "--version"], "runtime:portainer"))
    elif image.startswith("influxdb") or "/influxdb" in image:
        probes.append((["docker", "exec", container_id, "influxd", "version"], "runtime:influxd"))
        probes.append((["docker", "exec", container_id, "influx", "version"], "runtime:influx"))
    elif "backrest" in image:
        probes.append((["docker", "exec", container_id, "/app/backrest", "--version"], "runtime:backrest"))
        probes.append((["docker", "exec", container_id, "backrest", "--version"], "runtime:backrest"))
    elif "hass-configurator" in image:
        probes.append((["docker", "exec", container_id, "python3", "-m", "pip", "show", "hass-configurator"], "runtime:pip"))

    for command, source in probes:
        output = try_run_command(command)
        version = parse_first_version(output or "")
        if version:
            return version, source

    return None, None


def inspect_local_target(image_ref):
    raw = try_run_command(["docker", "image", "inspect", image_ref])
    if not raw:
        return None

    try:
        image_data = json.loads(raw)[0]
    except Exception:
        return None

    config = image_data.get("Config") or {}
    labels = config.get("Labels") or {}
    env_map = env_to_dict(config.get("Env") or [])
    version, version_source = pick_version(labels, env_map, image_ref)
    repo_digests = image_data.get("RepoDigests") or []
    digest = None

    normalized_image = image_ref.rsplit(":", 1)[0] if ":" in image_ref.rsplit("/", 1)[-1] else image_ref
    for repo_digest in repo_digests:
        if repo_digest.startswith(f"{normalized_image}@"):
            digest = repo_digest.rsplit("@", 1)[1]
            break
    if not digest and repo_digests:
        digest = repo_digests[0].rsplit("@", 1)[1] if "@" in repo_digests[0] else repo_digests[0]

    if not digest:
        digest = image_data.get("Id")

    return {
        "targetVersion": version,
        "targetVersionSource": version_source,
        "targetDigest": digest,
        "targetDigestShort": short_digest(digest),
        "targetDigestSource": "local-image",
        "note": "Registry metadata nejsou dostupna, pouzita metadata lokalne stazeneho tagu.",
    }


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
    if not version:
        version, version_source = runtime_version(container_id, image_ref)

    running_image_id = data.get("Image")
    digest = image_repo_digest_for_ref(image_ref, running_image_id) or labels.get("com.docker.compose.image") or running_image_id

    return {
        "currentVersion": version,
        "currentVersionSource": version_source,
        "currentDigest": digest,
        "currentDigestShort": short_digest(digest),
        "currentImageRef": image_ref,
    }


def is_floating_tag(image_ref):
    tag = image_tag(image_ref)
    return bool(tag and tag.lower() in FLOATING_TAGS)


def should_refresh_cached_target(image_ref, cached_target, current_info):
    if not cached_target or not is_floating_tag(image_ref):
        return False

    current_version = current_info.get("currentVersion")
    target_version = cached_target.get("targetVersion")
    if current_version and target_version and version_is_newer(current_version, target_version):
        return True

    return False


def inspect_target(image_ref, cache, current_info=None):
    cached = get_cached_entry(cache, image_ref, CACHE_TTL_SECONDS)
    if cached and not should_refresh_cached_target(image_ref, cached, current_info or {}):
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
        "targetDigestSource": "registry",
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

    if target_info.get("targetDigestSource") == "local-image" and current_digest and target_digest and current_digest == target_digest:
        return target_info.get("note")

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

    if current_version and target_version and version_is_newer(current_version, target_version):
        return "Aktualni container vypada novejsi nez remote target metadata. U floating tagu probehl refresh cache, ale registry muze byt pozadu."

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
                target_info = inspect_target(image_ref, cache, current_info)
            except Exception as exc:
                error_text = str(exc)
                if "429 Too Many Requests" in error_text or "toomanyrequests" in error_text.lower():
                    cached_target = get_cached_entry(cache, image_ref, None)
                    if cached_target:
                        target_info = dict(cached_target)
                        target_info["note"] = cache_age_note(cache, image_ref)
                    else:
                        local_target = inspect_local_target(image_ref)
                        if local_target:
                            target_info = local_target
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
            local_target_digest = target_info.get("targetDigestSource") == "local-image"
            current_version = comparable_version(result.get("currentVersion"))
            target_version = comparable_version(result.get("targetVersion"))
            result["isAlreadyCurrent"] = bool(
                result.get("currentDigest")
                and result.get("targetDigest")
                and result["currentDigest"] == result["targetDigest"]
                and (
                    not local_target_digest
                    or not target_version
                    or (current_version and current_version == target_version)
                )
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
