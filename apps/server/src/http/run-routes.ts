import {
  bodyObject,
  requiredPositiveInteger,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerRunRoutes({
  app,
  auth,
  cancellations,
  clock,
  principal,
  runRepository,
  runs,
  traces
}: ServerRouteContext): void {
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/runs",
    async (request) => runs.listRoomRuns(
      principal(request), request.params.roomId, clock()
    )
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
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/ambiguity-acknowledgement",
    async (request) => {
      const body = bodyObject(request);
      return runs.acknowledgeAmbiguity(
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
    }
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/retry",
    async (request) => {
      const body = bodyObject(request);
      return runs.retry(
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
      return cancellations.cancel(
        principal(request),
        request.params.runId,
        typeof body.reason === "string" ? body.reason : "Canceled from Web"
      );
    }
  );
}
