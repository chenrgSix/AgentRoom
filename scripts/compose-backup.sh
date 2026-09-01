#!/usr/bin/env bash
set -euo pipefail

repository_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -n "${CONVENE_WIRE_BACKUP_DIR:-}" && -n "${AGENT_ROOM_BACKUP_DIR:-}" &&
  "${CONVENE_WIRE_BACKUP_DIR}" != "${AGENT_ROOM_BACKUP_DIR}" ]]; then
  echo "CONVENE_WIRE_BACKUP_DIR conflicts with legacy AGENT_ROOM_BACKUP_DIR" >&2
  exit 1
fi
backup_root=${CONVENE_WIRE_BACKUP_DIR:-${AGENT_ROOM_BACKUP_DIR:-"${repository_root}/backups"}}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="convene-wire-${timestamp}.sqlite"
host_backup="${backup_root}/${backup_name}"
temporary_backup=""

cleanup() {
  local backup_status=$?
  local signal=${1:-}
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [[ -n "${temporary_backup}" && -e "${temporary_backup}" ]]; then
    rm -f -- "${temporary_backup}"
    if [[ -e "${temporary_backup}" || -L "${temporary_backup}" ]]; then
      cleanup_status=1
      echo "Failed to remove owned temporary backup: ${temporary_backup}" >&2
    fi
  fi
  if [[ -n "${signal}" ]]; then
    kill -s "${signal}" "$$"
    [[ "${signal}" == "INT" ]] && exit 130
    exit 143
  fi
  [[ "${backup_status}" -eq 0 && "${cleanup_status}" -ne 0 ]] && backup_status=1
  exit "${backup_status}"
}
trap cleanup EXIT
trap 'cleanup INT' INT
trap 'cleanup TERM' TERM

if [[ -e "${host_backup}" ]]; then
  echo "Backup already exists: ${host_backup}" >&2
  exit 1
fi

mkdir -p "${backup_root}"
chmod 0700 "${backup_root}"
temporary_backup=$(mktemp "${backup_root}/.convene-wire-backup.XXXXXX")

cd "${repository_root}"
if ! backup_output=$(docker compose exec -T agentroom \
  node apps/server/dist/data/backup-cli.js "/backups/${backup_name}" 2>&1); then
  printf '%s\n' "${backup_output}" >&2
  exit 1
fi
container_hash=$(docker compose exec -T agentroom \
  node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const h=crypto.createHash("sha256");fs.createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>console.log(h.digest("hex")));' \
  "/backups/${backup_name}" | tr -d '\r\n')
if ! copy_output=$(docker compose cp \
  "agentroom:/backups/${backup_name}" "${temporary_backup}" 2>&1); then
  printf '%s\n' "${copy_output}" >&2
  exit 1
fi
chmod 0600 "${temporary_backup}"

if command -v sha256sum >/dev/null 2>&1; then
  host_hash=$(sha256sum "${temporary_backup}" | awk '{print $1}')
else
  host_hash=$(shasum -a 256 "${temporary_backup}" | awk '{print $1}')
fi

if [[ "${host_hash}" != "${container_hash}" ]]; then
  echo "Copied backup checksum does not match the verified container backup" >&2
  exit 1
fi

if ! ln "${temporary_backup}" "${host_backup}"; then
  echo "Backup destination appeared while copying: ${host_backup}" >&2
  exit 1
fi
rm -f -- "${temporary_backup}"
temporary_backup=""

# OPS-013_STANDALONE_BACKUP_SYNC: the Controller performs exact file and
# exports-directory fsync before accepting this receipt. Direct script users
# retain a conservative POSIX host sync without adding a host Node dependency.
if ! command -v sync >/dev/null 2>&1; then
  echo "The host sync utility is required to complete a durable backup" >&2
  exit 1
fi
sync

printf '%s  %s\n' "${host_hash}" "${host_backup}"
