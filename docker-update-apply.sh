#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="/opt/docker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWED_FILE="${SCRIPT_DIR}/allowed-services.txt"

dry_run=0
services=()
result_emitted=0
current_phase="bootstrap"

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

emit_result_json() {
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
}

print("__RESULT_JSON__:" + json.dumps(payload, ensure_ascii=False, sort_keys=True))
PY
  result_emitted=1
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

finish_success() {
  local phase="$1"
  local summary="$2"
  local floating_tag_warning="${3:-0}"
  emit_legacy_ok
  emit_result_json "ok" "$phase" "$summary" 0 "$floating_tag_warning"
  trap - EXIT
  exit 0
}

finish_error() {
  local phase="$1"
  local exit_code="$2"
  local summary="$3"
  local floating_tag_warning="${4:-0}"
  emit_legacy_error "$summary"
  emit_result_json "error" "$phase" "$summary" "$exit_code" "$floating_tag_warning"
  trap - EXIT
  exit 0
}

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && $result_emitted -eq 0 ]]; then
    local summary="docker update failed (phase=${current_phase}, exit ${exit_code})"
    emit_legacy_error "$summary"
    emit_result_json "error" "$current_phase" "$summary" "$exit_code" 0
    trap - EXIT
    exit 0
  fi
}
trap cleanup EXIT

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

for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    dry_run=1
    continue
  fi
  services+=("$arg")
done

current_phase="allowlist"
if [[ ${#services[@]} -lt 1 ]]; then
  finish_error "allowlist" 2 "no services requested"
fi

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

capture_container_digests prev_digests

if [[ ${dry_run} -eq 1 ]]; then
  current_phase="dry_run"
  echo "=== Docker Update Dry Run ==="
  echo "Services: ${services[*]}"
  echo
  echo "Validated allowlist and compose service presence."
  echo
  docker compose ps "${services[@]}" || true
  echo
  finish_success "dry_run" "dry-run completed"
fi

echo "=== Docker Update Apply ==="
echo "Services: ${services[*]}"
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
finish_success "complete" "update applied"
