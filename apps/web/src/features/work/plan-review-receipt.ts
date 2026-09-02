export interface PendingPlanReviewCommand {
  operationId: string;
  expectedRevision: number;
  expectedDigest: string;
  expectedRootTaskRevision: number;
  decision: "approved" | "rejected";
  reason: string;
}

export interface PlanReviewReceiptScope {
  memberId: string;
  teamId: string;
  taskId: string;
  planId: string;
}

interface StoredPlanReviewReceipt extends PlanReviewReceiptScope {
  version: 1;
  command: PendingPlanReviewCommand;
}

const prefix = "convenewire.plan-review-receipt.v1";

function receiptKey(scope: PlanReviewReceiptScope): string {
  if (!scope.memberId || !scope.teamId || !scope.taskId || !scope.planId) {
    throw new Error("Plan review identity is incomplete");
  }
  return [prefix, scope.memberId, scope.teamId, scope.taskId, scope.planId]
    .map(encodeURIComponent).join(":");
}

function storage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("Plan review storage is unavailable");
  }
  return window.sessionStorage;
}

function validCommand(value: unknown): value is PendingPlanReviewCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return Object.keys(command).sort().join(",") ===
      "decision,expectedDigest,expectedRevision,expectedRootTaskRevision,operationId,reason" &&
    typeof command.operationId === "string" &&
    /^op_[A-Za-z0-9_-]{8,128}$/u.test(command.operationId) &&
    Number.isSafeInteger(command.expectedRevision) && Number(command.expectedRevision) >= 1 &&
    typeof command.expectedDigest === "string" && /^[a-f0-9]{64}$/u.test(command.expectedDigest) &&
    Number.isSafeInteger(command.expectedRootTaskRevision) &&
    Number(command.expectedRootTaskRevision) >= 1 &&
    (command.decision === "approved" || command.decision === "rejected") &&
    typeof command.reason === "string" && command.reason.trim().length > 0 &&
    command.reason.length <= 2_000;
}

function sameCommand(
  left: PendingPlanReviewCommand,
  right: PendingPlanReviewCommand
): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof PendingPlanReviewCommand] ===
      right[key as keyof PendingPlanReviewCommand]);
}

export function readPendingPlanReview(
  scope: PlanReviewReceiptScope
): PendingPlanReviewCommand | null {
  const raw = storage().getItem(receiptKey(scope));
  if (raw === null) return null;
  const receipt = JSON.parse(raw) as Partial<StoredPlanReviewReceipt>;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(",") !==
      "command,memberId,planId,taskId,teamId,version" ||
    receipt.version !== 1 || receipt.memberId !== scope.memberId ||
    receipt.teamId !== scope.teamId || receipt.taskId !== scope.taskId ||
    receipt.planId !== scope.planId || !validCommand(receipt.command)) {
    throw new Error("Plan review receipt cannot be verified");
  }
  return receipt.command;
}

export function savePendingPlanReview(
  scope: PlanReviewReceiptScope,
  command: PendingPlanReviewCommand
): void {
  if (!validCommand(command)) {
    throw new Error("Plan review command cannot be verified");
  }
  const previous = readPendingPlanReview(scope);
  if (previous && !sameCommand(previous, command)) {
    throw new Error("An unresolved plan review operation already exists");
  }
  const receipt: StoredPlanReviewReceipt = {
    version: 1,
    ...scope,
    command
  };
  const raw = JSON.stringify(receipt);
  const key = receiptKey(scope);
  storage().setItem(key, raw);
  if (storage().getItem(key) !== raw) {
    throw new Error("Plan review receipt was not persisted");
  }
}

export function clearPendingPlanReview(
  scope: PlanReviewReceiptScope,
  command: PendingPlanReviewCommand
): void {
  const previous = readPendingPlanReview(scope);
  if (!previous) return;
  if (!sameCommand(previous, command)) {
    throw new Error("Plan review receipt changed before confirmation");
  }
  const key = receiptKey(scope);
  storage().removeItem(key);
  if (storage().getItem(key) !== null) {
    throw new Error("Plan review receipt could not be cleared");
  }
}
