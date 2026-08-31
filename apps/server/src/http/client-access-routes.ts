import { AuthorizationError } from "../security/auth-service.js";
import { bearerToken, bodyObject, isLoopbackHost, noStore, requiredString, sessionCookie } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

function checkedBody(request: Parameters<typeof bodyObject>[0], keys: string[]) {
  const body = bodyObject(request);
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new Error("Unsupported client entry field");
  return body;
}

export function registerClientAccessRoutes({
  app, auth, clientAccess, clock, limitAnonymous, principal, requireTrustedOrigin, webAuth
}: ServerRouteContext): void {
  for (const action of ["rooms", "tickets"] as const) {
    app.post(`/api/client-access/${action}`, async (request, reply) => {
      noStore(reply);
      limitAnonymous(request, "client-entry-device");
      const device = auth.authenticateDevice(bearerToken(request), clock());
      const body = checkedBody(request, action === "rooms" ? ["clientAccessSecret"] : ["clientAccessSecret", "roomId"]);
      const secret = requiredString(body.clientAccessSecret, "clientAccessSecret", 128);
      return action === "rooms" ? clientAccess.list(device, secret, clock()) :
        clientAccess.issue(device, secret,
          body.roomId === undefined ? undefined : requiredString(body.roomId, "roomId", 140), clock());
    });
  }
  for (const action of ["preview", "claim"] as const) {
    app.post(`/api/auth/client-entry/${action}`, async (request, reply) => {
      noStore(reply);
      limitAnonymous(request, "client-entry-browser");
      if (webAuth.mode === "trusted-team") {
        requireTrustedOrigin(request);
      } else {
        let origin: URL;
        try { origin = new URL(request.headers.origin ?? ""); } catch { throw new AuthorizationError("FORBIDDEN", "Browser origin required"); }
        if (!isLoopbackHost(origin.hostname) || !["http:", "https:"].includes(origin.protocol)) {
          throw new AuthorizationError("FORBIDDEN", "Local browser origin required");
        }
      }
      const body = checkedBody(request, ["ticket"]);
      const ticket = requiredString(body.ticket, "ticket", 128);
      if (action === "preview") return clientAccess.preview(ticket, clock());
      const result = clientAccess.consume(ticket, clock());
      if (webAuth.mode === "trusted-team") void reply.header("set-cookie", sessionCookie(result.session));
      return {
        identity: result.identity,
        user: { ...result.user, canManageOwnerRecovery: false, clientTeamId: result.identity.teamId },
        mode: webAuth.mode,
        session: { expiresAt: result.session.expiresAt,
          ...(webAuth.mode === "local" ? { token: result.session.secret } : {}) }
      };
    });
  }
  app.delete<{ Params: { teamId: string; deviceId: string } }>(
    "/api/teams/:teamId/devices/:deviceId/client-access", async (request, reply) => {
      noStore(reply);
      const actor = auth.requireTeamMember(principal(request), request.params.teamId);
      clientAccess.revoke(actor, request.params.deviceId, clock());
      return { status: "revoked" };
    }
  );
}
