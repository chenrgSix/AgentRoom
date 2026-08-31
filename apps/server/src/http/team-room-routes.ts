import { AuthorizationError } from "../security/auth-service.js";
import type { RoomCollaborationPolicy } from "../team-room/room-collaboration-policy.js";
import {
  bodyObject,
  noStore,
  queryBoolean,
  requiredBoolean,
  requiredPositiveInteger,
  requiredString,
  requiredStringArray
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerTeamRoomRoutes({
  app,
  auth,
  clock,
  core,
  principal,
  teamChanges,
  teamRooms
}: ServerRouteContext): void {
  app.get<{ Querystring: { includeArchived?: string } }>(
    "/api/teams",
    async (request) => teamRooms.listTeams(
      principal(request),
      queryBoolean(request.query.includeArchived, "includeArchived")
    )
  );
  app.get<{
    Params: { teamId: string };
    Querystring: { after?: string };
  }>("/api/teams/:teamId/changes", async (request, reply) => {
    auth.requireTeamMember(principal(request), request.params.teamId);
    const after = request.query.after === undefined
      ? 0
      : Number.parseInt(request.query.after, 10);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Team change cursor must be a non-negative integer");
    }
    noStore(reply);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Team change client disconnected"));
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const changes = await teamChanges.wait(request.params.teamId, after, {
        signal: controller.signal
      });
      // A recovery, logout or Team archive can revoke access while this
      // request waits. Do not publish even change hints under stale authority.
      auth.requireTeamMember(principal(request), request.params.teamId);
      return changes;
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });
  app.post("/api/teams", async (request) => {
    const actor = principal(request);
    auth.requireFullWebSession(actor);
    const user = core.getUser(actor.userId);
    if (!user) {
      throw new AuthorizationError("UNAUTHENTICATED", "Session User not found");
    }
    const body = bodyObject(request);
    return teamRooms.createTeamForUser({
      userId: actor.userId,
      userDisplayName: user.displayName,
      teamName: requiredString(body.name, "name"),
      now: clock()
    });
  });
  app.patch<{ Params: { teamId: string } }>(
    "/api/teams/:teamId",
    async (request) => {
      const body = bodyObject(request);
      return teamRooms.updateTeam(principal(request), request.params.teamId, {
        ...(body.name === undefined
          ? {}
          : { name: requiredString(body.name, "name") }),
        ...(body.archived === undefined
          ? {}
          : { archived: requiredBoolean(body.archived, "archived") })
      }, clock());
    }
  );
  app.get<{
    Params: { teamId: string };
    Querystring: { includeArchived?: string };
  }>(
    "/api/teams/:teamId/rooms",
    async (request) => teamRooms.listRooms(
      principal(request),
      request.params.teamId,
      queryBoolean(request.query.includeArchived, "includeArchived")
    )
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/rooms",
    async (request) => {
      const body = bodyObject(request);
      return teamRooms.createRoom(
        principal(request),
        request.params.teamId,
        requiredString(body.name, "name"),
        clock()
      );
    }
  );
  app.patch<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId",
    async (request) => {
      const body = bodyObject(request);
      return teamRooms.updateRoom(principal(request), request.params.roomId, {
        ...(body.name === undefined
          ? {}
          : { name: requiredString(body.name, "name") }),
        ...(body.archived === undefined
          ? {}
          : { archived: requiredBoolean(body.archived, "archived") })
      }, clock());
    }
  );
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/participants",
    async (request) => teamRooms.getRoomParticipants(
      principal(request),
      request.params.roomId
    )
  );
  app.put<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/participants",
    async (request) => {
      const body = bodyObject(request);
      return teamRooms.replaceRoomParticipants(
        principal(request),
        request.params.roomId,
        {
          memberIds: requiredStringArray(body.memberIds, "memberIds"),
          agentIds: requiredStringArray(body.agentIds, "agentIds")
        },
        clock()
      );
    }
  );
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/settings",
    async (request) => teamRooms.getRoomSettings(
      principal(request),
      request.params.roomId
    )
  );
  app.put<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/settings",
    async (request) => {
      const body = bodyObject(request);
      const rawPolicy = body.collaborationPolicy;
      if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
        throw new Error("collaborationPolicy must be a JSON object");
      }
      return teamRooms.updateRoomSettings(
        principal(request),
        request.params.roomId,
        {
          participants: {
            memberIds: requiredStringArray(body.memberIds, "memberIds"),
            agentIds: requiredStringArray(body.agentIds, "agentIds")
          },
          collaborationPolicy: rawPolicy as unknown as RoomCollaborationPolicy,
          expectedRevision: requiredPositiveInteger(
            body.expectedRevision,
            "expectedRevision"
          )
        },
        clock()
      );
    }
  );
}
