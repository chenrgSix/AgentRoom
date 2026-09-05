import type { WorkbenchPage } from "@convene-wire/contracts/task-result";
import React from "react";

import type { Locale } from "../../i18n.js";
import type { TaskWorkDetailTab } from "./TaskWorkDetail.js";
import { attentionFilters, type WorkFilters } from "./work-filters.js";
import { WorkSearchInput } from "./WorkSearchInput.js";

export type WorkbenchItem = WorkbenchPage["items"][number];

interface WorkWorkspaceProps extends WorkFilters {
  searchContext?: string;
  onFiltersChange?: (filters: WorkFilters) => void;
  onClearFilters?: () => void;
  agentNames: ReadonlyMap<string, string>;
  error: string | null;
  items: WorkbenchItem[];
  loading: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  lifecycleState?: string;
  locale: Locale;
  memberNames: ReadonlyMap<string, string>;
  onCreateTask?: () => void;
  createTaskDisabled?: boolean;
  onCopyLink?: () => void | Promise<void>;
  onOpenAction?: (item: WorkbenchItem) => void;
  onOpenTask: (taskId: string, roomId: string) => void;
  onLoadMore?: () => void;
  onLifecycleStateChange?: (value: string) => void;
  onOwnerMemberIdChange?: (value: string) => void;
  onSearchChange?: (value: string) => void;
  onRefresh: () => void;
  onScopeChange: (scope: "mine" | "team") => void;
  roomNames: ReadonlyMap<string, string>;
  ownerMemberId?: string;
  search?: string;
  scope: "mine" | "team";
}

export interface WorkActionTarget {
  view: "room" | "work";
  roomId: string;
  taskId: string;
  tab?: TaskWorkDetailTab;
  runId?: string;
}

/** Navigation intent only. Neither the projection nor this mapping grants command authority. */
export function workActionTarget(item: WorkbenchItem): WorkActionTarget | null {
  const location = { roomId: item.roomId, taskId: item.taskId };
  const { reason, sourceId } = item.nextAction;
  if (reason === "none") return null;
  if (reason === "provide_input" || reason === "start_work") return { ...location, view: "room" };
  if (reason === "review_result" || reason === "submit_result") return { ...location, view: "work", tab: "results" };
  if (reason === "acknowledge_outcome") {
    const runId = sourceId && /^run_[A-Za-z0-9_-]{8,128}$/u.test(sourceId)
      ? sourceId
      : item.latestRun?.runId;
    return { ...location, view: "work", tab: "runs", ...(runId ? { runId } : {}) };
  }
  return { ...location, view: "work", tab: "overview" };
}

type GroupKey = "human" | "executing" | "review" | "blocked" | "completed" | "other";

const activeRunStates = new Set([
  "queued", "delivered", "working", "input_required"
]);
const blockedReasons = new Set([
  "outcome_unknown", "blocked", "overdue", "paused", "budget_exhausted",
  "runtime_unavailable", "result_rejected"
]);

function groupFor(item: WorkbenchItem): GroupKey {
  if (item.lifecycleState === "completed") return "completed";
  if (item.lifecycleState === "review" || item.attentionReasons.some(({ reason }) =>
    reason === "needs_approval" || reason === "result_stale"
  )) return "review";
  if (item.attentionReasons.some(({ reason }) => blockedReasons.has(reason))) {
    return "blocked";
  }
  if (item.nextAction.actorKind === "member" && item.nextAction.reason !== "none") {
    return "human";
  }
  if ((item.latestRun && activeRunStates.has(item.latestRun.state)) ||
    item.lifecycleState === "active") return "executing";
  return "other";
}

function label(value: string, locale: Locale): string {
  if (locale !== "zh-CN") return value.replaceAll("_", " ");
  const labels: Record<string, string> = {
    needs_input: "等待输入",
    outcome_unknown: "结果未知",
    needs_approval: "等待审核",
    result_stale: "结果已过期",
    blocked: "已阻塞",
    overdue: "已逾期",
    paused: "已暂停",
    budget_exhausted: "预算已用尽",
    runtime_unavailable: "运行时不可用",
    result_rejected: "结果被拒绝",
    draft: "草稿",
    ready: "就绪",
    active: "进行中",
    review: "审核中",
    completed: "已完成",
    canceled: "已取消",
    low: "低",
    normal: "普通",
    high: "高",
    urgent: "紧急",
    provide_input: "提供输入",
    acknowledge_outcome: "确认未知结果",
    review_result: "审核结果",
    resolve_block: "解决阻塞",
    resume_scheduling: "恢复调度",
    increase_budget: "增加预算",
    restore_runtime: "恢复运行时",
    submit_result: "提交结果",
    start_work: "开始工作",
    none: "无需操作",
    queued: "排队中",
    delivered: "已送达",
    working: "执行中",
    input_required: "等待输入",
    failed: "失败",
    expired: "已过期"
  };
  return labels[value] ?? value;
}

function WorkCard({
  agentNames,
  item,
  locale,
  memberNames,
  onOpenAction,
  onOpenTask,
  roomNames
}: {
  agentNames: ReadonlyMap<string, string>;
  item: WorkbenchItem;
  locale: Locale;
  memberNames: ReadonlyMap<string, string>;
  onOpenAction: WorkWorkspaceProps["onOpenAction"];
  onOpenTask: WorkWorkspaceProps["onOpenTask"];
  roomNames: ReadonlyMap<string, string>;
}) {
  const unknown = locale === "zh-CN" ? "未知" : "Unknown";
  return (
    <article className="work-card">
      <button
        aria-label={locale === "zh-CN"
          ? `打开 TASK-${item.taskDisplayNumber}`
          : `Open TASK-${item.taskDisplayNumber}`}
        className="work-card-open"
        onClick={() => onOpenTask(item.taskId, item.roomId)}
        type="button"
      >
        <span className="work-task-number">TASK-{item.taskDisplayNumber}</span>
        <span className={`work-priority ${item.priority}`}>{label(item.priority, locale)}</span>
        <strong>{item.title}</strong>
        <small>
          #{roomNames.get(item.roomId) ?? unknown} · {locale === "zh-CN" ? "负责人" : "Owner"} {memberNames.get(item.ownerMemberId) ?? unknown}
        </small>
      </button>
      <div className="work-state-row">
        <span>{label(item.lifecycleState, locale)}</span>
        {item.schedulingState === "paused" && <span>{label("paused", locale)}</span>}
        {item.latestRun && (
          <span>
            {agentNames.get(item.latestRun.agentId) ?? unknown} · {label(item.latestRun.state, locale)}
          </span>
        )}
      </div>
      {item.attentionReasons.length > 0 && (
        <ul aria-label={locale === "zh-CN" ? "全部关注原因" : "All attention reasons"} className="work-attention-list">
          {item.attentionReasons.map((attention) => (
            <li
              className={attention.reason === item.primaryAttention ? "primary" : ""}
              key={`${attention.reason}:${attention.sourceId}`}
            >{label(attention.reason, locale)}</li>
          ))}
        </ul>
      )}
      <dl className="work-facts">
        <div>
          <dt>{locale === "zh-CN" ? "必需标准" : "Required criteria"}</dt>
          <dd>{item.requiredCriteriaSatisfied}/{item.requiredCriteriaTotal}</dd>
        </div>
        <div>
          <dt>{locale === "zh-CN" ? "运行尝试" : "Run attempts"}</dt>
          <dd>{item.budgetUsage.runAttempts}</dd>
        </div>
        <div>
          <dt>{locale === "zh-CN" ? "提供方用量" : "Provider usage"}</dt>
          <dd>{item.budgetUsage.providerTokens === null
            ? unknown
            : item.budgetUsage.providerTokens}</dd>
        </div>
      </dl>
      <footer>
        {onOpenAction && workActionTarget(item) ? <button
          aria-label={locale === "zh-CN"
            ? `查看 TASK-${item.taskDisplayNumber} 的下一步：${label(item.nextAction.reason, locale)}`
            : `Open next step for TASK-${item.taskDisplayNumber}: ${label(item.nextAction.reason, locale)}`}
          className="work-inline-link work-next-action"
          onClick={() => onOpenAction(item)}
          type="button"
        >{locale === "zh-CN" ? "前往下一步" : "Open next step"} · {label(item.nextAction.reason, locale)}</button>
          : <span>{locale === "zh-CN" ? "下一步" : "Next"}: {label(item.nextAction.reason, locale)}</span>}
        {item.latestResultId && (
          <span>{locale === "zh-CN" ? "最新结果" : "Latest Result"}: {item.latestResultCurrent
            ? (locale === "zh-CN" ? "当前版本" : "Current")
            : (locale === "zh-CN" ? "旧版本" : "Stale")}</span>
        )}
      </footer>
    </article>
  );
}

export function WorkWorkspace({
  agentNames,
  error,
  items,
  loading,
  loadingMore = false,
  hasMore = false,
  lifecycleState = "",
  locale,
  memberNames,
  onCreateTask,
  createTaskDisabled = false,
  onCopyLink,
  onOpenAction,
  onOpenTask,
  onLoadMore,
  onLifecycleStateChange,
  onOwnerMemberIdChange,
  onSearchChange,
  onRefresh,
  onScopeChange,
  roomNames,
  ownerMemberId = "",
  search = "",
  scope, attention = "", filterRoomId = "", filterAgentId = "", priority = "",
  searchContext = "", onFiltersChange, onClearFilters
}: WorkWorkspaceProps) {
  const groups: Array<{ key: GroupKey; title: string }> = [
    { key: "human", title: locale === "zh-CN" ? "需要我处理" : "Needs human action" },
    { key: "executing", title: locale === "zh-CN" ? "正在执行" : "Executing" },
    { key: "review", title: locale === "zh-CN" ? "等待审核" : "Waiting for review" },
    { key: "blocked", title: locale === "zh-CN" ? "阻塞与风险" : "Blocked and at risk" },
    { key: "completed", title: locale === "zh-CN" ? "最近完成" : "Recently completed" },
    { key: "other", title: locale === "zh-CN" ? "其他工作" : "Other work" }
  ];
  const grouped = new Map(groups.map(({ key }) => [
    key,
    items.filter((item) => groupFor(item) === key)
  ]));
  return (
    <section className="work-workspace" aria-label={locale === "zh-CN" ? "工作台" : "Work"}>
      <header className="work-intro">
        <div>
          <p className="eyebrow">{locale === "zh-CN" ? "TEAM WORKBENCH" : "TEAM WORKBENCH"}</p>
          <h3>{locale === "zh-CN" ? "从工作开始，而不是从聊天记录开始" : "Start from work, not chat history"}</h3>
          <p>{locale === "zh-CN"
            ? "这里展示你有权访问的 Task、关注原因、最新 Run/Result 与下一步。"
            : "Authorized Tasks, every attention reason, the latest Run/Result, and the next action."}</p>
        </div>
        <div className="work-toolbar">
          {onCreateTask && <button className="work-inline-link work-create-task" disabled={createTaskDisabled} onClick={onCreateTask} type="button">{locale === "zh-CN" ? "新建任务" : "New Task"}</button>}
          <div aria-label={locale === "zh-CN" ? "工作范围" : "Work scope"} className="work-scope" role="group">
            <button aria-pressed={scope === "mine"} onClick={() => onScopeChange("mine")} type="button">{locale === "zh-CN" ? "我的" : "Mine"}</button>
            <button aria-pressed={scope === "team"} onClick={() => onScopeChange("team")} type="button">Team</button>
          </div>
          <button className="work-refresh" disabled={loading} onClick={onRefresh} type="button">
            {loading ? (locale === "zh-CN" ? "刷新中…" : "Refreshing…") : (locale === "zh-CN" ? "刷新" : "Refresh")}
          </button>
          {onCopyLink && <button className="work-inline-link" onClick={() => void onCopyLink()} type="button">{locale === "zh-CN" ? "复制当前链接" : "Copy current link"}</button>}
        </div>
      </header>
      {(onLifecycleStateChange || onOwnerMemberIdChange || onSearchChange || onFiltersChange) && <div className="work-filters" aria-label={locale === "zh-CN" ? "筛选工作" : "Filter work"}>
        {onSearchChange && <WorkSearchInput key={searchContext} value={search} locale={locale} onChange={onSearchChange} />}
        {onFiltersChange && <>
          <label>{locale === "zh-CN" ? "关注原因" : "Attention"}<select value={attention} onChange={(event) => onFiltersChange({ attention: event.target.value as WorkFilters["attention"] })}>
            <option value="">{locale === "zh-CN" ? "全部原因" : "All reasons"}</option>
            {attentionFilters.map((filter) => <option value={filter.value} key={filter.value}>{locale === "zh-CN" ? filter.zh : filter.en}</option>)}
          </select></label>
          <label>{locale === "zh-CN" ? "筛选房间" : "Filter Room"}<select value={filterRoomId} onChange={(event) => onFiltersChange({ filterRoomId: event.target.value })}>
            <option value="">{locale === "zh-CN" ? "全部房间" : "All Rooms"}</option>
            {filterRoomId && !roomNames.has(filterRoomId) && <option value={filterRoomId}>{locale === "zh-CN" ? "房间不可用" : "Room unavailable"}</option>}
            {[...roomNames].map(([id, name]) => <option value={id} key={id}>{name}</option>)}
          </select></label>
          <label>{locale === "zh-CN" ? "筛选智能体" : "Filter Agent"}<select value={filterAgentId} onChange={(event) => onFiltersChange({ filterAgentId: event.target.value })}>
            <option value="">{locale === "zh-CN" ? "全部智能体" : "All Agents"}</option>
            {filterAgentId && !agentNames.has(filterAgentId) && <option value={filterAgentId}>{locale === "zh-CN" ? "智能体不可用" : "Agent unavailable"}</option>}
            {[...agentNames].map(([id, name]) => <option value={id} key={id}>{name}</option>)}
          </select></label>
          <label>{locale === "zh-CN" ? "优先级" : "Priority"}<select value={priority} onChange={(event) => onFiltersChange({ priority: event.target.value as WorkFilters["priority"] })}>
            <option value="">{locale === "zh-CN" ? "全部优先级" : "All priorities"}</option>
            {["low", "normal", "high", "urgent"].map((value) => <option value={value} key={value}>{label(value, locale)}</option>)}
          </select></label>
          <div className="work-quick-filters" role="group" aria-label={locale === "zh-CN" ? "快捷筛选" : "Quick filters"}>
            {attentionFilters.slice(0, 3).map((filter) => <button className="work-inline-link" type="button" aria-pressed={attention === filter.value} key={filter.value} onClick={() => onFiltersChange({ attention: attention === filter.value ? "" : filter.value })}>{locale === "zh-CN" ? filter.zh : filter.en}</button>)}
          </div>
        </>}
        {onLifecycleStateChange && <label>{locale === "zh-CN" ? "任务状态" : "Task state"}<select onChange={(event) => onLifecycleStateChange(event.target.value)} value={lifecycleState}>
          <option value="">{locale === "zh-CN" ? "全部状态" : "All states"}</option>
          {["draft", "ready", "active", "review", "completed", "canceled"].map((state) => <option key={state} value={state}>{label(state, locale)}</option>)}
        </select></label>}
        {onOwnerMemberIdChange && <label>{locale === "zh-CN" ? "负责人" : "Owner"}<select onChange={(event) => onOwnerMemberIdChange(event.target.value)} value={ownerMemberId}>
          <option value="">{locale === "zh-CN" ? "全部负责人" : "All owners"}</option>
          {[...memberNames].map(([memberId, name]) => <option key={memberId} value={memberId}>{name}</option>)}
        </select></label>}
        {(lifecycleState || ownerMemberId || search || attention || filterRoomId || filterAgentId || priority) && <button className="work-inline-link" onClick={() => { if (onClearFilters) { onClearFilters(); return; } onLifecycleStateChange?.(""); onOwnerMemberIdChange?.(""); onSearchChange?.(""); onFiltersChange?.({ attention: "", filterRoomId: "", filterAgentId: "", priority: "" }); }} type="button">{locale === "zh-CN" ? "清除筛选" : "Clear filters"}</button>}
      </div>}
      {error && <p className="work-error" role="alert">{error}</p>}
      {!loading && !error && items.length === 0 ? (
        <div className="work-empty">
          <span>✓</span>
          <strong>{locale === "zh-CN" ? "当前范围没有工作项" : "No work items in this scope"}</strong>
          <p>{locale === "zh-CN"
            ? (search ? "没有匹配的任务；可调整搜索词或清除筛选。" : onCreateTask ? "可切换范围，或使用“新建任务”在当前 Room 中创建 Task。" : "可切换范围，或在 Room 中创建明确的 Task。")
            : (search ? "No matching Tasks; adjust your search or clear the filters." : onCreateTask ? "Change scope or use New Task to create work in the selected Room." : "Change scope or create an explicit Task in a Room.")}</p>
        </div>
      ) : (
        <div className="work-groups">
          {groups.map(({ key, title }) => {
            const groupItems = grouped.get(key) ?? [];
            if (groupItems.length === 0) return null;
            return (
              <section className={`work-group ${key}`} key={key}>
                <header><h4>{title}</h4><span>{groupItems.length}</span></header>
                <div className="work-card-grid">
                  {groupItems.map((item) => (
                    <WorkCard
                      agentNames={agentNames}
                      item={item}
                      key={item.taskId}
                      locale={locale}
                      memberNames={memberNames}
                      onOpenAction={onOpenAction}
                      onOpenTask={onOpenTask}
                      roomNames={roomNames}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {items.length > 0 && <footer className="work-pagination">
        <p role="status">{locale === "zh-CN" ? `已加载 ${items.length} 项工作` : `${items.length} work items loaded`}</p>
        {hasMore && onLoadMore && <button className="work-inline-link" disabled={loading || loadingMore} onClick={onLoadMore} type="button">{loadingMore ? (locale === "zh-CN" ? "加载中…" : "Loading…") : (locale === "zh-CN" ? "加载更多工作" : "Load more work")}</button>}
        {!hasMore && !loading && <small>{locale === "zh-CN" ? "已显示当前筛选下的全部工作" : "All work matching the current filters is shown"}</small>}
      </footer>}
    </section>
  );
}
