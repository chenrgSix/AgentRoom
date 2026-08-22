import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Database from "better-sqlite3";

const migrationFilename = /^(?<version>[0-9]{4})_(?<name>[a-z0-9_]+)\.sql$/;

interface AppliedMigration {
  checksum: string;
  name: string;
  version: number;
}

interface Migration extends AppliedMigration {
  sql: string;
}

export interface MigrationResult {
  appliedVersions: number[];
  currentVersion: number;
  databasePath: string;
  skippedVersions: number[];
}

export const defaultMigrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url)
);

function checksum(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function loadMigrations(migrationsDirectory: string): Promise<Migration[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations: Migration[] = [];
  const versions = new Set<number>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }

    const match = migrationFilename.exec(entry.name);
    if (!match?.groups) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }

    const versionText = match.groups.version;
    const name = match.groups.name;
    if (!versionText || !name) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }

    const version = Number.parseInt(versionText, 10);
    if (version === 0 || versions.has(version)) {
      throw new Error(`Duplicate or zero migration version: ${entry.name}`);
    }
    versions.add(version);

    const source = await readFile(path.join(migrationsDirectory, entry.name), "utf8");
    migrations.push({
      checksum: checksum(source),
      name,
      sql: source,
      version
    });
  }

  migrations.sort((left, right) => left.version - right.version);
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${migrationsDirectory}`);
  }

  return migrations;
}

function initializeMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

export async function migrateDatabase(
  databasePath: string,
  migrationsDirectory = defaultMigrationsDirectory
): Promise<MigrationResult> {
  const normalizedDatabasePath = path.resolve(databasePath);
  const migrations = await loadMigrations(path.resolve(migrationsDirectory));
  const database = new Database(normalizedDatabasePath);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    initializeMigrationTable(database);

    const appliedRows = database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as AppliedMigration[];
    const availableByVersion = new Map(
      migrations.map((migration) => [migration.version, migration])
    );

    for (const [index, applied] of appliedRows.entries()) {
      const available = availableByVersion.get(applied.version);
      if (!available) {
        throw new Error(
          `Database contains unknown migration version ${applied.version}`
        );
      }
      if (migrations[index]?.version !== applied.version) {
        throw new Error("Applied migrations are not a prefix of the source history");
      }
      if (available.name !== applied.name || available.checksum !== applied.checksum) {
        throw new Error(
          `Migration ${applied.version} differs from the already applied source`
        );
      }
    }

    const appliedVersions: number[] = [];
    const skippedVersions = appliedRows.map(({ version }) => version);
    const alreadyApplied = new Set(skippedVersions);
    const insertMigration = database.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (@version, @name, @checksum, @appliedAt)
    `);
    const applyMigration = database.transaction((migration: Migration) => {
      database.exec(migration.sql);
      insertMigration.run({
        appliedAt: new Date().toISOString(),
        checksum: migration.checksum,
        name: migration.name,
        version: migration.version
      });
    });

    for (const migration of migrations) {
      if (alreadyApplied.has(migration.version)) {
        continue;
      }

      applyMigration.immediate(migration);
      appliedVersions.push(migration.version);
    }

    const currentVersion = migrations.at(-1)?.version ?? 0;
    return {
      appliedVersions,
      currentVersion,
      databasePath: normalizedDatabasePath,
      skippedVersions
    };
  } finally {
    database.close();
  }
}
