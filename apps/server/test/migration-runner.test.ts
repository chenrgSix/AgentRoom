import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { prepareDatabaseDirectory } from "../src/data/database-location.js";
import {
  defaultMigrationsDirectory,
  migrateDatabase
} from "../src/data/migration-runner.js";

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `agent-room-${name}-`));
}

test("an empty database migrates from zero and reruns idempotently", async () => {
  const directory = await temporaryDirectory("migration");
  const databasePath = path.join(directory, "nested", "server.sqlite");
  await prepareDatabaseDirectory(databasePath);

  const first = await migrateDatabase(databasePath);
  assert.deepEqual(first.appliedVersions, [1, 2, 3, 4, 5]);
  assert.deepEqual(first.skippedVersions, []);
  assert.equal(first.currentVersion, 5);

  const second = await migrateDatabase(databasePath);
  assert.deepEqual(second.appliedVersions, []);
  assert.deepEqual(second.skippedVersions, [1, 2, 3, 4, 5]);

  const database = new Database(databasePath, { readonly: true });
  try {
    const migrationCount = database
      .prepare("SELECT count(*) AS count FROM schema_migrations")
      .get() as { count: number };
    const metadataTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'system_metadata'"
      )
      .get() as { count: number };

    assert.equal(migrationCount.count, 5);
    assert.equal(metadataTable.count, 1);
  } finally {
    database.close();
  }
});

test("an applied migration cannot be changed", async () => {
  const directory = await temporaryDirectory("checksum");
  const databasePath = path.join(directory, "server.sqlite");
  const migrationsDirectory = path.join(directory, "migrations");
  await prepareDatabaseDirectory(databasePath);
  await mkdir(migrationsDirectory, { recursive: true });

  const sourcePath = path.join(defaultMigrationsDirectory, "0001_initialize.sql");
  const migrationPath = path.join(migrationsDirectory, "0001_initialize.sql");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(migrationPath, source, "utf8");
  await migrateDatabase(databasePath, migrationsDirectory);

  await writeFile(migrationPath, `${source}\n-- changed\n`, "utf8");
  await assert.rejects(
    migrateDatabase(databasePath, migrationsDirectory),
    /differs from the already applied source/
  );
});

test("a failed migration rolls back its own schema changes", async () => {
  const directory = await temporaryDirectory("rollback");
  const databasePath = path.join(directory, "server.sqlite");
  const migrationsDirectory = path.join(directory, "migrations");
  await prepareDatabaseDirectory(databasePath);
  await mkdir(migrationsDirectory, { recursive: true });
  await writeFile(
    path.join(migrationsDirectory, "0001_first.sql"),
    "CREATE TABLE first_table (id INTEGER PRIMARY KEY) STRICT;\n",
    "utf8"
  );
  await writeFile(
    path.join(migrationsDirectory, "0002_broken.sql"),
    "CREATE TABLE partial_table (id INTEGER PRIMARY KEY) STRICT;\nINVALID SQL;\n",
    "utf8"
  );

  await assert.rejects(
    migrateDatabase(databasePath, migrationsDirectory),
    /near "INVALID": syntax error/
  );

  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master " +
        "WHERE type = 'table' AND name IN ('first_table', 'partial_table') " +
        "ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const migrations = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;

    assert.deepEqual(tables, [{ name: "first_table" }]);
    assert.deepEqual(migrations, [{ version: 1 }]);
  } finally {
    database.close();
  }
});
