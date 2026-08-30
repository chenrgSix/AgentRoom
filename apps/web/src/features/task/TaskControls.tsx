import { useEffect, useRef, type FormEvent } from "react";

import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { AgentTask } from "../../models.js";
import { appendCriteriaTemplate, parseTaskCriteria } from "./task-criteria.js";

interface TaskSelectorProps {
  locale: Locale;
  selectedTask: AgentTask | null;
  selectedTaskId: string | null;
  tasks: AgentTask[];
  onCreate: () => void;
  onSelect: (taskId: string) => void;
}

export function TaskSelector({
  locale,
  onCreate,
  onSelect,
  selectedTask,
  selectedTaskId,
  tasks
}: TaskSelectorProps) {
  return (
    <div className="task-context">
      <label>
        <span>{locale === "zh-CN" ? "当前任务" : "Current Task"}</span>
        <select
          aria-label={locale === "zh-CN" ? "当前任务" : "Current Task"}
          onChange={(event) => onSelect(event.target.value)}
          value={selectedTaskId ?? ""}
        >
          {tasks.map((task) => (
            <option key={task.taskId} value={task.taskId}>
              {task.title}{task.isDefault
                ? (locale === "zh-CN" ? " · 默认" : " · default")
                : ""} · {task.state}
            </option>
          ))}
        </select>
      </label>
      {selectedTask && (
        <span className={`task-state ${selectedTask.state}`}>
          {selectedTask.state}
        </span>
      )}
      <button onClick={onCreate} type="button">
        {locale === "zh-CN" ? "+ 新任务" : "+ New Task"}
      </button>
    </div>
  );
}

interface TaskCreateDialogProps {
  busy: boolean;
  criteria?: string;
  goal: string;
  locale: Locale;
  roomName: string;
  title: string;
  onClose: () => void;
  onCriteriaChange?: (value: string) => void;
  onGoalChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onTitleChange: (value: string) => void;
}

export function TaskCreateDialog({
  busy,
  criteria = "",
  goal,
  locale,
  onClose,
  onCriteriaChange,
  onGoalChange,
  onSubmit,
  onTitleChange,
  roomName,
  title
}: TaskCreateDialogProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const returnFocus = useRef(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => () => {
    const previous = returnFocus.current;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, []);
  let criteriaError: string | null = null;
  try { parseTaskCriteria(criteria, locale); } catch (reason) {
    criteriaError = reason instanceof Error ? reason.message : String(reason);
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) onClose();
    }}>
      <section
        aria-labelledby="new-task-dialog-title"
        aria-modal="true"
        className="modal-card"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]"
          )).filter((element) => element.tabIndex >= 0 && !element.closest("[hidden]") &&
            (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">#{roomName}</p>
            <h3 id="new-task-dialog-title">
              {locale === "zh-CN" ? "创建长期任务" : "Create long-lived Task"}
            </h3>
          </div>
          <button aria-label={t("cancel")} disabled={busy} onClick={onClose} type="button">×</button>
        </div>
        <p>
          {locale === "zh-CN"
            ? "后续 Run、Discussion 和本地 Agent Session 都会归属于这个任务，避免与同一房间里的其他工作串上下文。"
            : "Future Runs, Discussions, and local Agent Sessions use this Task scope instead of sharing unrelated Room work."}
        </p>
        <form className="modal-form" onSubmit={(event) => {
          if (busy || criteriaError) { event.preventDefault(); return; }
          void onSubmit(event);
        }}>
          <label htmlFor="new-task-title">
            {locale === "zh-CN" ? "任务名称" : "Task title"}
          </label>
          <input
            autoComplete="off"
            autoFocus
            id="new-task-title"
            maxLength={160}
            onChange={(event) => onTitleChange(event.target.value)}
            required
            value={title}
          />
          <label htmlFor="new-task-goal">
            {locale === "zh-CN" ? "任务目标" : "Task goal"}
          </label>
          <textarea
            id="new-task-goal"
            maxLength={20_000}
            onChange={(event) => onGoalChange(event.target.value)}
            required
            rows={4}
            value={goal}
          />
          {onCriteriaChange && <details className="task-delivery-options">
            <summary>{locale === "zh-CN" ? "交付要求（可选）" : "Delivery requirements (optional)"}</summary>
            <p>{locale === "zh-CN"
              ? "每行一条可核验的验收标准；创建后会随任务传给 Agent。填写标准不会自动完成任务。"
              : "One verifiable acceptance criterion per line, shared with the Agent. Criteria never automatically complete the Task."}</p>
            <div className="task-criteria-templates">
              <button disabled={busy} onClick={() => onCriteriaChange(appendCriteriaTemplate(criteria, locale === "zh-CN" ? [
                "结论回答任务目标，并说明适用范围。", "关键结论附有可核查的来源或证据。", "明确列出不确定性、风险和建议的下一步。"
              ] : [
                "The conclusion answers the goal and states its scope.", "Key findings include verifiable sources or evidence.", "Uncertainty, risks, and recommended next steps are explicit."
              ]))} type="button">{locale === "zh-CN" ? "+ 调研分析标准" : "+ Research criteria"}</button>
              <button disabled={busy} onClick={() => onCriteriaChange(appendCriteriaTemplate(criteria, locale === "zh-CN" ? [
                "交付内容覆盖任务目标，说明变更范围。", "提供验证步骤、结果和可核查的成果证据。", "明确列出未验证事项、已知限制和使用说明。"
              ] : [
                "The deliverable covers the goal and describes its change scope.", "Verification steps, results, and inspectable evidence are included.", "Untested areas, known limitations, and usage instructions are explicit."
              ]))} type="button">{locale === "zh-CN" ? "+ 实现验证标准" : "+ Delivery criteria"}</button>
            </div>
            <label htmlFor="new-task-criteria">{locale === "zh-CN" ? "验收标准" : "Acceptance criteria"}</label>
            <textarea aria-describedby="new-task-criteria-help" aria-invalid={criteriaError !== null} disabled={busy} id="new-task-criteria" onChange={(event) => onCriteriaChange(event.target.value)} rows={4} value={criteria} />
            <small id="new-task-criteria-help">{locale === "zh-CN" ? "最多 100 条，每条最多 2,000 字符。参考标准只会追加，不会覆盖已有内容。" : "Up to 100 criteria, 2,000 characters each. Templates append without replacing your text."}</small>
            {criteriaError && <p role="alert">{criteriaError}</p>}
          </details>}
          <div className="modal-actions">
            <button className="secondary-action" disabled={busy} onClick={onClose} type="button">{t("cancel")}</button>
            <button className="primary-action" disabled={busy || !title.trim() || !goal.trim() || criteriaError !== null}>
              {busy
                ? (locale === "zh-CN" ? "创建中…" : "Creating…")
                : (locale === "zh-CN" ? "创建并切换" : "Create and switch")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
