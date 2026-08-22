import path from "node:path";

import fastifyStatic from "@fastify/static";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest
} from "fastify";

import { CoreRepository } from "./data/core-repository.js";
import { openDatabase } from "./data/database.js";
import { prepareDatabaseDirectory } from "./data/database-location.js";
import { migrateDatabase } from "./data/migration-runner.js";
import { createOpaqueId } from "./domain/identifiers.js";
import { createTeamMcpServer } from "./mcp/mcp-server.js";
import { AgentService } from "./registry/agent-service.js";
import { MemberDeviceService } from "./registry/member-device-service.js";
import { PresenceService } from "./registry/presence-service.js";
import { RunRepository } from "./run/run-repository.js";
import { RunService } from "./run/run-service.js";
import { FakeRuntimeAdapter } from "./runtime/fake-runtime-adapter.js";
import { InProcessRunExecutor } from "./runtime/in-process-run-executor.js";
import {
  AuthService,
  AuthorizationError,
  type WebPrincipal
} from "./security/auth-service.js";
import { TeamRoomService } from "./team-room/team-room-service.js";
import { MessageService } from "./team-room/message-service.js";

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
  const messages = new MessageService(core, auth);
  const clock = options.clock ?? (() => new Date().toISOString());
  const runRepository = new RunRepository(database);
  const runs = new RunService(core, runRepository, auth);
  const executor = new InProcessRunExecutor(core, runRepository, clock);
  const fakeAdapters = new Map<string, FakeRuntimeAdapter>();
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
  app.get<{
    Params: { roomId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/rooms/:roomId/messages", async (request) => {
    const parsedLimit = request.query.limit === undefined
      ? 100
      : Number.parseInt(request.query.limit, 10);
    return messages.listMessages(principal(request), {
      roomId: request.params.roomId,
      limit: parsedLimit,
      ...(request.query.cursor ? { cursor: request.query.cursor } : {})
    });
  });
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/messages",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const mentionAgentId = body.mentionAgentId === undefined
        ? undefined
        : requiredString(body.mentionAgentId, "mentionAgentId", 140);
      const target = mentionAgentId ? core.getAgent(mentionAgentId) : undefined;
      const message = messages.createMemberMessage(actor, {
        roomId: request.params.roomId,
        content: requiredString(body.content, "content", 20_000),
        ...(mentionAgentId
          ? {
              mentions: [{
                targetType: "agent" as const,
                targetAgentId: mentionAgentId,
                displayLabel: target
                  ? `${target.name} / ${target.role}`
                  : mentionAgentId
              }]
            }
          : {}),
        now: clock()
      });
      const createdRuns = runs.createRunsForMessage(actor, message.messageId, clock());
      const executedRuns = [];
      for (const run of createdRuns) {
        const adapter = fakeAdapters.get(run.targetAgentId);
        if (!adapter) {
          executedRuns.push(run);
          continue;
        }
        adapter.enqueue({
          expectedInstruction: message.content,
          events: [
            { type: "status", sequence: 1, status: "working" },
            {
              type: "reply",
              sequence: 2,
              content: `${target?.name ?? "Agent"} completed: ${message.content}`
            },
            { type: "status", sequence: 3, status: "completed" }
          ]
        });
        executedRuns.push(await executor.execute(run.runId, adapter));
      }
      return {
        message,
        runs: executedRuns
      };
    }
  );
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/runs",
    async (request) => runs.listRoomRuns(principal(request), request.params.roomId)
  );
  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId/events",
    async (request) => {
      const actor = principal(request);
      const run = runRepository.getRun(request.params.runId);
      if (!run) {
        throw new Error(`Run not found: ${request.params.runId}`);
      }
      runs.listRoomRuns(actor, run.roomId);
      return runRepository.listEvents(run.runId);
    }
  );

  app.post("/mcp", async (request, reply) => {
    const mcpPrincipal = auth.authenticateMcp(bearerToken(request), clock());
    const server = createTeamMcpServer(mcpPrincipal);
    const transportOptions = {
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    } as unknown as StreamableHTTPServerTransportOptions;
    const transport = new StreamableHTTPServerTransport(transportOptions);
    await server.connect(transport as unknown as Transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await server.close();
    }
  });
  app.get("/mcp", async (_request, reply) => reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed" },
    id: null
  }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed" },
    id: null
  }));

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.webRoot),
      prefix: "/"
    });
  }
  return app;
}
