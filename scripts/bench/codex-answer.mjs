// Test-only generic Runtime adapter: emit final Codex answers, never JSON events.
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [executable, model, quotaDirectory] = process.argv.slice(2);
if (!executable || !model || !quotaDirectory) throw new Error("Executable, model and owned quota directory are required");
let reserved = false;
for (let slot = 0; slot < 12; slot += 1) {
  try {
    closeSync(openSync(path.join(quotaDirectory, `invocation-${slot}`), "wx", 0o600));
    reserved = true;
    break;
  } catch (error) { if (error.code !== "EEXIST") throw error; }
}
if (!reserved) {
  process.stderr.write("Benchmark invocation limit reached; no provider process started.\n");
  process.exit(1);
}
const child = spawn(executable, ["exec", "--json", "--sandbox", "read-only", "--ephemeral",
  "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--model", model,
  "-c", 'model_reasoning_effort="low"', "-"], { stdio: ["pipe", "pipe", "pipe"] });
const terminal = new Promise((resolve) => {
  child.once("error", () => resolve(1));
  child.once("exit", (code) => resolve(code ?? 1));
});
const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
// Do not forward provider diagnostics or any credentials into Room output.
child.stderr.resume();
let failed = false;
let answered = false;
for await (const line of createInterface({ input: child.stdout })) {
  try {
    const event = JSON.parse(line);
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      process.stdout.write(`${event.item.text}\n`);
      answered = true;
    }
    if (event.type === "turn.failed" || event.type === "error") failed = true;
    if (event.type?.startsWith("item.") && event.item?.type &&
      !["agent_message", "reasoning"].includes(event.item.type)) {
      // Closed-input benchmark responses that invoke tools are invalid.
      failed = true;
    }
  } catch { failed = true; }
}
const result = await terminal;
clearTimeout(timer);
if (failed || !answered || result !== 0) {
  process.stderr.write("Closed-input Codex benchmark invocation failed or used tools.\n");
  process.exitCode = 1;
}
