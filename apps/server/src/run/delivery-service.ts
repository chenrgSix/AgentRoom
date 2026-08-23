import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

interface DeliveryPayload {
  runId: string;
  traceId: string;
  roomId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  targetAgentId: string;
  deliveryAttemptId: string;
  idempotencyKey: string;
  parentRunId?: string;
  instruction: string;
  contextMessages: Array<{
    messageId: string;
    senderId: string;
    content: string;
  }>;
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
    private readonly connections: BridgeConnectionRegistry,
    private readonly clock: () => string
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
    now: string
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

  public getByRun(runId: string): DeliveryRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_deliveries WHERE run_id = ?
    `).get(runId) as DeliveryRow | undefined;
    return row && mapDelivery(row);
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
    const payload: DeliveryPayload = {
      runId: run.runId,
      traceId: run.traceId,
      roomId: run.roomId,
      triggerMessageId: run.triggerMessageId,
      requesterMemberId: run.requesterMemberId,
      targetAgentId: run.targetAgentId,
      deliveryAttemptId,
      idempotencyKey,
      ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      instruction: run.instruction,
      contextMessages: this.core
        .listMessagesThrough(run.roomId, trigger.sequence, 50)
        .map((message) => ({
          messageId: message.messageId,
          senderId: message.senderId,
          content: message.content
        })),
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
}
