import { chmod, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

export async function backupDatabase(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw new Error("Backup destination must differ from the source database");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    // SQLite can back up into an empty file. Reserve it exclusively with 0600
    // so no credential-bearing page is ever written to a public destination.
    const destinationFile = await open(destination, "wx", 0o600);
    await destinationFile.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Backup destination already exists: ${destination}`);
    }
    throw error;
  }
  try {
    const database = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await database.backup(destination);
    } finally {
      database.close();
    }
    await chmod(destination, 0o600);
    const verification = new Database(destination, { readonly: true });
    try {
      const result = verification.pragma("quick_check", { simple: true });
      if (result !== "ok") throw new Error(`Backup verification failed: ${String(result)}`);
    } finally {
      verification.close();
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}
