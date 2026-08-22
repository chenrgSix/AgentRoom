import { mkdir } from "node:fs/promises";
import path from "node:path";

export const databaseFilename = "agent-room.sqlite";

export interface DatabaseLocationOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function definedValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveDatabasePath(
  options: DatabaseLocationOptions = {}
): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const explicitPath = definedValue(env.AGENT_ROOM_DATABASE_PATH);

  if (explicitPath) {
    return path.resolve(cwd, explicitPath);
  }

  const configuredDataDirectory = definedValue(env.AGENT_ROOM_DATA_DIR);
  const dataDirectory = configuredDataDirectory
    ? path.resolve(cwd, configuredDataDirectory)
    : path.join(cwd, "var");

  return path.join(dataDirectory, databaseFilename);
}

export async function prepareDatabaseDirectory(
  databasePath: string
): Promise<void> {
  await mkdir(path.dirname(path.resolve(databasePath)), { recursive: true });
}
