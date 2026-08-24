import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type Database from "better-sqlite3";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import {
  DiscussionOrchestrator,
  type DiscussionMutationResult
} from "../src/discussion/discussion-orchestrator.js";
import { DiscussionRepository } from "../src/discussion/discussion-repository.js";
import { createOpaqueId } from "../src/domain/identifiers.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository, type RunRecord } from "../src/run/run-repository.js";
import { AuthService, type WebPrincipal } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-23T10:00:00.000Z";

interface OrchestratorFixture {
  close(): void;
  clock: { value: string };
  core: CoreRepository;
  database: Database.Database;
  discussions: DiscussionRepository;
  orchestrator: DiscussionOrchestrator;
  restart(): DiscussionOrchestrator;
  principal: WebPrincipal;
  roomId: string;
  agentIds: string[];
  runs: RunRepository;
}

async function fixture(
  clock: { value: string } = { value: now }
): Promise<OrchestratorFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-orchestrator-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const restartedDatabases: Database.Database[] = [];
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const messages = new MessageService(core, auth);
  const runs = new RunRepository(database);
  const discussions = new DiscussionRepository(database);
  const created = teams.createTeamForUser({
    userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    userDisplayName: "Alice",
    teamName: "Architecture",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-24T10:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "review", now);
  const device = registry.registerOwnDevice(
    principal,
    created.team.teamId,
    "Test Bridge",
    now
  );
  const agentIds = ["Coder", "Reviewer"].map((name) => agents.publishAgent(principal, {
    teamId: created.team.teamId,
    deviceId: device.deviceId,
    name,
    role: name,
    integrationMode: "fake",
    capabilities: {
      supportsHandoff: true,
      supportsInterrupt: true,
      supportsResume: false,
      supportsStart: true,
      supportsStreaming: true
    },
    now
  }).agentId);
  return {
    close: () => {
      for (const restartedDatabase of restartedDatabases.reverse()) {
        restartedDatabase.close();
      }
      database.close();
    },
    clock,
    core,
    database,
    discussions,
    orchestrator: new DiscussionOrchestrator(
      core, messages, discussions, runs, auth, () => clock.value
    ),
    restart: () => {
      const restartedDatabase = openDatabase(databasePath);
      restartedDatabases.push(restartedDatabase);
      const restartedCore = new CoreRepository(restartedDatabase);
      const restartedAuth = new AuthService(restartedDatabase);
      return new DiscussionOrchestrator(
        restartedCore,
        new MessageService(restartedCore, restartedAuth),
        new DiscussionRepository(restartedDatabase),
        new RunRepository(restartedDatabase),
        restartedAuth,
        () => clock.value
      );
    },
    principal,
    roomId: room.roomId,
    agentIds,
    runs
  };
}

function completeRun(input: {
  core: CoreRepository;
  runs: RunRepository;
  run: RunRecord;
  content: string;
  assessment?: Record<string, unknown>;
}): void {
  input.runs.applyEvent(input.run.runId, {
    type: "status", sequence: 1, status: "working"
  }, now);
  input.runs.applyEvent(input.run.runId, {
    type: "reply",
    sequence: 2,
    content: input.content,
    ...(input.assessment ? { assessment: input.assessment } : {})
  }, now);
  input.core.appendMessage({
    messageId: createOpaqueId("msg"),
    roomId: input.run.roomId,
    senderType: "agent",
    senderId: input.run.targetAgentId,
    content: input.content,
    mentions: [],
    parentMessageId: input.run.triggerMessageId,
    createdAt: now
  });
  input.runs.applyEvent(input.run.runId, {
    type: "status", sequence: 3, status: "completed"
  }, now);
}

function stageRunReply(input: {
  core: CoreRepository;
  runs: RunRepository;
  run: RunRecord;
  content: string;
  assessment?: Record<string, unknown>;
}): void {
  input.runs.applyEvent(input.run.runId, {
    type: "status", sequence: 1, status: "working"
  }, now);
  input.runs.applyEvent(input.run.runId, {
    type: "reply",
    sequence: 2,
    content: input.content,
    ...(input.assessment ? { assessment: input.assessment } : {})
  }, now);
  input.core.appendMessage({
    messageId: createOpaqueId("msg"),
    roomId: input.run.roomId,
    senderType: "agent",
    senderId: input.run.targetAgentId,
    content: input.content,
    mentions: [],
    parentMessageId: input.run.triggerMessageId,
    createdAt: now
  });
}

function finishStagedRun(runs: RunRepository, run: RunRecord): void {
  runs.applyEvent(run.runId, {
    type: "status", sequence: 3, status: "completed"
  }, now);
}

function recentTranscript(instruction: string): string {
  const startMarker = "## Recent Room Transcript\n";
  const endMarker = "\n\n## Your Task";
  const start = instruction.indexOf(startMarker);
  const end = instruction.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "instruction must contain a transcript section");
  assert.notEqual(end, -1, "instruction must terminate the transcript section");
  return instruction.slice(start + startMarker.length, end);
}

function failRun(runs: RunRepository, run: RunRecord): void {
  runs.applyEvent(run.runId, {
    type: "status", sequence: 1, status: "working"
  }, now);
  runs.applyEvent(run.runId, {
    type: "status",
    sequence: 2,
    status: "failed",
    error: {
      code: "TEST_RUNTIME_FAILURE",
      message: "The scripted participant failed.",
      retryable: false
    }
  }, now);
}

function requireTerminalResult(
  value: DiscussionMutationResult | null
): DiscussionMutationResult {
  assert.ok(value, "a Discussion-owned terminal Run must return a mutation result");
  return value;
}

function sortedRunIds(runs: readonly RunRecord[]): string[] {
  return runs.map(({ runId }) => runId).sort();
}

test("Room policy can disable new Agent Discussions", async () => {
  const environment = await fixture();
  try {
    environment.core.replaceRoomSettings(
      environment.roomId,
      environment.core.getRoomParticipants(environment.roomId),
      {
        allowDiscussion: false,
        allowAll: true,
        allowAgentMentions: true,
        maxAgentMentionDepth: 4
      },
      now
    );
    assert.throws(() => environment.orchestrator.create(environment.principal, {
      roomId: environment.roomId,
      goal: "This Discussion is disabled by Room policy",
      participantAgentIds: environment.agentIds
    }), /Room policy does not allow Agent Discussions/u);
    assert.equal(environment.discussions.listForRoom(environment.roomId).length, 0);
  } finally {
    environment.close();
  }
});

test("create fans one Wave out to every participant and advances only after its barrier", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Choose deterministic cancel semantics.",
      participantAgentIds: value.agentIds,
      mode: "review",
      outputMode: "decision_record"
    });

    assert.equal(result.discussion.executionModel, "parallel_wave");
    assert.equal(result.discussion.currentWave, 1);
    assert.deepEqual(
      value.core.getMessage(result.discussion.rootMessageId)?.mentions
        .map(({ targetAgentId }) => targetAgentId),
      value.agentIds
    );
    assert.equal(result.scheduledRuns.length, 2);
    assert.deepEqual(
      result.scheduledRuns.map(({ targetAgentId }) => targetAgentId),
      value.agentIds
    );
    assert.equal(new Set(result.scheduledRuns.map(({ triggerMessageId }) =>
      triggerMessageId
    )).size, 1);
    assert.equal(result.waves.length, 1);
    assert.equal(result.waves[0]?.expectedMembers, 2);
    assert.equal(result.waves[0]?.state, "open");
    assert.equal(new Set(result.turns.map(({ waveId }) => waveId)).size, 1);

    const [coder, reviewer] = result.scheduledRuns;
    assert.ok(coder);
    assert.ok(reviewer);
    completeRun({
      core: value.core,
      runs: value.runs,
      run: coder,
      content: "Persist the first accepted terminal outcome.",
      assessment: {
        newInformationAdded: true,
        newEvidenceRefs: ["coder:first-terminal"],
        recommendation: "continue"
      }
    });
    result = requireTerminalResult(value.orchestrator.onRunTerminal(coder.runId));

    assert.equal(result.scheduledRuns.length, 0);
    assert.equal(result.discussion.currentWave, 1);
    assert.equal(result.discussion.progress.version, 0);
    assert.equal(result.discussion.budget.turnsUsed, 0);
    assert.equal(result.discussion.budget.agentRunsUsed, 0);
    assert.equal(result.waves[0]?.state, "open");

    completeRun({
      core: value.core,
      runs: value.runs,
      run: reviewer,
      content: "Reject later terminal outcomes as duplicate evidence.",
      assessment: {
        newInformationAdded: true,
        newEvidenceRefs: ["reviewer:duplicate-rejection"],
        recommendation: "continue"
      }
    });
    result = requireTerminalResult(value.orchestrator.onRunTerminal(reviewer.runId));

    assert.equal(result.discussion.state, "active");
    assert.equal(result.discussion.currentWave, 2);
    assert.equal(result.discussion.progress.version, 1);
    assert.equal(result.discussion.budget.turnsUsed, 1);
    assert.equal(result.discussion.budget.agentRunsUsed, 2);
    assert.equal(result.waves[0]?.state, "completed");
    assert.equal(result.waves[1]?.state, "open");
    assert.equal(result.scheduledRuns.length, 2);

    const nextRunIds = sortedRunIds(result.scheduledRuns);
    const turnsAfterBarrier = result.turns.length;
    const duplicate = requireTerminalResult(
      value.orchestrator.onRunTerminal(reviewer.runId)
    );
    assert.equal(duplicate.scheduledRuns.length, 0);
    assert.equal(duplicate.turns.length, turnsAfterBarrier);
    assert.deepEqual(
      sortedRunIds(value.runs.listRoomRuns(value.roomId)
        .filter(({ runId }) => nextRunIds.includes(runId))),
      nextRunIds
    );
    assert.equal(
      value.discussions.listBudgetEvents(result.discussion.discussionId)
        .filter(({ eventType }) => eventType === "turn_recorded").length,
      1
    );
  } finally {
    value.close();
  }
});

test("Wave aggregation is invariant to participant callback order", async () => {
  async function runInOrder(order: readonly number[]) {
    const value = await fixture();
    try {
      let result = value.orchestrator.create(value.principal, {
        roomId: value.roomId,
        goal: "Collect stable recovery evidence.",
        participantAgentIds: value.agentIds
      });
      const runs = result.scheduledRuns;
      assert.equal(runs.length, 2);
      const evidence = [
        {
          content: "Persist dispatch intent before delivery.",
          assessment: {
            newInformationAdded: true,
            newEvidenceRefs: ["evidence:dispatch-intent"],
            openQuestions: [{
              id: "question:cancel-race",
              question: "Which terminal outcome wins a cancel race?",
              importance: "medium"
            }],
            disagreementRemaining: "low",
            recommendation: "continue"
          }
        },
        {
          content: "Recover a missing Run by its orchestration key.",
          assessment: {
            newInformationAdded: true,
            newEvidenceRefs: ["evidence:orchestration-key"],
            disagreementRemaining: "medium",
            recommendation: "continue"
          }
        }
      ] as const;

      for (const index of order) {
        const run = runs[index];
        const response = evidence[index];
        assert.ok(run);
        assert.ok(response);
        completeRun({ core: value.core, runs: value.runs, run, ...response });
        result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
      }

      return {
        progress: result.discussion.progress,
        firstWave: result.waves[0],
        scheduledOrdinals: result.scheduledRuns.map(({ targetAgentId }) =>
          result.participants.find(({ agentId }) => agentId === targetAgentId)?.ordinal
        )
      };
    } finally {
      value.close();
    }
  }

  const forward = await runInOrder([0, 1]);
  const reverse = await runInOrder([1, 0]);
  assert.deepEqual(reverse.progress, forward.progress);
  assert.equal(forward.firstWave?.state, "completed");
  assert.equal(reverse.firstWave?.state, "completed");
  assert.deepEqual(forward.scheduledOrdinals, [0, 1]);
  assert.deepEqual(reverse.scheduledOrdinals, [0, 1]);
});

test("a partial Wave continues while an all-failed Wave waits for a human", async () => {
  const partial = await fixture();
  try {
    let result = partial.orchestrator.create(partial.principal, {
      roomId: partial.roomId,
      goal: "Continue with the evidence that remains available.",
      participantAgentIds: partial.agentIds
    });
    const [failed, successful] = result.scheduledRuns;
    assert.ok(failed);
    assert.ok(successful);
    failRun(partial.runs, failed);
    result = requireTerminalResult(partial.orchestrator.onRunTerminal(failed.runId));
    assert.equal(result.scheduledRuns.length, 0);
    completeRun({
      core: partial.core,
      runs: partial.runs,
      run: successful,
      content: "The durable inbox still provides usable recovery evidence.",
      assessment: {
        newInformationAdded: true,
        newEvidenceRefs: ["evidence:durable-inbox"],
        recommendation: "continue"
      }
    });
    result = requireTerminalResult(partial.orchestrator.onRunTerminal(successful.runId));
    assert.equal(result.waves[0]?.state, "partial");
    assert.equal(result.discussion.state, "active");
    assert.equal(result.discussion.budget.turnsUsed, 1);
    assert.equal(result.discussion.budget.agentRunsUsed, 2);
    assert.equal(result.scheduledRuns.length, 2);
  } finally {
    partial.close();
  }

  const allFailed = await fixture();
  try {
    let result = allFailed.orchestrator.create(allFailed.principal, {
      roomId: allFailed.roomId,
      goal: "Require at least one successful participant.",
      participantAgentIds: allFailed.agentIds
    });
    const [first, second] = result.scheduledRuns;
    assert.ok(first);
    assert.ok(second);
    failRun(allFailed.runs, first);
    result = requireTerminalResult(allFailed.orchestrator.onRunTerminal(first.runId));
    assert.equal(result.scheduledRuns.length, 0);
    failRun(allFailed.runs, second);
    result = requireTerminalResult(allFailed.orchestrator.onRunTerminal(second.runId));

    assert.equal(result.waves[0]?.state, "failed");
    assert.equal(result.discussion.state, "waiting_human");
    assert.equal(result.discussion.stateReason, "runtime_failure");
    assert.equal(result.scheduledRuns.length, 0);
    assert.equal(result.discussion.budget.turnsUsed, 1);
    assert.equal(result.discussion.budget.agentRunsUsed, 2);
  } finally {
    allFailed.close();
  }
});

test("cancel returns every active Wave Run id", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Cancel all parallel participants together.",
      participantAgentIds: value.agentIds
    });
    const expectedRunIds = sortedRunIds(created.scheduledRuns);
    assert.equal(expectedRunIds.length, 2);

    const canceled = value.orchestrator.control(
      value.principal,
      created.discussion.discussionId,
      { action: "cancel" }
    );

    assert.equal(canceled.discussion.state, "canceled");
    assert.equal(canceled.discussion.stateReason, "user_canceled");
    assert.deepEqual([...canceled.cancelRunIds].sort(), expectedRunIds);
    assert.equal(canceled.scheduledRuns.length, 0);
  } finally {
    value.close();
  }
});

test("automatic completion waits for the Wave barrier then schedules one finalizer", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Choose one authoritative terminal-state rule.",
      participantAgentIds: value.agentIds,
      outputMode: "decision_record"
    });
    const [coder, reviewer] = result.scheduledRuns;
    assert.ok(coder);
    assert.ok(reviewer);
    const completionAssessment = {
      goalSatisfied: true,
      confidence: 0.96,
      newInformationAdded: true,
      disagreementRemaining: "none",
      recommendation: "finish"
    };

    completeRun({
      core: value.core,
      runs: value.runs,
      run: coder,
      content: "The first persisted terminal state is authoritative.",
      assessment: completionAssessment
    });
    result = requireTerminalResult(value.orchestrator.onRunTerminal(coder.runId));
    assert.equal(result.discussion.state, "active");
    assert.equal(result.scheduledRuns.length, 0);

    completeRun({
      core: value.core,
      runs: value.runs,
      run: reviewer,
      content: "The rule is deterministic and ready for a decision record.",
      assessment: completionAssessment
    });
    result = requireTerminalResult(value.orchestrator.onRunTerminal(reviewer.runId));

    assert.equal(result.discussion.state, "finalizing");
    assert.equal(result.discussion.stateReason, "goal_satisfied");
    assert.equal(result.scheduledRuns.length, 1);
    assert.equal(result.waves.length, 2);
    assert.equal(result.waves[1]?.phase, "finalization");
    assert.equal(result.waves[1]?.expectedMembers, 1);
    assert.equal(
      result.turns.filter(({ kind }) => kind === "finalization").length,
      1
    );

    const finalRun = result.scheduledRuns[0];
    assert.ok(finalRun);
    assert.match(finalRun.instruction, /Produce the final decision record/);
    completeRun({
      core: value.core,
      runs: value.runs,
      run: finalRun,
      content: "Decision: the first persisted terminal state wins."
    });
    result = requireTerminalResult(value.orchestrator.onRunTerminal(finalRun.runId));

    assert.equal(result.discussion.state, "completed");
    assert.equal(result.scheduledRuns.length, 0);
    assert.equal(result.waves[1]?.state, "completed");
  } finally {
    value.close();
  }
});

test("continue after an all-failed Wave uses a fresh system anchor", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Retry a failed Wave without reusing an idempotency anchor.",
      participantAgentIds: value.agentIds
    });
    const firstWaveRuns = result.scheduledRuns;
    assert.equal(firstWaveRuns.length, 2);
    for (const run of firstWaveRuns) {
      failRun(value.runs, run);
      result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
    }
    assert.equal(result.discussion.state, "waiting_human");
    assert.equal(result.waves[0]?.state, "failed");

    result = value.orchestrator.control(
      value.principal,
      result.discussion.discussionId,
      { action: "continue" }
    );

    assert.equal(result.discussion.state, "active");
    assert.equal(result.discussion.currentWave, 2);
    assert.equal(result.scheduledRuns.length, 2);
    const anchors = new Set(result.scheduledRuns.map(({ triggerMessageId }) =>
      triggerMessageId
    ));
    assert.equal(anchors.size, 1);
    const [anchorId] = [...anchors];
    assert.notEqual(anchorId, result.discussion.rootMessageId);
    const anchor = anchorId ? value.core.getMessage(anchorId) : undefined;
    assert.equal(anchor?.senderType, "system");
    assert.equal(anchor?.senderId, result.discussion.discussionId);
    assert.equal(anchor?.parentMessageId, result.discussion.rootMessageId);
  } finally {
    value.close();
  }
});

test("expired Wave members converge to waiting_human at the durable deadline", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Bound a Wave that no Runtime accepts.",
      participantAgentIds: value.agentIds,
      policy: { waveTimeoutSeconds: 30 }
    });
    value.clock.value = "2026-08-23T10:00:31.000Z";

    assert.deepEqual(value.orchestrator.expireDueWaves(), []);

    const view = value.orchestrator.get(
      value.principal,
      created.discussion.discussionId
    );
    assert.equal(view.discussion.state, "waiting_human");
    assert.equal(view.discussion.stateReason, "runtime_failure");
    assert.equal(view.waves[0]?.state, "failed");
    assert.deepEqual(
      created.scheduledRuns.map(({ runId }) => value.runs.getRun(runId)?.state),
      ["expired", "expired"]
    );
    assert.deepEqual(
      view.turns.map(({ terminalReason }) => terminalReason),
      ["run_expired", "run_expired"]
    );
  } finally {
    value.close();
  }
});

test("a working Wave member becomes outcome_unknown when the deadline passes", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Do not pretend an accepted Runtime never executed.",
      participantAgentIds: value.agentIds,
      policy: { waveTimeoutSeconds: 30 }
    });
    const [working, queued] = created.scheduledRuns;
    assert.ok(working);
    assert.ok(queued);
    value.runs.applyEvent(working.runId, {
      type: "status", sequence: 1, status: "working"
    }, now);
    value.clock.value = "2026-08-23T10:00:31.000Z";

    value.orchestrator.expireDueWaves();

    assert.equal(value.runs.getRun(working.runId)?.state, "outcome_unknown");
    assert.equal(value.runs.getRun(queued.runId)?.state, "expired");
    const view = value.orchestrator.get(
      value.principal,
      created.discussion.discussionId
    );
    assert.equal(view.discussion.state, "waiting_human");
    assert.equal(view.waves[0]?.state, "failed");
    assert.deepEqual(
      view.turns.map(({ terminalReason }) => terminalReason),
      ["run_outcome_unknown", "run_expired"]
    );
  } finally {
    value.close();
  }
});

test("input_required waits for the Wave barrier before selecting its state reason", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Escalate non-resumable participant input.",
      participantAgentIds: value.agentIds
    });
    const [blocked, successful] = result.scheduledRuns;
    assert.ok(blocked);
    assert.ok(successful);
    value.runs.applyEvent(blocked.runId, {
      type: "status", sequence: 1, status: "input_required"
    }, now);

    result = requireTerminalResult(
      value.orchestrator.onRunInputRequired(blocked.runId)
    );
    assert.equal(result.discussion.state, "active");
    assert.equal(result.waves[0]?.state, "open");
    assert.equal(result.scheduledRuns.length, 0);

    completeRun({
      core: value.core,
      runs: value.runs,
      run: successful,
      content: "The other participant produced recoverable evidence.",
      assessment: {
        newInformationAdded: true,
        recommendation: "continue"
      }
    });
    result = requireTerminalResult(
      value.orchestrator.onRunTerminal(successful.runId)
    );

    assert.equal(result.discussion.state, "waiting_human");
    assert.equal(result.discussion.stateReason, "input_required");
    assert.equal(result.waves[0]?.state, "partial");
    assert.equal(result.scheduledRuns.length, 0);
    assert.equal(
      result.turns.find(({ runId }) => runId === blocked.runId)?.terminalReason,
      "input_required"
    );
  } finally {
    value.close();
  }
});

test("finalizing rejects goal and pause changes while repeated finish is idempotent", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Freeze control semantics once final output begins.",
      participantAgentIds: value.agentIds
    });
    for (const run of result.scheduledRuns) {
      completeRun({
        core: value.core,
        runs: value.runs,
        run,
        content: `Completion evidence from ${run.targetAgentId}.`,
        assessment: {
          goalSatisfied: true,
          confidence: 0.95,
          newInformationAdded: true,
          disagreementRemaining: "none",
          recommendation: "finish"
        }
      });
      result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
    }
    assert.equal(result.discussion.state, "finalizing");
    assert.equal(result.scheduledRuns.length, 1);
    const decisionCount = result.decisions.length;
    const turnCount = result.turns.length;

    assert.throws(
      () => value.orchestrator.control(
        value.principal,
        result.discussion.discussionId,
        { action: "adjust_goal", goal: "A different goal." }
      ),
      /cannot adjust_goal while finalizing/u
    );
    assert.throws(
      () => value.orchestrator.control(
        value.principal,
        result.discussion.discussionId,
        { action: "pause" }
      ),
      /cannot pause while finalizing/u
    );

    const firstFinish = value.orchestrator.control(
      value.principal,
      result.discussion.discussionId,
      { action: "finish" }
    );
    const repeatedFinish = value.orchestrator.control(
      value.principal,
      result.discussion.discussionId,
      { action: "finish" }
    );
    assert.equal(repeatedFinish.discussion.state, "finalizing");
    assert.equal(firstFinish.decisions.length, decisionCount);
    assert.equal(repeatedFinish.decisions.length, decisionCount);
    assert.equal(repeatedFinish.turns.length, turnCount);
    assert.equal(repeatedFinish.scheduledRuns.length, 0);
  } finally {
    value.close();
  }
});

test("recovery terminates queued Runs and closes a canceled Wave", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Recover cancellation after the server stops dispatching.",
      participantAgentIds: value.agentIds
    });
    const runIds = sortedRunIds(created.scheduledRuns);
    const canceled = value.orchestrator.control(
      value.principal,
      created.discussion.discussionId,
      { action: "cancel" }
    );
    assert.deepEqual([...canceled.cancelRunIds].sort(), runIds);

    assert.deepEqual(value.orchestrator.recover(), []);

    const view = value.orchestrator.get(
      value.principal,
      created.discussion.discussionId
    );
    assert.equal(view.discussion.state, "canceled");
    assert.equal(view.waves[0]?.state, "canceled");
    assert.deepEqual(
      runIds.map((runId) => value.runs.getRun(runId)?.state),
      ["canceled", "canceled"]
    );
    assert.deepEqual(
      view.turns.map(({ state }) => state),
      ["canceled", "canceled"]
    );
  } finally {
    value.close();
  }
});

test("a disabled participant is omitted from the next Wave", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Do not dispatch future work to a disabled Agent.",
      participantAgentIds: value.agentIds
    });
    const disabledAgentId = value.agentIds[1];
    assert.ok(disabledAgentId);
    const disabledAgent = value.core.getAgent(disabledAgentId);
    assert.ok(disabledAgent);
    value.core.updateAgentPublication({
      ...disabledAgent,
      enabled: false,
      updatedAt: now
    });

    for (const run of result.scheduledRuns) {
      completeRun({
        core: value.core,
        runs: value.runs,
        run,
        content: `Independent evidence from ${run.targetAgentId}.`,
        assessment: {
          newInformationAdded: true,
          recommendation: "continue"
        }
      });
      result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
    }

    assert.equal(result.discussion.state, "active");
    assert.equal(result.discussion.currentWave, 2);
    assert.equal(result.waves[1]?.expectedMembers, 1);
    assert.equal(result.scheduledRuns.length, 1);
    assert.equal(result.scheduledRuns[0]?.targetAgentId, value.agentIds[0]);
  } finally {
    value.close();
  }
});

test("recovery resumes an atomically planned Wave across the Run bind cut", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Recover the durable next Wave without duplicating its barrier effects.",
      participantAgentIds: value.agentIds
    });
    for (const run of result.scheduledRuns) {
      completeRun({
        core: value.core,
        runs: value.runs,
        run,
        content: `Durable Wave evidence from ${run.targetAgentId}.`,
        assessment: { newInformationAdded: true, recommendation: "continue" }
      });
      result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
    }
    assert.equal(result.discussion.currentWave, 2);
    assert.equal(result.scheduledRuns.length, 2);
    const nextWave = result.waves[1];
    assert.ok(nextWave);
    const nextTurns = result.turns.filter(({ waveId }) => waveId === nextWave.waveId);
    assert.equal(nextTurns.length, 2);
    const keyedTurn = nextTurns[0];
    const missingTurn = nextTurns[1];
    assert.ok(keyedTurn?.runId);
    assert.ok(missingTurn?.runId);
    const keyedRunId = keyedTurn.runId;
    const deletedRunId = missingTurn.runId;

    value.database.prepare(`
      UPDATE discussion_turns
      SET run_id = NULL, state = 'planned'
      WHERE turn_id IN (?, ?)
    `).run(keyedTurn.turnId, missingTurn.turnId);
    value.database.prepare("DELETE FROM runs WHERE run_id = ?").run(deletedRunId);

    const stableCounts = {
      waves: value.discussions.listWaves(result.discussion.discussionId).length,
      decisions: value.discussions.listDecisions(result.discussion.discussionId).length,
      budgetEvents: value.discussions.listBudgetEvents(result.discussion.discussionId).length
    };
    const restarted = value.restart();
    const recovered = restarted.recover();

    assert.equal(recovered.length, 2);
    assert.ok(recovered.some(({ runId }) => runId === keyedRunId));
    assert.ok(recovered.every(({ runId }) => runId !== deletedRunId));
    const rebound = value.discussions.listTurnsForWave(nextWave.waveId);
    assert.equal(rebound[0]?.runId, keyedRunId);
    assert.ok(rebound[1]?.runId);
    assert.notEqual(rebound[1]?.runId, deletedRunId);
    assert.equal(value.runs.listRoomRuns(value.roomId).length, 4);
    assert.deepEqual({
      waves: value.discussions.listWaves(result.discussion.discussionId).length,
      decisions: value.discussions.listDecisions(result.discussion.discussionId).length,
      budgetEvents: value.discussions.listBudgetEvents(result.discussion.discussionId).length
    }, stableCounts);

    assert.deepEqual(
      sortedRunIds(restarted.recover()),
      sortedRunIds(recovered)
    );
    assert.equal(value.runs.listRoomRuns(value.roomId).length, 4);
    assert.deepEqual({
      waves: value.discussions.listWaves(result.discussion.discussionId).length,
      decisions: value.discussions.listDecisions(result.discussion.discussionId).length,
      budgetEvents: value.discussions.listBudgetEvents(result.discussion.discussionId).length
    }, stableCounts);
  } finally {
    value.close();
  }
});

test("recovery preserves a partially settled Wave until its remaining member finishes", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Keep the settled member durable while the other member resumes.",
      participantAgentIds: value.agentIds
    });
    const settledRun = created.scheduledRuns[0];
    const pendingRun = created.scheduledRuns[1];
    assert.ok(settledRun);
    assert.ok(pendingRun);
    completeRun({
      core: value.core,
      runs: value.runs,
      run: settledRun,
      content: "The first durable contribution is complete.",
      assessment: { newInformationAdded: true, recommendation: "continue" }
    });
    const partial = requireTerminalResult(
      value.orchestrator.onRunTerminal(settledRun.runId)
    );
    assert.equal(partial.waves[0]?.state, "open");
    assert.deepEqual(
      partial.turns.map(({ state }) => state),
      ["completed", "queued"]
    );
    const stableCounts = {
      waves: partial.waves.length,
      decisions: partial.decisions.length,
      budgetEvents: value.discussions.listBudgetEvents(
        partial.discussion.discussionId
      ).length
    };

    const restarted = value.restart();
    const recovered = restarted.recover();

    assert.deepEqual(recovered.map(({ runId }) => runId), [pendingRun.runId]);
    const recoveredView = restarted.get(
      value.principal,
      created.discussion.discussionId
    );
    assert.equal(recoveredView.waves[0]?.state, "open");
    assert.deepEqual(
      recoveredView.turns.map(({ state }) => state),
      ["completed", "queued"]
    );
    assert.deepEqual({
      waves: recoveredView.waves.length,
      decisions: recoveredView.decisions.length,
      budgetEvents: value.discussions.listBudgetEvents(
        partial.discussion.discussionId
      ).length
    }, stableCounts);

    completeRun({
      core: value.core,
      runs: value.runs,
      run: pendingRun,
      content: "The remaining durable contribution is complete.",
      assessment: { newInformationAdded: true, recommendation: "continue" }
    });
    const advanced = requireTerminalResult(
      restarted.onRunTerminal(pendingRun.runId)
    );
    assert.equal(advanced.waves[0]?.state, "completed");
    assert.equal(advanced.discussion.currentWave, 2);
    assert.equal(advanced.scheduledRuns.length, 2);
  } finally {
    value.close();
  }
});

test("Wave result anchors and next transcripts ignore callback and Room arrival order", async () => {
  async function converge(
    arrivalOrder: readonly number[],
    callbackOrder: readonly number[]
  ): Promise<{ anchorContent: string; transcripts: string[] }> {
    const value = await fixture();
    try {
      let result = value.orchestrator.create(value.principal, {
        roomId: value.roomId,
        goal: "Keep Wave aggregation deterministic.",
        participantAgentIds: value.agentIds
      });
      const runs = result.scheduledRuns;
      const replies = [
        "Coder contributes the first participant-ordered fact.",
        "Reviewer contributes the second participant-ordered fact."
      ];
      for (const index of arrivalOrder) {
        const run = runs[index];
        const content = replies[index];
        assert.ok(run);
        assert.ok(content);
        stageRunReply({
          core: value.core,
          runs: value.runs,
          run,
          content,
          assessment: { newInformationAdded: true, recommendation: "continue" }
        });
      }
      for (const index of callbackOrder) {
        const run = runs[index];
        assert.ok(run);
        finishStagedRun(value.runs, run);
        result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
      }

      const firstWave = result.waves[0];
      const nextWave = result.waves[1];
      assert.ok(firstWave);
      assert.ok(nextWave);
      const expectedAnchorId = `msg_wave_${firstWave.waveId.slice(5)}`;
      assert.equal(nextWave.inputMessageId, expectedAnchorId);
      assert.ok(result.scheduledRuns.every(({ triggerMessageId }) =>
        triggerMessageId === expectedAnchorId
      ));
      const anchor = value.core.getMessage(expectedAnchorId);
      assert.ok(anchor);
      return {
        anchorContent: anchor.content,
        transcripts: result.scheduledRuns.map(({ instruction }) =>
          recentTranscript(instruction)
        )
      };
    } finally {
      value.close();
    }
  }

  const forwardArrival = await converge([0, 1], [1, 0]);
  const reverseArrival = await converge([1, 0], [0, 1]);
  const expectedAnchor = [
    "第 1 轮已收敛。",
    "- Coder: completed",
    "- Reviewer: completed"
  ].join("\n");
  assert.equal(forwardArrival.anchorContent, expectedAnchor);
  assert.equal(reverseArrival.anchorContent, expectedAnchor);
  assert.deepEqual(reverseArrival.transcripts, forwardArrival.transcripts);
  for (const transcript of forwardArrival.transcripts) {
    assert.ok(
      transcript.indexOf("Coder contributes") < transcript.indexOf("Reviewer contributes")
    );
  }
});

test("recovery reuses a Wave result anchor written before barrier closure", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Retry the deterministic anchor side effect after a crash.",
      participantAgentIds: value.agentIds
    });
    const firstWave = created.waves[0];
    assert.ok(firstWave);
    for (const [index, run] of created.scheduledRuns.entries()) {
      stageRunReply({
        core: value.core,
        runs: value.runs,
        run,
        content: `Crash-retry evidence ${index + 1}.`,
        assessment: { newInformationAdded: true, recommendation: "continue" }
      });
      finishStagedRun(value.runs, run);
    }
    const anchorId = `msg_wave_${firstWave.waveId.slice(5)}`;
    const root = value.core.getMessage(created.discussion.rootMessageId);
    assert.ok(root);
    value.core.appendMessage({
      messageId: anchorId,
      roomId: value.roomId,
      senderType: "system",
      senderId: created.discussion.discussionId,
      content: [
        "第 1 轮已收敛。",
        "- Coder: completed",
        "- Reviewer: completed"
      ].join("\n"),
      mentions: [],
      parentMessageId: firstWave.inputMessageId,
      traceId: root.traceId,
      createdAt: now
    });

    const restarted = value.restart();
    const recovered = restarted.recover();
    const view = restarted.get(value.principal, created.discussion.discussionId);

    assert.equal(view.waves[0]?.state, "completed");
    assert.equal(view.waves[1]?.state, "open");
    assert.equal(view.waves[1]?.inputMessageId, anchorId);
    assert.equal(recovered.length, 2);
    assert.ok(recovered.every(({ triggerMessageId }) => triggerMessageId === anchorId));
    assert.equal(
      value.core.listMessagesAfter(value.roomId, 0, 100)
        .filter(({ messageId }) => messageId === anchorId).length,
      1
    );
    const stableCounts = {
      waves: view.waves.length,
      decisions: view.decisions.length,
      budgetEvents: value.discussions.listBudgetEvents(
        created.discussion.discussionId
      ).length
    };
    assert.deepEqual(sortedRunIds(restarted.recover()), sortedRunIds(recovered));
    const retried = restarted.get(value.principal, created.discussion.discussionId);
    assert.deepEqual({
      waves: retried.waves.length,
      decisions: retried.decisions.length,
      budgetEvents: value.discussions.listBudgetEvents(
        created.discussion.discussionId
      ).length
    }, stableCounts);
  } finally {
    value.close();
  }
});

test("next Wave context keeps exactly the newest 24 participant-ordered messages", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Bound a long deterministic Discussion transcript.",
      participantAgentIds: value.agentIds,
      policy: {
        initialLeaseTurns: 12,
        automaticMaxTurns: 30,
        hardMaxTurns: 50,
        finalizationReserveTurns: 1,
        plateauWindow: 6,
        allowAutomaticFinish: false
      }
    });
    for (let waveOrdinal = 1; waveOrdinal <= 13; waveOrdinal += 1) {
      assert.equal(result.scheduledRuns.length, 2);
      for (const [memberOrdinal, run] of result.scheduledRuns.entries()) {
        completeRun({
          core: value.core,
          runs: value.runs,
          run,
          content: `Contribution ${waveOrdinal}-${memberOrdinal}.`,
          assessment: { newInformationAdded: true, recommendation: "continue" }
        });
        result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
      }
    }

    assert.equal(result.discussion.currentWave, 14);
    const transcript = recentTranscript(result.scheduledRuns[0]?.instruction ?? "");
    assert.equal(
      transcript.split("\n").filter((line) => line.startsWith("[")).length,
      24
    );
    assert.doesNotMatch(transcript, /Contribution 1-[01]\./u);
    assert.doesNotMatch(transcript, /Contribution 2-0\./u);
    assert.match(transcript, /Contribution 2-1\./u);
    assert.match(transcript, /Contribution 13-1\./u);
    assert.match(transcript, /\[System\] 第 13 轮已收敛。/u);
  } finally {
    value.close();
  }
});

test("startup recovery expires a due planned Wave instead of dispatching it", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Never dispatch a Wave after its durable deadline.",
      participantAgentIds: value.agentIds,
      policy: { waveTimeoutSeconds: 30 }
    });
    for (const turn of created.turns) {
      assert.ok(turn.runId);
      value.database.prepare(`
        UPDATE discussion_turns
        SET run_id = NULL, state = 'planned'
        WHERE turn_id = ?
      `).run(turn.turnId);
      value.database.prepare("DELETE FROM runs WHERE run_id = ?").run(turn.runId);
    }
    value.clock.value = "2026-08-23T10:00:31.000Z";

    const recovered = value.restart().recover();

    assert.deepEqual(recovered, []);
    const view = value.orchestrator.get(
      value.principal,
      created.discussion.discussionId
    );
    assert.equal(view.discussion.state, "waiting_human");
    assert.equal(view.discussion.stateReason, "runtime_failure");
    assert.equal(view.waves[0]?.state, "failed");
    assert.ok(value.runs.listRoomRuns(value.roomId).every(({ state }) =>
      state === "expired"
    ));
  } finally {
    value.close();
  }
});

test("startup recovery does not create a Wave for an already expired no-Wave Discussion", async () => {
  const value = await fixture();
  try {
    const created = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Do not revive an expired aggregate before its first dispatch.",
      participantAgentIds: value.agentIds,
      policy: { maxDurationSeconds: 30, waveTimeoutSeconds: 30 }
    });
    const runIds = created.scheduledRuns.map(({ runId }) => runId);
    value.database.prepare(`
      DELETE FROM discussion_waves WHERE discussion_id = ?
    `).run(created.discussion.discussionId);
    for (const runId of runIds) {
      value.database.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    }
    value.database.prepare(`
      UPDATE discussions
      SET current_turn = 0, current_wave = 0
      WHERE discussion_id = ?
    `).run(created.discussion.discussionId);
    value.clock.value = "2026-08-23T10:00:31.000Z";

    const recovered = value.restart().recover();

    assert.deepEqual(recovered, []);
    const view = value.orchestrator.get(
      value.principal,
      created.discussion.discussionId
    );
    assert.equal(view.discussion.state, "terminated");
    assert.equal(view.discussion.stateReason, "hard_budget_exhausted");
    assert.equal(view.waves.length, 0);
    assert.equal(view.turns.length, 0);
    assert.equal(value.runs.listRoomRuns(value.roomId).length, 0);
  } finally {
    value.close();
  }
});

test("hard budget termination outranks loss of every eligible participant", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Preserve the hard budget reason when finalization has no Runtime.",
      participantAgentIds: value.agentIds,
      policy: {
        initialLeaseTurns: 1,
        automaticMaxTurns: 2,
        hardMaxTurns: 3,
        finalizationReserveTurns: 1,
        plateauWindow: 4,
        allowAutomaticFinish: false
      }
    });
    for (const run of result.scheduledRuns) {
      completeRun({
        core: value.core,
        runs: value.runs,
        run,
        content: `First Wave evidence from ${run.targetAgentId}.`,
        assessment: { newInformationAdded: true, recommendation: "continue" }
      });
      result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
    }
    assert.equal(result.discussion.currentWave, 2);
    const secondWaveRuns = result.scheduledRuns;
    assert.equal(secondWaveRuns.length, 2);
    for (const agentId of value.agentIds) {
      const agent = value.core.getAgent(agentId);
      assert.ok(agent);
      value.core.updateAgentPublication({
        ...agent,
        enabled: false,
        updatedAt: now
      });
    }
    for (const run of secondWaveRuns) {
      completeRun({
        core: value.core,
        runs: value.runs,
        run,
        content: `Final ordinary Wave evidence from ${run.targetAgentId}.`,
        assessment: { newInformationAdded: true, recommendation: "continue" }
      });
      result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
    }

    assert.equal(result.discussion.state, "terminated");
    assert.equal(result.discussion.stateReason, "hard_budget_exhausted");
    assert.equal(result.discussion.budget.turnsUsed, 2);
    assert.equal(result.discussion.budget.agentRunsUsed, 4);
    assert.equal(result.scheduledRuns.length, 0);
    assert.equal(result.waves.length, 2);
  } finally {
    value.close();
  }
});

test("soft-boundary recovery never fabricates a user extension", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Wait for explicit authority after the automatic lease is exhausted.",
      participantAgentIds: value.agentIds,
      policy: {
        initialLeaseTurns: 1,
        automaticMaxTurns: 2,
        hardMaxTurns: 4,
        finalizationReserveTurns: 1,
        plateauWindow: 4,
        allowAutomaticFinish: false
      }
    });
    while (result.discussion.state === "active") {
      const activeRuns = result.scheduledRuns;
      assert.equal(activeRuns.length, 2);
      for (const run of activeRuns) {
        completeRun({
          core: value.core,
          runs: value.runs,
          run,
          content: `Useful lease evidence from ${run.targetAgentId}.`,
          assessment: { newInformationAdded: true, recommendation: "continue" }
        });
        result = requireTerminalResult(value.orchestrator.onRunTerminal(run.runId));
      }
    }
    assert.equal(result.discussion.state, "awaiting_extension");
    assert.equal(result.discussion.budget.turnsUsed, 2);
    assert.equal(result.discussion.budget.extensions, 1);
    const stableCounts = {
      waves: result.waves.length,
      runs: value.runs.listRoomRuns(value.roomId).length,
      budgetEvents: value.discussions.listBudgetEvents(result.discussion.discussionId).length
    };
    value.database.prepare(`
      UPDATE discussions
      SET state = 'active', state_reason = NULL
      WHERE discussion_id = ?
    `).run(result.discussion.discussionId);

    const recovered = value.restart().recover();

    assert.deepEqual(recovered, []);
    const view = value.orchestrator.get(
      value.principal,
      result.discussion.discussionId
    );
    assert.equal(view.discussion.state, "awaiting_extension");
    assert.equal(view.discussion.stateReason, "soft_budget_exhausted");
    assert.equal(view.discussion.budget.extensions, 1);
    assert.deepEqual({
      waves: view.waves.length,
      runs: value.runs.listRoomRuns(value.roomId).length,
      budgetEvents: value.discussions.listBudgetEvents(result.discussion.discussionId).length
    }, stableCounts);
    assert.equal(
      value.discussions.listBudgetEvents(result.discussion.discussionId)
        .filter(({ metadata }) => metadata.source === "user").length,
      0
    );
  } finally {
    value.close();
  }
});
