import type Database from "better-sqlite3";
import type {
  ProviderInputAttestation,
  RemoteInputAttestation
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest,
  remoteInputAttestationDigest
} from "@convene-wire/contracts/execution-validation";
import { ExecutionError } from "../execution/execution-error.js";
import type { ExecutionPlanRepository } from
  "../execution/execution-plan-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import type { RemoteEvidenceRepository } from "./remote-evidence-repository.js";
import type { RemoteProviderBindingRepository } from
  "./remote-provider-binding-repository.js";
import {
  RemoteProviderClient,
  RemoteProviderClientError
} from "./remote-provider-client.js";
import {
  RemoteInputAttestationPlanner,
  RemoteInputPlanError
} from "./remote-input-attestation-planner.js";
import {
  RemoteInputAttestationRepository,
  type RemoteInputAttestationOperation
} from "./remote-input-attestation-repository.js";

interface ObserveCommand {
  operationId: string;
  providerBindingId: string;
  planRevision: number;
  nodeKey: string;
  expectedPlanDigest: string;
  expectedControlRevision: number;
  sourceEvidenceId: string;
}

const fail = (code: string, statusCode: 400 | 404 | 409 = 409): never => {
  throw new ExecutionError(code, statusCode);
};

function exactKeys(value: unknown, keys: readonly string[]):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    fail("REMOTE_INPUT_ATTESTATION_INVALID", 400);
  }
}

/** Sole network writer for provider input attestations. */
export class RemoteInputAttestationService {
  private readonly inFlight = new Map<string, Promise<RemoteInputAttestation>>();

  public constructor(
    private readonly database: Database.Database,
    private readonly repository: RemoteInputAttestationRepository,
    private readonly evidence: RemoteEvidenceRepository,
    private readonly bindings: RemoteProviderBindingRepository,
    private readonly plans: ExecutionPlanRepository,
    private readonly auth: AuthService,
    private readonly provider: RemoteProviderClient,
    private readonly planner: RemoteInputAttestationPlanner
  ) {}

  public async observe(
    principal: WebPrincipal,
    planId: string,
    input: unknown,
    now: string
  ): Promise<RemoteInputAttestation> {
    exactKeys(input, [
      "operationId", "providerBindingId", "planRevision", "nodeKey",
      "expectedPlanDigest", "expectedControlRevision", "sourceEvidenceId"
    ]);
    canonicalExecutionJSON(input);
    const command = input as unknown as ObserveCommand;
    if (!/^op_[A-Za-z0-9_-]{8,128}$/u.test(command.operationId) ||
      !Number.isSafeInteger(command.planRevision) || command.planRevision < 1 ||
      !Number.isSafeInteger(command.expectedControlRevision) ||
      command.expectedControlRevision < 1) {
      return fail("REMOTE_INPUT_ATTESTATION_INVALID", 400);
    }
    const key = command.operationId;
    const active = this.inFlight.get(key);
    if (active) return active;
    const work = this.observeCommand(principal, planId, command, now);
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    }
  }

  private async observeCommand(
    principal: WebPrincipal,
    planId: string,
    command: ObserveCommand,
    now: string
  ): Promise<RemoteInputAttestation> {
    const plan = this.plans.get(planId);
    if (!plan) return fail("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireFullWebSession(principal);
    const actor = this.auth.requireRoomMember(principal, plan.roomId);
    const node = plan.current.definition.nodes.find((entry) =>
      entry.nodeKey === command.nodeKey);
    const binding = this.bindings.get(command.providerBindingId);
    const source = this.evidence.getSource(command.sourceEvidenceId);
    if (actor.role !== "owner") return fail("REMOTE_EVIDENCE_OWNER_REQUIRED");
    if ((plan.state !== "approved" && plan.state !== "running") ||
      plan.current.revision !== command.planRevision ||
      plan.current.digest !== command.expectedPlanDigest ||
      plan.controlRevision !== command.expectedControlRevision) {
      return fail("REMOTE_EVIDENCE_PLAN_STALE");
    }
    if (!node || !binding || binding.revocation || !source ||
      binding.binding.teamId !== actor.teamId ||
      source.repositoryId !== node.repository.repositoryId ||
      binding.binding.repositoryId !== source.repositoryId ||
      source.kind !== "repository_commit" || !source.commit || !source.tree ||
      source.origin?.kind !== "remote_observation" ||
      source.origin.providerBindingId !== command.providerBindingId ||
      !source.origin.observationId || !source.origin.observationDigest ||
      this.database.prepare(`
        SELECT 1 FROM execution_dispatch_intents
        WHERE plan_id = ? AND plan_revision = ? AND node_key = ? LIMIT 1
      `).get(planId, command.planRevision, command.nodeKey)) {
      return fail("REMOTE_INPUT_ATTESTATION_UNAVAILABLE");
    }
    const commit = source.commit;
    const tree = source.tree;
    const sourceOrigin = source.origin;
    const sourceObservationId = sourceOrigin.observationId!;
    const sourceObservationDigest = sourceOrigin.observationDigest!;
    let planned: ReturnType<RemoteInputAttestationPlanner["plan"]>;
    try {
      planned = this.planner.plan(
        plan.current.definition,
        planId,
        command.planRevision,
        command.nodeKey
      );
    } catch (error) {
      return fail(error instanceof RemoteInputPlanError
        ? error.code : "REMOTE_INPUT_ATTESTATION_UNAVAILABLE");
    }
    const request = {
      ...command,
      planId,
      repositoryId: binding.binding.repositoryId,
      providerRepositoryId: binding.binding.providerRepositoryId,
      sourceDigest: source.sourceDigest,
      sourceObservationId,
      sourceObservationDigest,
      commit,
      tree,
      inputs: planned.inputs,
      remoteInputEvidenceDigest: planned.remoteInputEvidenceDigest
    };
    const plannedOperation = this.planOperation(
      request,
      actor.memberId,
      now
    );
    const replay = this.repository.get(command.operationId);
    if (replay) return replay;
    if (plannedOperation.state === "failed") {
      return fail(plannedOperation.errorCode ?? "REMOTE_INPUT_ATTESTATION_FAILED");
    }
    let observed: ProviderInputAttestation;
    try {
      observed = await this.provider.observeInputAttestation(binding.binding, {
        operationId: command.operationId,
        providerRepositoryId: binding.binding.providerRepositoryId,
        nodeKey: command.nodeKey,
        commit,
        tree,
        inputs: planned.inputs,
        remoteInputEvidenceDigest: planned.remoteInputEvidenceDigest
      });
    } catch (error) {
      const code = error instanceof RemoteProviderClientError
        ? error.code : "REMOTE_PROVIDER_UNAVAILABLE";
      if (error instanceof RemoteProviderClientError && error.outcomeUnknown) {
        this.repository.markOutcomeUnknown(command.operationId, code, now);
      } else {
        this.repository.markFailed(command.operationId, code, now);
      }
      return fail(code);
    }
    if (observed.operationId !== command.operationId ||
      observed.providerRepositoryId !== binding.binding.providerRepositoryId ||
      observed.nodeKey !== command.nodeKey ||
      observed.commit !== commit || observed.tree !== tree ||
      observed.remoteInputEvidenceDigest !== planned.remoteInputEvidenceDigest ||
      canonicalExecutionJSON(observed.inputs) !==
        canonicalExecutionJSON(planned.inputs)) {
      this.repository.markFailed(
        command.operationId,
        "REMOTE_PROVIDER_IDENTITY_MISMATCH",
        now
      );
      return fail("REMOTE_PROVIDER_IDENTITY_MISMATCH");
    }
    const pending: RemoteInputAttestation = {
      ...observed,
      providerBindingId: command.providerBindingId,
      repositoryId: binding.binding.repositoryId,
      planId,
      planRevision: command.planRevision,
      sourceEvidenceId: source.sourceEvidenceId,
      sourceDigest: source.sourceDigest,
      sourceObservationId,
      sourceObservationDigest,
      attestationDigest: "0".repeat(64)
    };
    pending.attestationDigest = remoteInputAttestationDigest(pending);
    assertExecutionCommand("remoteInputAttestation", pending);
    return this.repository.retain(pending, now);
  }

  private planOperation(
    request: Record<string, unknown> & ObserveCommand,
    actorMemberId: string,
    now: string
  ): RemoteInputAttestationOperation {
    const planned: RemoteInputAttestationOperation = {
      operationId: request.operationId,
      providerBindingId: request.providerBindingId,
      planId: request.planId as string,
      planRevision: request.planRevision,
      nodeKey: request.nodeKey,
      sourceEvidenceId: request.sourceEvidenceId,
      expectedPlanDigest: request.expectedPlanDigest,
      expectedControlRevision: request.expectedControlRevision,
      actorMemberId,
      requestDigest: executionOperationDigest(request),
      request,
      state: "planned",
      attestationId: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now
    };
    const retained = this.repository.plan(planned);
    if (retained.requestDigest !== planned.requestDigest ||
      canonicalExecutionJSON(retained.request) !== canonicalExecutionJSON(request)) {
      return fail("REMOTE_INPUT_ATTESTATION_OPERATION_CONFLICT");
    }
    return retained;
  }
}
