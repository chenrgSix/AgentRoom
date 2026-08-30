import type { ArtifactType } from "../task/artifact-repository.js";
import type { MemoryEntryType } from "../task/memory-entry-repository.js";
import type {
  AgentTaskState,
  TaskAssignmentRole,
  TaskCompletionPolicy,
  TaskCriterion,
  TaskLifecycleState,
  TaskPriority,
  TaskSchedulingState
} from "../task/task-repository.js";
import { artifactRelationInput } from "./artifact-relation-input.js";
import {
  bodyObject,
  noStore,
  requiredBoolean,
  requiredPositiveInteger,
  requiredStringArray,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerTaskRoutes({
  app,
  artifactPreviews,
  clock,
  core,
  dispatchRun,
  longTermMemory,
  principal,
  taskArtifacts,
  taskClarifications,
  tasks,
  teamChanges
}: ServerRouteContext): void {
  const objectInput = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
  };
  const criteriaInput = (value: unknown): TaskCriterion[] => {
    if (!Array.isArray(value)) throw new Error("criteria must be an array");
    return value.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`criteria[${index}] must be an object`);
      }
      const criterion = entry as Record<string, unknown>;
      return {
        criterionKey: requiredString(
          criterion.criterionKey,
          `criteria[${index}].criterionKey`,
          80
        ),
        description: requiredString(
          criterion.description,
          `criteria[${index}].description`,
          2_000
        ),
        required: requiredBoolean(
          criterion.required,
          `criteria[${index}].required`
        ),
        ordinal: requiredPositiveInteger(
          criterion.ordinal,
          `criteria[${index}].ordinal`
        )
      };
    });
  };
  const assignmentsInput = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error("assignments must be an array");
    return value.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`assignments[${index}] must be an object`);
      }
      const assignment = entry as Record<string, unknown>;
      return {
        agentId: requiredString(
          assignment.agentId,
          `assignments[${index}].agentId`,
          140
        ),
        role: requiredString(
          assignment.role,
          `assignments[${index}].role`
        ) as TaskAssignmentRole
      };
    });
  };
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
  const notifyTask = (task: { roomId: string }) => {
    const room = core.getRoom(task.roomId);
    if (room) teamChanges.notify(room.teamId, {
      kind: "room",
      roomId: task.roomId
    });
    return task;
  };
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/tasks",
    async (request) => tasks.list(principal(request), request.params.roomId)
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (request) => tasks.get(principal(request), request.params.taskId)
  );
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/tasks",
    async (request) => {
      const body = bodyObject(request);
      const budget = body.budgetPolicy === undefined
        ? undefined
        : objectInput(body.budgetPolicy, "budgetPolicy");
      return notifyTask(tasks.create(principal(request), {
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
            }),
        ...(body.ownerMemberId === undefined
          ? {}
          : {
              ownerMemberId: requiredString(
                body.ownerMemberId,
                "ownerMemberId",
                140
              )
            }),
        ...(body.completionPolicy === undefined
          ? {}
          : {
              completionPolicy: requiredString(
                body.completionPolicy,
                "completionPolicy"
              ) as TaskCompletionPolicy
            }),
        ...(body.priority === undefined
          ? {}
          : { priority: requiredString(body.priority, "priority") as TaskPriority }),
        ...(body.dueAt === undefined
          ? {}
          : {
              dueAt: body.dueAt === null
                ? null
                : requiredString(body.dueAt, "dueAt", 80)
            }),
        ...(body.lifecycleState === undefined
          ? {}
          : {
              lifecycleState: requiredString(
                body.lifecycleState,
                "lifecycleState"
              ) as "draft" | "ready"
            }),
        ...(body.criteria === undefined
          ? {}
          : { criteria: criteriaInput(body.criteria) }),
        ...(body.assignments === undefined
          ? {}
          : { assignments: assignmentsInput(body.assignments) }),
        ...(budget === undefined
          ? {}
          : {
              budgetPolicy: {
                maxRunAttempts: requiredPositiveInteger(
                  budget.maxRunAttempts,
                  "budgetPolicy.maxRunAttempts"
                ),
                maxExecutionDurationSeconds: requiredPositiveInteger(
                  budget.maxExecutionDurationSeconds,
                  "budgetPolicy.maxExecutionDurationSeconds"
                )
              }
            })
      }, clock()));
    }
  );
  app.patch<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (request) => {
      const body = bodyObject(request);
      return notifyTask(tasks.update(principal(request), request.params.taskId, {
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
      }, clock()));
    }
  );
  app.put<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/definition",
    async (request) => {
      const body = bodyObject(request);
      const budget = objectInput(body.budgetPolicy, "budgetPolicy");
      return notifyTask(tasks.updateDefinition(principal(request), request.params.taskId, {
        operationId: requiredString(body.operationId, "operationId", 140),
        expectedTaskRevision: requiredPositiveInteger(
          body.expectedTaskRevision,
          "expectedTaskRevision"
        ),
        title: requiredString(body.title, "title", 160),
        goal: requiredString(body.goal, "goal", 20_000),
        ownerMemberId: requiredString(body.ownerMemberId, "ownerMemberId", 140),
        completionPolicy: requiredString(
          body.completionPolicy,
          "completionPolicy"
        ) as TaskCompletionPolicy,
        priority: requiredString(body.priority, "priority") as TaskPriority,
        dueAt: body.dueAt === null
          ? null
          : requiredString(body.dueAt, "dueAt", 80),
        criteria: criteriaInput(body.criteria),
        assignments: assignmentsInput(body.assignments),
        budgetPolicy: {
          maxRunAttempts: requiredPositiveInteger(
            budget.maxRunAttempts,
            "budgetPolicy.maxRunAttempts"
          ),
          maxExecutionDurationSeconds: requiredPositiveInteger(
            budget.maxExecutionDurationSeconds,
            "budgetPolicy.maxExecutionDurationSeconds"
          )
        }
      }, clock()));
    }
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/control",
    async (request) => {
      const body = bodyObject(request);
      return notifyTask(tasks.updateControl(principal(request), request.params.taskId, {
        operationId: requiredString(body.operationId, "operationId", 140),
        expectedTaskRevision: requiredPositiveInteger(
          body.expectedTaskRevision,
          "expectedTaskRevision"
        ),
        ...(body.lifecycleState === undefined
          ? {}
          : {
              lifecycleState: requiredString(
                body.lifecycleState,
                "lifecycleState"
              ) as TaskLifecycleState
            }),
        ...(body.schedulingState === undefined
          ? {}
          : {
              schedulingState: requiredString(
                body.schedulingState,
                "schedulingState"
              ) as TaskSchedulingState
            })
      }, clock()));
    }
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/blocks",
    async (request) => {
      const body = bodyObject(request);
      return notifyTask(tasks.addBlock(principal(request), request.params.taskId, {
        operationId: requiredString(body.operationId, "operationId", 140),
        expectedTaskRevision: requiredPositiveInteger(
          body.expectedTaskRevision,
          "expectedTaskRevision"
        ),
        reason: requiredString(body.reason, "reason", 2_000)
      }, clock()));
    }
  );
  app.post<{ Params: { taskId: string; blockId: string } }>(
    "/api/tasks/:taskId/blocks/:blockId/resolve",
    async (request) => {
      const body = bodyObject(request);
      return notifyTask(tasks.resolveBlock(
        principal(request),
        request.params.taskId,
        request.params.blockId,
        {
          operationId: requiredString(body.operationId, "operationId", 140),
          expectedTaskRevision: requiredPositiveInteger(
            body.expectedTaskRevision,
            "expectedTaskRevision"
          )
        },
        clock()
      ));
    }
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/artifacts",
    async (request) => taskArtifacts.list(
      principal(request),
      request.params.taskId
    )
  );
  app.get<{ Params: { taskId: string; artifactId: string } }>(
    "/api/tasks/:taskId/artifacts/:artifactId/preview",
    async (request, reply) => {
      const preview = artifactPreviews.read(
        principal(request),
        request.params.taskId,
        request.params.artifactId
      );
      noStore(reply);
      void reply.header("x-content-type-options", "nosniff");
      return preview;
    }
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
            }),
        ...(body.relations === undefined
          ? {}
          : { relations: artifactRelationInput(body.relations) })
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
      const dispatchedRun = await dispatchRun(resumed.run);
      app.log.info({
        event: "task.clarification.resumed",
        traceId: resumed.run.traceId,
        taskId: resumed.clarification.taskId,
        clarificationId: resumed.clarification.clarificationId,
        requestingRunId: resumed.clarification.requestingRunId,
        continuationRunId: resumed.run.runId,
        agentId: resumed.run.targetAgentId,
        state: dispatchedRun.state
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
