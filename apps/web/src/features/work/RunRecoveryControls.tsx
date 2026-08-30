import type { TaskProjection } from "@convene-wire/contracts/task-result";
import React, { useEffect, useRef, useState } from "react";

import { captureWebSessionScope, isStaleWebSessionError, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import { clearRecoveryReceipt, readRecoveryReceipt, saveRecoveryReceipt, type RecoveryCommand, type RecoveryKind, type RecoveryReceiptScope } from "./recovery-receipt.js";

interface Acknowledgement {
  runId: string;
  reason: string;
  taskRevisionAfter: number;
}

interface RunRecoveryControlsProps {
  canManage: boolean;
  evidenceReady: boolean;
  locale: Locale;
  memberId: string | null;
  onChanged: (newRunId?: string) => void | Promise<void>;
  run: { runId: string; state: string; targetAgentId: string };
  task: TaskProjection;
  token: string | undefined;
}

interface ReceiptState {
  commands: Record<RecoveryKind, RecoveryCommand | null>;
  blocked: boolean;
}

function readReceipts(scope: RecoveryReceiptScope): ReceiptState {
  try {
    return { commands: { ack: readRecoveryReceipt(scope, "ack"), retry: readRecoveryReceipt(scope, "retry") }, blocked: false };
  } catch {
    return { commands: { ack: null, retry: null }, blocked: true };
  }
}

function operationId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `op_${random.replaceAll("-", "_")}`;
}

export function RunRecoveryControls(props: RunRecoveryControlsProps) {
  const key = JSON.stringify([props.memberId, props.task.teamId, props.task.taskId, props.run.runId, props.token]);
  return <ScopedRunRecoveryControls {...props} key={key} />;
}

function ScopedRunRecoveryControls({ canManage, evidenceReady, locale, memberId, onChanged, run, task, token }: RunRecoveryControlsProps) {
  const t = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const [scope] = useState<RecoveryReceiptScope>(() => ({ memberId: memberId ?? "", teamId: task.teamId, taskId: task.taskId, runId: run.runId }));
  const [receipts, setReceipts] = useState(() => readReceipts(scope));
  const [acknowledgement, setAcknowledgement] = useState<Acknowledgement | null>(null);
  const [ackLoading, setAckLoading] = useState(run.state === "outcome_unknown");
  const [ackError, setAckError] = useState<string | null>(null);
  const [reason, setReason] = useState(receipts.commands.ack?.reason ?? "");
  const [checked, setChecked] = useState(false);
  const [retryChecked, setRetryChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const sending = useRef(false);
  const mounted = useRef(true);
  const failedOperation = useRef<"ack" | "retry" | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function clearConfirmed(kind: RecoveryKind, command: RecoveryCommand | null): void {
    clearRecoveryReceipt(scope, kind, command);
    if (mounted.current) setReceipts((current) => ({ ...current, commands: { ...current.commands, [kind]: null } }));
  }

  useEffect(() => {
    if (run.state !== "outcome_unknown") return;
    let stopped = false;
    const isCurrentSession = captureWebSessionScope();
    const isCurrentRequest = () => !stopped && mounted.current && isCurrentSession();
    setAckLoading(true);
    setAckError(null);
    void jsonRequest<{ acknowledgement: Acknowledgement | null }>(
      `/api/runs/${run.runId}/ambiguity-acknowledgement`, {}, token
    ).then((result) => {
      if (!isCurrentRequest()) return;
      if (result.acknowledgement && (result.acknowledgement.runId !== run.runId ||
        !Number.isSafeInteger(result.acknowledgement.taskRevisionAfter) ||
        result.acknowledgement.taskRevisionAfter < 1 || typeof result.acknowledgement.reason !== "string")) {
        throw new Error("Acknowledgement does not match this Run");
      }
      setAcknowledgement(result.acknowledgement);
      if (result.acknowledgement && memberId) {
        try {
          clearConfirmed("ack", readRecoveryReceipt(scope, "ack"));
        } catch {
          setReceipts((current) => ({ ...current, blocked: true }));
        }
        if (failedOperation.current === "ack") {
          failedOperation.current = null;
          setCommandError(null);
        }
      }
    }).catch((error: unknown) => {
      if (isCurrentRequest() && !isStaleWebSessionError(error)) setAckError(t("无法核实此尝试的确认记录，请重新检查后再操作。", "Could not verify this attempt's acknowledgement. Check again before continuing."));
    }).finally(() => { if (isCurrentRequest()) setAckLoading(false); });
    return () => { stopped = true; };
  }, [locale, memberId, reloadKey, run.runId, run.state, scope, task.taskRevision, token]);

  const retryable = ["failed", "canceled", "expired", "outcome_unknown"].includes(run.state);
  if (!retryable) return null;

  const unknown = run.state === "outcome_unknown";
  const runnable = ["ready", "active", "review"].includes(task.lifecycleState) && task.schedulingState === "enabled";
  const budgetAvailable = task.budgetUsage.runAttempts < task.budgetPolicy.maxRunAttempts &&
    task.budgetUsage.executionDurationSeconds < task.budgetPolicy.maxExecutionDurationSeconds;
  const assigned = task.isDefault || task.assignments.some(({ agentId }) => agentId === run.targetAgentId);
  const pendingAck = receipts.commands.ack;
  const pendingRetry = receipts.commands.retry;
  const canRetry = canManage && evidenceReady && !receipts.blocked && (Boolean(pendingRetry) || (runnable && budgetAvailable && assigned && (!unknown || (acknowledgement !== null && !ackLoading && !ackError))));

  async function submit(kind: RecoveryKind) {
    const isCurrentSession = captureWebSessionScope();
    const isCurrentOperation = () => mounted.current && isCurrentSession();
    if (!isCurrentOperation() || !canManage || !evidenceReady || receipts.blocked || sending.current) return;
    if (kind === "ack" && (!unknown || acknowledgement || ackLoading || ackError || !checked || !(pendingAck?.reason ?? reason).trim())) return;
    if (kind === "retry" && (!canRetry || !retryChecked)) return;
    let command: RecoveryCommand;
    try {
      command = receipts.commands[kind] ?? readRecoveryReceipt(scope, kind) ?? {
        operationId: operationId(),
        expectedTaskRevision: Math.max(task.taskRevision, acknowledgement?.taskRevisionAfter ?? 0),
        ...(kind === "ack" ? { reason: reason.trim() } : {})
      };
      // Persist and verify the exact payload before allowing any external mutation.
      saveRecoveryReceipt(scope, kind, command);
    } catch {
      setReceipts((current) => ({ ...current, blocked: true }));
      return;
    }
    setReceipts((current) => ({ commands: { ...current.commands, [kind]: command }, blocked: false }));
    sending.current = true;
    setBusy(true);
    setCommandError(null);
    failedOperation.current = null;
    let confirmed = false;
    try {
      const result = await jsonRequest<Acknowledgement | { runId: string }>(
        `/api/runs/${run.runId}/${kind === "ack" ? "ambiguity-acknowledgement" : "retry"}`,
        { method: "POST", body: JSON.stringify(command) }, token
      );
      // A detached view leaves its exact receipt for explicit reconciliation.
      if (!isCurrentOperation()) return;
      if (kind === "ack" && (result.runId !== run.runId || !("taskRevisionAfter" in result) ||
        !Number.isSafeInteger(result.taskRevisionAfter) || result.taskRevisionAfter < 1 || typeof result.reason !== "string")) {
        throw new Error("Acknowledgement response could not be verified");
      }
      if (kind === "retry" && (typeof result.runId !== "string" ||
        !/^run_[A-Za-z0-9_-]{8,128}$/u.test(result.runId) || result.runId === run.runId)) {
        throw new Error("Retry response could not be verified");
      }
      clearConfirmed(kind, command);
      confirmed = true;
      if (mounted.current) {
        if (kind === "ack") setAcknowledgement(result as Acknowledgement);
        setChecked(false);
        setRetryChecked(false);
      }
      await onChanged(kind === "retry" ? result.runId : undefined);
    } catch (error) {
      // Never turn an old response into a new request under a replacement
      // session. Its receipt remains unresolved until the member reopens it.
      if (!isCurrentOperation() || isStaleWebSessionError(error)) return;
      // A definitive compare-and-swap rejection may use the refreshed revision.
      // An uncertain transport response must retain the exact operation identity.
      if (!confirmed && error instanceof Error && error.message === "Task revision conflict") {
        try {
          clearConfirmed(kind, command);
          if (mounted.current) { setChecked(false); setRetryChecked(false); }
        } catch {
          if (mounted.current) setReceipts((current) => ({ ...current, blocked: true }));
        }
      }
      if (mounted.current) {
        failedOperation.current = kind;
        setCommandError(confirmed ? t(
          "操作已确认，但页面刷新失败。请刷新权威状态，不要重复执行。",
          "The operation was confirmed, but the page did not refresh. Reload authoritative state instead of repeating execution."
        ) : t(
          "操作尚未确认。已请求刷新权威状态；再次点击只会核对同一操作，不会自动创建额外尝试。此标签页刷新或重新进入详情后仍会保留核对记录。",
          "The operation is not confirmed. Authoritative state was requested again; repeating the action checks the same operation without automatically creating another attempt. The receipt survives this tab's reloads and reopening details."
        ));
        setReloadKey((current) => current + 1);
      }
      try { await onChanged(); } catch { /* Keep the receipt when the refresh is unavailable. */ }
    } finally {
      sending.current = false;
      if (isCurrentOperation()) setBusy(false);
    }
  }

  return <section className="work-recovery" aria-label={t("恢复执行", "Recover execution")}>
    <h5>{t("恢复执行", "Recover execution")}</h5>
    {unknown && <p className="work-warning">{t("结果未知：先检查事件与实际成果，确认外部操作的结果。确认记录不会重试，也不会把原尝试标记为成功。", "Outcome unknown: inspect events and actual deliverables before acknowledging external effects. Acknowledgement neither retries nor marks this attempt successful.")}</p>}
    {!evidenceReady && <p role="status">{t("此尝试的证据尚未成功载入，确认和新尝试已暂停。", "This attempt's evidence has not loaded successfully. Acknowledgement and new attempts are paused.")}</p>}
    {canManage && receipts.blocked && <div>
      <p role="alert">{t("浏览器无法安全读取或保存恢复记录，已禁止确认和重试。请恢复此标签页的会话存储后重新检查，不要通过清空记录来重复执行。", "The browser cannot safely read or save recovery receipts. Acknowledgement and retries are blocked. Restore this tab's session storage and check again; do not clear receipts to repeat execution.")}</p>
      <button className="work-inline-link" disabled={busy} onClick={() => {
        const next = readReceipts(scope);
        setReceipts(next);
        if (next.commands.ack?.reason) setReason(next.commands.ack.reason);
        setReloadKey((current) => current + 1);
      }} type="button">{t("重新检查恢复记录", "Check recovery receipts again")}</button>
    </div>}
    {unknown && ackLoading && <p role="status">{t("正在核实确认记录…", "Checking acknowledgement…")}</p>}
    {ackError && <div><p role="alert">{ackError}</p><button className="work-inline-link" disabled={busy} onClick={() => setReloadKey((current) => current + 1)} type="button">{t("重新检查记录", "Check acknowledgement again")}</button></div>}
    {unknown && acknowledgement && !ackLoading && !ackError && <p role="status">{t("已记录结果确认：", "Acknowledgement recorded: ")}{acknowledgement.reason}</p>}
    {!canManage && <p>{t("仅任务负责人或 Team Owner 可以确认结果并发起新尝试。", "Only the Task Owner or Team Owner can acknowledge outcomes and start a new attempt.")}</p>}
    {canManage && unknown && !acknowledgement && !ackLoading && !ackError && <div className="work-review-controls">
      <label>{t("检查结果与确认理由", "Observed outcome and acknowledgement reason")}<textarea disabled={busy || Boolean(pendingAck) || receipts.blocked} maxLength={1000} onChange={(event) => setReason(event.target.value)} value={pendingAck?.reason ?? reason} /></label>
      <label><input checked={checked} disabled={busy || !evidenceReady || receipts.blocked} onChange={(event) => setChecked(event.target.checked)} type="checkbox" />{t("我已检查已有证据和外部操作结果。", "I have checked the evidence and external effects.")}</label>
      <button disabled={busy || !evidenceReady || receipts.blocked || !checked || !(pendingAck?.reason ?? reason).trim()} onClick={() => void submit("ack")} type="button">{pendingAck ? t("核对上次确认", "Check previous acknowledgement") : t("记录结果确认", "Record acknowledgement")}</button>
    </div>}
    {canManage && <div className="work-review-controls">
      <p>{t("新尝试会再次执行原指令，消耗执行预算，并可能产生新的外部操作。不会自动重试。", "A new attempt executes the original instruction again, consumes budget, and may cause new external effects. Retries are never automatic.")}</p>
      {!runnable && <p>{t("任务已暂停或结束，需要先恢复可调度状态。", "The Task is paused or closed. Restore its schedulable state first.")}</p>}
      {!budgetAvailable && <p>{t("执行预算已用尽，需要先调整任务预算。", "The execution budget is exhausted. Update the Task budget first.")}</p>}
      {!assigned && <p>{t("原 Agent 已不在任务分工中，需要先重新指派。", "The original Agent is no longer assigned. Restore its assignment first.")}</p>}
      <label><input checked={retryChecked} disabled={busy || !canRetry} onChange={(event) => setRetryChecked(event.target.checked)} type="checkbox" />{t("我确认明确发起一次新的执行。", "I explicitly authorize one new execution attempt.")}</label>
      <button disabled={busy || !canRetry || !retryChecked} onClick={() => void submit("retry")} type="button">{pendingRetry ? t("核对上次新尝试", "Check previous new attempt") : t("发起新尝试", "Start new attempt")}</button>
    </div>}
    {commandError && <p className="work-command-error" role="alert">{commandError}</p>}
  </section>;
}
