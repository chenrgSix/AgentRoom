import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { DiscussionRepository } from "../src/discussion/discussion-repository.js";
import {
  defaultDiscussionPolicy,
  emptyBudgetSnapshot,
  emptyProgressSnapshot,
  type DiscussionBudgetEvent,
  type DiscussionRecord,
  type DiscussionTurn,
  type DiscussionWave
} from "../src/discussion/discussion-types.js";
import { RunRepository, type RunRecord } from "../src/run/run-repository.js";

const now = "2026-08-23T10:00:00.000Z";
const ids = {
  user: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  team: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  member: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  room: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  device: "device_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  agent1: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  agent2: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
  message: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
  discussion: "discussion_01K4Z6J7Y8N9P0Q1R2S3T4V5W6"
};
const taskId = `task_default_${ids.room.slice(5)}`;

function seed(core: CoreRepository): void {
  core.createUser({ userId: ids.user, displayName: "Alice", createdAt: now });
  core.createTeamWithOwner(
    { teamId: ids.team, name: "Core", createdAt: now },
    {
      memberId: ids.member,
      teamId: ids.team,
      userId: ids.user,
      displayName: "Alice",
      role: "owner",
      createdAt: now
    }
  );
  core.createRoom({ roomId: ids.room, teamId: ids.team, name: "general", createdAt: now });
  core.createDevice({
    deviceId: ids.device,
    teamId: ids.team,
    ownerMemberId: ids.member,
    name: "Mac",
    status: "active",
    createdAt: now,
    revokedAt: null
  });
  for (const [agentId, name] of [[ids.agent1, "Coder"], [ids.agent2, "Reviewer"]]) {
    core.createAgent({
      agentId,
      teamId: ids.team,
      ownerMemberId: ids.member,
      deviceId: ids.device,
      name,
      role: name,
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      enabled: true,
      presence: "ready",
      createdAt: now,
      updatedAt: now
    });
  }
  core.appendMessage({
    messageId: ids.message,
    roomId: ids.room,
    senderType: "member",
    senderId: ids.member,
    content: "Design cancellation semantics.",
    mentions: [],
    parentMessageId: null,
    createdAt: now
  });
}

test("Discussion aggregate versions fence duplicate turn scheduling", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-discussion-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    seed(core);
    const repository = new DiscussionRepository(database);
    const budget = emptyBudgetSnapshot(defaultDiscussionPolicy.initialLeaseTurns);
    const discussion: DiscussionRecord = {
      discussionId: ids.discussion,
      roomId: ids.room,
      taskId,
      rootMessageId: ids.message,
      requesterMemberId: ids.member,
      goal: "Design cancellation semantics.",
      mode: "review",
      state: "active",
      stateReason: null,
      outputMode: "final_answer",
      policy: defaultDiscussionPolicy,
      progress: emptyProgressSnapshot(),
      budget,
      currentTurn: 0,
      nextSpeakerIndex: 0,
      requestedAction: null,
      version: 1,
      deadlineAt: "2026-08-23T10:20:00.000Z",
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    };
    const initialBudgetEvent: DiscussionBudgetEvent = {
      budgetEventId: "budget_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      ordinal: 1,
      eventType: "lease_granted",
      turns: defaultDiscussionPolicy.initialLeaseTurns,
      tokens: null,
      durationSeconds: 0,
      estimatedCostMicros: null,
      metadata: { source: "initial" },
      createdAt: now
    };
    repository.create(discussion, [
      { discussionId: ids.discussion, ordinal: 0, agentId: ids.agent1, role: "participant" },
      { discussionId: ids.discussion, ordinal: 1, agentId: ids.agent2, role: "reviewer" }
    ], initialBudgetEvent);

    const turn = {
      turnId: "turn_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      ordinal: 1,
      kind: "discussion" as const,
      speakerAgentId: ids.agent1,
      inputMessageId: ids.message,
      runId: null,
      outputMessageId: null,
      state: "planned" as const,
      assessment: null,
      replyHash: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    repository.appendTurn(turn, 1);
    assert.equal(repository.get(ids.discussion)?.version, 2);
    assert.deepEqual(repository.listParticipants(ids.discussion).map(({ agentId }) => agentId), [
      ids.agent1,
      ids.agent2
    ]);
    assert.equal(repository.listTurns(ids.discussion).length, 1);
    await assert.rejects(
      async () => repository.appendTurn({
        ...turn,
        turnId: "turn_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        ordinal: 2
      }, 1),
      /Stale Discussion aggregate version/
    );
    assert.equal(repository.listTurns(ids.discussion).length, 1);
    assert.equal(repository.listBudgetEvents(ids.discussion)[0]?.tokens, null);
  } finally {
    database.close();
  }
});

test("Discussion decisions are atomic with aggregate updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-decision-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    seed(core);
    const repository = new DiscussionRepository(database);
    const discussion: DiscussionRecord = {
      discussionId: ids.discussion,
      roomId: ids.room,
      taskId,
      rootMessageId: ids.message,
      requesterMemberId: ids.member,
      goal: "Design cancellation semantics.",
      mode: "round_robin",
      state: "active",
      stateReason: null,
      outputMode: "summary",
      policy: defaultDiscussionPolicy,
      progress: emptyProgressSnapshot(),
      budget: emptyBudgetSnapshot(4),
      currentTurn: 0,
      nextSpeakerIndex: 0,
      requestedAction: null,
      version: 1,
      deadlineAt: "2026-08-23T10:20:00.000Z",
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    };
    repository.create(discussion, [
      { discussionId: ids.discussion, ordinal: 0, agentId: ids.agent1, role: "participant" },
      { discussionId: ids.discussion, ordinal: 1, agentId: ids.agent2, role: "participant" }
    ], {
      budgetEventId: "budget_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      ordinal: 1,
      eventType: "lease_granted",
      turns: 4,
      tokens: null,
      durationSeconds: 0,
      estimatedCostMicros: null,
      metadata: {},
      createdAt: now
    });
    const decision = {
      decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      aggregateVersion: 1,
      progressVersion: 0,
      action: "continue" as const,
      reason: "discussion_active",
      nextAgentId: ids.agent1,
      outputMode: "none" as const,
      createdAt: now
    };
    const updated = repository.recordDecisionAndUpdate({
      decision,
      expectedVersion: 1,
      state: "active",
      stateReason: null,
      outputMode: "summary",
      progress: discussion.progress,
      budget: discussion.budget,
      nextSpeakerIndex: 1,
      requestedAction: null,
      terminalAt: null
    });
    assert.equal(updated.version, 2);
    assert.equal(repository.listDecisions(ids.discussion).length, 1);

    assert.throws(() => repository.recordDecisionAndUpdate({
      decision: {
        ...decision,
        decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        aggregateVersion: 2
      },
      expectedVersion: 1,
      state: "paused",
      stateReason: "user_paused",
      outputMode: "summary",
      progress: discussion.progress,
      budget: discussion.budget,
      nextSpeakerIndex: 1,
      requestedAction: null,
      terminalAt: null
    }), /Stale Discussion aggregate version/);
    assert.equal(repository.listDecisions(ids.discussion).length, 1);
  } finally {
    database.close();
  }
});

test("parallel Wave planning, settlement, and Barrier advancement are atomic", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-wave-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    seed(core);
    const repository = new DiscussionRepository(database);
    const budget = emptyBudgetSnapshot(defaultDiscussionPolicy.initialLeaseTurns);
    const discussion: DiscussionRecord = {
      discussionId: ids.discussion,
      roomId: ids.room,
      taskId,
      rootMessageId: ids.message,
      requesterMemberId: ids.member,
      goal: "Plan one parallel contribution Wave.",
      mode: "round_robin",
      state: "active",
      stateReason: null,
      outputMode: "final_answer",
      policy: defaultDiscussionPolicy,
      progress: emptyProgressSnapshot(),
      budget,
      executionModel: "parallel_wave",
      currentTurn: 0,
      currentWave: 0,
      nextSpeakerIndex: 0,
      requestedAction: null,
      version: 1,
      deadlineAt: "2026-08-23T10:20:00.000Z",
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    };
    repository.create(discussion, [
      { discussionId: ids.discussion, ordinal: 0, agentId: ids.agent1, role: "participant" },
      { discussionId: ids.discussion, ordinal: 1, agentId: ids.agent2, role: "participant" }
    ], {
      budgetEventId: "budget_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      ordinal: 1,
      eventType: "lease_granted",
      turns: 4,
      tokens: null,
      durationSeconds: 0,
      estimatedCostMicros: null,
      metadata: {},
      createdAt: now
    });

    const wave: DiscussionWave = {
      waveId: "wave_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      ordinal: 1,
      phase: "contribution",
      inputMessageId: ids.message,
      state: "open",
      deadlineAt: "2026-08-23T10:05:00.000Z",
      expectedMembers: 2,
      version: 1,
      createdAt: now,
      updatedAt: now,
      closedAt: null
    };
    const turns: DiscussionTurn[] = [ids.agent1, ids.agent2].map(
      (speakerAgentId, index) => ({
        turnId: `turn_01K4Z6J7Y8N9P0Q1R2S3T4V5W${6 + index}`,
        discussionId: ids.discussion,
        ordinal: index + 1,
        kind: "discussion",
        speakerAgentId,
        inputMessageId: ids.message,
        runId: null,
        outputMessageId: null,
        state: "planned",
        assessment: null,
        replyHash: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        waveId: wave.waveId,
        waveMemberOrdinal: index,
        terminalReason: null
      })
    );
    const firstDecision = {
      decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      discussionId: ids.discussion,
      aggregateVersion: 1,
      progressVersion: 0,
      action: "continue" as const,
      reason: "discussion_active",
      nextAgentId: null,
      outputMode: "none" as const,
      createdAt: now
    };
    const planned = repository.recordDecisionAndPlanWave({
      decision: firstDecision,
      wave,
      turns,
      expectedVersion: 1,
      state: "active",
      stateReason: null,
      outputMode: "final_answer",
      progress: discussion.progress,
      budget,
      nextSpeakerIndex: 0,
      requestedAction: null
    });
    assert.equal(planned.version, 2);
    assert.equal(planned.currentWave, 1);
    assert.equal(planned.currentTurn, 2);
    assert.equal(repository.listWaves(ids.discussion).length, 1);
    assert.deepEqual(
      repository.listTurnsForWave(wave.waveId).map(({ waveMemberOrdinal }) =>
        waveMemberOrdinal
      ),
      [0, 1]
    );
    const recoveryAnchorId = "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W7";
    core.appendMessage({
      messageId: recoveryAnchorId,
      roomId: ids.room,
      senderType: "system",
      senderId: ids.discussion,
      content: "Recovery anchor for the complete Wave.",
      mentions: [],
      parentMessageId: ids.message,
      createdAt: now
    });
    const reanchored = repository.reanchorPlannedWave(
      wave.waveId,
      recoveryAnchorId,
      now
    );
    assert.equal(reanchored.inputMessageId, recoveryAnchorId);
    assert.equal(reanchored.version, 2);
    assert.deepEqual(
      repository.listTurnsForWave(wave.waveId).map(({ inputMessageId }) =>
        inputMessageId
      ),
      [recoveryAnchorId, recoveryAnchorId]
    );

    assert.throws(() => repository.recordDecisionAndPlanWave({
      decision: {
        ...firstDecision,
        decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        aggregateVersion: 2
      },
      wave: {
        ...wave,
        waveId: "wave_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        ordinal: 2
      },
      turns: turns.map((turn, index) => ({
        ...turn,
        turnId: `turn_01K4Z6J7Y8N9P0Q1R2S3T4V6W${6 + index}`,
        ordinal: index + 3,
        waveId: "wave_01K4Z6J7Y8N9P0Q1R2S3T4V5W7"
      })),
      expectedVersion: 1,
      state: "active",
      stateReason: null,
      outputMode: "final_answer",
      progress: discussion.progress,
      budget,
      nextSpeakerIndex: 0,
      requestedAction: null
    }), /Stale Discussion aggregate version/u);
    assert.equal(repository.listDecisions(ids.discussion).length, 1);

    assert.throws(() => repository.recordDecisionAndPlanWave({
      decision: {
        ...firstDecision,
        decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        aggregateVersion: 2
      },
      wave: {
        ...wave,
        waveId: "wave_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        ordinal: 2
      },
      turns: turns.map((turn, index) => ({
        ...turn,
        turnId: `turn_01K4Z6J7Y8N9P0Q1R2S3T4V6W${6 + index}`,
        ordinal: index + 3,
        inputMessageId: ids.message,
        waveId: "wave_01K4Z6J7Y8N9P0Q1R2S3T4V5W7"
      })),
      expectedVersion: 2,
      state: "active",
      stateReason: null,
      outputMode: "final_answer",
      progress: discussion.progress,
      budget,
      nextSpeakerIndex: 0,
      requestedAction: null
    }), /UNIQUE constraint failed: discussion_waves\.discussion_id/u);
    assert.equal(repository.get(ids.discussion)?.version, 2);
    assert.equal(repository.listDecisions(ids.discussion).length, 1);
    assert.equal(repository.listWaves(ids.discussion).length, 1);
    assert.equal(repository.listTurns(ids.discussion).length, 2);

    const notReady = repository.closeWave({
      waveId: wave.waveId,
      expectedVersion: 2,
      state: "completed",
      now
    });
    assert.equal(notReady.applied, false);
    const firstSettlement = repository.settleTurn({
      turnId: turns[0]!.turnId,
      outputMessageId: null,
      state: "completed",
      assessment: null,
      replyHash: null,
      now
    });
    assert.equal(firstSettlement.applied, true);
    const duplicateSettlement = repository.settleTurn({
      turnId: turns[0]!.turnId,
      outputMessageId: null,
      state: "failed",
      assessment: null,
      replyHash: null,
      terminalReason: "late_duplicate",
      now
    });
    assert.equal(duplicateSettlement.applied, false);
    assert.equal(duplicateSettlement.turn.state, "completed");
    repository.settleTurn({
      turnId: turns[1]!.turnId,
      outputMessageId: null,
      state: "completed",
      assessment: null,
      replyHash: null,
      now
    });

    const nextWave: DiscussionWave = {
      ...wave,
      waveId: "wave_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
      ordinal: 2
    };
    const nextTurns = turns.map((turn, index) => ({
      ...turn,
      turnId: `turn_01K4Z6J7Y8N9P0Q1R2S3T4V6W${6 + index}`,
      ordinal: index + 3,
      waveId: nextWave.waveId
    }));
    const nextBudget = { ...budget, turnsUsed: 1, agentRunsUsed: 2 };
    const applyInput = {
      waveId: wave.waveId,
      expectedWaveVersion: 2,
      closeState: "completed" as const,
      closedAt: now,
      decision: {
        ...firstDecision,
        decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        aggregateVersion: 2,
        progressVersion: 1
      },
      expectedDiscussionVersion: 2,
      state: "active" as const,
      stateReason: null,
      outputMode: "final_answer" as const,
      progress: { ...discussion.progress, version: 1 },
      budget: nextBudget,
      nextSpeakerIndex: 0,
      requestedAction: null,
      terminalAt: null,
      budgetEvents: [{
        budgetEventId: "budget_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
        discussionId: ids.discussion,
        ordinal: 2,
        eventType: "turn_recorded" as const,
        turns: 1,
        tokens: null,
        durationSeconds: 0,
        estimatedCostMicros: null,
        metadata: { waveId: wave.waveId, agentRuns: 2 },
        createdAt: now
      }],
      nextWave: { wave: nextWave, turns: nextTurns }
    };
    const advanced = repository.closeReadyWaveAndApply(applyInput);
    assert.equal(advanced.applied, true);
    assert.equal(advanced.discussion.version, 3);
    assert.equal(advanced.discussion.currentWave, 2);
    assert.equal(repository.getWave(wave.waveId)?.state, "completed");
    assert.equal(repository.getWave(nextWave.waveId)?.state, "open");
    assert.equal(repository.listTurnsForWave(nextWave.waveId).length, 2);
    assert.equal(repository.listBudgetEvents(ids.discussion).length, 2);

    const duplicateAdvance = repository.closeReadyWaveAndApply(applyInput);
    assert.equal(duplicateAdvance.applied, false);
    assert.equal(repository.listDecisions(ids.discussion).length, 2);
    assert.equal(repository.listWaves(ids.discussion).length, 2);

    for (const turn of nextTurns) {
      repository.settleTurn({
        turnId: turn.turnId,
        outputMessageId: null,
        state: "failed",
        assessment: null,
        replyHash: null,
        terminalReason: "runtime_failure",
        now
      });
    }
    const waiting = repository.recordDecisionAndUpdate({
      decision: {
        ...firstDecision,
        decisionId: "decision_01K4Z6J7Y8N9P0Q1R2S3T4V5W8",
        aggregateVersion: 3,
        progressVersion: 2,
        action: "wait_human",
        reason: "runtime_failure"
      },
      expectedVersion: 3,
      state: "waiting_human",
      stateReason: "runtime_failure",
      outputMode: "final_answer",
      progress: { ...discussion.progress, version: 2 },
      budget: nextBudget,
      nextSpeakerIndex: 0,
      requestedAction: null,
      terminalAt: null,
      closingWave: {
        waveId: nextWave.waveId,
        state: "failed",
        completedAt: now,
        expectedVersion: 1
      }
    });
    assert.equal(waiting.state, "waiting_human");
    assert.equal(repository.getWave(nextWave.waveId)?.state, "failed");
    assert.equal(repository.listDecisions(ids.discussion).length, 3);
  } finally {
    database.close();
  }
});

test("Run orchestration keys provide a unique durable lookup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-run-key-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    seed(core);
    const repository = new RunRepository(database);
    const traceId = core.getMessage(ids.message)?.traceId;
    assert.ok(traceId);
    const run: RunRecord = {
      runId: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      traceId,
      roomId: ids.room,
      taskId,
      triggerMessageId: ids.message,
      requesterMemberId: ids.member,
      targetAgentId: ids.agent1,
      parentRunId: null,
      instruction: "Contribute to Wave 1.",
      state: "queued",
      lastSequence: 0,
      deadlineAt: "2026-08-23T10:05:00.000Z",
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      orchestrationKey: "turn_01K4Z6J7Y8N9P0Q1R2S3T4V5W6"
    };
    repository.createRuns([run]);
    assert.equal(
      repository.findByOrchestrationKey(run.orchestrationKey!)?.runId,
      run.runId
    );
    assert.throws(() => repository.createRuns([{
      ...run,
      runId: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
      targetAgentId: ids.agent2
    }]), /UNIQUE constraint failed: runs\.orchestration_key/u);
    assert.equal(repository.listRoomRuns(ids.room).length, 1);
  } finally {
    database.close();
  }
});
