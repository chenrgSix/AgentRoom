import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createTestResources } from "../../../scripts/test/resources.mjs";

import { createServerApp } from "../src/app.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberMessageRunService } from
  "../src/run/member-message-run-service.js";
import { ManualRunService } from "../src/run/manual-run-service.js";
import { RunProjectionReconciler } from
  "../src/run/run-projection-reconciler.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-29T10:00:00.000Z";

async function createFixture(t: TestContext) {
  const resources = await createTestResources(t, "convene-wire-consistency-");
  const directory = resources.directory;
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  resources.defer(() => { if (database.open) database.close(); });
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const messages = new MessageService(core, auth);
  const runRepository = new RunRepository(database);
  const runs = new RunService(
    core,
    runRepository,
    auth,
    new AgentTaskRepository(database)
  );
  const memberMessageRuns = new MemberMessageRunService(
    transactions,
    messages,
    runs
  );
  const created = teams.createTeamForUser({
    userId: "user_01K4Z6J7Y8N9P0Q1R2S3C0NSIS",
    userDisplayName: "Alice",
    teamName: "Consistency Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-29T11:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const agent = new AgentService(core, auth).publishAgent(principal, {
    teamId: created.team.teamId,
    deviceId: null,
    name: "Manual Builder",
    role: "Builder",
    integrationMode: "manual",
    capabilities: {
      supportsHandoff: true,
      supportsInterrupt: false,
      supportsResume: false,
      supportsStart: false,
      supportsStreaming: false
    },
    now
  });
  return {
    agent,
    auth,
    core,
    database,
    databasePath,
    memberMessageRuns,
    messages,
    principal,
    room,
    runRepository,
    runs,
    transactions
  };
}

test("member Message and mentioned Runs commit atomically and repair an old retry", async (t) => {
  const fixture = await createFixture(t);
  try {
    const input = {
      roomId: fixture.room.roomId,
      content: "Route this atomically",
      clientMessageId: "client_consistency_atomic_0001",
      mentions: [{
        targetType: "agent" as const,
        targetAgentId: fixture.agent.agentId,
        displayLabel: "Manual Builder / Builder"
      }],
      now
    };
    fixture.database.exec(`
      CREATE TEMP TRIGGER fail_mentioned_run_insert
      BEFORE INSERT ON runs
      BEGIN
        SELECT RAISE(ABORT, 'injected Run insert failure');
      END;
    `);
    assert.throws(
      () => fixture.memberMessageRuns.create(fixture.principal, input),
      /injected Run insert failure/u
    );
    assert.equal(
      fixture.core.listMessagesAfter(fixture.room.roomId, 0, 10).length,
      0
    );
    assert.equal(fixture.core.latestMessageSequence(fixture.room.roomId), 0);
    fixture.database.exec("DROP TRIGGER fail_mentioned_run_insert");

    const created = fixture.memberMessageRuns.create(fixture.principal, input);
    assert.equal(created.messageCreated, true);
    assert.equal(created.runsCreated, true);
    assert.equal(created.runs.length, 1);
    const replay = fixture.memberMessageRuns.create(fixture.principal, {
      ...input,
      content: "A replay cannot change the committed Message"
    });
    assert.equal(replay.messageCreated, false);
    assert.equal(replay.runsCreated, false);
    assert.equal(replay.message.messageId, created.message.messageId);
    assert.deepEqual(replay.runs, created.runs);

    const legacyInput = {
      ...input,
      content: "Repair a pre-atomic Message",
      clientMessageId: "client_consistency_repair_0002"
    };
    const legacyMessage = fixture.messages.createMemberMessage(
      fixture.principal,
      legacyInput
    );
    assert.deepEqual(fixture.runRepository.findByTrigger(legacyMessage.messageId), []);
    const repaired = fixture.memberMessageRuns.create(fixture.principal, legacyInput);
    assert.equal(repaired.messageCreated, false);
    assert.equal(repaired.runsCreated, true);
    assert.equal(repaired.runs.length, 1);
    assert.equal(repaired.runs[0]?.triggerMessageId, legacyMessage.messageId);
  } finally {
    fixture.database.close();
  }
});

test("manual completion rolls claim, reply Message, and terminal status back together", async (t) => {
  const fixture = await createFixture(t);
  try {
    const routed = fixture.memberMessageRuns.create(fixture.principal, {
      roomId: fixture.room.roomId,
      content: "Complete this manually",
      mentions: [{
        targetType: "agent",
        targetAgentId: fixture.agent.agentId,
        displayLabel: "Manual Builder / Builder"
      }],
      now
    });
    const run = routed.runs[0];
    assert.ok(run);
    const credential = fixture.auth.issueMcpCredential(
      fixture.principal,
      fixture.agent.agentId,
      now,
      "2026-08-29T11:00:00.000Z"
    );
    const mcpPrincipal = fixture.auth.authenticateMcp(credential.secret, now);
    const manualRuns = new ManualRunService(
      fixture.core,
      fixture.runRepository,
      fixture.transactions
    );
    fixture.database.exec(`
      CREATE TEMP TRIGGER fail_manual_completed_status
      BEFORE UPDATE OF state ON runs
      WHEN NEW.state = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'injected completed status failure');
      END;
    `);
    assert.throws(
      () => manualRuns.complete(
        mcpPrincipal,
        run.runId,
        "Completed exactly once.",
        now
      ),
      /injected completed status failure/u
    );
    assert.equal(fixture.runRepository.getRun(run.runId)?.state, "queued");
    assert.deepEqual(fixture.runRepository.listEvents(run.runId), []);
    assert.equal(
      fixture.core.listMessagesAfter(fixture.room.roomId, 0, 10).length,
      1
    );
    fixture.database.exec("DROP TRIGGER fail_manual_completed_status");

    const completed = manualRuns.complete(
      mcpPrincipal,
      run.runId,
      "Completed exactly once.",
      now
    );
    assert.equal(completed.state, "completed");
    assert.deepEqual(
      fixture.runRepository.listEvents(run.runId).map(({ event }) => event.type),
      ["status", "reply", "status"]
    );
    assert.equal(
      fixture.core.listMessagesAfter(fixture.room.roomId, 0, 10).length,
      2
    );
    assert.equal(
      manualRuns.complete(mcpPrincipal, run.runId, "Ignored replay", now).state,
      "completed"
    );
    assert.equal(
      fixture.core.listMessagesAfter(fixture.room.roomId, 0, 10).length,
      2
    );
  } finally {
    fixture.database.close();
  }
});

test("startup restores orphaned mentioned Messages with original deadlines exactly once", async (t) => {
  const fixture = await createFixture(t);
  const staleCreatedAt = now;
  const freshCreatedAt = "2026-08-29T10:20:00.000Z";
  const recoveryTime = "2026-08-29T10:30:00.000Z";
  const mention = {
    targetType: "agent" as const,
    targetAgentId: fixture.agent.agentId,
    displayLabel: "Manual Builder / Builder"
  };
  const stale = fixture.messages.createMemberMessage(fixture.principal, {
    roomId: fixture.room.roomId,
    content: "Do not execute this stale projection",
    mentions: [mention],
    now: staleCreatedAt
  });
  const fresh = fixture.messages.createMemberMessage(fixture.principal, {
    roomId: fixture.room.roomId,
    content: "Recover this fresh projection",
    mentions: [mention],
    now: freshCreatedAt
  });
  fixture.database.close();

  const reopened = openDatabase(fixture.databasePath);
  try {
    const transactions = new SqliteTransactionBoundary(reopened);
    const core = new CoreRepository(reopened, transactions);
    const runRepository = new RunRepository(reopened);
    const reconciler = new RunProjectionReconciler(
      reopened,
      transactions,
      core,
      new AgentTaskRepository(reopened),
      runRepository
    );
    reopened.exec(`
      CREATE TEMP TRIGGER fail_recovered_run_insert
      BEFORE INSERT ON runs
      BEGIN
        SELECT RAISE(ABORT, 'injected recovered Run failure');
      END;
    `);
    assert.throws(
      () => reconciler.reconcile(recoveryTime),
      /injected recovered Run failure/u
    );
    assert.deepEqual(runRepository.findByTrigger(stale.messageId), []);
    assert.deepEqual(runRepository.findByTrigger(fresh.messageId), []);
    reopened.exec("DROP TRIGGER fail_recovered_run_insert");

    const recovered = reconciler.reconcile(recoveryTime);
    assert.equal(recovered.expiredRuns.length, 1);
    assert.equal(recovered.queuedRuns.length, 1);
    assert.deepEqual(recovered.memberMessageFailures, []);
    const expiredRun = runRepository.findByTrigger(stale.messageId)[0];
    const queuedRun = runRepository.findByTrigger(fresh.messageId)[0];
    assert.ok(expiredRun);
    assert.ok(queuedRun);
    assert.equal(expiredRun.createdAt, staleCreatedAt);
    assert.equal(expiredRun.deadlineAt, "2026-08-29T10:20:00.000Z");
    assert.equal(expiredRun.state, "expired");
    assert.equal(expiredRun.terminalAt, expiredRun.deadlineAt);
    assert.deepEqual(
      runRepository.listEvents(expiredRun.runId).map(({ event }) => event),
      [{
        type: "status",
        sequence: 1,
        status: "expired",
        error: {
          code: "RUN_EXPIRED",
          message: "Run expired before startup could restore its missing projection.",
          retryable: false
        }
      }]
    );
    assert.equal(queuedRun.createdAt, freshCreatedAt);
    assert.equal(queuedRun.deadlineAt, "2026-08-29T10:40:00.000Z");
    assert.equal(queuedRun.state, "queued");

    const replay = reconciler.reconcile(recoveryTime);
    assert.deepEqual(replay.queuedRuns, []);
    assert.deepEqual(replay.expiredRuns, []);
    assert.equal(runRepository.listRoomRuns(fixture.room.roomId).length, 2);
  } finally {
    reopened.close();
  }
});

test("startup leaves a fresh orphan Message unrouted while its Task is not runnable", async (t) => {
  const fixture = await createFixture(t);
  const message = fixture.messages.createMemberMessage(fixture.principal, {
    roomId: fixture.room.roomId,
    content: "Wait until the Task is runnable again",
    mentions: [{
      targetType: "agent",
      targetAgentId: fixture.agent.agentId,
      displayLabel: "Manual Builder / Builder"
    }],
    now: "2026-08-29T10:20:00.000Z"
  });
  fixture.database.prepare(`
    UPDATE agent_tasks
    SET budget_run_attempts = max_run_attempts
    WHERE task_id = ?
  `).run(message.taskId);
  fixture.database.close();

  const reopened = openDatabase(fixture.databasePath);
  try {
    const transactions = new SqliteTransactionBoundary(reopened);
    const runRepository = new RunRepository(reopened);
    const reconciler = new RunProjectionReconciler(
      reopened,
      transactions,
      new CoreRepository(reopened, transactions),
      new AgentTaskRepository(reopened),
      runRepository
    );
    const failedClosed = reconciler.reconcile("2026-08-29T10:30:00.000Z");
    assert.deepEqual(failedClosed.memberMessageFailures, [{
      messageId: message.messageId,
      errorCode: "TASK_NOT_RUNNABLE"
    }]);
    assert.deepEqual(runRepository.findByTrigger(message.messageId), []);

    reopened.prepare(`
      UPDATE agent_tasks SET budget_run_attempts = 0 WHERE task_id = ?
    `).run(message.taskId);
    const recovered = reconciler.reconcile("2026-08-29T10:30:00.000Z");
    assert.equal(recovered.queuedRuns.length, 1);
    assert.equal(
      runRepository.findByTrigger(message.messageId)[0]?.deadlineAt,
      "2026-08-29T10:40:00.000Z"
    );
  } finally {
    reopened.close();
  }
});

test("Server startup runs the durable Member Message projection recovery", async (t) => {
  const fixture = await createFixture(t);
  const message = fixture.messages.createMemberMessage(fixture.principal, {
    roomId: fixture.room.roomId,
    content: "Recover this during Server startup",
    mentions: [{
      targetType: "agent",
      targetAgentId: fixture.agent.agentId,
      displayLabel: "Manual Builder / Builder"
    }],
    now: "2026-08-29T10:20:00.000Z"
  });
  fixture.database.close();

  const app = await createServerApp({
    databasePath: fixture.databasePath,
    clock: () => "2026-08-29T10:30:00.000Z"
  });
  await app.close();

  const reopened = openDatabase(fixture.databasePath);
  try {
    const recovered = new RunRepository(reopened).findByTrigger(
      message.messageId
    );
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.state, "queued");
    assert.equal(recovered[0]?.createdAt, message.createdAt);
    assert.equal(recovered[0]?.deadlineAt, "2026-08-29T10:40:00.000Z");
  } finally {
    reopened.close();
  }
});

test("startup reconciles legacy reply Messages by exact durable identity", async (t) => {
  const fixture = await createFixture(t);
  const eventCreatedAt = "2026-08-29T10:05:00.000Z";
  const recoveryTime = "2026-08-29T10:06:00.000Z";
  const cases = [
    { key: "exact", content: "Map the exact historical Message." },
    { key: "missing", content: "Create the missing historical Message." },
    { key: "ambiguous", content: "Do not choose between duplicates." },
    { key: "timestamp", content: "Do not guess a different timestamp." }
  ] as const;
  const records = cases.map((entry, index) => {
    const routed = fixture.memberMessageRuns.create(fixture.principal, {
      roomId: fixture.room.roomId,
      content: `Trigger legacy reply ${index + 1}`,
      clientMessageId: `client_legacy_reply_case_${index + 1}_0001`,
      mentions: [{
        targetType: "agent",
        targetAgentId: fixture.agent.agentId,
        displayLabel: "Manual Builder / Builder"
      }],
      now
    });
    assert.ok(routed.runs[0]);
    return { ...entry, run: routed.runs[0]!, trigger: routed.message };
  });
  const insertEvent = fixture.database.prepare(`
    INSERT INTO run_events (
      run_id, trace_id, sequence, event_type, status, content, output_reset,
      error_json, assessment_json, activity_json, session_json,
      clarification_json, created_at
    ) VALUES (?, ?, 1, 'reply', NULL, ?, 0, NULL, NULL, NULL, NULL, NULL, ?)
  `);
  const insertIntent = fixture.database.prepare(`
    INSERT INTO run_reply_routing_intents (
      parent_run_id, reply_sequence, content, state, created_at
    ) VALUES (?, 1, ?, 'pending', ?)
  `);
  for (const entry of records) {
    insertEvent.run(
      entry.run.runId,
      entry.run.traceId,
      entry.content,
      eventCreatedAt
    );
    insertIntent.run(entry.run.runId, entry.content, eventCreatedAt);
    fixture.database.prepare(`
      UPDATE runs SET last_sequence = 1, updated_at = ? WHERE run_id = ?
    `).run(eventCreatedAt, entry.run.runId);
  }
  const appendLegacyReply = (
    messageId: string,
    entry: (typeof records)[number],
    createdAt: string
  ) => fixture.core.appendMessage({
    messageId,
    traceId: entry.run.traceId,
    roomId: entry.run.roomId,
    taskId: entry.run.taskId,
    senderType: "agent",
    senderId: entry.run.targetAgentId,
    content: entry.content,
    mentions: [],
    parentMessageId: entry.trigger.messageId,
    createdAt
  });
  const exact = records.find(({ key }) => key === "exact")!;
  const ambiguous = records.find(({ key }) => key === "ambiguous")!;
  const timestamp = records.find(({ key }) => key === "timestamp")!;
  const exactMessage = appendLegacyReply(
    "msg_legacy_reply_exact_0001",
    exact,
    eventCreatedAt
  );
  appendLegacyReply(
    "msg_legacy_reply_ambiguous_0001",
    ambiguous,
    eventCreatedAt
  );
  appendLegacyReply(
    "msg_legacy_reply_ambiguous_0002",
    ambiguous,
    eventCreatedAt
  );
  appendLegacyReply(
    "msg_legacy_reply_timestamp_0001",
    timestamp,
    "2026-08-29T10:05:01.000Z"
  );
  const messageCountBefore = fixture.core.listMessagesAfter(
    fixture.room.roomId,
    0,
    100
  ).length;
  fixture.database.close();

  const reopened = openDatabase(fixture.databasePath);
  try {
    const transactions = new SqliteTransactionBoundary(reopened);
    const core = new CoreRepository(reopened, transactions);
    const runRepository = new RunRepository(reopened);
    const reconciler = new RunProjectionReconciler(
      reopened,
      transactions,
      core,
      new AgentTaskRepository(reopened),
      runRepository
    );
    const missing = records.find(({ key }) => key === "missing")!;
    reopened.exec(`
      CREATE TEMP TRIGGER fail_reconciled_reply_mapping
      BEFORE INSERT ON run_reply_message_projections
      WHEN NEW.run_id = '${missing.run.runId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected reconciled reply mapping failure');
      END;
    `);
    assert.throws(
      () => runRepository.reconcileReplyMessageProjection(
        missing.run.runId,
        1,
        recoveryTime
      ),
      /injected reconciled reply mapping failure/u
    );
    assert.equal(
      core.listMessagesAfter(fixture.room.roomId, 0, 100).length,
      messageCountBefore
    );
    assert.equal(
      runRepository.getReplyMessageProjection(missing.run.runId, 1),
      undefined
    );
    reopened.exec("DROP TRIGGER fail_reconciled_reply_mapping");
    const reconciled = reconciler.reconcile(recoveryTime);
    assert.equal(reconciled.replyProjections.length, 2);
    assert.equal(reconciled.replyProjectionFailures.length, 2);
    assert.equal(
      runRepository.getReplyMessageProjection(exact.run.runId, 1)?.messageId,
      exactMessage.messageId
    );
    const createdProjection = runRepository.getReplyMessageProjection(
      missing.run.runId,
      1
    );
    assert.ok(createdProjection);
    const createdMessage = core.getMessage(createdProjection.messageId);
    assert.equal(createdMessage?.createdAt, eventCreatedAt);
    assert.equal(createdMessage?.content, missing.content);
    assert.equal(createdMessage?.parentMessageId, missing.trigger.messageId);
    assert.equal(
      core.listMessagesAfter(fixture.room.roomId, 0, 100).length,
      messageCountBefore + 1
    );
    assert.deepEqual(
      runRepository.getReplyProjectionFailure(ambiguous.run.runId, 1),
      {
        runId: ambiguous.run.runId,
        replySequence: 1,
        errorCode: "MULTIPLE_EXACT_MESSAGES",
        candidateCount: 2,
        recordedAt: recoveryTime
      }
    );
    assert.deepEqual(
      runRepository.getReplyProjectionFailure(timestamp.run.runId, 1),
      {
        runId: timestamp.run.runId,
        replySequence: 1,
        errorCode: "TIMESTAMP_MISMATCH",
        candidateCount: 1,
        recordedAt: recoveryTime
      }
    );
    assert.equal(
      runRepository.getReplyMessageProjection(ambiguous.run.runId, 1),
      undefined
    );
    assert.equal(
      runRepository.getReplyMessageProjection(timestamp.run.runId, 1),
      undefined
    );

    const replay = reconciler.reconcile(recoveryTime);
    assert.deepEqual(replay.replyProjections, []);
    assert.deepEqual(replay.replyProjectionFailures, []);
    assert.equal(
      core.listMessagesAfter(fixture.room.roomId, 0, 100).length,
      messageCountBefore + 1
    );
  } finally {
    reopened.close();
  }
});
