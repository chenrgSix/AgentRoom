import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { GovernedExecutionManifest } from
  "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from
  "@convene-wire/contracts/execution-validation";

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

const governedWire = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/execution-runtime-cases.json",
  import.meta.url
), "utf8")).cases.find((entry: { name: string }) =>
  entry.name === "execution runtime: valid governed wire delivery"
).instance.payload;

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
  const registry = new BridgeConnectionRegistry(
    () => new Date("2026-08-31T10:05:00Z")
  );
  const legacy = new FakeSocket();
  const capable = new FakeSocket();
  const downgraded = new FakeSocket();
  const manifest = structuredClone(
    governedWire.contextManifest.execution
  ) as GovernedExecutionManifest;
  const deviceId = manifest.scope.deviceId;
  const agentId = manifest.scope.agentId;
  const capability = { version: 1, workspaceBoundary: "enforced", preventivePathEnforcement: false,
    operations: ["prepare", "capture", "verify"] };
  const requiredOperations = manifest.verificationProfiles.some((profile) =>
    profile.required
  ) ? ["prepare", "capture", "verify"] : ["prepare", "capture"];
  const readyGrant = {
    grant: structuredClone(manifest.grant),
    repositoryId: manifest.repository.repositoryId,
    bindingId: manifest.repository.bindingId,
    deviceId,
    agentId,
    planId: manifest.scope.planId,
    nodeKey: manifest.scope.nodeKey,
    operations: requiredOperations, runtimeProfile: {
      profileId: manifest.repository.runtimeProfileId,
      revision: 1,
      digest: manifest.repository.runtimeProfileDigest
    },
    verificationProfiles: manifest.verificationProfiles.map((profile) => ({
      profileId: profile.profileId,
      revision: profile.revision,
      digest: profile.digest
    })),
    scopePolicy: structuredClone(manifest.scopePolicy),
    integrationTargets: [],
    issuedAt: manifest.workspace.issuedAt,
    revokedAt: null
  };
  const agentCapability = { ...capability, readyGrants: [readyGrant] };
  const governed = (execution: GovernedExecutionManifest = manifest) => ({
    type: "run.requested", payload: {
      targetAgentId: agentId,
      contextManifest: { execution }
    }
  });
  const ordinary = { type: "run.requested", payload: {} };
  registry.register(deviceId, 1, legacy);
  assert.equal(registry.send(deviceId, governed()), false);
  assert.equal(registry.send(deviceId, ordinary), true);
  assert.equal(legacy.sent.length, 1);
  for (const invalid of [{ ...capability, version: 2 }, { ...capability, workspaceBoundary: "prompt_only" }, true]) {
    assert.throws(() => registry.register(deviceId, 2, capable, { governedExecution: invalid }), /PLAN_SCHEMA_INVALID/u);
    assert.equal(registry.activeEpoch(deviceId), 1);
    assert.equal(legacy.closes.length, 0);
  }
  registry.register(deviceId, 2, capable, { governedExecution: capability });
  assert.equal(registry.supportsGovernedExecution(deviceId), true);
  assert.equal(registry.supportsGovernedAgentCapability(deviceId, agentId, agentCapability), true);
  assert.equal(registry.supportsGovernedAgentCapability(deviceId, agentId, {
    ...capability, operations: ["prepare"]
  }), true);
  assert.equal(registry.supportsGovernedAgentCapability(deviceId, agentId, {
    ...capability, preventivePathEnforcement: true
  }), false);
  assert.equal(registry.supportsGovernedAgentCapability(deviceId, agentId, {
    ...capability, operations: ["publish"]
  }), false);
  assert.equal(registry.supportsGovernedAgentCapability(deviceId, agentId, {
    ...agentCapability,
    readyGrants: [{ ...readyGrant, deviceId: "device_foreign0001" }]
  }), false, "a foreign Device grant was accepted");
  assert.equal(registry.send(deviceId, governed()), false,
    "Device hello cannot stand in for current Agent publication");
  assert.equal(registry.recordGovernedAgentCapability(
    deviceId, 1, agentId, agentCapability
  ), false, "a stale epoch recorded Agent capability");
  assert.equal(registry.recordGovernedAgentCapability(
    deviceId, 2, agentId, {
      ...capability, operations: ["prepare"]
    }
  ), true);
  assert.equal(registry.send(deviceId, governed()), false,
    "prepare-only Agent publication enabled complete governed transport");
  assert.equal(registry.recordGovernedAgentCapability(
    deviceId, 2, agentId, agentCapability
  ), true);
  const agentSnapshot = registry.governedAgentExecutionCapability(
    deviceId, agentId
  )!;
  assert.deepEqual(agentSnapshot.operations, capability.operations);
  assert.equal(registry.governedAgentReadyGrants(
    deviceId, agentId
  )[0]?.grant.grantId, readyGrant.grant.grantId);
  agentSnapshot.operations.splice(0);
  assert.equal(registry.supportsGovernedAgentExecution(
    deviceId, agentId
  ), true);
  const invalidDigest = structuredClone(manifest);
  invalidDigest.scopePolicy.allowedPaths.push("foreign");
  assert.equal(registry.send(deviceId, governed(invalidDigest)), false,
    "a changed manifest reused its digest");
  const changedScope = structuredClone(invalidDigest);
  const { manifestDigest: _, ...unsigned } = changedScope;
  changedScope.manifestDigest = executionOperationDigest(unsigned);
  assert.equal(registry.send(deviceId, governed(changedScope)), false,
    "a rehashed manifest exceeded the current grant");
  assert.equal(registry.send(deviceId, governed()), true);
  assert.equal(registry.recordGovernedAgentCapability(
    deviceId, 2, agentId, undefined
  ), true);
  assert.equal(registry.send(deviceId, governed()), false,
    "same-epoch Agent downgrade retained its prior declaration");
  assert.equal(registry.recordGovernedAgentCapability(
    deviceId, 2, agentId, agentCapability
  ), true);
  registry.register(deviceId, 3, downgraded);
  assert.equal(registry.supportsGovernedExecution(deviceId), false);
  assert.equal(registry.supportsGovernedAgentCapability(
    deviceId, agentId, agentCapability
  ), false);
  assert.equal(registry.governedAgentExecutionCapability(
    deviceId, agentId
  ), undefined, "a new hello retained an older Agent declaration");
  assert.equal(registry.send(deviceId, governed()), false);
  assert.equal(registry.send(deviceId, ordinary), true);
  assert.equal(capable.sent.length, 1);
  const observing = { ...capability, operations: ["observe"] };
  registry.register("device_observer", 1, new FakeSocket(), { governedExecution: observing });
  observing.operations.push("prepare", "capture");
  assert.equal(registry.supportsGovernedExecution("device_observer"), false);
  assert.equal(registry.send("device_observer", governed()), false);
  const snapshot = registry.governedExecutionCapability("device_observer")!;
  assert.deepEqual(snapshot.operations, ["observe"]);
  snapshot.operations.push("prepare", "capture");
  assert.equal(registry.supportsGovernedExecution("device_observer"), false);
  assert.equal(registry.governedExecutionCapability("missing"), undefined);
});
