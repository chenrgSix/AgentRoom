import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { generateContractTypes } from "../src/codegen.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("contract generation is deterministic", async () => {
  const first = await generateContractTypes(packageRoot);
  const second = await generateContractTypes(packageRoot);

  assert.deepEqual(second, first);
  assert.match(first.typescript, /export type BridgeMessage =/);
  assert.match(
    first.bridgeRuntimeModule,
    /export function validateBridgeMessage/
  );
  assert.match(
    first.bridgeRuntimeModule,
    /export function decodeBridgeMessage/
  );
  assert.match(first.bridgeRuntimeModule, /context\.source/);
  assert.match(first.bridgeStandaloneValidator, /module\.exports = validate/);
  assert.match(first.goBridgeRuntimeValidator, /func ValidateBridgeMessage/);
  assert.match(
    first.goBridgeRuntimeValidator,
    /func ValidateAndNormalizeBridgeMessage/
  );
  assert.match(
    first.goBridgeRuntimeValidator,
    /func DecodeBridgeMessage/
  );
  assert.match(first.typescript, /timestamp: string;/);
  assert.doesNotMatch(first.typescript, /timestamp: Date;/);
  assert.match(first.go, /type BridgeHelloMessage struct/);
  assert.match(first.go, /type AgentProvisionRequestedMessage struct/);
  assert.match(first.go, /type AgentProvisionResultMessage struct/);
  assert.match(first.go, /ContextManifest \*ContextManifest/);
  assert.match(first.pairingGo, /package pairingcontracts/);
  assert.match(first.pairingGo, /type DevicePairingSessionClaimRequest struct/);
  assert.match(first.pairingGo, /type DevicePairingSessionPollProjection struct/);
  assert.match(first.pairingGo, /type DevicePairingPrivateTrustDescriptor struct/);
  assert.match(first.pairingGo, /type DevicePairingPrivateCARotationOffer struct/);
  assert.match(first.pairingGo, /SupportsScopedPrivateTrust \*bool/);
  assert.match(
    first.pairingTypescript,
    /export interface DevicePairingSessionOwnerProjection/
  );
  assert.match(
    first.pairingTypescript,
    /export interface DevicePairingPrivateTrustDescriptor/
  );
  assert.match(first.pairingTypescript, /trust\?: DevicePairingSessionCreatedTrust/);
  assert.match(first.go, /Timestamp time.Time/);
  assert.match(first.workGo, /package workcontracts/);
  assert.match(first.workGo, /type ResultProposal struct/);
  assert.match(first.workGo, /type RunContextManifest struct/);
  assert.match(first.workTypescript, /export interface TaskProjection/);
  assert.match(first.workTypescript, /export interface WorkbenchQuery/);
  assert.match(first.workTypescript, /search\?:\s+string;/);
  assert.match(first.workGo, /Search\s+\*string\s+`json:"search,omitempty"`/);
  assert.match(first.workTypescript, /export interface WorkbenchPage/);
  assert.match(first.executionTypescript, /export interface ExecutionPlanDefinition/);
  assert.match(first.executionTypescript, /export interface ExecutionPlanApprovalCommand/);
  assert.match(first.executionTypescript, /createdAt:\s+string;/);
  assert.match(first.executionGo, /package executioncontracts/);
  assert.match(first.executionGo, /type ExecutionPlanDefinition struct/);
  assert.match(first.executionValidators, /exports\.planDefinition/);
  for (const name of [
    "GovernedExecutionManifest", "ExecutionInputBinding", "GovernedExecutionCapability",
    "RepositoryBindingSummary", "ExecutionGrantSummary", "RepositoryOperationRequest",
    "RepositoryOperationReceipt", "RepositoryCheckpoint", "VerificationReceipt"
  ]) {
    assert.match(first.executionTypescript, new RegExp(`export interface ${name}`));
    assert.match(first.executionGo, new RegExp(`type ${name} struct`));
  }
  for (const name of [
    "executionManifest", "executionInputBinding", "executionCapability", "repositoryBinding",
    "executionGrant", "repositoryOperation", "repositoryReceipt", "executionCheckpoint",
    "verificationReceipt"
  ]) assert.match(first.executionValidators, new RegExp(`exports\\.${name}`));
});
