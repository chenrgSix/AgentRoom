import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_KILL_WAIT_MS = 5_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(processGroupId) {
  if (process.platform === "win32" || !processGroupId) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(processGroupId, child, signal) {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return;
  }
  if (!processGroupId) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function terminateWindowsTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  await new Promise((resolve) => {
    killer.once("error", resolve);
    killer.once("exit", resolve);
  });
}

async function waitForGroupExit(processGroupId, timeoutMs) {
  if (process.platform === "win32" || !processGroupId) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await delay(25);
  }
  return !processGroupExists(processGroupId);
}

export function spawnTestProcess(resources, command, arguments_ = [], options = {}) {
  if (!resources || typeof resources.defer !== "function") {
    throw new Error("spawnTestProcess requires owned test resources");
  }
  if (typeof command !== "string" || command.length === 0 || !Array.isArray(arguments_)) {
    throw new Error("spawnTestProcess requires a command and argument array");
  }
  const { graceMs = DEFAULT_GRACE_MS, killWaitMs = DEFAULT_KILL_WAIT_MS, ...spawnOptions } = options;
  const detached = process.platform !== "win32";
  const child = spawn(command, arguments_, {
    ...spawnOptions,
    detached,
    windowsHide: true
  });
  const processGroupId = detached ? child.pid : undefined;
  const terminal = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
  });
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      if (process.platform === "win32") {
        await terminateWindowsTree(child);
        await terminal;
        return;
      }
      signalProcessGroup(processGroupId, child, "SIGTERM");
      if (!await waitForGroupExit(processGroupId, graceMs)) {
        signalProcessGroup(processGroupId, child, "SIGKILL");
        await terminal;
        if (!await waitForGroupExit(processGroupId, killWaitMs)) {
          throw new Error(`Test process group ${String(processGroupId)} survived SIGKILL`);
        }
      }
      await terminal;
    })();
    return stopping;
  };
  try {
    resources.defer(stop);
  } catch (error) {
    void stop();
    throw error;
  }
  return { process: child, terminal, stop };
}
