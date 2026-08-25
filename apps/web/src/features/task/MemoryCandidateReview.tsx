import type { Locale } from "../../i18n.js";
import type { AgentTask, MemoryCandidate } from "../../models.js";

interface MemoryCandidateReviewProps {
  busyId: string | null;
  candidates: MemoryCandidate[];
  locale: Locale;
  onAccept: (candidate: MemoryCandidate) => void | Promise<void>;
  onReject: (candidate: MemoryCandidate) => void | Promise<void>;
  tasks: AgentTask[];
}

const typeLabels: Record<string, { "zh-CN": string; en: string }> = {
  acceptance_criterion: { "zh-CN": "验收标准", en: "Acceptance criterion" },
  blocker: { "zh-CN": "阻塞项", en: "Blocker" },
  constraint: { "zh-CN": "约束", en: "Constraint" },
  convention: { "zh-CN": "约定", en: "Convention" },
  decision: { "zh-CN": "决策", en: "Decision" },
  fact: { "zh-CN": "事实", en: "Fact" },
  goal: { "zh-CN": "目标", en: "Goal" },
  open_question: { "zh-CN": "待决问题", en: "Open question" },
  plan: { "zh-CN": "计划", en: "Plan" },
  progress: { "zh-CN": "进展", en: "Progress" },
  result: { "zh-CN": "结果", en: "Result" }
};

function compactId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 12)}…${id.slice(-8)}`;
}

export function MemoryCandidateReview({
  busyId,
  candidates,
  locale,
  onAccept,
  onReject,
  tasks
}: MemoryCandidateReviewProps) {
  if (candidates.length === 0) return null;
  const taskNames = new Map(tasks.map(({ taskId, title }) => [taskId, title]));
  return (
    <section
      aria-label={locale === "zh-CN" ? "待审核记忆" : "Memory candidates"}
      className="memory-candidate-review"
    >
      <header>
        <div>
          <span className="memory-candidate-kicker">
            {locale === "zh-CN" ? "非权威候选" : "Non-authoritative candidates"}
          </span>
          <strong>
            {locale === "zh-CN"
              ? `${candidates.length} 条记忆待成员审核`
              : `${candidates.length} memories need Member review`}
          </strong>
        </div>
        <small>
          {locale === "zh-CN"
            ? "接受后才会成为共享长期记忆。"
            : "They become shared long-term Memory only after acceptance."}
        </small>
      </header>
      <div className="memory-candidate-list">
        {candidates.map((candidate) => {
          const isBusy = busyId === candidate.candidateId;
          const scope = candidate.scopeKind === "room"
            ? (locale === "zh-CN" ? "房间" : "Room")
            : taskNames.get(candidate.scopeId) ?? compactId(candidate.scopeId);
          return (
            <article className="memory-candidate" key={candidate.candidateId}>
              <div className="memory-candidate-meta">
                <span>{scope}</span>
                <span>{typeLabels[candidate.type]?.[locale] ?? candidate.type}</span>
              </div>
              <p>{candidate.content}</p>
              <details>
                <summary>
                  {locale === "zh-CN"
                    ? `${candidate.sourceMessageIds.length} 条来源消息`
                    : `${candidate.sourceMessageIds.length} source Messages`}
                </summary>
                <code>{candidate.sourceMessageIds.map(compactId).join(", ")}</code>
                <small>{locale === "zh-CN" ? "检查点" : "Checkpoint"}: {compactId(candidate.checkpointId)}</small>
              </details>
              <div className="memory-candidate-actions">
                <button
                  className="secondary"
                  disabled={isBusy}
                  onClick={() => void onReject(candidate)}
                  type="button"
                >{locale === "zh-CN" ? "拒绝" : "Reject"}</button>
                <button
                  disabled={isBusy}
                  onClick={() => void onAccept(candidate)}
                  type="button"
                >
                  {isBusy
                    ? (locale === "zh-CN" ? "提交中…" : "Saving…")
                    : (locale === "zh-CN" ? "接受为长期记忆" : "Accept as Memory")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
