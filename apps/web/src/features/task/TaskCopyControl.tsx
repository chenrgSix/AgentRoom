import React, { useEffect, useRef, useState } from "react";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { captureWebSessionScope, HttpRequestError, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import { PanelDialog } from "../navigation/PanelDialog.js";

export function copyTaskDefinition(source: TaskProjection, locale: Locale) {
  const suffix = locale === "zh-CN" ? "（副本）" : " (copy)";
  return {
    title: source.title.slice(0, 160 - suffix.length) + suffix,
    goal: source.goal,
    completionPolicy: source.completionPolicy,
    lifecycleState: "draft" as const,
    criteria: source.criteria.toSorted((a, b) => a.ordinal - b.ordinal).map((criterion, index) => ({
      criterionKey: `criterion_copy_${String(index + 1).padStart(8, "0")}`,
      description: criterion.description, required: criterion.required, ordinal: index + 1
    }))
  };
}

export function TaskCopyControl({ task, locale, token, roomName, onCreated }: {
  task: TaskProjection; locale: Locale; token: string | undefined; roomName: string;
  onCreated: (task: TaskProjection) => void;
}) {
  const key = JSON.stringify([task.taskId, token]);
  const current = useRef(key); current.current = key;
  const request = useRef<AbortController | null>(null);
  const nextCriterion = useRef(101);
  const [source, setSource] = useState<TaskProjection | null>(null);
  const [draft, setDraft] = useState(() => copyTaskDefinition(task, locale));
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  useEffect(() => () => { request.current?.abort(); }, [key]);
  const close = () => { if (!request.current) setSource(null); };
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!source || request.current || unknown) return;
    const controller = new AbortController(); request.current = controller;
    const validSession = captureWebSessionScope();
    const valid = () => current.current === key && !controller.signal.aborted && validSession();
    setBusy(true); setError(null);
    let submitted = false;
    try {
      const fresh = await jsonRequest<TaskProjection>(`/api/tasks/${source.taskId}`, { signal: controller.signal }, token);
      if (!valid()) return;
      if (fresh.taskId !== source.taskId || fresh.roomId !== source.roomId || fresh.definitionRevision !== source.definitionRevision || fresh.criteriaRevision !== source.criteriaRevision) {
        setError(t("原任务定义已变化，请关闭后重新复制，再检查目标与标准。", "The source definition changed. Close and copy again to review the goal and criteria."));
        return;
      }
      const payload = { ...draft, title: draft.title.trim(), goal: draft.goal.trim(), criteria: draft.criteria.map((criterion, index) => ({ ...criterion, description: criterion.description.trim(), ordinal: index + 1 })) };
      submitted = true;
      const created = await jsonRequest<TaskProjection>(`/api/rooms/${source.roomId}/tasks`, { method: "POST", body: JSON.stringify(payload), signal: controller.signal }, token);
      if (!valid()) return;
      setSource(null);
      onCreated(created);
    } catch (reason) {
      if (!valid()) return;
      const uncertain = submitted && (!(reason instanceof HttpRequestError) || reason.status >= 500);
      setUnknown(uncertain);
      setError(uncertain
        ? t("尚未确认创建结果。请关闭窗口，到工作台查找新草稿后再决定是否重新创建。", "Creation is unconfirmed. Close this dialog and check Work for the new draft before creating another.")
        : t("无法创建草稿，请检查内容和房间访问权限后重试。", "Cannot create the draft. Check the fields and Room access, then retry."));
    } finally { if (request.current === controller) request.current = null; if (valid()) setBusy(false); }
  }
  const invalid = !draft.title.trim() || draft.title.length > 160 || !draft.goal.trim() || draft.goal.length > 20_000 || draft.criteria.some((criterion) => !criterion.description.trim() || criterion.description.length > 2000);
  function updateCriterion(index: number, patch: Partial<typeof draft.criteria[number]>) {
    setDraft((value) => ({ ...value, criteria: value.criteria.map((criterion, i) => i === index ? { ...criterion, ...patch } : criterion) }));
  }
  return <>
    <button className="work-inline-link" type="button" onClick={() => { setSource(task); setDraft(copyTaskDefinition(task, locale)); setUnknown(false); setError(null); }}>{t("复制为草稿", "Copy as draft")}</button>
    {source && <PanelDialog title={t("复制任务为新草稿", "Copy Task into a new draft")} locale={locale} onClose={close} error={error}>
      <p>{t(`来源 TASK-${source.taskDisplayNumber} · 房间 ${roomName}`, `Source TASK-${source.taskDisplayNumber} · Room ${roomName}`)}</p>
      <p>{t("确认目标和标准后创建。执行者需要重新选择；运行记录、结果和授权不会复制。", "Review the goal and criteria before creating. Choose execution Agents separately; history, Results and grants are not copied.")}</p>
      <form className="modal-form" onSubmit={(event) => { if (invalid) event.preventDefault(); else void create(event); }}>
        <label>{t("任务标题", "Task title")}<input disabled={busy || unknown} required maxLength={160} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>{t("任务目标", "Task goal")}<textarea disabled={busy || unknown} required maxLength={20_000} rows={4} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label>
        <p>{t("完成条件", "Completion policy")}: {source.completionPolicy === "accepted_result_required" ? t("必须接受结果", "Accepted Result required") : t("负责人确认", "Owner confirmation")}</p>
        <fieldset disabled={busy || unknown} className="task-copy-criteria"><legend>{t("验收标准", "Acceptance criteria")}</legend>
          {draft.criteria.map((criterion, index) => <div key={criterion.criterionKey}>
            <label>{t(`标准 ${index + 1}`, `Criterion ${index + 1}`)}<textarea required maxLength={2000} value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} /></label>
            <label><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />{t(`标准 ${index + 1} 必需`, `Criterion ${index + 1} required`)}</label>
            <button type="button" className="work-inline-link" onClick={() => setDraft({ ...draft, criteria: draft.criteria.filter((_, i) => i !== index) })}>{t(`移除标准 ${index + 1}`, `Remove criterion ${index + 1}`)}</button>
          </div>)}
          <button type="button" disabled={draft.criteria.length >= 100} onClick={() => setDraft({ ...draft, criteria: [...draft.criteria, { criterionKey: `criterion_copy_${String(nextCriterion.current++).padStart(8, "0")}`, description: "", required: true, ordinal: draft.criteria.length + 1 }] })}>{t("添加标准", "Add criterion")}</button>
        </fieldset>
        <div className="modal-actions"><button className="secondary-action" disabled={busy} type="button" onClick={close}>{t("取消", "Cancel")}</button><button className="primary-action" disabled={busy || unknown || invalid} type="submit">{busy ? t("正在创建…", "Creating…") : t("创建新草稿", "Create new draft")}</button></div>
      </form>
    </PanelDialog>}
  </>;
}
