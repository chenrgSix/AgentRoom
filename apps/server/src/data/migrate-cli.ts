import path from "node:path";

import {
  prepareDatabaseDirectory,
  resolveDatabasePath
} from "./database-location.js";
import { migrateDatabase } from "./migration-runner.js";

function parseDatabasePath(arguments_: string[]): string {
  if (arguments_.length === 0) {
    return resolveDatabasePath();
  }

  if (arguments_.length === 2 && arguments_[0] === "--database") {
    const value = arguments_[1]?.trim();
    if (!value) {
      throw new Error("--database requires a non-empty path");
    }
    return path.resolve(value);
  }

  throw new Error("Usage: db:migrate [--database <path>]");
}

const databasePath = parseDatabasePath(process.argv.slice(2));
await prepareDatabaseDirectory(databasePath);
const result = await migrateDatabase(databasePath);

console.log(
  `Database ${result.databasePath} is at migration ${result.currentVersion}; ` +
  `applied ${result.appliedVersions.length}`
);
