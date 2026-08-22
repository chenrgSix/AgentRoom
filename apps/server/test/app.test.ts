import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

const now = "2026-08-22T10:00:00.000Z";

test("local Web API bootstraps a user and manages authorized Teams and Rooms", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-api-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now
  });
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
    const createAgent = await app.inject({
      method: "POST",
      url: `/api/teams/${team.team.teamId}/fake-agents`,
      headers: { authorization },
      payload: { name: "Builder", role: "Backend" }
    });
    assert.equal(createAgent.statusCode, 200);
    assert.equal(createAgent.json().presence, "ready");

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
    assert.equal(agents.json()[0].name, "Builder");
  } finally {
    await app.close();
  }
});
