import type { AgentProvisionResultPayload } from
  "@agent-room/contracts/bridge-messages";
import type Database from "better-sqlite3";

import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type DevicePrincipal,
  type WebPrincipal
} from "../security/auth-service.js";

export type AgentProvisionRequestStatus =
  | "pending"
  | "delivered"
  | "accepted"
  | "ready"
  | "rejected";

export type AgentProvisionRejectionReason = NonNullable<
  AgentProvisionResultPayload["reason"]
>;

export interface AgentProvisionRequestRecord {
  requestId: string;
  teamId: string;
  deviceId: string;
  templateAgentId: string;
  agentId: string;
  requestedByMemberId: string;
  name: string;
  role: string;
  status: AgentProvisionRequestStatus;
  rejectionReason: AgentProvisionRejectionReason | null;
  createdAt: string;
  deliveredAt: string | null;
  respondedAt: string | null;
  readyAt: string | null;
  updatedAt: string;
}

interface AgentProvisionRequestRow {
  request_id: string;
  team_id: string;
  device_id: string;
  template_agent_id: string;
  agent_id: string;
  requested_by_member_id: string;
  name: string;
  role: string;
  status: AgentProvisionRequestStatus;
  rejection_reason: AgentProvisionRejectionReason | null;
  created_at: string;
  delivered_at: string | null;
  responded_at: string | null;
  ready_at: string | null;
  updated_at: string;
}

function normalizedLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error(`${label} must contain 1 to 80 characters`);
  }
  return normalized;
}

function mapRow(row: AgentProvisionRequestRow): AgentProvisionRequestRecord {
  return {
    requestId: row.request_id,
    teamId: row.team_id,
    deviceId: row.device_id,
    templateAgentId: row.template_agent_id,
    agentId: row.agent_id,
    requestedByMemberId: row.requested_by_member_id,
    name: row.name,
    role: row.role,
    status: row.status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    respondedAt: row.responded_at,
    readyAt: row.ready_at,
    updatedAt: row.updated_at
  };
}

export class AgentProvisioningService {
  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public createRequest(
    principal: WebPrincipal,
    input: {
      requestId: string;
      teamId: string;
      deviceId: string;
      templateAgentId: string;
      name: string;
      role: string;
      now: string;
    }
  ): AgentProvisionRequestRecord {
    if (!/^agentprov_[A-Za-z0-9_-]{8,128}$/u.test(input.requestId)) {
      throw new Error("Agent provisioning request ID is invalid");
    }
    const actor = this.auth.requireTeamMember(principal, input.teamId);
    const name = normalizedLabel(input.name, "Agent name");
    const role = normalizedLabel(input.role, "Agent role");
    const device = this.core.getDevice(input.deviceId);
    const template = this.core.getAgent(input.templateAgentId);
    if (
      !device ||
      device.teamId !== input.teamId ||
      device.ownerMemberId !== actor.memberId ||
      device.status !== "active"
    ) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Agent provisioning requires an active Device owned by the current Member"
      );
    }
    if (
      !template ||
      template.teamId !== input.teamId ||
      template.ownerMemberId !== actor.memberId ||
      template.deviceId !== device.deviceId ||
      template.integrationMode !== "managed" ||
      !template.enabled
    ) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Agent provisioning template ownership denied"
      );
    }

    const existing = this.get(input.requestId);
    if (existing) {
      if (
        existing.teamId !== input.teamId ||
        existing.requestedByMemberId !== actor.memberId ||
        existing.deviceId !== input.deviceId ||
        existing.templateAgentId !== input.templateAgentId ||
        existing.name !== name ||
        existing.role !== role
      ) {
        throw new Error("Agent provisioning request changed; use a new request ID");
      }
      return existing;
    }

    const agentId = createOpaqueId("agent");
    this.database.prepare(`
      INSERT INTO agent_provision_requests (
        request_id, team_id, device_id, template_agent_id, agent_id,
        requested_by_member_id, name, role, status, rejection_reason,
        created_at, delivered_at, responded_at, ready_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL, NULL, ?)
    `).run(
      input.requestId,
      input.teamId,
      input.deviceId,
      input.templateAgentId,
      agentId,
      actor.memberId,
      name,
      role,
      input.now,
      input.now
    );
    return this.require(input.requestId);
  }

  public markDelivered(requestId: string, now: string): AgentProvisionRequestRecord {
    this.database.prepare(`
      UPDATE agent_provision_requests
      SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?),
          updated_at = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(now, now, requestId);
    return this.require(requestId);
  }

  public applyResult(
    principal: DevicePrincipal,
    payload: AgentProvisionResultPayload,
    now: string
  ): AgentProvisionRequestRecord {
    const request = this.require(payload.requestId);
    if (
      request.teamId !== principal.teamId ||
      request.deviceId !== principal.deviceId ||
      request.deviceId !== payload.deviceId ||
      request.templateAgentId !== payload.templateAgentId ||
      request.agentId !== payload.agentId
    ) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Agent provisioning result identity denied"
      );
    }
    if (request.status === "ready") return request;
    if (request.status === "accepted" && payload.status === "accepted") {
      return request;
    }
    if (
      request.status === "rejected" &&
      payload.status === "rejected" &&
      request.rejectionReason === payload.reason
    ) {
      return request;
    }
    if (!["pending", "delivered"].includes(request.status)) {
      throw new Error("Agent provisioning result conflicts with terminal state");
    }
    if (payload.status === "rejected" && payload.reason === undefined) {
      throw new Error("Rejected Agent provisioning result requires a reason");
    }
    if (payload.status === "accepted" && payload.reason !== undefined) {
      throw new Error("Accepted Agent provisioning result cannot include a reason");
    }
    this.database.prepare(`
      UPDATE agent_provision_requests
      SET status = ?, rejection_reason = ?, responded_at = ?, updated_at = ?
      WHERE request_id = ? AND status IN ('pending', 'delivered')
    `).run(
      payload.status,
      payload.status === "rejected" ? payload.reason : null,
      now,
      now,
      request.requestId
    );
    return this.require(request.requestId);
  }

  public markReadyForPublishedAgent(
    principal: DevicePrincipal,
    agentId: string,
    now: string
  ): AgentProvisionRequestRecord | undefined {
    const request = this.database.prepare(`
      SELECT * FROM agent_provision_requests WHERE agent_id = ?
    `).get(agentId) as AgentProvisionRequestRow | undefined;
    if (!request) return undefined;
    if (
      request.team_id !== principal.teamId ||
      request.device_id !== principal.deviceId ||
      request.requested_by_member_id !== principal.ownerMemberId
    ) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Published Agent provisioning identity denied"
      );
    }
    if (request.status === "ready") return mapRow(request);
    if (request.status !== "accepted") {
      throw new Error("Provisioned Agent published before local acceptance");
    }
    this.database.prepare(`
      UPDATE agent_provision_requests
      SET status = 'ready', ready_at = ?, updated_at = ?
      WHERE request_id = ? AND status = 'accepted'
    `).run(now, now, request.request_id);
    return this.require(request.request_id);
  }

  public listOwnRequests(
    principal: WebPrincipal,
    teamId: string
  ): AgentProvisionRequestRecord[] {
    const actor = this.auth.requireTeamMember(principal, teamId);
    return (this.database.prepare(`
      SELECT * FROM agent_provision_requests
      WHERE team_id = ? AND requested_by_member_id = ?
      ORDER BY created_at DESC, request_id DESC
    `).all(teamId, actor.memberId) as AgentProvisionRequestRow[]).map(mapRow);
  }

  private get(requestId: string): AgentProvisionRequestRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agent_provision_requests WHERE request_id = ?
    `).get(requestId) as AgentProvisionRequestRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  private require(requestId: string): AgentProvisionRequestRecord {
    const request = this.get(requestId);
    if (!request) throw new Error(`Agent provisioning request not found: ${requestId}`);
    return request;
  }
}
