import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { generateContractTypes } from "../src/codegen.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("contract generation is deterministic", async () => {
  const first = await generateContractTypes(packageRoot);
  const second = await generateContractTypes(packageRoot);

  assert.deepEqual(second, first);
  assert.match(first.typescript, /export type BridgeMessage =/);
  assert.match(first.typescript, /timestamp: string;/);
  assert.doesNotMatch(first.typescript, /timestamp: Date;/);
  assert.match(first.go, /type BridgeHelloMessage struct/);
  assert.match(first.go, /Timestamp time.Time/);
});
