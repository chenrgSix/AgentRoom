import type {
  ResultProposal,
  ResultReviewCommand
} from "@agent-room/contracts/task-result";

import {
  bodyObject,
  bearerToken,
  noStore,
  requiredBoolean,
  requiredPositiveInteger,
  requiredString,
  requiredStringArray
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => objectInput(entry, `${label}[${index}]`));
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}`);
  }
}

function proposalInput(body: Record<string, unknown>): ResultProposal {
  assertKeys(body, [
    "operationId", "taskId", "definitionRevision", "criteriaRevision",
    "proposedAtTaskRevision", "supersedesResultId", "outcome", "summary",
    "risks", "openQuestions", "nextActions", "sources", "criterionClaims"
  ], "Result proposal");
  const sources = objectArray(body.sources, "sources").map((source, index) => {
    const kind = requiredString(source.kind, `sources[${index}].kind`);
    const base = {
      evidenceRefId: requiredString(
        source.evidenceRefId,
        `sources[${index}].evidenceRefId`,
        80
      )
    };
    if (kind === "artifact") {
      assertKeys(source, ["evidenceRefId", "kind", "artifactId"], `sources[${index}]`);
      return {
        ...base,
        kind,
        artifactId: requiredString(source.artifactId, `sources[${index}].artifactId`, 140)
      };
    }
    if (kind === "run_event") {
      assertKeys(source, ["evidenceRefId", "kind", "runId", "sequence"], `sources[${index}]`);
      return {
        ...base,
        kind,
        runId: requiredString(source.runId, `sources[${index}].runId`, 140),
        sequence: requiredPositiveInteger(
          source.sequence,
          `sources[${index}].sequence`
        )
      };
    }
    if (kind === "message") {
      assertKeys(source, ["evidenceRefId", "kind", "messageId"], `sources[${index}]`);
      return {
        ...base,
        kind,
        messageId: requiredString(source.messageId, `sources[${index}].messageId`, 140)
      };
    }
    if (kind === "memory") {
      assertKeys(source, ["evidenceRefId", "kind", "memoryId"], `sources[${index}]`);
      return {
        ...base,
        kind,
        memoryId: requiredString(source.memoryId, `sources[${index}].memoryId`, 140)
      };
    }
    if (kind === "discussion") {
      assertKeys(source, ["evidenceRefId", "kind", "discussionId"], `sources[${index}]`);
      return {
        ...base,
        kind,
        discussionId: requiredString(
          source.discussionId,
          `sources[${index}].discussionId`,
          140
        )
      };
    }
    throw new Error(`sources[${index}].kind is unsupported`);
  }) as ResultProposal["sources"];
  const nextActions = objectArray(body.nextActions, "nextActions").map(
    (action, index) => {
      assertKeys(action, ["nextActionKey", "description"], `nextActions[${index}]`);
      return {
        nextActionKey: requiredString(
          action.nextActionKey,
          `nextActions[${index}].nextActionKey`,
          80
        ),
        description: requiredString(
          action.description,
          `nextActions[${index}].description`,
          2_000
        )
      };
    }
  );
  const criterionClaims = objectArray(
    body.criterionClaims,
    "criterionClaims"
  ).map((claim, index) => {
    assertKeys(claim, [
      "criterionKey", "coverage", "explanation", "evidenceRefIds"
    ], `criterionClaims[${index}]`);
    return {
      criterionKey: requiredString(
        claim.criterionKey,
        `criterionClaims[${index}].criterionKey`,
        80
      ),
      coverage: requiredString(
        claim.coverage,
        `criterionClaims[${index}].coverage`
      ) as ResultProposal["criterionClaims"][number]["coverage"],
      explanation: requiredString(
        claim.explanation,
        `criterionClaims[${index}].explanation`,
        4_000
      ),
      evidenceRefIds: requiredStringArray(
        claim.evidenceRefIds,
        `criterionClaims[${index}].evidenceRefIds`
      )
    };
  });
  return {
    operationId: requiredString(body.operationId, "operationId", 140),
    taskId: requiredString(body.taskId, "taskId", 140),
    definitionRevision: requiredPositiveInteger(
      body.definitionRevision,
      "definitionRevision"
    ),
    criteriaRevision: requiredPositiveInteger(
      body.criteriaRevision,
      "criteriaRevision"
    ),
    proposedAtTaskRevision: requiredPositiveInteger(
      body.proposedAtTaskRevision,
      "proposedAtTaskRevision"
    ),
    supersedesResultId: body.supersedesResultId === null
      ? null
      : requiredString(body.supersedesResultId, "supersedesResultId", 140),
    outcome: requiredString(body.outcome, "outcome") as ResultProposal["outcome"],
    summary: requiredString(body.summary, "summary", 20_000),
    risks: requiredStringArray(body.risks, "risks"),
    openQuestions: requiredStringArray(body.openQuestions, "openQuestions"),
    nextActions,
    sources,
    criterionClaims
  };
}

function reviewInput(body: Record<string, unknown>): ResultReviewCommand {
  assertKeys(body, [
    "operationId", "decision", "expectedTaskRevision",
    "expectedReviewRevision", "reason", "completeTask"
  ], "Result review");
  if (!Number.isSafeInteger(body.expectedReviewRevision) ||
    (body.expectedReviewRevision as number) < 0) {
    throw new Error("expectedReviewRevision must be a non-negative integer");
  }
  return {
    operationId: requiredString(body.operationId, "operationId", 140),
    decision: requiredString(body.decision, "decision") as
      ResultReviewCommand["decision"],
    expectedTaskRevision: requiredPositiveInteger(
      body.expectedTaskRevision,
      "expectedTaskRevision"
    ),
    expectedReviewRevision: body.expectedReviewRevision as number,
    reason: requiredString(body.reason, "reason", 4_000),
    completeTask: requiredBoolean(body.completeTask, "completeTask")
  };
}

export function registerResultRoutes({
  app,
  auth,
  clock,
  core,
  principal,
  results,
  teamChanges
}: ServerRouteContext): void {
  app.post("/api/bridge/results", async (request, reply) => {
    const device = auth.authenticateDevice(bearerToken(request), clock());
    const body = bodyObject(request);
    assertKeys(body, ["actorKind", "agentId", "runId", "proposal"],
      "Managed Result proposal");
    if (body.actorKind !== "managed_agent") {
      throw new Error("Managed Result actor kind is invalid");
    }
    const result = results.proposeManagedAgent(device, {
      agentId: requiredString(body.agentId, "agentId", 140),
      runId: requiredString(body.runId, "runId", 140),
      proposal: proposalInput(objectInput(body.proposal, "proposal"))
    }, clock());
    teamChanges.notify(device.teamId, { kind: "room", roomId: result.roomId });
    noStore(reply);
    return result;
  });
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/results",
    async (request) => results.list(principal(request), request.params.taskId)
  );
  app.get<{ Params: { resultId: string } }>(
    "/api/results/:resultId",
    async (request) => results.get(principal(request), request.params.resultId)
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/results",
    async (request) => {
      const proposal = proposalInput(bodyObject(request));
      if (proposal.taskId !== request.params.taskId) {
        throw new Error("Result Task does not match the route");
      }
      const result = results.proposeMember(principal(request), proposal, clock());
      const room = core.getRoom(result.roomId);
      if (room) teamChanges.notify(room.teamId, {
        kind: "room",
        roomId: result.roomId
      });
      return result;
    }
  );
  app.post<{ Params: { resultId: string } }>(
    "/api/results/:resultId/review-decisions",
    async (request) => {
      const outcome = results.review(
        principal(request),
        request.params.resultId,
        reviewInput(bodyObject(request)),
        clock()
      );
      const room = core.getRoom(outcome.result.roomId);
      if (room) teamChanges.notify(room.teamId, {
        kind: "room",
        roomId: outcome.result.roomId
      });
      return outcome;
    }
  );
  app.post<{ Params: { resultId: string } }>(
    "/api/results/:resultId/follow-up-tasks",
    async (request) => {
      const body = bodyObject(request);
      assertKeys(body, [
        "operationId", "nextActionKey", "title", "ownerMemberId"
      ], "Child Task command");
      const childTask = results.createChildTask(
        principal(request),
        request.params.resultId,
        {
        operationId: requiredString(body.operationId, "operationId", 140),
        nextActionKey: requiredString(body.nextActionKey, "nextActionKey", 80),
        title: requiredString(body.title, "title", 160),
        ownerMemberId: requiredString(body.ownerMemberId, "ownerMemberId", 140)
        },
        clock()
      );
      const room = core.getRoom(childTask.roomId);
      if (room) teamChanges.notify(room.teamId, {
        kind: "room",
        roomId: childTask.roomId
      });
      return childTask;
    }
  );
}
