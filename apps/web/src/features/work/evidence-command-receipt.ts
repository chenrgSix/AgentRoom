export type EvidenceCommandKind = "remote_adoption" | "integration_approval";

export interface EvidenceCommandScope {
  memberId: string;
  teamId: string;
  taskId: string;
  planId: string;
  nodeKey: string;
  kind: EvidenceCommandKind;
}

export interface PendingEvidenceCommand {
  version: 1;
  scope: EvidenceCommandScope;
  operationId: string;
  template: Record<string, unknown>;
}

const prefix = "convenewire.execution-evidence-command.v1";

function storage(): Storage {
  if (typeof window === "undefined" || !window.sessionStorage) {
    throw new Error("Tab session storage is unavailable");
  }
  return window.sessionStorage;
}

function key(scope: EvidenceCommandScope): string {
  return [prefix, scope.memberId, scope.teamId, scope.taskId, scope.planId,
    scope.nodeKey, scope.kind].map(encodeURIComponent).join(":");
}

function sameScope(left: EvidenceCommandScope, right: EvidenceCommandScope): boolean {
  return left.memberId === right.memberId && left.teamId === right.teamId &&
    left.taskId === right.taskId && left.planId === right.planId &&
    left.nodeKey === right.nodeKey && left.kind === right.kind;
}

function valid(
  value: unknown,
  expected: EvidenceCommandScope
): value is PendingEvidenceCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<PendingEvidenceCommand>;
  return record.version === 1 && Boolean(record.scope) &&
    sameScope(record.scope as EvidenceCommandScope, expected) &&
    typeof record.operationId === "string" &&
    /^op_[A-Za-z0-9_-]{8,128}$/u.test(record.operationId) &&
    Boolean(record.template) && typeof record.template === "object" &&
    !Array.isArray(record.template);
}

export function readPendingEvidenceCommand(
  scope: EvidenceCommandScope
): PendingEvidenceCommand | null {
  const raw = storage().getItem(key(scope));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!valid(parsed, scope)) {
    throw new Error("Stored proof command is invalid and was not submitted");
  }
  return parsed;
}

export function savePendingEvidenceCommand(
  command: PendingEvidenceCommand
): void {
  storage().setItem(key(command.scope), JSON.stringify(command));
}

export function clearPendingEvidenceCommand(
  command: PendingEvidenceCommand
): void {
  const current = readPendingEvidenceCommand(command.scope);
  if (current?.operationId === command.operationId &&
    JSON.stringify(current.template) === JSON.stringify(command.template)) {
    storage().removeItem(key(command.scope));
  }
}
