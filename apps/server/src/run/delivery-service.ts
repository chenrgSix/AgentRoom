import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type {
  ContextArtifactRef,
  ContextLongTermMemoryScope,
  ContextMemoryProjection,
  ContextPlanner,
  PlannedRoomContextBundle
} from "../task/context-planner.js";
import {
  ResultEvidenceConsumptionRepository
} from "../task/result-evidence-consumption-repository.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

interface DeliveryPayload {
  runId: string;
  traceId: string;
  roomId: string;
  taskId: string;
  session: {
    scope: "task";
    resumePolicy: "resume_or_start";
    contextCursor: number;
    runtimeScopeId?: string;
  };
  triggerMessageId: string;
  requesterMemberId: string;
  targetAgentId: string;
  targetAgentName?: string;
  deliveryAttemptId: string;
  idempotencyKey: string;
  parentRunId?: string;
  instruction: string;
  contextPlan: {
    roomMemory: ContextMemoryProjection;
    taskMemory: ContextMemoryProjection;
    resultEvidence?: {
      revision: number;
      deliveryKind: "bootstrap" | "delta";
      fromRevision: number;
      throughRevision: number;
      hasMore: boolean;
      artifactRefs: ContextArtifactRef[];
    };
    longTermMemory?: {
      room?: ContextLongTermMemoryScope;
      task?: ContextLongTermMemoryScope;
    };
  };
  contextMessages: Array<{
    messageId: string;
    sequence: number;
    senderId: string;
    senderName?: string;
    content: string;
  }>;
  roomContextBundle?: Omit<PlannedRoomContextBundle, "rawTail"> & {
    rawTail: Omit<PlannedRoomContextBundle["rawTail"], "messages"> & {
      messages: Array<{
        messageId: string;
        sequence: number;
        senderId: string;
        senderName?: string;
        content: string;
      }>;
    };
  };
  routingAgents?: Array<{ agentId: string; name: string }>;
  deadline: string;
}

interface DeliveryRow {
  delivery_attempt_id: string;
  trace_id: string;
  run_id: string;
  device_id: string;
  idempotency_key: string;
  payload_hash: string;
  payload_json: string;
  state: "pending" | "accepted";
  send_count: number;
  created_at: string;
  last_sent_at: string | null;
  accepted_at: string | null;
}

export interface DeliveryRecord {
  deliveryAttemptId: string;
  traceId: string;
  runId: string;
  deviceId: string;
  idempotencyKey: string;
  payloadHash: string;
  payload: DeliveryPayload;
  state: "pending" | "accepted";
  sendCount: number;
  createdAt: string;
  lastSentAt: string | null;
  acceptedAt: string | null;
}

export interface RoomContextConsumptionReceipt {
  baseContextCursor: number;
  checkpointId?: string;
  rawFromSequenceExclusive: number;
  rawThroughSequenceInclusive: number;
  rawMessageCount: number;
  coverageThroughSequence: number;
}

function mapDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    deliveryAttemptId: row.delivery_attempt_id,
    traceId: row.trace_id,
    runId: row.run_id,
    deviceId: row.device_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    payload: JSON.parse(row.payload_json) as DeliveryPayload,
    state: row.state,
    sendCount: row.send_count,
    createdAt: row.created_at,
    lastSentAt: row.last_sent_at,
    acceptedAt: row.accepted_at
  };
}

export class DeliveryService {
  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly contextPlanner: ContextPlanner,
    private readonly connections: BridgeConnectionRegistry,
    private readonly clock: () => string,
    private readonly evidenceConsumption = new ResultEvidenceConsumptionRepository(database)
  ) {}

  public dispatch(runId: string): DeliveryRecord | undefined {
    const run = this.runs.getRun(runId);
    if (run?.state === "queued" && Date.parse(run.deadlineAt) <= Date.parse(this.clock())) {
      this.runs.expireQueued(run.roomId, this.clock());
      return undefined;
    }
    const delivery = this.ensure(runId);
    if (!delivery || delivery.state === "accepted") {
      return delivery;
    }
    const sent = this.connections.send(delivery.deviceId, {
      protocolVersion: "1.0",
      messageId: createOpaqueId("msg"),
      timestamp: this.clock(),
      type: "run.requested",
      payload: delivery.payload
    });
    if (!sent) {
      return delivery;
    }
    this.database.prepare(`
      UPDATE run_deliveries
      SET send_count = send_count + 1, last_sent_at = ?
      WHERE delivery_attempt_id = ? AND state = 'pending'
    `).run(this.clock(), delivery.deliveryAttemptId);
    return this.getByRun(runId);
  }

  public dispatchQueuedForDevice(deviceId: string): void {
    const rows = this.database.prepare(`
      SELECT r.run_id
      FROM runs r
      JOIN agents a ON a.agent_id = r.target_agent_id
      WHERE a.device_id = ? AND r.state = 'queued'
      ORDER BY r.created_at, r.run_id
    `).all(deviceId) as Array<{ run_id: string }>;
    for (const row of rows) {
      this.dispatch(row.run_id);
    }
  }

  public accept(
    principal: DevicePrincipal,
    runId: string,
    traceId: string,
    agentId: string,
    sequence: number,
    now: string,
    artifactMaterializations?: unknown,
    artifactMaterializationError?: unknown
  ): RunRecord {
    if (sequence !== 1) {
      throw new Error("run.accepted must use sequence 1");
    }
    const run = this.runs.getRun(runId);
    const agent = this.core.getAgent(agentId);
    const delivery = this.getByRun(runId);
    if (
      !run ||
      !agent ||
      !delivery ||
      run.traceId !== traceId ||
      delivery.traceId !== traceId ||
      run.targetAgentId !== agentId ||
      agent.deviceId !== principal.deviceId ||
      agent.ownerMemberId !== principal.ownerMemberId ||
      delivery.deviceId !== principal.deviceId
    ) {
      throw new Error("Run acceptance identity mismatch");
    }
    this.validateArtifactMaterializations(
      delivery,
      artifactMaterializations,
      artifactMaterializationError
    );
    this.database.prepare(`
      UPDATE run_deliveries SET state = 'accepted', accepted_at = ?
      WHERE run_id = ? AND state = 'pending'
    `).run(now, runId);
    return this.runs.applyEvent(runId, {
      type: "status",
      sequence: 1,
      status: "delivered"
    }, now).run;
  }

  private validateArtifactMaterializations(
    delivery: DeliveryRecord,
    materializations: unknown,
    materializationError: unknown
  ): void {
    const expected = delivery.payload.contextPlan.resultEvidence?.artifactRefs
      .flatMap((reference) => reference.content
        ? [{ artifactId: reference.artifactId, ...reference.content }]
        : []) ?? [];
    if (materializationError !== undefined) {
      const failure = materializationError as Record<string, unknown>;
      if (
        expected.length === 0 || !failure || typeof failure !== "object" ||
        Array.isArray(failure) ||
        failure.code !== "ARTIFACT_MATERIALIZATION_FAILED" ||
        failure.retryable !== false ||
        failure.message !==
          "Pinned Artifact content could not be verified in isolated staging." ||
        (materializations !== undefined &&
          (!Array.isArray(materializations) || materializations.length !== 0))
      ) {
        throw new Error("Artifact materialization failure does not match delivery");
      }
      return;
    }
    if (!Array.isArray(materializations)) {
      if (expected.length === 0 && materializations === undefined) return;
      throw new Error("Artifact materialization receipts do not match delivery");
    }
    if (materializations.length !== expected.length) {
      throw new Error("Artifact materialization receipts do not match delivery");
    }
    const remaining = new Map(expected.map((receipt) => [receipt.artifactId, receipt]));
    for (const candidate of materializations) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Artifact materialization receipts do not match delivery");
      }
      const receipt = candidate as Record<string, unknown>;
      const artifactId = typeof receipt.artifactId === "string"
        ? receipt.artifactId
        : "";
      const pinned = remaining.get(artifactId);
      if (
        !pinned || receipt.contentId !== pinned.contentId ||
        receipt.logicalAlias !== pinned.logicalAlias ||
        receipt.mediaType !== pinned.mediaType ||
        receipt.sha256 !== pinned.sha256 ||
        receipt.sizeBytes !== pinned.sizeBytes ||
        (receipt.materializationState !== "verified" &&
          receipt.materializationState !== "reused")
      ) {
        throw new Error("Artifact materialization receipts do not match delivery");
      }
      remaining.delete(artifactId);
    }
    if (remaining.size !== 0) {
      throw new Error("Artifact materialization receipts do not match delivery");
    }
  }

  public getByRun(runId: string): DeliveryRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_deliveries WHERE run_id = ?
    `).get(runId) as DeliveryRow | undefined;
    return row && mapDelivery(row);
  }

  public validateRoomContextConsumption(
    runId: string,
    disposition: "started" | "resumed" | "recreated",
    contextCursor: number,
    receipt: RoomContextConsumptionReceipt
  ): void {
    const bundle = this.getByRun(runId)?.payload.roomContextBundle;
    const run = this.runs.getRun(runId);
    const agent = run && this.core.getAgent(run.targetAgentId);
    if (!bundle || !run || !agent?.capabilities.supportsRoomContextCoverage) {
      throw new Error("Run was not delivered with Room context coverage");
    }
    const values = [
      contextCursor,
      receipt.baseContextCursor,
      receipt.rawFromSequenceExclusive,
      receipt.rawThroughSequenceInclusive,
      receipt.rawMessageCount,
      receipt.coverageThroughSequence
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Room context consumption cursors are invalid");
    }
    if (
      receipt.rawMessageCount > 12 ||
      receipt.rawThroughSequenceInclusive !==
        bundle.rawTail.throughSequenceInclusive ||
      receipt.rawThroughSequenceInclusive - receipt.rawFromSequenceExclusive !==
        receipt.rawMessageCount ||
      contextCursor !== receipt.coverageThroughSequence ||
      receipt.coverageThroughSequence !== Math.max(
        receipt.baseContextCursor,
        bundle.targetThroughSequence
      ) ||
      receipt.coverageThroughSequence < bundle.targetThroughSequence ||
      receipt.coverageThroughSequence > this.core.latestMessageSequence(run.roomId)
    ) {
      throw new Error("Room context consumption does not match its delivered interval");
    }
    if (
      (disposition === "started" || disposition === "recreated") &&
      receipt.baseContextCursor !== 0
    ) {
      throw new Error("A new Runtime session cannot inherit a Room context cursor");
    }
    const checkpoint = bundle.checkpoint;
    const shouldConsumeCheckpoint = checkpoint !== undefined &&
      (disposition !== "resumed" ||
        checkpoint.throughSequence > receipt.baseContextCursor);
    if (
      (shouldConsumeCheckpoint && receipt.checkpointId !== checkpoint?.checkpointId) ||
      (!shouldConsumeCheckpoint && receipt.checkpointId !== undefined)
    ) {
      throw new Error("Room context checkpoint receipt does not match delivery");
    }
    const expectedRawFrom = shouldConsumeCheckpoint
      ? bundle.rawTail.fromSequenceExclusive
      : Math.min(
          Math.max(
            receipt.baseContextCursor,
            bundle.rawTail.fromSequenceExclusive
          ),
          bundle.rawTail.throughSequenceInclusive
        );
    if (receipt.rawFromSequenceExclusive !== expectedRawFrom) {
      throw new Error("Room context raw receipt does not match delivery");
    }
  }

  private ensure(runId: string): DeliveryRecord | undefined {
    const existing = this.getByRun(runId);
    if (existing) {
      return existing;
    }
    const run = this.runs.getRun(runId);
    if (!run || run.state !== "queued") {
      return undefined;
    }
    const agent = this.core.getAgent(run.targetAgentId);
    const trigger = this.core.getMessage(run.triggerMessageId);
    if (
      !agent ||
      agent.integrationMode !== "managed" ||
      !agent.deviceId ||
      !trigger
    ) {
      return undefined;
    }
    const deliveryAttemptId = createOpaqueId("delivery");
    const idempotencyKey = createOpaqueId("idem");
    const evidenceAfterRevision = agent.runtimeScopeId
      ? this.evidenceConsumption.get(
          run.taskId,
          agent.agentId,
          agent.runtimeScopeId
      )
      : undefined;
    const contextFence = this.runs.getContextFence(run.runId);
    const plannedContext = this.contextPlanner.plan({
      roomId: run.roomId,
      taskId: run.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId,
      ...(evidenceAfterRevision !== undefined
        ? { resultEvidenceAfterRevision: evidenceAfterRevision }
        : {}),
      ...(contextFence ? { contextFence } : {})
    }, this.clock());
    const roomContextBundle = agent.capabilities.supportsRoomContextCoverage
      ? plannedContext.roomContextBundle
      : undefined;
    const contextPlan = agent.capabilities.supportsArtifactMaterialization
      ? plannedContext.contextPlan
      : {
          ...plannedContext.contextPlan,
          ...(plannedContext.contextPlan.resultEvidence
            ? {
                resultEvidence: {
                  ...plannedContext.contextPlan.resultEvidence,
                  artifactRefs: plannedContext.contextPlan.resultEvidence.artifactRefs.map(
                    ({ content: _content, ...reference }) => reference
                  )
                }
              }
            : {})
        };
    const payload: DeliveryPayload = {
      runId: run.runId,
      traceId: run.traceId,
      roomId: run.roomId,
      taskId: run.taskId,
      session: {
        scope: "task",
        resumePolicy: "resume_or_start",
        contextCursor: trigger.sequence,
        ...(agent.runtimeScopeId ? { runtimeScopeId: agent.runtimeScopeId } : {})
      },
      triggerMessageId: run.triggerMessageId,
      requesterMemberId: run.requesterMemberId,
      targetAgentId: run.targetAgentId,
      targetAgentName: agent.name,
      deliveryAttemptId,
      idempotencyKey,
      ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      instruction: run.instruction,
      contextPlan,
      contextMessages: roomContextBundle
        ? []
        : plannedContext.contextMessages.map((message) =>
            this.contextMessage(message)
          ),
      ...(roomContextBundle
        ? {
            roomContextBundle: {
              ...roomContextBundle,
              rawTail: {
                ...roomContextBundle.rawTail,
                messages: roomContextBundle.rawTail.messages.map((message) =>
                  this.contextMessage(message)
                )
              }
            }
          }
        : {}),
      routingAgents: this.core.getRoom(run.roomId)?.collaborationPolicy
        .allowAgentMentions
        ? this.core.listAgents(agent.teamId)
          .filter((candidate) =>
            candidate.enabled &&
            candidate.agentId !== agent.agentId &&
            this.core.isRoomAgent(run.roomId, candidate.agentId)
          )
          .sort((left, right) => left.name === right.name
            ? left.agentId.localeCompare(right.agentId)
            : left.name.localeCompare(right.name)
          )
          .slice(0, 20)
          .map((candidate) => ({
            agentId: candidate.agentId,
            name: candidate.name
          }))
        : [],
      deadline: run.deadlineAt
    };
    const payloadJson = JSON.stringify(payload);
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    this.database.prepare(`
      INSERT INTO run_deliveries (
        delivery_attempt_id, trace_id, run_id, device_id, idempotency_key,
        payload_hash, payload_json, state, send_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(
      deliveryAttemptId,
      run.traceId,
      run.runId,
      agent.deviceId,
      idempotencyKey,
      payloadHash,
      payloadJson,
      this.clock()
    );
    return this.getByRun(runId);
  }

  private contextMessage(message: {
    messageId: string;
    sequence: number;
    senderType: "member" | "agent" | "system";
    senderId: string;
    content: string;
  }): {
    messageId: string;
    sequence: number;
    senderId: string;
    senderName: string;
    content: string;
  } {
    return {
      messageId: message.messageId,
      sequence: message.sequence,
      senderId: message.senderId,
      senderName: message.senderType === "member"
        ? this.core.getMember(message.senderId)?.displayName ?? "Member"
        : message.senderType === "agent"
          ? this.core.getAgent(message.senderId)?.name ?? "Agent"
          : "Agent Room",
      content: message.content
    };
  }
}
