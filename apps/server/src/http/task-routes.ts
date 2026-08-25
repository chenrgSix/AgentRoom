import type { ArtifactType } from "../task/artifact-repository.js";
import type { MemoryEntryType } from "../task/memory-entry-repository.js";
import type { AgentTaskState } from "../task/task-repository.js";
import {
  bodyObject,
  requiredStringArray,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerTaskRoutes({
  app,
  clock,
  core,
  delivery,
  longTermMemory,
  principal,
  taskArtifacts,
  taskClarifications,
  tasks,
  teamChanges
}: ServerRouteContext): void {
  const memoryInput = (body: Record<string, unknown>) => ({
    type: requiredString(body.type, "type") as MemoryEntryType,
    content: requiredString(body.content, "content", 2_000),
    ...(body.supersedesMemoryId === undefined
      ? {}
      : {
          supersedesMemoryId: body.supersedesMemoryId === null
            ? null
            : requiredString(
                body.supersedesMemoryId,
                "supersedesMemoryId",
                160
              )
        }),
    ...(body.sourceMessageIds === undefined
      ? {}
      : {
          sourceMessageIds: requiredStringArray(
            body.sourceMessageIds,
            "sourceMessageIds"
          )
        }),
    ...(body.sourceArtifactIds === undefined
      ? {}
      : {
          sourceArtifactIds: requiredStringArray(
            body.sourceArtifactIds,
            "sourceArtifactIds"
          )
        }),
    ...(body.sourceRunIds === undefined
      ? {}
      : {
          sourceRunIds: requiredStringArray(body.sourceRunIds, "sourceRunIds")
        }),
    ...(body.sourceDiscussionIds === undefined
      ? {}
      : {
          sourceDiscussionIds: requiredStringArray(
            body.sourceDiscussionIds,
            "sourceDiscussionIds"
          )
        })
  });
  const memoryCursor = (query: { after?: string; limit?: string }) => {
    const after = query.after === undefined ? 0 : Number.parseInt(query.after, 10);
    const limit = query.limit === undefined ? 100 : Number.parseInt(query.limit, 10);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Memory revision cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Memory page limit must be from 1 to 100");
    }
    return { after, limit };
  };
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/tasks",
    async (request) => tasks.list(principal(request), request.params.roomId)
  );
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/tasks",
    async (request) => {
      const body = bodyObject(request);
      return tasks.create(principal(request), {
        roomId: request.params.roomId,
        title: requiredString(body.title, "title", 160),
        goal: requiredString(body.goal, "goal", 20_000),
        ...(body.parentTaskId === undefined
          ? {}
          : {
              parentTaskId: body.parentTaskId === null
                ? null
                : requiredString(body.parentTaskId, "parentTaskId", 140)
            }),
        ...(body.primaryAgentId === undefined
          ? {}
          : {
              primaryAgentId: body.primaryAgentId === null
                ? null
                : requiredString(body.primaryAgentId, "primaryAgentId", 140)
            }),
        ...(body.workspaceRef === undefined
          ? {}
          : {
              workspaceRef: body.workspaceRef === null
                ? null
                : requiredString(body.workspaceRef, "workspaceRef", 512)
            })
      }, clock());
    }
  );
  app.patch<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (request) => {
      const body = bodyObject(request);
      return tasks.update(principal(request), request.params.taskId, {
        ...(body.title === undefined
          ? {}
          : { title: requiredString(body.title, "title", 160) }),
        ...(body.goal === undefined
          ? {}
          : { goal: requiredString(body.goal, "goal", 20_000) }),
        ...(body.state === undefined
          ? {}
          : { state: requiredString(body.state, "state") as AgentTaskState }),
        ...(body.primaryAgentId === undefined
          ? {}
          : {
              primaryAgentId: body.primaryAgentId === null
                ? null
                : requiredString(body.primaryAgentId, "primaryAgentId", 140)
            }),
        ...(body.workspaceRef === undefined
          ? {}
          : {
              workspaceRef: body.workspaceRef === null
                ? null
                : requiredString(body.workspaceRef, "workspaceRef", 512)
            })
      }, clock());
    }
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/artifacts",
    async (request) => taskArtifacts.list(
      principal(request),
      request.params.taskId
    )
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/artifacts",
    async (request) => {
      const body = bodyObject(request);
      return taskArtifacts.create(principal(request), request.params.taskId, {
        type: requiredString(body.type, "type") as ArtifactType,
        title: requiredString(body.title, "title", 160),
        summary: requiredString(body.summary, "summary", 4_000),
        ...(body.workspaceRef === undefined
          ? {}
          : {
              workspaceRef: body.workspaceRef === null
                ? null
                : requiredString(body.workspaceRef, "workspaceRef", 512)
            }),
        ...(body.repository === undefined
          ? {}
          : {
              repository: body.repository === null
                ? null
                : requiredString(body.repository, "repository", 512)
            }),
        ...(body.path === undefined
          ? {}
          : {
              path: body.path === null
                ? null
                : requiredString(body.path, "path", 1024)
            }),
        ...(body.commitSha === undefined
          ? {}
          : {
              commitSha: body.commitSha === null
                ? null
                : requiredString(body.commitSha, "commitSha", 64)
            }),
        ...(body.branch === undefined
          ? {}
          : {
              branch: body.branch === null
                ? null
                : requiredString(body.branch, "branch", 255)
            }),
        ...(body.sourceRunId === undefined
          ? {}
          : {
              sourceRunId: body.sourceRunId === null
                ? null
                : requiredString(body.sourceRunId, "sourceRunId", 140)
            })
      }, clock());
    }
  );
  app.get<{
    Params: { roomId: string };
    Querystring: { after?: string; limit?: string };
  }>("/api/rooms/:roomId/memory-entries", async (request) => {
    const cursor = memoryCursor(request.query);
    return longTermMemory.listRoom(
      principal(request), request.params.roomId, cursor.after, cursor.limit
    );
  });
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/memory-entries",
    async (request) => {
      const entry = longTermMemory.createRoom(
        principal(request),
        request.params.roomId,
        memoryInput(bodyObject(request)),
        clock()
      );
      const room = core.getRoom(entry.roomId);
      if (room) teamChanges.notify(room.teamId, { kind: "room", roomId: room.roomId });
      return entry;
    }
  );
  app.get<{
    Params: { taskId: string };
    Querystring: { after?: string; limit?: string };
  }>("/api/tasks/:taskId/memory-entries", async (request) => {
    const cursor = memoryCursor(request.query);
    return longTermMemory.listTask(
      principal(request), request.params.taskId, cursor.after, cursor.limit
    );
  });
  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/memory-entries",
    async (request) => {
      const entry = longTermMemory.createTask(
        principal(request),
        request.params.taskId,
        memoryInput(bodyObject(request)),
        clock()
      );
      const room = core.getRoom(entry.roomId);
      if (room) teamChanges.notify(room.teamId, { kind: "room", roomId: room.roomId });
      return entry;
    }
  );
  app.post<{ Params: { memoryId: string } }>(
    "/api/memory-entries/:memoryId/retract",
    async (request) => {
      const entry = longTermMemory.retract(
        principal(request), request.params.memoryId, clock()
      );
      const room = core.getRoom(entry.roomId);
      if (room) teamChanges.notify(room.teamId, { kind: "room", roomId: room.roomId });
      return entry;
    }
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/clarifications",
    async (request) => taskClarifications.list(
      principal(request),
      request.params.taskId,
      clock()
    )
  );
  app.post<{ Params: { clarificationId: string } }>(
    "/api/clarifications/:clarificationId/answer",
    async (request) => {
      const body = bodyObject(request);
      const resumed = taskClarifications.answer(
        principal(request),
        request.params.clarificationId,
        requiredString(body.answer, "answer", 20_000),
        clock()
      );
      const dispatched = delivery.dispatch(resumed.run.runId);
      app.log.info({
        event: "task.clarification.resumed",
        traceId: resumed.run.traceId,
        taskId: resumed.clarification.taskId,
        clarificationId: resumed.clarification.clarificationId,
        requestingRunId: resumed.clarification.requestingRunId,
        continuationRunId: resumed.run.runId,
        agentId: resumed.run.targetAgentId,
        deviceId: dispatched?.deviceId ?? null,
        sendCount: dispatched?.sendCount ?? 0,
        sent: (dispatched?.sendCount ?? 0) > 0
      }, "Task clarification resumed");
      const room = core.getRoom(resumed.clarification.roomId);
      if (room) {
        teamChanges.notify(room.teamId, {
          kind: "room",
          roomId: resumed.clarification.roomId
        });
      }
      return resumed;
    }
  );
}
