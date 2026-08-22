import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitiveText } from "../src/security/redaction.js";

test("common credentials are removed before Agent output persistence", () => {
  const redacted = redactSensitiveText(
    "Bearer abcdefghijklmnop secret=very-sensitive-value sk-1234567890abcdefghijkl"
  );
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  assert.equal(redacted.includes("very-sensitive"), false);
  assert.equal(redacted.includes("sk-"), false);
  assert.match(redacted, /\[REDACTED\]/u);
});
