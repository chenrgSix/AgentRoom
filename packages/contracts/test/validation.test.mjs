import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateContractFixtures,
  validateContractPackage,
  validateSchemaDocument
} from "../src/validation.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("the checked-in contract package is internally consistent", async () => {
  const result = await validateContractPackage(packageRoot);

  assert.deepEqual(result, {
    catalogVersion: "0.1.0",
    schemaCount: 9
  });
});

test("the product rename preserves published JSON Schema identities", async () => {
  const catalog = JSON.parse(await readFile(
    new URL("../catalog.json", import.meta.url),
    "utf8"
  ));

  for (const schema of catalog.schemas) {
    assert.match(schema.id, /^https:\/\/agentroom\.dev\/schemas\//u);
  }
});

test("positive and negative golden fixtures match their schemas", async () => {
  const result = await validateContractFixtures(packageRoot);

  assert.deepEqual(result, {
    fixtureCount: 116,
    fixtureVersion: "1.0",
    invalidCount: 65,
    validCount: 51
  });
});

test("an invalid JSON Schema is rejected", () => {
  assert.throws(
    () => validateSchemaDocument({ type: "not-a-json-schema-type" }),
    /Invalid JSON Schema/
  );
});
