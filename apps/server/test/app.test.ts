import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

const now = "2026-08-22T10:00:00.000Z";

test("local Web API bootstraps a user and manages authorized Teams and Rooms", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-api-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({
    databasePath,
    clock: () => now
  });
  let persistedUserId = "";
  let persistedRoomId = "";
  try {
    const unauthorized = await app.inject({ method: "GET", url: "/api/teams" });
    assert.equal(unauthorized.statusCode, 401);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    assert.equal(bootstrap.statusCode, 200);
    const identity = bootstrap.json() as {
      user: { userId: string };
      session: { token: string };
    };
    persistedUserId = identity.user.userId;
    const authorization = `Bearer ${identity.session.token}`;
    const createTeam = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Core Team" }
    });
    assert.equal(createTeam.statusCode, 200);
    const team = createTeam.json() as {
      team: { teamId: string; name: string };
    };
    const createRoom = await app.inject({
      method: "POST",
      url: `/api/teams/${team.team.teamId}/rooms`,
      headers: { authorization },
      payload: { name: "general" }
    });
    assert.equal(createRoom.statusCode, 200);
    const room = createRoom.json() as { roomId: string };
    persistedRoomId = room.roomId;
    const createAgent = await app.inject({
      method: "POST",
      url: `/api/teams/${team.team.teamId}/fake-agents`,
      headers: { authorization },
      payload: { name: "Builder", role: "Backend" }
    });
    assert.equal(createAgent.statusCode, 200);
    assert.equal(createAgent.json().presence, "ready");
    const agent = createAgent.json() as { agentId: string };
    const createReviewer = await app.inject({
      method: "POST",
      url: `/api/teams/${team.team.teamId}/fake-agents`,
      headers: { authorization },
      payload: { name: "Reviewer", role: "Quality" }
    });
    assert.equal(createReviewer.statusCode, 200);
    const reviewer = createReviewer.json() as { agentId: string };

    const teams = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization }
    });
    assert.equal(teams.json()[0].name, "Core Team");
    const rooms = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/rooms`,
      headers: { authorization }
    });
    assert.equal(rooms.json()[0].name, "general");
    const members = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/members`,
      headers: { authorization }
    });
    assert.equal(members.json()[0].displayName, "Alice");
    const agents = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/agents`,
      headers: { authorization }
    });
    assert.deepEqual(
      agents.json().map((item: { name: string }) => item.name).sort(),
      ["Builder", "Reviewer"]
    );
    const createMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/messages`,
      headers: { authorization },
      payload: {
        content: "Hello Team",
        mentionAgentId: agent.agentId
      }
    });
    assert.equal(createMessage.statusCode, 200);
    const routed = createMessage.json() as {
      message: { sequence: number };
      runs: Array<{ runId: string; targetAgentId: string; state: string }>;
    };
    assert.equal(routed.message.sequence, 1);
    assert.equal(routed.runs[0]?.targetAgentId, agent.agentId);
    assert.equal(routed.runs[0]?.state, "completed");
    const reviewMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/messages`,
      headers: { authorization },
      payload: {
        content: "Review the result",
        mentionAgentId: reviewer.agentId
      }
    });
    assert.equal(reviewMessage.statusCode, 200);
    assert.equal(reviewMessage.json().runs[0].state, "completed");
    const timeline = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.roomId}/messages`,
      headers: { authorization }
    });
    assert.deepEqual(
      timeline.json().items.map((item: { content: string }) => item.content),
      [
        "Hello Team",
        "Builder completed: Hello Team",
        "Review the result",
        "Reviewer completed: Review the result"
      ]
    );
    const roomRuns = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.roomId}/runs`,
      headers: { authorization }
    });
    assert.equal(roomRuns.statusCode, 200);
    assert.deepEqual(
      roomRuns.json().map((run: { state: string }) => run.state),
      ["completed", "completed"]
    );
    const runEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${routed.runs[0]?.runId}/events`,
      headers: { authorization }
    });
    assert.deepEqual(
      runEvents.json().map((item: { event: { type: string } }) => item.event.type),
      ["status", "reply", "status"]
    );
    const startDiscussion = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/discussions`,
      headers: { authorization },
      payload: {
        goal: "Agree deterministic delivery recovery.",
        participantAgentIds: [agent.agentId, reviewer.agentId],
        mode: "review",
        outputMode: "decision_record"
      }
    });
    assert.equal(startDiscussion.statusCode, 200);
    const discussion = startDiscussion.json() as {
      discussion: { discussionId: string; state: string; stateReason: string };
      turns: Array<{ kind: string; state: string }>;
    };
    assert.equal(discussion.discussion.state, "completed");
    assert.equal(discussion.discussion.stateReason, "discussion_plateau");
    assert.equal(discussion.turns.at(-1)?.kind, "finalization");
    assert.ok(discussion.turns.every(({ state }) => state === "completed"));
    const listDiscussions = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.roomId}/discussions`,
      headers: { authorization }
    });
    assert.equal(listDiscussions.statusCode, 200);
    assert.equal(listDiscussions.json()[0].discussion.discussionId,
      discussion.discussion.discussionId);
  } finally {
    await app.close();
  }

  const reloaded = await createServerApp({ databasePath, clock: () => now });
  try {
    const bootstrap = await reloaded.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice", userId: persistedUserId }
    });
    const token = (bootstrap.json() as { session: { token: string } }).session.token;
    const timeline = await reloaded.inject({
      method: "GET",
      url: `/api/rooms/${persistedRoomId}/messages`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(timeline.statusCode, 200);
    assert.equal(timeline.json().items.length, 10);
  } finally {
    await reloaded.close();
  }
});
