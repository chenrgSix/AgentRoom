import assert from "node:assert/strict";
import test from "node:test";

import {
  HostedSseParserError,
  parseHostedServerSentEvents
} from "../src/runtime/hosted-sse-parser.js";

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  limits: { maxEventBytes?: number; maxStreamBytes?: number } = {}
) {
  return await Array.fromAsync(parseHostedServerSentEvents(stream, limits));
}

async function parserFailure(
  stream: ReadableStream<Uint8Array>,
  limits: { maxEventBytes?: number; maxStreamBytes?: number } = {}
): Promise<HostedSseParserError> {
  let failure: unknown;
  try {
    await collect(stream, limits);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof HostedSseParserError);
  return failure;
}

test("Hosted SSE parser preserves split UTF-8, CRLF, and multiline data", async () => {
  const source = [
    ": provider heartbeat\r\n",
    "event: response.output_text.delta\r\n",
    "data: first 你\r\n",
    "data: second\r\n",
    "ignored: value\r\n",
    "\r\n",
    "data: final\n\n"
  ].join("");
  const encoded = new TextEncoder().encode(source);
  const chunks = Array.from(encoded, (byte) => Uint8Array.of(byte));

  assert.deepEqual(await collect(byteStream(chunks)), [
    {
      event: "response.output_text.delta",
      data: "first 你\nsecond"
    },
    { data: "final" }
  ]);
});

test("Hosted SSE parser rejects invalid UTF-8 and unterminated events", async () => {
  const invalidUtf8 = Uint8Array.from([
    ...new TextEncoder().encode("data: "),
    0xc3,
    0x28,
    0x0a,
    0x0a
  ]);
  assert.equal(
    (await parserFailure(byteStream([invalidUtf8]))).code,
    "HOSTED_SSE_INVALID_UTF8"
  );

  assert.equal(
    (await parserFailure(byteStream([
      new TextEncoder().encode("data: incomplete")
    ]))).code,
    "HOSTED_SSE_INCOMPLETE_EVENT"
  );
});

test("Hosted SSE parser enforces independent event and stream byte limits", async () => {
  assert.equal(
    (await parserFailure(
      byteStream([new TextEncoder().encode("data: 123456789\n\n")]),
      { maxEventBytes: 8, maxStreamBytes: 100 }
    )).code,
    "HOSTED_SSE_EVENT_TOO_LARGE"
  );

  assert.equal(
    (await parserFailure(
      byteStream([
        new TextEncoder().encode("data: a\n\n"),
        new TextEncoder().encode("data: b\n\n")
      ]),
      { maxEventBytes: 12, maxStreamBytes: 15 }
    )).code,
    "HOSTED_SSE_STREAM_TOO_LARGE"
  );
});
