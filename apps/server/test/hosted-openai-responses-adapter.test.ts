import assert from "node:assert/strict";
import test from "node:test";

import {
  HostedOpenAIResponsesAdapter,
  HostedOpenAIResponsesError,
  HostedOpenAIResponsesProbe,
  hostedOpenAIResponsesEndpoint
} from "../src/runtime/hosted-openai-responses-adapter.js";
import type {
  RuntimeEvent,
  RuntimeRequest
} from "../src/runtime/runtime-adapter.js";

const apiKey = "sk-testcredentialABCDEFGHIJKLMNOP";
const providerResponseId = "resp_hosted_test_123";

function runtimeRequest(): RuntimeRequest {
  return {
    runId: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    taskId: "task_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    instruction: "Summarize the bounded collaboration context.",
    contextCursor: 4,
    contextMessages: [{
      messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      sequence: 4,
      senderId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      content: "A previous message contained token=supersecretvalue."
    }]
  };
}

function frame(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function successfulFrames(): string[] {
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Hello, world." }]
  };
  return [
    frame("response.created", {
      response: { id: providerResponseId, status: "in_progress" }
    }),
    frame("response.in_progress", {
      response: { id: providerResponseId, status: "in_progress" }
    }),
    frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "reasoning",
        encrypted_content: "must-not-be-projected"
      }
    }),
    frame("response.reasoning_summary_text.delta", {
      output_index: 0,
      summary_index: 0,
      delta: "private chain of thought"
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "reasoning",
        encrypted_content: "must-not-be-projected"
      }
    }),
    frame("response.output_item.added", {
      output_index: 1,
      item: { type: "message", role: "assistant", content: [] }
    }),
    frame("response.content_part.added", {
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "" }
    }),
    frame("response.output_text.delta", {
      output_index: 1,
      content_index: 0,
      delta: "Hello, "
    }),
    frame("response.output_text.delta", {
      output_index: 1,
      content_index: 0,
      delta: "world."
    }),
    frame("response.output_text.done", {
      output_index: 1,
      content_index: 0,
      text: "Hello, world."
    }),
    frame("response.content_part.done", {
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "Hello, world." }
    }),
    frame("response.output_item.done", {
      output_index: 1,
      item: message
    }),
    frame("response.completed", {
      response: {
        id: providerResponseId,
        status: "completed",
        output: [
          {
            type: "reasoning",
            encrypted_content: "must-not-be-projected"
          },
          message
        ]
      }
    })
  ];
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

function sseResponse(frames: string[], contentType = "text/event-stream") {
  const encoded = new TextEncoder().encode(frames.join(""));
  const chunks = Array.from(encoded, (byte) => Uint8Array.of(byte));
  return new Response(byteStream(chunks), {
    status: 200,
    headers: { "content-type": contentType }
  });
}

function fetchReturning(
  response: Response,
  observe?: (input: URL | RequestInfo, init?: RequestInit) => void
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    observe?.(input, init);
    return response;
  }) as typeof fetch;
}

async function collect(adapter: HostedOpenAIResponsesAdapter, request: RuntimeRequest) {
  return await Array.fromAsync(adapter.execute(request));
}

async function adapterFailure(
  adapter: HostedOpenAIResponsesAdapter,
  request: RuntimeRequest
): Promise<HostedOpenAIResponsesError> {
  let failure: unknown;
  try {
    await collect(adapter, request);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof HostedOpenAIResponsesError);
  return failure;
}

test("Hosted OpenAI adapter sends one fixed text-only Responses request", async () => {
  const request = runtimeRequest();
  let observedInput: URL | RequestInfo | undefined;
  let observedInit: RequestInit | undefined;
  const adapter = HostedOpenAIResponsesAdapter.prepare({
    profile: {
      model: "gpt-5.4-mini",
      instructions: "Return concise plain text.",
      maxOutputTokens: 512
    },
    apiKey,
    request,
    firstSequence: 7,
    fetch: fetchReturning(sseResponse(successfulFrames()), (input, init) => {
      observedInput = input;
      observedInit = init;
    })
  });

  const events = await collect(adapter, request);
  assert.deepEqual(events, [
    { type: "status", sequence: 7, status: "working" },
    { type: "output", sequence: 8, content: "Hello, " },
    { type: "output", sequence: 9, content: "world." },
    { type: "reply", sequence: 10, content: "Hello, world." },
    { type: "status", sequence: 11, status: "completed" }
  ] satisfies RuntimeEvent[]);

  assert.equal(observedInput, hostedOpenAIResponsesEndpoint);
  assert.equal(observedInit?.method, "POST");
  assert.equal(observedInit?.redirect, "error");
  const headers = new Headers(observedInit?.headers);
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  assert.equal(headers.get("content-type"), "application/json");

  const rawRequestBody = String(observedInit?.body);
  const body = JSON.parse(rawRequestBody) as Record<string, unknown>;
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.background, false);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, "none");
  assert.equal(body.max_output_tokens, 512);
  assert.match(String(body.instructions), /no filesystem, shell, browser/iu);
  assert.doesNotMatch(rawRequestBody, /supersecretvalue/u);
  assert.match(rawRequestBody, /\[REDACTED\]/u);

  const publicProjection = JSON.stringify(adapter);
  assert.doesNotMatch(publicProjection, new RegExp(apiKey, "u"));
  assert.doesNotMatch(publicProjection, /authorization|Current instruction/iu);
  assert.doesNotMatch(JSON.stringify(events), /chain of thought|must-not-be-projected/iu);
  assert.match(adapter.requestSha256, /^[a-f0-9]{64}$/u);
});

test("Hosted OpenAI adapter rejects malformed, incomplete, and overflowing streams", async (t) => {
  const request = runtimeRequest();
  const cases: Array<{
    name: string;
    response: Response;
    code: string;
    disposition: string;
  }> = [
    {
      name: "malformed JSON",
      response: sseResponse([
        "event: response.created\ndata: not-json\n\n"
      ]),
      code: "HOSTED_PROVIDER_STREAM_INVALID",
      disposition: "outcome_unknown"
    },
    {
      name: "missing terminal",
      response: sseResponse([frame("response.created", {
        response: { id: providerResponseId, status: "in_progress" }
      })]),
      code: "HOSTED_PROVIDER_STREAM_ENDED_EARLY",
      disposition: "outcome_unknown"
    },
    {
      name: "event overflow",
      response: sseResponse([frame("response.created", {
        response: { id: providerResponseId, status: "in_progress" }
      })]),
      code: "HOSTED_PROVIDER_STREAM_OVERFLOW",
      disposition: "outcome_unknown"
    }
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const adapter = HostedOpenAIResponsesAdapter.prepare({
        profile: { model: "gpt-5.4-mini" },
        apiKey,
        request,
        fetch: fetchReturning(candidate.response),
        ...(candidate.name === "event overflow"
          ? { sseLimits: { maxEventBytes: 40, maxStreamBytes: 1_000 } }
          : {})
      });
      const failure = await adapterFailure(adapter, request);
      assert.equal(failure.code, candidate.code);
      assert.equal(failure.disposition, candidate.disposition);
      assert.doesNotMatch(failure.message, /not-json|resp_hosted/u);
    });
  }
});

test("Hosted OpenAI adapter rejects tool output and invalid terminal ordering", async (t) => {
  const request = runtimeRequest();
  const created = frame("response.created", {
    response: { id: providerResponseId, status: "in_progress" }
  });
  const tool = frame("response.output_item.added", {
    output_index: 0,
    item: { type: "function_call", name: "shell", arguments: "{}" }
  });
  const terminal = successfulFrames().at(-1)!;

  await t.test("tool output", async () => {
    const adapter = HostedOpenAIResponsesAdapter.prepare({
      profile: { model: "gpt-5.4-mini" },
      apiKey,
      request,
      fetch: fetchReturning(sseResponse([created, tool]))
    });
    const failure = await adapterFailure(adapter, request);
    assert.equal(failure.code, "HOSTED_PROVIDER_TOOL_OUTPUT_REJECTED");
    assert.equal(failure.disposition, "failed");
  });

  for (const [name, frames] of [
    ["duplicate terminal", [...successfulFrames(), terminal]],
    ["event after terminal", [
      ...successfulFrames(),
      frame("response.in_progress", {
        response: { id: providerResponseId, status: "in_progress" }
      })
    ]]
  ] as const) {
    await t.test(name, async () => {
      const adapter = HostedOpenAIResponsesAdapter.prepare({
        profile: { model: "gpt-5.4-mini" },
        apiKey,
        request,
        fetch: fetchReturning(sseResponse([...frames]))
      });
      const failure = await adapterFailure(adapter, request);
      assert.equal(failure.code, "HOSTED_PROVIDER_PROTOCOL_INVALID");
      assert.equal(failure.disposition, "failed");
    });
  }
});

test("Hosted OpenAI adapter classifies HTTP, transport, content type, and abort safely", async (t) => {
  const request = runtimeRequest();

  await t.test("HTTP authentication failure", async () => {
    const adapter = HostedOpenAIResponsesAdapter.prepare({
      profile: { model: "gpt-5.4-mini" },
      apiKey,
      request,
      fetch: fetchReturning(new Response(`raw ${apiKey}`, { status: 401 }))
    });
    assert.deepEqual(await collect(adapter, request), [{
      type: "status",
      sequence: 1,
      status: "failed",
      error: {
        code: "HOSTED_PROVIDER_AUTHENTICATION_FAILED",
        message: "Hosted provider rejected its credential.",
        retryable: false
      }
    }]);
  });

  await t.test("invalid content type", async () => {
    const adapter = HostedOpenAIResponsesAdapter.prepare({
      profile: { model: "gpt-5.4-mini" },
      apiKey,
      request,
      fetch: fetchReturning(new Response(`raw ${apiKey}`, {
        headers: { "content-type": "application/json" }
      }))
    });
    const failure = await adapterFailure(adapter, request);
    assert.equal(failure.code, "HOSTED_PROVIDER_CONTENT_TYPE_INVALID");
    assert.equal(failure.disposition, "outcome_unknown");
    assert.doesNotMatch(failure.message, new RegExp(apiKey, "u"));
  });

  await t.test("transport exception", async () => {
    const adapter = HostedOpenAIResponsesAdapter.prepare({
      profile: { model: "gpt-5.4-mini" },
      apiKey,
      request,
      fetch: (async () => {
        throw new Error(`transport leaked ${apiKey}`);
      }) as typeof fetch
    });
    const failure = await adapterFailure(adapter, request);
    assert.equal(failure.code, "HOSTED_PROVIDER_TRANSPORT_UNKNOWN");
    assert.equal(failure.disposition, "outcome_unknown");
    assert.doesNotMatch(failure.message, new RegExp(apiKey, "u"));
  });

  await t.test("local abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = HostedOpenAIResponsesAdapter.prepare({
      profile: { model: "gpt-5.4-mini" },
      apiKey,
      request,
      signal: controller.signal,
      fetch: (async () => {
        throw new DOMException("raw abort detail", "AbortError");
      }) as typeof fetch
    });
    assert.deepEqual(await collect(adapter, request), [{
      type: "status",
      sequence: 1,
      status: "canceled",
      error: {
        code: "HOSTED_REQUEST_ABORTED",
        message: "Hosted provider request was canceled locally.",
        retryable: false
      }
    }]);
  });

  await t.test("abort while consuming SSE", async () => {
    const abort = new AbortController();
    const created = new TextEncoder().encode(frame("response.created", {
      response: { id: providerResponseId, status: "in_progress" }
    }));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(created);
          return;
        }
        abort.abort();
        controller.error(new DOMException("raw abort detail", "AbortError"));
      }
    });
    let observedSignal: AbortSignal | null | undefined;
    const adapter = HostedOpenAIResponsesAdapter.prepare({
      profile: { model: "gpt-5.4-mini" },
      apiKey,
      request,
      signal: abort.signal,
      fetch: fetchReturning(new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8" }
      }), (_input, init) => {
        observedSignal = init?.signal;
      })
    });
    assert.deepEqual(await collect(adapter, request), [
      { type: "status", sequence: 1, status: "working" },
      {
        type: "status",
        sequence: 2,
        status: "canceled",
        error: {
          code: "HOSTED_REQUEST_ABORTED",
          message: "Hosted provider request was canceled locally.",
          retryable: false
        }
      }
    ]);
    assert.equal(observedSignal, abort.signal);
  });
});

test("Hosted OpenAI adapter binds execution to the prepared invocation", async () => {
  const request = runtimeRequest();
  let fetchCalls = 0;
  const adapter = HostedOpenAIResponsesAdapter.prepare({
    profile: { model: "gpt-5.4-mini" },
    apiKey,
    request,
    fetch: (async () => {
      fetchCalls += 1;
      return sseResponse(successfulFrames());
    }) as typeof fetch
  });
  const mismatched = { ...request, contextCursor: request.contextCursor + 1 };
  const failure = await adapterFailure(adapter, mismatched);
  assert.equal(failure.code, "HOSTED_REQUEST_MISMATCH");
  assert.equal(failure.disposition, "failed");
  assert.equal(fetchCalls, 0);
});

test("Hosted OpenAI credential validation is 16-512 UTF-8 bytes without whitespace or controls", () => {
  const request = runtimeRequest();
  const prepare = (credential: string) => HostedOpenAIResponsesAdapter.prepare({
    profile: { model: "gpt-5.4-mini" },
    apiKey: credential,
    request,
    fetch: fetchReturning(sseResponse(successfulFrames()))
  });

  assert.doesNotThrow(() => prepare("a".repeat(16)));
  assert.doesNotThrow(() => prepare("a".repeat(512)));
  for (const invalid of [
    "a".repeat(15),
    "a".repeat(513),
    `abcdefgh ijklmnop`,
    `abcdefgh\u0085ijklmnop`,
    `abcdefgh\u200Bijklmnop`
  ]) {
    assert.throws(
      () => prepare(invalid),
      (error: unknown) => error instanceof HostedOpenAIResponsesError &&
        error.code === "HOSTED_CONFIGURATION_INVALID"
    );
  }
});

test("Hosted OpenAI probe consumes the full stream and returns no provider content", async (t) => {
  await t.test("ready", async () => {
    let observedBody = "";
    const probe = new HostedOpenAIResponsesProbe(fetchReturning(
      sseResponse(successfulFrames()),
      (_input, init) => {
        observedBody = String(init?.body);
      }
    ));
    const result = await probe.test({
      provider: "openai_responses",
      model: "gpt-5.4-mini",
      apiKey
    });
    assert.deepEqual(result, { status: "ready" });
    assert.deepEqual(Object.keys(result), ["status"]);
    const body = JSON.parse(observedBody) as Record<string, unknown>;
    assert.equal(body.max_output_tokens, 16);
    assert.match(observedBody, /Reply with the single word READY\./u);
    assert.doesNotMatch(JSON.stringify(result), /Hello|chain of thought|READY/u);
  });

  await t.test("post-terminal protocol failure proves full consumption", async () => {
    const response = sseResponse([
      ...successfulFrames(),
      frame("response.in_progress", {
        response: { id: providerResponseId, status: "in_progress" }
      })
    ]);
    const result = await new HostedOpenAIResponsesProbe(fetchReturning(response)).test({
      provider: "openai_responses",
      model: "gpt-5.4-mini",
      apiKey
    });
    assert.deepEqual(result, {
      status: "failed",
      failureCode: "HOSTED_PROVIDER_PROTOCOL_INVALID"
    });
  });

  await t.test("failure is content-free", async () => {
    const result = await new HostedOpenAIResponsesProbe(fetchReturning(
      new Response(`raw provider detail ${apiKey}`, { status: 401 })
    )).test({
      provider: "openai_responses",
      model: "gpt-5.4-mini",
      apiKey
    });
    assert.deepEqual(result, {
      status: "failed",
      failureCode: "HOSTED_PROVIDER_AUTHENTICATION_FAILED"
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey, "u"));
  });
});
