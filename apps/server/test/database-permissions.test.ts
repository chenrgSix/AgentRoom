import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";

test("SQLite database and live sidecars are private, including legacy files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-private-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "server.sqlite");
  const database = openDatabase(databasePath);
  try {
    database.exec("CREATE TABLE private_data (value TEXT NOT NULL)");
    database.prepare("INSERT INTO private_data VALUES (?)").run("preserved");
    if (process.platform !== "win32") {
      for (const suffix of ["", "-wal", "-shm"]) {
        assert.equal((await stat(`${databasePath}${suffix}`)).mode & 0o777, 0o600);
        await chmod(`${databasePath}${suffix}`, 0o644);
      }
    }
    const reopened = openDatabase(databasePath);
    try {
      assert.deepEqual(reopened.prepare("SELECT value FROM private_data").get(), {
        value: "preserved"
      });
      if (process.platform !== "win32") {
        for (const suffix of ["", "-wal", "-shm"]) {
          assert.equal((await stat(`${databasePath}${suffix}`)).mode & 0o777, 0o600);
        }
      }
    } finally {
      reopened.close();
    }
  } finally {
    database.close();
  }
});

test("migration-only startup creates and repairs private database permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-private-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  if (process.platform !== "win32") {
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    await chmod(databasePath, 0o644);
  }
  const migrated = await migrateDatabase(databasePath);
  assert.deepEqual(migrated.appliedVersions, []);
  if (process.platform !== "win32") {
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  }
});
