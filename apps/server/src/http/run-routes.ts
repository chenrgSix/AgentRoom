import {
  bodyObject,
  noStore,
  requiredPositiveInteger,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";
import { truncateUnicodeCodePoints } from "../domain/unicode-length.js";

export function registerRunRoutes({
  app,
  auth,
  cancellations,
  clock,
  core,
  dispatchRun,
  principal,
  runRepository,
  runs,
  teamChanges,
  traces
}: ServerRouteContext): void {
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/runs",
    async (request) => runs.listRoomRuns(
      principal(request), request.params.roomId, clock()
    )
  );
  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/runs",
    async (request) => runs.listTaskRuns(
      principal(request), request.params.taskId
    )
  );
  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    async (request) => runs.get(principal(request), request.params.runId)
  );
  app.get<{
    Params: { runId: string };
    Querystring: { after?: string };
  }>(
    "/api/runs/:runId/events",
    async (request) => {
      const actor = principal(request);
      const run = runRepository.getRun(request.params.runId);
      if (!run) {
        throw new Error(`Run not found: ${request.params.runId}`);
      }
      runs.listRoomRuns(actor, run.roomId);
      const after = request.query.after === undefined
        ? 0
        : Number.parseInt(request.query.after, 10);
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new Error("Run event cursor must be a non-negative integer");
      }
      return runRepository.listEvents(run.runId, after);
    }
  );
  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId/context-manifest",
    async (request) => runs.getContextManifest(
      principal(request),
      request.params.runId
    )
  );
  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId/ambiguity-acknowledgement",
    async (request, reply) => {
      noStore(reply);
      return {
        acknowledgement: runs.getAmbiguityAcknowledgement(
          principal(request), request.params.runId
        )
      };
    }
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/ambiguity-acknowledgement",
    async (request) => {
      const body = bodyObject(request);
      const acknowledgement = runs.acknowledgeAmbiguity(
        principal(request),
        request.params.runId,
        {
          operationId: requiredString(body.operationId, "operationId", 140),
          expectedTaskRevision: requiredPositiveInteger(
            body.expectedTaskRevision,
            "expectedTaskRevision"
          ),
          reason: requiredString(body.reason, "reason", 1000)
        },
        clock()
      );
      const run = runRepository.getRun(request.params.runId);
      const room = run && core.getRoom(run.roomId);
      if (room && run) teamChanges.notify(room.teamId, {
        kind: "room",
        roomId: run.roomId
      });
      return acknowledgement;
    }
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/retry",
    async (request) => {
      const body = bodyObject(request);
      const retry = runs.retry(
        principal(request),
        request.params.runId,
        {
          operationId: requiredString(body.operationId, "operationId", 140),
          expectedTaskRevision: requiredPositiveInteger(
            body.expectedTaskRevision,
            "expectedTaskRevision"
          )
        },
        clock()
      );
      await dispatchRun(retry);
      return retry;
    }
  );
  app.get<{ Params: { traceId: string } }>(
    "/api/traces/:traceId",
    async (request) => {
      const actor = principal(request);
      const entries = traces.list(request.params.traceId);
      const roomId = entries[0]?.roomId;
      if (!roomId) {
        throw new Error(`Trace not found: ${request.params.traceId}`);
      }
      auth.requireRoomMember(actor, roomId);
      return { traceId: request.params.traceId, entries };
    }
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/cancel",
    async (request) => {
      const body = bodyObject(request);
      const reason = truncateUnicodeCodePoints(
        typeof body.reason === "string"
          ? body.reason.trim()
          : "Canceled from Web",
        512
      ) || "Canceled from Web";
      const canceled = cancellations.cancel(
        principal(request),
        request.params.runId,
        reason
      );
      return canceled;
    }
  );
}
