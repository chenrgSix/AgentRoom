import type { FormEvent } from "react";

import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { AgentTask } from "../../models.js";

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
  goal: string;
  locale: Locale;
  roomName: string;
  title: string;
  onClose: () => void;
  onGoalChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onTitleChange: (value: string) => void;
}

export function TaskCreateDialog({
  busy,
  goal,
  locale,
  onClose,
  onGoalChange,
  onSubmit,
  onTitleChange,
  roomName,
  title
}: TaskCreateDialogProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) onClose();
    }}>
      <section
        aria-labelledby="new-task-dialog-title"
        aria-modal="true"
        className="modal-card"
        role="dialog"
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
        <form className="modal-form" onSubmit={(event) => void onSubmit(event)}>
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
            {locale === "zh-CN" ? "目标与完成口径" : "Goal and completion criteria"}
          </label>
          <textarea
            id="new-task-goal"
            maxLength={20_000}
            onChange={(event) => onGoalChange(event.target.value)}
            required
            rows={4}
            value={goal}
          />
          <div className="modal-actions">
            <button className="secondary-action" disabled={busy} onClick={onClose} type="button">{t("cancel")}</button>
            <button className="primary-action" disabled={busy || !title.trim() || !goal.trim()}>
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
