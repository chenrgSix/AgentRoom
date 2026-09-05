import type { Locale } from "../../i18n.js";
import type { Agent, DiscussionView } from "../../models.js";

type Selection = NonNullable<DiscussionView["waves"][number]["selection"]>;
type Reason = NonNullable<Selection["explanations"]>[number]["reasons"][number];
const labels: Record<Reason, [string, string]> = {
  all_member_policy: ["本次设置为全员参与", "All-member policy"],
  no_focus_questions: ["暂无聚焦问题，先收集各方意见", "No focus questions; collect all perspectives"],
  no_deterministic_match: ["未找到明确匹配，保留全员参与", "No deterministic match; retain all members"],
  question_reporter: ["提出过当前优先问题", "Reported a current priority question"],
  role_match: ["角色关键词匹配当前优先问题", "Role terms match a current priority question"],
  required_reviewer: ["本轮需要指定评审参与", "Required Reviewer for this wave"],
  finalizer_reviewer: ["由可用的指定评审汇总结论", "Eligible designated Reviewer consolidates the answer"],
  finalizer_primary: ["无可用指定评审，由任务主负责人汇总", "No eligible designated Reviewer; Task primary consolidates"],
  finalizer_ordinal: ["无可用指定评审或主负责人，按原参与顺序汇总", "No eligible Reviewer or primary; use frozen participant order"]
};

export function DiscussionInsights({ view, wave, agentsById, locale }: {
  view: DiscussionView;
  wave: DiscussionView["waves"][number] | null;
  agentsById: ReadonlyMap<string, Agent>;
  locale: Locale;
}) {
  const zh = locale === "zh-CN";
  const selection = wave?.selection;
  const usage = view.observedUsage;
  const name = (id: string) => agentsById.get(id)?.name ?? id;
  const active = usage ? usage.runsByState.queued + usage.runsByState.delivered +
    usage.runsByState.working + usage.runsByState.input_required : null;
  return <>
    {selection && <div className="discussion-selection-audit"
      aria-label={zh ? "本轮参与选择证据" : "Wave participant selection evidence"}>
      <strong>{zh ? "本轮选择证据" : "Wave selection evidence"}</strong>
      <span>{selection.selectedAgentIds.map(name).join(", ")}</span>
      {selection.version === 2 && selection.explanations?.length
        ? <ul className="discussion-selection-reasons">{selection.explanations.map((entry) =>
          <li key={entry.agentId}><strong>{name(entry.agentId)}</strong>: {entry.reasons.map((reason) =>
            labels[reason]?.[zh ? 0 : 1] ?? reason).join(zh ? "；" : "; ")}
            {entry.reportedQuestionIds.length > 0 && <span> · {entry.reportedQuestionIds.join(", ")}</span>}
            {entry.matchedRoleTerms.length > 0 && <span> · {entry.matchedRoleTerms.join(", ")}</span>}
          </li>)}</ul>
        : <span>{zh ? "旧记录未保存逐项选择原因" : "This legacy record has no per-member reasons"}</span>}
      {selection.focusQuestionIds.length > 0 && <span>{zh ? "聚焦问题" : "Focus questions"}: {selection.focusQuestionIds.join(", ")}</span>}
      <details><summary>{zh ? "查看校验证据" : "Inspect audit evidence"}</summary>
        <span>{selection.strategy} · v{selection.version}</span><br />
        <code>{selection.selectionDigest}</code>
      </details>
    </div>}
    <div className="discussion-selection-audit" aria-label={zh ? "讨论运行统计" : "Discussion usage"}>
      <strong>{zh ? "实际运行" : "Observed runs"}</strong>
      {usage ? <>
        <span>{zh ? `已创建 ${usage.createdRuns} 个 Run · 已完成 ${usage.runsByState.completed} · 未结束 ${active}`
          : `${usage.createdRuns} Runs created · ${usage.runsByState.completed} completed · ${active} active`}</span>
        <span>{zh ? `失败 ${usage.runsByState.failed} · 已取消 ${usage.runsByState.canceled} · 已过期 ${usage.runsByState.expired} · 结果未知 ${usage.runsByState.outcome_unknown}`
          : `${usage.runsByState.failed} failed · ${usage.runsByState.canceled} canceled · ${usage.runsByState.expired} expired · ${usage.runsByState.outcome_unknown} outcome unknown`}</span>
        <span>{zh ? "讨论历时（含等待）" : "Discussion elapsed time (including waits)"}: {usage.wallDurationSeconds === null
          ? (zh ? "未知" : "Unknown") : `${usage.wallDurationSeconds}s`}</span>
        <span>{zh ? `未创建 Run 的成员槽位 ${usage.unboundMemberSlots} · 记录不可用 ${usage.unavailableRunRecords}`
          : `${usage.unboundMemberSlots} member slots without a Run · ${usage.unavailableRunRecords} records unavailable`}</span>
      </> : <span>{zh ? "当前服务器未提供实际运行统计" : "Observed usage is unavailable from this Server"}</span>}
      {view.discussion.budget.agentRunsUsed !== undefined && <span>{zh ? "预算已记账槽位" : "Debited budget slots"}: {view.discussion.budget.agentRunsUsed}</span>}
    </div>
  </>;
}
