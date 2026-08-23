# Backup and Restore

## Create a Verified Backup

The server can stay online while SQLite creates a consistent backup through its
native backup API. The destination must not already exist:

```bash
AGENT_ROOM_DATABASE_PATH=/srv/agent-room/server.sqlite \
  npm run db:backup --workspace @agent-room/server -- \
  /srv/backups/agent-room-2026-08-22.sqlite
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

## Restore or Roll Back a Migration

Migrations are forward-only. To restore, stop the central server, preserve the
current database and its WAL/SHM siblings, copy a verified backup to a new
explicit path, and start with `AGENT_ROOM_DATABASE_PATH` pointing to that copy.
The startup migration runner validates checksums and applies only newer source
migrations. Confirm `/api/health`, Team/Room history, Agents, Runs, and one
read-only MCP context call before retiring the previous files.

Never overwrite the live database in place while the server is running. A
rollback means selecting a pre-migration backup, not editing or deleting an
applied migration file.

The Compose restore helper stages a verified backup under a new name. It
refuses to run while the Server container is active, streams SHA-256 instead of
loading the database into memory, runs SQLite `quick_check`, and never replaces
the current database:

```bash
docker compose stop caddy agentroom
./scripts/compose-restore.sh "$PWD/backups/agent-room-20260823T120000Z.sqlite"
```

Copy the printed `AGENT_ROOM_DATABASE_PATH` value into `.env`, run
`docker compose up -d`, then check `/api/health/ready`, Team/Room history, one
Agent connection, and one read-only MCP call. Keep both database files until
that verification succeeds.
