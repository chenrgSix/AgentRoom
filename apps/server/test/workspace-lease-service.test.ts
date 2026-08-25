import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { WorkspaceLeaseRepository } from
  "../src/workspace/workspace-lease-repository.js";
import { WorkspaceLeaseService } from
  "../src/workspace/workspace-lease-service.js";

const now = "2026-08-25T10:00:00.000Z";
const workspaceRef = `workspace_${"a".repeat(64)}`;
const workspaceGeneration = "b".repeat(64);

test("source-read leases bind exact Run, Agent, Device, and Workspace snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-workspace-"));
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
    const created = teams.createTeamForUser({
      userId: "user_workspace_12345678",
      userDisplayName: "Alice",
      teamName: "Workspace Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-25T11:00:00.000Z"
    );
    const member = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(member, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(
      member,
      created.team.teamId,
      "Alice Mac",
      now
    );
    const otherDevice = registry.registerOwnDevice(
      member,
      created.team.teamId,
      "Other Mac",
      now
    );
    const agent = agents.publishAgent(member, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Managed",
      integrationMode: "managed",
      workspaceRef,
      workspaceGeneration,
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true,
        supportsWorkspaceLeases: true
      },
      now
    });
    const message = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Produce one patch Artifact.",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const run = runs.createRunsForMessage(member, message.messageId, now)[0];
    assert.ok(run);
    runRepository.applyEvent(run.runId, {
      type: "status",
      sequence: 1,
      status: "delivered"
    }, now);

    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const principal = auth.authenticateDevice(credential.secret, now);
    const otherCredential = auth.issueDeviceCredential(otherDevice.deviceId, now);
    const otherPrincipal = auth.authenticateDevice(otherCredential.secret, now);
    const service = new WorkspaceLeaseService(
      new WorkspaceLeaseRepository(database),
      runRepository,
      taskRepository,
      core
    );
    const request = {
      runId: run.runId,
      agentId: agent.agentId,
      workspaceRef,
      workspaceGeneration,
      idempotencyKey: "idem_workspace_lease_12345678"
    };
    const issued = service.issueReadSource(principal, request, now);
    const retried = service.issueReadSource(principal, request, now);

    assert.equal(issued.leaseId, retried.leaseId);
    assert.equal(issued.mode, "read_source");
    assert.equal(issued.state, "active");
    assert.equal(issued.deviceId, device.deviceId);
    assert.equal(
      service.requireActiveReadSource(principal, issued.leaseId, request, now)
        .leaseId,
      issued.leaseId
    );
    assert.throws(
      () => service.issueReadSource(principal, {
        ...request,
        workspaceGeneration: "c".repeat(64)
      }, now),
      /idempotency key conflicts/u
    );
    assert.throws(
      () => service.getForDevice(otherPrincipal, issued.leaseId, now),
      /access denied/u
    );
    assert.equal(
      service.getForDevice(
        principal,
        issued.leaseId,
        "2026-08-25T10:03:00.000Z"
      ).state,
      "expired"
    );
    assert.deepEqual(
      service.getSourceSnapshot(principal, run.runId, agent.agentId),
      {
        agentId: agent.agentId,
        runId: run.runId,
        workspaceRef,
        workspaceGeneration
      }
    );
    const refreshedGeneration = "c".repeat(64);
    assert.equal(
      service.refreshSourceSnapshot(principal, {
        runId: run.runId,
        agentId: agent.agentId,
        workspaceRef,
        expectedWorkspaceGeneration: workspaceGeneration,
        workspaceGeneration: refreshedGeneration
      }, now).workspaceGeneration,
      refreshedGeneration
    );
    assert.throws(
      () => service.refreshSourceSnapshot(principal, {
        runId: run.runId,
        agentId: agent.agentId,
        workspaceRef,
        expectedWorkspaceGeneration: workspaceGeneration,
        workspaceGeneration: "d".repeat(64)
      }, now),
      /refresh conflicts/u
    );
    assert.throws(
      () => service.requireActiveReadSource(principal, issued.leaseId, request, now),
      /stale or unsupported/u
    );
    assert.equal(
      service.issueReadSource(principal, {
        ...request,
        workspaceGeneration: refreshedGeneration,
        idempotencyKey: "idem_workspace_refreshed_12345678"
      }, now).state,
      "active"
    );
    assert.equal(service.release(principal, issued.leaseId, now).state, "released");
  } finally {
    database.close();
  }
});

test("source-read lease rejects stale snapshot and non-active Run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-workspace-"));
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
    const created = teams.createTeamForUser({
      userId: "user_workspace_negative_12345678",
      userDisplayName: "Alice",
      teamName: "Workspace Negative Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-25T11:00:00.000Z"
    );
    const member = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(member, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(
      member,
      created.team.teamId,
      "Alice Mac",
      now
    );
    const agent = agents.publishAgent(member, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Managed",
      integrationMode: "managed",
      workspaceRef,
      workspaceGeneration,
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true,
        supportsWorkspaceLeases: true
      },
      now
    });
    const message = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Produce one patch Artifact.",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const run = runs.createRunsForMessage(member, message.messageId, now)[0];
    assert.ok(run);
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const principal = auth.authenticateDevice(credential.secret, now);
    const service = new WorkspaceLeaseService(
      new WorkspaceLeaseRepository(database),
      runRepository,
      taskRepository,
      core
    );
    assert.throws(
      () => service.issueReadSource(principal, {
        runId: run.runId,
        agentId: agent.agentId,
        workspaceRef,
        workspaceGeneration,
        idempotencyKey: "idem_workspace_queued_12345678"
      }, now),
      /active assigned Run/u
    );

    runRepository.applyEvent(run.runId, {
      type: "status",
      sequence: 1,
      status: "delivered"
    }, now);
    const activeRequest = {
      runId: run.runId,
      agentId: agent.agentId,
      workspaceRef,
      workspaceGeneration,
      idempotencyKey: "idem_workspace_live_recheck_1234"
    };
    const activeLease = service.issueReadSource(principal, activeRequest, now);
    assert.throws(
      () => service.issueReadSource(principal, {
        runId: run.runId,
        agentId: agent.agentId,
        workspaceRef,
        workspaceGeneration: "c".repeat(64),
        idempotencyKey: "idem_workspace_stale_12345678"
      }, now),
      /stale or unsupported/u
    );

    runRepository.applyEvent(run.runId, {
      type: "status",
      sequence: 2,
      status: "completed"
    }, now);
    assert.throws(
      () => service.issueReadSource(principal, activeRequest, now),
      /active assigned Run/u
    );
    assert.throws(
      () => service.requireActiveReadSource(
        principal,
        activeLease.leaseId,
        activeRequest,
        now
      ),
      /active assigned Run/u
    );
    assert.throws(
      () => service.issueReadSource(principal, {
        runId: run.runId,
        agentId: agent.agentId,
        workspaceRef,
        workspaceGeneration,
        idempotencyKey: "idem_workspace_terminal_12345678"
      }, now),
      /active assigned Run/u
    );
  } finally {
    database.close();
  }
});
