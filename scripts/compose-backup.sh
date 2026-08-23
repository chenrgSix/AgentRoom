#!/usr/bin/env bash
set -euo pipefail

repository_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
backup_root=${AGENT_ROOM_BACKUP_DIR:-"${repository_root}/backups"}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="agent-room-${timestamp}.sqlite"
host_backup="${backup_root}/${backup_name}"
temporary_backup=""

cleanup() {
  if [[ -n "${temporary_backup}" && -e "${temporary_backup}" ]]; then
    rm -f -- "${temporary_backup}"
  fi
}
trap cleanup EXIT

if [[ -e "${host_backup}" ]]; then
  echo "Backup already exists: ${host_backup}" >&2
  exit 1
fi

mkdir -p "${backup_root}"
chmod 0700 "${backup_root}"
temporary_backup=$(mktemp "${backup_root}/.agent-room-backup.XXXXXX")

cd "${repository_root}"
docker compose exec -T agentroom \
  node apps/server/dist/data/backup-cli.js "/backups/${backup_name}"
container_hash=$(docker compose exec -T agentroom \
  node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const h=crypto.createHash("sha256");fs.createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>console.log(h.digest("hex")));' \
  "/backups/${backup_name}" | tr -d '\r\n')
docker compose cp "agentroom:/backups/${backup_name}" "${temporary_backup}"
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

printf '%s  %s\n' "${host_hash}" "${host_backup}"
