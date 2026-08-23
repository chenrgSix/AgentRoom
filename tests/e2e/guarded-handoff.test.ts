import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../../apps/server/src/app.js";

const now = "2026-08-23T12:00:00.000Z";

test("three Remote MCP Agents complete one guarded handoff chain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-handoff-e2e-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now
  });
  try {
    const bootstrap = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { displayName: "Team Owner" }
    });
    const webToken = bootstrap.json().session.token as string;
    const webHeaders = { authorization: `Bearer ${webToken}` };
    const team = await app.inject({
      method: "POST", url: "/api/teams", headers: webHeaders,
      payload: { name: "Guarded Handoff" }
    });
    const teamId = team.json().team.teamId as string;
    const room = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/rooms`, headers: webHeaders,
      payload: { name: "delivery" }
    });
    const roomId = room.json().roomId as string;

    const createAgent = async (name: string, role: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/teams/${teamId}/manual-agents`,
        headers: webHeaders,
        payload: { name, role }
      });
      assert.equal(response.statusCode, 200);
      return {
        agentId: response.json().agent.agentId as string,
        token: response.json().credential.token as string
      };
    };
    const alice = await createAgent("Alice Agent", "Planner");
    const bob = await createAgent("Bob Agent", "Implementer");
    const carol = await createAgent("Carol Agent", "Reviewer");

    let requestId = 1;
    const call = async (
      token: string,
      name: string,
      args: Record<string, unknown>
    ) => app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`
      },
      payload: {
        jsonrpc: "2.0",
        id: requestId++,
        method: "tools/call",
        params: { name, arguments: args }
      }
    });

    const rootResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: webHeaders,
      payload: {
        content: "Plan, implement, and review the guarded delivery change.",
        mentionAgentId: alice.agentId
      }
    });
    assert.equal(rootResponse.statusCode, 200);
    const rootRun = rootResponse.json().runs[0] as {
      runId: string;
      traceId: string;
      state: string;
    };
    assert.equal(rootRun.state, "queued");

    const aliceClaim = await call(alice.token, "team.claim_run", {
      runId: rootRun.runId
    });
    assert.equal(aliceClaim.json().result.structuredContent.run.state, "working");
    const bobHandoff = await call(alice.token, "team.handoff", {
      parentRunId: rootRun.runId,
      targetAgentId: bob.agentId,
      instruction: "Implement Alice's bounded plan."
    });
    const bobRun = bobHandoff.json().result.structuredContent.run as {
      runId: string;
      traceId: string;
      parentRunId: string;
    };
    assert.equal(bobRun.parentRunId, rootRun.runId);
    assert.equal(bobRun.traceId, rootRun.traceId);

    await call(bob.token, "team.claim_run", { runId: bobRun.runId });
    const carolHandoff = await call(bob.token, "team.handoff", {
      parentRunId: bobRun.runId,
      targetAgentId: carol.agentId,
      instruction: "Review the implementation and report the release decision."
    });
    const carolRun = carolHandoff.json().result.structuredContent.run as {
      runId: string;
      traceId: string;
      parentRunId: string;
    };
    assert.equal(carolRun.parentRunId, bobRun.runId);
    assert.equal(carolRun.traceId, rootRun.traceId);

    await call(carol.token, "team.claim_run", { runId: carolRun.runId });
    const loop = await call(carol.token, "team.handoff", {
      parentRunId: carolRun.runId,
      targetAgentId: alice.agentId,
      instruction: "Attempt to revisit Alice."
    });
    assert.equal(loop.json().result.isError, true);
    assert.match(loop.json().result.content[0].text, /cannot revisit/u);

    const carolComplete = await call(carol.token, "team.complete_run", {
      runId: carolRun.runId,
      content: "Carol approved the bounded implementation."
    });
    assert.equal(carolComplete.json().result.structuredContent.run.state, "completed");
    const bobComplete = await call(bob.token, "team.complete_run", {
      runId: bobRun.runId,
      content: "Bob completed implementation after Carol's review."
    });
    assert.equal(bobComplete.json().result.structuredContent.run.state, "completed");
    const aliceComplete = await call(alice.token, "team.complete_run", {
      runId: rootRun.runId,
      content: "Alice finalized the reviewed delivery plan."
    });
    assert.equal(aliceComplete.json().result.structuredContent.run.state, "completed");

    const runs = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/runs`, headers: webHeaders
    });
    assert.deepEqual(
      runs.json().map((run: { state: string }) => run.state),
      ["completed", "completed", "completed"]
    );
    assert.ok(runs.json().every((run: { traceId: string }) =>
      run.traceId === rootRun.traceId
    ));
    const trace = await app.inject({
      method: "GET", url: `/api/traces/${rootRun.traceId}`, headers: webHeaders
    });
    assert.deepEqual(
      new Set(trace.json().entries
        .filter((entry: { kind: string }) => entry.kind === "run")
        .map((entry: { entityId: string }) => entry.entityId)),
      new Set([rootRun.runId, bobRun.runId, carolRun.runId])
    );
  } finally {
    await app.close();
  }
});
