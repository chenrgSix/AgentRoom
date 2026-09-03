import type Database from "better-sqlite3";
import type { ExecutionInputBinding, ExecutionPlanProjection, GovernedExecutionManifest } from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand, canonicalExecutionJSON, executionOperationDigest, validateExecutionPlanDefinition
} from "@convene-wire/contracts/execution-validation";
import type { ArtifactPublicationRepository } from "../artifact/artifact-publication-repository.js";
import type { LocalArtifactBlobStore } from "../artifact/local-artifact-blob-store.js";
import { AuthorizationError, type AuthService, type DevicePrincipal, type WebPrincipal } from "../security/auth-service.js";
import type { ArtifactRepository, TaskArtifactRecord } from "../task/artifact-repository.js";
import type { ExecutionApprovalRepository } from "./execution-approval-repository.js";
import type { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { ExecutionInputRepository, type StoredExecutionInput } from "./execution-input-repository.js";
import { ExecutionError } from "./execution-error.js";

export interface ExecutionInputSelection {
  artifactId: string;
  inputSlot: string;
  sourceResultId: string | null;
  sourceAuthority?: NonNullable<ExecutionInputBinding["sourceAuthority"]>;
}
export interface FreezeExecutionInputs {
  planId: string; revision: number; expectedDigest: string; expectedControlRevision: number;
  nodeKey: string; runId: string; deviceId: string;
  selections: ExecutionInputSelection[]; expiresAt: string;
}
interface Destination {
  task_id: string; target_agent_id: string; device_id: string; owner_member_id: string;
  room_id: string; team_id: string; definition_revision: number; criteria_revision: number;
  task_revision: number; deadline_at: string; context_manifest_json: string | null;
}
interface AcceptedSource {
  task_id: string; result_version: number; definition_revision: number; criteria_revision: number;
  operation_id: string; reviewed_by_member_id: string; reviewed_at: string;
}
interface MaterializedSource {
  adoption_native: number;
  adoption_digest: string;
  adoption_id: string;
  source_digest: string;
  source_evidence_id: string;
  candidate_commit: string | null;
  candidate_tree: string | null;
  criteria_revision: number;
  definition_revision: number;
  gate: "accepted_result" | "verified_output" | "integrated_commit";
  gate_operation_id: string;
  materialization_digest: string;
  operation_id: string | null;
  result_version: number | null;
  reviewed_at: string | null;
  reviewed_by_member_id: string | null;
  task_id: string;
}
const binary = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fail = (code: string): never => { throw new ExecutionError(code, 409); };
const deny = (): never => { throw new AuthorizationError("FORBIDDEN", "Execution input is not authorized for this Run"); };

function acceptedProjection(source: MaterializedSource): AcceptedSource {
  if (
    source.gate !== "accepted_result" ||
    source.operation_id !== source.gate_operation_id ||
    source.result_version === null ||
    !source.reviewed_by_member_id ||
    !source.reviewed_at
  ) return fail("EXECUTION_INPUT_SOURCE_UNAVAILABLE");
  return {
    task_id: source.task_id,
    result_version: source.result_version,
    definition_revision: source.definition_revision,
    criteria_revision: source.criteria_revision,
    operation_id: source.operation_id,
    reviewed_by_member_id: source.reviewed_by_member_id,
    reviewed_at: source.reviewed_at
  };
}

function materializedGateDigest(source: MaterializedSource): string {
  return source.gate === "accepted_result" && source.adoption_native === 0
    ? executionOperationDigest(acceptedProjection(source))
    : source.materialization_digest;
}

/** Owns explicit input grants, never Result acceptance or repository execution. */
export class ExecutionInputService {
  public constructor(
    private readonly database: Database.Database,
    private readonly inputs: ExecutionInputRepository,
    private readonly plans: ExecutionPlanRepository,
    private readonly approvals: ExecutionApprovalRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly contents: ArtifactPublicationRepository,
    private readonly blobs: LocalArtifactBlobStore,
    private readonly auth: AuthService
  ) {}

  /** Internal admission port: the caller must atomically create the Run and freeze its manifest. */
  public freezeForRun(input: FreezeExecutionInputs, now: string): ExecutionInputBinding[] {
    if (!this.database.inTransaction) throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    return this.database.transaction(() => this.freezeAcceptedInputs(input, now))();
  }

  private freezeAcceptedInputs(input: FreezeExecutionInputs, now: string): ExecutionInputBinding[] {
    canonicalExecutionJSON(input);
    if (input.selections.length > 32 || new Set(input.selections.map((s) => s.inputSlot)).size !== input.selections.length) {
      return fail("EXECUTION_INPUT_SELECTION_INVALID");
    }
    const plan = this.plans.get(input.planId);
    if (!plan || !["approved", "running"].includes(plan.state) || plan.current.revision !== input.revision ||
      plan.current.digest !== input.expectedDigest || plan.controlRevision !== input.expectedControlRevision) {
      return fail("EXECUTION_INPUT_PLAN_STALE");
    }
    const approval = this.approvals.get(plan.planId, input.revision);
    if (!approval || approval.decision !== "approved" || approval.digest !== input.expectedDigest) {
      return fail("EXECUTION_INPUT_APPROVAL_REQUIRED");
    }
    const destination = this.destination(plan, input.nodeKey, input.runId, input.deviceId);
    const nowMs = Date.parse(now), expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expires) || expires <= nowMs ||
      expires > Date.parse(destination.deadline_at)) return fail("EXECUTION_INPUT_EXPIRY_INVALID");
    const definition = validateExecutionPlanDefinition(plan.current.definition);
    const node = definition.definition.nodes.find((entry) => entry.nodeKey === input.nodeKey)!;
    if (input.selections.some((selection) => !node.inputs.some((slot) => slot.slotKey === selection.inputSlot)) ||
      node.inputs.some((slot) => slot.required && !input.selections.some((selection) => selection.inputSlot === slot.slotKey))) {
      return fail("EXECUTION_INPUT_SELECTION_INVALID");
    }
    // Resolve every source before persisting any row, even inside a larger transaction.
    const prepared = input.selections.map((selection) => {
      const edge = definition.definition.edges.find((entry) => entry.toNodeKey === node.nodeKey &&
        entry.bindings.some((binding) => binding.inputSlot === selection.inputSlot));
      const external = definition.definition.externalInputs.find((entry) =>
        entry.nodeKey === node.nodeKey && entry.inputSlot === selection.inputSlot);
      if ((!edge && !external) || (edge && external)) return fail("EXECUTION_INPUT_PRODUCER_MISSING");
      const sourceNode = edge && definition.definition.nodes.find((entry) => entry.nodeKey === edge.fromNodeKey);
      const sourceTask = sourceNode && plan.compiledTasks.find((entry) => entry.nodeKey === sourceNode.nodeKey);
      const sourceTaskId = sourceTask?.taskId ?? external?.sourceTaskId;
      if (!sourceTaskId || sourceTaskId === destination.task_id) return fail("EXECUTION_INPUT_SOURCE_INVALID");
      const source = edge
        ? (selection.sourceAuthority || selection.sourceResultId)
          ? this.materializedSource(
            edge.gate,
            plan.planId,
            input.revision,
            sourceTaskId,
            selection.sourceResultId,
            selection.sourceAuthority,
            selection.artifactId,
            edge.bindings.find((entry) =>
              entry.inputSlot === selection.inputSlot)!.outputSlot,
            plan.roomId
          )
          : fail("EXECUTION_INPUT_SOURCE_AUTHORITY_REQUIRED")
        : selection.sourceResultId && !selection.sourceAuthority
          ? this.acceptedSource(
            sourceTaskId,
            selection.sourceResultId,
            selection.artifactId,
            plan.roomId
          )
          : fail("EXECUTION_INPUT_SOURCE_INVALID");
      if (sourceTask && (source.definition_revision !== sourceTask.definitionRevision ||
        source.criteria_revision !== sourceTask.criteriaRevision)) return fail("EXECUTION_INPUT_SOURCE_STALE");
      const artifact = this.sealedArtifact(selection.artifactId, sourceTaskId, plan.roomId);
      const slot = node.inputs.find((entry) => entry.slotKey === selection.inputSlot)!;
      const outputSlot = edge?.bindings.find((entry) => entry.inputSlot === selection.inputSlot)?.outputSlot ?? "external";
      if (artifact.type !== slot.kind || (sourceNode && !sourceNode.outputs.some((output) =>
        output.slotKey === outputSlot && output.kind === artifact.type))) return fail("EXECUTION_INPUT_KIND_MISMATCH");
      if (external && (external.sourceResultId !== selection.sourceResultId || external.artifactId !== artifact.artifactId ||
        external.artifactRevision !== artifact.artifactRevision || external.contentDigest !== artifact.contentSha256 ||
        external.kind !== artifact.type)) return fail("EXECUTION_INPUT_EXTERNAL_MISMATCH");
      const binding: ExecutionInputBinding = {
        bindingId: `input_${executionOperationDigest({ runId: input.runId, inputSlot: selection.inputSlot })}`,
        planId: plan.planId, planRevision: input.revision, edgeKey: edge?.edgeKey ?? null,
        gate: edge?.gate ?? "accepted_result",
        gateOperationId: edge
          ? (source as MaterializedSource).gate_operation_id
          : (source as AcceptedSource).operation_id,
        gateDigest: edge
          ? materializedGateDigest(source as MaterializedSource)
          : executionOperationDigest(source),
        sourceTaskId, sourceDefinitionRevision: source.definition_revision, sourceCriteriaRevision: source.criteria_revision,
        sourceResultId: selection.sourceResultId, sourceResultVersion: source.result_version,
        sourceAuthority: edge ? {
          sourceEvidenceId: (source as MaterializedSource).source_evidence_id,
          sourceDigest: (source as MaterializedSource).source_digest,
          adoptionId: (source as MaterializedSource).adoption_id,
          adoptionDigest: (source as MaterializedSource).adoption_digest
        } : null,
        sourceOutputSlot: outputSlot,
        artifact: { artifactId: artifact.artifactId, artifactRevision: artifact.artifactRevision,
          contentDigest: artifact.contentSha256!, byteLength: artifact.contentSizeBytes!, kind: slot.kind },
        repositoryId: sourceNode?.repository?.repositoryId ?? null,
        sourceCommit: edge
          ? (source as MaterializedSource).candidate_commit
          : null,
        sourceTree: edge
          ? (source as MaterializedSource).candidate_tree
          : null,
        destinationTaskId: destination.task_id, destinationRunId: input.runId,
        destinationAgentId: destination.target_agent_id, destinationDeviceId: input.deviceId,
        inputSlot: selection.inputSlot, issuedAt: now, expiresAt: input.expiresAt
      };
      const requestDigest = executionOperationDigest({ ...input, selections: [selection],
        binding: { ...binding, issuedAt: null } });
      const previous = this.inputs.get(binding.bindingId);
      if (previous && previous.requestDigest !== requestDigest) return fail("EXECUTION_INPUT_CONFLICT");
      if (destination.context_manifest_json !== null) {
        const frozen = JSON.parse(destination.context_manifest_json).execution?.inputs as ExecutionInputBinding[] | undefined;
        if (!previous || !Array.isArray(frozen) || !frozen.some((entry) =>
          canonicalExecutionJSON(entry) === canonicalExecutionJSON(previous.binding))) return fail("EXECUTION_INPUT_MANIFEST_FROZEN");
      }
      const record: StoredExecutionInput = { binding, nodeKey: node.nodeKey, contentId: artifact.contentId!,
        planDigest: approval.digest, approvalOperationId: approval.operationId,
        controlRevision: plan.controlRevision, requestDigest };
      return { record, ordinal: sourceNode ? definition.topologicalOrder.indexOf(sourceNode.nodeKey) : -1 };
    });
    prepared.sort((a, b) => a.ordinal - b.ordinal || binary(a.record.binding.inputSlot, b.record.binding.inputSlot));
    return prepared.map(({ record }) => this.inputs.insert(record));
  }

  public getForMember(principal: WebPrincipal, planId: string, bindingId: string): ExecutionInputBinding {
    const plan = this.plans.get(planId);
    if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireRoomMember(principal, plan.roomId);
    const input = this.inputs.get(bindingId);
    if (!input || input.binding.planId !== planId) throw new ExecutionError("EXECUTION_INPUT_NOT_FOUND", 404);
    return input.binding;
  }

  public artifactInputsForMember(principal: WebPrincipal, planId: string, artifactId: string): ExecutionInputBinding[] {
    const plan = this.plans.get(planId);
    if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireRoomMember(principal, plan.roomId);
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.roomId !== plan.roomId || !plan.compiledTasks.some((task) => task.taskId === artifact.taskId)) {
      throw new ExecutionError("EXECUTION_INPUT_NOT_FOUND", 404);
    }
    const inputs = this.inputs.artifactInputs(artifactId);
    if (inputs.some((input) => input.planId !== planId)) return fail("EXECUTION_INPUT_CORRUPT");
    return inputs;
  }

  /** Called only inside initial canonical Artifact binding, never a client-supplied relation command. */
  public recordArtifactInputs(principal: DevicePrincipal, artifact: TaskArtifactRecord, now: string): void {
    if (!this.database.inTransaction) throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    const run = this.database.prepare("SELECT context_manifest_json FROM runs WHERE run_id = ?")
      .get(artifact.sourceRunId) as { context_manifest_json: string | null } | undefined;
    const manifest = run?.context_manifest_json && JSON.parse(run.context_manifest_json).execution as GovernedExecutionManifest | undefined;
    if (!manifest) return;
    assertExecutionCommand("executionManifest", manifest);
    const { manifestDigest, ...unsigned } = manifest;
    if (executionOperationDigest(unsigned) !== manifestDigest || executionOperationDigest(manifest.inputs) !== manifest.inputDigest ||
      new Set(manifest.inputs.map((input) => input.bindingId)).size !== manifest.inputs.length ||
      manifest.scope.deviceId !== principal.deviceId || manifest.scope.runId !== artifact.sourceRunId ||
      manifest.scope.taskId !== artifact.taskId || manifest.scope.agentId !== artifact.createdByAgentId ||
      manifest.scope.roomId !== artifact.roomId) return fail("EXECUTION_INPUT_PROVENANCE_INVALID");
    const bindings = manifest.inputs.map((binding) => {
      const stored = this.inputs.get(binding.bindingId);
      if (!stored || canonicalExecutionJSON(stored.binding) !== canonicalExecutionJSON(binding) ||
        binding.destinationRunId !== artifact.sourceRunId || binding.destinationTaskId !== artifact.taskId ||
        binding.destinationAgentId !== artifact.createdByAgentId || binding.destinationDeviceId !== principal.deviceId ||
        stored.planDigest !== manifest.scope.planDigest || stored.approvalOperationId !== manifest.scope.approvalOperationId ||
        stored.controlRevision !== manifest.scope.planControlRevision || stored.nodeKey !== manifest.scope.nodeKey ||
        binding.planId !== manifest.scope.planId || binding.planRevision !== manifest.scope.planRevision) {
        return fail("EXECUTION_INPUT_PROVENANCE_INVALID");
      }
      return binding;
    });
    this.inputs.recordArtifactInputs(artifact.artifactId, bindings, now);
  }

  public readForDevice(principal: DevicePrincipal, runId: string, bindingId: string, now: string) {
    let input: StoredExecutionInput, artifact: TaskArtifactRecord;
    try {
      const stored = this.inputs.get(bindingId);
      if (!stored) return deny();
      input = stored;
      const { binding } = input;
      if (binding.destinationRunId !== runId || binding.destinationDeviceId !== principal.deviceId ||
        !Number.isFinite(Date.parse(now)) || Date.parse(binding.expiresAt) <= Date.parse(now) ||
        Date.parse(binding.issuedAt) > Date.parse(now)) return deny();
      const plan = this.plans.get(binding.planId);
      if (!plan || !["approved", "running", "paused", "review"].includes(plan.state) ||
        plan.current.revision !== binding.planRevision || plan.current.digest !== input.planDigest) return deny();
      const destination = this.destination(plan, input.nodeKey, runId, principal.deviceId);
      if (destination.team_id !== principal.teamId || destination.owner_member_id !== principal.ownerMemberId ||
        Date.parse(destination.deadline_at) <= Date.parse(now)) return deny();
      const delivery = this.database.prepare(`SELECT payload_json FROM run_deliveries
        WHERE run_id = ? AND device_id = ? AND state IN ('pending', 'accepted')`)
        .get(runId, principal.deviceId) as { payload_json: string } | undefined;
      if (!delivery || !destination.context_manifest_json) return deny();
      const envelope = JSON.parse(delivery.payload_json);
      const manifest = envelope.contextManifest?.execution as GovernedExecutionManifest | undefined;
      assertExecutionCommand("executionManifest", manifest);
      if (!manifest) return deny();
      const canonical = JSON.parse(destination.context_manifest_json);
      const { manifestDigest, ...unsigned } = manifest;
      const scope = manifest.scope;
      if (executionOperationDigest(unsigned) !== manifestDigest || executionOperationDigest(manifest.inputs) !== manifest.inputDigest ||
        canonicalExecutionJSON(canonical) !== canonicalExecutionJSON(envelope.contextManifest) ||
        envelope.runId !== runId || envelope.targetAgentId !== destination.target_agent_id ||
        canonical.runId !== runId || canonical.taskId !== destination.task_id || scope.nodeKey !== input.nodeKey ||
        canonical.taskRevision !== scope.taskRevision || canonical.definitionRevision !== scope.definitionRevision ||
        canonical.criteriaRevision !== scope.criteriaRevision || canonical.target?.agentId !== destination.target_agent_id ||
        canonical.target?.deviceId !== principal.deviceId ||
        scope.runId !== runId || scope.taskId !== destination.task_id || scope.agentId !== destination.target_agent_id ||
        scope.deviceId !== principal.deviceId || scope.roomId !== plan.roomId || scope.planId !== plan.planId ||
        scope.planRevision !== binding.planRevision || scope.planDigest !== input.planDigest ||
        scope.planControlRevision !== input.controlRevision || scope.approvalOperationId !== input.approvalOperationId ||
        scope.definitionRevision !== destination.definition_revision || scope.criteriaRevision !== destination.criteria_revision ||
        manifest.inputs.filter((entry) => entry.bindingId === bindingId).length !== 1 ||
        canonicalExecutionJSON(manifest.inputs.find((entry) => entry.bindingId === bindingId)) !== canonicalExecutionJSON(binding)) return deny();
      if (binding.edgeKey !== null) {
        if (!binding.sourceAuthority) return deny();
        const source = this.materializedSource(
          binding.gate,
          binding.planId,
          binding.planRevision,
          binding.sourceTaskId,
          binding.sourceResultId,
          binding.sourceAuthority,
          binding.artifact.artifactId,
          binding.sourceOutputSlot,
          plan.roomId
        );
        const gateDigest = materializedGateDigest(source);
        if (
          gateDigest !== binding.gateDigest ||
          source.gate_operation_id !== binding.gateOperationId ||
          source.candidate_commit !== binding.sourceCommit ||
          source.candidate_tree !== binding.sourceTree
        ) return deny();
      } else {
        if (!binding.sourceResultId || binding.sourceAuthority) return deny();
        const source = this.acceptedSource(
          binding.sourceTaskId,
          binding.sourceResultId!,
          binding.artifact.artifactId,
          plan.roomId
        );
        if (
          executionOperationDigest(source) !== binding.gateDigest ||
          source.operation_id !== binding.gateOperationId ||
          binding.sourceCommit !== null || binding.sourceTree !== null
        ) return deny();
      }
      artifact = this.sealedArtifact(binding.artifact.artifactId, binding.sourceTaskId, plan.roomId);
      if (artifact.contentId !== input.contentId || artifact.artifactRevision !== binding.artifact.artifactRevision ||
        artifact.contentSha256 !== binding.artifact.contentDigest || artifact.contentSizeBytes !== binding.artifact.byteLength ||
        artifact.type !== binding.artifact.kind) return deny();
    } catch { return deny(); }
    const content = input.contentId && this.contents.getContent(input.contentId);
    if (!content || content.teamId !== principal.teamId) return deny();
    try {
      return { binding: input.binding, mediaType: artifact.contentMediaType!,
        bytes: this.blobs.readVerified(content.storageKey, input.binding.artifact.contentDigest, input.binding.artifact.byteLength) };
    } catch { throw new ExecutionError("EXECUTION_INPUT_CONTENT_UNAVAILABLE", 409); }
  }

  private destination(plan: ExecutionPlanProjection, nodeKey: string, runId: string, deviceId: string): Destination {
    const row = this.database.prepare(`SELECT run.task_id, run.target_agent_id, agent.device_id,
      agent.owner_member_id, run.room_id, room.team_id, task.definition_revision, task.criteria_revision,
      task.task_revision, run.deadline_at, run.context_manifest_json
      FROM runs run JOIN agent_tasks task ON task.task_id = run.task_id
      JOIN rooms room ON room.room_id = run.room_id AND room.archived_at IS NULL
      JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
      JOIN room_human_participants task_owner ON task_owner.room_id = room.room_id AND task_owner.member_id = task.owner_member_id
      JOIN agent_tasks root ON root.task_id = @rootTaskId AND root.room_id = room.room_id
        AND root.owner_member_id = @rootOwner AND root.lifecycle_state NOT IN ('completed', 'canceled')
      JOIN room_human_participants root_owner ON root_owner.room_id = room.room_id AND root_owner.member_id = root.owner_member_id
      JOIN agents agent ON agent.agent_id = run.target_agent_id AND agent.enabled = 1 AND agent.integration_mode = 'managed'
      JOIN devices device ON device.device_id = agent.device_id AND device.status = 'active'
      JOIN team_members member ON member.member_id = agent.owner_member_id AND member.team_id = room.team_id
      JOIN room_human_participants human ON human.room_id = room.room_id AND human.member_id = member.member_id
      JOIN room_agent_participants participant ON participant.room_id = room.room_id AND participant.agent_id = agent.agent_id
      JOIN execution_plan_nodes node ON node.plan_id = @planId AND node.revision = @revision
        AND node.node_key = @nodeKey AND node.task_id = task.task_id AND node.agent_id = agent.agent_id
      JOIN execution_plan_task_claims claim ON claim.task_id = task.task_id AND claim.plan_id = node.plan_id
        AND claim.revision = node.revision AND claim.node_key = node.node_key
      WHERE run.run_id = @runId AND agent.device_id = @deviceId AND run.room_id = @roomId AND task.room_id = run.room_id
        AND device.owner_member_id = member.member_id AND device.team_id = room.team_id AND agent.team_id = room.team_id
        AND task.lifecycle_state IN ('ready', 'active', 'review')
        AND run.state IN ('queued', 'delivered', 'working', 'input_required')
        AND task.definition_revision = node.definition_revision AND task.criteria_revision = node.criteria_revision
        AND task.owner_member_id = node.owner_member_id
        AND EXISTS (SELECT 1 FROM task_agent_assignments assignment WHERE assignment.task_id = task.task_id
          AND assignment.agent_id = agent.agent_id)
    `).get({ planId: plan.planId, revision: plan.current.revision, nodeKey, runId, deviceId, roomId: plan.roomId,
      rootTaskId: plan.rootTaskId, rootOwner: plan.ownerMemberId }) as Destination | undefined;
    return row ?? fail("EXECUTION_INPUT_DESTINATION_UNAVAILABLE");
  }

  private acceptedSource(taskId: string, resultId: string, artifactId: string, roomId: string): AcceptedSource {
    const source = this.database.prepare(`SELECT result.task_id, result.result_version, result.definition_revision,
      result.criteria_revision, review.operation_id, review.reviewed_by_member_id, review.reviewed_at
      FROM task_results result JOIN result_reviews review ON review.result_id = result.result_id
      JOIN agent_tasks task ON task.task_id = result.task_id
      JOIN room_human_participants owner ON owner.room_id = task.room_id AND owner.member_id = task.owner_member_id
      JOIN result_evidence_refs evidence ON evidence.result_id = result.result_id AND evidence.evidence_kind = 'artifact'
        AND evidence.artifact_id = @artifactId
      WHERE result.result_id = @resultId AND result.task_id = @taskId AND result.room_id = @roomId
        AND result.state = 'accepted' AND review.decision = 'accepted' AND task.lifecycle_state <> 'canceled'
        AND task.definition_revision = result.definition_revision AND task.criteria_revision = result.criteria_revision
    `).get({ taskId, resultId, artifactId, roomId }) as AcceptedSource | undefined;
    return source ?? fail("EXECUTION_INPUT_SOURCE_UNAVAILABLE");
  }

  private materializedSource(
    gate: "accepted_result" | "verified_output" | "integrated_commit",
    planId: string,
    planRevision: number,
    taskId: string,
    resultId: string | null,
    authority: NonNullable<ExecutionInputBinding["sourceAuthority"]> | undefined,
    artifactId: string,
    outputSlot: string,
    roomId: string
  ): MaterializedSource {
    const source = this.database.prepare(`
      SELECT node.task_id, result.result_version,
        node.definition_revision, node.criteria_revision,
        materialization.gate, materialization.adoption_id,
        materialization.adoption_digest,
        materialization.source_evidence_id,
        materialization.source_digest,
        materialization.gate_operation_id,
        materialization.materialization_digest,
        CASE WHEN EXISTS (
          SELECT 1 FROM execution_carried_evidence_adoptions carried
          WHERE carried.adoption_id = materialization.adoption_id
            AND carried.adoption_digest = materialization.adoption_digest
            AND carried.plan_id = materialization.plan_id
            AND carried.plan_revision = materialization.plan_revision
            AND carried.node_key = materialization.node_key
        ) OR EXISTS (
          SELECT 1 FROM execution_remote_evidence_adoptions remote
          WHERE remote.adoption_id = materialization.adoption_id
            AND remote.adoption_digest = materialization.adoption_digest
            AND remote.plan_id = materialization.plan_id
            AND remote.plan_revision = materialization.plan_revision
            AND remote.node_key = materialization.node_key
        ) THEN 1 ELSE 0 END AS adoption_native,
        materialization.candidate_commit, materialization.candidate_tree,
        review.operation_id, review.reviewed_by_member_id, review.reviewed_at
      FROM execution_all_adopted_node_materializations materialization
      JOIN execution_plan_nodes node ON node.plan_id = materialization.plan_id
        AND node.revision = materialization.plan_revision
        AND node.node_key = materialization.node_key
        AND node.task_id = @taskId
      JOIN agent_tasks task ON task.task_id = node.task_id
        AND task.room_id = @roomId AND task.lifecycle_state <> 'canceled'
        AND task.definition_revision = node.definition_revision
        AND task.criteria_revision = node.criteria_revision
      LEFT JOIN task_results result
        ON result.result_id = materialization.source_result_id
        AND result.task_id = node.task_id
        AND result.result_version = materialization.source_result_version
        AND result.definition_revision = node.definition_revision
        AND result.criteria_revision = node.criteria_revision
        AND result.room_id = @roomId
      LEFT JOIN result_reviews review
        ON materialization.gate = 'accepted_result'
        AND review.result_id = result.result_id
        AND review.operation_id = materialization.gate_operation_id
        AND review.decision = 'accepted'
      JOIN json_each(materialization.artifact_pins_json) pin
        ON json_extract(pin.value, '$.artifactId') = @artifactId
        AND json_extract(pin.value, '$.outputSlot') = @outputSlot
      JOIN task_artifact_refs artifact ON artifact.artifact_id = @artifactId
        AND artifact.task_id = node.task_id AND artifact.room_id = @roomId
        AND artifact.content_mode = 'snapshot_blob'
      WHERE materialization.plan_id = @planId
        AND materialization.plan_revision = @planRevision
        AND materialization.gate = @gate
        AND materialization.source_result_id IS @resultId
        AND (@sourceEvidenceId IS NULL OR
          (materialization.source_evidence_id = @sourceEvidenceId
            AND materialization.source_digest = @sourceDigest
            AND materialization.adoption_id = @adoptionId
            AND materialization.adoption_digest = @adoptionDigest))
        AND (
          (materialization.source_result_id IS NULL AND result.result_id IS NULL) OR
          (materialization.source_result_id IS NOT NULL AND result.result_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM result_evidence_refs evidence
              WHERE evidence.result_id = result.result_id
                AND evidence.evidence_kind = 'artifact'
                AND evidence.artifact_id = artifact.artifact_id
            ))
        )
    `).get({
      planId,
      planRevision,
      gate,
      taskId,
      resultId,
      sourceEvidenceId: authority?.sourceEvidenceId ?? null,
      sourceDigest: authority?.sourceDigest ?? null,
      adoptionId: authority?.adoptionId ?? null,
      adoptionDigest: authority?.adoptionDigest ?? null,
      artifactId,
      outputSlot,
      roomId
    }) as MaterializedSource | undefined;
    return source ?? fail("EXECUTION_INPUT_SOURCE_UNAVAILABLE");
  }

  private sealedArtifact(artifactId: string, taskId: string, roomId: string): TaskArtifactRecord {
    const artifact = this.artifacts.get(artifactId);
    const content = artifact?.contentId && this.contents.getContent(artifact.contentId);
    const room = this.database.prepare("SELECT team_id FROM rooms WHERE room_id = ?").get(roomId) as { team_id: string } | undefined;
    if (!artifact || artifact.taskId !== taskId || artifact.roomId !== roomId || artifact.contentMode !== "snapshot_blob" ||
      !content || content.sha256 !== artifact.contentSha256 || content.sizeBytes !== artifact.contentSizeBytes ||
      !room || content.teamId !== room.team_id || !artifact.contentMediaType || content.sizeBytes < 1 ||
      content.sizeBytes > (4 << 20)) return fail("EXECUTION_INPUT_CONTENT_UNAVAILABLE");
    return artifact;
  }
}
