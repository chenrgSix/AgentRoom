import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createServerApp } from "../src/app.js";
import { openDatabase } from "../src/data/database.js";
import { hostedOpenAIResponsesEndpoint } from
  "../src/runtime/hosted-openai-responses-adapter.js";
import { AuthService, AuthorizationError } from
  "../src/security/auth-service.js";

const now = "2026-08-30T05:00:00.000Z";
const apiKey = "sk-hosted-api-test-ABCDEFGHIJKLMNOP";

function frame(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function providerResponse(text: string, responseId: string): Response {
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  };
  const source = [
    frame("response.created", {
      response: { id: responseId, status: "in_progress" }
    }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { type: "message", role: "assistant", content: [] }
    }),
    frame("response.content_part.added", {
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" }
    }),
    frame("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      delta: text
    }),
    frame("response.output_text.done", {
      output_index: 0,
      content_index: 0,
      text
    }),
    frame("response.content_part.done", {
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text }
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: message
    }),
    frame("response.completed", {
      response: {
        id: responseId,
        status: "completed",
        output: [message]
      }
    })
  ].join("");
  return new Response(source, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

async function bootstrap(app: FastifyInstance) {
  const bootstrapped = await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { displayName: "Alice" }
  });
  assert.equal(bootstrapped.statusCode, 200);
  const authorization = `Bearer ${bootstrapped.json().session.token as string}`;
  const teamResponse = await app.inject({
    method: "POST",
    url: "/api/teams",
    headers: { authorization },
    payload: { name: "Hosted Team" }
  });
  const teamId = teamResponse.json().team.teamId as string;
  const roomResponse = await app.inject({
    method: "POST",
    url: `/api/teams/${teamId}/rooms`,
    headers: { authorization },
    payload: { name: "general" }
  });
  return {
    authorization,
    roomId: roomResponse.json().roomId as string,
    teamId
  };
}

async function waitForTerminal(
  app: FastifyInstance,
  authorization: string,
  runId: string
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
      headers: { authorization }
    });
    const run = response.json();
    if ([
      "completed", "failed", "canceled", "expired", "outcome_unknown"
    ].includes(run.state)) return run;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Hosted Run did not reach a terminal state");
}

async function createHostedAgent(
  app: FastifyInstance,
  authorization: string,
  teamId: string,
  roomId: string,
  name: string,
  model = "gpt-5.4-mini"
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/teams/${teamId}/hosted-agents`,
    headers: { authorization },
    payload: {
      name,
      role: "Remote model",
      provider: "openai_responses",
      model,
      apiKey,
      roomIds: [roomId]
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { agentId: string; profileRevision: number };
}

async function waitForRoomRuns(
  app: FastifyInstance,
  authorization: string,
  roomId: string,
  count: number
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/runs`,
      headers: { authorization }
    });
    const runs = response.json() as Array<{ state: string }>;
    if (
      runs.length >= count &&
      runs.every((run) => [
        "completed", "failed", "canceled", "expired", "outcome_unknown"
      ].includes(run.state))
    ) {
      return runs;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Hosted Room Runs did not settle");
}

async function waitForDiscussion(
  app: FastifyInstance,
  authorization: string,
  discussionId: string
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/discussions/${discussionId}`,
      headers: { authorization }
    });
    const snapshot = response.json();
    if (["completed", "canceled", "terminated"].includes(
      snapshot.discussion.state
    )) return snapshot;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Hosted Discussion did not settle");
}

test("Owner configures a Hosted Agent after startup and Mention runs without Bridge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-api-"));
  const requests: Array<{ authorization: string | null; body: string }> = [];
  let providerCall = 0;
  const hostedFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(input, hostedOpenAIResponsesEndpoint);
    assert.equal(init?.redirect, "error");
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: String(init?.body)
    });
    providerCall += 1;
    return providerResponse(
      providerCall === 1 ? "READY" : "Hosted response",
      `resp_hosted_api_${providerCall}`
    );
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => now
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const arbitraryEndpoint = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/hosted-agents`,
      headers: { authorization },
      payload: {
        name: "Unsafe",
        role: "Remote",
        provider: "openai_responses",
        model: "gpt-5.4-mini",
        apiKey,
        roomIds: [roomId],
        baseUrl: "http://127.0.0.1:1"
      }
    });
    assert.equal(arbitraryEndpoint.statusCode, 400);
    assert.match(arbitraryEndpoint.body, /endpoints are fixed/u);
    assert.equal(providerCall, 0);

    const createdResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/hosted-agents`,
      headers: { authorization },
      payload: {
        name: "Central Writer",
        role: "Remote model",
        provider: "openai_responses",
        model: "gpt-5.4-mini",
        apiKey,
        roomIds: [roomId]
      }
    });
    assert.equal(createdResponse.statusCode, 200, createdResponse.body);
    assert.equal(createdResponse.headers["cache-control"], "no-store");
    const created = createdResponse.json();
    assert.equal(created.provider, "openai_responses");
    assert.equal(created.presence, "ready");
    assert.equal(created.credentialConfigured, true);
    assert.equal(JSON.stringify(created).includes(apiKey), false);

    const listed = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/hosted-agents`,
      headers: { authorization }
    });
    assert.equal(listed.headers["cache-control"], "no-store");
    assert.equal(listed.json().length, 1);
    assert.equal(listed.body.includes(apiKey), false);

    const sent = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: {
        content: "Please answer from the central model.",
        mentionAgentIds: [created.agentId]
      }
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const runId = sent.json().runs[0].runId as string;
    const terminal = await waitForTerminal(app, authorization, runId);
    assert.equal(terminal.state, "completed", JSON.stringify({
      terminal,
      events: (await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/events`,
        headers: { authorization }
      })).json()
    }));

    const events = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/events`,
      headers: { authorization }
    });
    assert.deepEqual(events.json().map((event: { event: { type: string } }) =>
      event.event.type
    ), ["status", "status", "output", "reply", "status"]);
    const messages = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/messages?tail=true`,
      headers: { authorization }
    });
    assert.equal(
      messages.json().items.some((message: { content: string }) =>
        message.content === "Hosted response"
      ),
      true
    );
    assert.equal(providerCall, 2);
    assert.equal(requests.every((request) =>
      request.authorization === `Bearer ${apiKey}`
    ), true);
    for (const request of requests) {
      const body = JSON.parse(request.body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.deepEqual(body.tools, []);
    }
    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.agentId}`,
      headers: { authorization },
      payload: { enabled: false }
    });
    assert.equal(disabled.json().presence, "offline");
    const reenabled = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.agentId}`,
      headers: { authorization },
      payload: { enabled: true }
    });
    assert.equal(reenabled.json().presence, "ready");
    assert.equal(providerCall, 2);
  } finally {
    await app.close();
  }
});

test("provider execution failure remains degraded until a successful check", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-health-"));
  let providerCall = 0;
  const hostedFetch = (async () => {
    providerCall += 1;
    if (providerCall === 2) {
      return new Response("provider-private-detail", { status: 503 });
    }
    return providerResponse("READY", `resp_hosted_health_${providerCall}`);
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => now
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const manual = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/manual-agents`,
      headers: { authorization },
      payload: { name: "Unaffected Manual Agent", role: "Reviewer" }
    });
    assert.equal(manual.statusCode, 200, manual.body);
    const manualAgentId = manual.json().agent.agentId as string;
    const agent = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Health Agent"
    );
    const sent = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: { content: "Observe provider failure.", mentionAgentIds: [agent.agentId] }
    });
    const runId = sent.json().runs[0].runId as string;
    assert.equal((await waitForTerminal(app, authorization, runId)).state, "failed");
    for (let read = 0; read < 2; read += 1) {
      const agents = await app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/agents`,
        headers: { authorization }
      });
      assert.equal(
        agents.json().find((candidate: { agentId: string }) =>
          candidate.agentId === agent.agentId
        ).presence,
        "degraded"
      );
      const manualProjection = agents.json().find(
        (candidate: { agentId: string }) => candidate.agentId === manualAgentId
      );
      assert.equal(manualProjection.integrationMode, "manual");
      assert.equal(manualProjection.presence, "manual");
    }
    const checked = await app.inject({
      method: "POST",
      url: `/api/hosted-agents/${agent.agentId}/tests`,
      headers: { authorization }
    });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.equal(checked.json().status, "succeeded");
    const restored = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/agents`,
      headers: { authorization }
    });
    assert.equal(
      restored.json().find((candidate: { agentId: string }) =>
        candidate.agentId === agent.agentId
      ).presence,
      "ready"
    );
    assert.equal(
      restored.json().find((candidate: { agentId: string }) =>
        candidate.agentId === manualAgentId
      ).integrationMode,
      "manual"
    );
    assert.equal(providerCall, 3);
  } finally {
    await app.close();
  }
});

test("Hosted reply handoff dispatches one bounded child without Bridge", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-handoff-"));
  let providerCall = 0;
  const hostedFetch = (async () => {
    providerCall += 1;
    const text = providerCall <= 2
      ? "READY"
      : providerCall === 3
        ? "Please @Central Reviewer review this response."
        : "Review completed.";
    return providerResponse(text, `resp_hosted_handoff_${providerCall}`);
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => now
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const source = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Writer", "gpt-handoff-source"
    );
    const target = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Reviewer", "gpt-handoff-target"
    );
    const sent = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: { content: "Draft an answer.", mentionAgentIds: [source.agentId] }
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const rootRunId = sent.json().runs[0].runId as string;
    const runs = await waitForRoomRuns(app, authorization, roomId, 2) as Array<{
      runId: string;
      parentRunId: string | null;
      targetAgentId: string;
      state: string;
    }>;
    const root = runs.find((run) => run.runId === rootRunId);
    const child = runs.find((run) => run.parentRunId === rootRunId);
    assert.equal(root?.state, "completed");
    assert.equal(child?.targetAgentId, target.agentId);
    assert.equal(child?.state, "completed");
    assert.equal(providerCall, 4);
  } finally {
    await app.close();
  }
});

test("Hosted Discussion completes its bounded wave and finalization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-discussion-"));
  let providerCall = 0;
  const hostedFetch = (async () => {
    providerCall += 1;
    return providerResponse(
      providerCall <= 2 ? "READY" : "Shared discussion conclusion.",
      `resp_hosted_discussion_${providerCall}`
    );
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => now
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const first = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Analyst"
    );
    const second = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Reviewer"
    );
    const created = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/discussions`,
      headers: { authorization },
      payload: {
        goal: "Reach one bounded conclusion.",
        participantAgentIds: [first.agentId, second.agentId],
        outputMode: "summary",
        policy: {
          initialLeaseTurns: 2,
          automaticMaxTurns: 2,
          hardMaxTurns: 4,
          maxDurationSeconds: 30,
          waveTimeoutSeconds: 30,
          plateauWindow: 1,
          minimumCompletionConfidence: 0.8,
          finalizationReserveTurns: 1,
          requireReviewer: false,
          allowAutomaticFinish: true
        }
      }
    });
    assert.equal(created.statusCode, 200, created.body);
    const discussionId = created.json().discussion.discussionId as string;
    const completed = await waitForDiscussion(
      app, authorization, discussionId
    );
    assert.equal(completed.discussion.state, "completed");
    assert.equal(completed.turns.length, 5);
    assert.equal(
      completed.turns.every((turn: { runId: string | null; state: string }) =>
        turn.runId !== null && turn.state === "completed"
      ),
      true
    );
    assert.deepEqual(
      new Set(completed.turns.map((turn: { speakerAgentId: string }) =>
        turn.speakerAgentId
      )),
      new Set([first.agentId, second.agentId])
    );
    assert.equal(providerCall, 7);
  } finally {
    await app.close();
  }
});

test("Hosted cancellation after provider dispatch closes outcome as unknown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-cancel-"));
  let providerCall = 0;
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    executionStarted = resolve;
  });
  let abortObserved!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abortObserved = resolve;
  });
  const hostedFetch = (async (_input, init) => {
    providerCall += 1;
    if (providerCall === 1) {
      return providerResponse("READY", "resp_hosted_cancel_probe");
    }
    executionStarted();
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => {
        abortObserved();
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (init?.signal?.aborted) rejectAbort();
      else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => now
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const agent = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Slow Agent"
    );
    const sent = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: { content: "Wait for cancellation.", mentionAgentIds: [agent.agentId] }
    });
    const runId = sent.json().runs[0].runId as string;
    await started;
    const canceled = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: { authorization },
      payload: { reason: "Stop the remote request" }
    });
    assert.equal(canceled.statusCode, 200, canceled.body);
    assert.equal(canceled.json().state, "outcome_unknown");
    await aborted;
    assert.equal((await waitForTerminal(app, authorization, runId)).state,
      "outcome_unknown");
    const replay = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: { authorization },
      payload: { reason: "Do not retry" }
    });
    assert.equal(replay.json().state, "outcome_unknown");
    assert.equal(providerCall, 2);
  } finally {
    await app.close();
  }
});

test("queued Hosted work expires behind per-Agent concurrency without HTTPS", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-expiry-"));
  let currentNow = now;
  let providerCall = 0;
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    executionStarted = resolve;
  });
  let releaseExecution!: (response: Response) => void;
  const hostedFetch = (async () => {
    providerCall += 1;
    if (providerCall === 1) {
      return providerResponse("READY", "resp_hosted_expiry_probe");
    }
    if (providerCall > 2) {
      throw new Error("Expired queued Hosted Run opened HTTPS");
    }
    executionStarted();
    return new Promise<Response>((resolve) => {
      releaseExecution = resolve;
    });
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => currentNow
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const agent = await createHostedAgent(
      app, authorization, teamId, roomId, "Central Serial Agent"
    );
    const first = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: { content: "First request.", mentionAgentIds: [agent.agentId] }
    });
    const firstRunId = first.json().runs[0].runId as string;
    await started;
    const second = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: { content: "Second request.", mentionAgentIds: [agent.agentId] }
    });
    const secondRunId = second.json().runs[0].runId as string;
    currentNow = "2026-08-30T05:21:00.000Z";
    releaseExecution(providerResponse(
      "First completed.", "resp_hosted_expiry_execution"
    ));
    assert.equal((await waitForTerminal(app, authorization, firstRunId)).state,
      "completed");
    assert.equal((await waitForTerminal(app, authorization, secondRunId)).state,
      "expired");
    assert.equal(providerCall, 2);
  } finally {
    await app.close();
  }
});

test("Hosted authorization fences reject cross-Team, cross-Room, stale, and active mutations", async () => {
  const directory = await mkdtemp(path.join(
    os.tmpdir(),
    "convene-wire-hosted-fences-"
  ));
  let providerCall = 0;
  let probeCall = 0;
  let executionCall = 0;
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    executionStarted = resolve;
  });
  let abortObserved!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abortObserved = resolve;
  });
  const hostedFetch = (async (_input, init) => {
    providerCall += 1;
    const body = JSON.parse(String(init?.body)) as { input?: unknown };
    if (JSON.stringify(body.input).includes("single word READY")) {
      probeCall += 1;
      return providerResponse("READY", `resp_hosted_fence_probe_${probeCall}`);
    }
    executionCall += 1;
    if (executionCall > 1) {
      throw new Error("Rejected Hosted mutation opened provider HTTPS");
    }
    executionStarted();
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => {
        abortObserved();
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (init?.signal?.aborted) rejectAbort();
      else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  }) as typeof fetch;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    hostedFetch,
    clock: () => now,
    logger: false
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const foreignTeam = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Foreign Hosted Team" }
    });
    assert.equal(foreignTeam.statusCode, 200, foreignTeam.body);
    const foreignTeamId = foreignTeam.json().team.teamId as string;
    const foreignRoom = await app.inject({
      method: "POST",
      url: `/api/teams/${foreignTeamId}/rooms`,
      headers: { authorization },
      payload: { name: "foreign" }
    });
    assert.equal(foreignRoom.statusCode, 200, foreignRoom.body);
    const foreignRoomId = foreignRoom.json().roomId as string;

    const crossTeam = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/hosted-agents`,
      headers: { authorization },
      payload: {
        name: "Cross Team Hosted",
        role: "Remote model",
        provider: "openai_responses",
        model: "gpt-5.4-mini",
        apiKey,
        roomIds: [foreignRoomId]
      }
    });
    assert.equal(crossTeam.statusCode, 403, crossTeam.body);
    assert.equal(crossTeam.json().error.code, "FORBIDDEN");
    assert.equal(providerCall, 0);

    const hosted = await createHostedAgent(
      app,
      authorization,
      teamId,
      roomId,
      "Central Scoped Agent"
    );
    assert.equal(providerCall, 1);
    assert.equal(probeCall, 1);
    const privateRoom = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization },
      payload: { name: "private" }
    });
    assert.equal(privateRoom.statusCode, 200, privateRoom.body);
    const privateRoomId = privateRoom.json().roomId as string;
    const crossRoom = await app.inject({
      method: "POST",
      url: `/api/rooms/${privateRoomId}/messages`,
      headers: { authorization },
      payload: {
        content: "Do not route outside the explicit Room.",
        mentionAgentIds: [hosted.agentId]
      }
    });
    assert.equal(crossRoom.statusCode, 400, crossRoom.body);
    assert.match(crossRoom.json().error.message, /Mention target is unavailable/u);
    assert.equal(providerCall, 1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/hosted-agents/${hosted.agentId}/profile`,
      headers: { authorization },
      payload: {
        expectedProfileRevision: hosted.profileRevision,
        model: "gpt-5.4"
      }
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().profileRevision, 2);
    assert.equal(providerCall, 2);
    assert.equal(probeCall, 2);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/hosted-agents/${hosted.agentId}/profile`,
      headers: { authorization },
      payload: {
        expectedProfileRevision: hosted.profileRevision,
        model: "gpt-5.4-mini"
      }
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "CONFLICT");
    assert.match(stale.json().error.message, /changed; reload and retry/u);
    assert.equal(providerCall, 3);
    const afterStale = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/hosted-agents`,
      headers: { authorization }
    });
    assert.equal(afterStale.statusCode, 200, afterStale.body);
    assert.equal(afterStale.json()[0].profileRevision, 2);
    assert.equal(afterStale.json()[0].model, "gpt-5.4");
    assert.equal(executionCall, 0);

    const sent = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: {
        content: "Hold this Run open while mutations are attempted.",
        mentionAgentIds: [hosted.agentId]
      }
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const runId = sent.json().runs[0].runId as string;
    await started;
    assert.equal(executionCall, 1);
    const providerCallsAtDispatch = providerCall;

    const activeProfile = await app.inject({
      method: "PATCH",
      url: `/api/hosted-agents/${hosted.agentId}/profile`,
      headers: { authorization },
      payload: {
        expectedProfileRevision: 2,
        model: "gpt-5.4-mini"
      }
    });
    assert.equal(activeProfile.statusCode, 409, activeProfile.body);
    assert.match(activeProfile.json().error.message, /locked while work is active/u);
    const activeDisable = await app.inject({
      method: "PATCH",
      url: `/api/agents/${hosted.agentId}`,
      headers: { authorization },
      payload: { enabled: false }
    });
    assert.equal(activeDisable.statusCode, 400, activeDisable.body);
    assert.match(activeDisable.json().error.message, /cannot be disabled while/u);
    assert.equal(providerCall, providerCallsAtDispatch);

    const canceled = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: { authorization },
      payload: { reason: "Close the active-work fence test" }
    });
    assert.equal(canceled.statusCode, 200, canceled.body);
    assert.equal(canceled.json().state, "outcome_unknown");
    await aborted;
  } finally {
    await app.close();
  }
});

test("Hosted provider credentials grant no Result, Task, Member, Device, or MCP authority", async () => {
  const directory = await mkdtemp(path.join(
    os.tmpdir(),
    "convene-wire-hosted-authority-"
  ));
  const databasePath = path.join(directory, "server.sqlite");
  const hostedFetch = (async () =>
    providerResponse("READY", "resp_hosted_authority_probe")) as typeof fetch;
  const app = await createServerApp({
    databasePath,
    hostedFetch,
    clock: () => now,
    logger: false
  });
  await app.ready();
  try {
    const { authorization, roomId, teamId } = await bootstrap(app);
    const hosted = await createHostedAgent(
      app,
      authorization,
      teamId,
      roomId,
      "Central Authority-Limited Agent"
    );
    const configurations = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/hosted-agents`,
      headers: { authorization }
    });
    const configuration = configurations.json()[0] as Record<string, unknown>;
    assert.equal("credential" in configuration, false);
    assert.equal("token" in configuration, false);
    assert.equal("apiKey" in configuration, false);
    assert.equal(configurations.body.includes(apiKey), false);

    const tasks = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization }
    });
    assert.equal(tasks.statusCode, 200, tasks.body);
    const task = tasks.json()[0] as {
      taskId: string;
      definitionRevision: number;
      criteriaRevision: number;
      taskRevision: number;
    };
    const hostedAuthorization = `Bearer ${apiKey}`;
    const resultProposal = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId}/results`,
      headers: { authorization: hostedAuthorization },
      payload: {
        operationId: "op_hosted_result_denied_0001",
        taskId: task.taskId,
        definitionRevision: task.definitionRevision,
        criteriaRevision: task.criteriaRevision,
        proposedAtTaskRevision: task.taskRevision,
        supersedesResultId: null,
        outcome: "informational",
        summary: "A Hosted provider credential must not propose this Result.",
        risks: [],
        openQuestions: [],
        nextActions: [],
        sources: [],
        criterionClaims: []
      }
    });
    assert.equal(resultProposal.statusCode, 401, resultProposal.body);
    const ambiguityAcknowledgement = await app.inject({
      method: "POST",
      url: "/api/runs/run_hosted_authority_denied/ambiguity-acknowledgement",
      headers: { authorization: hostedAuthorization },
      payload: {
        operationId: "op_hosted_ambiguity_denied_0001",
        expectedTaskRevision: task.taskRevision,
        reason: "A Hosted provider credential must not acknowledge ambiguity."
      }
    });
    assert.equal(
      ambiguityAcknowledgement.statusCode,
      401,
      ambiguityAcknowledgement.body
    );
    const taskCompletion = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.taskId}`,
      headers: { authorization: hostedAuthorization },
      payload: { state: "completed" }
    });
    assert.equal(taskCompletion.statusCode, 401, taskCompletion.body);
    const memberCommand = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/members`,
      headers: { authorization: hostedAuthorization },
      payload: {
        userId: "user_hosted_authority_denied",
        displayName: "Denied Hosted Member"
      }
    });
    assert.equal(memberCommand.statusCode, 401, memberCommand.body);
    const deviceCommand = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/devices`,
      headers: { authorization: hostedAuthorization }
    });
    assert.equal(deviceCommand.statusCode, 401, deviceCommand.body);
    const mcpCommand = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: hostedAuthorization
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "hosted-denied", version: "1" }
        }
      }
    });
    assert.equal(mcpCommand.statusCode, 401, mcpCommand.body);

    const database = openDatabase(databasePath);
    try {
      const agent = database.prepare(`
        SELECT integration_mode, device_id FROM agents WHERE agent_id = ?
      `).get(hosted.agentId) as {
        integration_mode: string;
        device_id: string | null;
      };
      assert.deepEqual(agent, {
        integration_mode: "hosted",
        device_id: null
      });
      assert.equal((database.prepare(`
        SELECT count(*) AS count FROM mcp_credentials WHERE agent_id = ?
      `).get(hosted.agentId) as { count: number }).count, 0);
      const auth = new AuthService(database);
      const owner = auth.authenticateWebSession(
        authorization.slice("Bearer ".length),
        now
      );
      assert.throws(
        () => auth.issueMcpCredential(owner, hosted.agentId, now),
        (error: unknown) => error instanceof AuthorizationError &&
          error.code === "FORBIDDEN" &&
          /Manual Agent ownership denied/u.test(error.message)
      );
      assert.throws(
        () => auth.issueDeviceCredential(hosted.agentId, now),
        (error: unknown) => error instanceof AuthorizationError &&
          error.code === "FORBIDDEN" &&
          /Device is not active/u.test(error.message)
      );
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});
