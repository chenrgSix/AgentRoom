import type { DiscussionOrchestrator } from "../discussion/discussion-orchestrator.js";
import type {
  DiscussionMode,
  DiscussionOutputMode,
  DiscussionPolicy
} from "../discussion/discussion-types.js";
import {
  bodyObject,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerDiscussionRoutes({
  advanceDiscussion,
  app,
  cancellations,
  discussions,
  dispatchDiscussionRuns,
  principal
}: ServerRouteContext): void {
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/discussions",
    async (request) => discussions.list(principal(request), request.params.roomId)
  );
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/discussions",
    async (request) => {
      const body = bodyObject(request);
      if (
        !Array.isArray(body.participantAgentIds) ||
        !body.participantAgentIds.every((value) => typeof value === "string")
      ) {
        throw new Error("participantAgentIds must be an array of Agent IDs");
      }
      const rawPolicy = body.policy;
      if (
        rawPolicy !== undefined &&
        (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))
      ) {
        throw new Error("policy must be a JSON object");
      }
      const result = discussions.create(principal(request), {
        roomId: request.params.roomId,
        ...(body.taskId === undefined
          ? {}
          : { taskId: requiredString(body.taskId, "taskId", 140) }),
        goal: requiredString(body.goal, "goal", 20_000),
        participantAgentIds: body.participantAgentIds,
        ...(body.mode === undefined
          ? {}
          : { mode: body.mode as DiscussionMode }),
        ...(body.outputMode === undefined
          ? {}
          : { outputMode: body.outputMode as DiscussionOutputMode }),
        ...(rawPolicy === undefined
          ? {}
          : { policy: rawPolicy as Partial<DiscussionPolicy> })
      });
      if (result.scheduledRuns.length) {
        await dispatchDiscussionRuns(result.scheduledRuns);
      }
      return discussions.get(principal(request), result.discussion.discussionId);
    }
  );
  app.get<{ Params: { discussionId: string } }>(
    "/api/discussions/:discussionId",
    async (request) => discussions.get(
      principal(request),
      request.params.discussionId
    )
  );
  app.post<{ Params: { discussionId: string } }>(
    "/api/discussions/:discussionId/actions",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const action = requiredString(body.action, "action", 40);
      if (!new Set([
        "finish", "stop_after_turn", "pause", "cancel", "continue",
        "adjust_goal"
      ]).has(action)) {
        throw new Error("Unsupported Discussion action");
      }
      const result = discussions.control(
        actor,
        request.params.discussionId,
        {
          action: action as Parameters<DiscussionOrchestrator["control"]>[2]["action"],
          ...(body.goal === undefined
            ? {}
            : { goal: requiredString(body.goal, "goal", 20_000) }),
          ...(body.extensionTurns === undefined
            ? {}
            : { extensionTurns: Number(body.extensionTurns) })
        }
      );
      const cancelWarnings: string[] = [];
      for (const cancelRunId of result.cancelRunIds) {
        try {
          const canceledRun = cancellations.cancel(
            actor,
            cancelRunId,
            "Discussion stopped immediately"
          );
          if (new Set([
            "completed", "failed", "canceled", "expired", "outcome_unknown"
          ]).has(canceledRun.state)) {
            await advanceDiscussion(canceledRun.runId);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Runtime cancel failed";
          cancelWarnings.push(`${cancelRunId}: ${message}`);
        }
      }
      if (result.scheduledRuns.length) {
        await dispatchDiscussionRuns(result.scheduledRuns);
      }
      return {
        ...discussions.get(actor, request.params.discussionId),
        cancelWarning: cancelWarnings.length > 0 ? cancelWarnings.join("; ") : null
      };
    }
  );
}
