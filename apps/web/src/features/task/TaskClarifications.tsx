import type { FormEvent } from "react";

import type { Locale } from "../../i18n.js";
import type { Agent, TaskClarification } from "../../models.js";

interface TaskClarificationsProps {
  agentsById: Map<string, Agent>;
  answers: Record<string, string>;
  busyId: string | null;
  clarifications: TaskClarification[];
  locale: Locale;
  onAnswer: (event: FormEvent, clarification: TaskClarification) => void | Promise<void>;
  onAnswerChange: (clarificationId: string, value: string) => void;
}

export function TaskClarifications({
  agentsById,
  answers,
  busyId,
  clarifications,
  locale,
  onAnswer,
  onAnswerChange
}: TaskClarificationsProps) {
  return clarifications.map((clarification) => {
    const target = agentsById.get(clarification.targetAgentId);
    const draft = answers[clarification.clarificationId] ?? "";
    const isBusy = busyId === clarification.clarificationId;
    return (
      <form
        className="task-clarification"
        key={clarification.clarificationId}
        onSubmit={(event) => void onAnswer(event, clarification)}
      >
        <div className="task-clarification-copy">
          <span className="task-clarification-label">
            {locale === "zh-CN" ? "任务信息待补充" : "Task clarification required"}
            {target ? ` · ${target.name}` : ""}
          </span>
          <strong>{clarification.question}</strong>
          <small>
            {locale === "zh-CN"
              ? "你的回答会作为房间消息写入当前任务，并在同一任务会话中继续；这不是本地权限审批。"
              : "Your answer becomes a Room message and continues the same Task session. It is not a local permission approval."}
          </small>
        </div>
        {clarification.choices.length > 0 && (
          <div className="task-clarification-choices">
            {clarification.choices.map((choice) => (
              <button
                aria-pressed={draft === choice}
                key={choice}
                onClick={() => onAnswerChange(clarification.clarificationId, choice)}
                type="button"
              >{choice}</button>
            ))}
          </div>
        )}
        <div className="task-clarification-answer">
          <textarea
            aria-label={locale === "zh-CN" ? "任务补充信息" : "Task clarification answer"}
            disabled={isBusy}
            onChange={(event) => onAnswerChange(
              clarification.clarificationId,
              event.currentTarget.value
            )}
            placeholder={locale === "zh-CN" ? "输入补充信息" : "Provide the missing information"}
            required
            rows={2}
            value={draft}
          />
          <button disabled={isBusy || !draft.trim()}>
            {isBusy
              ? (locale === "zh-CN" ? "继续中…" : "Resuming…")
              : (locale === "zh-CN" ? "回答并继续" : "Answer and resume")}
          </button>
        </div>
      </form>
    );
  });
}
