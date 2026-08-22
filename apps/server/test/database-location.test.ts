import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  databaseFilename,
  resolveDatabasePath
} from "../src/data/database-location.js";

const cwd = path.resolve("/tmp/agent-room-location-test");

test("database location defaults to the repository-local var directory", () => {
  assert.equal(
    resolveDatabasePath({ cwd, env: {} }),
    path.join(cwd, "var", databaseFilename)
  );
});

test("configured data directory is used when no explicit database is set", () => {
  assert.equal(
    resolveDatabasePath({
      cwd,
      env: { AGENT_ROOM_DATA_DIR: "runtime-data" }
    }),
    path.join(cwd, "runtime-data", databaseFilename)
  );
});

test("explicit database path has highest precedence", () => {
  assert.equal(
    resolveDatabasePath({
      cwd,
      env: {
        AGENT_ROOM_DATABASE_PATH: "custom/server.sqlite",
        AGENT_ROOM_DATA_DIR: "ignored"
      }
    }),
    path.join(cwd, "custom", "server.sqlite")
  );
});
