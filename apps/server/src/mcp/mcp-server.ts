import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { CoreRepository } from "../data/core-repository.js";
import type { DeliveryService } from "../run/delivery-service.js";
import type { HandoffService } from "../run/handoff-service.js";
import type { ManualRunService } from "../run/manual-run-service.js";
import type { McpPrincipal } from "../security/auth-service.js";
import type { MessageService } from "../team-room/message-service.js";
import type { TeamWaitService } from "./team-wait-service.js";
import type { TaskArtifactService } from "../task/task-artifact-service.js";

interface TeamMcpDependencies {
  clock: () => string;
  core: CoreRepository;
  delivery: DeliveryService;
  handoffs: HandoffService;
  manualRuns: ManualRunService;
  messages: MessageService;
  taskArtifacts: TaskArtifactService;
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
  server.registerTool("team.get_mentions", {
    description: "List active Team Runs that mention the authenticated manual Agent."
  }, async () => toolResult({
    mentions: dependencies.manualRuns.listMentions(principal)
  }));
  server.registerTool("team.get_run", {
    description: "Read one Run assigned to the authenticated manual Agent.",
    inputSchema: { runId: z.string().min(1) }
  }, async ({ runId }) => toolResult({
    run: dependencies.manualRuns.get(principal, runId)
  }));
  server.registerTool("team.list_task_artifacts", {
    description: "List structured result evidence for one authorized Task.",
    inputSchema: {
      taskId: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(50)
    }
  }, async ({ taskId, limit }) => toolResult(
    dependencies.taskArtifacts.list(principal, taskId, limit)
  ));
  server.registerTool("team.report_task_artifact", {
    description: "Publish a workspace-local result reference for one authorized Task.",
    inputSchema: {
      taskId: z.string().min(1),
      type: z.enum(["commit", "branch", "file", "patch", "test_result", "document"]),
      workspaceRef: z.string().min(1).max(512).optional(),
      repository: z.string().min(1).max(512).optional(),
      path: z.string().min(1).max(1024).optional(),
      commitSha: z.string().min(7).max(64).optional(),
      branch: z.string().min(1).max(255).optional(),
      title: z.string().min(1).max(160),
      summary: z.string().min(1).max(4_000),
      sourceRunId: z.string().min(1).optional(),
      relations: z.array(z.object({
        type: z.enum(["derives_from", "reviews", "verifies"]),
        targetArtifactId: z.string().min(1).max(140)
      }).strict()).max(20).optional()
    }
  }, async ({
    taskId, type, title, summary, workspaceRef, repository, path,
    commitSha, branch, sourceRunId, relations
  }) => toolResult(dependencies.taskArtifacts.create(
    principal,
    taskId,
    {
      type,
      title,
      summary,
      ...(workspaceRef === undefined ? {} : { workspaceRef }),
      ...(repository === undefined ? {} : { repository }),
      ...(path === undefined ? {} : { path }),
      ...(commitSha === undefined ? {} : { commitSha }),
      ...(branch === undefined ? {} : { branch }),
      ...(sourceRunId === undefined ? {} : { sourceRunId }),
      ...(relations === undefined ? {} : { relations })
    },
    dependencies.clock()
  )));
  server.registerTool("team.claim_run", {
    description: "Mark one queued manual Agent Run as working.",
    inputSchema: { runId: z.string().min(1) }
  }, async ({ runId }) => toolResult({
    run: dependencies.manualRuns.claim(principal, runId, dependencies.clock())
  }));
  server.registerTool("team.complete_run", {
    description: "Reply to and complete one assigned manual Agent Run.",
    inputSchema: {
      runId: z.string().min(1),
      content: z.string().min(1).max(20_000)
    }
  }, async ({ runId, content }) => toolResult({
    run: dependencies.manualRuns.complete(principal, runId, content, dependencies.clock())
  }));
  server.registerTool("team.fail_run", {
    description: "Fail one assigned manual Agent Run with a safe summary.",
    inputSchema: {
      runId: z.string().min(1),
      message: z.string().min(1).max(2_000)
    }
  }, async ({ runId, message }) => toolResult({
    run: dependencies.manualRuns.fail(principal, runId, message, dependencies.clock())
  }));
  server.registerTool("team.handoff", {
    description: "Create a bounded child Run for another Agent.",
    inputSchema: {
      parentRunId: z.string().min(1),
      targetAgentId: z.string().min(1),
      instruction: z.string().min(1).max(20_000)
    }
  }, async ({ parentRunId, targetAgentId, instruction }) => {
    const run = dependencies.handoffs.create(principal, {
      parentRunId, targetAgentId, instruction
    }, dependencies.clock());
    dependencies.delivery.dispatch(run.runId);
    return toolResult({ run });
  });
  return server;
}
