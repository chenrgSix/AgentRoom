import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { backupDatabase } from "../src/data/backup.js";
import { migrateDatabase } from "../src/data/migration-runner.js";

test("verified SQLite backup restores an acceptance marker with private permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "server.sqlite");
  const backup = path.join(directory, "backups", "acceptance.sqlite");
  await migrateDatabase(source);
  const database = new Database(source);
  database.prepare(`
    INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)
  `).run("acceptance", "passed", "2026-08-22T10:00:00.000Z");
  database.close();

  await backupDatabase(source, backup);
  if (process.platform !== "win32") {
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(backup))).mode & 0o777, 0o700);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
  }
  const restored = new Database(backup, { readonly: true });
  try {
    const row = restored.prepare(`
      SELECT value FROM system_metadata WHERE key = 'acceptance'
    `).get() as { value: string };
    assert.equal(row.value, "passed");
  } finally {
    restored.close();
  }
  await assert.rejects(() => backupDatabase(source, backup), /already exists/u);
});

test("failed direct backups remove only their newly reserved destination", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-backup-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backup = path.join(directory, "backups", "failed.sqlite");
  await assert.rejects(() => backupDatabase(path.join(directory, "missing.sqlite"), backup));
  await assert.rejects(() => stat(backup), { code: "ENOENT" });
});
