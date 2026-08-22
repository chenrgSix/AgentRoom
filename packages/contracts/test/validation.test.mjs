import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateContractPackage,
  validateSchemaDocument
} from "../src/validation.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("the checked-in contract package is internally consistent", async () => {
  const result = await validateContractPackage(packageRoot);

  assert.deepEqual(result, {
    catalogVersion: "0.1.0",
    schemaCount: 1
  });
});

test("an invalid JSON Schema is rejected", () => {
  assert.throws(
    () => validateSchemaDocument({ type: "not-a-json-schema-type" }),
    /Invalid JSON Schema/
  );
});
