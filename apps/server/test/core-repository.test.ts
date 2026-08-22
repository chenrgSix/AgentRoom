import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { prepareDatabaseDirectory } from "../src/data/database-location.js";
import { migrateDatabase } from "../src/data/migration-runner.js";

const createdAt = "2026-08-22T10:00:00.000Z";

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-core-"));
  const databasePath = path.join(directory, "data", "server.sqlite");
  await prepareDatabaseDirectory(databasePath);
  await migrateDatabase(databasePath);
  return databasePath;
}

test("core entities persist and reload with structured mentions", async () => {
  const databasePath = await createDatabasePath();
  const database = openDatabase(databasePath);
  const repository = new CoreRepository(database);

  repository.createUser({
    userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    displayName: "Alice",
    createdAt
  });
  repository.createTeamWithOwner(
    {
      teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      name: "Core Team",
      createdAt
    },
    {
      memberId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      displayName: "Alice",
      role: "owner",
      createdAt
    }
  );
  repository.createRoom({
    roomId: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    name: "general",
    createdAt
  });
  repository.createDevice({
    deviceId: "device_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    ownerMemberId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    name: "Alice Mac",
    status: "active",
    createdAt,
    revokedAt: null
  });
  repository.createAgent({
    agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    ownerMemberId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    deviceId: "device_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    name: "Builder",
    role: "Backend",
    integrationMode: "fake",
    capabilities: {
      supportsHandoff: true,
      supportsInterrupt: true,
      supportsResume: false,
      supportsStart: true,
      supportsStreaming: true
    },
    enabled: true,
    presence: "ready",
    createdAt,
    updatedAt: createdAt
  });
  const first = repository.appendMessage({
    messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    roomId: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    senderType: "member",
    senderId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    content: "Please review the data model.",
    mentions: [{
      targetType: "agent",
      targetAgentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      displayLabel: "Builder / Backend"
    }],
    parentMessageId: null,
    createdAt
  });
  const second = repository.appendMessage({
    messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
    roomId: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    senderType: "member",
    senderId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    content: "Use stable ordering.",
    mentions: [],
    parentMessageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    createdAt
  });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  database.close();

  const reopened = openDatabase(databasePath);
  try {
    const reloaded = new CoreRepository(reopened);
    assert.equal(
      reloaded.getTeam("team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6")?.name,
      "Core Team"
    );
    assert.equal(
      reloaded.getMember("member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6")?.role,
      "owner"
    );
    assert.equal(
      reloaded.getRoom("room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6")?.name,
      "general"
    );
    assert.equal(
      reloaded.getDevice("device_01K4Z6J7Y8N9P0Q1R2S3T4V5W6")?.status,
      "active"
    );
    assert.equal(
      reloaded.getAgent("agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6")?.role,
      "Backend"
    );
    assert.deepEqual(
      reloaded.getMessage("msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6"),
      first
    );
    assert.deepEqual(
      reloaded.getMessage("msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W7"),
      second
    );
  } finally {
    reopened.close();
  }
});

test("a message rejects an unavailable or cross-Team Agent mention", async () => {
  const databasePath = await createDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    repository.createUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      displayName: "Alice",
      createdAt
    });
    repository.createTeamWithOwner(
      {
        teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        name: "Core Team",
        createdAt
      },
      {
        memberId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        displayName: "Alice",
        role: "owner",
        createdAt
      }
    );
    repository.createRoom({
      roomId: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      teamId: "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      name: "general",
      createdAt
    });

    assert.throws(() => repository.appendMessage({
      messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      roomId: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      senderType: "member",
      senderId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      content: "Mention an unknown Agent.",
      mentions: [{
        targetType: "agent",
        targetAgentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        displayLabel: "Unknown"
      }],
      parentMessageId: null,
      createdAt
    }), /Mention target is unavailable/);
  } finally {
    database.close();
  }
});
