import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { HandoffService } from "../src/run/handoff-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("MCP Agent handoff creates a bounded child and rejects lineage loops", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-handoff-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const agents = new AgentService(core, auth);
    const messages = new MessageService(core, auth);
    const runRepository = new RunRepository(database);
    const runs = new RunService(core, runRepository, auth);
    const handoffs = new HandoffService(core, runRepository);
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", userDisplayName: "Alice",
      teamName: "Core Team", now
    });
    const session = auth.issueWebSession(created.owner.userId ?? "", now, "2026-08-22T11:00:00.000Z");
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const capabilities = {
      supportsHandoff: true, supportsInterrupt: false, supportsResume: false,
      supportsStart: false, supportsStreaming: false
    };
    const builder = agents.publishAgent(principal, {
      teamId: created.team.teamId, deviceId: null, name: "Builder", role: "Manual",
      integrationMode: "manual", capabilities, now
    });
    const reviewer = agents.publishAgent(principal, {
      teamId: created.team.teamId, deviceId: null, name: "Reviewer", role: "Manual",
      integrationMode: "manual", capabilities, now
    });
    const builderCredential = auth.issueMcpCredential(principal, builder.agentId, now, "2026-08-22T11:00:00.000Z");
    const reviewerCredential = auth.issueMcpCredential(principal, reviewer.agentId, now, "2026-08-22T11:00:00.000Z");
    const trigger = messages.createMemberMessage(principal, {
      roomId: room.roomId, content: "Build it", mentions: [{
        targetType: "agent", targetAgentId: builder.agentId, displayLabel: "Builder / Manual"
      }], now
    });
    const root = runs.createRunsForMessage(principal, trigger.messageId, now)[0];
    assert.ok(root);
    const child = handoffs.create(auth.authenticateMcp(builderCredential.secret, now), {
      parentRunId: root.runId, targetAgentId: reviewer.agentId, instruction: "Review it"
    }, now);
    assert.equal(child.parentRunId, root.runId);
    assert.equal(child.targetAgentId, reviewer.agentId);
    assert.throws(() => handoffs.create(auth.authenticateMcp(reviewerCredential.secret, now), {
      parentRunId: child.runId, targetAgentId: builder.agentId, instruction: "Loop back"
    }, now), /cannot revisit/u);
  } finally {
    database.close();
  }
});
