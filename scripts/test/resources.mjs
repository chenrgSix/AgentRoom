import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function validatePrefix(prefix) {
  if (typeof prefix !== "string" || prefix.length < 2 || prefix.length > 96 ||
      path.basename(prefix) !== prefix || !/^[a-z0-9][a-z0-9._-]*-$/u.test(prefix)) {
    throw new Error(`Invalid test temporary-directory prefix: ${String(prefix)}`);
  }
}

async function removeOwnedDirectory(owner) {
  let current;
  try {
    current = await lstat(owner.path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== owner.device || current.ino !== owner.inode ||
      await realpath(owner.path) !== owner.path) {
    throw new Error(`Refusing to remove replaced test directory: ${owner.path}`);
  }
  await rm(owner.path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  try {
    await lstat(owner.path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Test directory still exists after cleanup: ${owner.path}`);
}

export async function createTestResources(testContext, prefix) {
  if (!testContext || typeof testContext.after !== "function") {
    throw new Error("createTestResources requires a node:test TestContext");
  }
  validatePrefix(prefix);
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const resolvedDirectory = await realpath(directory);
  const directoryStat = await lstat(resolvedDirectory);
  const owner = {
    path: resolvedDirectory,
    device: directoryStat.dev,
    inode: directoryStat.ino
  };
  const cleanups = [];
  let cleaning = false;
  try {
    testContext.after(async () => {
      cleaning = true;
      const errors = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await removeOwnedDirectory(owner);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `Failed to clean test resources below ${resolvedDirectory}`);
      }
    });
  } catch (error) {
    await removeOwnedDirectory(owner);
    throw error;
  }
  return {
    directory: resolvedDirectory,
    defer(cleanup) {
      if (cleaning) throw new Error("Cannot register cleanup after test cleanup started");
      if (typeof cleanup !== "function") throw new Error("Test cleanup must be a function");
      cleanups.push(cleanup);
    }
  };
}
