import assert from "node:assert/strict";
import test from "node:test";
import { renamedEnvironmentValue } from "../src/config/environment.js";

test("prefers the current ConveneWire environment name", () => {
  assert.equal(
    renamedEnvironmentValue(
      { CONVENE_WIRE_PORT: " 3000 ", AGENT_ROOM_PORT: "3000" },
      "CONVENE_WIRE_PORT",
      "AGENT_ROOM_PORT"
    ),
    "3000"
  );
});

test("accepts the released AgentRoom environment name as an alias", () => {
  assert.equal(
    renamedEnvironmentValue(
      { AGENT_ROOM_DATABASE_PATH: "legacy/data.sqlite" },
      "CONVENE_WIRE_DATABASE_PATH",
      "AGENT_ROOM_DATABASE_PATH"
    ),
    "legacy/data.sqlite"
  );
});

test("rejects conflicting current and legacy environment values", () => {
  assert.throws(
    () => renamedEnvironmentValue(
      {
        CONVENE_WIRE_PUBLIC_ORIGIN: "https://new.example.com",
        AGENT_ROOM_PUBLIC_ORIGIN: "https://old.example.com"
      },
      "CONVENE_WIRE_PUBLIC_ORIGIN",
      "AGENT_ROOM_PUBLIC_ORIGIN"
    ),
    /CONVENE_WIRE_PUBLIC_ORIGIN conflicts with legacy AGENT_ROOM_PUBLIC_ORIGIN/u
  );
});
