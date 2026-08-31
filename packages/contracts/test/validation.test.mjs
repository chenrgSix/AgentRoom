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
    schemaCount: 10
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

test("every wire integer is bounded to the interoperable safe range", async () => {
  const maximumSafeInteger = 9_007_199_254_740_991;
  const schemaPaths = [
    "../schemas/bridge/messages.schema.json",
    "../schemas/bridge/pairing-session.schema.json",
    "../schemas/work/task-result.schema.json",
    "../schemas/work/execution-plan.schema.json"
  ];
  const integerLocations = [];
  const inspect = (value, location) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspect(child, `${location}/${index}`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.includes("integer")) {
      integerLocations.push(location);
      assert.equal(Number.isSafeInteger(value.minimum), true, `${location} minimum`);
      assert.equal(Number.isSafeInteger(value.maximum), true, `${location} maximum`);
      assert.ok(value.minimum >= -maximumSafeInteger, `${location} minimum range`);
      assert.ok(value.maximum <= maximumSafeInteger, `${location} maximum range`);
      assert.ok(value.minimum <= value.maximum, `${location} ordered bounds`);
    }
    for (const [key, child] of Object.entries(value)) {
      inspect(child, `${location}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  };

  for (const schemaPath of schemaPaths) {
    const schema = JSON.parse(await readFile(
      new URL(schemaPath, import.meta.url),
      "utf8"
    ));
    inspect(schema, schema.$id);
  }
  assert.ok(integerLocations.length > 0);
});

test("positive and negative golden fixtures match their schemas", async () => {
  const result = await validateContractFixtures(packageRoot);

  assert.deepEqual(result, {
    fixtureCount: 201,
    fixtureVersion: "1.0",
    invalidCount: 119,
    validCount: 82
  });
});

test("an invalid JSON Schema is rejected", () => {
  assert.throws(
    () => validateSchemaDocument({ type: "not-a-json-schema-type" }),
    /Invalid JSON Schema/
  );
});
