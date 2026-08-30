import {
  bodyObject,
  requiredString,
  requiredStringArray
} from "./http-helpers.js";
import { agentMentionDisplayLabel } from
  "../team-room/agent-mention-label.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerMessageRoutes({
  app,
  clock,
  core,
  dispatchRun,
  memberMessageRuns,
  messages,
  principal,
  runRepository
}: ServerRouteContext): void {
  app.get<{
    Params: { roomId: string };
    Querystring: { cursor?: string; limit?: string; tail?: string };
  }>("/api/rooms/:roomId/messages", async (request) => {
    const parsedLimit = request.query.limit === undefined
      ? 100
      : Number.parseInt(request.query.limit, 10);
    if (
      request.query.tail !== undefined &&
      request.query.tail !== "true" &&
      request.query.tail !== "false"
    ) {
      throw new Error("Message tail must be true or false");
    }
    return messages.listMessages(principal(request), {
      roomId: request.params.roomId,
      limit: parsedLimit,
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.tail === "true" ? { tail: true } : {})
    });
  });
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/messages",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const legacyMentionAgentId = body.mentionAgentId === undefined
        ? undefined
        : requiredString(body.mentionAgentId, "mentionAgentId", 140);
      if (legacyMentionAgentId && body.mentionAgentIds !== undefined) {
        throw new Error("Use mentionAgentId or mentionAgentIds, not both");
      }
      const mentionAgentIds = body.mentionAgentIds === undefined
        ? (legacyMentionAgentId ? [legacyMentionAgentId] : [])
        : requiredStringArray(body.mentionAgentIds, "mentionAgentIds");
      if (
        mentionAgentIds.length > 5 ||
        new Set(mentionAgentIds).size !== mentionAgentIds.length
      ) {
        throw new Error("mentionAgentIds must contain up to 5 unique Agent IDs");
      }
      const now = clock();
      const persisted = memberMessageRuns.create(actor, {
        roomId: request.params.roomId,
        ...(body.taskId === undefined
          ? {}
          : { taskId: requiredString(body.taskId, "taskId", 140) }),
        content: requiredString(body.content, "content", 20_000),
        ...(body.clientMessageId === undefined
          ? {}
          : {
              clientMessageId: requiredString(
                body.clientMessageId,
                "clientMessageId",
                140
              )
            }),
        ...(mentionAgentIds.length > 0
          ? {
              mentions: mentionAgentIds.map((agentId) => {
                const target = core.getAgent(agentId);
                return {
                targetType: "agent" as const,
                targetAgentId: agentId,
                displayLabel: target
                  ? agentMentionDisplayLabel(target.name, target.role)
                  : agentId
                };
              })
            }
          : {}),
        now
      });
      const message = persisted.message;
      if (!persisted.runsCreated) {
        return {
          message,
          runs: persisted.runs
        };
      }
      const executedRuns = [];
      for (const run of persisted.runs) {
        await dispatchRun(run);
        executedRuns.push(runRepository.getRun(run.runId) ?? run);
      }
      return {
        message,
        runs: executedRuns
      };
    }
  );
}
