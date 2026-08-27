import type {
  AttentionElement,
  LifecycleState,
  Priority,
  Scope,
  WorkbenchQuery
} from "@agent-room/contracts/task-result";

import { noStore } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

const allowedKeys = new Set([
  "scope", "attention", "lifecycleState", "priority", "ownerMemberId",
  "roomId", "agentId", "updatedAfter", "updatedBefore", "limit", "cursor"
]);

function scalar(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be singular`);
  return value;
}

function list(value: unknown, label: string): string[] {
  const input = scalar(value, label);
  if (!input) return [];
  const values = input.split(",").map((entry) => entry.trim());
  if (values.some((entry) => entry.length === 0) ||
    new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique comma-separated values`);
  }
  return values;
}

function optionalId(value: unknown, label: string): string | null {
  const input = scalar(value, label);
  if (input === undefined) return null;
  if (!/^[a-z]+_[A-Za-z0-9_-]{8,128}$/u.test(input)) {
    throw new Error(`${label} is invalid`);
  }
  return input;
}

function queryInput(value: Record<string, unknown>): WorkbenchQuery {
  const extras = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (extras.length > 0) {
    throw new Error(`Workbench query contains unsupported fields: ${extras.join(", ")}`);
  }
  const scope = scalar(value.scope, "scope") ?? "mine";
  const limitText = scalar(value.limit, "limit");
  const limit = limitText === undefined ? 50 : Number(limitText);
  const cursor = scalar(value.cursor, "cursor") ?? null;
  if (cursor !== null && !/^[A-Za-z0-9_-]{8,512}$/u.test(cursor)) {
    throw new Error("Workbench cursor is invalid");
  }
  return {
    scope: scope as Scope,
    attention: list(value.attention, "attention") as AttentionElement[],
    lifecycleState: list(value.lifecycleState, "lifecycleState") as LifecycleState[],
    priority: list(value.priority, "priority") as Priority[],
    ownerMemberId: optionalId(value.ownerMemberId, "ownerMemberId"),
    roomId: optionalId(value.roomId, "roomId"),
    agentId: optionalId(value.agentId, "agentId"),
    updatedAfter: scalar(value.updatedAfter, "updatedAfter") ?? null,
    updatedBefore: scalar(value.updatedBefore, "updatedBefore") ?? null,
    limit,
    cursor
  };
}

export function registerWorkbenchRoutes({
  app,
  principal,
  workbench
}: ServerRouteContext): void {
  app.get<{
    Params: { teamId: string };
    Querystring: Record<string, unknown>;
  }>("/api/teams/:teamId/work-items", async (request, reply) => {
    noStore(reply);
    return workbench.list(
      principal(request),
      request.params.teamId,
      queryInput(request.query)
    );
  });
}
