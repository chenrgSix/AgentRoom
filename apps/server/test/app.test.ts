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
    const ownerMemberId = members.json()[0].memberId as string;
    const agents = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/agents`,
      headers: { authorization }
    });
    assert.deepEqual(
      agents.json().map((item: { name: string }) => item.name).sort(),
      ["Builder", "Reviewer"]
    );
    const renamedTeam = await app.inject({
      method: "PATCH",
      url: `/api/teams/${team.team.teamId}`,
      headers: { authorization },
      payload: { name: "Delivery Team" }
    });
    assert.equal(renamedTeam.statusCode, 200);
    assert.equal(renamedTeam.json().name, "Delivery Team");
    const renamedRoom = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.roomId}`,
      headers: { authorization },
      payload: { name: "delivery" }
    });
    assert.equal(renamedRoom.statusCode, 200);
    assert.equal(renamedRoom.json().name, "delivery");
    const disabledAgent = await app.inject({
      method: "PATCH",
      url: `/api/agents/${reviewer.agentId}`,
      headers: { authorization },
      payload: { enabled: false }
    });
    assert.equal(disabledAgent.statusCode, 200);
    assert.equal(disabledAgent.json().enabled, false);
    const enabledAgent = await app.inject({
      method: "PATCH",
      url: `/api/agents/${reviewer.agentId}`,
      headers: { authorization },
      payload: { enabled: true }
    });
    assert.equal(enabledAgent.statusCode, 200);
    const archivedRoom = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.roomId}`,
      headers: { authorization },
      payload: { archived: true }
    });
    assert.equal(archivedRoom.statusCode, 200);
    const activeRooms = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/rooms`,
      headers: { authorization }
    });
    assert.deepEqual(activeRooms.json(), []);
    const allRooms = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/rooms?includeArchived=true`,
      headers: { authorization }
    });
    assert.equal(allRooms.json()[0].roomId, room.roomId);
    await app.inject({
      method: "PATCH",
      url: `/api/rooms/${room.roomId}`,
      headers: { authorization },
      payload: { archived: false }
    });
    await app.inject({
      method: "PATCH",
      url: `/api/teams/${team.team.teamId}`,
      headers: { authorization },
      payload: { archived: true }
    });
    const activeTeams = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization }
    });
    assert.deepEqual(activeTeams.json(), []);
    const allTeams = await app.inject({
      method: "GET",
      url: "/api/teams?includeArchived=true",
      headers: { authorization }
    });
    assert.equal(allTeams.json()[0].teamId, team.team.teamId);
    await app.inject({
      method: "PATCH",
      url: `/api/teams/${team.team.teamId}`,
      headers: { authorization },
      payload: { archived: false }
    });
    const changeCheckpoint = await app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/changes?after=0`,
      headers: { authorization }
    });
    assert.equal(changeCheckpoint.statusCode, 200);
    const changeCursor = changeCheckpoint.json().cursor as number;
    const nextChange = app.inject({
      method: "GET",
      url: `/api/teams/${team.team.teamId}/changes?after=${changeCursor}`,
      headers: { authorization }
    });
    const createMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/messages`,
      headers: { authorization },
      payload: {
        content: "Hello Team",
        mentionAgentId: agent.agentId,
        clientMessageId: "client_01K4Z6J7Y8N9P0Q1R2S3T4V5W6"
      }
    });
    assert.equal(createMessage.statusCode, 200);
    const changed = await nextChange;
    assert.equal(changed.statusCode, 200);
    assert.deepEqual(changed.json(), {
      changed: true,
      cursor: changeCursor + 1,
      reset: false
    });
    const routed = createMessage.json() as {
      message: { messageId: string; sequence: number };
      runs: Array<{ runId: string; targetAgentId: string; state: string }>;
    };
    assert.equal(routed.message.sequence, 1);
    assert.equal(routed.runs[0]?.targetAgentId, agent.agentId);
    assert.equal(routed.runs[0]?.state, "completed");
    const retryMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/messages`,
      headers: { authorization },
      payload: {
        content: "ambiguous retry content is ignored",
        mentionAgentId: agent.agentId,
        clientMessageId: "client_01K4Z6J7Y8N9P0Q1R2S3T4V5W6"
      }
    });
    assert.equal(retryMessage.statusCode, 200);
    assert.equal(retryMessage.json().message.messageId, routed.message.messageId);
    assert.equal(retryMessage.json().runs[0].runId, routed.runs[0]?.runId);
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

    const roomParticipants = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.roomId}/participants`,
      headers: { authorization }
    });
    assert.equal(roomParticipants.statusCode, 200);
    assert.deepEqual(roomParticipants.json().memberIds, [ownerMemberId]);
    assert.deepEqual(
      roomParticipants.json().agentIds.sort(),
      [agent.agentId, reviewer.agentId].sort()
    );
    const updateParticipants = await app.inject({
      method: "PUT",
      url: `/api/rooms/${room.roomId}/participants`,
      headers: { authorization },
      payload: { memberIds: [ownerMemberId], agentIds: [agent.agentId] }
    });
    assert.equal(updateParticipants.statusCode, 200);
    assert.deepEqual(updateParticipants.json(), {
      memberIds: [ownerMemberId],
      agentIds: [agent.agentId]
    });
    const removedAgentMention = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/messages`,
      headers: { authorization },
      payload: { content: "Reviewer is no longer assigned", mentionAgentId: reviewer.agentId }
    });
    assert.equal(removedAgentMention.statusCode, 400);
    assert.match(removedAgentMention.json().error.message, /Mention target is unavailable/u);
    const removedAgentDiscussion = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.roomId}/discussions`,
      headers: { authorization },
      payload: {
        goal: "Do not schedule an unassigned reviewer.",
        participantAgentIds: [agent.agentId, reviewer.agentId]
      }
    });
    assert.equal(removedAgentDiscussion.statusCode, 400);
    assert.match(removedAgentDiscussion.json().error.message, /participant is unavailable/u);

    const createConflictRoom = await app.inject({
      method: "POST",
      url: `/api/teams/${team.team.teamId}/rooms`,
      headers: { authorization },
      payload: { name: "discussion-conflict" }
    });
    assert.equal(createConflictRoom.statusCode, 200);
    const conflictRoomId = createConflictRoom.json().roomId as string;
    const manualAgentIds: string[] = [];
    for (const name of ["Manual Coder", "Manual Reviewer"]) {
      const created = await app.inject({
        method: "POST",
        url: `/api/teams/${team.team.teamId}/manual-agents`,
        headers: { authorization },
        payload: { name, role: "Participant" }
      });
      assert.equal(created.statusCode, 200);
      manualAgentIds.push(created.json().agent.agentId as string);
    }
    const openDiscussion = await app.inject({
      method: "POST",
      url: `/api/rooms/${conflictRoomId}/discussions`,
      headers: { authorization },
      payload: {
        goal: "Wait for manual participants.",
        participantAgentIds: manualAgentIds
      }
    });
    assert.equal(openDiscussion.statusCode, 200);
    const competingDiscussion = await app.inject({
      method: "POST",
      url: `/api/rooms/${conflictRoomId}/discussions`,
      headers: { authorization },
      payload: {
        goal: "Do not start a hidden competing Discussion.",
        participantAgentIds: manualAgentIds
      }
    });
    assert.equal(competingDiscussion.statusCode, 409);
    assert.equal(competingDiscussion.json().error.code, "CONFLICT");
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
    assert.equal(timeline.json().items.length, 15);
  } finally {
    await reloaded.close();
  }
});
