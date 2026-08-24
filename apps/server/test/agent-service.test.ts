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
import { AuthService } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("managed, fake, and manual Agent publications enforce capability ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-agent-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    const auth = new AuthService(database);
    const teamRooms = new TeamRoomService(repository, auth);
    const registry = new MemberDeviceService(repository, auth);
    const agents = new AgentService(repository, auth);
    const created = teamRooms.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: "Alice",
      teamName: "Core Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const device = registry.registerOwnDevice(
      principal,
      created.team.teamId,
      "Alice Mac",
      now
    );
    const managed = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Backend",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const manual = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: null,
      name: "Reviewer",
      role: "Review",
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
    const fake = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Test Double",
      role: "Acceptance",
      integrationMode: "fake",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const devicePrincipal = auth.authenticateDevice(credential.secret, now);
    const remote = agents.publishDeviceAgent(devicePrincipal, {
      agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5WR",
      name: "Remote Builder",
      role: "Managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const republished = agents.publishDeviceAgent(devicePrincipal, {
      agentId: remote.agentId,
      name: "Remote Builder Updated",
      role: "Managed",
      capabilities: remote.capabilities,
      now
    });

    const disabled = agents.setEnabled(principal, remote.agentId, false, now);
    const republishedDisabled = agents.publishDeviceAgent(devicePrincipal, {
      agentId: remote.agentId,
      name: "Remote Builder While Disabled",
      role: "Managed",
      capabilities: remote.capabilities,
      now
    });
    const enabled = agents.setEnabled(principal, remote.agentId, true, now);

    assert.equal(managed.presence, "offline");
    assert.equal(manual.presence, "manual");
    assert.equal(fake.integrationMode, "fake");
    assert.equal(republished.name, "Remote Builder Updated");
    assert.equal(disabled.enabled, false);
    assert.equal(republishedDisabled.enabled, false);
    assert.equal(republishedDisabled.presence, "offline");
    assert.equal(enabled.enabled, true);
    assert.deepEqual(
      agents.listAgents(principal, created.team.teamId)
        .map((agent) => agent.name)
        .sort(),
      ["Builder", "Remote Builder While Disabled", "Reviewer", "Test Double"]
    );
    assert.throws(() => agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: null,
      name: "Invalid",
      role: "Manual",
      integrationMode: "manual",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: false,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: false
      },
      now
    }), /Manual Agents cannot advertise/);
  } finally {
    database.close();
  }
});
