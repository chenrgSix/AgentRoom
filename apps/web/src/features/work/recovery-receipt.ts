export type RecoveryKind = "ack" | "retry";

export interface RecoveryCommand {
  operationId: string;
  expectedTaskRevision: number;
  reason?: string;
}

export interface RecoveryReceiptScope {
  memberId: string;
  teamId: string;
  taskId: string;
  runId: string;
}

interface RecoveryReceipt extends RecoveryReceiptScope {
  version: 1;
  kind: RecoveryKind;
  command: RecoveryCommand;
}

const storagePrefix = "convenewire.recovery-receipt.v1";

function receiptKey(scope: RecoveryReceiptScope, kind: RecoveryKind): string {
  if (!scope.memberId || !scope.teamId || !scope.taskId || !scope.runId) {
    throw new Error("Recovery identity is incomplete");
  }
  return [storagePrefix, scope.memberId, scope.teamId, scope.taskId, scope.runId, kind]
    .map(encodeURIComponent).join(":");
}

function storage(): Storage {
  if (typeof window === "undefined") throw new Error("Recovery storage is unavailable");
  return window.sessionStorage;
}

function validCommand(command: unknown, kind: RecoveryKind): command is RecoveryCommand {
  if (!command || typeof command !== "object" || Array.isArray(command)) return false;
  const record = command as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== (kind === "ack"
    ? "expectedTaskRevision,operationId,reason"
    : "expectedTaskRevision,operationId")) return false;
  return typeof record.operationId === "string" && /^op_[A-Za-z0-9_-]{8,128}$/u.test(record.operationId) &&
    Number.isSafeInteger(record.expectedTaskRevision) && Number(record.expectedTaskRevision) >= 1 &&
    (kind === "retry" || (typeof record.reason === "string" && record.reason.trim().length > 0 && record.reason.length <= 1000));
}

function sameCommand(left: RecoveryCommand, right: RecoveryCommand): boolean {
  return left.operationId === right.operationId && left.expectedTaskRevision === right.expectedTaskRevision &&
    left.reason === right.reason;
}

export function readRecoveryReceipt(scope: RecoveryReceiptScope, kind: RecoveryKind): RecoveryCommand | null {
  const raw = storage().getItem(receiptKey(scope, kind));
  if (raw === null) return null;
  const receipt = JSON.parse(raw) as Partial<RecoveryReceipt>;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(",") !== "command,kind,memberId,runId,taskId,teamId,version" ||
    receipt.version !== 1 || receipt.kind !== kind || receipt.memberId !== scope.memberId ||
    receipt.teamId !== scope.teamId || receipt.taskId !== scope.taskId || receipt.runId !== scope.runId ||
    !validCommand(receipt.command, kind)) {
    throw new Error("Recovery receipt cannot be verified");
  }
  return receipt.command;
}

export function saveRecoveryReceipt(scope: RecoveryReceiptScope, kind: RecoveryKind, command: RecoveryCommand): void {
  if (!validCommand(command, kind)) throw new Error("Recovery command cannot be verified");
  const previous = readRecoveryReceipt(scope, kind);
  if (previous && !sameCommand(previous, command)) throw new Error("An unresolved recovery operation already exists");
  const receipt: RecoveryReceipt = { version: 1, ...scope, kind, command };
  const raw = JSON.stringify(receipt);
  const key = receiptKey(scope, kind);
  storage().setItem(key, raw);
  if (storage().getItem(key) !== raw) throw new Error("Recovery receipt was not persisted");
}

export function clearRecoveryReceipt(scope: RecoveryReceiptScope, kind: RecoveryKind, command: RecoveryCommand | null): void {
  const previous = readRecoveryReceipt(scope, kind);
  if (!previous) return;
  if (!command || !sameCommand(previous, command)) throw new Error("Recovery receipt changed before confirmation");
  const key = receiptKey(scope, kind);
  storage().removeItem(key);
  if (storage().getItem(key) !== null) throw new Error("Recovery receipt could not be cleared");
}
