import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExecutionCommand,
  executionOperationDigest,
  validateExecutionPlanDefinition
} from "../src/execution-validation.mjs";

const suite = JSON.parse(await readFile(
  new URL("../fixtures/execution-plan-cases.json", import.meta.url), "utf8"
));
const definition = validateExecutionPlanDefinition(structuredClone(
  suite.cases.find((entry) => entry.name === "execution: valid full plan").instance
)).definition;
const at = "2026-09-03T08:00:00.000Z";
const digest = executionOperationDigest(definition);
const command = {
  operationId: "op_supersession_candidate0001",
  expectedCurrentRevision: 1,
  expectedCurrentDigest: digest,
  expectedControlRevision: 1,
  expectedRootTaskRevision: 2,
  definition,
  reason: "Rewire the approved graph after bounded new evidence."
};
const candidate = {
  candidateId: "supersession_candidate0001",
  operationId: command.operationId,
  planId: "plan_supersession0001",
  baseRevision: 1,
  baseDigest: digest,
  baseControlRevision: 1,
  rootTaskRevision: 2,
  candidateRevision: 2,
  candidateDigest: digest,
  definition,
  author: { kind: "member", memberId: "member_supersession0001" },
  reason: command.reason,
  requestDigest: "a".repeat(64),
  createdAt: at
};
const carry = {
  targetNodeKey: "Build",
  gate: "verified_output",
  sourceAdoptionId: "adoption_supersession_source0001",
  sourceAdoptionDigest: "b".repeat(64),
  sourceReuseContractId: "reuse_supersession_source0001",
  sourceNodeReuseContractDigest: "c".repeat(64),
  sourceReuseInputEvidenceDigest: "d".repeat(64)
};
const activation = {
  operationId: "op_supersession_activate0001",
  expectedCurrentRevision: 1,
  expectedCurrentDigest: digest,
  expectedControlRevision: 1,
  expectedRootTaskRevision: 2,
  candidateId: candidate.candidateId,
  expectedCandidateRevision: 2,
  expectedCandidateDigest: digest,
  carryForward: [carry],
  reason: "Adopt the exact reviewed successor."
};

test("supersession commands separate immutable proposal, activation and carry pins", () => {
  for (const [kind, value] of [
    ["supersessionCandidateCommand", command],
    ["supersessionCandidateRecord", candidate],
    ["supersessionActivationCommand", activation],
    ["agentSupersessionCandidateCommand", {
      runId: "run_supersession0001",
      command
    }],
    ["agentSupersessionActivationCommand", {
      runId: "run_supersession0001",
      delegationId: "replan_supersession0001",
      command: activation
    }]
  ]) {
    assert.doesNotThrow(() => assertExecutionCommand(kind, value));
    assert.throws(() => assertExecutionCommand(kind, {
      ...value,
      authority: "human"
    }));
  }
  assert.throws(() => assertExecutionCommand("supersessionActivationCommand", {
    ...activation,
    carryForward: [{ ...carry, sourceNodeReuseContractDigest: undefined }]
  }));
});

test("replan delegation is exact, expiring and independently revocable", () => {
  const issue = {
    operationId: "op_replan_issue0001",
    expectedPlanRevision: 1,
    expectedPlanDigest: digest,
    expectedControlRevision: 1,
    agentId: "agent_supersession0001",
    expiresAt: "2026-09-03T09:00:00.000Z",
    reason: "Delegate one bounded topology correction."
  };
  const record = {
    delegationId: "replan_supersession0001",
    revision: 1,
    operationId: issue.operationId,
    planId: candidate.planId,
    planRevision: 1,
    planDigest: digest,
    planControlRevision: 1,
    agentId: issue.agentId,
    issuedByMemberId: "member_supersession0001",
    taskIds: ["task_supersession0001"],
    expiresAt: issue.expiresAt,
    reason: issue.reason,
    delegationDigest: "e".repeat(64),
    issuedAt: at
  };
  const revoke = {
    operationId: "op_replan_revoke0001",
    expectedRevision: 1,
    expectedDigest: record.delegationDigest,
    reason: "Withdraw unused delegated authority."
  };
  const revocation = {
    operationId: revoke.operationId,
    delegationId: record.delegationId,
    delegationRevision: 1,
    delegationDigest: record.delegationDigest,
    revokedByMemberId: record.issuedByMemberId,
    reason: revoke.reason,
    revocationDigest: "f".repeat(64),
    revokedAt: at
  };
  for (const [kind, value] of [
    ["replanDelegationIssueCommand", issue],
    ["replanDelegationRecord", record],
    ["replanDelegationRevokeCommand", revoke],
    ["replanDelegationRevocationRecord", revocation]
  ]) {
    assert.doesNotThrow(() => assertExecutionCommand(kind, value));
    assert.throws(() => assertExecutionCommand(kind, { ...value, revision: 0 }));
  }
});
