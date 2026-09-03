import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnTestProcess } from "./child-process.mjs";
import { createTestResources } from "./resources.mjs";

const fixture = fileURLToPath(new URL("./fixtures/process-child.mjs", import.meta.url));

async function waitForState(statePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      // A child owns the state file and may be preempted between truncation and
      // its complete write. Treat that transient snapshot like ENOENT, but
      // continue to surface every other filesystem or programming error.
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${statePath}`);
}

test("state polling tolerates an in-progress child write", async (t) => {
  const resources = await createTestResources(t, "convene-wire-process-state-");
  const statePath = path.join(resources.directory, "processes.json");
  await writeFile(statePath, "{");
  const completedWrite = new Promise((resolve, reject) => {
    setTimeout(() => {
      void writeFile(statePath, JSON.stringify({ parentPid: 1, grandchildPid: 2 }))
        .then(resolve, reject);
    }, 50);
  });
  const state = await waitForState(statePath);
  await completedWrite;
  assert.deepEqual(state, { parentPid: 1, grandchildPid: 2 });
});

async function assertProcessGone(processId) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Process ${processId} still exists after cleanup`);
}

test("a process startup failure remains owned and the resource root is removed", async (t) => {
  let directory;
  await t.test("owned failure", async (childTest) => {
    const resources = await createTestResources(childTest, "convene-wire-process-failure-");
    directory = resources.directory;
    const handle = spawnTestProcess(resources, path.join(directory, "missing-executable"));
    const result = await handle.terminal;
    assert.equal(result.code, null);
    assert.equal(result.error?.code, "ENOENT");
  });
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("cleanup escalates from SIGTERM to SIGKILL for an owned process tree", async (t) => {
  let directory;
  let state;
  await t.test("owned tree", async (childTest) => {
    const resources = await createTestResources(childTest, "convene-wire-process-tree-");
    directory = resources.directory;
    const statePath = path.join(directory, "processes.json");
    spawnTestProcess(resources, process.execPath, [fixture, "tree", statePath], {
      stdio: "ignore",
      graceMs: 100,
      killWaitMs: 2_000
    });
    state = await waitForState(statePath);
  });
  await assert.rejects(access(directory), { code: "ENOENT" });
  await assertProcessGone(state.parentPid);
  await assertProcessGone(state.grandchildPid);
});

test("cleanup kills an owned process group after its original parent exits", async (t) => {
  let state;
  await t.test("owned orphan", async (childTest) => {
    const resources = await createTestResources(childTest, "convene-wire-process-orphan-");
    const statePath = path.join(resources.directory, "processes.json");
    const handle = spawnTestProcess(resources, process.execPath, [fixture, "orphan", statePath], {
      stdio: "ignore",
      graceMs: 100,
      killWaitMs: 2_000
    });
    state = await waitForState(statePath);
    const result = await handle.terminal;
    assert.equal(result.code, 0);
  });
  await assertProcessGone(state.grandchildPid);
});

test("explicit process cleanup is idempotent", async (t) => {
  const resources = await createTestResources(t, "convene-wire-process-idempotent-");
  const statePath = path.join(resources.directory, "processes.json");
  const handle = spawnTestProcess(resources, process.execPath, [fixture, "tree", statePath], {
    stdio: "ignore",
    graceMs: 100,
    killWaitMs: 2_000
  });
  const state = await waitForState(statePath);
  await Promise.all([handle.stop(), handle.stop()]);
  await assertProcessGone(state.parentPid);
  await assertProcessGone(state.grandchildPid);
});
