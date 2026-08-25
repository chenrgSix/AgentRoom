import assert from "node:assert/strict";
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
    schemaCount: 7
  });
});

test("positive and negative golden fixtures match their schemas", async () => {
  const result = await validateContractFixtures(packageRoot);

  assert.deepEqual(result, {
    fixtureCount: 56,
    fixtureVersion: "1.0",
    invalidCount: 30,
    validCount: 26
  });
});

test("an invalid JSON Schema is rejected", () => {
  assert.throws(
    () => validateSchemaDocument({ type: "not-a-json-schema-type" }),
    /Invalid JSON Schema/
  );
});
