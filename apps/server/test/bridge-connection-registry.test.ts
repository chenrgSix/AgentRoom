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
