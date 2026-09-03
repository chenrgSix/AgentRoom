import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanSupersessionActivationReceipt,
  ExecutionPlanSupersessionCandidateCommand,
  ExecutionPlanSupersessionControlView,
  ExecutionReplanDelegation,
  ExecutionReplanDelegationRevocation
} from "@convene-wire/contracts/execution-plan";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  captureWebSessionScope,
  HttpRequestError,
  isStaleWebSessionError,
  jsonRequest
} from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import type { Member } from "../../models.js";
import { diffPlanDefinitions, displayPlanDiffValue } from "./plan-diff.js";

interface PlanSupersessionPanelProps {
  agentNames: ReadonlyMap<string, string>;
  currentMember: Member;
  locale: Locale;
  onChanged: () => void | Promise<void>;
  plan: ExecutionPlanProjection;
  task: TaskProjection;
  token: string | undefined;
}

type CommandKind = "candidate" | "activation" | "delegation" | "revocation";

function t(zh: string, en: string, locale: Locale): string {
  return locale === "zh-CN" ? zh : en;
}

function operationId(): string {
  const value = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `op_${value.replaceAll("-", "_")}`;
}

function shortenedDigest(digest: string): string {
  return `${digest.slice(0, 12)}…${digest.slice(-8)}`;
}

function display(value: string): string {
  return value.replaceAll("_", " ");
}

function defaultExpiry(): string {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setSeconds(0, 0);
  return next.toISOString().slice(0, 16);
}

function candidateAuthor(
  candidate: NonNullable<ExecutionPlanSupersessionControlView["candidate"]>
): string {
  const author = candidate.author;
  if (author.kind === "member") return `member · ${author.memberId ?? "?"}`;
  if (author.kind === "agent") return `agent · ${author.agentId ?? "?"} · ${author.runId ?? "?"}`;
  return `discussion · ${author.discussionId ?? "?"}`;
}

export function PlanSupersessionPanel({
  agentNames,
  currentMember,
  locale,
  onChanged,
  plan,
  task,
  token
}: PlanSupersessionPanelProps) {
  const [control, setControl] = useState<ExecutionPlanSupersessionControlView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CommandKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [candidateDefinition, setCandidateDefinition] = useState("");
  const [candidateReason, setCandidateReason] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [delegationAgentId, setDelegationAgentId] = useState("");
  const [delegationExpiry, setDelegationExpiry] = useState(defaultExpiry);
  const [delegationReason, setDelegationReason] = useState("");
  const [revocationReasons, setRevocationReasons] = useState<Record<string, string>>({});
  const [unknown, setUnknown] = useState<CommandKind | null>(null);
  const requestId = useRef(0);
  const candidateOperation = useRef<string | null>(null);
  const activationOperation = useRef<string | null>(null);
  const delegationOperation = useRef<string | null>(null);
  const revocationOperations = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const sessionCurrent = useMemo(() => captureWebSessionScope(), [plan.planId, token]);
  const isCurrent = useCallback(() => mounted.current && sessionCurrent(), [sessionCurrent]);
  const primaryAgentIds = useMemo(() => [...new Set(task.assignments
    .filter(({ role }) => role === "primary")
    .map(({ agentId }) => agentId))].sort(), [task.assignments]);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await jsonRequest<ExecutionPlanSupersessionControlView>(
        `/api/execution-plans/${plan.planId}/supersession-control`, {}, token
      );
      if (!isCurrent() || currentRequest !== requestId.current) return;
      if (next.planId !== plan.planId || next.currentRevision !== plan.current.revision ||
        next.currentDigest !== plan.current.digest ||
        next.controlRevision !== plan.controlRevision) {
        throw new Error(t(
          "重规划控制投影与当前计划不匹配。请刷新整个计划页面。",
          "The replanning control projection does not match the current plan. Reload the complete plan page.",
          locale
        ));
      }
      setControl(next);
      setUnknown(null);
    } catch (reason) {
      if (isCurrent() && currentRequest === requestId.current &&
        !isStaleWebSessionError(reason)) setError(String(reason));
    } finally {
      if (isCurrent() && currentRequest === requestId.current) setLoading(false);
    }
  }, [isCurrent, locale, plan.controlRevision, plan.current.digest,
    plan.current.revision, plan.planId, token]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, [load]);

  async function prepareCandidate(): Promise<void> {
    if (busy || control?.candidate) return;
    setBusy("candidate");
    setCommandError(null);
    try {
      const compiledTasks = await Promise.all(plan.compiledTasks.map(({ taskId }) =>
        jsonRequest<TaskProjection>(`/api/tasks/${taskId}`, {}, token)));
      if (!isCurrent()) return;
      const byTaskId = new Map(compiledTasks.map((entry) => [entry.taskId, entry]));
      const compiledByNode = new Map(plan.compiledTasks.map((entry) => [entry.nodeKey, entry]));
      const definition = structuredClone(plan.current.definition);
      definition.nodes = definition.nodes.map((node) => {
        const compiled = compiledByNode.get(node.nodeKey);
        const currentTask = compiled && byTaskId.get(compiled.taskId);
        if (!compiled || !currentTask || currentTask.roomId !== plan.roomId ||
          currentTask.parentTaskId !== plan.rootTaskId) {
          throw new Error(t(
            `节点 ${node.nodeKey} 的当前 Task 身份无法安全解析。`,
            `The current Task identity for node ${node.nodeKey} cannot be resolved safely.`,
            locale
          ));
        }
        return {
          ...node,
          task: {
            mode: "existing" as const,
            taskId: currentTask.taskId,
            expectedTaskRevision: currentTask.taskRevision,
            definitionRevision: currentTask.definitionRevision,
            criteriaRevision: currentTask.criteriaRevision
          }
        };
      }) as typeof definition.nodes;
      setCandidateDefinition(JSON.stringify(definition, null, 2));
      setCandidateOpen(true);
    } catch (reason) {
      if (isCurrent() && !isStaleWebSessionError(reason)) setCommandError(String(reason));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  async function submitCandidate(): Promise<void> {
    if (!control || control.candidate || busy || !candidateReason.trim()) return;
    let definition: ExecutionPlanDefinition;
    try {
      const parsed = JSON.parse(candidateDefinition) as Partial<ExecutionPlanDefinition>;
      if (!parsed || typeof parsed !== "object" || parsed.rootTaskId !== plan.rootTaskId) {
        throw new Error(t(
          "候选必须是当前根 Task 的完整计划定义。",
          "The candidate must be a complete plan definition for the current root Task.",
          locale
        ));
      }
      definition = parsed as ExecutionPlanDefinition;
    } catch (reason) {
      setCommandError(String(reason));
      return;
    }
    const op = candidateOperation.current ?? operationId();
    candidateOperation.current = op;
    const command: ExecutionPlanSupersessionCandidateCommand = {
      operationId: op,
      expectedCurrentRevision: control.currentRevision,
      expectedCurrentDigest: control.currentDigest,
      expectedControlRevision: control.controlRevision,
      expectedRootTaskRevision: control.rootTaskRevision,
      definition,
      reason: candidateReason.trim()
    };
    setBusy("candidate");
    setCommandError(null);
    try {
      const retained = await jsonRequest<NonNullable<ExecutionPlanSupersessionControlView["candidate"]>>(
        `/api/execution-plans/${plan.planId}/supersession-candidates`, {
          method: "POST", body: JSON.stringify(command)
        }, token
      );
      if (!isCurrent()) return;
      if (retained.planId !== plan.planId || retained.operationId !== op ||
        retained.baseRevision !== control.currentRevision ||
        retained.baseDigest !== control.currentDigest ||
        retained.baseControlRevision !== control.controlRevision ||
        retained.rootTaskRevision !== control.rootTaskRevision) {
        throw new Error(t("候选回执与提交的精确计划不匹配。", "The candidate receipt does not match the exact submitted plan.", locale));
      }
      candidateOperation.current = null;
      setUnknown(null);
      setCandidateOpen(false);
      setCandidateDefinition("");
      setCandidateReason("");
      await load();
    } catch (reason) {
      if (!isCurrent() || isStaleWebSessionError(reason)) return;
      if (reason instanceof HttpRequestError) candidateOperation.current = null;
      else setUnknown("candidate");
      setCommandError(t(
        `候选结果未确认：${String(reason)}。请先重新载入；网络结果未知时只能重试当前内存中的完全相同请求。`,
        `Candidate outcome was not confirmed: ${String(reason)}. Reload first; after an unknown network outcome only the exact in-memory request may be retried.`,
        locale
      ));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  async function activate(): Promise<void> {
    const template = control?.activationTemplate;
    if (!control?.candidate || !template || busy || !activationConfirmed ||
      !activationReason.trim()) return;
    const op = activationOperation.current ?? operationId();
    activationOperation.current = op;
    setBusy("activation");
    setCommandError(null);
    try {
      const receipt = await jsonRequest<ExecutionPlanSupersessionActivationReceipt>(
        `/api/execution-plans/${plan.planId}/supersession-activations`, {
          method: "POST",
          body: JSON.stringify({ ...template, operationId: op, reason: activationReason.trim() })
        }, token
      );
      if (!isCurrent()) return;
      if (receipt.operationId !== op || receipt.candidate.candidateId !== template.candidateId ||
        receipt.plan.current.revision !== template.expectedCandidateRevision ||
        receipt.plan.current.digest !== template.expectedCandidateDigest ||
        receipt.delegationId !== null) {
        throw new Error(t("激活回执与确认的精确候选不匹配。", "The activation receipt does not match the exact confirmed candidate.", locale));
      }
      activationOperation.current = null;
      setUnknown(null);
      setActivationConfirmed(false);
      setActivationReason("");
      await onChanged();
    } catch (reason) {
      if (!isCurrent() || isStaleWebSessionError(reason)) return;
      if (reason instanceof HttpRequestError) activationOperation.current = null;
      else setUnknown("activation");
      setCommandError(t(
        `激活结果未确认：${String(reason)}。请从 Server 重新读取当前修订；未知结果只能以相同操作 ID 重试。`,
        `Activation outcome was not confirmed: ${String(reason)}. Reload the current Server revision; an unknown outcome may only be retried with the same operation ID.`,
        locale
      ));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  async function issueDelegation(): Promise<void> {
    if (!control || busy || !delegationAgentId || !delegationReason.trim()) return;
    const expires = Date.parse(delegationExpiry);
    if (!Number.isFinite(expires)) {
      setCommandError(t("请输入有效的委托到期时间。", "Enter a valid delegation expiry.", locale));
      return;
    }
    const expiresAt = new Date(expires).toISOString();
    const op = delegationOperation.current ?? operationId();
    delegationOperation.current = op;
    const command = {
      operationId: op,
      expectedPlanRevision: control.currentRevision,
      expectedPlanDigest: control.currentDigest,
      expectedControlRevision: control.controlRevision,
      expectedRootTaskRevision: control.rootTaskRevision,
      agentId: delegationAgentId,
      expiresAt,
      reason: delegationReason.trim()
    };
    setBusy("delegation");
    setCommandError(null);
    try {
      const retained = await jsonRequest<ExecutionReplanDelegation>(
        `/api/execution-plans/${plan.planId}/replan-delegations`, {
          method: "POST", body: JSON.stringify(command)
        }, token
      );
      if (!isCurrent()) return;
      if (retained.operationId !== op || retained.planId !== plan.planId ||
        retained.planRevision !== control.currentRevision ||
        retained.planDigest !== control.currentDigest ||
        retained.agentId !== delegationAgentId) {
        throw new Error(t("委托回执与提交的精确权限不匹配。", "The delegation receipt does not match the exact submitted authority.", locale));
      }
      delegationOperation.current = null;
      setUnknown(null);
      setDelegationAgentId("");
      setDelegationReason("");
      setDelegationExpiry(defaultExpiry());
      await load();
    } catch (reason) {
      if (!isCurrent() || isStaleWebSessionError(reason)) return;
      if (reason instanceof HttpRequestError) delegationOperation.current = null;
      else setUnknown("delegation");
      setCommandError(t(
        `委托结果未确认：${String(reason)}。先重新载入；未知结果只可重试相同命令。`,
        `Delegation outcome was not confirmed: ${String(reason)}. Reload first; an unknown outcome may only retry the same command.`,
        locale
      ));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  async function revoke(delegation: ExecutionReplanDelegation): Promise<void> {
    const reasonText = revocationReasons[delegation.delegationId]?.trim();
    if (busy || !reasonText) return;
    const op = revocationOperations.current.get(delegation.delegationId) ?? operationId();
    revocationOperations.current.set(delegation.delegationId, op);
    setBusy("revocation");
    setCommandError(null);
    try {
      const receipt = await jsonRequest<ExecutionReplanDelegationRevocation>(
        `/api/execution-plans/${plan.planId}/replan-delegations/${delegation.delegationId}/revocations`, {
          method: "POST",
          body: JSON.stringify({
            operationId: op,
            expectedRevision: delegation.revision,
            expectedDigest: delegation.delegationDigest,
            reason: reasonText
          })
        }, token
      );
      if (!isCurrent()) return;
      if (receipt.operationId !== op || receipt.delegationId !== delegation.delegationId ||
        receipt.delegationRevision !== delegation.revision ||
        receipt.delegationDigest !== delegation.delegationDigest) {
        throw new Error(t("撤销回执与精确委托不匹配。", "The revocation receipt does not match the exact delegation.", locale));
      }
      revocationOperations.current.delete(delegation.delegationId);
      setUnknown(null);
      setRevocationReasons((current) => ({ ...current, [delegation.delegationId]: "" }));
      await load();
    } catch (reason) {
      if (!isCurrent() || isStaleWebSessionError(reason)) return;
      if (reason instanceof HttpRequestError) revocationOperations.current.delete(delegation.delegationId);
      else setUnknown("revocation");
      setCommandError(t(
        `撤销结果未确认：${String(reason)}。先重新载入；未知结果只可重试相同命令。`,
        `Revocation outcome was not confirmed: ${String(reason)}. Reload first; an unknown outcome may only retry the same command.`,
        locale
      ));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  const candidateDiffs = useMemo(() => control?.candidate
    ? diffPlanDefinitions(plan.current.definition, control.candidate.definition)
    : [], [control?.candidate, plan.current.definition]);

  return <section className="work-plan-supersession" aria-label={t("有界重规划", "Bounded replanning", locale)}>
    <header>
      <div><h5>{t("有界重规划与证据继承", "Bounded replanning and evidence carry-forward", locale)}</h5>
        <p>{t("Owner 审查候选；Server 计算可继承证据。激活不会接受浏览器自行选择的 proof。", "The Owner reviews the candidate while the Server computes reusable evidence. Activation never accepts browser-selected proof.", locale)}</p></div>
      <button disabled={loading || busy !== null} onClick={() => void load()} type="button">{t("刷新重规划状态", "Reload replanning state", locale)}</button>
    </header>
    {error && <p className="work-command-error" role="alert">{error}</p>}
    {commandError && <p className="work-command-error" role="alert">{commandError}</p>}
    {unknown && <p className="work-plan-pending" role="status">{t(`存在未确认的 ${display(unknown)} 请求。请先刷新权威状态，再决定是否重试内存中的完全相同命令。`, `An ${display(unknown)} request is unconfirmed. Reload authoritative state before deciding whether to retry the exact in-memory command.`, locale)}</p>}
    {loading && !control ? <p role="status">{t("正在载入重规划权限…", "Loading replanning authority…", locale)}</p> : control && <>
      <dl className="work-plan-supersession-pins">
        <div><dt>{t("当前计划", "Current plan", locale)}</dt><dd>r{control.currentRevision} · {shortenedDigest(control.currentDigest)}</dd></div>
        <div><dt>Control revision</dt><dd>{control.controlRevision}</dd></div>
        <div><dt>Root Task revision</dt><dd>{control.rootTaskRevision}</dd></div>
      </dl>

      {!control.candidate && <div className="work-plan-supersession-command">
        <h6>{t("准备候选修订", "Prepare candidate revision", locale)}</h6>
        <p>{t("浏览器会先读取所有已编译 Task 的当前身份，并将节点改为 existing-task pins；不会创建新 Task。", "The browser first reads every compiled Task identity and converts nodes to existing-task pins; it creates no new Task.", locale)}</p>
        {!candidateOpen ? <button disabled={busy !== null} onClick={() => void prepareCandidate()} type="button">{t("准备可编辑候选", "Prepare editable candidate", locale)}</button> : <>
          <label>{t("重规划理由", "Replanning reason", locale)}<textarea onChange={(event) => setCandidateReason(event.target.value)} value={candidateReason} /></label>
          <label>{t("完整候选计划 JSON", "Complete candidate plan JSON", locale)}<textarea aria-label={t("完整候选计划 JSON", "Complete candidate plan JSON", locale)} className="work-plan-json" onChange={(event) => setCandidateDefinition(event.target.value)} spellCheck={false} value={candidateDefinition} /></label>
          <div><button disabled={busy !== null || !candidateReason.trim()} onClick={() => void submitCandidate()} type="button">{t("保留候选", "Retain candidate", locale)}</button><button disabled={busy !== null} onClick={() => { setCandidateOpen(false); setCandidateDefinition(""); setCandidateReason(""); candidateOperation.current = null; }} type="button">{t("取消", "Cancel", locale)}</button></div>
        </>}
      </div>}

      {control.candidate && <div className="work-plan-supersession-candidate">
        <h6>{t("待激活候选", "Candidate awaiting activation", locale)}</h6>
        <dl>
          <div><dt>Candidate</dt><dd>{control.candidate.candidateId}</dd></div>
          <div><dt>{t("修订", "Revision", locale)}</dt><dd>{control.candidate.baseRevision} → {control.candidate.candidateRevision}</dd></div>
          <div><dt>Digest</dt><dd>{control.candidate.candidateDigest}</dd></div>
          <div><dt>{t("作者", "Author", locale)}</dt><dd>{candidateAuthor(control.candidate)}</dd></div>
          <div><dt>{t("理由", "Reason", locale)}</dt><dd>{control.candidate.reason}</dd></div>
        </dl>
        <h6>{t("候选差异", "Candidate diff", locale)}</h6>
        {candidateDiffs.length === 0 ? <p>{t("结构化定义没有变化。", "The structured definition is unchanged.", locale)}</p> : <ol className="work-plan-supersession-diff">{candidateDiffs.map((entry, index) => <li key={`${entry.path}:${index}`}><strong>{display(entry.kind)}</strong><code>{entry.path}</code>{entry.kind !== "added" && <del>{displayPlanDiffValue(entry.before)}</del>}{entry.kind !== "removed" && <ins>{displayPlanDiffValue(entry.after)}</ins>}</li>)}</ol>}
        <h6>{t("Server 准备的证据继承", "Server-prepared evidence carry-forward", locale)}</h6>
        {control.activationTemplate ? <>
          {control.activationTemplate.carryForward.length === 0 ? <p>{t("此候选不需要继承旧证据。", "This candidate requires no prior evidence carry-forward.", locale)}</p> : <ol className="work-plan-carry">{control.activationTemplate.carryForward.map((entry) => <li key={`${entry.targetNodeKey}:${entry.gate}`}><strong>{entry.targetNodeKey} · {display(entry.gate)}</strong><span>Adoption {entry.sourceAdoptionId} · {shortenedDigest(entry.sourceAdoptionDigest)}</span><span>Reuse {entry.sourceReuseContractId} · {shortenedDigest(entry.sourceNodeReuseContractDigest)}</span><span>Inputs {shortenedDigest(entry.sourceReuseInputEvidenceDigest)}</span></li>)}</ol>}
          <label>{t("激活理由", "Activation reason", locale)}<textarea onChange={(event) => setActivationReason(event.target.value)} value={activationReason} /></label>
          <label className="work-plan-confirm"><input checked={activationConfirmed} onChange={(event) => setActivationConfirmed(event.target.checked)} type="checkbox" />{t(`我确认激活候选 r${control.activationTemplate.expectedCandidateRevision}（${shortenedDigest(control.activationTemplate.expectedCandidateDigest)}）及 Server 列出的精确证据继承。`, `I confirm activation of candidate r${control.activationTemplate.expectedCandidateRevision} (${shortenedDigest(control.activationTemplate.expectedCandidateDigest)}) and the exact Server-listed evidence carry-forward.`, locale)}</label>
          <button disabled={busy !== null || !activationConfirmed || !activationReason.trim()} onClick={() => void activate()} type="button">{t("激活精确候选", "Activate exact candidate", locale)}</button>
        </> : <p className="work-evidence-blockers">{t(`当前不能激活：${control.activationBlockerCode ?? "authority unavailable"}。`, `Activation is currently blocked: ${control.activationBlockerCode ?? "authority unavailable"}.`, locale)}</p>}
      </div>}

      <div className="work-plan-delegations">
        <h6>{t("Tech Lead 重规划委托", "Tech Lead replanning delegations", locale)}</h6>
        <p>{t("委托只允许 primary Agent 在固定 Task 集内提出候选或激活；Owner 可以随时撤销。", "Delegation only lets a primary Agent propose or activate within the fixed Task set; the Owner may revoke it.", locale)}</p>
        {primaryAgentIds.length === 0 ? <p>{t("根 Task 没有 primary Agent，不能签发委托。", "The root Task has no primary Agent, so delegation cannot be issued.", locale)}</p> : <div className="work-plan-delegation-form">
          <label>{t("Primary Agent", "Primary Agent", locale)}<select onChange={(event) => setDelegationAgentId(event.target.value)} value={delegationAgentId}><option value="">—</option>{primaryAgentIds.map((agentId) => <option key={agentId} value={agentId}>{agentNames.get(agentId) ?? agentId}</option>)}</select></label>
          <label>{t("到期时间（最长 24 小时）", "Expiry (maximum 24 hours)", locale)}<input onChange={(event) => setDelegationExpiry(event.target.value)} type="datetime-local" value={delegationExpiry} /></label>
          <label>{t("委托理由", "Delegation reason", locale)}<textarea onChange={(event) => setDelegationReason(event.target.value)} value={delegationReason} /></label>
          <button disabled={busy !== null || !delegationAgentId || !delegationReason.trim()} onClick={() => void issueDelegation()} type="button">{t("签发精确委托", "Issue exact delegation", locale)}</button>
        </div>}
        {control.delegations.length === 0 ? <p>{t("尚无委托记录。", "No delegation records yet.", locale)}</p> : <ol>{control.delegations.map(({ delegation, state }) => <li key={delegation.delegationId}>
          <header><strong>{agentNames.get(delegation.agentId) ?? delegation.agentId}</strong><span>{display(state)} · revision {delegation.revision}</span></header>
          <p>{delegation.reason}</p>
          <dl><div><dt>Delegation</dt><dd>{delegation.delegationId}</dd></div><div><dt>Digest</dt><dd>{delegation.delegationDigest}</dd></div><div><dt>{t("有效期", "Validity", locale)}</dt><dd>{delegation.issuedAt} → {delegation.expiresAt}</dd></div><div><dt>{t("固定 Task", "Pinned Tasks", locale)}</dt><dd>{delegation.taskIds.join(", ")}</dd></div></dl>
          {state === "active" && <div className="work-plan-delegation-revoke"><label>{t("撤销理由", "Revocation reason", locale)}<input onChange={(event) => setRevocationReasons((current) => ({ ...current, [delegation.delegationId]: event.target.value }))} value={revocationReasons[delegation.delegationId] ?? ""} /></label><button disabled={busy !== null || !revocationReasons[delegation.delegationId]?.trim()} onClick={() => void revoke(delegation)} type="button">{t("撤销委托", "Revoke delegation", locale)}</button></div>}
        </li>)}</ol>}
      </div>
      <p className="work-plan-authority-note">{t(`当前操作人为 ${currentMember.displayName}。Central 只保留计划、授权与证据回执；仓库与 Git 操作仍由 Client / Bridge 控制。`, `Current operator: ${currentMember.displayName}. Central retains plans, authority and evidence receipts only; repository and Git operations remain under Client / Bridge control.`, locale)}</p>
    </>}
  </section>;
}
