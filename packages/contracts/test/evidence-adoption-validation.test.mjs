import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExecutionCommand,
  evidenceAdoptionDigest,
  evidenceAdoptionOperationDigest,
  evidenceNodeReuseContractDigest,
  evidenceProofSetDigest,
  evidenceReuseContractDigest,
  evidenceReuseInputDigest,
  executionOperationDigest,
  sourceEvidenceDigest
} from "../src/execution-validation.mjs";

const suite = JSON.parse(await readFile(
  new URL("../fixtures/evidence-adoption-cases.json", import.meta.url),
  "utf8"
));
const kinds = {
  sourceEvidence: "sourceEvidence",
  gateProofRef: "gateProofRef",
  evidenceAdoption: "evidenceAdoption",
  evidenceReuseContract: "evidenceReuseContract"
};

function kindFor(fixture) {
  return kinds[fixture.schemaId.split("/").at(-1)];
}

function sealAdoption(value) {
  value.proofSetDigest = evidenceProofSetDigest(value.proofs);
  value.operationDigest = evidenceAdoptionOperationDigest(value);
  value.adoptionDigest = evidenceAdoptionDigest(value);
  return value;
}

test("closed evidence contracts enforce schema and canonical semantic identity", () => {
  for (const fixture of suite.cases) {
    const kind = kindFor(fixture);
    assert.ok(kind, fixture.name);
    if (fixture.valid) {
      assert.doesNotThrow(() =>
        assertExecutionCommand(kind, fixture.instance), fixture.name);
    } else {
      assert.throws(() =>
        assertExecutionCommand(kind, fixture.instance), undefined, fixture.name);
    }
  }
});

test("source evidence rejects digest, object format, ordering and identity substitution", () => {
  const source = structuredClone(suite.cases.find((entry) =>
    entry.name === "evidence adoption: valid task Result source"
  ).instance);
  const secondPin = {
    ...source.artifactPins[0],
    outputSlot: "report",
    artifactId: "artifact_evidence04"
  };
  source.artifactPins = [source.artifactPins[0], secondPin];
  source.sourceDigest = sourceEvidenceDigest(source);
  assert.doesNotThrow(() => assertExecutionCommand("sourceEvidence", source));

  for (const mutate of [
    (value) => { value.sourceDigest = "0".repeat(64); },
    (value) => { value.artifactPins.reverse(); },
    (value) => { value.artifactPins[1].outputSlot = value.artifactPins[0].outputSlot; },
    (value) => { value.artifactPins[1].artifactId = value.artifactPins[0].artifactId; }
  ]) {
    const invalid = structuredClone(source);
    mutate(invalid);
    assert.throws(() => assertExecutionCommand("sourceEvidence", invalid));
  }

  const repository = structuredClone(suite.cases.find((entry) =>
    entry.name === "evidence adoption: valid local repository commit source"
  ).instance);
  repository.objectFormat = "sha256";
  repository.sourceDigest = sourceEvidenceDigest(repository);
  assert.throws(() => assertExecutionCommand("sourceEvidence", repository),
    /EVIDENCE_OBJECT_FORMAT_MISMATCH/u);
});

test("adoption rejects wrong, duplicate, unordered and digest-substituted proof sets", () => {
  const base = structuredClone(suite.cases.find((entry) =>
    entry.name === "evidence adoption: valid accepted Result adoption"
  ).instance);
  const first = {
    kind: "verification_receipt",
    operationId: "op_verify_evidence01",
    verificationId: "verification_evidence01",
    profileId: "profile_evidence01",
    profileRevision: 1,
    profileDigest: "1".repeat(64),
    proofDigest: "2".repeat(64)
  };
  const second = {
    ...first,
    operationId: "op_verify_evidence02",
    verificationId: "verification_evidence02",
    profileId: "profile_evidence02",
    proofDigest: "3".repeat(64)
  };
  base.gate = "verified_output";
  base.proofs = [first, second];
  sealAdoption(base);
  assert.doesNotThrow(() => assertExecutionCommand("evidenceAdoption", base));

  const mutations = [
    (value) => { value.proofs.reverse(); },
    (value) => { value.proofs[1].operationId = value.proofs[0].operationId; },
    (value) => { value.proofSetDigest = "0".repeat(64); },
    (value) => { value.operationDigest = "0".repeat(64); },
    (value) => { value.adoptionDigest = "0".repeat(64); }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(base);
    mutate(invalid);
    assert.throws(() => assertExecutionCommand("evidenceAdoption", invalid));
  }
});

function sealReuseContract(value) {
  value.reuseInputEvidenceDigest = evidenceReuseInputDigest(value.reuseInputs);
  value.nodeReuseContractDigest = evidenceNodeReuseContractDigest(value);
  value.contractDigest = evidenceReuseContractDigest(value);
  value.reuseContractId = `reuse_${executionOperationDigest({
    adoptionId: value.adoptionId,
    contractDigest: value.contractDigest
  })}`;
  return value;
}

test("reuse contracts separate attempt identity from logical evidence", () => {
  const base = structuredClone(suite.cases.find((entry) =>
    entry.name === "evidence adoption: valid evidence reuse contract"
  ).instance);
  assert.doesNotThrow(() =>
    assertExecutionCommand("evidenceReuseContract", base));

  const bindingA = {
    inputSlot: "source",
    destinationRunId: "run_attempt0001",
    destinationDeviceId: "device_attempt01",
    bindingId: "input_attempt0001",
    issuedAt: "2026-09-02T01:00:00Z",
    expiresAt: "2026-09-02T02:00:00Z"
  };
  const bindingB = {
    ...bindingA,
    destinationRunId: "run_attempt0002",
    destinationDeviceId: "device_attempt02",
    bindingId: "input_attempt0002",
    issuedAt: "2026-09-02T03:00:00Z",
    expiresAt: "2026-09-02T04:00:00Z"
  };
  assert.notEqual(executionOperationDigest([bindingA]),
    executionOperationDigest([bindingB]));
  assert.equal(evidenceReuseInputDigest(base.reuseInputs),
    evidenceReuseInputDigest(structuredClone(base.reuseInputs)));

  const laterRevision = structuredClone(base);
  laterRevision.planRevision += 1;
  laterRevision.nodeExecutionDigest = "0".repeat(64);
  sealReuseContract(laterRevision);
  assert.notEqual(laterRevision.contractDigest, base.contractDigest);
  assert.equal(laterRevision.nodeReuseContractDigest,
    base.nodeReuseContractDigest);
  assert.equal(laterRevision.reuseInputEvidenceDigest,
    base.reuseInputEvidenceDigest);
  assert.doesNotThrow(() =>
    assertExecutionCommand("evidenceReuseContract", laterRevision));
});

test("reuse contracts reject changed semantics, substitution and digest drift", () => {
  const base = structuredClone(suite.cases.find((entry) =>
    entry.name === "evidence adoption: valid evidence reuse contract"
  ).instance);
  const mutations = [
    (value) => { value.reuseInputs[0].inputSlot = "wrong"; },
    (value) => { value.reuseInputs[0].producer.edge.toNodeKey = "Other"; },
    (value) => { value.reuseInputs[0].artifact.kind = "document"; },
    (value) => { value.nodeReuseContractDigest = "0".repeat(64); },
    (value) => { value.contractDigest = "0".repeat(64); },
    (value) => { value.reuseContractId = "reuse_substitute01"; }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(base);
    mutate(invalid);
    assert.throws(() =>
      assertExecutionCommand("evidenceReuseContract", invalid));
  }

  for (const mutate of [
    (value) => { value.task.criteria[0].description = "Different"; },
    (value) => { value.node.repository.baseCommit = "9".repeat(40); },
    (value) => { value.node.scope.allowedPaths = ["other"]; },
    (value) => { value.node.outputs[0].kind = "patch"; },
    (value) => { value.node.verificationProfiles[0].digest = "8".repeat(64); },
    (value) => { value.integrationPolicy.integrationTargets[0].expectedCommit =
      "7".repeat(40); },
    (value) => { value.node.agentId = "agent_evidence02"; },
    (value) => { value.node.repository.grantRevision += 1; },
    (value) => { value.node.repository.runtimeProfileDigest = "6".repeat(64); },
    (value) => { value.reuseInputs[0].artifact.contentDigest = "5".repeat(64); }
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    sealReuseContract(changed);
    assert.notEqual(changed.nodeReuseContractDigest,
      base.nodeReuseContractDigest);
  }
});
