import type Database from "better-sqlite3";

export class SqliteTransactionBoundary {
  public constructor(private readonly database: Database.Database) {}

  public immediate<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }
}
