import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

const now = "2026-08-23T10:00:00.000Z";

test("health and metrics expose safe operational failure signals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-ops-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now
  });
  try {
    const live = await app.inject({ method: "GET", url: "/api/health/live" });
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().status, "alive");

    const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
    assert.deepEqual(ready.json(), { status: "ready" });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.deepEqual(health.json(), {
      status: "ready",
      checks: { database: "ready", bridge: "not_configured" }
    });

    const unauthorized = await app.inject({ method: "GET", url: "/api/teams" });
    assert.equal(unauthorized.statusCode, 401);

    const bootstrap = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { displayName: "Alice" }
    });
    const authorization = {
      authorization: `Bearer ${bootstrap.json().session.token as string}`
    };
    const team = await app.inject({
      method: "POST", url: "/api/teams", headers: authorization,
      payload: { name: "Operations" }
    });
    const teamId = team.json().team.teamId as string;
    const room = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/rooms`, headers: authorization,
      payload: { name: "alerts" }
    });
    const manual = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/manual-agents`,
      headers: authorization,
      payload: { name: "Operator", role: "On-call" }
    });
    const routed = await app.inject({
      method: "POST", url: `/api/rooms/${room.json().roomId as string}/messages`,
      headers: authorization,
      payload: {
        content: "Inspect the queue",
        mentionAgentId: manual.json().agent.agentId as string
      }
    });
    assert.equal(routed.json().runs[0].state, "queued");

    const metrics = await app.inject({ method: "GET", url: "/api/metrics" });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.headers["content-type"] ?? "", /text\/plain/u);
    assert.match(metrics.body, /^agentroom_up 1$/mu);
    assert.match(metrics.body, /^agentroom_bridge_connections 0$/mu);
    assert.match(metrics.body, /^agentroom_managed_agents 0$/mu);
    assert.match(metrics.body, /^agentroom_run_queue_depth 1$/mu);
    assert.match(metrics.body, /^agentroom_runs\{state="queued"\} 1$/mu);
    assert.match(
      metrics.body,
      /^agentroom_http_requests_total\{method="GET",status_class="4xx"\} 1$/mu
    );
    assert.doesNotMatch(metrics.body, /Inspect the queue|Bearer|session\.token/u);
  } finally {
    await app.close();
  }
});
