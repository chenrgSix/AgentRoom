import type { HostedAgentConfigurationService } from
  "../hosted/hosted-agent-configuration-service.js";
import {
  bodyObject,
  noStore,
  requiredPositiveInteger,
  requiredString,
  requiredStringArray
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

function rejectProviderEndpointFields(body: Record<string, unknown>): void {
  for (const field of ["baseUrl", "baseURL", "endpoint", "url", "proxyUrl"]) {
    if (body[field] !== undefined) {
      throw new Error("Hosted provider endpoints are fixed by the Server");
    }
  }
}

export function registerHostedAgentRoutes({
  app,
  clock,
  hostedAgents,
  principal
}: ServerRouteContext & {
  hostedAgents: HostedAgentConfigurationService;
}): void {
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/hosted-agents",
    async (request, reply) => {
      noStore(reply);
      return hostedAgents.list(principal(request), request.params.teamId);
    }
  );

  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/hosted-agent-tests",
    async (request, reply) => {
      const body = bodyObject(request);
      rejectProviderEndpointFields(body);
      const result = await hostedAgents.testConnection(principal(request), {
        teamId: request.params.teamId,
        provider: requiredString(body.provider, "provider", 80),
        model: requiredString(body.model, "model", 160),
        apiKey: requiredString(body.apiKey, "apiKey", 512),
        now: clock()
      });
      noStore(reply);
      return result;
    }
  );

  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/hosted-agents",
    async (request, reply) => {
      const body = bodyObject(request);
      rejectProviderEndpointFields(body);
      const result = await hostedAgents.create(principal(request), {
        teamId: request.params.teamId,
        name: requiredString(body.name, "name"),
        role: requiredString(body.role, "role"),
        provider: requiredString(body.provider, "provider", 80) as
          "openai_responses",
        model: requiredString(body.model, "model", 160),
        apiKey: requiredString(body.apiKey, "apiKey", 512),
        roomIds: requiredStringArray(body.roomIds, "roomIds"),
        now: clock()
      });
      noStore(reply);
      return result;
    }
  );

  app.post<{ Params: { agentId: string } }>(
    "/api/hosted-agents/:agentId/tests",
    async (request, reply) => {
      const result = await hostedAgents.testConfigured(
        principal(request),
        request.params.agentId,
        clock()
      );
      noStore(reply);
      return result;
    }
  );

  app.patch<{ Params: { agentId: string } }>(
    "/api/hosted-agents/:agentId/profile",
    async (request, reply) => {
      const body = bodyObject(request);
      rejectProviderEndpointFields(body);
      const result = await hostedAgents.updateProfile(principal(request), {
        agentId: request.params.agentId,
        expectedProfileRevision: requiredPositiveInteger(
          body.expectedProfileRevision,
          "expectedProfileRevision"
        ),
        model: requiredString(body.model, "model", 160),
        ...(body.apiKey === undefined
          ? {}
          : { apiKey: requiredString(body.apiKey, "apiKey", 512) }),
        now: clock()
      });
      noStore(reply);
      return result;
    }
  );

  app.post<{ Params: { agentId: string } }>(
    "/api/hosted-agents/:agentId/credential/revoke",
    async (request, reply) => {
      const body = bodyObject(request);
      const result = hostedAgents.revokeCredential(
        principal(request),
        request.params.agentId,
        requiredPositiveInteger(
          body.expectedProfileRevision,
          "expectedProfileRevision"
        ),
        clock()
      );
      noStore(reply);
      return result;
    }
  );
}
