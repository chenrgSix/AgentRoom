import Database from "better-sqlite3";

export function openDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  return database;
}
