import {
  type RunActivityProjection,
  type RunEventRecord,
  type RunOutputProjection
} from "./room-sync.js";
import type { LocalSession, Run } from "./models.js";

const userKey = "agent-room.local-user";
export const webSessionExpiredEvent = "convenewire:web-session-expired";
let webSessionGeneration = 0;

export function advanceWebSessionGeneration(): void {
  webSessionGeneration += 1;
}

export function captureWebSessionScope(): () => boolean {
  const generation = webSessionGeneration;
  return () => generation === webSessionGeneration;
}

export class StaleWebSessionError extends Error {
  public constructor() {
    super("The request belongs to a previous Web session");
    this.name = "AbortError";
  }
}

export function isStaleWebSessionError(reason: unknown): reason is StaleWebSessionError {
  return reason instanceof StaleWebSessionError;
}

export class HttpRequestError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export async function jsonRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const generation = webSessionGeneration;
  const publicEntry = /^\/api\/(?:bootstrap$|auth\/(?:status$|setup$|recover-owner$|recover-member$|member-invitations\/claim$))/u.test(path);
  const requireCurrentSession = () => {
    if (!publicEntry && generation !== webSessionGeneration) {
      throw new StaleWebSessionError();
    }
  };
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    });
  } catch (reason) {
    requireCurrentSession();
    throw reason;
  }
  requireCurrentSession();
  let body: T & { error?: { message?: string } };
  try {
    body = await response.json() as typeof body;
  } catch (reason) {
    requireCurrentSession();
    throw reason;
  }
  requireCurrentSession();
  if (!response.ok) {
    if (response.status === 401 && !publicEntry && generation === webSessionGeneration && typeof window !== "undefined") {
      window.dispatchEvent(new window.Event(webSessionExpiredEvent));
    }
    throw new HttpRequestError(body.error?.message ?? `Request failed (${response.status})`, response.status);
  }
  return body;
}

export function bridgeServerURL(): string {
  const current = import.meta.env?.VITE_CONVENE_WIRE_SERVER_URL?.trim();
  const legacy = import.meta.env?.VITE_AGENT_ROOM_SERVER_URL?.trim();
  if (current && legacy && current !== legacy) {
    throw new Error(
      "VITE_CONVENE_WIRE_SERVER_URL conflicts with legacy VITE_AGENT_ROOM_SERVER_URL"
    );
  }
  const configured = current || legacy;
  if (configured) return configured.replace(/\/$/u, "");
  if (window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  return window.location.origin;
}

export async function localBootstrap(): Promise<LocalSession> {
  const saved = localStorage.getItem(userKey);
  const existing = saved
    ? JSON.parse(saved) as { userId: string; displayName: string }
    : null;
  const displayName = existing?.displayName ?? "Local Owner";
  const result = await jsonRequest<{
    user: { userId: string; displayName: string };
    session: { token: string };
  }>("/api/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      displayName,
      ...(existing ? { userId: existing.userId } : {})
    })
  });
  localStorage.setItem(userKey, JSON.stringify(result.user));
  return { ...result.user, token: result.session.token };
}

export function invitationTokenFromFragment(fragment: string): string | null {
  const match = /^#\/join\/([A-Za-z0-9_-]{16,256})$/u.exec(fragment);
  return match?.[1] ?? null;
}

export const activeRunStates = new Set<Run["state"]>([
  "queued",
  "delivered",
  "working",
  "input_required"
]);

export async function loadRunOutputEvents(
  roomRuns: Run[],
  current: Map<string, RunOutputProjection>,
  currentActivities: Map<string, RunActivityProjection>,
  token?: string
): Promise<Map<string, RunEventRecord[]>> {
  const candidates = roomRuns.filter((run) =>
    activeRunStates.has(run.state) || current.has(run.runId) ||
    currentActivities.has(run.runId)
  );
  const batches = await Promise.all(candidates.map(async (run) => {
    const knownSequences = [
      current.get(run.runId)?.sequence,
      currentActivities.get(run.runId)?.sequence
    ].filter((value): value is number => value !== undefined);
    const after = knownSequences.length > 0 ? Math.min(...knownSequences) : 0;
    const records = await jsonRequest<RunEventRecord[]>(
      `/api/runs/${run.runId}/events?after=${after}`,
      {},
      token
    );
    return [run.runId, records] as const;
  }));
  return new Map(batches);
}
