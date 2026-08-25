import type { MemoryCandidateState } from "../memory/memory-candidate-service.js";
import { bodyObject, requiredString } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

const candidateStates = new Set<MemoryCandidateState | "all">([
  "pending", "accepted", "rejected", "all"
]);

export function registerMemoryCandidateRoutes({
  app,
  clock,
  core,
  memoryCandidates,
  principal,
  teamChanges
}: ServerRouteContext): void {
  app.get<{
    Params: { roomId: string };
    Querystring: { state?: string; limit?: string };
  }>("/api/rooms/:roomId/memory-candidates", async (request) => {
    const state = request.query.state ?? "pending";
    const limit = request.query.limit === undefined
      ? 100
      : Number.parseInt(request.query.limit, 10);
    if (!candidateStates.has(state as MemoryCandidateState | "all")) {
      throw new Error("Memory candidate state is invalid");
    }
    return memoryCandidates.listRoom(
      principal(request),
      request.params.roomId,
      state as MemoryCandidateState | "all",
      limit
    );
  });

  app.post<{ Params: { candidateId: string } }>(
    "/api/memory-candidates/:candidateId/accept",
    async (request) => {
      const candidate = memoryCandidates.accept(
        principal(request), request.params.candidateId, clock()
      );
      const room = core.getRoom(candidate.roomId);
      if (room) {
        teamChanges.notify(room.teamId, { kind: "room", roomId: room.roomId });
      }
      return candidate;
    }
  );

  app.post<{ Params: { candidateId: string } }>(
    "/api/memory-candidates/:candidateId/reject",
    async (request) => {
      const body = bodyObject(request);
      const candidate = memoryCandidates.reject(
        principal(request),
        request.params.candidateId,
        body.reason === undefined
          ? undefined
          : requiredString(body.reason, "reason", 500),
        clock()
      );
      const room = core.getRoom(candidate.roomId);
      if (room) {
        teamChanges.notify(room.teamId, { kind: "room", roomId: room.roomId });
      }
      return candidate;
    }
  );
}
