import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { createServerApp } from "../../apps/server/src/app.js";
import { createTestResources } from "../../scripts/test/resources.mjs";
import { hostedOpenAIResponsesEndpoint } from
  "../../apps/server/src/runtime/hosted-openai-responses-adapter.js";

const now = "2026-08-30T08:00:00.000Z";
const apiKey = "hosted-e2e-fake-key-DO-NOT-USE-0123456789";
const outputCredential = "chunked-hosted-output-secret-0123456789";
const expectedReply = "Hosted streaming response; [REDACTED]";

interface ApiResponse<T> {
  body: string;
  headers: Headers;
  status: number;
  value: T;
}

interface HostedRequest {
  authorization: string | null;
  body: Record<string, unknown>;
  endpoint: string;
  redirect: RequestRedirect | undefined;
}

function capturingLogger(entries: string[]): FastifyBaseLogger {
  let logger: FastifyBaseLogger;
  const capture = (level: string) => (...values: unknown[]): void => {
    entries.push(`${level} ${values.map((value) => inspect(value, {
      depth: 6,
      breakLength: Infinity
    })).join(" ")}`);
  };
  logger = {
    level: "trace",
    fatal: capture("fatal"),
    error: capture("error"),
    warn: capture("warn"),
    info: capture("info"),
    debug: capture("debug"),
    trace: capture("trace"),
    silent: capture("silent"),
    child: (...values: unknown[]) => {
      capture("child")(...values);
      return logger;
    }
  } as unknown as FastifyBaseLogger;
  return logger;
}

function frame(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function providerResponse(deltas: string[], responseId: string): Response {
  const text = deltas.join("");
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
    ...deltas.map((delta) => frame("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      delta
    })),
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
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const end = Math.min(offset + 37, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
      if (offset === bytes.length) controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

async function requestJson<T>(
  baseUrl: string,
  transcript: string[],
  pathname: string,
  options: {
    body?: Record<string, unknown>;
    method?: string;
    token?: string;
  } = {}
): Promise<ApiResponse<T>> {
  const method = options.method ?? "GET";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(options.token
        ? { authorization: `Bearer ${options.token}` }
        : {}),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.text();
  transcript.push(JSON.stringify({
    method,
    pathname,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body
  }));
  let value: T;
  try {
    value = JSON.parse(body) as T;
  } catch {
    throw new Error(`Expected JSON from ${method} ${pathname}: ${body}`);
  }
  return { body, headers: response.headers, status: response.status, value };
}

async function waitForCompletedRun(
  baseUrl: string,
  transcript: string[],
  token: string,
  runId: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await requestJson<Record<string, unknown>>(
      baseUrl,
      transcript,
      `/api/runs/${runId}`,
      { token }
    );
    const state = response.value.state;
    if ([
      "completed", "failed", "canceled", "expired", "outcome_unknown"
    ].includes(String(state))) {
      return response.value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Hosted E2E Run did not reach a terminal state");
}

test("Central Hosted Agent completes a real-HTTP Mention without Bridge", {
  timeout: 15_000
}, async (t) => {
  const resources = await createTestResources(t, "convene-wire-central-hosted-e2e-");
  const directory = resources.directory;
  const apiTranscript: string[] = [];
  const logEntries: string[] = [];
  const hostedRequests: HostedRequest[] = [];
  const hostedFetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit
  ) => {
    hostedRequests.push({
      endpoint: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      redirect: init?.redirect
    });
    await Promise.resolve();
    return hostedRequests.length === 1
      ? providerResponse(["READY"], "resp_hosted_e2e_probe")
      : providerResponse(
          [
            "Hosted ", "streaming response; to", "ken=",
            outputCredential.slice(0, 12), outputCredential.slice(12)
          ],
          "resp_hosted_e2e_run"
        );
  }) as typeof fetch;
  let app: FastifyInstance | undefined;
  let appClosed = false;
  const closeApp = async () => {
    if (!app || appClosed) return;
    appClosed = true;
    await app.close();
  };
  resources.defer(closeApp);
  try {
    app = await createServerApp({
      databasePath: path.join(directory, "server.sqlite"),
      hostedFetch,
      clock: () => now,
      loggerInstance: capturingLogger(logEntries)
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Central did not bind a random local TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const initialHealth = await requestJson<{
      checks: { bridge: string; database: string };
      status: string;
    }>(baseUrl, apiTranscript, "/api/health");
    assert.equal(initialHealth.status, 200);
    assert.deepEqual(initialHealth.value, {
      status: "ready",
      checks: { database: "ready", bridge: "not_configured" }
    });
    assert.equal(hostedRequests.length, 0);

    const bootstrap = await requestJson<{
      session: { token: string };
    }>(baseUrl, apiTranscript, "/api/bootstrap", {
      method: "POST",
      body: { displayName: "Hosted E2E Owner" }
    });
    assert.equal(bootstrap.status, 200, bootstrap.body);
    const token = bootstrap.value.session.token;
    const team = await requestJson<{
      team: { teamId: string };
    }>(baseUrl, apiTranscript, "/api/teams", {
      method: "POST",
      token,
      body: { name: "Central Hosted E2E" }
    });
    assert.equal(team.status, 200, team.body);
    const teamId = team.value.team.teamId;
    const room = await requestJson<{
      roomId: string;
    }>(baseUrl, apiTranscript, `/api/teams/${teamId}/rooms`, {
      method: "POST",
      token,
      body: { name: "hosted-acceptance" }
    });
    assert.equal(room.status, 200, room.body);
    const roomId = room.value.roomId;

    const unconfigured = await requestJson<unknown[]>(
      baseUrl,
      apiTranscript,
      `/api/teams/${teamId}/hosted-agents`,
      { token }
    );
    assert.equal(unconfigured.status, 200, unconfigured.body);
    assert.deepEqual(unconfigured.value, []);
    assert.equal(hostedRequests.length, 0);

    const created = await requestJson<{
      agentId: string;
      credentialConfigured: boolean;
      presence: string;
      roomIds: string[];
    }>(baseUrl, apiTranscript, `/api/teams/${teamId}/hosted-agents`, {
      method: "POST",
      token,
      body: {
        name: "Central Hosted Writer",
        role: "Text-only response writer",
        provider: "openai_responses",
        model: "gpt-5.4-mini",
        apiKey,
        roomIds: [roomId]
      }
    });
    assert.equal(created.status, 200, created.body);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.deepEqual(created.value.roomIds, [roomId]);
    assert.equal(created.value.credentialConfigured, true);
    assert.equal(created.value.presence, "ready");
    assert.equal(hostedRequests.length, 1);

    const sent = await requestJson<{
      runs: Array<{ runId: string }>;
    }>(baseUrl, apiTranscript, `/api/rooms/${roomId}/messages`, {
      method: "POST",
      token,
      body: {
        content: "Answer through the Central Hosted Agent.",
        mentionAgentIds: [created.value.agentId]
      }
    });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.value.runs.length, 1);
    const runId = sent.value.runs[0]!.runId;
    const terminal = await waitForCompletedRun(
      baseUrl,
      apiTranscript,
      token,
      runId
    );
    assert.equal(terminal.state, "completed", JSON.stringify(terminal));

    const events = await requestJson<Array<{
      event: { content?: string; sequence: number; status?: string; type: string };
    }>>(baseUrl, apiTranscript, `/api/runs/${runId}/events`, { token });
    assert.equal(events.status, 200, events.body);
    const eventTypes = events.value.map(({ event }) => event.type);
    assert.deepEqual(eventTypes.filter((type, index) =>
      type !== "output" || eventTypes[index - 1] !== "output"
    ), ["status", "status", "output", "reply", "status"]);
    assert.deepEqual(
      events.value.map(({ event }) => event.sequence),
      events.value.map((_event, index) => index + 1)
    );
    const output = events.value.filter(({ event }) => event.type === "output");
    assert.ok(output.length >= 2);
    assert.equal(output.map(({ event }) => event.content).join(""), expectedReply);
    assert.equal(events.value.at(-2)?.event.content, expectedReply);
    assert.equal(events.value.at(-1)?.event.status, "completed");

    const messages = await requestJson<{
      items: Array<{ content: string; senderId: string }>;
    }>(baseUrl, apiTranscript, `/api/rooms/${roomId}/messages?tail=true`, {
      token
    });
    assert.equal(messages.status, 200, messages.body);
    assert.equal(messages.value.items.some(({ content, senderId }) =>
      content === expectedReply &&
      senderId === created.value.agentId
    ), true);

    const finalHealth = await requestJson<{
      checks: { bridge: string; database: string };
      status: string;
    }>(baseUrl, apiTranscript, "/api/health");
    assert.deepEqual(finalHealth.value, {
      status: "ready",
      checks: { database: "ready", bridge: "not_configured" }
    });
    const metricsResponse = await fetch(`${baseUrl}/api/metrics`);
    const metrics = await metricsResponse.text();
    apiTranscript.push(JSON.stringify({
      method: "GET",
      pathname: "/api/metrics",
      status: metricsResponse.status,
      headers: Object.fromEntries(metricsResponse.headers),
      body: metrics
    }));
    assert.equal(metricsResponse.status, 200);
    assert.match(
      metricsResponse.headers.get("content-type") ?? "",
      /^text\/plain/u
    );
    assert.equal(metrics.includes(apiKey), false);

    assert.equal(hostedRequests.length, 2);
    for (const request of hostedRequests) {
      assert.equal(request.endpoint, hostedOpenAIResponsesEndpoint);
      assert.equal(request.redirect, "error");
      assert.equal(request.authorization, `Bearer ${apiKey}`);
      assert.equal(request.body.store, false);
      assert.equal(request.body.stream, true);
      assert.equal(request.body.background, false);
      assert.deepEqual(request.body.tools, []);
      assert.equal(request.body.tool_choice, "none");
      assert.equal(JSON.stringify(request.body).includes(apiKey), false);
    }
    assert.equal(apiTranscript.join("\n").includes(apiKey), false);
    assert.equal(logEntries.join("\n").includes(apiKey), false);
    for (const sensitive of [outputCredential, outputCredential.slice(0, 12)]) {
      assert.equal(apiTranscript.join("\n").includes(sensitive), false);
      assert.equal(logEntries.join("\n").includes(sensitive), false);
    }
  } finally {
    await closeApp();
  }
});
