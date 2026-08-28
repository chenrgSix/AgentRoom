#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 /absolute/path/to/backup.sqlite [target-name.sqlite]" >&2
  exit 1
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source_directory=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)
source_name=$(basename -- "$1")
source_path="${source_directory}/${source_name}"
target_name=${2:-"convene-wire-restore-$(date -u +%Y%m%dT%H%M%SZ).sqlite"}

if [[ ! -f "${source_path}" ]]; then
  echo "Backup does not exist: ${source_path}" >&2
  exit 1
fi
if [[ ! "${target_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$ ]]; then
  echo "Restore target must be a plain .sqlite filename" >&2
  exit 1
fi

cd "${repository_root}"
if [[ -n "$(docker compose ps --quiet agentroom)" ]]; then
  echo "Stop the agentroom service before staging a restore" >&2
  exit 1
fi

docker compose run --rm --no-deps -T --user root \
  --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
  -v "${source_path}:/restore/source.sqlite:ro" \
  agentroom node -e '
    const fs = require("node:fs");
    const Database = require("better-sqlite3");
    const source = process.argv[1];
    const destination = process.argv[2];
    const verify = (filename) => {
      const database = new Database(filename, { readonly: true, fileMustExist: true });
      try {
        if (database.pragma("quick_check", { simple: true }) !== "ok") {
          throw new Error(`SQLite quick_check failed: ${filename}`);
        }
      } finally {
        database.close();
      }
    };
    const digest = (filename) => new Promise((resolve, reject) => {
      const hash = require("node:crypto").createHash("sha256");
      const stream = fs.createReadStream(filename);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
    let destinationCreated = false;
    (async () => {
      const sourceHash = await digest(source);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      destinationCreated = true;
      fs.chmodSync(destination, 0o600);
      const node = fs.readFileSync("/etc/passwd", "utf8")
        .split("\n")
        .find((line) => line.startsWith("node:"));
      if (!node) throw new Error("Container node account is missing");
      const fields = node.split(":");
      fs.chownSync(destination, Number(fields[2]), Number(fields[3]));
      if (await digest(destination) !== sourceHash) {
        throw new Error("Copied restore SHA-256 does not match its source");
      }
      verify(destination);
      console.log(`Staged verified restore: ${destination}`);
    })().catch((error) => {
      if (destinationCreated) {
        try {
          fs.unlinkSync(destination);
        } catch (cleanupError) {
          console.error(`Failed to remove rejected restore: ${cleanupError}`);
        }
      }
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  ' /restore/source.sqlite "/data/${target_name}"

printf 'Set CONVENE_WIRE_DATABASE_PATH=/data/%s, then run docker compose up -d.\n' \
  "${target_name}"
