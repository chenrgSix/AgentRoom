import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeBridgeMessage,
  validateBridgeMessage
} from "../generated/runtime/bridge-validator.mjs";

const bridgeSchemaId =
  "https://agentroom.dev/schemas/bridge/messages.schema.json";

function runReply(content = "Completed.") {
  return {
    protocolVersion: "1.0",
    messageId: "msg_runtime_validator_12345678",
    timestamp: "2026-08-29T00:00:00Z",
    type: "run.reply",
    payload: {
      runId: "run_runtime_validator_12345678",
      traceId: "trace_runtime_validator_12345678",
      agentId: "agent_runtime_validator_12345678",
      sequence: 3,
      content
    }
  };
}

function failedStatus(error) {
  return {
    ...runReply(),
    type: "run.status",
    payload: {
      runId: "run_runtime_validator_12345678",
      traceId: "trace_runtime_validator_12345678",
      agentId: "agent_runtime_validator_12345678",
      sequence: 3,
      status: "failed",
      error
    }
  };
}

function agentPublish(name, role) {
  return {
    protocolVersion: "1.0",
    messageId: "msg_runtime_validator_agent_1234",
    timestamp: "2026-08-29T00:00:00Z",
    type: "agent.publish",
    payload: {
      teamId: "team_runtime_validator_12345678",
      agentId: "agent_runtime_validator_12345678",
      ownerMemberId: "member_runtime_validator_12345678",
      deviceId: "device_runtime_validator_12345678",
      name,
      role,
      capabilities: {
        invocationMode: "managed",
        supportsStart: true,
        supportsResume: false,
        supportsStreaming: true,
        supportsInterrupt: true,
        supportsHandoff: false
      }
    }
  };
}

async function rawWireCases() {
  const suite = JSON.parse(await readFile(
    new URL(
      "../fixtures/runtime-bridge-wire-cases.json",
      import.meta.url
    ),
    "utf8"
  ));
  return suite.cases.map((fixture) => {
    let raw = fixture.raw;
    if (raw === undefined && fixture.nestCount !== undefined) {
      raw = fixture.rawPrefix + "[".repeat(fixture.nestCount) + "null" +
        "]".repeat(fixture.nestCount) + fixture.rawSuffix;
    } else if (raw === undefined && fixture.arrayCount !== undefined) {
      raw = fixture.rawPrefix + Array.from(
        { length: fixture.arrayCount },
        () => fixture.arrayItem
      ).join(",") + fixture.rawSuffix;
    } else if (raw === undefined) {
      raw = fixture.rawPrefix + fixture.repeat.repeat(fixture.repeatCount) +
        fixture.rawSuffix;
    }
    return { ...fixture, raw };
  });
}

test("standalone runtime validation agrees with every root Bridge fixture", async () => {
  const fixtureSuite = JSON.parse(await readFile(
    new URL("../fixtures/cases.json", import.meta.url),
    "utf8"
  ));
  const fixtures = fixtureSuite.cases.filter(({ schemaId }) =>
    schemaId === bridgeSchemaId
  );

  assert.ok(fixtures.length > 0);
  for (const fixture of fixtures) {
    assert.equal(
      validateBridgeMessage(structuredClone(fixture.instance)),
      fixture.valid,
      fixture.name
    );
  }
});

test("standalone validation closes the envelope but retains payload extensions", () => {
  const message = runReply();

  assert.equal(validateBridgeMessage(message), true);
  assert.equal(validateBridgeMessage({
    ...message,
    unexpected: true
  }), false);
  assert.equal(validateBridgeMessage({
    ...message,
    messageId: undefined
  }), false);
  assert.equal(validateBridgeMessage({
    ...message,
    timestamp: undefined
  }), false);
  assert.equal(validateBridgeMessage({
    ...message,
    payload: {
      ...message.payload,
      futureOptionalAssessmentHint: true
    }
  }), true);
});

test("standalone validation enforces reply and error bounds", () => {
  assert.equal(validateBridgeMessage(runReply("x".repeat(20_000))), true);
  assert.equal(validateBridgeMessage(runReply("x".repeat(20_001))), false);
  assert.equal(validateBridgeMessage(runReply("😀".repeat(20_000))), true);
  assert.equal(validateBridgeMessage(runReply("😀".repeat(20_001))), false);

  const maximumError = {
    code: "A".repeat(64),
    message: "m".repeat(512),
    retryable: false
  };
  assert.equal(validateBridgeMessage(failedStatus(maximumError)), true);
  assert.equal(validateBridgeMessage(failedStatus({
    ...maximumError,
    code: "A".repeat(65)
  })), false);
  assert.equal(validateBridgeMessage(failedStatus({
    ...maximumError,
    message: "m".repeat(513)
  })), false);
  assert.equal(validateBridgeMessage(failedStatus({
    ...maximumError,
    internalStack: "must not cross the boundary"
  })), false);
});

test("standalone validation accepts only canonical Go-compatible UTC timestamps", () => {
  for (const timestamp of [
    "2026-08-29T00:00:00Z",
    "2026-08-29T00:00:00.1Z",
    "2026-08-29T00:00:00.123456789Z"
  ]) {
    assert.equal(validateBridgeMessage({ ...runReply(), timestamp }), true, timestamp);
  }
  for (const timestamp of [
    "2026-08-29t00:00:00Z",
    "2026-08-29T23:59:60Z",
    "2026-08-29T00:00:00.1234567890Z"
  ]) {
    assert.equal(validateBridgeMessage({ ...runReply(), timestamp }), false, timestamp);
  }
});

test("standalone Agent publication bounds use Unicode code points", () => {
  assert.equal(validateBridgeMessage(agentPublish(
    "😀".repeat(80),
    "🛠".repeat(80)
  )), true);
  assert.equal(validateBridgeMessage(agentPublish("n", "r".repeat(81))), false);
  assert.equal(validateBridgeMessage(agentPublish("n", "🛠".repeat(81))), false);
});

test("raw Bridge decoding agrees with the shared exact-number corpus", async () => {
  const cases = await rawWireCases();
  assert.ok(cases.length > 0);
  for (const fixture of cases) {
    const decoded = decodeBridgeMessage(fixture.raw);
    assert.equal(Boolean(decoded), fixture.valid, fixture.name);
    if (decoded) assert.equal(decoded.type, fixture.messageType, fixture.name);
  }
});

test("raw decoding normalizes declared numbers and preserves extensions", async () => {
  const cases = await rawWireCases();
  const decodeCase = (name) => decodeBridgeMessage(
    cases.find((fixture) => fixture.name === name)?.raw ?? ""
  );

  const exponent = decodeCase("declared integer accepts exponent notation");
  assert.equal(exponent?.payload.sequence, 1);
  const maximum = decodeCase("declared integer accepts maximum safe value");
  assert.equal(maximum?.payload.sequence, Number.MAX_SAFE_INTEGER);
  const negativeZero = decodeCase(
    "declared negative zero normalizes to positive zero"
  );
  assert.equal(negativeZero?.payload.session?.contextCursor, 0);
  assert.equal(Object.is(negativeZero?.payload.session?.contextCursor, -0), false);

  const extensions = decodeCase(
    "open extensions retain arbitrary raw numbers and JSON values"
  );
  const future = extensions?.payload.futureExtension;
  assert.equal(typeof future?.finiteHuge, "number");
  assert.equal(future?.finiteHuge, 1e100);
  assert.equal(typeof future?.fraction, "number");
  assert.equal(future?.fraction, 0.25);
  assert.equal(future?.text, "kept");
  assert.equal(future?.flag, true);
  assert.equal(future?.nothing, null);
  assert.equal(JSON.isRawJSON(future?.huge), true);
  assert.equal(JSON.isRawJSON(future?.unsafeInteger), true);
  assert.match(JSON.stringify(extensions), /"huge":1e400/u);
  assert.match(
    JSON.stringify(extensions),
    /"unsafeInteger":9007199254740993/u
  );

  const status = decodeCase("error details retain deep raw numbers");
  const details = status?.payload.error?.details;
  assert.equal(details?.exitCode, 2);
  assert.equal(typeof details?.exitCode, "number");
  assert.equal(details?.category, "future_runtime_category");
  assert.equal(details?.stderrCaptured, true);
  assert.equal(JSON.isRawJSON(details?.huge), true);
  assert.match(JSON.stringify(status), /"huge":1e400/u);

  const session = decodeCase("deep session cursors and revisions normalize");
  assert.equal(session?.payload.session?.contextCursor, 1);
  assert.equal(
    session?.payload.session?.resultEvidenceRevision,
    Number.MAX_SAFE_INTEGER
  );
  const assessment = decodeCase("declared noninteger number remains a number");
  assert.equal(assessment?.payload.assessment?.confidence, 0.5);
  const minimumSubnormal = decodeCase(
    "declared number accepts minimum subnormal rounding boundary"
  );
  assert.equal(
    minimumSubnormal?.payload.assessment?.confidence,
    Number.MIN_VALUE
  );
  const surrogatePair = decodeCase(
    "escaped Unicode surrogate pair decodes without drift"
  );
  assert.equal(surrogatePair?.payload.content, "😀");
});

test("raw decoding accepts strict UTF-8 bytes and rejects malformed input", () => {
  const raw = JSON.stringify(runReply());
  const encoded = new TextEncoder().encode(raw);
  assert.equal(
    decodeBridgeMessage(encoded)?.type,
    "run.reply"
  );
  assert.equal(
    decodeBridgeMessage(Uint8Array.of(0xef, 0xbb, 0xbf, ...encoded)),
    undefined
  );
  assert.throws(() => decodeBridgeMessage("{not-json"), SyntaxError);
  assert.throws(
    () => decodeBridgeMessage(Uint8Array.of(0xff)),
    TypeError
  );
  assert.equal(decodeBridgeMessage("{}"), undefined);
});
