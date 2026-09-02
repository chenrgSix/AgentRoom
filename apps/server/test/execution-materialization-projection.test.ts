import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  EvidenceAdoption,
  GateProofRef,
  SourceEvidence
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  evidenceAdoptionDigest,
  evidenceAdoptionOperationDigest,
  evidenceProofSetDigest
} from "@convene-wire/contracts/execution-validation";

import {
  projectGeneralizedExecutionMaterialization,
  projectLocalExecutionMaterialization
} from "../src/execution/execution-materialization-projection.js";

const fixtureDocument = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/evidence-adoption-cases.json",
  import.meta.url
), "utf8")) as {
  cases: Array<{ instance: unknown; name: string; valid: boolean }>;
};

function validFixture<T>(name: string): T {
  const found = fixtureDocument.cases.find((entry) =>
    entry.name === name && entry.valid
  );
  assert.ok(found, `missing fixture ${name}`);
  return structuredClone(found.instance) as T;
}

test("version-1 projection retains the exact local Result-bearing shape", () => {
  const materialization = {
    planId: "plan_projection01",
    planRevision: 1,
    nodeKey: "Build",
    gate: "accepted_result" as const,
    dispatchGeneration: 1,
    sourceRunId: "run_projection001",
    sourceResultId: "result_projection01",
    sourceResultVersion: 1,
    gateOperationId: "op_review_projection01",
    artifactPins: [{
      outputSlot: "patch",
      artifactId: "artifact_projection01",
      artifactRevision: 1,
      contentDigest: "a".repeat(64),
      byteLength: 42,
      kind: "patch" as const
    }],
    materializationDigest: "b".repeat(64),
    createdAt: "2026-09-02T01:00:00.123Z"
  };
  assert.deepEqual(projectLocalExecutionMaterialization(materialization), {
    projectionVersion: 1,
    ...materialization
  });
});

test("version-2 projection never fabricates a Result for remote evidence", () => {
  const source = validFixture<SourceEvidence>(
    "evidence adoption: valid remote repository commit source contract"
  );
  const proof = validFixture<GateProofRef>(
    "evidence adoption: valid verification proof"
  );
  assertExecutionCommand("sourceEvidence", source);
  const adoption: EvidenceAdoption = {
    version: 1,
    adoptionId: "adoption_projection01",
    operationId: "op_adopt_projection01",
    operationDigest: "0".repeat(64),
    planId: "plan_projection01",
    planRevision: 1,
    nodeKey: "Build",
    gate: "verified_output",
    sourceEvidenceId: source.sourceEvidenceId,
    sourceDigest: source.sourceDigest,
    sourceExecution: null,
    proofs: [proof],
    proofSetDigest: evidenceProofSetDigest([proof]),
    nodeContractDigest: "e".repeat(64),
    resolvedInputSetDigest: "f".repeat(64),
    authority: {
      service: "execution_materialization",
      approvalOperationId: "op_approve_projection01",
      planDigest: "a".repeat(64),
      roomId: "room_projection01",
      taskId: "task_projection01",
      definitionRevision: 1,
      criteriaRevision: 1,
      agentId: "agent_projection01",
      deviceId: "device_projection01",
      grantId: "grant_projection01",
      grantRevision: 1,
      grantDigest: "b".repeat(64)
    },
    adoptionDigest: "0".repeat(64),
    createdAt: "2026-09-02T01:02:00.123Z"
  };
  adoption.operationDigest = evidenceAdoptionOperationDigest(adoption);
  adoption.adoptionDigest = evidenceAdoptionDigest(adoption);
  assertExecutionCommand("evidenceAdoption", adoption);

  const projection = projectGeneralizedExecutionMaterialization({
    adoption,
    source,
    legacyMaterializationDigest: "c".repeat(64)
  });
  assert.equal(projection.projectionVersion, 2);
  assert.equal(projection.sourceEvidence.kind, "repository_commit");
  assert.equal(projection.sourceEvidence.commit, source.commit);
  assert.equal("companionResult" in projection, false);
  assert.equal("sourceResultId" in projection, false);
  assert.equal(JSON.stringify(projection).includes("sourceResultId"), false);
  assert.equal(JSON.stringify(projection).includes('"resultId":null'), false);
});
