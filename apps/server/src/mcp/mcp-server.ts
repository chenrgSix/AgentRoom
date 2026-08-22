import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { CoreRepository } from "../data/core-repository.js";
import type { McpPrincipal } from "../security/auth-service.js";
import type { MessageService } from "../team-room/message-service.js";
import type { TeamWaitService } from "./team-wait-service.js";

interface TeamMcpDependencies {
  clock: () => string;
  core: CoreRepository;
  messages: MessageService;
  wait: TeamWaitService;
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function createTeamMcpServer(
  principal: McpPrincipal,
  dependencies: TeamMcpDependencies
): McpServer {
  const server = new McpServer({
    name: "agent-room",
    version: "0.1.0"
  });
  server.registerTool("team.whoami", {
    description: "Return the authenticated Agent Room Team identity."
  }, async () => toolResult({
    agentId: principal.agentId,
    memberId: principal.memberId,
    teamId: principal.teamId
  }));
  server.registerTool("team.get_context", {
    description: "Read Room metadata and the most recent authorized messages.",
    inputSchema: {
      roomId: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(30)
    }
  }, async ({ roomId, limit }) => {
    const page = dependencies.messages.listMessages(principal, { roomId, limit });
    const room = dependencies.core.getRoom(roomId);
    if (!room || room.teamId !== principal.teamId) {
      throw new Error("Room access denied");
    }
    return toolResult({
      agentId: principal.agentId,
      room,
      messages: page.items,
      nextCursor: page.nextCursor
    });
  });
  server.registerTool("team.get_messages", {
    description: "Read an ordered page of Room messages from an optional cursor.",
    inputSchema: {
      roomId: z.string().min(1),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(50)
    }
  }, async ({ roomId, cursor, limit }) => toolResult(
    dependencies.messages.listMessages(principal, {
      roomId,
      limit,
      ...(cursor ? { cursor } : {})
    }) as unknown as Record<string, unknown>
  ));
  server.registerTool("team.send_message", {
    description: "Send a Room message as the authenticated manual Agent.",
    inputSchema: {
      roomId: z.string().min(1),
      content: z.string().min(1).max(20_000)
    }
  }, async ({ roomId, content }) => toolResult({
    message: dependencies.messages.createAgentMessage(principal, {
      roomId,
      content,
      now: dependencies.clock()
    })
  }));
  server.registerTool("team.reply", {
    description: "Reply to one Message as the authenticated manual Agent.",
    inputSchema: {
      roomId: z.string().min(1),
      parentMessageId: z.string().min(1),
      content: z.string().min(1).max(20_000)
    }
  }, async ({ roomId, parentMessageId, content }) => toolResult({
    message: dependencies.messages.createAgentMessage(principal, {
      roomId,
      parentMessageId,
      content,
      now: dependencies.clock()
    })
  }));
  server.registerTool("team.wait", {
    description: "Wait briefly for new Room messages and return a resumable cursor.",
    inputSchema: {
      roomId: z.string().min(1),
      cursor: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(100).max(30_000).default(20_000)
    }
  }, async ({ roomId, cursor, timeoutMs }) => toolResult(
    await dependencies.wait.wait(principal, {
      roomId,
      timeoutMs,
      ...(cursor ? { cursor } : {})
    }) as unknown as Record<string, unknown>
  ));
  return server;
}
