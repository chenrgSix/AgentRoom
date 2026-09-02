import assert from "node:assert/strict";
import test from "node:test";

import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import { ExecutionError } from "../src/execution/execution-error.js";
import type { ExecutionNodeProjector } from
  "../src/execution/execution-node-projector.js";
import {
  compareExecutionSchedulerCandidates,
  type ExecutionNodeStateRepository,
  type ExecutionSchedulerCandidate
} from "../src/execution/execution-node-state-repository.js";
import { ExecutionScheduler } from
  "../src/execution/execution-scheduler.js";
import type { ExecutionSettlementService } from
  "../src/execution/execution-settlement-service.js";
import type { GovernedRunAdmissionService } from
  "../src/execution/governed-run-admission-service.js";
import type { RunRecord } from "../src/run/run-repository.js";

const now = "2026-09-02T00:00:00.000Z";

function candidate(
  planId: string,
  nodeKey: string,
  topologicalOrdinal: number,
  planApprovedAt = now
): ExecutionSchedulerCandidate {
  return {
    planId,
    planRevision: 1,
    nodeKey,
    planApprovedAt,
    topologicalOrdinal
  };
}

function run(identity: ExecutionSchedulerCandidate): RunRecord {
  return {
    runId: `run_${identity.planId}_${identity.nodeKey}`,
    traceId: `trace_${identity.planId}_${identity.nodeKey}`,
    roomId: "room_scheduler0001",
    taskId: `task_${identity.planId}_${identity.nodeKey}`,
    triggerMessageId: `msg_${identity.planId}_${identity.nodeKey}`,
    requesterMemberId: "member_scheduler0001",
    targetAgentId: `agent_${identity.planId}_${identity.nodeKey}`,
    parentRunId: null,
    instruction: identity.nodeKey,
    state: "queued",
    lastSequence: 0,
    deadlineAt: now,
    createdAt: now,
    updatedAt: now,
    terminalAt: null
  };
}

function schedulerFixture(input: {
  candidates: ExecutionSchedulerCandidate[];
  maxCandidateEvaluations?: number;
  readiness?: (
    candidate: ExecutionSchedulerCandidate,
    evaluation: number
  ) => { ready: true; blocker: null } | { ready: false; blocker: string };
  admit?: (candidate: ExecutionSchedulerCandidate) => RunRecord;
}) {
  const admissions: string[] = [];
  const projections: Array<{ blocker: string | null; key: string }> = [];
  const evaluations = new Map<string, number>();
  let settlementRounds = 0;
  const key = (value: ExecutionSchedulerCandidate): string =>
    `${value.planId}/${value.nodeKey}`;
  const transactions = {
    immediate<T>(work: () => T): T {
      return work();
    }
  } as SqliteTransactionBoundary;
  const nodes = {
    listCandidates: () => structuredClone(input.candidates)
  } as unknown as ExecutionNodeStateRepository;
  const projector = {
    projectReadiness: (
      identity: ExecutionSchedulerCandidate,
      readiness: { ready: boolean; blocker: string | null }
    ) => {
      projections.push({ key: key(identity), blocker: readiness.blocker });
      return {};
    }
  } as unknown as ExecutionNodeProjector;
  const settlement = {
    reconcile: () => {
      settlementRounds += 1;
      return [];
    },
    reconcileOne: () => ({})
  } as unknown as ExecutionSettlementService;
  const admission = {
    readiness: (identity: ExecutionSchedulerCandidate) => {
      const identityKey = key(identity);
      const evaluation = (evaluations.get(identityKey) ?? 0) + 1;
      evaluations.set(identityKey, evaluation);
      return input.readiness?.(identity, evaluation) ?? {
        ready: true as const,
        blocker: null
      };
    },
    admitScheduled: (identity: ExecutionSchedulerCandidate) => {
      const admitted = input.admit?.(identity) ?? run(identity);
      admissions.push(key(identity));
      return { created: true, runs: [admitted] };
    }
  } as unknown as GovernedRunAdmissionService;
  const scheduler = new ExecutionScheduler(
    transactions,
    nodes,
    projector,
    settlement,
    admission,
    () => now,
    input.maxCandidateEvaluations
  );
  return {
    admissions,
    evaluations,
    projections,
    scheduler,
    settlementRounds: () => settlementRounds
  };
}

test("scheduler admits at most one node per plan in each fair round", () => {
  const f = schedulerFixture({
    candidates: [
      candidate("plan_a", "A1", 0),
      candidate("plan_a", "A2", 1),
      candidate("plan_b", "B1", 0),
      candidate("plan_b", "B2", 1)
    ]
  });
  const runs = f.scheduler.sweep();
  assert.deepEqual(f.admissions, [
    "plan_a/A1",
    "plan_b/B1",
    "plan_a/A2",
    "plan_b/B2"
  ]);
  assert.deepEqual(runs.map((entry) => entry.runId), [
    "run_plan_a_A1",
    "run_plan_b_B1",
    "run_plan_a_A2",
    "run_plan_b_B2"
  ]);
  assert.equal(f.settlementRounds(), 2);
});

test("scheduler revisits a newly unblocked node in a later bounded round", () => {
  let admittedSibling = false;
  const f = schedulerFixture({
    candidates: [
      candidate("plan_a", "Blocked", 0),
      candidate("plan_a", "Ready", 1)
    ],
    readiness: (identity) => identity.nodeKey === "Blocked" && !admittedSibling
      ? { ready: false, blocker: "EXECUTION_DEPENDENCY_NOT_MATERIALIZED" }
      : { ready: true, blocker: null },
    admit: (identity) => {
      if (identity.nodeKey === "Ready") admittedSibling = true;
      return run(identity);
    }
  });
  f.scheduler.sweep();
  assert.deepEqual(f.admissions, ["plan_a/Ready", "plan_a/Blocked"]);
  assert.equal(f.evaluations.get("plan_a/Blocked"), 2);
  assert.equal(f.settlementRounds(), 2);
});

test("scheduler isolates one admission fault and honors its evaluation bound", () => {
  const f = schedulerFixture({
    candidates: [
      candidate("plan_a", "Fault", 0),
      candidate("plan_a", "HealthyA", 1),
      candidate("plan_b", "HealthyB", 0)
    ],
    maxCandidateEvaluations: 3,
    admit: (identity) => {
      if (identity.nodeKey === "Fault") {
        throw new ExecutionError("EXECUTION_GRANT_UNAVAILABLE");
      }
      return run(identity);
    }
  });
  f.scheduler.sweep();
  assert.deepEqual(f.admissions, ["plan_a/HealthyA", "plan_b/HealthyB"]);
  assert.equal(f.evaluations.get("plan_a/Fault"), 1);
  assert.ok(f.projections.some((entry) =>
    entry.key === "plan_a/Fault" &&
    entry.blocker === "EXECUTION_GRANT_UNAVAILABLE"
  ));
  assert.equal(f.settlementRounds(), 1);
});

test("candidate ordering is stable across insertion permutations", () => {
  const expected = [
    candidate("plan_a", "A1", 0, "2026-09-01T23:59:59.000Z"),
    candidate("plan_a", "A2", 1, "2026-09-01T23:59:59.000Z"),
    candidate("plan_b", "B1", 0),
    candidate("plan_b", "B2", 1)
  ];
  const permutations = [
    expected,
    [...expected].reverse(),
    [expected[2]!, expected[0]!, expected[3]!, expected[1]!]
  ];
  for (const permutation of permutations) {
    assert.deepEqual(
      [...permutation].sort(compareExecutionSchedulerCandidates),
      expected
    );
  }
});
