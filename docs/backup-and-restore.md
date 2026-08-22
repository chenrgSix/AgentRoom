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
