import assert from "node:assert/strict";
import test from "node:test";

import validators from "../generated/runtime/execution-plan-validator.cjs";

import {
  assertExecutionCommand,
  providerObservationDigest,
  remoteCIObservationReceiptDigest,
  remoteCommitObservationDigest,
  sourceEvidenceDigest
} from "../src/execution-validation.mjs";

const at = "2026-09-03T01:00:00.000Z";
const digest = (character) => character.repeat(64);
const sha1 = (character) => character.repeat(40);

function remoteEvidence() {
  const providerCommit = {
    version: 1,
    operationId: "op_web_remote_commit01",
    observationId: "observation_web_commit01",
    providerRepositoryId: "owner/repository",
    objectFormat: "sha1",
    baseCommit: sha1("1"),
    commit: sha1("2"),
    tree: sha1("3"),
    bundleDigest: digest("b"),
    bundleByteLength: 100,
    pullRequest: null,
    providerObservationDigest: digest("0"),
    observedAt: at
  };
  providerCommit.providerObservationDigest =
    providerObservationDigest(providerCommit);
  const commitObservation = {
    ...providerCommit,
    providerBindingId: "provider_web00001",
    repositoryId: "repo_web00001",
    taskId: "task_web000001",
    inputDigest: digest("d"),
    bundleArtifactId: "artifact_bundle_web01",
    patchArtifactId: "artifact_patch_web001",
    patchArtifactRevision: 1,
    patchOutputSlot: "patch",
    patchDigest: digest("e"),
    patchByteLength: 20,
    observationDigest: digest("0")
  };
  commitObservation.observationDigest =
    remoteCommitObservationDigest(commitObservation);
  const source = {
    version: 1,
    sourceEvidenceId: "source_web_remote01",
    kind: "repository_commit",
    repositoryId: commitObservation.repositoryId,
    objectFormat: commitObservation.objectFormat,
    commit: commitObservation.commit,
    tree: commitObservation.tree,
    inputDigest: commitObservation.inputDigest,
    artifactPins: [{
      outputSlot: "patch",
      artifactId: commitObservation.patchArtifactId,
      artifactRevision: commitObservation.patchArtifactRevision,
      contentDigest: commitObservation.patchDigest,
      byteLength: commitObservation.patchByteLength,
      kind: "patch"
    }],
    origin: {
      kind: "remote_observation",
      providerBindingId: commitObservation.providerBindingId,
      providerRepositoryId: commitObservation.providerRepositoryId,
      observationId: commitObservation.observationId,
      observationDigest: commitObservation.observationDigest,
      commitBundleArtifactId: commitObservation.bundleArtifactId
    },
    sourceDigest: digest("0"),
    createdAt: at
  };
  source.sourceDigest = sourceEvidenceDigest(source);
  const providerCI = {
    version: 1,
    operationId: "op_web_remote_ci0001",
    observationId: "observation_web_ci0001",
    providerRepositoryId: commitObservation.providerRepositoryId,
    checkKey: "unit",
    attempt: 1,
    commit: commitObservation.commit,
    tree: commitObservation.tree,
    outcome: "passed",
    providerObservationDigest: digest("0"),
    observedAt: at
  };
  providerCI.providerObservationDigest = providerObservationDigest(providerCI);
  const receipt = {
    ...providerCI,
    providerBindingId: commitObservation.providerBindingId,
    repositoryId: commitObservation.repositoryId,
    sourceEvidenceId: source.sourceEvidenceId,
    profileId: "profile_web00001",
    profileRevision: 1,
    profileDigest: digest("a"),
    receiptDigest: digest("0")
  };
  receipt.receiptDigest = remoteCIObservationReceiptDigest(receipt);
  return { commitObservation, source, receipt };
}

function page() {
  const remote = remoteEvidence();
  return {
    version: 1,
    taskId: "task_web000001",
    plans: [{
      planId: "plan_web0000001",
      planRevision: 1,
      planDigest: digest("4"),
      controlRevision: 2,
      state: "running",
      nodes: [{
        nodeKey: "Build",
        taskId: "task_web000001",
        runtime: {
          state: "awaiting_result",
          blockerCode: null,
          dispatchGeneration: 1,
          runId: "run_web00000001",
          lastRunState: "completed",
          projectionRevision: 3,
          updatedAt: at
        },
        requiredVerificationProfiles: [{
          profileId: "profile_web00001",
          revision: 1,
          digest: digest("a")
        }],
        stages: [],
        verifications: [{ kind: "remote_ci", receipt: remote.receipt }],
        remote: {
          commitObservation: remote.commitObservation,
          source: remote.source,
          ciReceipts: [remote.receipt],
          adoptionState: "ready",
          blockerCodes: [],
          commandTemplate: {
            providerBindingId: remote.commitObservation.providerBindingId,
            planRevision: 1,
            nodeKey: "Build",
            expectedPlanDigest: digest("4"),
            expectedControlRevision: 2,
            sourceEvidenceId: remote.source.sourceEvidenceId
          }
        },
        integration: {
          state: "not_required",
          target: null,
          approval: null,
          receipt: null,
          blockerCode: null,
          commandTemplate: null
        },
        nextAction: {
          kind: "adopt_remote_evidence",
          actorKind: "team_owner",
          reasonCode: "REMOTE_ADOPTION_READY"
        }
      }]
    }]
  };
}

test("execution evidence page binds remote source, CI and exact adoption command", () => {
  const value = page();
  assert.equal(validators.executionEvidencePage(value), true,
    JSON.stringify(validators.executionEvidencePage.errors));
  assert.doesNotThrow(() =>
    assertExecutionCommand("executionEvidencePage", value));

  const substituted = structuredClone(value);
  substituted.plans[0].nodes[0].remote.source.commit = sha1("9");
  substituted.plans[0].nodes[0].remote.source.sourceDigest =
    sourceEvidenceDigest(substituted.plans[0].nodes[0].remote.source);
  assert.throws(() => assertExecutionCommand("executionEvidencePage", substituted),
    /EXECUTION_EVIDENCE_REMOTE_IDENTITY_MISMATCH/u);

  const staleTemplate = structuredClone(value);
  staleTemplate.plans[0].nodes[0].remote.commandTemplate.expectedControlRevision = 1;
  assert.throws(() => assertExecutionCommand("executionEvidencePage", staleTemplate),
    /EXECUTION_EVIDENCE_REMOTE_COMMAND_MISMATCH/u);
});

test("execution evidence page has deterministic plan and node order", () => {
  const value = page();
  const second = structuredClone(value.plans[0]);
  second.planId = "plan_web0000002";
  value.plans.unshift(second);
  assert.throws(() => assertExecutionCommand("executionEvidencePage", value),
    /EXECUTION_EVIDENCE_PLAN_ORDER/u);
});

test("proof-control commands are closed exact payloads", () => {
  const remoteCommand = {
    operationId: "op_web_adopt00001",
    providerBindingId: "provider_web00001",
    planRevision: 1,
    nodeKey: "Build",
    expectedPlanDigest: digest("4"),
    expectedControlRevision: 2,
    sourceEvidenceId: "source_web_remote01"
  };
  assert.equal(validators.remoteEvidenceAdoptionCommand(remoteCommand), true,
    JSON.stringify(validators.remoteEvidenceAdoptionCommand.errors));
  assert.doesNotThrow(() =>
    assertExecutionCommand("remoteEvidenceAdoptionCommand", remoteCommand));
  assert.throws(() => assertExecutionCommand("remoteEvidenceAdoptionCommand", {
    ...remoteCommand,
    providerCredential: "forbidden"
  }), /PLAN_SCHEMA_INVALID/u);

  const integrationCommand = {
    operationId: "op_web_integrate001",
    candidateCommit: sha1("2"),
    candidateTree: sha1("3"),
    deadline: "2026-09-03T01:05:00.000Z",
    inputDigest: digest("d"),
    materializationDigest: digest("5"),
    nodeKey: "Build",
    planId: "plan_web0000001",
    planRevision: 1,
    target: {
      repositoryId: "repo_web00001",
      targetRef: "refs/heads/main",
      expectedCommit: sha1("1")
    },
    verificationReceipts: [{
      receiptDigest: digest("6"),
      verificationId: "verification_web00001"
    }]
  };
  assert.equal(validators.integrationApprovalCommand(integrationCommand), true,
    JSON.stringify(validators.integrationApprovalCommand.errors));
  assert.doesNotThrow(() =>
    assertExecutionCommand("integrationApprovalCommand", integrationCommand));
  assert.throws(() => assertExecutionCommand("integrationApprovalCommand", {
    ...integrationCommand,
    target: { ...integrationCommand.target, expectedCommit: sha1("9") },
    expectedTargetCommit: sha1("1")
  }), /PLAN_SCHEMA_INVALID/u);
});
