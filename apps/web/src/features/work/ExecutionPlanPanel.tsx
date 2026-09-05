import type {
  ExecutionPlanApprovalPage,
  ExecutionPlanApprovalReceipt,
  ExecutionPlanDefinition,
  ExecutionPlanPage,
  ExecutionPlanProjection,
  ExecutionPlanRevision,
  ExecutionPlanRevisionPage
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
import {
  diffPlanDefinitions,
  displayPlanDiffValue
} from "./plan-diff.js";
import {
  clearPendingPlanReview,
  readPendingPlanReview,
  savePendingPlanReview,
  type PendingPlanReviewCommand,
  type PlanReviewReceiptScope
} from "./plan-review-receipt.js";
import { PlanSupersessionPanel } from "./PlanSupersessionPanel.js";
import { PlanDefinitionEditor } from "./PlanDefinitionEditor.js";

interface ExecutionPlanPanelProps {
  agentNames: ReadonlyMap<string, string>;
  currentMember: Member | null;
  locale: Locale;
  onChanged: () => void;
  task: TaskProjection;
  token: string | undefined;
}

interface PlanFacts {
  approvals: ExecutionPlanApprovalPage["approvals"];
  previous: ExecutionPlanRevision | null;
}

function t(zh: string, en: string, locale: Locale): string {
  return locale === "zh-CN" ? zh : en;
}

function display(value: string): string {
  return value.replaceAll("_", " ");
}

function operationId(): string {
  const value = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `op_${value.replaceAll("-", "_")}`;
}

function shortenedDigest(digest: string): string {
  return `${digest.slice(0, 12)}…${digest.slice(-8)}`;
}

function authorLabel(plan: ExecutionPlanProjection): string {
  const author = plan.current.author;
  if (author.kind === "member") return `member · ${author.memberId ?? "?"}`;
  if (author.kind === "agent") return `agent · ${author.agentId ?? "?"} · ${author.runId ?? "?"}`;
  return `discussion · ${author.discussionId ?? "?"}`;
}

function reviewScope(
  task: TaskProjection,
  member: Member,
  planId: string
): PlanReviewReceiptScope {
  return {
    memberId: member.memberId,
    teamId: task.teamId,
    taskId: task.taskId,
    planId
  };
}

export function ExecutionPlanPanel({
  agentNames,
  currentMember,
  locale,
  onChanged,
  task,
  token
}: ExecutionPlanPanelProps) {
  const [plans, setPlans] = useState<ExecutionPlanProjection[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [facts, setFacts] = useState<PlanFacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [factsLoading, setFactsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"revision" | "review" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [revisionUnknown, setRevisionUnknown] = useState(false);
  const editBase = useRef<{ revision: number; rootTaskRevision: number } | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [pendingReview, setPendingReview] = useState<PendingPlanReviewCommand | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ExecutionPlanApprovalReceipt | null>(null);
  const listRequestId = useRef(0);
  const factsRequestId = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const revisionOperation = useRef<{ operationId: string; expectedRevision: number; expectedRootTaskRevision: number; definition: ExecutionPlanDefinition } | null>(null);
  const mounted = useRef(true);
  const sessionCurrent = useMemo(() => captureWebSessionScope(), [task.taskId, token]);
  const isCurrent = useCallback(() => mounted.current && sessionCurrent(), [sessionCurrent]);
  const selected = plans.find(({ planId }) => planId === selectedPlanId) ?? null;
  selectedIdRef.current = selectedPlanId;
  const canManage = Boolean(currentMember && currentMember.teamId === task.teamId &&
    (currentMember.role === "owner" || currentMember.memberId === task.ownerMemberId));

  const replacePlan = useCallback((plan: ExecutionPlanProjection) => {
    setPlans((current) => current.map((entry) =>
      entry.planId === plan.planId ? plan : entry));
  }, []);

  const loadFacts = useCallback(async (plan: ExecutionPlanProjection) => {
    const requestId = ++factsRequestId.current;
    setFactsLoading(true);
    setFacts(null);
    setCommandError(null);
    try {
      const previousAfter = Math.max(0, plan.current.revision - 2);
      const [history, approvalPage] = await Promise.all([
        jsonRequest<ExecutionPlanRevisionPage>(
          `/api/execution-plans/${plan.planId}/revisions?afterRevision=${previousAfter}&limit=2`,
          {}, token
        ),
        jsonRequest<ExecutionPlanApprovalPage>(
          `/api/execution-plans/${plan.planId}/approvals?limit=50`, {}, token
        )
      ]);
      if (!isCurrent() || requestId !== factsRequestId.current ||
        selectedIdRef.current !== plan.planId) return;
      const current = history.revisions.find(({ revision }) =>
        revision === plan.current.revision);
      if (!current || current.digest !== plan.current.digest ||
        approvalPage.approvals.some((approval) =>
          approval.planId !== plan.planId)) {
        throw new Error(t(
          "计划历史与当前投影不匹配，已拒绝显示。",
          "Plan history does not match the current projection and was refused.",
          locale
        ));
      }
      const previous = history.revisions.find(({ revision }) =>
        revision === plan.current.revision - 1) ?? null;
      setFacts({ approvals: approvalPage.approvals, previous });
      if (canManage && currentMember) {
        const scope = reviewScope(task, currentMember, plan.planId);
        try {
          const pending = readPendingPlanReview(scope);
          const confirmed = pending && approvalPage.approvals.some(({ operationId: id }) =>
            id === pending.operationId);
          if (pending && confirmed) {
            clearPendingPlanReview(scope, pending);
            setPendingReview(null);
          } else {
            setPendingReview(pending);
            if (pending) setReviewReason(pending.reason);
          }
          setStorageError(null);
        } catch (reason) {
          setPendingReview(null);
          setStorageError(String(reason));
        }
      }
    } catch (reason) {
      if (isCurrent() && requestId === factsRequestId.current &&
        !isStaleWebSessionError(reason)) setError(String(reason));
    } finally {
      if (isCurrent() && requestId === factsRequestId.current) setFactsLoading(false);
    }
  }, [canManage, currentMember, isCurrent, locale, task, token]);

  const loadPlans = useCallback(async () => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const page = await jsonRequest<ExecutionPlanPage>(
        `/api/tasks/${task.taskId}/execution-plans?limit=50`, {}, token
      );
      if (!isCurrent() || requestId !== listRequestId.current) return;
      const ordered = [...page.plans].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.planId.localeCompare(right.planId)) as ExecutionPlanProjection[];
      setPlans(ordered);
      const nextId = ordered.some(({ planId }) => planId === selectedIdRef.current)
        ? selectedIdRef.current
        : ordered[0]?.planId ?? null;
      setSelectedPlanId(nextId);
      selectedIdRef.current = nextId;
      if (nextId) {
        const plan = ordered.find(({ planId }) => planId === nextId)!;
        await loadFacts(plan);
      } else {
        setFacts(null);
      }
    } catch (reason) {
      if (isCurrent() && requestId === listRequestId.current &&
        !isStaleWebSessionError(reason)) setError(String(reason));
    } finally {
      if (isCurrent() && requestId === listRequestId.current) setLoading(false);
    }
  }, [isCurrent, loadFacts, task.taskId, token]);

  useEffect(() => {
    mounted.current = true;
    void loadPlans();
    return () => {
      mounted.current = false;
      listRequestId.current += 1;
      factsRequestId.current += 1;
    };
  }, [loadPlans]);

  function selectPlan(planId: string): void {
    const plan = plans.find((entry) => entry.planId === planId);
    if (!plan) return;
    selectedIdRef.current = planId;
    setSelectedPlanId(planId);
    setEditOpen(false);
    setEditorText("");
    revisionOperation.current = null;
    setRevisionUnknown(false);
    setReviewReason("");
    setApprovalConfirmed(false);
    setPendingReview(null);
    setStorageError(null);
    setLastReceipt(null);
    void loadFacts(plan);
  }

  function beginEdit(): void {
    if (!selected || !canManage || selected.state !== "draft") return;
    setEditorText(JSON.stringify(selected.current.definition, null, 2));
    editBase.current = { revision: selected.current.revision, rootTaskRevision: task.taskRevision };
    revisionOperation.current = null;
    setRevisionUnknown(false);
    setEditOpen(true);
    setCommandError(null);
  }

  async function saveRevision(): Promise<void> {
    if (!selected || !canManage || selected.state !== "draft" || busy) return;
    let definition: ExecutionPlanDefinition;
    try {
      const parsed = JSON.parse(editorText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as { rootTaskId?: unknown }).rootTaskId !== task.taskId) {
        throw new Error(t(
          "定义必须是当前根 Task 的完整 JSON 对象。",
          "The definition must be a complete JSON object for this root Task.",
          locale
        ));
      }
      definition = parsed as ExecutionPlanDefinition;
    } catch (reason) {
      setCommandError(String(reason));
      return;
    }
    setBusy("revision");
    setCommandError(null);
    const selectedAtStart = selected;
    const command = revisionOperation.current ?? {
      operationId: operationId(), expectedRevision: editBase.current?.revision ?? selected.current.revision,
      expectedRootTaskRevision: editBase.current?.rootTaskRevision ?? task.taskRevision, definition
    };
    revisionOperation.current = command;
    try {
      const updated = await jsonRequest<ExecutionPlanProjection>(
        `/api/execution-plans/${selected.planId}/revisions`, {
          method: "POST",
          body: JSON.stringify(command)
        }, token
      );
      if (!isCurrent() || selectedIdRef.current !== selectedAtStart.planId) return;
      revisionOperation.current = null;
      setRevisionUnknown(false);
      replacePlan(updated);
      setEditOpen(false);
      setEditorText("");
      setApprovalConfirmed(false);
      await loadFacts(updated);
      onChanged();
    } catch (reason) {
      if (!isCurrent() || isStaleWebSessionError(reason)) return;
      const unknown = !(reason instanceof HttpRequestError) || reason.status >= 500;
      if (!unknown) revisionOperation.current = null;
      setRevisionUnknown(unknown);
      setCommandError(t(
        `修订未确认：${String(reason)}。请重新载入；网络结果未知时，本页重试复用同一操作 ID。`,
        `Revision was not confirmed: ${String(reason)}. Reload it; this page reuses the same operation ID when the network outcome is unknown.`,
        locale
      ));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  async function submitReview(
    decision: "approved" | "rejected",
    retry = false
  ): Promise<void> {
    if (!selected || !currentMember || !canManage || busy || storageError) return;
    const reason = reviewReason.trim();
    if (!retry && (!reason || (decision === "approved" && !approvalConfirmed))) return;
    const scope = reviewScope(task, currentMember, selected.planId);
    const command: PendingPlanReviewCommand = retry && pendingReview
      ? pendingReview
      : {
          operationId: operationId(),
          expectedRevision: selected.current.revision,
          expectedDigest: selected.current.digest,
          expectedRootTaskRevision: task.taskRevision,
          decision,
          reason
        };
    try {
      savePendingPlanReview(scope, command);
      setPendingReview(command);
    } catch (reasonValue) {
      setStorageError(String(reasonValue));
      return;
    }
    setBusy("review");
    setCommandError(null);
    const selectedAtStart = selected.planId;
    try {
      const receipt = await jsonRequest<ExecutionPlanApprovalReceipt>(
        `/api/execution-plans/${selected.planId}/approvals`, {
          method: "POST",
          body: JSON.stringify(command)
        }, token
      );
      if (!isCurrent() || selectedIdRef.current !== selectedAtStart) return;
      if (receipt.approval.planId !== selected.planId ||
        receipt.approval.operationId !== command.operationId ||
        receipt.approval.revision !== command.expectedRevision ||
        receipt.approval.digest !== command.expectedDigest ||
        receipt.approval.decision !== command.decision) {
        throw new Error(t(
          "审批回执与提交的精确计划不匹配。",
          "The review receipt does not match the exact submitted plan.",
          locale
        ));
      }
      clearPendingPlanReview(scope, command);
      setPendingReview(null);
      setLastReceipt(receipt);
      setApprovalConfirmed(false);
      setReviewReason("");
      await loadPlans();
      onChanged();
    } catch (reasonValue) {
      if (!isCurrent() || isStaleWebSessionError(reasonValue)) return;
      if (reasonValue instanceof HttpRequestError) {
        try {
          clearPendingPlanReview(scope, command);
          setPendingReview(null);
        } catch (storageReason) {
          setStorageError(String(storageReason));
        }
      }
      setCommandError(t(
        `审批结果未确认：${String(reasonValue)}。先重新载入权威历史；若为网络中断，只能重试这条完全相同的命令。`,
        `Review outcome was not confirmed: ${String(reasonValue)}. Reload authoritative history first; after a network cut only this exact command may be retried.`,
        locale
      ));
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  const requiredQuestions = selected?.current.definition.decision.unresolvedQuestions
    .filter(({ required }) => required) ?? [];
  const rootUnavailable = task.isDefault || task.parentTaskId !== null ||
    task.lifecycleState === "completed" || task.lifecycleState === "canceled";
  const approvalBlocked = !selected || selected.state !== "draft" ||
    requiredQuestions.length > 0 || rootUnavailable;
  const diffs = useMemo(() => selected && facts?.previous
    ? diffPlanDefinitions(facts.previous.definition, selected.current.definition)
    : [], [facts?.previous, selected]);

  if (loading && plans.length === 0) {
    return <p role="status">{t("正在载入执行计划…", "Loading execution plans…", locale)}</p>;
  }
  if (error && plans.length === 0) {
    return <div className="work-plan-error"><p role="alert">{error}</p><button onClick={() => void loadPlans()} type="button">{t("重新载入计划", "Reload plans", locale)}</button></div>;
  }
  if (plans.length === 0) {
    return <section className="work-plan-empty"><h4>{t("执行计划", "Execution plan", locale)}</h4><p>{t("此 Task 尚无计划提案。Discussion 或已授权的 Tech Lead 可以先提交草案；只有人类可以批准。", "This Task has no plan proposal yet. A Discussion or assigned Tech Lead may propose a draft; only a human can approve it.", locale)}</p></section>;
  }
  if (!selected) return null;

  return <div className="work-plan-surface">
    <header className="work-plan-toolbar">
      <div>
        <p className="eyebrow">{t("人类控制面", "HUMAN CONTROL PLANE", locale)}</p>
        <h4>{selected.current.definition.title}</h4>
        <p>{t("审查 Server 保留的精确版本；此页面不会自行调度或合并。", "Review the exact Server-retained version; this page never schedules or merges by itself.", locale)}</p>
      </div>
      <label>{t("计划提案", "Plan proposal", locale)}
        <select aria-label={t("计划提案", "Plan proposal", locale)} onChange={(event) => selectPlan(event.target.value)} value={selected.planId}>
          {plans.map((plan) => <option key={plan.planId} value={plan.planId}>
            {plan.current.definition.title} · r{plan.current.revision} · {display(plan.state)}
          </option>)}
        </select>
      </label>
      <button disabled={loading || factsLoading} onClick={() => void loadPlans()} type="button">{t("刷新权威状态", "Reload authoritative state", locale)}</button>
    </header>

    {error && <p className="work-error" role="alert">{error}</p>}
    {commandError && <p className="work-command-error" role="alert">{commandError}</p>}
    {storageError && <p className="work-command-error" role="alert">{t("浏览器无法安全保留审批记录，已禁止新的审批：", "The browser cannot safely retain the review receipt; new review is blocked: ", locale)}{storageError}</p>}
    {pendingReview && <section className="work-plan-pending" role="status">
      <strong>{t("存在未确认的精确审批命令", "An exact review command is unconfirmed", locale)}</strong>
      <p>{display(pendingReview.decision)} · r{pendingReview.expectedRevision} · {shortenedDigest(pendingReview.expectedDigest)}</p>
      <button disabled={busy !== null} onClick={() => void loadPlans()} type="button">{t("先检查权威历史", "Check authoritative history", locale)}</button>
      <button disabled={busy !== null} onClick={() => void submitReview(pendingReview.decision, true)} type="button">{t("重试完全相同的命令", "Retry the exact same command", locale)}</button>
    </section>}

    <section className="work-plan-facts">
      <article><h5>{t("精确身份", "Exact identity", locale)}</h5><dl>
        <div><dt>Plan ID</dt><dd>{selected.planId}</dd></div>
        <div><dt>{t("状态", "State", locale)}</dt><dd>{display(selected.state)}</dd></div>
        <div><dt>{t("修订", "Revision", locale)}</dt><dd>{selected.current.revision}</dd></div>
        <div><dt>Digest</dt><dd className="work-plan-digest">{selected.current.digest}</dd></div>
        <div><dt>{t("作者", "Author", locale)}</dt><dd>{authorLabel(selected)}</dd></div>
        <div><dt>{t("更新时间", "Updated", locale)}</dt><dd>{selected.updatedAt}</dd></div>
      </dl></article>
      <article><h5>{t("决策", "Decision", locale)}</h5>
        <p>{selected.current.definition.decision.summary}</p>
        <ul>{selected.current.definition.decision.items.map((item) => <li key={item.itemKey}><strong>{item.itemKey}</strong> · {item.statement}</li>)}</ul>
        <p>{t("冻结来源", "Frozen sources", locale)}: {selected.current.definition.decision.sources.length}</p>
        <ul>{selected.current.definition.decision.sources.map((source) => <li key={source.evidenceRefId}>{display(source.kind)} · {source.evidenceRefId}</li>)}</ul>
      </article>
      <article><h5>{t("策略", "Policy", locale)}</h5><dl>
        <div><dt>{t("最大并发", "Max concurrency", locale)}</dt><dd>{selected.current.definition.policy.maxConcurrency}</dd></div>
        <div><dt>{t("集成模式", "Integration", locale)}</dt><dd>{display(selected.current.definition.policy.integration)}</dd></div>
        <div><dt>{t("人类集成批准", "Human integration approval", locale)}</dt><dd>{selected.current.definition.policy.requireHumanIntegrationApproval ? t("需要", "Required", locale) : t("不需要", "Not required", locale)}</dd></div>
        <div><dt>{t("总尝试预算", "Total attempt budget", locale)}</dt><dd>{selected.current.definition.policy.budget.maxRunAttempts}</dd></div>
        <div><dt>{t("集成目标", "Integration targets", locale)}</dt><dd>{selected.current.definition.policy.integrationTargets.length}</dd></div>
      </dl></article>
    </section>

    <section className="work-plan-blockers" aria-label={t("批准阻塞项", "Approval blockers", locale)}>
      <h5>{t("批准阻塞项", "Approval blockers", locale)}</h5>
      {requiredQuestions.length === 0 && !rootUnavailable && selected.state === "draft"
        ? <p>{t("浏览器投影中没有必需问题阻塞。Server 提交时仍会重新检查来源、Agent、Task、输入和竞争计划。", "No required-question blocker exists in this browser projection. The Server still rechecks sources, Agents, Tasks, inputs and competing plans on submission.", locale)}</p>
        : <ul>
            {selected.state !== "draft" && <li>{t("只有 draft 可以审查或修订。", "Only a draft can be reviewed or revised.", locale)}</li>}
            {rootUnavailable && <li>{t("根 Task 当前不可用于计划批准。", "The root Task is currently unavailable for plan approval.", locale)}</li>}
            {requiredQuestions.map((question) => <li key={question.questionKey}><strong>{question.questionKey}</strong> · {question.text}</li>)}
          </ul>}
    </section>

    <section className="work-plan-graph">
      <h5>{t("执行节点", "Execution nodes", locale)}</h5>
      <div>{selected.current.definition.nodes.map((node) => <article key={node.nodeKey}>
        <header><strong>{node.nodeKey}</strong><span>{display(node.kind)}</span><span>{node.required ? t("必需", "required", locale) : t("可选", "optional", locale)}</span></header>
        <p>{agentNames.get(node.agentId) ?? node.agentId}</p>
        <dl>
          <div><dt>Task</dt><dd>{display(node.task.mode)} · {node.task.title ?? node.task.taskId}</dd></div>
          <div><dt>{t("仓库", "Repository", locale)}</dt><dd>{node.repository.repositoryId}</dd></div>
          <div><dt>{t("基础提交", "Base commit", locale)}</dt><dd className="work-plan-digest">{node.repository.baseCommit}</dd></div>
          <div><dt>{t("路径权限", "Path access", locale)}</dt><dd>{display(node.scope.access)} · {node.scope.allowedPaths.join(", ") || "—"}</dd></div>
          <div><dt>{t("输入", "Inputs", locale)}</dt><dd>{node.inputs.map((input) => `${input.slotKey}:${input.kind}${input.required ? "*" : ""}`).join(", ") || "—"}</dd></div>
          <div><dt>{t("输出", "Outputs", locale)}</dt><dd>{node.outputs.map((output) => `${output.slotKey}:${output.kind}${output.required ? "*" : ""}`).join(", ")}</dd></div>
          <div><dt>{t("验证", "Verification", locale)}</dt><dd>{node.verificationProfiles.map((profile) => `${profile.profileId}@${profile.revision}${profile.required ? "*" : ""}`).join(", ") || "—"}</dd></div>
          <div><dt>{t("预算", "Budget", locale)}</dt><dd>{node.budget.maxRunAttempts} · {node.budget.maxExecutionDurationSeconds}s</dd></div>
        </dl>
      </article>)}</div>
      <h5>{t("依赖边", "Dependency edges", locale)}</h5>
      {selected.current.definition.edges.length === 0 ? <p>{t("没有依赖边", "No dependency edges", locale)}</p> : <ol>{selected.current.definition.edges.map((edge) => <li key={edge.edgeKey}><strong>{edge.fromNodeKey} → {edge.toNodeKey}</strong><span>{display(edge.gate)}</span><small>{edge.bindings.map((binding) => `${binding.outputSlot} → ${binding.inputSlot}`).join(", ") || t("仅门控", "gate only", locale)}</small></li>)}</ol>}
      <h5>{t("外部输入", "External inputs", locale)}</h5>
      {selected.current.definition.externalInputs.length === 0 ? <p>{t("没有外部输入", "No external inputs", locale)}</p> : <ul>{selected.current.definition.externalInputs.map((input) => <li key={`${input.nodeKey}:${input.inputSlot}`}><strong>{input.nodeKey}.{input.inputSlot}</strong> · {input.kind} · {input.artifactId}@{input.artifactRevision}</li>)}</ul>}
    </section>

    <section className="work-plan-diff">
      <h5>{t("与前一修订的差异", "Diff from previous revision", locale)}</h5>
      {factsLoading ? <p role="status">{t("正在载入修订历史…", "Loading revision history…", locale)}</p>
        : !facts?.previous ? <p>{t("这是第一个修订。", "This is the first revision.", locale)}</p>
        : diffs.length === 0 ? <p>{t("结构化定义没有变化。", "The structured definition is unchanged.", locale)}</p>
        : <ol>{diffs.map((entry, index) => <li key={`${entry.path}:${index}`}><strong>{display(entry.kind)}</strong><code>{entry.path}</code>{entry.kind !== "added" && <del>{displayPlanDiffValue(entry.before)}</del>}{entry.kind !== "removed" && <ins>{displayPlanDiffValue(entry.after)}</ins>}</li>)}</ol>}
    </section>

    {canManage && currentMember && ["approved", "running", "paused", "review"].includes(selected.state) && <PlanSupersessionPanel
      agentNames={agentNames}
      currentMember={currentMember}
      key={`${selected.planId}:${selected.current.revision}:${selected.controlRevision}`}
      locale={locale}
      onChanged={async () => { await loadPlans(); onChanged(); }}
      plan={selected}
      task={task}
      token={token}
    />}

    {canManage && selected.state === "draft" && <section className="work-plan-editor">
      <h5>{t("修订完整定义", "Revise complete definition", locale)}</h5>
      {!editOpen ? <button disabled={busy !== null || pendingReview !== null} onClick={beginEdit} type="button">{t("编辑当前草案", "Edit current draft", locale)}</button> : <form onSubmit={(event) => { event.preventDefault(); void saveRevision(); }}>
        <PlanDefinitionEditor text={editorText} onChange={setEditorText} agentNames={agentNames} locale={locale} disabled={busy !== null || revisionUnknown} />
        {revisionUnknown && <p role="status">{t("修订结果待确认。重试会发送上次的相同内容，请确认后再继续编辑。", "Revision outcome is unconfirmed. Retry sends the exact previous content; confirm it before editing again.", locale)}</p>}
        <div><button disabled={busy !== null} type="submit">{busy === "revision" ? t("正在保留…", "Retaining…", locale) : revisionUnknown ? t("重试相同修订", "Retry exact revision", locale) : t("提交新修订", "Submit new revision", locale)}</button><button disabled={busy !== null || revisionUnknown} onClick={() => { setEditOpen(false); setEditorText(""); revisionOperation.current = null; }} type="button">{t("取消编辑", "Cancel editing", locale)}</button></div>
      </form>}
    </section>}

    {canManage && selected.state === "draft" && <section className="work-plan-review">
      <h5>{t("精确人类审查", "Exact human review", locale)}</h5>
      <p>{t(`将绑定 r${selected.current.revision}、digest ${shortenedDigest(selected.current.digest)} 和当前 Task revision ${task.taskRevision}。`, `This binds r${selected.current.revision}, digest ${shortenedDigest(selected.current.digest)}, and current Task revision ${task.taskRevision}.`, locale)}</p>
      <label>{t("审查理由", "Review reason", locale)}<textarea disabled={pendingReview !== null} onChange={(event) => setReviewReason(event.target.value)} value={reviewReason} /></label>
      <label className="work-plan-confirm"><input checked={approvalConfirmed} disabled={pendingReview !== null || approvalBlocked} onChange={(event) => setApprovalConfirmed(event.target.checked)} type="checkbox" />{t(`我确认批准精确修订 r${selected.current.revision}（${shortenedDigest(selected.current.digest)}）。`, `I confirm approval of exact revision r${selected.current.revision} (${shortenedDigest(selected.current.digest)}).`, locale)}</label>
      <div><button disabled={busy !== null || pendingReview !== null || approvalBlocked || !approvalConfirmed || !reviewReason.trim() || Boolean(storageError)} onClick={() => void submitReview("approved")} type="button">{t("批准精确计划", "Approve exact plan", locale)}</button><button disabled={busy !== null || pendingReview !== null || selected.state !== "draft" || !reviewReason.trim() || Boolean(storageError)} onClick={() => void submitReview("rejected")} type="button">{t("拒绝此修订", "Reject this revision", locale)}</button></div>
    </section>}

    <section className="work-plan-receipts">
      <h5>{t("不可变审查回执", "Immutable review receipts", locale)}</h5>
      {lastReceipt && <article className="work-plan-latest-receipt"><strong>{t("本次已确认", "Confirmed now", locale)}</strong><span>{lastReceipt.approval.operationId}</span><span>{display(lastReceipt.approval.decision)} · r{lastReceipt.approval.revision} · {shortenedDigest(lastReceipt.approval.digest)}</span></article>}
      {!facts || facts.approvals.length === 0 ? <p>{t("尚无审查回执", "No review receipts yet", locale)}</p> : <ol>{facts.approvals.map((approval) => <li key={approval.operationId}><header><strong>{display(approval.decision)} · r{approval.revision}</strong><span>{approval.reviewedAt}</span></header><p>{approval.reason}</p><dl><div><dt>Digest</dt><dd>{shortenedDigest(approval.digest)}</dd></div><div><dt>{t("审查者", "Reviewer", locale)}</dt><dd>{approval.reviewedByMemberId}</dd></div><div><dt>Task revision</dt><dd>{approval.rootTaskRevisionBefore} → {approval.rootTaskRevisionAfter}</dd></div><div><dt>{t("编译 Task", "Compiled Tasks", locale)}</dt><dd>{approval.compiledTasks.map(({ nodeKey, taskId }) => `${nodeKey}:${taskId}`).join(", ") || "—"}</dd></div></dl></li>)}</ol>}
    </section>
  </div>;
}
