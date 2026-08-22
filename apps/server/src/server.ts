import { createServerApp } from "./app.js";
import { resolveDatabasePath } from "./data/database-location.js";

const port = Number.parseInt(process.env.AGENT_ROOM_PORT ?? "3000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AGENT_ROOM_PORT must be a valid TCP port");
}

const app = await createServerApp({
  databasePath: resolveDatabasePath(),
  logger: true,
  ...(process.env.AGENT_ROOM_WEB_ROOT
    ? { webRoot: process.env.AGENT_ROOM_WEB_ROOT }
    : {})
});

await app.listen({ host: "127.0.0.1", port });
