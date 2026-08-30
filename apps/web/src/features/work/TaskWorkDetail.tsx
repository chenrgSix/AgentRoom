import type {
  ResultProjection,
  RunContextManifest,
  TaskProjection
} from "@convene-wire/contracts/task-result";
import React from "react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { captureWebSessionScope, isStaleWebSessionError, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import type {
  ArtifactPreview,
  DiscussionView,
  Member,
  TaskArtifact,
  TaskArtifactPage
} from "../../models.js";
import { ArtifactPreviewPanel } from "../task/ArtifactPreviewPanel.js";
import { RunRecoveryControls } from "./RunRecoveryControls.js";

export const taskWorkDetailTabs = ["overview", "runs", "results", "artifacts", "discussion", "audit"] as const;
export type TaskWorkDetailTab = typeof taskWorkDetailTabs[number];

interface DetailedRun {
  runId: string;
  traceId: string;
  roomId: string;
  taskId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  targetAgentId: string;
  parentRunId: string | null;
  attemptNumber?: number;
  retryOfRunId?: string | null;
  instruction: string;
  state: string;
  lastSequence: number;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

interface DetailedRunEvent {
  sequence: number;
  createdAt: string;
  event: {
    type: "status" | "activity" | "output" | "reply";
    status?: string;
    kind?: string;
    phase?: string;
    label?: string;
    content?: string;
  };
}

interface DetailState {
  artifacts: TaskArtifact[];
  discussions: DiscussionView[];
  results: ResultProjection[];
  runs: DetailedRun[];
  task: TaskProjection;
}

interface RunEvidenceScope {
  taskId: string;
  runId: string | null;
  memberId: string | null;
  token: string | undefined;
  lastSequence: number | undefined;
}

interface RunEvidence {
  scope: RunEvidenceScope;
  status: "loading" | "ready" | "failed";
  events: DetailedRunEvent[];
  manifest: RunContextManifest | null;
  error: string | null;
}

interface TaskWorkDetailProps {
  agentNames: ReadonlyMap<string, string>;
  currentMember: Member | null;
  locale: Locale;
  initialTab?: TaskWorkDetailTab;
  initialRunId?: string | null;
  memberNames: ReadonlyMap<string, string>;
  onBack: () => void;
  onChanged: () => void;
  onCopyLink?: () => void | Promise<void>;
  onTabChange?: (tab: TaskWorkDetailTab) => void;
  onRunChange?: (runId: string) => void;
  onOpenRoom: (roomId: string, taskId: string) => void;
  onOpenTask: (taskId: string, roomId: string) => void;
  refreshKey: string;
  roomNames: ReadonlyMap<string, string>;
  taskId: string;
  token: string | undefined;
}

function text(zh: string, en: string, locale: Locale): string {
  return locale === "zh-CN" ? zh : en;
}

function display(value: string): string {
  return value.replaceAll("_", " ");
}

function createOperationId(): string {
  const value = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `op_${value.replaceAll("-", "_")}`;
}

function sourceIdentity(source: ResultProjection["proposal"]["sources"][number]): string {
  if (source.kind === "artifact") return source.artifactId ?? source.evidenceRefId;
  if (source.kind === "run_event") {
    return `${source.runId ?? source.evidenceRefId} · event ${source.sequence ?? "?"}`;
  }
  if (source.kind === "message") return source.messageId ?? source.evidenceRefId;
  if (source.kind === "memory") return source.memoryId ?? source.evidenceRefId;
  return source.discussionId ?? source.evidenceRefId;
}

function eventText(record: DetailedRunEvent): string {
  const event = record.event;
  if (event.type === "status") return event.status ?? "status";
  if (event.type === "activity") {
    return [event.kind, event.phase, event.label, event.content].filter(Boolean).join(" · ");
  }
  return event.content ?? "";
}

export function TaskWorkDetail({
  agentNames,
  currentMember,
  locale,
  initialTab = "overview",
  initialRunId = null,
  memberNames,
  onBack,
  onChanged,
  onCopyLink,
  onTabChange,
  onRunChange,
  onOpenRoom,
  onOpenTask,
  refreshKey,
  roomNames,
  taskId,
  token
}: TaskWorkDetailProps) {
  const requestedTab = taskWorkDetailTabs.includes(initialTab) ? initialTab : "overview";
  const [tab, setTab] = useState<TaskWorkDetailTab>(requestedTab);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [completeTask, setCompleteTask] = useState<Record<string, boolean>>({});
  const [followUpTitles, setFollowUpTitles] = useState<Record<string, string>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const requestedRunId = useRef(initialRunId);
  requestedRunId.current = initialRunId;
  const [runEvidence, setRunEvidence] = useState<RunEvidence | null>(null);
  const [evidenceReloadKey, setEvidenceReloadKey] = useState(0);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null);
  const [artifactPreviewBusyId, setArtifactPreviewBusyId] = useState<string | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [evidenceResultId, setEvidenceResultId] = useState<string | null>(null);
  const [evidenceArtifactId, setEvidenceArtifactId] = useState<string | null>(null);
  const previewRequestId = useRef(0);
  const operationIds = useRef(new Map<string, string>());
  const detailRequestId = useRef(0);
  const mounted = useRef(true);
  const detailScope = useMemo(() => ({
    taskId, memberId: currentMember?.memberId ?? null, token,
    isCurrentSession: captureWebSessionScope()
  }), [currentMember?.memberId, taskId, token]);
  const activeDetailScope = useRef(detailScope);
  activeDetailScope.current = detailScope;
  const isCurrentDetail = useCallback(() => mounted.current &&
    activeDetailScope.current === detailScope && detailScope.isCurrentSession(), [detailScope]);
  const lastRefreshKey = useRef(refreshKey);
  const selectedRunSequence = detail?.runs.find(({ runId }) => runId === selectedRunId)?.lastSequence;
  const evidenceScope = useMemo<RunEvidenceScope>(() => ({
    taskId, runId: selectedRunId, memberId: currentMember?.memberId ?? null, token, lastSequence: selectedRunSequence
  }), [currentMember?.memberId, selectedRunId, selectedRunSequence, taskId, token]);
  // Render-time scope fencing prevents even one frame of the previous Run's evidence.
  const currentEvidence = runEvidence?.scope === evidenceScope ? runEvidence : null;
  const runEvents = currentEvidence?.status === "ready" ? currentEvidence.events : [];
  const runManifest = currentEvidence?.status === "ready" ? currentEvidence.manifest : null;
  const runDetailError = currentEvidence?.error ?? null;
  const runDetailLoading = tab === "runs" && selectedRunId !== null && (!currentEvidence || currentEvidence.status === "loading");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      detailRequestId.current += 1;
      previewRequestId.current += 1;
    };
  }, []);

  // Location changes are navigation intent; ordinary evidence refreshes do not
  // overwrite a tab or Run the member selected while waiting for the response.
  useEffect(() => { setTab(requestedTab); }, [requestedTab, taskId]);

  useEffect(() => {
    const runs = detail?.task.taskId === taskId ? detail.runs : [];
    setSelectedRunId(initialRunId
      ? runs.find(({ runId }) => runId === initialRunId)?.runId ?? null
      : runs.at(-1)?.runId ?? null);
  }, [initialRunId, taskId]);

  function selectTab(next: TaskWorkDetailTab): void {
    setTab(next);
    if (next !== tab) onTabChange?.(next);
  }

  function selectRun(runId: string): void {
    setSelectedRunId(runId);
    if (runId !== selectedRunId) onRunChange?.(runId);
  }

  const operationIdFor = (key: string): string => {
    const existing = operationIds.current.get(key);
    if (existing) return existing;
    const created = createOperationId();
    operationIds.current.set(key, created);
    return created;
  };

  const loadDetail = useCallback(async (clearError = true) => {
    if (!isCurrentDetail()) return;
    const requestId = ++detailRequestId.current;
    setLoading(true);
    if (clearError) setError(null);
    try {
      const task = await jsonRequest<TaskProjection>(`/api/tasks/${taskId}`, {}, token);
      if (!isCurrentDetail() || requestId !== detailRequestId.current) return;
      const [runs, results, artifactPage, roomDiscussions] = await Promise.all([
        jsonRequest<DetailedRun[]>(`/api/tasks/${taskId}/runs`, {}, token),
        jsonRequest<ResultProjection[]>(`/api/tasks/${taskId}/results`, {}, token),
        jsonRequest<TaskArtifactPage>(`/api/tasks/${taskId}/artifacts`, {}, token),
        jsonRequest<DiscussionView[]>(`/api/rooms/${task.roomId}/discussions`, {}, token)
      ]);
      if (requestId !== detailRequestId.current || !isCurrentDetail()) return;
      setDetail({
        artifacts: artifactPage.artifacts,
        discussions: roomDiscussions.filter(({ discussion }) => discussion.taskId === taskId),
        results,
        runs,
        task
      });
      setSelectedRunId((current) => runs.some(({ runId }) => runId === current)
        ? current
        : requestedRunId.current
          ? runs.find(({ runId }) => runId === requestedRunId.current)?.runId ?? null
          : runs.at(-1)?.runId ?? null);
    } catch (reason) {
      if (requestId === detailRequestId.current && isCurrentDetail() && !isStaleWebSessionError(reason)) setError(String(reason));
    } finally {
      if (requestId === detailRequestId.current && isCurrentDetail()) setLoading(false);
    }
  }, [isCurrentDetail, taskId, token]);

  useEffect(() => {
    setDetail(null);
    setSelectedRunId(null);
    setCommandError(null);
    operationIds.current.clear();
    setRunEvidence(null);
    previewRequestId.current += 1;
    setArtifactPreview(null);
    setArtifactPreviewBusyId(null);
    setArtifactPreviewError(null);
    setEvidenceArtifactId(null);
    setEvidenceResultId(null);
    lastRefreshKey.current = refreshKey;
    void loadDetail();
  }, [loadDetail, taskId]);

  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    void loadDetail(false);
  }, [loadDetail, refreshKey]);

  useEffect(() => {
    if (!selectedRunId || tab !== "runs") {
      setRunEvidence(null);
      return;
    }
    let stopped = false;
    setRunEvidence({ scope: evidenceScope, status: "loading", events: [], manifest: null, error: null });
    void Promise.all([
      jsonRequest<DetailedRunEvent[]>(`/api/runs/${selectedRunId}/events?after=0`, {}, token),
      jsonRequest<RunContextManifest>(`/api/runs/${selectedRunId}/context-manifest`, {}, token)
        .catch((reason: unknown) => {
          if (reason instanceof Error && reason.message === "Run Context Manifest was not recorded") return null;
          throw reason;
        })
    ]).then(([events, manifest]) => {
      if (stopped) return;
      if (manifest && (manifest.runId !== selectedRunId || manifest.taskId !== taskId)) {
        throw new Error(text("上下文清单与当前尝试不匹配，已拒绝显示。", "The context manifest does not match this attempt and was refused.", locale));
      }
      setRunEvidence({
        scope: evidenceScope, status: "ready", events: [...events].sort((left, right) => left.sequence - right.sequence), manifest, error: null
      });
    }).catch((reason: unknown) => {
      if (!stopped) setRunEvidence({ scope: evidenceScope, status: "failed", events: [], manifest: null, error: String(reason) });
    });
    return () => { stopped = true; };
  }, [evidenceReloadKey, evidenceScope, locale, selectedRunId, tab, taskId, token]);

  const canReview = Boolean(currentMember && detail && currentMember.teamId === detail.task.teamId && (
    currentMember.role === "owner" || currentMember.memberId === detail.task.ownerMemberId
  ));
  const selectedRun = detail?.runs.find(({ runId }) => runId === selectedRunId) ?? null;
  const latestRun = detail?.runs.at(-1) ?? null;
  const latestResult = detail?.results[0] ?? null;
  const linkedResults = selectedRun ? detail?.results.filter((result) =>
    result.proposedBy.runId === selectedRun.runId ||
    result.proposal.sources.some((source) =>
      source.kind === "run_event" && source.runId === selectedRun.runId
    )
  ) ?? [] : [];
  const requiredCriteria = detail?.task.criteria.filter(({ required }) => required) ?? [];
  const latestClaims = new Map(latestResult?.proposal.criterionClaims.map((claim) => [
    claim.criterionKey,
    claim
  ]) ?? []);
  const satisfiedRequired = requiredCriteria.filter(({ criterionKey }) =>
    latestClaims.get(criterionKey)?.coverage === "satisfied"
  ).length;
  const tabs = useMemo<Array<{ key: TaskWorkDetailTab; label: string }>>(() => [
    { key: "overview", label: text("概览", "Overview", locale) },
    { key: "runs", label: "Runs" },
    { key: "results", label: "Results" },
    { key: "artifacts", label: "Artifacts" },
    { key: "discussion", label: "Discussion" },
    { key: "audit", label: "Audit" }
  ], [locale]);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, key: TaskWorkDetailTab): void {
    const index = tabs.findIndex((item) => item.key === key);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (event.key === "Enter" || event.key === " ") nextIndex = index;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    selectTab(next.key);
    document.getElementById(`work-tab-${next.key}`)?.focus();
  }

  async function reviewResult(result: ResultProjection, decision: "accepted" | "rejected") {
    if (!isCurrentDetail() || !detail || !canReview) return;
    const key = `review:${result.resultId}:${decision}`;
    const reason = reviewReasons[result.resultId]?.trim();
    if (!reason) return;
    setBusyKey(key);
    setCommandError(null);
    try {
      await jsonRequest(`/api/results/${result.resultId}/review-decisions`, {
        method: "POST",
        body: JSON.stringify({
          operationId: operationIdFor(key),
          decision,
          expectedTaskRevision: detail.task.taskRevision,
          expectedReviewRevision: result.review?.reviewRevision ?? 0,
          reason,
          completeTask: decision === "accepted" && Boolean(completeTask[result.resultId])
        })
      }, token);
      if (!isCurrentDetail()) return;
      operationIds.current.delete(key);
      await loadDetail(false);
      if (isCurrentDetail()) onChanged();
    } catch (reasonValue) {
      if (!isCurrentDetail() || isStaleWebSessionError(reasonValue)) return;
      setCommandError(text(
        `命令未确认：${String(reasonValue)}。已重新载入权威状态；重试会复用同一操作 ID。`,
        `Command was not confirmed: ${String(reasonValue)}. Authoritative state was reloaded; retry reuses the same operation ID.`,
        locale
      ));
      await loadDetail(false);
    } finally {
      if (isCurrentDetail()) setBusyKey(null);
    }
  }

  async function createFollowUp(result: ResultProjection, nextActionKey: string, description: string) {
    if (!isCurrentDetail() || !detail || !canReview) return;
    const key = `follow-up:${result.resultId}:${nextActionKey}`;
    const title = (followUpTitles[key] ?? description).trim();
    if (!title) return;
    setBusyKey(key);
    setCommandError(null);
    try {
      const childTask = await jsonRequest<TaskProjection>(
        `/api/results/${result.resultId}/follow-up-tasks`,
        {
          method: "POST",
          body: JSON.stringify({
            operationId: operationIdFor(key),
            nextActionKey,
            title: title.slice(0, 160),
            ownerMemberId: detail.task.ownerMemberId
          })
        },
        token
      );
      if (!isCurrentDetail()) return;
      operationIds.current.delete(key);
      onChanged();
      onOpenTask(childTask.taskId, childTask.roomId);
    } catch (reasonValue) {
      if (!isCurrentDetail() || isStaleWebSessionError(reasonValue)) return;
      setCommandError(text(
        `后续 Task 状态未知：${String(reasonValue)}。请重试；同一操作 ID 会返回同一 Task。`,
        `Follow-up Task state is unknown: ${String(reasonValue)}. Retry safely; the same operation ID resolves to the same Task.`,
        locale
      ));
    } finally {
      if (isCurrentDetail()) setBusyKey(null);
    }
  }

  async function previewArtifact(artifact: TaskArtifact) {
    if (!isCurrentDetail()) return;
    const requestId = ++previewRequestId.current;
    setArtifactPreview(null);
    setArtifactPreviewBusyId(artifact.artifactId);
    setArtifactPreviewError(null);
    try {
      const preview = await jsonRequest<ArtifactPreview>(
        `/api/tasks/${taskId}/artifacts/${artifact.artifactId}/preview`, {}, token
      );
      if (requestId !== previewRequestId.current || !isCurrentDetail()) return;
      if (preview.taskId !== taskId || preview.artifactId !== artifact.artifactId ||
        preview.artifactRevision !== artifact.artifactRevision || preview.integrity !== "verified" ||
        preview.trust !== "untrusted" || preview.sha256 !== artifact.contentSha256) {
        throw new Error(text("成果身份或校验信息不匹配，已拒绝显示。", "Artifact identity or integrity does not match; preview was refused.", locale));
      }
      setArtifactPreview(preview);
    } catch (reason) {
      if (requestId === previewRequestId.current && isCurrentDetail() && !isStaleWebSessionError(reason)) setArtifactPreviewError(String(reason));
    } finally {
      if (requestId === previewRequestId.current && isCurrentDetail()) setArtifactPreviewBusyId(null);
    }
  }

  function closePreview() {
    previewRequestId.current += 1;
    setArtifactPreview(null);
    setArtifactPreviewBusyId(null);
    setArtifactPreviewError(null);
  }

  if (loading && !detail) {
    return <section className="work-detail loading">{text("正在载入 Task…", "Loading Task…", locale)}</section>;
  }
  if (!detail) {
    return (
      <section className="work-detail error">
        <button onClick={onBack} type="button">← {text("返回工作台", "Back to Work", locale)}</button>
        <p role="alert">{error ?? text("Task 不可用", "Task unavailable", locale)}</p>
      </section>
    );
  }

  const { task } = detail;
  const roomName = roomNames.get(task.roomId) ?? text("未知 Room", "Unknown Room", locale);
  return (
    <section className="work-detail" aria-label={`TASK-${task.taskDisplayNumber}`}>
      <header className="work-detail-header">
        <button className="work-back" onClick={onBack} type="button">← {text("工作台", "Work", locale)}</button>
        <div>
          <p className="eyebrow">TASK-{task.taskDisplayNumber}</p>
          <h3>{task.title}</h3>
          <p>{task.goal}</p>
        </div>
        <div className="work-detail-actions">
          <div className="work-detail-badges">
            {task.isDefault && <span>{text("快速 Room 工作", "Quick Room work", locale)}</span>}
            <span>{display(task.lifecycleState)}</span>
            <span>{display(task.priority)}</span>
          </div>
          {onCopyLink && <button className="work-inline-link" onClick={() => void onCopyLink()} type="button">{text("复制当前链接", "Copy current link", locale)}</button>}
        </div>
      </header>
      <div aria-label={text("Task 详情导航", "Task detail navigation", locale)} className="work-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            aria-controls={`work-panel-${item.key}`}
            aria-selected={tab === item.key}
            id={`work-tab-${item.key}`}
            key={item.key}
            onClick={() => selectTab(item.key)}
            onKeyDown={(event) => navigateTabs(event, item.key)}
            role="tab"
            tabIndex={tab === item.key ? 0 : -1}
            type="button"
          >{item.label}</button>
        ))}
      </div>
      {error && <p className="work-error" role="alert">{error}</p>}
      {commandError && <p className="work-command-error" role="alert">{commandError}</p>}
      <div aria-labelledby={`work-tab-${tab}`} className="work-detail-panel" id={`work-panel-${tab}`} role="tabpanel">
        {tab === "overview" && (
          <div className="work-overview-grid">
            <article className="work-panel-card">
              <h4>{text("责任与位置", "Ownership and location", locale)}</h4>
              <dl>
                <div><dt>Room</dt><dd>#{roomName}</dd></div>
                <div><dt>{text("负责人", "Owner", locale)}</dt><dd>{memberNames.get(task.ownerMemberId) ?? text("未知", "Unknown", locale)}</dd></div>
                <div><dt>{text("调度", "Scheduling", locale)}</dt><dd>{display(task.schedulingState)}</dd></div>
                <div><dt>{text("完成策略", "Completion", locale)}</dt><dd>{display(task.completionPolicy)}</dd></div>
              </dl>
              <button onClick={() => onOpenRoom(task.roomId, task.taskId)} type="button">
                {text("在 Room 中打开此 Task", "Open this Task in Room", locale)}
              </button>
            </article>
            <article className="work-panel-card">
              <h4>{text("验收标准", "Acceptance criteria", locale)}</h4>
              <p>{satisfiedRequired}/{requiredCriteria.length} {text("条必需标准有证据支持", "required criteria evidenced", locale)}</p>
              <ol>{task.criteria.map((criterion) => {
                const claim = latestClaims.get(criterion.criterionKey);
                return <li key={criterion.criterionKey}><strong>{criterion.description}</strong><span>{claim ? display(claim.coverage) : text("无声明", "No claim", locale)}</span></li>;
              })}</ol>
            </article>
            <article className="work-panel-card">
              <h4>{text("执行与预算", "Execution and budget", locale)}</h4>
              <dl>
                <div><dt>{text("运行尝试", "Run attempts", locale)}</dt><dd>{task.budgetUsage.runAttempts}/{task.budgetPolicy.maxRunAttempts}</dd></div>
                <div><dt>{text("执行秒数", "Execution seconds", locale)}</dt><dd>{task.budgetUsage.executionDurationSeconds}</dd></div>
                <div><dt>{text("提供方 Tokens", "Provider tokens", locale)}</dt><dd>{task.budgetUsage.providerTokens ?? text("未知", "Unknown", locale)}</dd></div>
                <div><dt>{text("提供方成本", "Provider cost", locale)}</dt><dd>{task.budgetUsage.providerCostUsd ?? text("未知", "Unknown", locale)}</dd></div>
                <div><dt>{text("最新 Run", "Latest Run", locale)}</dt><dd>{latestRun ? `${text("尝试", "Attempt", locale)} ${latestRun.attemptNumber ?? "?"} · ${display(latestRun.state)}` : text("无", "None", locale)}</dd></div>
                <div><dt>{text("最新 Result", "Latest Result", locale)}</dt><dd>{latestResult ? `v${latestResult.resultVersion} · ${display(latestResult.state)}` : text("无", "None", locale)}</dd></div>
              </dl>
            </article>
            <article className="work-panel-card">
              <h4>{text("下一步与关注项", "Next action and attention", locale)}</h4>
              <p>{display(task.nextAction.reason)} · {display(task.nextAction.actorKind)}</p>
              {task.attentionReasons.length === 0
                ? <p>{text("没有待处理关注项", "No attention reasons", locale)}</p>
                : <ul>{task.attentionReasons.map((attention) => <li key={`${attention.reason}:${attention.sourceId}`}>{display(attention.reason)}</li>)}</ul>}
              <p>{text("指派", "Assignments", locale)}: {task.assignments.map(({ agentId, role }) => `${agentNames.get(agentId) ?? text("未知 Agent", "Unknown Agent", locale)} (${role})`).join(", ") || text("无", "None", locale)}</p>
              {latestResult && latestResult.proposal.openQuestions.length > 0 && <><strong>{text("最新开放问题", "Latest open questions", locale)}</strong><ul>{latestResult.proposal.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul></>}
            </article>
          </div>
        )}

        {tab === "runs" && (
          <div className="work-run-layout">
            <nav aria-label={text("运行尝试", "Run attempts", locale)} className="work-run-list">
              {detail.runs.length === 0 && <p>{text("尚无 Run", "No Runs yet", locale)}</p>}
              {detail.runs.map((run) => (
                <button aria-pressed={selectedRunId === run.runId} key={run.runId} onClick={() => selectRun(run.runId)} type="button">
                  <strong>{text("尝试", "Attempt", locale)} {run.attemptNumber ?? "?"}</strong>
                  <span>{agentNames.get(run.targetAgentId) ?? text("未知 Agent", "Unknown Agent", locale)}</span>
                  <span>{display(run.state)}</span>
                </button>
              ))}
            </nav>
            <article className="work-run-detail">
              {!selectedRun ? <p>{initialRunId
                ? text("此任务中没有可访问的指定 Run，请选择一次可用的尝试。", "The requested Run is not available in this Task. Select an available attempt.", locale)
                : text("选择一个 Run", "Select a Run", locale)}</p> : <>
                <h4>{text("冻结的运行尝试", "Frozen Run attempt", locale)}</h4>
                <dl>
                  <div><dt>{text("状态", "State", locale)}</dt><dd>{display(selectedRun.state)}</dd></div>
                  <div><dt>{text("父 Run", "Parent Run", locale)}</dt><dd>{selectedRun.parentRunId ? text("有", "Present", locale) : text("无", "None", locale)}</dd></div>
                  <div><dt>{text("重试来源", "Retry lineage", locale)}</dt><dd>{selectedRun.retryOfRunId ? text("前一次尝试", "Prior attempt", locale) : text("首次尝试", "Initial attempt", locale)}</dd></div>
                  <div><dt>Run ID</dt><dd>{selectedRun.runId}</dd></div>
                  <div><dt>{text("触发消息", "Trigger message", locale)}</dt><dd>{selectedRun.triggerMessageId}</dd></div>
                  <div><dt>{text("指令", "Instruction", locale)}</dt><dd>{selectedRun.instruction}</dd></div>
                </dl>
                <p>{text("关联 Result", "Linked Results", locale)}: {linkedResults.length === 0
                  ? text("无", "None", locale)
                  : linkedResults.map((result) => `v${result.resultVersion} (${display(result.state)})`).join(", ")}</p>
                {linkedResults.length > 0 && <button className="work-inline-link" onClick={() => selectTab("results")} type="button">{text("查看关联 Result", "View linked Results", locale)}</button>}
                <RunRecoveryControls
                  canManage={canReview}
                  evidenceReady={currentEvidence?.status === "ready"}
                  key={selectedRun.runId}
                  locale={locale}
                  memberId={currentMember?.memberId ?? null}
                  onChanged={async (newRunId) => {
                    if (!isCurrentDetail()) return;
                    await loadDetail(false);
                    if (!isCurrentDetail()) return;
                    if (newRunId) selectRun(newRunId);
                    onChanged();
                  }}
                  run={selectedRun}
                  task={task}
                  token={token}
                />
                {runDetailLoading && <p role="status">{text("正在载入此尝试的证据…", "Loading evidence for this attempt…", locale)}</p>}
                {runDetailError && <div><p role="alert">{runDetailError}</p><button className="work-inline-link" onClick={() => setEvidenceReloadKey((current) => current + 1)} type="button">{text("重新载入尝试证据", "Reload attempt evidence", locale)}</button></div>}
                <section>
                  <h5>{text("上下文清单", "Context manifest", locale)}</h5>
                  {runManifest ? <>
                    <p>{runManifest.goal}</p>
                    <dl>
                      <div><dt>{text("定义修订", "Definition revision", locale)}</dt><dd>{runManifest.definitionRevision}</dd></div>
                      <div><dt>{text("标准修订", "Criteria revision", locale)}</dt><dd>{runManifest.criteriaRevision}</dd></div>
                      <div><dt>{text("运行时", "Runtime", locale)}</dt><dd>{display(runManifest.target.runtimeKind)}</dd></div>
                      <div><dt>{text("工作区别名", "Workspace alias", locale)}</dt><dd>{runManifest.target.workspaceAlias ?? text("未记录", "Not recorded", locale)}</dd></div>
                      <div><dt>{text("文件系统", "Filesystem", locale)}</dt><dd>{display(runManifest.permissions.filesystemAccess)}</dd></div>
                    </dl>
                    <p>{text("明确省略", "Explicitly omitted", locale)}: {runManifest.omittedCategories.map(display).join(", ")}</p>
                  </> : <p>{text("此 Run 未记录上下文清单。", "No context manifest was recorded for this Run.", locale)}</p>}
                </section>
                <section>
                  <h5>{text("有序事件", "Ordered events", locale)}</h5>
                  {runEvents.length === 0 ? <p>{text("没有事件", "No events", locale)}</p> : <ol className="work-event-list">{runEvents.map((record) => <li key={record.sequence}><span>#{record.sequence}</span><strong>{record.event.type}</strong><pre>{eventText(record)}</pre></li>)}</ol>}
                </section>
              </>}
            </article>
          </div>
        )}

        {tab === "results" && (
          <div className="work-result-list">
            {detail.results.length === 0 && <p>{text("尚无 Result", "No Results yet", locale)}</p>}
            {detail.results.map((result) => {
              const stale = result.proposal.definitionRevision !== task.definitionRevision || result.proposal.criteriaRevision !== task.criteriaRevision;
              return <article className="work-result-card" key={result.resultId}>
                <header><strong>Result v{result.resultVersion}</strong><span>{display(result.state)}</span><span>{display(result.proposal.outcome)}</span></header>
                {stale && <p className="work-warning">{text("此 Result 基于旧的 Task 定义或标准，不可接受。", "This Result is stale against the current Task definition or criteria and cannot be accepted.", locale)}</p>}
                <p className="work-result-summary">{result.proposal.summary}</p>
                <p>{text("提议者", "Proposed by", locale)}: {display(result.proposedBy.kind)}</p>
                <h5>{text("标准声明", "Criterion claims", locale)}</h5>
                <ul>{result.proposal.criterionClaims.map((claim) => <li key={claim.criterionKey}><strong>{display(claim.coverage)}</strong> — {claim.explanation}<small>{claim.evidenceRefIds.join(", ")}</small></li>)}</ul>
                <h5>{text("证据来源", "Evidence sources", locale)}</h5>
                <ul>{result.proposal.sources.map((source) => {
                  const artifact = source.kind === "artifact" ? detail.artifacts.find(({ artifactId }) => artifactId === source.artifactId) : undefined;
                  const sourceRun = source.kind === "run_event" ? detail.runs.find(({ runId }) => runId === source.runId) : undefined;
                  return <li key={source.evidenceRefId}>
                    {artifact ? <>
                      <span>{artifact.title} · r{artifact.artifactRevision}</span>
                      {artifact.contentMode === "snapshot_blob" ? <button className="work-inline-link" disabled={artifactPreviewBusyId !== null} onClick={() => { setEvidenceArtifactId(artifact.artifactId); setEvidenceResultId(result.resultId); void previewArtifact(artifact); }} type="button">{text("查看证据", "Inspect evidence", locale)}</button> : <small>{text("仅引用；没有可验证的内容快照。", "Reference only; no verifiable content snapshot.", locale)}</small>}
                    </> : sourceRun ? <button className="work-inline-link" onClick={() => { selectRun(sourceRun.runId); selectTab("runs"); }} type="button">{text("查看运行事件", "Inspect Run events", locale)} · #{source.sequence ?? "?"}</button> : <span>{display(source.kind)} · {sourceIdentity(source)}</span>}
                  </li>;
                })}</ul>
                {evidenceResultId === result.resultId && <ArtifactPreviewPanel
                  artifacts={detail.artifacts.filter(({ artifactId }) => artifactId === evidenceArtifactId)}
                  busyId={artifactPreviewBusyId}
                  error={artifactPreviewError}
                  locale={locale}
                  onClose={closePreview}
                  onPreview={previewArtifact}
                  preview={artifactPreview?.artifactId === evidenceArtifactId ? artifactPreview : null}
                />}
                {result.proposal.risks.length > 0 && <><h5>{text("风险", "Risks", locale)}</h5><ul>{result.proposal.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></>}
                {result.proposal.openQuestions.length > 0 && <><h5>{text("开放问题", "Open questions", locale)}</h5><ul>{result.proposal.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul></>}
                {result.review && <p>{text("审核", "Review", locale)}: {display(result.review.decision)} · {result.review.reason}</p>}
                {canReview && result.state === "proposed" && <section className="work-review-controls" aria-label={text("审核 Result", "Review Result", locale)}>
                  <label>{text("审核理由", "Review reason", locale)}<textarea onChange={(event) => setReviewReasons((current) => ({ ...current, [result.resultId]: event.target.value }))} value={reviewReasons[result.resultId] ?? ""} /></label>
                  <label><input checked={Boolean(completeTask[result.resultId])} disabled={stale} onChange={(event) => setCompleteTask((current) => ({ ...current, [result.resultId]: event.target.checked }))} type="checkbox" />{text("接受时同时完成 Task", "Complete Task when accepting", locale)}</label>
                  <div>
                    <button disabled={stale || busyKey !== null || !(reviewReasons[result.resultId]?.trim())} onClick={() => void reviewResult(result, "accepted")} type="button">{text("接受", "Accept", locale)}</button>
                    <button disabled={busyKey !== null || !(reviewReasons[result.resultId]?.trim())} onClick={() => void reviewResult(result, "rejected")} type="button">{text("拒绝", "Reject", locale)}</button>
                  </div>
                </section>}
                {canReview && result.state === "accepted" && result.proposal.nextActions.length > 0 && <section className="work-follow-ups">
                  <h5>{text("从已接受 Result 创建后续 Task", "Create follow-up Tasks from accepted Result", locale)}</h5>
                  {result.proposal.nextActions.map((action) => {
                    const key = `follow-up:${result.resultId}:${action.nextActionKey}`;
                    return <div key={action.nextActionKey}><input aria-label={`${text("后续 Task", "Follow-up Task", locale)}: ${action.description}`} onChange={(event) => setFollowUpTitles((current) => ({ ...current, [key]: event.target.value }))} value={followUpTitles[key] ?? action.description} /><button disabled={busyKey !== null} onClick={() => void createFollowUp(result, action.nextActionKey, action.description)} type="button">{text("创建 Task", "Create Task", locale)}</button></div>;
                  })}
                </section>}
              </article>;
            })}
          </div>
        )}

        {tab === "artifacts" && <div className="work-artifact-list">
          {detail.artifacts.length === 0 && <p>{text("尚无 Artifact", "No Artifacts yet", locale)}</p>}
          <ArtifactPreviewPanel artifacts={detail.artifacts} busyId={artifactPreviewBusyId} error={artifactPreviewError} locale={locale} onClose={closePreview} onPreview={(artifact) => { setEvidenceResultId(null); setEvidenceArtifactId(null); return previewArtifact(artifact); }} preview={artifactPreview} />
          {detail.artifacts.filter(({ contentMode }) => contentMode !== "snapshot_blob").map((artifact) => <article key={artifact.artifactId}><strong>{artifact.title}</strong><span>{display(artifact.type)} · r{artifact.artifactRevision}</span><p>{artifact.summary}</p><small>{text("仅引用；没有可验证的内容快照。", "Reference only; no verifiable content snapshot.", locale)}</small></article>)}
        </div>}

        {tab === "discussion" && <div className="work-discussion-list">
          {detail.discussions.length === 0 ? <p>{text("此 Task 没有 Discussion", "No Discussion for this Task", locale)}</p> : detail.discussions.map(({ discussion, participants, turns }) => <article key={discussion.discussionId}><header><strong>{discussion.goal}</strong><span>{display(discussion.state)}</span></header><p>{text("轮次", "Turns", locale)}: {discussion.currentTurn} · {text("参与 Agent", "Agent participants", locale)}: {participants.length}</p><p>{text("开放问题", "Open questions", locale)}: {discussion.progress.openQuestions.length}</p><p>{text("已记录发言", "Recorded turns", locale)}: {turns.length}</p></article>)}
        </div>}

        {tab === "audit" && <div className="work-audit">
          <h4>{text("可核验的不可变事实", "Verifiable immutable facts", locale)}</h4>
          <dl>
            <div><dt>Task revision</dt><dd>{task.taskRevision}</dd></div>
            <div><dt>Definition revision</dt><dd>{task.definitionRevision}</dd></div>
            <div><dt>Criteria revision</dt><dd>{task.criteriaRevision}</dd></div>
            <div><dt>Result versions</dt><dd>{detail.results.length}</dd></div>
            <div><dt>Run attempts</dt><dd>{detail.runs.length}</dd></div>
          </dl>
          <p>{text("当前没有独立的审计日志读取 API；本页只展示权威投影中已有的修订、不可变 Result 审核和 Run 事件，不推断缺失历史。", "There is no standalone audit-log read API yet. This view shows only revisions, immutable Result reviews, and Run events present in authoritative projections; it does not infer missing history.", locale)}</p>
        </div>}
      </div>
    </section>
  );
}
