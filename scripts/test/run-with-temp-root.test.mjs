import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnTestProcess } from "./child-process.mjs";
import { createTestResources } from "./resources.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const runner = path.join(directory, "run-with-temp-root.mjs");
const childFixture = path.join(directory, "fixtures", "run-child.mjs");
const forbiddenPrefixes = ["agentroom-", "agent-room-", "convenewire-", "convene-wire-"];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function isolatedEnvironment(base) {
  const environment = { ...process.env, CONVENE_WIRE_TEST_RUN_BASE: base };
  delete environment.CONVENE_WIRE_TEST_RUN_ROOT;
  delete environment.CONVENE_WIRE_TEST_RUN_OWNER;
  return environment;
}

function startRunner(resources, base, arguments_, environmentOverrides = {}) {
  const handle = spawnTestProcess(resources, process.execPath, [runner, ...arguments_], {
    env: { ...isolatedEnvironment(base), ...environmentOverrides },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const child = handle.process;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { ...handle, child, result };
}

async function runRunner(resources, base, arguments_) {
  return (await startRunner(resources, base, arguments_).result);
}

function createdRoot(stderr) {
  const match = stderr.match(/^\[convenewire-test-run\] root=(.+)$/mu);
  assert.ok(match, `missing run root in stderr:\n${stderr}`);
  return match[1];
}

function command(mode, reportPath) {
  return ["--", process.execPath, childFixture, mode, reportPath];
}

async function fixture(t) {
  const resources = await createTestResources(t, "cw-test-runner-");
  const base = resources.directory;
  const sentinel = path.join(base, "foreign-sibling");
  await mkdir(sentinel);
  await writeFile(path.join(sentinel, "keep.txt"), "keep\n", "utf8");
  return { base, resources, sentinel };
}

async function assertClean(result, sentinel) {
  const root = createdRoot(result.stderr);
  assert.equal(await exists(root), false, result.stderr);
  assert.equal(await readFile(path.join(sentinel, "keep.txt"), "utf8"), "keep\n");
  return root;
}

function processAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("runner removes the exact root after success and reuses it when nested", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  const reportPath = path.join(base, "success.json");
  const result = await runRunner(resources, base, [
    "--",
    process.execPath,
    runner,
    "--",
    process.execPath,
    childFixture,
    "success",
    reportPath
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const root = await assertClean(result, sentinel);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.root, root);
  assert.equal(result.stderr.match(/^\[convenewire-test-run\] root=/gmu)?.length, 1);
  assert.match(report.goFlags, /(^|\s)-modcacherw(?:\s|$)/u);
  assert.equal(report.goFlags.match(/(^|\s)-modcacherw(?=\s|$)/gu)?.length, 1);
  for (const value of [report.temporary, report.goBuild, report.goModule, report.npm, report.nodeCompile]) {
    assert.ok(value.startsWith(`${root}${path.sep}`));
  }
});

test("runner removes the exact root after an assertion failure", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  const result = await runRunner(resources, base, command("assertion-failure", path.join(base, "failure.json")));
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null);
  await assertClean(result, sentinel);
});

test("runner removes the exact root when child startup fails", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  const result = await runRunner(resources, base, ["--", "convenewire-command-that-does-not-exist"]);
  assert.equal(result.code, 127, result.stderr);
  assert.match(result.stderr, /spawn failed/u);
  await assertClean(result, sentinel);
});

test("runner rejects an unowned inherited path without deleting it", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  const result = await startRunner(resources, base, command("success", path.join(base, "unsafe.json")), {
    CONVENE_WIRE_TEST_RUN_ROOT: sentinel,
    CONVENE_WIRE_TEST_RUN_OWNER: "not-the-owner"
  }).result;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /owner marker/u);
  assert.equal(await readFile(path.join(sentinel, "keep.txt"), "utf8"), "keep\n");
});

test("runner terminates descendants and removes the root after timeout", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  const reportPath = path.join(base, "timeout.json");
  const result = await runRunner(resources, base, ["--timeout-ms", "250", "--grace-ms", "250", ...command("hold", reportPath)]);
  assert.equal(result.code, 124, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(processAlive(report.processId), false);
  assert.equal(processAlive(report.grandchildProcessId), false);
  await assertClean(result, sentinel);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`runner removes the root after ${signal}`, async (t) => {
    const { base, resources, sentinel } = await fixture(t);
    const reportPath = path.join(base, `${signal}.json`);
    const active = startRunner(resources, base, ["--grace-ms", "250", ...command("hold", reportPath)]);
    const report = await waitForFile(reportPath);
    active.child.kill(signal);
    const result = await active.result;
    assert.equal(result.signal, signal, result.stderr);
    assert.equal(processAlive(report.processId), false);
    assert.equal(processAlive(report.grandchildProcessId), false);
    await assertClean(result, sentinel);
  });
}

test("parallel owners never remove one another", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  const firstReportPath = path.join(base, "parallel-first.json");
  const secondReportPath = path.join(base, "parallel-second.json");
  const first = startRunner(resources, base, ["--grace-ms", "250", ...command("hold", firstReportPath)]);
  const second = startRunner(resources, base, ["--grace-ms", "250", ...command("hold", secondReportPath)]);
  const [firstReport, secondReport] = await Promise.all([
    waitForFile(firstReportPath),
    waitForFile(secondReportPath)
  ]);
  assert.notEqual(firstReport.root, secondReport.root);
  assert.equal(await exists(firstReport.root), true);
  assert.equal(await exists(secondReport.root), true);
  first.child.kill("SIGTERM");
  const firstResult = await first.result;
  assert.equal(firstResult.signal, "SIGTERM", firstResult.stderr);
  assert.equal(await exists(firstReport.root), false);
  assert.equal(await exists(secondReport.root), true);
  assert.equal(processAlive(secondReport.processId), true);
  second.child.kill("SIGTERM");
  const secondResult = await second.result;
  assert.equal(secondResult.signal, "SIGTERM", secondResult.stderr);
  assert.equal(await exists(secondReport.root), false);
  assert.equal(await readFile(path.join(sentinel, "keep.txt"), "utf8"), "keep\n");
});

test("three consecutive runs leave no four-prefix directory", async (t) => {
  const { base, resources, sentinel } = await fixture(t);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const reportPath = path.join(base, `repeat-${iteration}.json`);
    const result = await runRunner(resources, base, command("success", reportPath));
    assert.equal(result.code, 0, result.stderr);
    await assertClean(result, sentinel);
    const matches = (await readdir(base)).filter((name) =>
      forbiddenPrefixes.some((prefix) => name.startsWith(prefix))
    );
    assert.deepEqual(matches, []);
  }
});

test("registered test and disposable preview entrypoints use the shared run owner", async () => {
  const manifests = [
    ["package.json", [
      "test:all", "test:bridge", "test:bridge-ui", "test:qa-evidence",
      "test:product-experience", "test:temp-lifecycle", "test:site", "test:compose",
      "test:e2e", "test:e2e:live", "preview:product-experience"
    ]],
    ["apps/server/package.json", ["test"]],
    ["apps/web/package.json", ["test"]],
    ["packages/contracts/package.json", ["test"]]
  ];
  for (const [manifestPath, scriptNames] of manifests) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, manifestPath), "utf8"));
    for (const scriptName of scriptNames) {
      assert.match(
        manifest.scripts[scriptName],
        /(?:^|\s)node\s+[^\n]*run-with-temp-root\.mjs(?:\s|$)/u,
        `${manifestPath} ${scriptName} bypasses the shared test-run owner`
      );
    }
  }
});
