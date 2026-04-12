#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="/opt/docker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWED_FILE="${SCRIPT_DIR}/allowed-services.txt"

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "__RESULT__:ERROR:docker update failed (exit ${exit_code})"
    trap - EXIT
    exit 0
  fi
}
trap cleanup EXIT

dry_run=0
services=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    dry_run=1
    continue
  fi
  services+=("$arg")
done

if [[ ${#services[@]} -lt 1 ]]; then
  echo "__RESULT__:ERROR:no services requested"
  exit 2
fi

if [[ ! -f "${ALLOWED_FILE}" ]]; then
  echo "__RESULT__:ERROR:missing allowlist file at ${ALLOWED_FILE}"
  exit 3
fi

declare -A allowed=()
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  allowed["${line}"]=1
done < "${ALLOWED_FILE}"

for service in "${services[@]}"; do
  if [[ -z "${allowed[$service]+x}" ]]; then
    echo "__RESULT__:ERROR:service '${service}' is not allowlisted"
    exit 4
  fi
done

if [[ ! -d "${COMPOSE_DIR}" ]]; then
  echo "__RESULT__:ERROR:compose directory not found at ${COMPOSE_DIR}"
  exit 5
fi

cd "${COMPOSE_DIR}"

if [[ ! -f docker-compose.yml && ! -f compose.yml ]]; then
  echo "__RESULT__:ERROR:no compose file found in ${COMPOSE_DIR}"
  exit 6
fi

declare -A compose_services=()
while IFS= read -r service; do
  [[ -z "${service}" ]] && continue
  compose_services["${service}"]=1
done < <(docker compose config --services)

for service in "${services[@]}"; do
  if [[ -z "${compose_services[$service]+x}" ]]; then
    echo "__RESULT__:ERROR:service '${service}' not found in docker compose config"
    exit 7
  fi
done

if [[ ${dry_run} -eq 1 ]]; then
  echo "=== Docker Update Dry Run ==="
  echo "Services: ${services[*]}"
  echo
  echo "Validated allowlist and compose service presence."
  echo
  docker compose ps "${services[@]}" || true
  echo
  echo "__RESULT__:OK:DRY_RUN"
  trap - EXIT
  exit 0
fi

echo "=== Docker Update Apply ==="
echo "Services: ${services[*]}"
echo

docker compose pull "${services[@]}"
echo
docker compose up -d --no-deps "${services[@]}"
echo
docker compose ps "${services[@]}"
echo
echo "__RESULT__:OK"
trap - EXIT
