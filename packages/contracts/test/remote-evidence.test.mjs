import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExecutionCommand,
  providerInputAttestationDigest,
  providerObservationDigest,
  remoteCIObservationReceiptDigest,
  remoteCommitObservationDigest,
  remoteInputAttestationDigest,
  remoteInputEvidenceDigest,
  remoteProviderBindingDigest,
  remoteProviderBindingRevocationDigest
} from "../src/execution-validation.mjs";

const at = "2026-09-02T12:00:00.000Z";
const digest = (character) => character.repeat(64);
const sha1 = (character) => character.repeat(40);

function binding(origin = "https://provider.example") {
  const value = {
    version: 1,
    providerBindingId: "provider_example001",
    teamId: "team_example001",
    repositoryId: "repo_example001",
    providerOrigin: origin,
    providerRepositoryId: "owner/repository",
    ciChecks: [{
      checkKey: "unit",
      profileId: "profile_example001",
      profileRevision: 1,
      profileDigest: digest("a")
    }],
    createdByMemberId: "member_example001",
    bindingDigest: digest("0"),
    createdAt: at
  };
  value.bindingDigest = remoteProviderBindingDigest(value);
  return value;
}

function providerCommit() {
  const value = {
    version: 1,
    operationId: "op_remote_commit0001",
    observationId: "observation_commit0001",
    providerRepositoryId: "owner/repository",
    objectFormat: "sha1",
    baseCommit: sha1("1"),
    commit: sha1("2"),
    tree: sha1("3"),
    bundleDigest: digest("b"),
    bundleByteLength: 100,
    pullRequest: {
      number: 17,
      headRef: "refs/heads/change",
      baseRef: "refs/heads/main"
    },
    providerObservationDigest: digest("0"),
    observedAt: at
  };
  value.providerObservationDigest = providerObservationDigest(value);
  return value;
}

function providerCI() {
  const value = {
    version: 1,
    operationId: "op_remote_ci0000001",
    observationId: "observation_ci00000001",
    providerRepositoryId: "owner/repository",
    checkKey: "unit",
    attempt: 1,
    commit: sha1("2"),
    tree: sha1("3"),
    outcome: "passed",
    providerObservationDigest: digest("0"),
    observedAt: at
  };
  value.providerObservationDigest = providerObservationDigest(value);
  return value;
}

function providerInputAttestation() {
  const value = {
    version: 1,
    operationId: "op_remote_inputs00001",
    attestationId: "attestation_remoteinputs0001",
    providerRepositoryId: "owner/repository",
    nodeKey: "Build",
    commit: sha1("2"),
    tree: sha1("3"),
    inputs: [{
      adoptionId: "adoption_inputsource0001",
      adoptionDigest: digest("a"),
      reuseInput: {
        inputSlot: "source",
        producer: {
          kind: "adopted_evidence",
          edge: {
            edgeKey: "PrepareBuild",
            fromNodeKey: "Prepare",
            toNodeKey: "Build",
            gate: "verified_output",
            bindings: [{ outputSlot: "patch", inputSlot: "source" }]
          },
          sourceEvidenceId: "source_inputsource0001",
          sourceDigest: digest("b"),
          proofSetDigest: digest("c")
        },
        artifact: { contentDigest: digest("d"), kind: "patch" }
      }
    }],
    remoteInputEvidenceDigest: digest("0"),
    providerAttestationDigest: digest("0"),
    attestedAt: at
  };
  value.remoteInputEvidenceDigest = remoteInputEvidenceDigest(value.inputs);
  value.providerAttestationDigest = providerInputAttestationDigest(value);
  return value;
}

test("remote provider binding is metadata-only, ordered and digest-bound", () => {
  for (const origin of ["https://provider.example", "http://127.0.0.1:4317", "http://[::1]:4317"]) {
    assert.doesNotThrow(() => assertExecutionCommand("remoteProviderBinding", binding(origin)));
  }
  for (const origin of [
    "http://provider.example", "https://token@provider.example",
    "https://provider.example/path", "https://provider.example?token=secret"
  ]) {
    assert.throws(() => assertExecutionCommand("remoteProviderBinding", binding(origin)));
  }
  const unordered = binding();
  unordered.ciChecks = [
    { checkKey: "z", profileId: "profile_example002", profileRevision: 1, profileDigest: digest("b") },
    ...unordered.ciChecks
  ];
  unordered.bindingDigest = remoteProviderBindingDigest(unordered);
  assert.throws(() => assertExecutionCommand("remoteProviderBinding", unordered),
    /REMOTE_PROVIDER_CHECK_ORDER/u);
  assert.throws(() => assertExecutionCommand("remoteProviderBinding", {
    ...binding(), credential: "forbidden"
  }), /PLAN_SCHEMA_INVALID/u);
  assert.throws(() => assertExecutionCommand("remoteProviderBinding", {
    ...binding(), bindingDigest: digest("f")
  }), /REMOTE_PROVIDER_BINDING_DIGEST_MISMATCH/u);
});

test("provider binding revocation is immutable-payload digest-bound", () => {
  const value = {
    version: 1,
    operationId: "op_provider_revoke0001",
    providerBindingId: "provider_example001",
    expectedBindingDigest: binding().bindingDigest,
    revokedByMemberId: "member_example001",
    reason: "Owner withdrew remote observation authority",
    revocationDigest: digest("0"),
    revokedAt: at
  };
  value.revocationDigest = remoteProviderBindingRevocationDigest(value);
  assert.doesNotThrow(() => assertExecutionCommand("remoteProviderBindingRevocation", value));
  assert.throws(() => assertExecutionCommand("remoteProviderBindingRevocation", {
    ...value, expectedBindingDigest: digest("f")
  }), /REMOTE_PROVIDER_REVOCATION_DIGEST_MISMATCH/u);
});

test("provider and retained commit observations bind exact Git and Artifact identity", () => {
  const external = providerCommit();
  assert.doesNotThrow(() => assertExecutionCommand("providerCommitObservation", external));
  assert.throws(() => assertExecutionCommand("providerCommitObservation", {
    ...external, tree: digest("3"),
    providerObservationDigest: providerObservationDigest({ ...external, tree: digest("3") })
  }), /REMOTE_EVIDENCE_OBJECT_FORMAT_MISMATCH/u);
  assert.throws(() => assertExecutionCommand("providerCommitObservation", {
    ...external, providerObservationDigest: digest("f")
  }), /REMOTE_PROVIDER_OBSERVATION_DIGEST_MISMATCH/u);

  const retained = {
    version: 1,
    operationId: external.operationId,
    providerBindingId: "provider_example001",
    repositoryId: "repo_example001",
    providerRepositoryId: external.providerRepositoryId,
    taskId: "task_example001",
    observationId: external.observationId,
    objectFormat: external.objectFormat,
    baseCommit: external.baseCommit,
    commit: external.commit,
    tree: external.tree,
    inputDigest: digest("d"),
    bundleArtifactId: "artifact_bundle0001",
    bundleDigest: external.bundleDigest,
    bundleByteLength: external.bundleByteLength,
    patchArtifactId: "artifact_patch00001",
    patchArtifactRevision: 1,
    patchOutputSlot: "patch",
    patchDigest: digest("e"),
    patchByteLength: 20,
    pullRequest: external.pullRequest,
    providerObservationDigest: external.providerObservationDigest,
    observationDigest: digest("0"),
    observedAt: at
  };
  retained.observationDigest = remoteCommitObservationDigest(retained);
  assert.doesNotThrow(() => assertExecutionCommand("remoteCommitObservation", retained));
  assert.throws(() => assertExecutionCommand("remoteCommitObservation", {
    ...retained, patchArtifactId: "artifact_other0001"
  }), /REMOTE_COMMIT_OBSERVATION_DIGEST_MISMATCH/u);
});

test("remote CI receipt is distinct from provider observation and exact-source bound", () => {
  const external = providerCI();
  assert.doesNotThrow(() => assertExecutionCommand("providerCIObservation", external));
  const receipt = {
    ...external,
    providerBindingId: "provider_example001",
    repositoryId: "repo_example001",
    sourceEvidenceId: "source_example0001",
    profileId: "profile_example001",
    profileRevision: 1,
    profileDigest: digest("a"),
    receiptDigest: digest("0")
  };
  receipt.receiptDigest = remoteCIObservationReceiptDigest(receipt);
  assert.doesNotThrow(() => assertExecutionCommand("remoteCIObservationReceipt", receipt));
  assert.throws(() => assertExecutionCommand("remoteCIObservationReceipt", {
    ...receipt, checkKey: "foreign"
  }), /REMOTE_CI_RECEIPT_DIGEST_MISMATCH/u);
  assert.throws(() => assertExecutionCommand("providerCIObservation", {
    ...external, callbackSecret: "forbidden"
  }), /PLAN_SCHEMA_INVALID/u);
});

test("remote input attestations separate adoption authority from logical equality", () => {
  const external = providerInputAttestation();
  assert.doesNotThrow(() =>
    assertExecutionCommand("providerInputAttestation", external));
  const retained = {
    ...external,
    providerBindingId: "provider_example001",
    repositoryId: "repo_example001",
    planId: "plan_example001",
    planRevision: 1,
    sourceEvidenceId: "source_remoteoutput0001",
    sourceDigest: digest("e"),
    sourceObservationId: "observation_commit0001",
    sourceObservationDigest: digest("f"),
    attestationDigest: digest("0")
  };
  retained.attestationDigest = remoteInputAttestationDigest(retained);
  assert.doesNotThrow(() =>
    assertExecutionCommand("remoteInputAttestation", retained));
  assert.equal(retained.remoteInputEvidenceDigest,
    remoteInputEvidenceDigest(retained.inputs));

  const secondAuthority = structuredClone(external);
  secondAuthority.inputs[0].adoptionId = "adoption_inputsource0002";
  secondAuthority.inputs[0].adoptionDigest = digest("9");
  secondAuthority.providerAttestationDigest =
    providerInputAttestationDigest(secondAuthority);
  assert.equal(secondAuthority.remoteInputEvidenceDigest,
    external.remoteInputEvidenceDigest);
  assert.notEqual(secondAuthority.providerAttestationDigest,
    external.providerAttestationDigest);

  for (const mutate of [
    (value) => { value.inputs[0].reuseInput.producer.sourceDigest = digest("1"); },
    (value) => { value.inputs[0].reuseInput.producer.proofSetDigest = digest("2"); },
    (value) => { value.inputs[0].reuseInput.artifact.contentDigest = digest("3"); },
    (value) => { value.inputs[0].reuseInput.producer.edge.toNodeKey = "Other"; },
    (value) => { value.tree = digest("4"); },
    (value) => { value.credential = "forbidden"; }
  ]) {
    const invalid = structuredClone(external);
    mutate(invalid);
    assert.throws(() =>
      assertExecutionCommand("providerInputAttestation", invalid));
  }

  const externalProducer = structuredClone(external);
  externalProducer.inputs[0].reuseInput.producer = {
    kind: "external_result",
    externalInput: {
      nodeKey: "Build",
      inputSlot: "source",
      sourceTaskId: "task_source0001",
      sourceResultId: "result_source0001",
      artifactId: "artifact_source0001",
      artifactRevision: 1,
      contentDigest: digest("d"),
      kind: "patch"
    },
    reviewOperationId: "op_review_source0001",
    reviewDigest: digest("5")
  };
  externalProducer.remoteInputEvidenceDigest =
    remoteInputEvidenceDigest(externalProducer.inputs);
  externalProducer.providerAttestationDigest =
    providerInputAttestationDigest(externalProducer);
  assert.throws(() =>
    assertExecutionCommand("providerInputAttestation", externalProducer),
  /REMOTE_INPUT_ATTESTATION_PRODUCER_INVALID/u);
});
