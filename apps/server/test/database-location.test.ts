import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  databaseFilename,
  prepareDatabaseDirectory,
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

test("new database directories are private without chmodding existing shared parents", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-private-data-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const dataDirectory = path.join(directory, "nested", "data");
  await prepareDatabaseDirectory(path.join(dataDirectory, databaseFilename));
  if (process.platform !== "win32") {
    assert.equal((await stat(path.dirname(dataDirectory))).mode & 0o777, 0o700);
    assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  }
  await prepareDatabaseDirectory(path.join(directory, databaseFilename));
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  }
});
