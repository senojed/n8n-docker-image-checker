#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="/opt/docker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWED_FILE="${SCRIPT_DIR}/allowed-services.txt"
DEFAULT_AUDIT_LOG_PATH="/var/log/docker-updates/audit.jsonl"
DEFAULT_PRECHECK_DISK_USAGE_LIMIT_PCT=85
DEFAULT_BACKUP_MARKER_MAX_AGE_SECONDS=86400
LOCK_FILE_PATH="${COMPOSE_DIR}/.docker-update-apply.lock"

dry_run=0
operator=""
workflow_execution_id=""
audit_log_path="${DEFAULT_AUDIT_LOG_PATH}"
precheck_disk_usage_limit_pct="${DEFAULT_PRECHECK_DISK_USAGE_LIMIT_PCT}"
backup_marker_path=""
backup_marker_max_age_seconds="${DEFAULT_BACKUP_MARKER_MAX_AGE_SECONDS}"
health_checks_payload_base64=""
services=()
result_emitted=0
current_phase="bootstrap"
host_name="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"

declare -A allowed=()
declare -A compose_services=()
declare -A prev_digests=()
declare -A new_digests=()

array_payload() {
  local -n values_ref=$1
  if [[ ${#values_ref[@]} -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${values_ref[@]}"
}

map_payload() {
  local -n map_ref=$1
  if [[ ${#map_ref[@]} -eq 0 ]]; then
    return 0
  fi
  for key in "${!map_ref[@]}"; do
    [[ -n "${map_ref[$key]}" ]] || continue
    printf '%s=%s\n' "$key" "${map_ref[$key]}"
  done | sort
}

build_result_payload() {
  local status="$1"
  local phase="$2"
  local summary="$3"
  local exit_code="$4"
  local floating_tag_warning="${5:-0}"

  RESULT_STATUS="$status" \
  RESULT_PHASE="$phase" \
  RESULT_SUMMARY="$summary" \
  RESULT_EXIT_CODE="$exit_code" \
  RESULT_DRY_RUN="$dry_run" \
  RESULT_FLOATING_TAG_WARNING="$floating_tag_warning" \
  RESULT_OPERATOR="${operator:-unknown}" \
  RESULT_WORKFLOW_EXECUTION_ID="${workflow_execution_id}" \
  RESULT_HOST="${host_name}" \
  SERVICES_PAYLOAD="$(array_payload services)" \
  PREV_DIGESTS_PAYLOAD="$(map_payload prev_digests)" \
  NEW_DIGESTS_PAYLOAD="$(map_payload new_digests)" \
  python3 - <<'PY'
import json
import os


def lines(name):
    value = os.environ.get(name, "")
    if not value:
        return []
    return [line for line in value.splitlines() if line.strip()]


def key_value_map(name):
    data = {}
    for line in lines(name):
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key] = value
    return data


payload = {
    "status": os.environ["RESULT_STATUS"],
    "phase": os.environ["RESULT_PHASE"],
    "summary": os.environ["RESULT_SUMMARY"],
    "exit_code": int(os.environ["RESULT_EXIT_CODE"]),
    "dry_run": os.environ["RESULT_DRY_RUN"] == "1",
    "floating_tag_warning": os.environ["RESULT_FLOATING_TAG_WARNING"] == "1",
    "services": lines("SERVICES_PAYLOAD"),
    "prev_digests": key_value_map("PREV_DIGESTS_PAYLOAD"),
    "new_digests": key_value_map("NEW_DIGESTS_PAYLOAD"),
    "operator": os.environ.get("RESULT_OPERATOR") or None,
    "workflow_execution_id": os.environ.get("RESULT_WORKFLOW_EXECUTION_ID") or None,
    "host": os.environ.get("RESULT_HOST") or None,
}

print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
PY
}

append_audit_entry() {
  local result_payload="$1"
  local audit_dir
  audit_dir="$(dirname "${audit_log_path}")"
  mkdir -p "${audit_dir}"

  AUDIT_RESULT_PAYLOAD="${result_payload}" \
  AUDIT_LOG_PATH="${audit_log_path}" \
  AUDIT_OPERATOR="${operator:-unknown}" \
  AUDIT_HOST="${host_name}" \
  AUDIT_WORKFLOW_EXECUTION_ID="${workflow_execution_id}" \
  python3 - <<'PY'
import datetime
import json
import os


payload = json.loads(os.environ["AUDIT_RESULT_PAYLOAD"])
entry = {
    "ts": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "operator": os.environ.get("AUDIT_OPERATOR") or "unknown",
    "host": os.environ.get("AUDIT_HOST") or "unknown",
    "services": payload.get("services") or [],
    "prev_digests": payload.get("prev_digests") or {},
    "new_digests": payload.get("new_digests") or {},
    "status": payload.get("status"),
    "phase": payload.get("phase"),
    "dry_run": bool(payload.get("dry_run")),
    "workflow_execution_id": os.environ.get("AUDIT_WORKFLOW_EXECUTION_ID") or None,
    "summary": payload.get("summary"),
    "exit_code": payload.get("exit_code"),
    "floating_tag_warning": bool(payload.get("floating_tag_warning")),
}

with open(os.environ["AUDIT_LOG_PATH"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
PY
}

emit_legacy_ok() {
  if [[ ${dry_run} -eq 1 ]]; then
    echo "__RESULT__:OK:DRY_RUN"
  else
    echo "__RESULT__:OK"
  fi
}

emit_legacy_error() {
  local summary="$1"
  echo "__RESULT__:ERROR:${summary}"
}

emit_result() {
  local status="$1"
  local phase="$2"
  local summary="$3"
  local exit_code="$4"
  local floating_tag_warning="${5:-0}"
  local skip_audit="${6:-0}"
  local payload

  payload="$(build_result_payload "$status" "$phase" "$summary" "$exit_code" "$floating_tag_warning")"

  if [[ "${skip_audit}" -eq 0 ]]; then
    if ! append_audit_entry "${payload}"; then
      current_phase="audit_log"
      emit_result "error" "audit_log" "audit log append failed at ${audit_log_path}" 10 "$floating_tag_warning" 1
      return
    fi
  fi

  if [[ "${status}" == "ok" ]]; then
    emit_legacy_ok
  else
    emit_legacy_error "$summary"
  fi

  echo "__RESULT_JSON__:${payload}"
  result_emitted=1
}

finish_success() {
  local phase="$1"
  local summary="$2"
  local floating_tag_warning="${3:-0}"
  emit_result "ok" "$phase" "$summary" 0 "$floating_tag_warning"
  trap - EXIT
  exit 0
}

finish_error() {
  local phase="$1"
  local exit_code="$2"
  local summary="$3"
  local floating_tag_warning="${4:-0}"
  emit_result "error" "$phase" "$summary" "$exit_code" "$floating_tag_warning"
  trap - EXIT
  exit 0
}

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && $result_emitted -eq 0 ]]; then
    local summary="docker update failed (phase=${current_phase}, exit ${exit_code})"
    emit_result "error" "$current_phase" "$summary" "$exit_code" 0
    trap - EXIT
    exit 0
  fi
}
trap cleanup EXIT

acquire_execution_lock() {
  current_phase="lock"

  if ! command -v flock >/dev/null 2>&1; then
    finish_error "lock" 8 "flock is not available on host"
  fi

  if ! touch "${LOCK_FILE_PATH}"; then
    finish_error "lock" 8 "lock file is not writable at ${LOCK_FILE_PATH}"
  fi

  exec 9<>"${LOCK_FILE_PATH}"
  if ! flock -n 9; then
    finish_error "lock" 8 "another update in progress"
  fi
}

is_non_negative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

run_disk_precheck() {
  local docker_root_dir usage_value usage_pct

  if [[ "${precheck_disk_usage_limit_pct}" == "0" ]]; then
    return 0
  fi

  docker_root_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null | tr -d '\r')"
  if [[ -z "${docker_root_dir}" ]]; then
    finish_error "precheck_disk" 11 "docker info did not return DockerRootDir"
  fi

  if [[ ! -d "${docker_root_dir}" ]]; then
    finish_error "precheck_disk" 11 "docker root directory not found at ${docker_root_dir}"
  fi

  usage_value="$(df -P "${docker_root_dir}" 2>/dev/null | awk 'NR==2 {print $5}')"
  usage_pct="${usage_value%\%}"
  if ! is_non_negative_integer "${usage_pct}"; then
    finish_error "precheck_disk" 11 "failed to read disk usage for ${docker_root_dir}"
  fi

  if (( usage_pct > precheck_disk_usage_limit_pct )); then
    finish_error "precheck_disk" 11 "docker storage usage is ${usage_pct}% (limit ${precheck_disk_usage_limit_pct}%)"
  fi
}

run_compose_precheck() {
  if ! docker compose config -q >/dev/null 2>&1; then
    finish_error "precheck_compose" 12 "docker compose config -q failed"
  fi
}

run_backup_marker_precheck() {
  local marker_mtime now_ts marker_age

  if [[ -z "${backup_marker_path}" ]]; then
    return 0
  fi

  if [[ ! -f "${backup_marker_path}" ]]; then
    finish_error "precheck_backup" 13 "backup marker not found at ${backup_marker_path}"
  fi

  marker_mtime="$(stat -c '%Y' "${backup_marker_path}" 2>/dev/null || true)"
  if ! is_non_negative_integer "${marker_mtime}"; then
    finish_error "precheck_backup" 13 "failed to read backup marker timestamp at ${backup_marker_path}"
  fi

  now_ts="$(date +%s)"
  if ! is_non_negative_integer "${now_ts}"; then
    finish_error "precheck_backup" 13 "failed to read current epoch time"
  fi

  marker_age=$((now_ts - marker_mtime))
  if (( marker_age < 0 )); then
    marker_age=0
  fi

  if (( marker_age > backup_marker_max_age_seconds )); then
    finish_error "precheck_backup" 13 "backup marker is ${marker_age}s old (limit ${backup_marker_max_age_seconds}s) at ${backup_marker_path}"
  fi
}

run_post_checks() {
  local post_check_payload post_check_ok post_check_summary

  if [[ -z "${health_checks_payload_base64}" ]]; then
    return 0
  fi

  post_check_payload="$(
    SERVICES_PAYLOAD="$(array_payload services)" \
    HEALTH_CHECKS_PAYLOAD_BASE64="${health_checks_payload_base64}" \
    COMPOSE_DIR="${COMPOSE_DIR}" \
    python3 - <<'PY'
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def lines(name):
    value = os.environ.get(name, "")
    if not value:
        return []
    return [line for line in value.splitlines() if line.strip()]


def clamp_positive_int(value, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def docker_status(compose_dir, service):
    container_id = subprocess.run(
        ["docker", "compose", "ps", "-q", service],
        cwd=compose_dir,
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    if not container_id:
        return None, "container not found"

    inspect = json.loads(
        subprocess.run(
            ["docker", "inspect", container_id],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )[0]
    state = inspect.get("State", {})
    health = (state.get("Health") or {}).get("Status")
    status = health or state.get("Status")
    return status, None


def poll_docker(service, config, compose_dir):
    timeout = clamp_positive_int(config.get("timeoutSeconds"), 60)
    interval = clamp_positive_int(config.get("intervalSeconds"), 5)
    deadline = time.time() + timeout
    last_status = None
    last_error = None

    while time.time() <= deadline:
        try:
            status, error = docker_status(compose_dir, service)
        except Exception as exc:
            status, error = None, str(exc)

        last_status = status
        last_error = error
        if status in {"healthy", "running"}:
            return {
                "service": service,
                "ok": True,
                "type": "docker",
                "status": status,
                "summary": f"{service}: docker status {status}",
            }

        time.sleep(interval)

    suffix = f"status {last_status}" if last_status else (last_error or "unknown error")
    return {
        "service": service,
        "ok": False,
        "type": "docker",
        "status": last_status,
        "summary": f"{service}: docker health check failed ({suffix})",
    }


def poll_http(service, config):
    url = config.get("url")
    timeout = clamp_positive_int(config.get("timeoutSeconds"), 60)
    interval = clamp_positive_int(config.get("intervalSeconds"), 5)
    expected = config.get("expectStatus") or [200]
    expected_statuses = {int(value) for value in expected}
    headers = {
        str(name): str(value)
        for name, value in (config.get("headers") or {}).items()
        if str(name).strip() and str(value).strip()
    }
    deadline = time.time() + timeout
    last_status = None
    last_error = None

    while time.time() <= deadline:
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=min(interval, 10)) as response:
                status = response.getcode()
        except urllib.error.HTTPError as exc:
            status = exc.code
        except Exception as exc:
            status = None
            last_error = str(exc)
        else:
            last_error = None

        last_status = status
        if status in expected_statuses:
            return {
                "service": service,
                "ok": True,
                "type": "http",
                "url": url,
                "status": status,
                "summary": f"{service}: http {status} at {url}",
            }

        if status is not None:
            last_error = f"http {status}"

        time.sleep(interval)

    suffix = last_error or (f"http {last_status}" if last_status is not None else "unknown error")
    return {
        "service": service,
        "ok": False,
        "type": "http",
        "url": url,
        "status": last_status,
        "summary": f"{service}: http health check failed ({suffix}) at {url}",
    }


services = lines("SERVICES_PAYLOAD")
payload = json.loads(base64.b64decode(os.environ["HEALTH_CHECKS_PAYLOAD_BASE64"]).decode("utf-8"))
compose_dir = os.environ["COMPOSE_DIR"]
details = []

for service in services:
    config = payload.get(service) or {"type": "none"}
    check_type = str(config.get("type") or "none").strip().lower()
    if check_type == "none":
        details.append({
            "service": service,
            "ok": True,
            "type": "none",
            "summary": f"{service}: no post-check configured",
        })
        continue

    if check_type == "docker":
        details.append(poll_docker(service, config, compose_dir))
        continue

    if check_type == "http":
        details.append(poll_http(service, config))
        continue

    details.append({
        "service": service,
        "ok": False,
        "type": check_type,
        "summary": f"{service}: unsupported health check type {check_type}",
    })

failed = [detail for detail in details if not detail.get("ok")]
summary = "post-check passed"
if failed:
    summary = "; ".join(detail["summary"] for detail in failed)

print(json.dumps({"ok": not failed, "summary": summary, "details": details}, ensure_ascii=False, sort_keys=True))
PY
  )" || finish_error "post_check" 14 "post-check runner failed"

  echo "=== Post Check ==="
  POST_CHECK_PAYLOAD="${post_check_payload}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["POST_CHECK_PAYLOAD"])
for detail in payload.get("details") or []:
    print(detail.get("summary") or json.dumps(detail, ensure_ascii=False, sort_keys=True))
PY

  post_check_ok="$(
    POST_CHECK_PAYLOAD="${post_check_payload}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["POST_CHECK_PAYLOAD"])
print("1" if payload.get("ok") else "0")
PY
  )"

  if [[ "${post_check_ok}" != "1" ]]; then
    post_check_summary="$(
      POST_CHECK_PAYLOAD="${post_check_payload}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["POST_CHECK_PAYLOAD"])
print(payload.get("summary") or "post-check failed")
PY
    )"
    finish_error "post_check" 14 "${post_check_summary}"
  fi
}

capture_container_digests() {
  local target_name="$1"
  local -n target_ref=$target_name
  target_ref=()

  for service in "${services[@]}"; do
    local container_id image_digest
    container_id="$(docker compose ps -q "$service" 2>/dev/null || true)"
    if [[ -z "${container_id}" ]]; then
      continue
    fi
    image_digest="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
    if [[ -n "${image_digest}" ]]; then
      target_ref["$service"]="${image_digest}"
    fi
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --operator)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --operator"
      fi
      operator="$2"
      shift 2
      ;;
    --workflow-execution-id)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --workflow-execution-id"
      fi
      workflow_execution_id="$2"
      shift 2
      ;;
    --audit-log-path)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --audit-log-path"
      fi
      audit_log_path="$2"
      shift 2
      ;;
    --disk-usage-limit-pct)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --disk-usage-limit-pct"
      fi
      precheck_disk_usage_limit_pct="$2"
      if ! is_non_negative_integer "${precheck_disk_usage_limit_pct}" || (( precheck_disk_usage_limit_pct > 100 )); then
        finish_error "bootstrap" 1 "invalid value for --disk-usage-limit-pct: ${precheck_disk_usage_limit_pct}"
      fi
      shift 2
      ;;
    --backup-marker-path)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --backup-marker-path"
      fi
      backup_marker_path="$2"
      shift 2
      ;;
    --backup-marker-max-age-seconds)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --backup-marker-max-age-seconds"
      fi
      backup_marker_max_age_seconds="$2"
      if ! is_non_negative_integer "${backup_marker_max_age_seconds}" || (( backup_marker_max_age_seconds == 0 )); then
        finish_error "bootstrap" 1 "invalid value for --backup-marker-max-age-seconds: ${backup_marker_max_age_seconds}"
      fi
      shift 2
      ;;
    --health-checks-payload-base64)
      if [[ $# -lt 2 ]]; then
        finish_error "bootstrap" 1 "missing value for --health-checks-payload-base64"
      fi
      health_checks_payload_base64="$2"
      shift 2
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        services+=("$1")
        shift
      done
      ;;
    -*)
      finish_error "bootstrap" 1 "unknown argument '$1'"
      ;;
    *)
      services+=("$1")
      shift
      ;;
  esac
done

current_phase="allowlist"
if [[ ${#services[@]} -lt 1 ]]; then
  finish_error "allowlist" 2 "no services requested"
fi

acquire_execution_lock

current_phase="allowlist"
if [[ ! -f "${ALLOWED_FILE}" ]]; then
  finish_error "allowlist" 3 "missing allowlist file at ${ALLOWED_FILE}"
fi

while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  allowed["${line}"]=1
done < "${ALLOWED_FILE}"

for service in "${services[@]}"; do
  if [[ -z "${allowed[$service]+x}" ]]; then
    finish_error "allowlist" 4 "service '${service}' is not allowlisted"
  fi
done

current_phase="compose_config"
if [[ ! -d "${COMPOSE_DIR}" ]]; then
  finish_error "compose_config" 5 "compose directory not found at ${COMPOSE_DIR}"
fi

cd "${COMPOSE_DIR}"

if [[ ! -f docker-compose.yml && ! -f compose.yml ]]; then
  finish_error "compose_config" 6 "no compose file found in ${COMPOSE_DIR}"
fi

current_phase="precheck_disk"
run_disk_precheck

current_phase="precheck_compose"
run_compose_precheck

compose_service_list="$(docker compose config --services 2>&1)" || finish_error "compose_config" 7 "docker compose config --services failed"
while IFS= read -r service; do
  [[ -z "${service}" ]] && continue
  compose_services["${service}"]=1
done <<< "${compose_service_list}"

for service in "${services[@]}"; do
  if [[ -z "${compose_services[$service]+x}" ]]; then
    finish_error "compose_config" 7 "service '${service}' not found in docker compose config"
  fi
done

current_phase="precheck_backup"
run_backup_marker_precheck

capture_container_digests prev_digests

if [[ ${dry_run} -eq 1 ]]; then
  current_phase="dry_run"
  echo "=== Docker Update Dry Run ==="
  echo "Services: ${services[*]}"
  echo "Operator: ${operator:-unknown}"
  echo
  echo "Validated allowlist and compose service presence."
  echo
  docker compose ps "${services[@]}" || true
  echo
  finish_success "dry_run" "dry-run completed"
fi

echo "=== Docker Update Apply ==="
echo "Services: ${services[*]}"
echo "Operator: ${operator:-unknown}"
echo

current_phase="pull"
if ! docker compose pull "${services[@]}"; then
  finish_error "pull" 8 "docker compose pull failed"
fi

echo
current_phase="up"
if ! docker compose up -d --no-deps "${services[@]}"; then
  finish_error "up" 9 "docker compose up failed"
fi

capture_container_digests new_digests

echo
docker compose ps "${services[@]}"
echo

current_phase="post_check"
run_post_checks

finish_success "complete" "update applied"
