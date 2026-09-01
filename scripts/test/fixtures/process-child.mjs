import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [mode, statePath] = process.argv.slice(2);
const fixturePath = fileURLToPath(import.meta.url);

if (mode === "grandchild") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "tree") {
  process.on("SIGTERM", () => {});
  const grandchild = spawn(process.execPath, [fixturePath, "grandchild", statePath], {
    detached: false,
    stdio: "ignore"
  });
  await writeFile(statePath, JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }));
  grandchild.unref();
  setInterval(() => {}, 1_000);
} else if (mode === "orphan") {
  const grandchild = spawn(process.execPath, [fixturePath, "grandchild", statePath], {
    detached: false,
    stdio: "ignore"
  });
  await writeFile(statePath, JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }));
  grandchild.unref();
  process.exit(0);
} else {
  process.exitCode = 2;
}
