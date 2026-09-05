import { DiscussionInsights } from "./DiscussionInsights.js";
import type { Locale } from "../../i18n.js";
import type {
  Agent,
  DiscussionState,
  DiscussionView,
  Run
} from "../../models.js";

type WaveMemberState = "queued" | "working" | "completed" | "failed" | "canceled";
type DiscussionWave = DiscussionView["waves"][number];
export type DiscussionAction = "finish" | "stop_after_turn" | "pause" | "cancel" | "continue";

function discussionStateLabel(state: DiscussionState, locale: Locale): string {
  if (locale === "en") return state.replaceAll("_", " ");
  const labels: Record<DiscussionState, string> = {
    active: "讨论中",
    stop_requested: "将在本轮后停止",
    waiting_human: "等待你的决定",
    awaiting_extension: "等待继续讨论",
    paused: "已暂停",
    finalizing: "正在生成结论",
    completed: "已完成",
    canceled: "已立即停止",
    terminated: "已达到安全上限"
  };
  return labels[state];
}

function waveMemberState(
  turn: DiscussionView["turns"][number],
  run: Run | undefined
): WaveMemberState {
  if (turn.state === "completed") return "completed";
  if (turn.state === "failed") return "failed";
  if (turn.state === "canceled") return "canceled";
  if (run) {
    if (run.state === "completed") return "completed";
    if (run.state === "canceled") return "canceled";
    if (["failed", "expired", "outcome_unknown"].includes(run.state)) return "failed";
    if (["working", "input_required"].includes(run.state)) return "working";
    return "queued";
  }
  if (turn.state === "working") return "working";
  return "queued";
}

function waveMemberStateLabel(state: WaveMemberState, locale: Locale): string {
  if (locale === "en") {
    const labels: Record<WaveMemberState, string> = {
      canceled: "Canceled",
      completed: "Completed",
      failed: "Failed",
      queued: "Queued",
      working: "Working"
    };
    return labels[state];
  }
  const labels: Record<WaveMemberState, string> = {
    canceled: "已取消",
    completed: "已完成",
    failed: "失败",
    queued: "排队中",
    working: "执行中"
  };
  return labels[state];
}

function waveStateLabel(state: DiscussionWave["state"], locale: Locale): string {
  if (locale === "en") {
    const labels: Record<DiscussionWave["state"], string> = {
      canceled: "Canceled",
      completed: "Completed",
      failed: "Failed",
      open: "In progress",
      partial: "Partially completed"
    };
    return labels[state];
  }
  const labels: Record<DiscussionWave["state"], string> = {
    canceled: "已取消",
    completed: "已完成",
    failed: "失败",
    open: "进行中",
    partial: "部分完成"
  };
  return labels[state];
}

function wavePhaseLabel(phase: DiscussionWave["phase"], locale: Locale): string {
  if (locale === "en") {
    return phase === "finalization"
      ? "Conclusion generation"
      : phase === "review" ? "Parallel review" : "Parallel contribution";
  }
  return phase === "finalization"
    ? "结论生成"
    : phase === "review" ? "并行复核" : "并行讨论";
}

function terminalReasonLabel(reason: string, locale: Locale): string {
  const normalized = reason.replaceAll("_", " ");
  if (locale === "en") {
    const labels: Record<string, string> = {
      completed_without_reply: "Completed without a reply",
      agent_unavailable: "Agent unavailable",
      discussion_canceled_before_dispatch: "Discussion canceled before dispatch",
      input_required: "Human input required",
      late_duplicate: "Late duplicate result",
      run_canceled: "Run canceled",
      run_expired: "Run expired",
      run_failed: "Run failed",
      run_outcome_unknown: "Run outcome unknown",
      runtime_failure: "Runtime failure"
    };
    return labels[reason] ?? normalized;
  }
  const labels: Record<string, string> = {
    completed_without_reply: "已结束但没有返回回复",
    agent_unavailable: "智能体不可用",
    discussion_canceled_before_dispatch: "投递前讨论已取消",
    input_required: "需要人工输入",
    late_duplicate: "收到重复的迟到结果",
    run_canceled: "执行已取消",
    run_expired: "执行已过期",
    run_failed: "执行失败",
    run_outcome_unknown: "执行结果未知",
    runtime_failure: "运行时失败"
  };
  return labels[reason] ?? reason;
}

function display(value: string): string {
  return value.replaceAll("_", " ");
}

interface DiscussionStatusProps {
  activeDiscussion: DiscussionView | null;
  agentsById: Map<string, Agent>;
  busy: boolean;
  expanded: boolean;
  goalDraft: string;
  goalEditId: string | null;
  locale: Locale;
  runsById: Map<string, Run>;
  visibleDiscussion: DiscussionView;
  onCancelGoalEdit: () => void;
  onControl: (discussionId: string, action: DiscussionAction) => void | Promise<void>;
  onEditGoal: (discussion: DiscussionView) => void;
  onGoalDraftChange: (value: string) => void;
  onSaveGoal: () => void | Promise<void>;
  onToggle: () => void;
}

export function DiscussionStatus({
  activeDiscussion,
  agentsById,
  busy,
  expanded,
  goalDraft,
  goalEditId,
  locale,
  onCancelGoalEdit,
  onControl,
  onEditGoal,
  onGoalDraftChange,
  onSaveGoal,
  onToggle,
  runsById,
  visibleDiscussion
}: DiscussionStatusProps) {
  const activeWave = visibleDiscussion.waves.find(({ ordinal, state }) =>
    state === "open" && ordinal === visibleDiscussion.discussion.currentWave
  ) ?? visibleDiscussion.waves.findLast(({ state }) => state === "open")
    ?? visibleDiscussion.waves.findLast(({ ordinal }) =>
      ordinal === visibleDiscussion.discussion.currentWave
    )
    ?? visibleDiscussion.waves.at(-1)
    ?? null;
  const activeWaveMembers = activeWave
    ? visibleDiscussion.turns
      .filter(({ waveId }) => waveId === activeWave.waveId)
      .sort((left, right) =>
        (left.waveMemberOrdinal ?? Number.MAX_SAFE_INTEGER) -
        (right.waveMemberOrdinal ?? Number.MAX_SAFE_INTEGER)
      )
      .map((turn) => ({
        agent: agentsById.get(turn.speakerAgentId),
        state: waveMemberState(turn, turn.runId ? runsById.get(turn.runId) : undefined),
        turn
      }))
    : [];
  const expectedMembers = activeWave
    ? Math.max(activeWave.expectedMembers, activeWaveMembers.length)
    : 0;
  const endedMembers = activeWaveMembers.filter(({ state }) =>
    state === "completed" || state === "failed" || state === "canceled"
  ).length;
  const waveNumber = activeWave && activeWave.phase !== "finalization"
    ? activeWave.ordinal || visibleDiscussion.waves.filter(({ ordinal, phase }) =>
      ordinal <= activeWave.ordinal && phase !== "finalization"
    ).length
    : 0;

  return (
    <section className={`discussion-status${expanded ? " expanded" : ""}`} aria-label={locale === "zh-CN" ? "当前智能体讨论" : "Active Agent Discussion"}>
      <button
        aria-controls={`discussion-details-${visibleDiscussion.discussion.discussionId}`}
        aria-expanded={expanded}
        aria-label={locale === "zh-CN"
          ? `${expanded ? "收起" : "展开"}讨论详情`
          : `${expanded ? "Collapse" : "Expand"} Discussion details`}
        className="discussion-status-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className={`discussion-state ${visibleDiscussion.discussion.state}`}>
          {discussionStateLabel(visibleDiscussion.discussion.state, locale)}
          {visibleDiscussion.discussion.state === "active" && waveNumber > 0 &&
            ` · ${locale === "zh-CN" ? "第" : "wave "}${waveNumber}${locale === "zh-CN" ? "轮" : ""}`}
        </span>
        <strong className="discussion-status-title">{visibleDiscussion.discussion.goal}</strong>
        {activeWave && (
          <span
            aria-label={locale === "zh-CN"
              ? `智能体进度 ${endedMembers}/${expectedMembers}`
              : `Agent progress ${endedMembers}/${expectedMembers}`}
            className="discussion-status-progress"
          >{endedMembers}/{expectedMembers}</span>
        )}
        <span className="discussion-status-toggle-label">
          {locale === "zh-CN" ? (expanded ? "收起" : "详情") : (expanded ? "Hide" : "Details")}
        </span>
        <span aria-hidden="true" className="discussion-status-chevron">⌄</span>
      </button>
      {expanded && (
        <div className="discussion-status-details" id={`discussion-details-${visibleDiscussion.discussion.discussionId}`}>
          <div className="discussion-status-copy">
            {goalEditId === visibleDiscussion.discussion.discussionId && (
              <textarea
                aria-label={locale === "zh-CN" ? "讨论目标" : "Discussion goal"}
                className="discussion-goal-editor"
                onChange={(event) => onGoalDraftChange(event.currentTarget.value)}
                rows={2}
                value={goalDraft}
              />
            )}
            <small>
              {visibleDiscussion.discussion.progress.openQuestions.length > 0
                ? (locale === "zh-CN"
                    ? `还有 ${visibleDiscussion.discussion.progress.openQuestions.length} 个未决问题`
                    : `${visibleDiscussion.discussion.progress.openQuestions.length} open questions`)
                : ["completed", "canceled", "terminated"].includes(visibleDiscussion.discussion.state)
                  ? (locale === "zh-CN" ? "本次讨论已经结束" : "This Discussion has ended")
                  : (locale === "zh-CN" ? "正在根据进展和边际收益决定下一步" : "The Orchestrator is evaluating progress and marginal gain")}
            </small>
            {visibleDiscussion.discussion.policy && <dl className="discussion-policy-audit" aria-label={locale === "zh-CN" ? "讨论策略" : "Discussion policy"}>
              <div><dt>{locale === "zh-CN" ? "参与选择" : "Participant selection"}</dt><dd>{display(visibleDiscussion.discussion.policy.participantSelectionMode)} · {visibleDiscussion.discussion.policy.focusedParticipantLimit}</dd></div>
              <div><dt>{locale === "zh-CN" ? "本轮完成" : "Wave completion"}</dt><dd>{display(visibleDiscussion.discussion.policy.waveCompletionMode)}{visibleDiscussion.discussion.policy.waveCompletionMode === "read_only_quorum" ? ` · ${visibleDiscussion.discussion.policy.quorumMinimumCompleted} @ ${visibleDiscussion.discussion.policy.quorumSoftDeadlineSeconds}s` : ""}</dd></div>
            </dl>}
            <DiscussionInsights view={visibleDiscussion} wave={activeWave}
              agentsById={agentsById} locale={locale} />
            {activeWave && (
              <div className={`discussion-wave ${activeWave.phase} ${activeWave.state}`}>
                <div className="discussion-wave-summary">
                  <span>{wavePhaseLabel(activeWave.phase, locale)}</span>
                  <span className="discussion-wave-result">
                    <span className={`discussion-wave-state ${activeWave.state}`}>
                      {waveStateLabel(activeWave.state, locale)}
                    </span>
                    <strong>{locale === "zh-CN"
                      ? `${endedMembers}/${expectedMembers} 已结束`
                      : `${endedMembers}/${expectedMembers} finished`}</strong>
                  </span>
                </div>
                {activeWave.phase === "finalization" && activeWave.state === "open" && (
                  <div className="discussion-wave-finalizing" role="status">
                    <span aria-hidden="true" className="discussion-wave-pulse" />
                    <span>{locale === "zh-CN" ? "正在汇总各智能体结果" : "Consolidating Agent results"}</span>
                  </div>
                )}
                <ul
                  aria-label={activeWave.phase === "finalization"
                    ? (locale === "zh-CN" ? "结论生成进度" : "Conclusion generation progress")
                    : locale === "zh-CN"
                      ? `第${waveNumber}轮并行进度`
                      : `Wave ${waveNumber} parallel progress`}
                  className="discussion-wave-members"
                >
                  {activeWaveMembers.map(({ agent, state, turn }) => (
                    <li className={`discussion-wave-member ${state}`} key={turn.turnId}>
                      <span aria-hidden="true" className="discussion-wave-member-dot" />
                      <span className="discussion-wave-member-copy">
                        <strong>{agent?.name ?? (locale === "zh-CN" ? "智能体" : "Agent")}</strong>
                        {turn.terminalReason && (
                          <small>{locale === "zh-CN" ? "原因：" : "Reason: "}{terminalReasonLabel(turn.terminalReason, locale)}</small>
                        )}
                      </span>
                      <span>{waveMemberStateLabel(state, locale)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {((visibleDiscussion.seals?.length ?? 0) > 0 ||
              (visibleDiscussion.supplementalEvidence?.length ?? 0) > 0) && <div className="discussion-quorum-audit" aria-label={locale === "zh-CN" ? "Quorum 封存与迟到证据" : "Quorum seals and late evidence"}>
              <strong>{locale === "zh-CN" ? "Quorum 封存与迟到证据" : "Quorum seals and late evidence"}</strong>
              {(visibleDiscussion.seals ?? []).map((seal) => <article key={seal.sealId}>
                <header><span>{seal.sealId}</span><span>{seal.sealedAt}</span></header>
                <p>{locale === "zh-CN" ? "最低完成" : "Minimum completed"}: {seal.minimumCompleted} · {seal.acceptedMembers.length} {locale === "zh-CN" ? "条回复已封存" : "replies sealed"}</p>
                <ul>{seal.acceptedMembers.map((member) => <li key={member.turnId}><strong>{agentsById.get(member.agentId)?.name ?? member.agentId}</strong><span>{member.role} · reply #{member.sourceReplySequence} · message #{member.sourceMessageSequence}</span><code>{member.replyHash}</code></li>)}</ul>
                <code>{locale === "zh-CN" ? "Seal 摘要" : "Seal digest"}: {seal.sealDigest}</code>
              </article>)}
              {(visibleDiscussion.supplementalEvidence ?? []).map((evidence) => <article className="supplemental" key={evidence.evidenceId}>
                <header><span>{locale === "zh-CN" ? "迟到证据" : "Late evidence"} · {evidence.evidenceId}</span><span>{evidence.submittedAt}</span></header>
                <p>{agentsById.get(evidence.agentId)?.name ?? evidence.agentId} · reply #{evidence.sourceReplySequence} · message #{evidence.sourceMessageSequence}</p>
                <code>{evidence.evidenceDigest}</code>
              </article>)}
              <small>{locale === "zh-CN" ? "只显示不可变身份与摘要；迟到回复内容不会进入已封存决策。" : "Only immutable identities and digests are shown; late reply content never enters the sealed decision."}</small>
            </div>}
          </div>
          <div className="discussion-controls">
            {activeDiscussion && (goalEditId === activeDiscussion.discussion.discussionId ? (
              <>
                <button className="discussion-primary" disabled={busy || !goalDraft.trim()} onClick={() => void onSaveGoal()} type="button">
                  {locale === "zh-CN" ? "保存目标" : "Save goal"}
                </button>
                <button disabled={busy} onClick={onCancelGoalEdit} type="button">
                  {locale === "zh-CN" ? "取消" : "Cancel"}
                </button>
              </>
            ) : (
              <>
                {["awaiting_extension", "waiting_human", "paused"].includes(activeDiscussion.discussion.state) ? (
                  <button className="discussion-primary" disabled={busy} onClick={() => void onControl(activeDiscussion.discussion.discussionId, "continue")} type="button">
                    {locale === "zh-CN" ? "继续解决" : "Continue solving"}
                  </button>
                ) : activeDiscussion.discussion.state !== "finalizing" && activeDiscussion.discussion.state !== "stop_requested" ? (
                  <button className="discussion-primary" disabled={busy} onClick={() => void onControl(activeDiscussion.discussion.discussionId, "finish")} type="button">
                    {locale === "zh-CN" ? "结束并生成结论" : "Finish and generate conclusion"}
                  </button>
                ) : null}
                {activeDiscussion.discussion.state === "active" && (
                  <>
                    <button disabled={busy} onClick={() => void onControl(activeDiscussion.discussion.discussionId, "stop_after_turn")} type="button">
                      {locale === "zh-CN" ? "本轮后停止" : "Stop after turn"}
                    </button>
                    <button disabled={busy} onClick={() => void onControl(activeDiscussion.discussion.discussionId, "pause")} type="button">
                      {locale === "zh-CN" ? "暂停" : "Pause"}
                    </button>
                  </>
                )}
                {["awaiting_extension", "waiting_human", "paused"].includes(activeDiscussion.discussion.state) && (
                  <button disabled={busy} onClick={() => onEditGoal(activeDiscussion)} type="button">
                    {locale === "zh-CN" ? "调整目标" : "Adjust goal"}
                  </button>
                )}
                {activeDiscussion.discussion.state !== "finalizing" && (
                  <button className="discussion-danger" disabled={busy} onClick={() => void onControl(activeDiscussion.discussion.discussionId, "cancel")} type="button">
                    {locale === "zh-CN" ? "立即停止" : "Stop now"}
                  </button>
                )}
              </>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
