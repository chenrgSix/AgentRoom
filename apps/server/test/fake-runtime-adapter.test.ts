import assert from "node:assert/strict";
import test from "node:test";

import { FakeRuntimeAdapter } from "../src/runtime/fake-runtime-adapter.js";

test("Fake Runtime deterministically streams a success script", async () => {
  const adapter = new FakeRuntimeAdapter();
  adapter.enqueue({
    expectedInstruction: "Review the API.",
    events: [
      { type: "status", sequence: 1, status: "working" },
      { type: "output", sequence: 2, content: "The API is " },
      { type: "reply", sequence: 3, content: "The API is consistent." },
      { type: "status", sequence: 4, status: "completed" }
    ]
  });
  const request = {
    runId: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    instruction: "Review the API.",
    contextMessages: []
  };
  const events = [];
  for await (const event of adapter.execute(request)) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "status", sequence: 1, status: "working" },
    { type: "output", sequence: 2, content: "The API is " },
    { type: "reply", sequence: 3, content: "The API is consistent." },
    { type: "status", sequence: 4, status: "completed" }
  ]);
  assert.deepEqual(adapter.receivedRequests(), [request]);
});

test("Fake Runtime rejects invalid scripts and exposes failure events", async () => {
  const adapter = new FakeRuntimeAdapter();
  assert.throws(() => adapter.enqueue({
    events: [{ type: "status", sequence: 1, status: "working" }]
  }), /terminal status/);
  adapter.enqueue({
    events: [
      { type: "status", sequence: 1, status: "working" },
      {
        type: "status",
        sequence: 2,
        status: "failed",
        error: { code: "FAKE_FAILURE", message: "Scripted failure", retryable: false }
      }
    ]
  });
  const events = [];
  for await (const event of adapter.execute({
    runId: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    instruction: "Fail deterministically.",
    contextMessages: []
  })) {
    events.push(event);
  }
  assert.equal(events.at(-1)?.type, "status");
  assert.equal(events.at(-1)?.sequence, 2);
});
