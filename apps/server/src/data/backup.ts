import { access, mkdir } from "node:fs/promises";
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
  try {
    await access(destination);
    throw new Error(`Backup destination already exists: ${destination}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Backup destination")) {
      throw error;
    }
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  const verification = new Database(destination, { readonly: true });
  try {
    const result = verification.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error(`Backup verification failed: ${String(result)}`);
  } finally {
    verification.close();
  }
}
