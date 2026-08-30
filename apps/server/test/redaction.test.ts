import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveText,
  StreamingSensitiveTextRedactor
} from "../src/security/redaction.js";

test("common credentials are removed before Agent output persistence", () => {
  const redacted = redactSensitiveText(
    "Bearer abcdefghijklmnop secret=very-sensitive-value sk-1234567890abcdefghijkl"
  );
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  assert.equal(redacted.includes("very-sensitive"), false);
  assert.equal(redacted.includes("sk-"), false);
  assert.match(redacted, /\[REDACTED\]/u);
});

test("streaming redaction preserves ordinary deltas and only retains possible markers", () => {
  const redactor = new StreamingSensitiveTextRedactor();
  assert.equal(redactor.push("Hello, "), "Hello, ");
  assert.equal(redactor.push("world."), "world.");
  assert.equal(redactor.push(" to"), " ");
  assert.equal(redactor.push("kenization is useful."), "tokenization is useful.");
  assert.equal(redactor.finish(), "");
  assert.equal(redactor.finish(), "");
});

test("streaming credential markers and values remain private until a delimiter", () => {
  const credentials = [
    "Bearer abcdefghijklmnop",
    "sk-abcdefghijklmnop",
    "sK-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrst",
    "gho_abcdefghijklmnopqrst",
    "ghu_abcdefghijklmnopqrst",
    "ghs_abcdefghijklmnopqrst",
    "ghr_abcdefghijklmnopqrst",
    `AKIA${"A".repeat(16)}`,
    "token=supersecretvalue",
    "SECRET:supersecretvalue",
    `password${" ".repeat(128)}=${" ".repeat(128)}${"a".repeat(256)}`
  ];
  for (const credential of credentials) {
    const redactor = new StreamingSensitiveTextRedactor();
    assert.equal(redactor.push("Visible "), "Visible ");
    for (const character of credential) {
      assert.equal(redactor.push(character), "");
    }
    assert.equal(redactor.push("; safe."), "[REDACTED]; safe.");
    assert.equal(redactor.finish(), "");
  }
});

test("streaming redaction matches full ordered redaction at every split boundary", () => {
  const inputs = [
    "Visible Bearer abcdefghijklmnop; safe.",
    "Visible sk-abcdefghijklmnop; safe.",
    "Visible ghp_abcdefghijklmnopqrst; safe.",
    `Visible AKIA${"A".repeat(16)}s.`,
    "Visible token=supersecretvalue; safe.",
    "Visible token=Bearer abcdefghijklmnop ",
    "Visible token=shortBearer abcdefghijklmnop ",
    "Visible secret=sk-abcdefghijklmnop ",
    "Visible token=longtoken ",
    "Visible password=secret=supersecretvalue; safe.",
    "Visible Bearer abcdefghijklmnop;token=supersecretvalue; safe.",
    "Visible sk-abcdefghijklmnop;ghp_abcdefghijklmnopqrst; safe.",
    "Visible token=short; no full credential.",
    "Visible possible marker token"
  ];

  for (const input of inputs) {
    const expected = redactSensitiveText(input);
    for (let split = 0; split <= input.length; split += 1) {
      const redactor = new StreamingSensitiveTextRedactor();
      const projected = redactor.push(input.slice(0, split)) +
        redactor.push(input.slice(split)) + redactor.finish();
      assert.equal(projected, expected, `split ${split} of ${input}`);
    }
    const redactor = new StreamingSensitiveTextRedactor();
    const projected = [...input].map((character) => redactor.push(character)).join("") +
      redactor.finish();
    assert.equal(projected, expected);
  }
});

test("streaming redaction handles a retained nested marker at the Hosted text limit", () => {
  const input = `token=${"a".repeat(9_990)}token`.padEnd(20_000, " ");
  const redactor = new StreamingSensitiveTextRedactor();
  let projected = "";
  for (const character of input) projected += redactor.push(character);
  projected += redactor.finish();
  assert.equal(projected, redactSensitiveText(input));
  assert.equal(projected, `[REDACTED]${" ".repeat(9_999)}`);
});
