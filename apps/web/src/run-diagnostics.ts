export type RuntimeFailureCategory =
  | "start"
  | "authentication"
  | "rate_limit"
  | "network"
  | "model"
  | "configuration"
  | "unknown";

export interface RunDiagnostic {
  code: string;
  category: RuntimeFailureCategory | null;
  exitCode: number | null;
  retryable: boolean;
  stderrCaptured: boolean;
}

interface RunEventView {
  event?: {
    type?: unknown;
    error?: unknown;
  };
}

const categories = new Set<RuntimeFailureCategory>([
  "start",
  "authentication",
  "rate_limit",
  "network",
  "model",
  "configuration",
  "unknown"
]);

export function projectRunDiagnostic(events: RunEventView[]): RunDiagnostic | null {
  for (const record of [...events].reverse()) {
    if (record.event?.type !== "status") continue;
    const error = record.event.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) continue;
    const source = error as Record<string, unknown>;
    if (typeof source.code !== "string" || source.code.trim().length === 0) continue;
    const details = source.details && typeof source.details === "object" &&
      !Array.isArray(source.details)
      ? source.details as Record<string, unknown>
      : {};
    const category = typeof details.category === "string" &&
      categories.has(details.category as RuntimeFailureCategory)
      ? details.category as RuntimeFailureCategory
      : null;
    return {
      code: source.code,
      category,
      exitCode: typeof details.exitCode === "number" &&
        Number.isSafeInteger(details.exitCode)
        ? details.exitCode
        : null,
      retryable: source.retryable === true,
      stderrCaptured: details.stderrCaptured === true
    };
  }
  return null;
}

export async function loadRunDiagnostic(
  runId: string,
  requestEvents: (path: string) => Promise<RunEventView[]>
): Promise<RunDiagnostic | null> {
  const events = await requestEvents(`/api/runs/${encodeURIComponent(runId)}/events`);
  return projectRunDiagnostic(events);
}
