import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createTestResources } from "./resources.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("test resources run deferred cleanup in reverse order before removing the directory", async (t) => {
  let directory;
  const order = [];
  await t.test("owned fixture", async (child) => {
    const resources = await createTestResources(child, "convene-wire-resource-test-");
    directory = resources.directory;
    await writeFile(path.join(directory, "owned.txt"), "owned\n", "utf8");
    resources.defer(() => { order.push("first"); });
    resources.defer(async () => {
      assert.equal(await readFile(path.join(directory, "owned.txt"), "utf8"), "owned\n");
      order.push("second");
    });
  });
  assert.deepEqual(order, ["second", "first"]);
  assert.equal(await exists(directory), false);
});

test("test resources reject path-shaped prefixes before creating a directory", async (t) => {
  await assert.rejects(
    createTestResources(t, "../convene-wire-unsafe-"),
    /Invalid test temporary-directory prefix/u
  );
});
