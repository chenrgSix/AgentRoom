import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnTestProcess } from "./child-process.mjs";
import { createTestResources } from "./resources.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/shell-owned-temp.sh", import.meta.url));
const shellScripts = [
  ["bridge/scripts/verify-release-assets.sh", "cleanup"],
  ["ops/convenewirectl/scripts/build-central-image.sh", "cleanup"],
  ["ops/convenewirectl/scripts/package-central-release.sh", "cleanup"],
  ["ops/convenewirectl/scripts/verify-central-release.sh", "cleanup"],
  ["ops/convenewirectl/scripts/verify-central-image-docker.sh", "cleanup_runtime"],
  ["scripts/compose-backup.sh", "cleanup"]
];

async function waitForRoot(statePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return (await readFile(statePath, "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for shell state at ${statePath}`);
}

async function assertAbsent(target) {
  await assert.rejects(access(target), { code: "ENOENT" });
}

test("shell temporary owners remove their exact root on success and failure", async (t) => {
  const resources = await createTestResources(t, "convene-wire-shell-owner-");
  for (const [mode, expectedCode] of [["success", 0], ["failure", 7]]) {
    const statePath = path.join(resources.directory, `${mode}.txt`);
    const handle = spawnTestProcess(resources, "/bin/bash", [fixture, statePath, mode], {
      stdio: "ignore"
    });
    const root = await waitForRoot(statePath);
    const result = await handle.terminal;
    assert.equal(result.code, expectedCode);
    await assertAbsent(root);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`shell temporary owner removes its exact root after ${signal}`, async (t) => {
    const resources = await createTestResources(t, "convene-wire-shell-signal-");
    const statePath = path.join(resources.directory, `${signal}.txt`);
    const handle = spawnTestProcess(resources, "/bin/bash", [fixture, statePath, "hold"], {
      stdio: "ignore"
    });
    const root = await waitForRoot(statePath);
    handle.process.kill(signal);
    const result = await handle.terminal;
    assert.equal(result.signal, signal);
    await assertAbsent(root);
  });
}

test("every production shell temporary owner traps EXIT, INT and TERM before mktemp", async () => {
  for (const [relativePath, cleanup] of shellScripts) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    const exitTrap = `trap ${cleanup} EXIT`;
    const interruptTrap = `trap '${cleanup} INT' INT`;
    const terminateTrap = `trap '${cleanup} TERM' TERM`;
    assert.ok(source.includes(exitTrap), `${relativePath} lacks ${exitTrap}`);
    assert.ok(source.includes(interruptTrap), `${relativePath} lacks ${interruptTrap}`);
    assert.ok(source.includes(terminateTrap), `${relativePath} lacks ${terminateTrap}`);
    assert.ok(
      source.indexOf(exitTrap) < source.indexOf("$(mktemp"),
      `${relativePath} installs cleanup after creating its temporary resource`
    );
  }
});
