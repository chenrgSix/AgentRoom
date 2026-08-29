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
import { PresenceService } from "../src/registry/presence-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("heartbeat, adapter health, stale epochs, and TTL derive Presence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-presence-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(repository, auth);
    const registry = new MemberDeviceService(repository, auth);
    const agents = new AgentService(repository, auth);
    const presence = new PresenceService(repository, auth, 30_000);
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: "Alice",
      teamName: "Core Team",
      now
    });
    const webSession = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const webPrincipal = auth.authenticateWebSession(webSession.secret, now);
    const device = registry.registerOwnDevice(
      webPrincipal,
      created.team.teamId,
      "Alice Mac",
      now
    );
    const agent = agents.publishAgent(webPrincipal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Backend",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const manual = agents.publishAgent(webPrincipal, {
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
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const devicePrincipal = auth.authenticateDevice(credential.secret, now);

    presence.recordHello(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 2,
      bridgeVersion: "0.4.0-qa030.1",
      adapterAvailable: true,
      now
    });
    assert.deepEqual(repository.getDeviceBridgeObservation(device.deviceId), {
      deviceId: device.deviceId,
      connectionEpoch: 2,
      bridgeVersion: "0.4.0-qa030.1",
      sourceCommit: null,
      executableSha256: null,
      observedAt: now
    });
    assert.equal(
      presence.listAgents(webPrincipal, created.team.teamId, now)
        .find((item) => item.agentId === agent.agentId)?.presence,
      "ready"
    );
    assert.equal(
      presence.listAgents(webPrincipal, created.team.teamId, now)
        .find((item) => item.agentId === manual.agentId)?.presence,
      "manual"
    );
    presence.recordHeartbeat(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 2,
      adapterAvailable: false,
      now
    });
    assert.equal(
      repository.getDeviceBridgeObservation(device.deviceId)?.bridgeVersion,
      "0.4.0-qa030.1"
    );
    assert.equal(
      presence.listAgents(webPrincipal, created.team.teamId, now)
        .find((item) => item.agentId === agent.agentId)?.presence,
      "degraded"
    );
    presence.recordHello(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 3,
      bridgeVersion: "0.4.0-qa030.2",
      sourceCommit: "a".repeat(40),
      executableSha256: "b".repeat(64),
      adapterAvailable: true,
      now
    });
    assert.deepEqual(repository.getDeviceBridgeObservation(device.deviceId), {
      deviceId: device.deviceId,
      connectionEpoch: 3,
      bridgeVersion: "0.4.0-qa030.2",
      sourceCommit: "a".repeat(40),
      executableSha256: "b".repeat(64),
      observedAt: now
    });
    assert.throws(() => presence.recordHello(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 3,
      bridgeVersion: "0.4.0-qa030.3",
      adapterAvailable: true,
      now
    }), /build observation changed within one connection epoch/);
    assert.throws(() => presence.recordHello(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 4,
      bridgeVersion: "0.4.0-qa030.3",
      sourceCommit: "a".repeat(40),
      adapterAvailable: true,
      now
    }), /build observation must be one canonical pair/);
    assert.throws(() => presence.recordHello(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 5,
      bridgeVersion: "v0.4.0-qa030.3",
      adapterAvailable: true,
      now
    }), /Bridge version must be canonical/);
    repository.updateAgentPresence(agent.agentId, "busy", now);
    assert.equal(
      presence.listAgents(webPrincipal, created.team.teamId, now)
        .find((item) => item.agentId === agent.agentId)?.presence,
      "busy"
    );
    assert.throws(() => presence.recordHeartbeat(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 1,
      adapterAvailable: true,
      now
    }), /Stale Device connection epoch/);
    assert.equal(
      presence.listAgents(
        webPrincipal,
        created.team.teamId,
        "2026-08-22T10:00:31.000Z"
      ).find((item) => item.agentId === agent.agentId)?.presence,
      "offline"
    );
    assert.equal(repository.getAgent(agent.agentId)?.presence, "offline");
  } finally {
    database.close();
  }
});
