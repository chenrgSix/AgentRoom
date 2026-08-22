import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { backupDatabase } from "../src/data/backup.js";
import { migrateDatabase } from "../src/data/migration-runner.js";

test("verified SQLite backup restores an acceptance marker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-backup-"));
  const source = path.join(directory, "server.sqlite");
  const backup = path.join(directory, "backups", "acceptance.sqlite");
  await migrateDatabase(source);
  const database = new Database(source);
  database.prepare(`
    INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)
  `).run("acceptance", "passed", "2026-08-22T10:00:00.000Z");
  database.close();

  await backupDatabase(source, backup);
  const restored = new Database(backup, { readonly: true });
  try {
    const row = restored.prepare(`
      SELECT value FROM system_metadata WHERE key = 'acceptance'
    `).get() as { value: string };
    assert.equal(row.value, "passed");
  } finally {
    restored.close();
  }
  assert.rejects(() => backupDatabase(source, backup), /already exists/u);
});
