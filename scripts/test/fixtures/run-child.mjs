import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode, reportPath] = process.argv.slice(2);

async function report(value) {
  if (!reportPath) return;
  await writeFile(reportPath, `${JSON.stringify(value)}\n`, "utf8");
}

function environmentReport(extra = {}) {
  return {
    root: process.env.CONVENE_WIRE_TEST_RUN_ROOT,
    temporary: process.env.TMPDIR,
    goBuild: process.env.GOCACHE,
    goModule: process.env.GOMODCACHE,
    npm: process.env.npm_config_cache,
    nodeCompile: process.env.NODE_COMPILE_CACHE,
    goFlags: process.env.GOFLAGS,
    processId: process.pid,
    ...extra
  };
}

if (mode === "success") {
  const root = process.env.CONVENE_WIRE_TEST_RUN_ROOT;
  assert.ok(root);
  for (const directory of [
    process.env.TMPDIR,
    process.env.GOCACHE,
    process.env.GOMODCACHE,
    process.env.npm_config_cache,
    process.env.NODE_COMPILE_CACHE
  ]) {
    assert.ok(directory?.startsWith(`${root}${path.sep}`));
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "owned.txt");
    await writeFile(file, "owned\n", "utf8");
    if (directory === process.env.GOMODCACHE) await chmod(file, 0o444);
  }
  assert.match(process.env.GOFLAGS ?? "", /(^|\s)-modcacherw(?:\s|$)/u);
  await report(environmentReport());
} else if (mode === "assertion-failure") {
  await report(environmentReport());
  assert.fail("intentional assertion failure");
} else if (mode === "grandchild") {
  setInterval(() => {}, 1_000);
} else if (mode === "hold") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild"], {
    stdio: "ignore"
  });
  await report(environmentReport({ grandchildProcessId: child.pid }));
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
