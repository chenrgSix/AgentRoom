# Backup and Restore

## Create a Verified Backup

The server can stay online while SQLite creates a consistent backup through its
native backup API. The destination must not already exist:

```bash
CONVENE_WIRE_DATABASE_PATH=/srv/convene-wire/server.sqlite \
  npm run db:backup --workspace @convene-wire/server -- \
  /srv/backups/convene-wire-2026-08-22.sqlite
```

The command runs `quick_check` before reporting success. Store backups outside
the live data directory with the same access controls as the source database.

For the trusted-team Compose profile, keep the root `.env` file in place and
run:

```bash
./scripts/compose-backup.sh
```

The script asks the running Server to create and `quick_check` a new backup,
copies it to the ignored `backups/` directory with mode `0600`, and refuses the
copy if its SHA-256 differs from the verified container file. The host install
uses an atomic no-clobber hard link, so a concurrent destination cannot be
overwritten. It neither overwrites an existing path nor deletes older backups.
The verified container copy remains in the private backup volume; define and
monitor a retention policy for both copies before long-running production use.
Both copies are still on the same physical host. Copy each accepted backup and
its reported SHA-256 to separately controlled off-host or offline-capable
storage. Keep the digest independently from the database file, then periodically
test a restore from that copy.

## Restore or Roll Back a Migration

Migrations are forward-only. To restore, stop the central server, preserve the
current database and its WAL/SHM siblings, copy a verified backup to a new
explicit path, and start with `CONVENE_WIRE_DATABASE_PATH` pointing to that copy.
The startup migration runner validates checksums and applies only newer source
migrations. Confirm `/api/health`, Team/Room history, Agents, Runs, and one
read-only MCP context call before retiring the previous files.

Never overwrite the live database in place while the server is running. A
rollback means selecting a pre-migration backup, not editing or deleting an
applied migration file.

The Compose restore helper stages a verified backup under a new name. It
refuses to run while the Server container is active, streams SHA-256 instead of
loading the database into memory, runs SQLite `quick_check`, and never replaces
the current database.

First hash the selected source and compare the complete 64-character value with
the digest retained when that backup was created. Stop on any mismatch; the
restore helper's later copy check cannot determine whether a valid SQLite file
is the wrong backup.

```bash
sha256sum "$PWD/backups/convene-wire-20260823T120000Z.sqlite"
# On macOS when sha256sum is unavailable:
shasum -a 256 "$PWD/backups/convene-wire-20260823T120000Z.sqlite"
```

Only after that independent comparison passes, stop and stage the restore:

```bash
docker compose stop caddy agentroom
./scripts/compose-restore.sh \
  "$PWD/backups/convene-wire-20260823T120000Z.sqlite" \
  convene-wire-rollback.sqlite
```

Set the exact printed container path in `.env`:

```dotenv
CONVENE_WIRE_DATABASE_PATH=/data/convene-wire-rollback.sqlite
```

If the backup predates an application migration, also check out and rebuild the
previous application release before starting. A newer image would immediately
reapply its forward migrations to the restored database.

Run `docker compose up -d`, inspect `docker compose ps --all` and
`docker compose logs --tail=100 agentroom caddy`, then check
`/api/health/ready`, Team/Room history, one Agent connection, and one read-only
MCP call. Keep the original database path and restored file until verification
succeeds. To abandon the restore, stop the services, put the original
`CONVENE_WIRE_DATABASE_PATH` and matching application release back in place, and
start again; do not overwrite or delete either database while evaluating the
result.
