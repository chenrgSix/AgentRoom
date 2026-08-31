import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalExecutionJSON, executionOperationDigest } from "../src/execution-validation.mjs";

const suite = JSON.parse(await readFile(new URL("../fixtures/execution-canonical-cases.json", import.meta.url), "utf8"));
for (const entry of suite.cases) test(`shared execution JSON: ${entry.name}`, () => {
  const value = JSON.parse(entry.raw);
  assert.equal(canonicalExecutionJSON(value), entry.canonical);
  assert.equal(executionOperationDigest(value), entry.digest);
});
