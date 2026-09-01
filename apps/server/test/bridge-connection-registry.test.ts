import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeConnectionRegistry,
  type BridgeSocket
} from "../src/bridge/bridge-connection-registry.js";

class FakeSocket implements BridgeSocket {
  public readonly closes: Array<{ code?: number; reason?: string }> = [];
  public readonly sent: string[] = [];

  public close(code?: number, reason?: string): void {
    this.closes.push({ ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
  }

  public send(data: string): void {
    this.sent.push(data);
  }
}

test("only the newest authenticated Bridge epoch remains active", () => {
  const registry = new BridgeConnectionRegistry();
  const first = new FakeSocket();
  const stale = new FakeSocket();
  const newest = new FakeSocket();
  assert.equal(registry.register("device_one", 2, first, {
    supportsAgentProvisioning: true
  }), true);
  assert.equal(registry.register("device_one", 1, stale), false);
  assert.equal(registry.register("device_one", 3, newest), true);
  assert.equal(first.closes[0]?.code, 4_001);
  assert.equal(registry.activeEpoch("device_one"), 3);
  assert.equal(registry.supportsAgentProvisioning("device_one"), false);
  registry.remove("device_one", first);
  assert.equal(registry.activeEpoch("device_one"), 3);
  assert.equal(registry.send("device_one", { type: "test" }), true);
  assert.deepEqual(JSON.parse(newest.sent[0] ?? ""), { type: "test" });
});

test("Bridge capabilities belong to the active connection epoch", () => {
  const registry = new BridgeConnectionRegistry();
  const capable = new FakeSocket();
  const replacement = new FakeSocket();
  assert.equal(registry.register("device_capable", 1, capable, {
    supportsAgentProvisioning: true
  }), true);
  assert.equal(registry.supportsAgentProvisioning("device_capable"), true);
  assert.equal(registry.register("device_capable", 2, replacement), true);
  assert.equal(registry.supportsAgentProvisioning("device_capable"), false);
});

test("governed Run transport requires the current exact execution capability", () => {
  const registry = new BridgeConnectionRegistry();
  const legacy = new FakeSocket();
  const capable = new FakeSocket();
  const downgraded = new FakeSocket();
  const capability = { version: 1, workspaceBoundary: "enforced", preventivePathEnforcement: false,
    operations: ["prepare", "capture", "verify"] };
  const governed = { type: "run.requested", payload: {
    targetAgentId: "agent_execution", contextManifest: { execution: {} }
  } };
  const ordinary = { type: "run.requested", payload: {} };
  registry.register("device_execution", 1, legacy);
  assert.equal(registry.send("device_execution", governed), false);
  assert.equal(registry.send("device_execution", ordinary), true);
  assert.equal(legacy.sent.length, 1);
  for (const invalid of [{ ...capability, version: 2 }, { ...capability, workspaceBoundary: "prompt_only" }, true]) {
    assert.throws(() => registry.register("device_execution", 2, capable, { governedExecution: invalid }), /PLAN_SCHEMA_INVALID/u);
    assert.equal(registry.activeEpoch("device_execution"), 1);
    assert.equal(legacy.closes.length, 0);
  }
  registry.register("device_execution", 2, capable, { governedExecution: capability });
  assert.equal(registry.supportsGovernedExecution("device_execution"), true);
  assert.equal(registry.supportsGovernedAgentCapability("device_execution", capability), true);
  assert.equal(registry.supportsGovernedAgentCapability("device_execution", {
    ...capability, operations: ["prepare"]
  }), true);
  assert.equal(registry.supportsGovernedAgentCapability("device_execution", {
    ...capability, preventivePathEnforcement: true
  }), false);
  assert.equal(registry.supportsGovernedAgentCapability("device_execution", {
    ...capability, operations: ["publish"]
  }), false);
  assert.equal(registry.send("device_execution", governed), false,
    "Device hello cannot stand in for current Agent publication");
  assert.equal(registry.recordGovernedAgentCapability(
    "device_execution", 1, "agent_execution", capability
  ), false, "a stale epoch recorded Agent capability");
  assert.equal(registry.recordGovernedAgentCapability(
    "device_execution", 2, "agent_execution", {
      ...capability, operations: ["prepare"]
    }
  ), true);
  assert.equal(registry.send("device_execution", governed), false,
    "prepare-only Agent publication enabled complete governed transport");
  assert.equal(registry.recordGovernedAgentCapability(
    "device_execution", 2, "agent_execution", capability
  ), true);
  const agentSnapshot = registry.governedAgentExecutionCapability(
    "device_execution", "agent_execution"
  )!;
  assert.deepEqual(agentSnapshot.operations, capability.operations);
  agentSnapshot.operations.splice(0);
  assert.equal(registry.supportsGovernedAgentExecution(
    "device_execution", "agent_execution"
  ), true);
  assert.equal(registry.send("device_execution", governed), true);
  assert.equal(registry.recordGovernedAgentCapability(
    "device_execution", 2, "agent_execution", undefined
  ), true);
  assert.equal(registry.send("device_execution", governed), false,
    "same-epoch Agent downgrade retained its prior declaration");
  assert.equal(registry.recordGovernedAgentCapability(
    "device_execution", 2, "agent_execution", capability
  ), true);
  registry.register("device_execution", 3, downgraded);
  assert.equal(registry.supportsGovernedExecution("device_execution"), false);
  assert.equal(registry.supportsGovernedAgentCapability("device_execution", capability), false);
  assert.equal(registry.governedAgentExecutionCapability(
    "device_execution", "agent_execution"
  ), undefined, "a new hello retained an older Agent declaration");
  assert.equal(registry.send("device_execution", governed), false);
  assert.equal(registry.send("device_execution", ordinary), true);
  assert.equal(capable.sent.length, 1);
  const observing = { ...capability, operations: ["observe"] };
  registry.register("device_observer", 1, new FakeSocket(), { governedExecution: observing });
  observing.operations.push("prepare", "capture");
  assert.equal(registry.supportsGovernedExecution("device_observer"), false);
  assert.equal(registry.send("device_observer", governed), false);
  const snapshot = registry.governedExecutionCapability("device_observer")!;
  assert.deepEqual(snapshot.operations, ["observe"]);
  snapshot.operations.push("prepare", "capture");
  assert.equal(registry.supportsGovernedExecution("device_observer"), false);
  assert.equal(registry.governedExecutionCapability("missing"), undefined);
});
