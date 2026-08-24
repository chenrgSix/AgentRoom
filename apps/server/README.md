# Agent Room Server

This workspace hosts the central Team service. The SQLite layer contains the
core Team, Room, Member, Device, Agent, Message, structured Mention, Run,
Delivery, and Discussion tables plus transactional trace columns. The
Fastify API serves Web, MCP, and authenticated Bridge WebSocket traffic.

`GET /api/traces/{traceId}` returns access-controlled lifecycle metadata for
one Message-to-Runtime path without returning prompt or reply content.

Operational endpoints are:

- `/api/health/live` for liveness;
- `/api/health/ready` for SQLite readiness;
- `/api/health` for aggregate and optional Bridge degradation;
- `/api/metrics` for secret-free Prometheus text metrics.

The production logger emits structured HTTP, Bridge, Delivery, and Run events
without request bodies or Runtime content. Restrict metrics access at the
reverse proxy when the listener is exposed beyond a trusted network.

Set `AGENT_ROOM_BRIDGE_SERVER_TOKEN` to an opaque 32-to-512-byte value when a
deployment should require the same access parameter from Bridge join, claim,
legacy pair, and WebSocket requests. The value is compared without being
logged or persisted. An unset value retains token-free local compatibility.

## Database Location

The database path is resolved in this order:

1. `AGENT_ROOM_DATABASE_PATH`;
2. `<AGENT_ROOM_DATA_DIR>/agent-room.sqlite`;
3. `<current working directory>/var/agent-room.sqlite`.

Relative environment values are resolved from the current working directory.
The migration command creates the parent directory but never overwrites an
existing database.

## Commands

```bash
npm run db:migrate --workspace @agent-room/server
npm run dev --workspace @agent-room/server
npm run build --workspace @agent-room/server
npm test --workspace @agent-room/server
```

For an explicit location, run
`npm run db:migrate -- --database /absolute/path/agent-room.sqlite` from the
repository root.
