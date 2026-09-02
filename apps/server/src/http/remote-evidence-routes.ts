import type { FastifyReply, FastifyRequest } from "fastify";
import { noStore } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerRemoteEvidenceRoutes({
  app, clock, principal, remoteProviderBindings
}: ServerRouteContext): void {
  const options = {
    bodyLimit: 64 * 1024,
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => noStore(reply)
  };
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/remote-provider-bindings",
    options,
    async (request) => remoteProviderBindings.create(
      principal(request), request.params.teamId, request.body, clock()
    )
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/remote-provider-bindings",
    options,
    async (request) => ({ bindings: remoteProviderBindings.list(
      principal(request), request.params.teamId
    ) })
  );
  app.post<{ Params: { bindingId: string } }>(
    "/api/remote-provider-bindings/:bindingId/revocations",
    options,
    async (request) => remoteProviderBindings.revoke(
      principal(request), request.params.bindingId, request.body, clock()
    )
  );
}
