import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAgentRuntimePolicy,
  applyEnrollmentCodexPolicy
} from "./static/runtime-policy.mjs";

function controlFixture() {
  const attributes = new Map();
  return {
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    }
  };
}

function policyFixture(hidden) {
  const classes = new Set(hidden ? ["hidden"] : []);
  return {
    classes,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      }
    }
  };
}

test("Agent Runtime policy exposes only the selected Runtime description", () => {
  const control = controlFixture();
  const codexPolicy = policyFixture(false);
  const piPolicy = policyFixture(true);

  applyAgentRuntimePolicy("pi", control, codexPolicy, piPolicy);
  assert.equal(control.attributes.get("aria-describedby"), "agent-pi-permission-policy");
  assert.equal(codexPolicy.classes.has("hidden"), true);
  assert.equal(piPolicy.classes.has("hidden"), false);

  applyAgentRuntimePolicy("codex", control, codexPolicy, piPolicy);
  assert.equal(control.attributes.get("aria-describedby"), "agent-codex-session-ownership-policy");
  assert.equal(codexPolicy.classes.has("hidden"), false);
  assert.equal(piPolicy.classes.has("hidden"), true);
});

test("disabled enrollment Codex removes its hidden policy description", () => {
  const control = controlFixture();

  applyEnrollmentCodexPolicy(true, control);
  assert.equal(control.attributes.get("aria-describedby"), "codex-session-ownership-policy");

  applyEnrollmentCodexPolicy(false, control);
  assert.equal(control.attributes.has("aria-describedby"), false);
});
