# ConveneWire Server

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

Set `CONVENE_WIRE_BRIDGE_SERVER_TOKEN` to an opaque 32-to-512-byte value when a
deployment should require the same access parameter from Bridge join, claim,
legacy pair, and WebSocket requests. The value is compared without being
logged or persisted. An unset value retains token-free local compatibility.

## Database Location

The database path is resolved in this order:

1. `CONVENE_WIRE_DATABASE_PATH`;
2. `<CONVENE_WIRE_DATA_DIR>/agent-room.sqlite`;
3. `<current working directory>/var/agent-room.sqlite`.

The legacy filename is intentionally stable so an upgrade opens the existing
Team database instead of creating an empty second database. The corresponding
`AGENT_ROOM_DATABASE_PATH` and `AGENT_ROOM_DATA_DIR` names remain accepted
aliases; conflicting old and new values fail startup.

Relative environment values are resolved from the current working directory.
The migration command creates the parent directory but never overwrites an
existing database.

## Commands

```bash
npm run db:migrate --workspace @convene-wire/server
npm run dev --workspace @convene-wire/server
npm run build --workspace @convene-wire/server
npm test --workspace @convene-wire/server
```

For an explicit location, run
`npm run db:migrate -- --database /absolute/path/agent-room.sqlite` from the
repository root.
