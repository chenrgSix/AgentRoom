# OPS-004 and DATA-005 Compose Acceptance

- Date: 2026-08-23
- Result: **PASS within the documented single-host trusted-team boundary**
- Platform: macOS Docker Desktop, local Caddy CA, isolated named volumes
- Candidate image: `agentroom/server:v0.2.0-rc.1`

## Deployment Evidence

The committed Compose configuration rendered without interpolation errors, and
the pinned Dockerfile rebuilt contracts, Server, and Web from the allowlisted
build context. The following runtime checks passed:

| Check | Result |
| --- | --- |
| Secret initializer | exited `0`; prepared secret was readable by Server without exposing its value |
| Server isolation | user `node`, read-only root, `cap_drop=ALL`, healthy, port 3000 not published |
| Caddy isolation | read-only root; only `NET_BIND_SERVICE`; config validation passed |
| Public surface | HTTPS health and Web returned `200`; metrics returned `404`; HTTP returned `308` to HTTPS |
| MCP proxy | authenticated MCP `initialize` returned AgentRoom server metadata |
| Bridge proxy | WebSocket Upgrade plus invalid Device Bearer reached Server and returned its credential-specific `401` |
| Graceful stop | Server exited `0`, was not OOM-killed, restarted, and returned ready |

The smoke used host ports 18080/18443 to avoid local conflicts. Production uses
80/443; port 80 is only for ACME and redirect. Public ACME issuance was not
claimed by this local-CA test.

## Backup and Restore Evidence

`compose-backup.sh` created a native SQLite backup, passed `quick_check`, copied
it to an owner-only host file, and matched the container and host SHA-256. The
no-clobber host install completed without leaving its temporary file.

With Server stopped, `compose-restore.sh` passed all of these cases:

- refused to stage any target while the Server container was running;
- staged the verified backup under a new database filename;
- rejected an existing target with `EEXIST` without changing it;
- rejected a non-SQLite source and removed only the newly rejected target;
- streamed and verified a 67,207,168-byte SQLite fixture whose `quick_check`
  returned `ok`;
- started from the restored normal backup and retained the smoke Team record.

Commands used were `docker compose config`, `docker compose build --pull`,
`docker compose up -d`, `docker inspect`, `caddy validate`, `curl`,
`compose-backup.sh`, and `compose-restore.sh`. No physical two-machine claim is
made here; QA-002 remains a separate acceptance gate.
