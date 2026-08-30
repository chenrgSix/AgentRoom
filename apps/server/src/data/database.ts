import { chmodSync, closeSync, fchmodSync, openSync } from "node:fs";

import Database from "better-sqlite3";

export function secureDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath === "") return;
  // Reserve new files with private permissions before SQLite can write data,
  // and repair permissions on legacy databases without truncating them.
  const descriptor = openSync(databasePath, "a", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      chmodSync(`${databasePath}${suffix}`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function openDatabase(databasePath: string): Database.Database {
  secureDatabaseFiles(databasePath);
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
