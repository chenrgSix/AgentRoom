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
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("only a structured visible Agent Mention is persisted for routing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-mention-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(repository, auth);
    const registry = new MemberDeviceService(repository, auth);
    const agents = new AgentService(repository, auth);
    const messages = new MessageService(repository, auth);
    const created = teams.createTeamForUser({
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
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(
      principal,
      created.team.teamId,
      "Alice Mac",
      now
    );
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Backend",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });

    const plain = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "@Builder this is only text",
      now
    });
    assert.deepEqual(plain.mentions, []);

    const structured = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Please implement the API.",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Backend"
      }],
      now
    });
    assert.equal(structured.mentions[0]?.targetAgentId, agent.agentId);
    assert.throws(() => messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Try a forged target.",
      mentions: [{
        targetType: "agent",
        targetAgentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
        displayLabel: "Forged"
      }],
      now
    }), /Mention target is unavailable/);
    assert.throws(() => messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Duplicate target.",
      mentions: [
        {
          targetType: "agent",
          targetAgentId: agent.agentId,
          displayLabel: "Builder"
        },
        {
          targetType: "agent",
          targetAgentId: agent.agentId,
          displayLabel: "Builder Again"
        }
      ],
      now
    }), /Duplicate Agent Mention/);
  } finally {
    database.close();
  }
});
