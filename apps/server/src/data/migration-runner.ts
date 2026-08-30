import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Database from "better-sqlite3";

const migrationFilename = /^(?<version>[0-9]{4})_(?<name>[a-z0-9_]+)\.sql$/;
const migrationDirectiveMarker = "-- convenewire:migration";
const foreignKeysOffDirective =
  `${migrationDirectiveMarker} foreign_keys=off`;

interface AppliedMigration {
  checksum: string;
  name: string;
  version: number;
}

interface Migration extends AppliedMigration {
  foreignKeysOff: boolean;
  sql: string;
}

interface ForeignKeyViolation {
  fkid: number;
  parent: string;
  rowid: number | null;
  table: string;
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

function requiresForeignKeysOff(source: string, filename: string): boolean {
  const lines = source.split(/\r?\n/u);
  const firstLine = lines[0] ?? "";
  const directives = lines.filter((line) =>
    line.trimStart().startsWith(migrationDirectiveMarker)
  );
  if (directives.length === 0) return false;
  if (
    directives.length !== 1 ||
    firstLine !== foreignKeysOffDirective ||
    directives[0] !== foreignKeysOffDirective
  ) {
    throw new Error(`Invalid migration directive: ${filename}`);
  }
  return true;
}

function foreignKeysEnabled(database: Database.Database): boolean {
  return database.pragma("foreign_keys", { simple: true }) === 1;
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
      foreignKeysOff: requiresForeignKeysOff(source, entry.name),
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
      if (migration.foreignKeysOff) {
        const violations = database.pragma(
          "foreign_key_check"
        ) as ForeignKeyViolation[];
        if (violations.length > 0) {
          throw new Error(
            `Migration ${migration.version} violates foreign key constraints`
          );
        }
      }
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

      if (!migration.foreignKeysOff) {
        applyMigration.immediate(migration);
      } else {
        if (database.inTransaction) {
          throw new Error(
            `Migration ${migration.version} cannot disable foreign keys in a transaction`
          );
        }
        database.pragma("foreign_keys = OFF");
        if (foreignKeysEnabled(database)) {
          throw new Error(
            `Migration ${migration.version} could not disable foreign keys`
          );
        }
        try {
          applyMigration.immediate(migration);
        } finally {
          database.pragma("foreign_keys = ON");
          if (!foreignKeysEnabled(database)) {
            throw new Error(
              `Migration ${migration.version} could not restore foreign keys`
            );
          }
        }
      }
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
