# Agent Room Server

This workspace hosts the central Team service. The SQLite layer contains the
core Team, Room, Member, Device, Agent, Message, and structured Mention tables
plus transactional repositories. The Fastify API supports local session
bootstrap and basic Team, Room, Member, and Fake Agent management. MCP,
WebSocket, and production delivery are introduced by their own tasks.

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
