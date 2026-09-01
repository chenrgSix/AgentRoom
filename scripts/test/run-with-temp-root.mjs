#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const markerName = ".owner.json";
const rootEnvironment = "CONVENE_WIRE_TEST_RUN_ROOT";
const ownerEnvironment = "CONVENE_WIRE_TEST_RUN_OWNER";
const baseEnvironment = "CONVENE_WIRE_TEST_RUN_BASE";
const defaultGraceMs = 5_000;

function usageError(message) {
  return new Error(`${message}\nUsage: run-with-temp-root.mjs [--cwd DIR] [--timeout-ms MS] [--grace-ms MS] -- COMMAND [ARG ...]`);
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw usageError(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw usageError("A command must follow --");
  }
  const options = argv.slice(0, separator);
  const command = argv[separator + 1];
  const commandArguments = argv.slice(separator + 2);
  let cwd = process.cwd();
  let timeoutMs;
  let graceMs = defaultGraceMs;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if (option === "--cwd") {
      if (!value) throw usageError("--cwd requires a directory");
      cwd = path.resolve(process.cwd(), value);
      index += 1;
    } else if (option === "--timeout-ms") {
      timeoutMs = positiveInteger(value, option);
      index += 1;
    } else if (option === "--grace-ms") {
      graceMs = positiveInteger(value, option);
      index += 1;
    } else {
      throw usageError(`Unknown option: ${option}`);
    }
  }
  return { command, commandArguments, cwd, timeoutMs, graceMs };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid test-run owner marker at ${filePath}: ${error.message}`);
  }
}

async function inheritedRoot(environment) {
  const root = environment[rootEnvironment];
  const token = environment[ownerEnvironment];
  if (!root && !token) return undefined;
  if (!root || !token) {
    throw new Error("Incomplete inherited test-run ownership environment");
  }
  const resolvedRoot = await realpath(root);
  const marker = await readJson(path.join(resolvedRoot, markerName));
  if (marker.version !== 1 || marker.root !== resolvedRoot || marker.token !== token) {
    throw new Error("Inherited test-run ownership marker does not match the environment");
  }
  return resolvedRoot;
}

async function createRoot(environment) {
  const requestedBase = environment[baseEnvironment]
    ? path.resolve(environment[baseEnvironment])
    : os.tmpdir();
  const base = await realpath(requestedBase);
  const baseStat = await lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error(`Test-run base is not a real directory: ${base}`);
  }
  let root;
  try {
    root = await mkdtemp(path.join(base, "convene-wire-test-run-"));
    const resolvedRoot = await realpath(root);
    const rootStat = await lstat(resolvedRoot);
    const token = randomUUID();
    const marker = {
      version: 1,
      root: resolvedRoot,
      token,
      device: rootStat.dev,
      inode: rootStat.ino,
      processId: process.pid,
      createdAt: new Date().toISOString()
    };
    await writeFile(path.join(resolvedRoot, markerName), `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const directories = {
      temporary: path.join(resolvedRoot, "tmp"),
      goBuild: path.join(resolvedRoot, "cache", "go-build"),
      goModule: path.join(resolvedRoot, "cache", "go-mod"),
      npm: path.join(resolvedRoot, "cache", "npm"),
      nodeCompile: path.join(resolvedRoot, "cache", "node-compile")
    };
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, {
      recursive: true,
      mode: 0o700
    })));
    return {
      root: resolvedRoot,
      token,
      device: rootStat.dev,
      inode: rootStat.ino,
      directories
    };
  } catch (error) {
    if (!root) throw error;
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to initialize and clean test-run root ${root}`);
    }
    throw error;
  }
}

function appendModCacheWriteFlag(value) {
  const current = value?.trim() ?? "";
  if (/(^|\s)-modcacherw(?:\s|$)/u.test(current)) return current;
  return `${current}${current ? " " : ""}-modcacherw`;
}

function ownedEnvironment(environment, owner) {
  return {
    ...environment,
    [rootEnvironment]: owner.root,
    [ownerEnvironment]: owner.token,
    TMPDIR: owner.directories.temporary,
    TEMP: owner.directories.temporary,
    TMP: owner.directories.temporary,
    GOCACHE: owner.directories.goBuild,
    GOMODCACHE: owner.directories.goModule,
    npm_config_cache: owner.directories.npm,
    NODE_COMPILE_CACHE: owner.directories.nodeCompile,
    GOFLAGS: appendModCacheWriteFlag(environment.GOFLAGS),
    npm_config_update_notifier: "false"
  };
}

async function cleanupRoot(owner) {
  let current;
  try {
    current = await lstat(owner.root);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Refusing to remove replaced test-run root: ${owner.root}`);
  }
  if (current.dev !== owner.device || current.ino !== owner.inode) {
    throw new Error(`Refusing to remove a test-run root with changed identity: ${owner.root}`);
  }
  const currentRealPath = await realpath(owner.root);
  if (currentRealPath !== owner.root) {
    throw new Error(`Refusing to remove redirected test-run root: ${owner.root}`);
  }
  const marker = await readJson(path.join(owner.root, markerName));
  if (marker.version !== 1 || marker.root !== owner.root || marker.token !== owner.token ||
      marker.device !== owner.device || marker.inode !== owner.inode) {
    throw new Error(`Refusing to remove test-run root with mismatched ownership: ${owner.root}`);
  }
  await rm(owner.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  try {
    await lstat(owner.root);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Test-run root still exists after cleanup: ${owner.root}`);
}

function windowsCommand(command) {
  if (process.platform !== "win32") return command;
  return ["npm", "npx", "pnpm", "yarn"].includes(command) ? `${command}.cmd` : command;
}

function spawnCommand(options, environment, detached) {
  const child = spawn(windowsCommand(options.command), options.commandArguments, {
    cwd: options.cwd,
    env: environment,
    detached,
    stdio: "inherit",
    windowsHide: true
  });
  let settled = false;
  const result = new Promise((resolve) => {
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => finish({ kind: "spawn-error", error }));
    child.once("close", (code, signal) => finish({ kind: "child", code, signal }));
  });
  return { child, result };
}

function groupAlive(processId) {
  if (!processId || process.platform === "win32") return false;
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function signalGroup(processId, signal) {
  if (!processId) return;
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitUntil(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (read() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !read();
}

async function stopWindowsTree(child, graceMs) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitUntil(() => child.exitCode === null && child.signalCode === null, graceMs)) return;
  try {
    await execFileAsync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) throw error;
  }
}

async function stopOwnedTree(child, graceMs) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await stopWindowsTree(child, graceMs);
    return;
  }
  if (!groupAlive(child.pid)) return;
  signalGroup(child.pid, "SIGTERM");
  if (await waitUntil(() => groupAlive(child.pid), graceMs)) return;
  signalGroup(child.pid, "SIGKILL");
  if (!(await waitUntil(() => groupAlive(child.pid), graceMs))) {
    throw new Error(`Owned child process group ${child.pid} did not terminate`);
  }
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function createControl() {
  let resolveControl;
  const controller = {
    requested: undefined,
    promise: new Promise((resolve) => { resolveControl = resolve; }),
    request(request) {
      if (controller.requested) return;
      controller.requested = request;
      resolveControl(request);
    },
    handlers: new Map()
  };
  controller.handlers.set("SIGINT", () => controller.request({ kind: "signal", signal: "SIGINT" }));
  controller.handlers.set("SIGTERM", () => controller.request({ kind: "signal", signal: "SIGTERM" }));
  controller.install = () => {
    for (const [signal, handler] of controller.handlers) process.on(signal, handler);
  };
  controller.uninstall = () => {
    for (const [signal, handler] of controller.handlers) process.off(signal, handler);
  };
  return controller;
}

async function awaitTerminal(result, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned child did not emit a terminal event")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emitTerminal(outcome) {
  if (outcome.signal && process.platform !== "win32") {
    process.removeAllListeners(outcome.signal);
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exitCode = outcome.code;
}

async function runNested(options, environment) {
  const { result } = spawnCommand(options, environment, false);
  const outcome = await result;
  if (outcome.kind === "spawn-error") {
    process.stderr.write(`[convenewire-test-run] spawn failed: ${outcome.error.message}\n`);
    return { code: 127 };
  }
  if (outcome.signal) return { signal: outcome.signal, code: signalExitCode(outcome.signal) };
  return { code: outcome.code ?? 1 };
}

async function runOwned(options, environment, owner, controller) {
  let timer;
  let child;
  let childResult;
  let terminal;
  let primaryError;
  let childTreeStopped = false;
  try {
    ({ child, result: childResult } = spawnCommand(options, environment, process.platform !== "win32"));
    if (options.timeoutMs) {
      timer = setTimeout(() => controller.request({ kind: "timeout" }), options.timeoutMs);
      timer.unref();
    }
    const outcome = await Promise.race([childResult, controller.promise]);
    if (outcome.kind === "child") {
      terminal = outcome.signal
        ? { signal: outcome.signal, code: signalExitCode(outcome.signal) }
        : { code: outcome.code ?? 1 };
    } else if (outcome.kind === "spawn-error") {
      process.stderr.write(`[convenewire-test-run] spawn failed: ${outcome.error.message}\n`);
      terminal = { code: 127 };
    } else if (outcome.kind === "timeout") {
      process.stderr.write(`[convenewire-test-run] timed out after ${options.timeoutMs}ms\n`);
      terminal = { code: 124 };
    } else {
      terminal = { signal: outcome.signal, code: signalExitCode(outcome.signal) };
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await stopOwnedTree(child, options.graceMs);
      childTreeStopped = true;
    } catch (error) {
      primaryError ??= error;
    }
    try {
      if (childResult) await awaitTerminal(childResult, options.graceMs);
    } catch (error) {
      primaryError ??= error;
    }
    if (childTreeStopped) {
      try {
        await cleanupRoot(owner);
        process.stderr.write(`[convenewire-test-run] cleaned=${owner.root}\n`);
      } catch (error) {
        primaryError ??= error;
      }
    }
  }
  if (primaryError) throw primaryError;
  if (controller.requested?.kind === "signal") {
    return {
      signal: controller.requested.signal,
      code: signalExitCode(controller.requested.signal)
    };
  }
  return terminal ?? { code: 1 };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const existingRoot = await inheritedRoot(process.env);
  if (existingRoot) return runNested(options, process.env);
  const controller = createControl();
  controller.install();
  try {
    const owner = await createRoot(process.env);
    process.stderr.write(`[convenewire-test-run] root=${owner.root}\n`);
    if (controller.requested) {
      await cleanupRoot(owner);
      process.stderr.write(`[convenewire-test-run] cleaned=${owner.root}\n`);
      return controller.requested.kind === "signal"
        ? { signal: controller.requested.signal, code: signalExitCode(controller.requested.signal) }
        : { code: 124 };
    }
    return await runOwned(options, ownedEnvironment(process.env, owner), owner, controller);
  } finally {
    controller.uninstall();
  }
}

try {
  emitTerminal(await main());
} catch (error) {
  process.stderr.write(`[convenewire-test-run] ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
