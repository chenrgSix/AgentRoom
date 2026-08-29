import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { prepareDatabaseDirectory } from "../src/data/database-location.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import {
  AuthService,
  AuthorizationError
} from "../src/security/auth-service.js";

const now = "2026-08-22T10:00:00.000Z";
const future = "2026-08-22T11:00:00.000Z";
const userId = "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";
const teamId = "team_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";
const memberId = "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";
const deviceId = "device_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-auth-"));
  const databasePath = path.join(directory, "server.sqlite");
  await prepareDatabaseDirectory(databasePath);
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const repository = new CoreRepository(database);
  repository.createUser({ userId, displayName: "Alice", createdAt: now });
  repository.createTeamWithOwner(
    { teamId, name: "Core Team", createdAt: now },
    {
      memberId,
      teamId,
      userId,
      displayName: "Alice",
      role: "owner",
      createdAt: now
    }
  );
  repository.createDevice({
    deviceId,
    teamId,
    ownerMemberId: memberId,
    name: "Alice Mac",
    status: "active",
    createdAt: now,
    revokedAt: null
  });
  return { auth: new AuthService(database), database };
}

test("web sessions store only hashes and authorize Team membership", async () => {
  const { auth, database } = await createFixture();
  try {
    const issued = auth.issueWebSession(userId, now, future);
    const stored = database.prepare(`
      SELECT token_hash FROM web_sessions WHERE session_id = ?
    `).get(issued.id) as { token_hash: string };
    assert.notEqual(stored.token_hash, issued.secret);
    assert.equal(stored.token_hash.length, 64);

    const principal = auth.authenticateWebSession(issued.secret, now);
    assert.equal(principal.userId, userId);
    assert.equal(auth.requireTeamMember(principal, teamId).memberId, memberId);
    assert.throws(
      () => auth.requireTeamMember(
        principal,
        "team_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ"
      ),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "FORBIDDEN"
    );
  } finally {
    database.close();
  }
});

test("forged, expired, and revoked web sessions are rejected", async () => {
  const { auth, database } = await createFixture();
  try {
    assert.throws(
      () => auth.authenticateWebSession("forged-token", now),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "UNAUTHENTICATED"
    );

    const issued = auth.issueWebSession(userId, now, future);
    assert.throws(
      () => auth.authenticateWebSession(
        issued.secret,
        "2026-08-22T11:00:00.000Z"
      ),
      AuthorizationError
    );
    assert.equal(auth.revokeWebSession(issued.id, now), true);
    assert.throws(
      () => auth.authenticateWebSession(issued.secret, now),
      AuthorizationError
    );
  } finally {
    database.close();
  }
});

test("device credentials rotate and revoke without persisting the secret", async () => {
  const { auth, database } = await createFixture();
  try {
    const first = auth.issueDeviceCredential(deviceId, now);
    assert.equal(auth.authenticateDevice(first.secret, now).deviceId, deviceId);

    const second = auth.issueDeviceCredential(deviceId, now);
    assert.throws(() => auth.authenticateDevice(first.secret, now), AuthorizationError);
    assert.equal(auth.authenticateDevice(second.secret, now).teamId, teamId);

    const stored = database.prepare(`
      SELECT secret_hash FROM device_credentials WHERE credential_id = ?
    `).get(second.id) as { secret_hash: string };
    assert.notEqual(stored.secret_hash, second.secret);
    assert.equal(auth.revokeDeviceCredential(second.id, now), true);
    assert.throws(() => auth.authenticateDevice(second.secret, now), AuthorizationError);
  } finally {
    database.close();
  }
});

test("successful authentication coalesces activity timestamp writes", async () => {
  const { auth, database } = await createFixture();
  try {
    const oneMinuteLater = "2026-08-22T10:01:00.000Z";
    const sixMinutesLater = "2026-08-22T10:06:00.000Z";
    const readTimestamp = (
      table: "web_sessions" | "device_credentials" | "mcp_credentials",
      column: "last_seen_at" | "last_used_at",
      idColumn: "session_id" | "credential_id",
      id: string
    ) => (database.prepare(`
      SELECT ${column} AS activity_at FROM ${table} WHERE ${idColumn} = ?
    `).get(id) as { activity_at: string | null }).activity_at;

    const web = auth.issueWebSession(userId, now, future);
    auth.authenticateWebSession(web.secret, oneMinuteLater);
    assert.equal(readTimestamp(
      "web_sessions", "last_seen_at", "session_id", web.id
    ), now);
    auth.authenticateWebSession(web.secret, sixMinutesLater);
    assert.equal(readTimestamp(
      "web_sessions", "last_seen_at", "session_id", web.id
    ), sixMinutesLater);

    const device = auth.issueDeviceCredential(deviceId, now);
    auth.authenticateDevice(device.secret, now);
    auth.authenticateDevice(device.secret, oneMinuteLater);
    assert.equal(readTimestamp(
      "device_credentials", "last_used_at", "credential_id", device.id
    ), now);
    auth.authenticateDevice(device.secret, sixMinutesLater);
    assert.equal(readTimestamp(
      "device_credentials", "last_used_at", "credential_id", device.id
    ), sixMinutesLater);

    const agentId = "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";
    new CoreRepository(database).createAgent({
      agentId,
      teamId,
      ownerMemberId: memberId,
      deviceId: null,
      name: "Reviewer",
      role: "Reviewer",
      integrationMode: "manual",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: false,
        supportsResume: false,
        supportsStart: false,
        supportsStreaming: false
      },
      enabled: true,
      presence: "manual",
      createdAt: now,
      updatedAt: now
    });
    const mcp = auth.issueMcpCredential(
      auth.authenticateWebSession(web.secret, now),
      agentId,
      now
    );
    auth.authenticateMcp(mcp.secret, now);
    auth.authenticateMcp(mcp.secret, oneMinuteLater);
    assert.equal(readTimestamp(
      "mcp_credentials", "last_used_at", "credential_id", mcp.id
    ), now);
    auth.authenticateMcp(mcp.secret, sixMinutesLater);
    assert.equal(readTimestamp(
      "mcp_credentials", "last_used_at", "credential_id", mcp.id
    ), sixMinutesLater);
  } finally {
    database.close();
  }
});
