import type { AgentProvisionRequestedMessage } from
  "@convene-wire/contracts/bridge-messages";

import { createOpaqueId } from "../domain/identifiers.js";
import { FakeRuntimeAdapter } from "../runtime/fake-runtime-adapter.js";
import {
  bodyObject,
  noStore,
  requiredBoolean,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerRegistryRoutes({
  agentProvisioning,
  agents,
  app,
  auth,
  bridgeConnections,
  clock,
  core,
  deviceRevocation,
  fakeAdapters,
  limitAnonymous,
  pairing,
  presence,
  principal,
  registry,
  requireBridgeServerToken,
  trustedWeb
}: ServerRouteContext): void {
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/devices",
    async (request) => registry.listDevices(
      principal(request),
      request.params.teamId
    ).map((device) => ({
      ...device,
      supportsAgentProvisioning:
        bridgeConnections.supportsAgentProvisioning(device.deviceId)
    }))
  );
  app.patch<{ Params: { agentId: string } }>(
    "/api/agents/:agentId",
    async (request) => {
      const body = bodyObject(request);
      const enabled = requiredBoolean(body.enabled, "enabled");
      return agents.setEnabled(principal(request), request.params.agentId, enabled, clock());
    }
  );
  app.delete<{ Params: { teamId: string; deviceId: string } }>(
    "/api/teams/:teamId/devices/:deviceId",
    async (request) => {
      const device = deviceRevocation.revoke(
        principal(request),
        request.params.teamId,
        request.params.deviceId
      );
      return device;
    }
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/members",
    async (request) => registry.listMembers(principal(request), request.params.teamId)
  );
  if (trustedWeb) {
    app.post<{ Params: { teamId: string } }>(
      "/api/teams/:teamId/member-invitations",
      async (request, reply) => {
        const body = bodyObject(request);
        const invitation = trustedWeb.createMemberInvitation(
          principal(request),
          request.params.teamId,
          requiredString(body.displayName, "displayName"),
          clock()
        );
        noStore(reply);
        return invitation;
      }
    );
  } else {
    app.post<{ Params: { teamId: string } }>(
      "/api/teams/:teamId/members",
      async (request) => {
        const body = bodyObject(request);
        return registry.addMember(principal(request), {
          teamId: request.params.teamId,
          userId: requiredString(body.userId, "userId", 140),
          displayName: requiredString(body.displayName, "displayName"),
          now: clock()
        });
      }
    );
  }
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/agents",
    async (request) => presence.listAgents(
      principal(request),
      request.params.teamId,
      clock()
    )
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/agent-provision-requests",
    async (request) => agentProvisioning.listOwnRequests(
      principal(request),
      request.params.teamId
    )
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/agent-provision-requests",
    async (request) => {
      const body = bodyObject(request);
      const managementCode = requiredString(
        body.managementCode,
        "managementCode",
        8
      );
      if (!/^(?:[0-9]{6}|[0-9]{8})$/u.test(managementCode)) {
        throw new Error("Management code must contain exactly 6 or 8 digits");
      }
      const deviceId = requiredString(body.deviceId, "deviceId", 140);
      const templateAgentId = requiredString(
        body.templateAgentId,
        "templateAgentId",
        140
      );
      agentProvisioning.requireEligibleTarget(principal(request), {
        teamId: request.params.teamId,
        deviceId,
        templateAgentId
      });
      if (
        bridgeConnections.activeEpoch(deviceId) !== undefined &&
        !bridgeConnections.supportsAgentProvisioning(deviceId)
      ) {
        throw new Error(
          "Agent provisioning conflict: Bridge upgrade required"
        );
      }
      const now = clock();
      const provision = agentProvisioning.createRequest(principal(request), {
        requestId: requiredString(body.requestId, "requestId", 140),
        teamId: request.params.teamId,
        deviceId,
        templateAgentId,
        name: requiredString(body.name, "name"),
        role: requiredString(body.role, "role"),
        now
      });
      if (
        ["accepted", "ready"].includes(provision.status) ||
        (provision.status === "rejected" &&
          provision.rejectionReason !== "configuration_failed")
      ) {
        return provision;
      }
      const message: AgentProvisionRequestedMessage = {
        protocolVersion: "1.0",
        messageId: createOpaqueId("msg"),
        timestamp: now,
        type: "agent.provision.requested",
        payload: {
          requestId: provision.requestId,
          deviceId: provision.deviceId,
          templateAgentId: provision.templateAgentId,
          agentId: provision.agentId,
          name: provision.name,
          role: provision.role,
          managementCode
        }
      };
      if (!bridgeConnections.send(provision.deviceId, message)) {
        throw new Error(
          "Agent provisioning conflict: Bridge is offline; retry with the same request ID"
        );
      }
      return agentProvisioning.markDelivered(provision.requestId, now);
    }
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/fake-agents",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const now = clock();
      const name = requiredString(body.name, "name");
      const device = registry.registerOwnDevice(
        actor,
        request.params.teamId,
        `${name} Fake Bridge`,
        now
      );
      const agent = agents.publishAgent(actor, {
        teamId: request.params.teamId,
        deviceId: device.deviceId,
        name,
        role: requiredString(body.role, "role"),
        integrationMode: "fake",
        capabilities: {
          supportsHandoff: true,
          supportsInterrupt: true,
          supportsResume: false,
          supportsStart: true,
          supportsStreaming: true
        },
        now
      });
      const credential = auth.issueDeviceCredential(device.deviceId, now);
      const devicePrincipal = auth.authenticateDevice(credential.secret, now);
      presence.recordHeartbeat(devicePrincipal, {
        deviceId: device.deviceId,
        connectionEpoch: 1,
        adapterAvailable: true,
        now
      });
      fakeAdapters.set(agent.agentId, new FakeRuntimeAdapter());
      return core.getAgent(agent.agentId);
    }
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/manual-agents",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const now = clock();
      const agent = agents.publishAgent(actor, {
        teamId: request.params.teamId,
        deviceId: null,
        name: requiredString(body.name, "name"),
        role: requiredString(body.role, "role"),
        integrationMode: "manual",
        capabilities: {
          supportsHandoff: true,
          supportsInterrupt: false,
          supportsResume: false,
          supportsStart: false,
          supportsStreaming: false
        },
        now
      });
      const expiresAt = new Date(
        Date.parse(now) + 90 * 24 * 60 * 60 * 1000
      ).toISOString();
      const credential = auth.issueMcpCredential(
        actor,
        agent.agentId,
        now,
        expiresAt
      );
      return {
        agent,
        credential: { token: credential.secret, expiresAt }
      };
    }
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/bridge-invites",
    async (request) => {
      const body = bodyObject(request);
      return pairing.createInvite(
        principal(request),
        request.params.teamId,
        requiredString(body.deviceName, "deviceName"),
        clock()
      );
    }
  );
  app.post("/api/bridge/join-requests", async (request) => {
    requireBridgeServerToken(request);
    limitAnonymous(request, "bridge-join-request");
    const body = bodyObject(request);
    return pairing.createJoinRequest({
      deviceName: requiredString(body.deviceName, "deviceName"),
      agentName: requiredString(body.agentName, "agentName"),
      agentRole: requiredString(body.agentRole, "agentRole")
    }, clock());
  });
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/bridge-join-requests/approve",
    async (request) => {
      const body = bodyObject(request);
      return pairing.approveJoinRequest(
        principal(request),
        request.params.teamId,
        requiredString(body.code, "code", 20),
        clock()
      );
    }
  );
  app.post<{ Params: { joinRequestId: string } }>(
    "/api/bridge/join-requests/:joinRequestId/claim",
    async (request, reply) => {
      requireBridgeServerToken(request);
      const body = bodyObject(request);
      const result = pairing.claimJoinRequest(
        request.params.joinRequestId,
        requiredString(body.pollToken, "pollToken", 128),
        clock()
      );
      if (result.status === "pending") {
        void reply.code(202);
        return result;
      }
      return {
        status: result.status,
        device: result.device,
        credential: {
          token: result.credential.secret,
          expiresAt: result.credential.expiresAt
        }
      };
    }
  );
  app.post("/api/bridge/pair", async (request) => {
    requireBridgeServerToken(request);
    limitAnonymous(request, "bridge-pair");
    const body = bodyObject(request);
    const result = pairing.exchange(
      requiredString(body.code, "code", 128),
      requiredString(body.deviceName, "deviceName"),
      clock()
    );
    return {
      device: result.device,
      credential: {
        token: result.credential.secret,
        expiresAt: result.credential.expiresAt
      }
    };
  });
}
