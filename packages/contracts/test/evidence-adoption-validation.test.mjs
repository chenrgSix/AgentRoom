import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExecutionCommand,
  evidenceAdoptionDigest,
  evidenceAdoptionOperationDigest,
  evidenceProofSetDigest,
  sourceEvidenceDigest
} from "../src/execution-validation.mjs";

const suite = JSON.parse(await readFile(
  new URL("../fixtures/evidence-adoption-cases.json", import.meta.url),
  "utf8"
));
const kinds = {
  sourceEvidence: "sourceEvidence",
  gateProofRef: "gateProofRef",
  evidenceAdoption: "evidenceAdoption"
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
