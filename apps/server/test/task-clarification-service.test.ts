import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeConnectionRegistry } from "../src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { SqliteTransactionBoundary } from "../src/data/sqlite-transaction-boundary.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { BridgeRunEventService } from "../src/run/bridge-run-event-service.js";
import { CancellationService } from "../src/run/cancellation-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ClarificationRepository } from "../src/task/clarification-repository.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { TaskClarificationService } from "../src/task/task-clarification-service.js";

const now = "2026-08-25T10:00:00.000Z";

test("Task clarification resumes the same Task session in a new bounded Run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-clarification-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const registry = new MemberDeviceService(core, auth);
    const agents = new AgentService(core, auth);
    const messages = new MessageService(core, auth);
    const runRepository = new RunRepository(database);
    const taskRepository = new AgentTaskRepository(database);
    const runs = new RunService(core, runRepository, auth, taskRepository);
    const clarificationRepository = new ClarificationRepository(database);
    const clarifications = new TaskClarificationService(
      new SqliteTransactionBoundary(database),
      clarificationRepository,
      taskRepository,
      core,
      runRepository,
      runs,
      messages,
      auth
    );
    const created = teams.createTeamForUser({
      userId: "user_clarification_owner",
      userDisplayName: "Alice",
      teamName: "Core Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-25T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(
      principal,
      created.team.teamId,
      "Mac",
      now
    );
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Managed",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const trigger = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Prepare the deployment",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const run = runs.createRunsForMessage(principal, trigger.messageId, now)[0];
    assert.ok(run);
    runRepository.applyEvent(run.runId, {
      type: "status",
      sequence: 1,
      status: "delivered"
    }, now);
    const devicePrincipal = auth.authenticateDevice(
      auth.issueDeviceCredential(device.deviceId, now).secret,
      now
    );
    const bridgeEvents = new BridgeRunEventService(core, runRepository);
    bridgeEvents.applyStatus(devicePrincipal, {
      runId: run.runId,
      traceId: run.traceId,
      agentId: agent.agentId,
      sequence: 2,
      status: "working"
    }, now);
    const waiting = bridgeEvents.applyStatus(devicePrincipal, {
      runId: run.runId,
      traceId: run.traceId,
      agentId: agent.agentId,
      sequence: 3,
      status: "input_required",
      clarification: {
        kind: "task",
        question: "Which region should be used? token=private-region",
        choices: ["eu-west-1", "eu-central-1"]
      },
      session: {
        disposition: "started",
        contextCursor: trigger.sequence
      }
    }, now);
    assert.equal(waiting.run.state, "input_required");

    const listed = clarifications.list(principal, run.taskId);
    assert.equal(listed.length, 1);
    const clarification = listed[0];
    assert.ok(clarification);
    assert.equal(clarification.state, "waiting");
    assert.equal(clarification.question.includes("private-region"), false);
    assert.deepEqual(clarification.choices, ["eu-west-1", "eu-central-1"]);
    const questionMessage = core.getMessage(clarification.questionMessageId);
    assert.equal(questionMessage?.senderId, agent.agentId);
    assert.equal(questionMessage?.taskId, run.taskId);
    assert.equal(questionMessage?.parentMessageId, trigger.messageId);
    assert.equal(questionMessage?.content.includes("private-region"), false);
    const persistedClarification = runRepository.listEvents(run.runId).at(-1)?.event;
    assert.equal(
      persistedClarification?.type === "status" &&
        persistedClarification.clarification?.question.includes("private-region"),
      false
    );

    const outsiderTeam = teams.createTeamForUser({
      userId: "user_clarification_outsider",
      userDisplayName: "Mallory",
      teamName: "Other Team",
      now
    });
    const outsiderSession = auth.issueWebSession(
      outsiderTeam.owner.userId ?? "",
      now,
      "2026-08-25T11:00:00.000Z"
    );
    const outsider = auth.authenticateWebSession(outsiderSession.secret, now);
    assert.throws(
      () => clarifications.list(outsider, run.taskId),
      /Room access denied/u
    );
    assert.throws(
      () => clarifications.answer(
        outsider,
        clarification.clarificationId,
        "Try to cross Team scope.",
        now
      ),
      /Room access denied/u
    );

    const resumed = clarifications.answer(
      principal,
      clarification.clarificationId,
      "Use eu-west-1.",
      "2026-08-25T10:01:00.000Z"
    );
    assert.equal(resumed.clarification.state, "resumed");
    assert.equal(resumed.run.taskId, run.taskId);
    assert.equal(resumed.run.targetAgentId, agent.agentId);
    assert.equal(resumed.run.runId, resumed.clarification.continuationRunId);
    assert.notEqual(resumed.run.runId, run.runId);
    assert.equal(resumed.message.parentMessageId, questionMessage?.messageId);
    assert.equal(resumed.message.content, "Use eu-west-1.");
    assert.equal(runRepository.getRun(run.runId)?.state, "outcome_unknown");
    assert.equal(
      runRepository.listEvents(run.runId).at(-1)?.event.type === "status" &&
        runRepository.listEvents(run.runId).at(-1)?.event.status,
      "outcome_unknown"
    );

    const delivery = new DeliveryService(
      database,
      core,
      runRepository,
      new ContextPlanner(database, core, taskRepository),
      new BridgeConnectionRegistry(),
      () => "2026-08-25T10:01:00.000Z"
    ).dispatch(resumed.run.runId);
    assert.equal(delivery?.payload.taskId, run.taskId);
    assert.deepEqual(delivery?.payload.session, {
      scope: "task",
      resumePolicy: "resume_or_start",
      contextCursor: resumed.message.sequence
    });
    assert.ok(delivery?.payload.contextMessages.some((message) =>
      message.messageId === clarification.questionMessageId
    ));

    const retry = clarifications.answer(
      principal,
      clarification.clarificationId,
      "A conflicting retry must not create a second continuation.",
      "2026-08-25T10:02:00.000Z"
    );
    assert.equal(retry.run.runId, resumed.run.runId);
    assert.equal(runRepository.findByTrigger(resumed.message.messageId).length, 1);
    assert.throws(() => bridgeEvents.applyStatus(devicePrincipal, {
      runId: resumed.run.runId,
      traceId: resumed.run.traceId,
      agentId: agent.agentId,
      sequence: 2,
      status: "input_required",
      clarification: {
        kind: "task",
        question: "Invalid choice shape",
        choices: ["only-one"]
      }
    }, now), /Invalid Task clarification status/u);

    const requestClarification = (content: string, at: string) => {
      const message = messages.createMemberMessage(principal, {
        roomId: room.roomId,
        taskId: run.taskId,
        content,
        mentions: [{
          targetType: "agent" as const,
          targetAgentId: agent.agentId,
          displayLabel: "Builder / Managed"
        }],
        now: at
      });
      const pending = runs.createRunsForMessage(principal, message.messageId, at)[0];
      assert.ok(pending);
      runRepository.applyEvent(pending.runId, {
        type: "status", sequence: 1, status: "delivered"
      }, at);
      bridgeEvents.applyStatus(devicePrincipal, {
        runId: pending.runId,
        traceId: pending.traceId,
        agentId: agent.agentId,
        sequence: 2,
        status: "working"
      }, at);
      bridgeEvents.applyStatus(devicePrincipal, {
        runId: pending.runId,
        traceId: pending.traceId,
        agentId: agent.agentId,
        sequence: 3,
        status: "input_required",
        clarification: { kind: "task", question: `Clarify ${content}?` }
      }, at);
      const latest = clarificationRepository.listForTask(run.taskId)[0];
      assert.ok(latest);
      return { run: pending, clarification: latest };
    };

    const cancelCase = requestClarification(
      "cancel lifecycle",
      "2026-08-25T10:03:00.000Z"
    );
    const canceled = new CancellationService(
      core,
      runRepository,
      auth,
      new BridgeConnectionRegistry(),
      () => "2026-08-25T10:04:00.000Z"
    ).cancel(principal, cancelCase.run.runId, "No longer needed");
    assert.equal(canceled.state, "canceled");
    assert.deepEqual(
      clarificationRepository.get(cancelCase.clarification.clarificationId),
      {
        ...cancelCase.clarification,
        state: "canceled",
        resolutionReason: "run_canceled",
        canceledAt: "2026-08-25T10:04:00.000Z"
      }
    );

    const expireCase = requestClarification(
      "expiry lifecycle",
      "2026-08-25T10:05:00.000Z"
    );
    clarifications.list(
      principal,
      run.taskId,
      "2026-08-25T10:25:01.000Z"
    );
    assert.equal(runRepository.getRun(expireCase.run.runId)?.state, "expired");
    assert.equal(
      clarificationRepository.get(expireCase.clarification.clarificationId)
        ?.resolutionReason,
      "run_expired"
    );

    const unavailableCase = requestClarification(
      "unavailable Agent lifecycle",
      "2026-08-25T10:26:00.000Z"
    );
    database.prepare(`
      UPDATE agents SET enabled = 0, presence = 'offline', updated_at = ?
      WHERE agent_id = ?
    `).run("2026-08-25T10:27:00.000Z", agent.agentId);
    const reconciled = clarifications.reconcile("2026-08-25T10:27:00.000Z");
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.clarificationId, unavailableCase.clarification.clarificationId);
    assert.equal(reconciled[0]?.resolutionReason, "agent_unavailable");
    assert.equal(
      runRepository.getRun(unavailableCase.run.runId)?.state,
      "outcome_unknown"
    );
    assert.throws(() => clarifications.answer(
      principal,
      unavailableCase.clarification.clarificationId,
      "Too late",
      "2026-08-25T10:28:00.000Z"
    ), /clarification is canceled/u);
  } finally {
    database.close();
  }
});
