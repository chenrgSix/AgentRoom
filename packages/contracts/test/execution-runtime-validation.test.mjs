import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertExecutionCommand } from "../src/execution-validation.mjs";

const suite = JSON.parse(await readFile(
  new URL("../fixtures/execution-runtime-cases.json", import.meta.url), "utf8"
));
const kinds = {
  manifest: "executionManifest", inputBinding: "executionInputBinding",
  capability: "executionCapability", bindingSummary: "repositoryBinding",
  runtimeAuthorityRequest: "runtimeAuthorityRequest", runtimeAuthorityView: "runtimeAuthorityView",
  grantSummary: "executionGrant", operationRequest: "repositoryOperation",
  operationReceipt: "repositoryReceipt", checkpoint: "executionCheckpoint",
  verificationReceipt: "verificationReceipt", sourceEvidence: "sourceEvidence",
  gateProofRef: "gateProofRef", evidenceAdoption: "evidenceAdoption",
  evidenceReuseContract: "evidenceReuseContract"
};

test("shared execution admission validates every runtime shape without granting authority", () => {
  for (const fixture of suite.cases) {
    if (!fixture.schemaId.includes("/execution-runtime.schema.json#/$defs/")) continue;
    const kind = kinds[fixture.schemaId.split("/").at(-1)];
    assert.ok(kind, fixture.name);
    if (fixture.valid) assert.doesNotThrow(() => assertExecutionCommand(kind, fixture.instance), fixture.name);
    else assert.throws(() => assertExecutionCommand(kind, fixture.instance), /PLAN_SCHEMA_INVALID/u, fixture.name);
  }
});

test("all six operation payloads reject injected commands and cross-kind fields", () => {
  const operations = suite.cases.filter((entry) => entry.valid && entry.instance.action);
  assert.equal(operations.length, 6);
  for (const fixture of operations) {
    assert.doesNotThrow(() => assertExecutionCommand("repositoryOperation", fixture.instance));
    for (const mutate of [
      (value) => { value.action.command = "arbitrary"; },
      (value) => { value.action[value.action.kind].command = "arbitrary"; },
      (value) => { value.action.deploy = {}; },
      (value) => { value.grant.command = "arbitrary"; }
    ]) {
      const invalid = structuredClone(fixture.instance);
      mutate(invalid);
      assert.throws(() => assertExecutionCommand("repositoryOperation", invalid), /PLAN_SCHEMA_INVALID/u, fixture.name);
    }
  }
});

test("governed capture intent is frozen, bounded, and path-safe", () => {
  const manifest = suite.cases.find((entry) =>
    entry.name === "execution runtime: valid manifest"
  ).instance;
  assert.doesNotThrow(() => assertExecutionCommand("executionManifest", manifest));
  for (const mutate of [
    (value) => { delete value.capture.operationId; },
    (value) => { value.capture.outputs[0].slotKey = "bad slot"; },
    (value) => { value.capture.outputs[0].path = "/absolute/report.json"; },
    (value) => { value.capture.outputs[0].path = "reports\\secret.json"; },
    (value) => { value.capture.outputs[0].command = "git add -A"; },
    (value) => { value.capture.outputs = []; }
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => assertExecutionCommand("executionManifest", invalid), /PLAN_SCHEMA_INVALID/u);
  }
});

test("governed readiness publishes only schema-valid path-free grant summaries", () => {
  const capability = suite.cases.find((entry) =>
    entry.name === "execution runtime: valid capability"
  ).instance;
  assert.equal(capability.readyGrants.length, 1);
  assert.doesNotThrow(() => assertExecutionCommand("executionCapability", capability));
  for (const mutate of [
    (value) => { value.readyGrants[0].command = "git status"; },
    (value) => { value.readyGrants[0].scopePolicy.allowedPaths = ["/private/source"]; },
    (value) => { value.readyGrants[0].operations = ["prepare", "capture", "capture"]; },
    (value) => { value.readyGrants = []; }
  ]) {
    const invalid = structuredClone(capability);
    mutate(invalid);
    assert.throws(() => assertExecutionCommand("executionCapability", invalid), /PLAN_SCHEMA_INVALID/u);
  }
});
