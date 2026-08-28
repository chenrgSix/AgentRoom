import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentProvisioningService } from
  "../src/registry/agent-provisioning-service.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-27T08:00:00.000Z";

test("Agent provisioning is owner-scoped, idempotent, and converges on publication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-provision-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  let database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const registry = new MemberDeviceService(core, auth);
    const agents = new AgentService(core, auth);
    const provisioning = new AgentProvisioningService(database, core, auth);
    const created = teams.createTeamForUser({
      userId: "user_provision_owner_12345678",
      userDisplayName: "Alice",
      teamName: "Provisioning Team",
      now
    });
    const ownerSession = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-27T09:00:00.000Z"
    );
    const owner = auth.authenticateWebSession(ownerSession.secret, now);
    const device = registry.registerOwnDevice(
      owner,
      created.team.teamId,
      "Alice Bridge",
      now
    );
    const template = agents.publishAgent(owner, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Implementation",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const bridge = auth.authenticateDevice(credential.secret, now);

    const request = provisioning.createRequest(owner, {
      requestId: "agentprov_request_12345678",
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      templateAgentId: template.agentId,
      name: "Reviewer",
      role: "Review",
      now
    });
    const retried = provisioning.createRequest(owner, {
      requestId: request.requestId,
      teamId: request.teamId,
      deviceId: request.deviceId,
      templateAgentId: request.templateAgentId,
      name: request.name,
      role: request.role,
      now
    });

    assert.equal(request.status, "pending");
    assert.equal(retried.agentId, request.agentId);
    assert.throws(() => provisioning.createRequest(owner, {
      requestId: request.requestId,
      teamId: request.teamId,
      deviceId: request.deviceId,
      templateAgentId: request.templateAgentId,
      name: "Changed",
      role: request.role,
      now
    }), /use a new request ID/u);

    provisioning.markDelivered(request.requestId, now);
    const accepted = provisioning.applyResult(bridge, {
      requestId: request.requestId,
      deviceId: device.deviceId,
      templateAgentId: template.agentId,
      agentId: request.agentId,
      status: "accepted"
    }, now);
    assert.equal(accepted.status, "accepted");

    const published = provisioning.convergePublishedAgent(
      bridge,
      request.agentId,
      now,
      () => agents.publishDeviceAgent(bridge, {
        agentId: request.agentId,
        name: request.name,
        role: request.role,
        capabilities: template.capabilities,
        now
      })
    );
    assert.equal(published.agentId, request.agentId);
    assert.equal(
      provisioning.listOwnRequests(owner, created.team.teamId)[0]?.status,
      "ready"
    );
    assert.equal(
      provisioning.listOwnRequests(owner, created.team.teamId)[0]?.agentId,
      request.agentId
    );

    const recoveredFailure = provisioning.createRequest(owner, {
      requestId: "agentprov_failed_publish_12345678",
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      templateAgentId: template.agentId,
      name: "Recovered Failure",
      role: "Recovery",
      now
    });
    provisioning.markDelivered(recoveredFailure.requestId, now);
    provisioning.applyResult(bridge, {
      requestId: recoveredFailure.requestId,
      deviceId: device.deviceId,
      templateAgentId: template.agentId,
      agentId: recoveredFailure.agentId,
      status: "rejected",
      reason: "configuration_failed"
    }, now);
    provisioning.convergePublishedAgent(
      bridge,
      recoveredFailure.agentId,
      now,
      () => agents.publishDeviceAgent(bridge, {
        agentId: recoveredFailure.agentId,
        name: recoveredFailure.name,
        role: recoveredFailure.role,
        capabilities: template.capabilities,
        now
      })
    );
    assert.equal(
      provisioning.listOwnRequests(owner, created.team.teamId).find(
        ({ requestId }) => requestId === recoveredFailure.requestId
      )?.status,
      "ready"
    );

    const rollbackRequest = provisioning.createRequest(owner, {
      requestId: "agentprov_atomic_rollback_12345678",
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      templateAgentId: template.agentId,
      name: "Atomic Rollback",
      role: "Recovery",
      now
    });
    provisioning.markDelivered(rollbackRequest.requestId, now);
    assert.throws(() => provisioning.convergePublishedAgent(
      bridge,
      rollbackRequest.agentId,
      now,
      () => {
        agents.publishDeviceAgent(bridge, {
          agentId: rollbackRequest.agentId,
          name: rollbackRequest.name,
          role: rollbackRequest.role,
          capabilities: template.capabilities,
          now
        });
        throw new Error("simulated request status write failure");
      }
    ), /simulated request status write failure/u);
    assert.equal(core.getAgent(rollbackRequest.agentId), undefined);
    assert.equal(
      provisioning.listOwnRequests(owner, created.team.teamId).find(
        ({ requestId }) => requestId === rollbackRequest.requestId
      )?.status,
      "delivered"
    );

    core.ensureUser({
      userId: "user_provision_foreign_12345678",
      displayName: "Mallory",
      createdAt: now
    });
    registry.addMember(owner, {
      teamId: created.team.teamId,
      userId: "user_provision_foreign_12345678",
      displayName: "Mallory",
      now
    });
    const foreignSession = auth.issueWebSession(
      "user_provision_foreign_12345678",
      now,
      "2026-08-27T09:00:00.000Z"
    );
    const foreign = auth.authenticateWebSession(foreignSession.secret, now);
    assert.throws(() => provisioning.createRequest(foreign, {
      requestId: "agentprov_foreign_12345678",
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      templateAgentId: template.agentId,
      name: "Intruder",
      role: "Denied",
      now
    }), /owned by the current Member/u);

    const columns = database.prepare(
      "PRAGMA table_info(agent_provision_requests)"
    ).all() as Array<{ name: string }>;
    assert.equal(columns.some(({ name }) => name.includes("code")), false);

    database.close();
    database = openDatabase(databasePath);
    const reloaded = new AgentProvisioningService(
      database,
      new CoreRepository(database),
      new AuthService(database)
    );
    assert.equal(
      reloaded.listOwnRequests(owner, created.team.teamId)[0]?.status,
      "ready"
    );
  } finally {
    database.close();
  }
});
