import type { FastifyReply, FastifyRequest } from "fastify";

import { createOpaqueId } from "../domain/identifiers.js";
import { AuthorizationError } from "../security/auth-service.js";
import type { TrustedWebAccessService } from "../security/trusted-web-access-service.js";
import {
  bodyObject,
  clearSessionCookie,
  noStore,
  requiredString,
  sessionCookie
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerAuthRoutes({
  app,
  auth,
  clock,
  core,
  limitAnonymous,
  optionalPrincipal,
  principal,
  requireTrustedOrigin,
  trustedWeb,
  webAuth
}: ServerRouteContext): void {
  app.get("/api/auth/status", async (request, reply) => {
    noStore(reply);
    const actor = optionalPrincipal(request);
    const user = actor ? core.getUser(actor.userId) : undefined;
    if (actor && user) {
      return {
        mode: webAuth.mode,
        state: "authenticated",
        user: { ...user, canManageOwnerRecovery: trustedWeb?.isInstallationOwner(user.userId) ?? false },
        session: { expiresAt: auth.getWebSessionExpiresAt(actor.sessionId) }
      };
    }
    return {
      mode: webAuth.mode,
      state: trustedWeb?.status() ?? "local_bootstrap"
    };
  });
  app.get("/api/auth/session", async (request, reply) => {
    noStore(reply);
    const actor = principal(request);
    const user = core.getUser(actor.userId);
    if (!user) {
      throw new AuthorizationError("UNAUTHENTICATED", "Session User not found");
    }
    return {
      user: { ...user, canManageOwnerRecovery: trustedWeb?.isInstallationOwner(user.userId) ?? false },
      session: { expiresAt: auth.getWebSessionExpiresAt(actor.sessionId) }
    };
  });
  app.delete("/api/auth/session", async (request, reply) => {
    noStore(reply);
    const actor = principal(request);
    auth.revokeWebSession(actor.sessionId, clock());
    if (webAuth.mode === "trusted-team") {
      void reply.header("set-cookie", clearSessionCookie());
    }
    return { status: "signed_out" };
  });

  if (trustedWeb) {
    const recoveryToken = (request: FastifyRequest): string =>
      requiredString(
        request.headers["x-agent-room-recovery-token"],
        "x-agent-room-recovery-token",
        512
      );
    const establishSession = (
      reply: FastifyReply,
      result: ReturnType<TrustedWebAccessService["recover"]>
    ) => {
      noStore(reply);
      void reply.header("set-cookie", sessionCookie(result.session));
      return {
        user: { ...result.user, canManageOwnerRecovery: trustedWeb.isInstallationOwner(result.user.userId) },
        session: { expiresAt: result.session.expiresAt }
      };
    };
    app.post("/api/auth/setup", async (request, reply) => {
      limitAnonymous(request, "web-setup");
      requireTrustedOrigin(request);
      const body = bodyObject(request);
      return establishSession(reply, trustedWeb.setup(
        recoveryToken(request),
        requiredString(body.displayName, "displayName"),
        clock()
      ));
    });
    app.post("/api/auth/recover-owner", async (request, reply) => {
      limitAnonymous(request, "web-recover");
      requireTrustedOrigin(request);
      return establishSession(
        reply,
        trustedWeb.recover(recoveryToken(request), clock())
      );
    });
    app.get("/api/auth/owner-recovery", async (request, reply) => {
      noStore(reply);
      return trustedWeb.ownerRecoverySettings(principal(request));
    });
    app.put("/api/auth/owner-recovery", async (request, reply) => {
      noStore(reply);
      requireTrustedOrigin(request);
      const actor = principal(request);
      const body = bodyObject(request);
      if (typeof body.expectedRevision !== "number") {
        throw new Error("expectedRevision must be a number");
      }
      return trustedWeb.replaceOwnerRecovery(actor, recoveryToken(request), body.expectedRevision, clock());
    });
    app.post("/api/auth/member-invitations/claim", async (request, reply) => {
      limitAnonymous(request, "member-invitation-claim");
      requireTrustedOrigin(request);
      const body = bodyObject(request);
      const result = trustedWeb.claimMemberInvitation(
        requiredString(body.token, "token", 128),
        clock()
      );
      noStore(reply);
      void reply.header("set-cookie", sessionCookie(result.session));
      return {
        member: result.member,
        user: result.user,
        session: { expiresAt: result.session.expiresAt }
      };
    });
    app.post("/api/auth/recover-member", async (request, reply) => {
      noStore(reply);
      limitAnonymous(request, "member-recovery-claim");
      requireTrustedOrigin(request);
      const body = bodyObject(request);
      const result = trustedWeb.claimMemberRecovery(
        requiredString(body.token, "token", 128), clock()
      );
      void reply.header("set-cookie", sessionCookie(result.session));
      return {
        member: result.member,
        user: result.user,
        session: { expiresAt: result.session.expiresAt }
      };
    });
  } else {
    app.post("/api/bootstrap", async (request) => {
      const body = bodyObject(request);
      const displayName = requiredString(body.displayName, "displayName");
      const requestedUserId = body.userId;
      const userId = requestedUserId === undefined
        ? createOpaqueId("user")
        : requiredString(requestedUserId, "userId", 140);
      if (!/^user_[A-Za-z0-9_-]{8,128}$/u.test(userId)) {
        throw new Error("userId is not a valid opaque User identifier");
      }
      const now = clock();
      core.ensureUser({ userId, displayName: displayName.trim(), createdAt: now });
      const expiresAt = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000)
        .toISOString();
      const session = auth.issueWebSession(userId, now, expiresAt);
      return {
        user: core.getUser(userId),
        session: { token: session.secret, expiresAt }
      };
    });
  }
}
