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
  type DiscussionRecord
} from "../src/discussion/discussion-types.js";
import { RunRepository } from "../src/run/run-repository.js";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-discussion-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-decision-"));
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
