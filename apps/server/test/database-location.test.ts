import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  databaseFilename,
  resolveDatabasePath
} from "../src/data/database-location.js";

const cwd = path.resolve("/tmp/convene-wire-location-test");

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
      env: { CONVENE_WIRE_DATA_DIR: "runtime-data" }
    }),
    path.join(cwd, "runtime-data", databaseFilename)
  );
});

test("explicit database path has highest precedence", () => {
  assert.equal(
    resolveDatabasePath({
      cwd,
      env: {
        CONVENE_WIRE_DATABASE_PATH: "custom/server.sqlite",
        CONVENE_WIRE_DATA_DIR: "ignored"
      }
    }),
    path.join(cwd, "custom", "server.sqlite")
  );
});

test("keeps the released AgentRoom filename and accepts its environment alias", () => {
  assert.equal(
    resolveDatabasePath({
      cwd,
      env: { AGENT_ROOM_DATA_DIR: "legacy-data" }
    }),
    path.join(cwd, "legacy-data", "agent-room.sqlite")
  );
});

test("rejects conflicting current and legacy database paths", () => {
  assert.throws(
    () => resolveDatabasePath({
      cwd,
      env: {
        CONVENE_WIRE_DATABASE_PATH: "new.sqlite",
        AGENT_ROOM_DATABASE_PATH: "old.sqlite"
      }
    }),
    /CONVENE_WIRE_DATABASE_PATH conflicts with legacy AGENT_ROOM_DATABASE_PATH/u
  );
});
