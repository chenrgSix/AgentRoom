import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createTestResources } from "../../../scripts/test/resources.mjs";

import {
  CoreRepository,
  type AgentCapabilities,
  type AgentRecord
} from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import {
  PresenceService,
  type HostedAgentAvailability
} from "../src/registry/presence-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-30T10:00:00.000Z";

const hostedCapabilities: AgentCapabilities = {
  supportsHandoff: true,
  supportsInterrupt: true,
  supportsResume: false,
  supportsStart: true,
  supportsStreaming: true
};

async function createFixture(t: TestContext, prefix: string) {
  const resources = await createTestResources(t, prefix);
  const directory = resources.directory;
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  resources.defer(() => { if (database.open) database.close(); });
  const repository = new CoreRepository(database);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(repository, auth);
  const agents = new AgentService(repository, auth);
  const registry = new MemberDeviceService(repository, auth);
  const created = teams.createTeamForUser({
    userId: "user_hosted_owner_12345678",
    userDisplayName: "Alice",
    teamName: "Hosted Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-30T11:00:00.000Z"
  );
  const owner = auth.authenticateWebSession(session.secret, now);
  return {
    agents,
    auth,
    created,
    database,
    owner,
    registry,
    repository,
    teams
  };
}

test("Hosted Agent creation requires explicit Rooms and no local Runtime authority", async (t) => {
  const fixture = await createFixture(t, "convene-wire-hosted-registry-");
  try {
    const firstRoom = fixture.teams.createRoom(
      fixture.owner,
      fixture.created.team.teamId,
      "Hosted",
      now
    );
    const secondRoom = fixture.teams.createRoom(
      fixture.owner,
      fixture.created.team.teamId,
      "Private",
      now
    );
    const hosted = fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Central Reviewer",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      roomIds: [firstRoom.roomId],
      now
    });

    assert.equal(hosted.integrationMode, "hosted");
    assert.equal(hosted.deviceId, null);
    assert.equal(hosted.runtimePolicy, null);
    assert.equal(hosted.runtimeScopeId, null);
    assert.equal(hosted.workspaceRef, null);
    assert.equal(hosted.workspaceGeneration, null);
    assert.equal(hosted.workspaceAlias, null);
    assert.equal(hosted.presence, "degraded");
    assert.deepEqual(
      fixture.repository.getRoomParticipants(firstRoom.roomId).agentIds,
      [hosted.agentId]
    );
    assert.deepEqual(
      fixture.repository.getRoomParticipants(secondRoom.roomId).agentIds,
      []
    );
    assert.equal(fixture.repository.getRoom(firstRoom.roomId)?.settingsRevision, 2);
    assert.equal(fixture.repository.getRoom(secondRoom.roomId)?.settingsRevision, 1);

    const unassigned = fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Unassigned Central Agent",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      roomIds: [],
      now
    });
    assert.equal(unassigned.integrationMode, "hosted");
    assert.equal(
      [firstRoom, secondRoom].some((room) =>
        fixture.repository.getRoomParticipants(room.roomId).agentIds.includes(
          unassigned.agentId
        )
      ),
      false
    );

    const laterRoom = fixture.teams.createRoom(
      fixture.owner,
      fixture.created.team.teamId,
      "Later",
      now
    );
    assert.deepEqual(
      fixture.repository.getRoomParticipants(laterRoom.roomId).agentIds,
      []
    );

    const manual = fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Manual Reviewer",
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
    const newestRoom = fixture.teams.createRoom(
      fixture.owner,
      fixture.created.team.teamId,
      "Newest",
      now
    );
    assert.deepEqual(
      fixture.repository.getRoomParticipants(newestRoom.roomId).agentIds,
      [manual.agentId]
    );

    assert.throws(() => fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Implicit Rooms",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      now
    }), /requires explicit Room IDs/u);
    assert.throws(() => fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Duplicate Rooms",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      roomIds: [firstRoom.roomId, firstRoom.roomId],
      now
    }), /Room IDs must be unique/u);
    assert.throws(() => fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: "device_not_a_hosted_binding",
      name: "Device Bound",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      roomIds: [],
      now
    }), /cannot bind Device or local Runtime state/u);
    assert.throws(() => fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Scoped",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      runtimeScopeId: "a".repeat(64),
      roomIds: [],
      now
    }), /cannot bind Device or local Runtime state/u);
    assert.throws(() => fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Resumable",
      role: "Review",
      integrationMode: "hosted",
      capabilities: { ...hostedCapabilities, supportsResume: true },
      roomIds: [],
      now
    }), /cannot advertise Bridge Runtime capabilities/u);
    assert.throws(() => fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "No Stream",
      role: "Review",
      integrationMode: "hosted",
      capabilities: { ...hostedCapabilities, supportsStreaming: false },
      roomIds: [],
      now
    }), /require start, streaming, and interrupt/u);

    const conversionDevice = fixture.registry.registerOwnDevice(
      fixture.owner,
      fixture.created.team.teamId,
      "Conversion Attempt Device",
      now
    );
    const conversionCredential = fixture.auth.issueDeviceCredential(
      conversionDevice.deviceId,
      now
    );
    const conversionPrincipal = fixture.auth.authenticateDevice(
      conversionCredential.secret,
      now
    );
    assert.throws(() => fixture.agents.publishDeviceAgent(conversionPrincipal, {
      agentId: hosted.agentId,
      name: "Converted Hosted Agent",
      role: "Managed",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    }), /Bridge Agent identity ownership denied/u);
    assert.deepEqual(
      {
        integrationMode: fixture.repository.getAgent(hosted.agentId)?.integrationMode,
        deviceId: fixture.repository.getAgent(hosted.agentId)?.deviceId
      },
      { integrationMode: "hosted", deviceId: null }
    );

    fixture.repository.createUser({
      userId: "user_hosted_member_12345678",
      displayName: "Bob",
      createdAt: now
    });
    fixture.repository.createMember({
      memberId: "member_hosted_member_12345678",
      teamId: fixture.created.team.teamId,
      userId: "user_hosted_member_12345678",
      displayName: "Bob",
      role: "member",
      createdAt: now
    });
    const memberSession = fixture.auth.issueWebSession(
      "user_hosted_member_12345678",
      now,
      "2026-08-30T11:00:00.000Z"
    );
    const member = fixture.auth.authenticateWebSession(memberSession.secret, now);
    assert.throws(() => fixture.agents.publishAgent(member, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Member Hosted",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      roomIds: [],
      now
    }), /Only a Team owner/u);

    const directAgent: AgentRecord = {
      ...hosted,
      agentId: "agent_hosted_repository_12345678",
      name: "Repository Hosted"
    };
    assert.throws(
      () => fixture.repository.createAgent(directAgent),
      /requires explicit Room IDs/u
    );
    assert.throws(
      () => fixture.repository.createAgent({
        ...directAgent,
        agentId: "agent_hosted_unsafe_repository_12345678",
        runtimeScopeId: "b".repeat(64)
      }, { roomIds: [] }),
      /cannot persist Device or local Runtime state/u
    );
    const missingRoomAgent = {
      ...directAgent,
      agentId: "agent_hosted_missing_room_12345678"
    };
    assert.throws(
      () => fixture.repository.createAgent(missingRoomAgent, {
        roomIds: ["room_missing_12345678"]
      }),
      /must be active and belong to its Team/u
    );
    assert.equal(fixture.repository.getAgent(missingRoomAgent.agentId), undefined);
  } finally {
    fixture.database.close();
  }
});

test("Hosted Presence derives from injected profile availability without Bridge state", async (t) => {
  const fixture = await createFixture(t, "convene-wire-hosted-presence-");
  try {
    const room = fixture.teams.createRoom(
      fixture.owner,
      fixture.created.team.teamId,
      "Hosted",
      now
    );
    const hosted = fixture.agents.publishAgent(fixture.owner, {
      teamId: fixture.created.team.teamId,
      deviceId: null,
      name: "Central Reviewer",
      role: "Review",
      integrationMode: "hosted",
      capabilities: hostedCapabilities,
      roomIds: [room.roomId],
      now
    });
    let availability: HostedAgentAvailability | undefined;
    const presence = new PresenceService(fixture.repository, fixture.auth, 30_000, {
      getAvailability: (agentId) =>
        agentId === hosted.agentId ? availability : undefined
    });
    const readHosted = () => presence.listAgents(
      fixture.owner,
      fixture.created.team.teamId,
      now
    ).find((agent) => agent.agentId === hosted.agentId);

    assert.equal(readHosted()?.presence, "degraded");
    availability = "ready";
    assert.equal(readHosted()?.presence, "degraded");
    fixture.repository.updateAgentPresence(hosted.agentId, "ready", now);
    assert.equal(readHosted()?.presence, "ready");

    fixture.repository.updateAgentPresence(hosted.agentId, "busy", now);
    availability = "degraded";
    assert.equal(readHosted()?.presence, "busy");
    fixture.repository.updateAgentPresence(hosted.agentId, "ready", now);
    assert.equal(readHosted()?.presence, "degraded");

    assert.equal(
      fixture.agents.setEnabled(fixture.owner, hosted.agentId, false, now).presence,
      "offline"
    );
    availability = "ready";
    assert.equal(readHosted()?.enabled, false);
    assert.equal(readHosted()?.presence, "offline");
    assert.equal(
      fixture.agents.setEnabled(fixture.owner, hosted.agentId, true, now).presence,
      "degraded"
    );
    assert.equal(readHosted()?.presence, "degraded");
    fixture.repository.updateAgentPresence(hosted.agentId, "ready", now);
    assert.equal(readHosted()?.presence, "ready");

    const device = fixture.registry.registerOwnDevice(
      fixture.owner,
      fixture.created.team.teamId,
      "Owner Mac",
      now
    );
    const credential = fixture.auth.issueDeviceCredential(device.deviceId, now);
    const devicePrincipal = fixture.auth.authenticateDevice(credential.secret, now);
    presence.recordHello(devicePrincipal, {
      deviceId: device.deviceId,
      connectionEpoch: 1,
      bridgeVersion: "0.4.1",
      adapterAvailable: true,
      now
    });
    assert.equal(readHosted()?.presence, "ready");
    assert.throws(() => presence.recordAgentStatus(devicePrincipal, {
      agentId: hosted.agentId,
      deviceId: device.deviceId,
      connectionEpoch: 1,
      status: "busy",
      now
    }), /identity mismatch/u);

    const defaultPresence = new PresenceService(fixture.repository, fixture.auth);
    fixture.repository.updateAgentPresence(hosted.agentId, "ready", now);
    assert.equal(
      defaultPresence.listAgents(
        fixture.owner,
        fixture.created.team.teamId,
        now
      ).find((agent) => agent.agentId === hosted.agentId)?.presence,
      "degraded"
    );
  } finally {
    fixture.database.close();
  }
});
