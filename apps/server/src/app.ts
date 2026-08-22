import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest
} from "fastify";

import { CoreRepository } from "./data/core-repository.js";
import { openDatabase } from "./data/database.js";
import { prepareDatabaseDirectory } from "./data/database-location.js";
import { migrateDatabase } from "./data/migration-runner.js";
import { createOpaqueId } from "./domain/identifiers.js";
import { AgentService } from "./registry/agent-service.js";
import { MemberDeviceService } from "./registry/member-device-service.js";
import { PresenceService } from "./registry/presence-service.js";
import {
  AuthService,
  AuthorizationError,
  type WebPrincipal
} from "./security/auth-service.js";
import { TeamRoomService } from "./team-room/team-room-service.js";

export interface ServerAppOptions {
  databasePath: string;
  clock?: () => string;
  logger?: boolean;
  webRoot?: string;
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new Error("Request body must be a JSON object");
  }
  return request.body as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maximum = 80
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new AuthorizationError("UNAUTHENTICATED", "Bearer session required");
  }
  return authorization.slice(7);
}

export async function createServerApp(
  options: ServerAppOptions
): Promise<FastifyInstance> {
  await prepareDatabaseDirectory(options.databasePath);
  await migrateDatabase(options.databasePath);
  const database = openDatabase(options.databasePath);
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const teamRooms = new TeamRoomService(core, auth);
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const presence = new PresenceService(core, auth);
  const clock = options.clock ?? (() => new Date().toISOString());
  const app = Fastify({ logger: options.logger ?? false });
  const principal = (request: FastifyRequest): WebPrincipal =>
    auth.authenticateWebSession(bearerToken(request), clock());

  app.addHook("onClose", (_instance, done) => {
    database.close();
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      void reply.code(error.code === "UNAUTHENTICATED" ? 401 : 403).send({
        error: { code: error.code, message: error.message }
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    const statusCode = message.includes("UNIQUE constraint failed") ? 409 : 400;
    void reply.code(statusCode).send({
      error: {
        code: statusCode === 409 ? "CONFLICT" : "INVALID_REQUEST",
        message
      }
    });
  });

  app.get("/api/health", async () => ({ status: "ok" }));
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

  app.get("/api/teams", async (request) =>
    teamRooms.listTeams(principal(request))
  );
  app.post("/api/teams", async (request) => {
    const actor = principal(request);
    const user = core.getUser(actor.userId);
    if (!user) {
      throw new AuthorizationError("UNAUTHENTICATED", "Session User not found");
    }
    const body = bodyObject(request);
    return teamRooms.createTeamForUser({
      userId: actor.userId,
      userDisplayName: user.displayName,
      teamName: requiredString(body.name, "name"),
      now: clock()
    });
  });
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/rooms",
    async (request) => teamRooms.listRooms(principal(request), request.params.teamId)
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/rooms",
    async (request) => {
      const body = bodyObject(request);
      return teamRooms.createRoom(
        principal(request),
        request.params.teamId,
        requiredString(body.name, "name"),
        clock()
      );
    }
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/members",
    async (request) => registry.listMembers(principal(request), request.params.teamId)
  );
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
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/agents",
    async (request) => agents.listAgents(principal(request), request.params.teamId)
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
        integrationMode: "managed",
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
      return core.getAgent(agent.agentId);
    }
  );

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.webRoot),
      prefix: "/"
    });
  }
  return app;
}
