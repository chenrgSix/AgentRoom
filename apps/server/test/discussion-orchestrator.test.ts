import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { DiscussionOrchestrator } from "../src/discussion/discussion-orchestrator.js";
import { DiscussionRepository } from "../src/discussion/discussion-repository.js";
import { createOpaqueId } from "../src/domain/identifiers.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository, type RunRecord } from "../src/run/run-repository.js";
import { AuthService, type WebPrincipal } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-23T10:00:00.000Z";

async function fixture(): Promise<{
  close(): void;
  core: CoreRepository;
  discussions: DiscussionRepository;
  orchestrator: DiscussionOrchestrator;
  principal: WebPrincipal;
  roomId: string;
  agentIds: string[];
  runs: RunRepository;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-orchestrator-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
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
    close: () => database.close(),
    core,
    discussions,
    orchestrator: new DiscussionOrchestrator(
      core, messages, discussions, runs, auth, () => now
    ),
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

test("central Orchestrator alternates participants and finalizes a plateau", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Choose deterministic cancel semantics.",
      participantAgentIds: value.agentIds,
      mode: "review",
      outputMode: "decision_record"
    });
    assert.equal(result.scheduledRun?.targetAgentId, value.agentIds[0]);

    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const run = result.scheduledRun;
      assert.ok(run);
      completeRun({ core: value.core, runs: value.runs, run, content: "First terminal state wins." });
      result = value.orchestrator.onRunTerminal(run.runId) ?? result;
      if (ordinal < 3) {
        assert.equal(result.scheduledRun?.targetAgentId, value.agentIds[ordinal % 2]);
      }
    }

    assert.equal(result.discussion.state, "finalizing");
    assert.equal(result.discussion.stateReason, "discussion_plateau");
    assert.equal(result.scheduledRun?.targetAgentId, value.agentIds[1]);
    const finalRun = result.scheduledRun;
    assert.ok(finalRun);
    assert.match(finalRun.instruction, /## Goal/);
    assert.match(finalRun.instruction, /## Progress/);
    assert.match(finalRun.instruction, /Produce the final decision record/);
    completeRun({
      core: value.core,
      runs: value.runs,
      run: finalRun,
      content: "Decision: the first persisted terminal state is authoritative."
    });
    result = value.orchestrator.onRunTerminal(finalRun.runId) ?? result;
    assert.equal(result.discussion.state, "completed");
    assert.deepEqual(
      value.discussions.listBudgetEvents(result.discussion.discussionId)
        .map(({ eventType }) => eventType),
      [
        "lease_granted",
        "turn_recorded",
        "turn_recorded",
        "turn_recorded",
        "finalization_reserved"
      ]
    );
  } finally {
    value.close();
  }
});

test("structured Agent evidence can finish a simple Discussion early", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Choose one terminal-state rule.",
      participantAgentIds: value.agentIds
    });
    const run = result.scheduledRun;
    assert.ok(run);
    completeRun({
      core: value.core,
      runs: value.runs,
      run,
      content: "The first persisted terminal state wins.",
      assessment: {
        goalSatisfied: true,
        confidence: 0.96,
        newInformationAdded: true,
        recommendation: "finish"
      }
    });
    result = value.orchestrator.onRunTerminal(run.runId) ?? result;
    assert.equal(result.discussion.state, "finalizing");
    assert.equal(result.discussion.stateReason, "goal_satisfied");
    assert.equal(result.turns.filter(({ kind }) => kind === "discussion").length, 1);
    assert.equal(result.scheduledRun !== null, true);
  } finally {
    value.close();
  }
});

test("soft budget waits for semantic continue and user finish stops after the active turn", async () => {
  const value = await fixture();
  try {
    let result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Review delivery recovery.",
      participantAgentIds: value.agentIds,
      policy: {
        initialLeaseTurns: 1,
        automaticMaxTurns: 2,
        hardMaxTurns: 5,
        finalizationReserveTurns: 1,
        plateauWindow: 4
      }
    });
    let run = result.scheduledRun;
    assert.ok(run);
    completeRun({ core: value.core, runs: value.runs, run, content: "Persist intent before dispatch." });
    result = value.orchestrator.onRunTerminal(run.runId) ?? result;
    assert.equal(result.discussion.budget.leaseEndTurn, 2);
    run = result.scheduledRun;
    assert.ok(run);
    completeRun({ core: value.core, runs: value.runs, run, content: "Reconcile missing Runs by intent." });
    result = value.orchestrator.onRunTerminal(run.runId) ?? result;
    assert.equal(result.discussion.state, "awaiting_extension");
    assert.equal(result.scheduledRun, null);

    result = value.orchestrator.control(value.principal, result.discussion.discussionId, {
      action: "continue",
      extensionTurns: 1
    });
    assert.equal(result.discussion.state, "active");
    run = result.scheduledRun;
    assert.ok(run);
    result = value.orchestrator.control(value.principal, result.discussion.discussionId, {
      action: "finish"
    });
    assert.equal(result.discussion.state, "stop_requested");
    completeRun({ core: value.core, runs: value.runs, run, content: "Recovery converges exactly once." });
    result = value.orchestrator.onRunTerminal(run.runId) ?? result;
    assert.equal(result.discussion.state, "finalizing");
    assert.equal(result.discussion.stateReason, "user_requested_finish");
  } finally {
    value.close();
  }
});

test("recovery recreates one missing Run from a durable planned turn", async () => {
  const value = await fixture();
  try {
    const result = value.orchestrator.create(value.principal, {
      roomId: value.roomId,
      goal: "Test durable intent.",
      participantAgentIds: value.agentIds
    });
    const turn = result.turns[0];
    assert.ok(turn?.runId);
    assert.equal(value.orchestrator.recover().length, 0);
    assert.equal(value.runs.findByTrigger(turn.inputMessageId).length, 1);
  } finally {
    value.close();
  }
});
