import path from "node:path";

import { backupDatabase } from "./backup.js";
import { resolveDatabasePath } from "./database-location.js";

const destination = process.argv[2];
if (!destination) {
  throw new Error("Usage: npm run db:backup -- /absolute/path/to/backup.sqlite");
}

const resolved = path.resolve(destination);
await backupDatabase(resolveDatabasePath(), resolved);
console.log(`Verified SQLite backup: ${resolved}`);
