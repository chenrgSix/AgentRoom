import React, { useMemo, useState } from "react";
import type { ExecutionPlanDefinition } from "@convene-wire/contracts/execution-plan";
import type { Locale } from "../../i18n.js";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const budget = (value: unknown) => record(value) && typeof value.maxRunAttempts === "number" && typeof value.maxExecutionDurationSeconds === "number";

/** Checks only fields the form reads. Full contract and authority validation remain on Server. */
export function commonPlanDefinition(text: string): ExecutionPlanDefinition | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value) || typeof value.title !== "string" || !record(value.policy) || typeof value.policy.maxConcurrency !== "number" || !budget(value.policy.budget) ||
      !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 64 || !value.nodes.every((node: unknown) => record(node) &&
        typeof node.nodeKey === "string" && typeof node.agentId === "string" && budget(node.budget) && record(node.task) &&
        ((node.task.mode === "new" && typeof node.task.title === "string" && typeof node.task.goal === "string") ||
         (node.task.mode === "existing" && typeof node.task.taskId === "string")))) return null;
    return value as unknown as ExecutionPlanDefinition;
  } catch { return null; }
}

export function PlanDefinitionEditor({ text, onChange, agentNames, locale, disabled }: {
  text: string; onChange: (text: string) => void; agentNames: ReadonlyMap<string, string>; locale: Locale; disabled: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const definition = useMemo(() => commonPlanDefinition(text), [text]);
  const t = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  function update(change: (value: ExecutionPlanDefinition) => void) {
    if (!definition) return;
    const next = structuredClone(definition); change(next); onChange(JSON.stringify(next, null, 2));
  }
  function numberField(label: string, value: number, maximum: number, change: (value: ExecutionPlanDefinition, number: number) => void) {
    return <label>{label}<input type="number" required min={1} max={maximum} step={1} value={value === 0 ? "" : value} onChange={(event) => update((next) => change(next, Number(event.target.value)))} /></label>;
  }
  return <fieldset disabled={disabled} className="work-plan-common-editor">
    <legend>{t("计划内容", "Plan content")}</legend>
    <button className="work-inline-link" type="button" onClick={(event) => {
      if (!advanced && event.currentTarget.form && !event.currentTarget.form.reportValidity()) return;
      setAdvanced(!advanced);
    }}>{advanced ? t("常用字段", "Common fields") : t("高级 JSON", "Advanced JSON")}</button>
    {advanced ? <label>{t("完整计划定义 JSON", "Complete plan definition JSON")}<textarea aria-label={t("完整计划定义 JSON", "Complete plan definition JSON")} spellCheck={false} value={text} onChange={(event) => onChange(event.target.value)} /></label>
      : !definition ? <p role="alert">{t("JSON 中的常用字段暂时无法显示，请切换高级 JSON 检查内容。", "The common fields cannot be displayed. Open Advanced JSON to check the content.")}</p>
      : <>
        <label>{t("计划标题", "Plan title")}<input required maxLength={160} value={definition.title} onChange={(event) => update((next) => { next.title = event.target.value; })} /></label>
        <div className="work-plan-budget-fields">
          {numberField(t("最大并发", "Max concurrency"), definition.policy.maxConcurrency, 8, (next, number) => { next.policy.maxConcurrency = number; })}
          {numberField(t("计划最多尝试次数", "Plan attempt budget"), definition.policy.budget.maxRunAttempts, 1000, (next, number) => { next.policy.budget.maxRunAttempts = number; })}
          {numberField(t("计划执行预算（秒）", "Plan execution budget (seconds)"), definition.policy.budget.maxExecutionDurationSeconds, 2_592_000, (next, number) => { next.policy.budget.maxExecutionDurationSeconds = number; })}
        </div>
        {definition.nodes.map((node, index) => <fieldset key={`${node.nodeKey}:${index}`}><legend>{t("节点", "Node")} · {node.nodeKey}</legend>
          {node.task.mode === "new" ? <>
            <label>{t(`任务标题 · ${node.nodeKey}`, `Task title · ${node.nodeKey}`)}<input required maxLength={160} value={node.task.title!} onChange={(event) => update((next) => { next.nodes[index]!.task.title = event.target.value; })} /></label>
            <label>{t(`任务目标 · ${node.nodeKey}`, `Task goal · ${node.nodeKey}`)}<textarea required maxLength={20_000} rows={4} value={node.task.goal!} onChange={(event) => update((next) => { next.nodes[index]!.task.goal = event.target.value; })} /></label>
          </> : <p>{t("引用已有任务", "Linked existing Task")}: {node.task.taskId}</p>}
          <label>{t(`执行者 · ${node.nodeKey}`, `Execution Agent · ${node.nodeKey}`)}<select value={node.agentId} onChange={(event) => update((next) => { next.nodes[index]!.agentId = event.target.value; })}>
            {!agentNames.has(node.agentId) && <option value={node.agentId}>{t("当前执行者暂不可选", "Current Agent unavailable")} · {node.agentId}</option>}
            {[...agentNames].map(([id, name]) => <option key={id} value={id}>{name} · {id}</option>)}
          </select></label>
          <div className="work-plan-budget-fields">
            {numberField(t(`最多尝试次数 · ${node.nodeKey}`, `Attempt budget · ${node.nodeKey}`), node.budget.maxRunAttempts, 1000, (next, number) => { next.nodes[index]!.budget.maxRunAttempts = number; })}
            {numberField(t(`执行预算（秒） · ${node.nodeKey}`, `Execution budget (seconds) · ${node.nodeKey}`), node.budget.maxExecutionDurationSeconds, 2_592_000, (next, number) => { next.nodes[index]!.budget.maxExecutionDurationSeconds = number; })}
          </div>
        </fieldset>)}
        <p>{t("提交后生成新修订，确认差异后可单独审批。更换执行者后仍需通过其任务与仓库授权检查。", "Submitting creates a new revision for separate review. A changed Agent must still pass Task and repository authorization checks.")}</p>
      </>}
  </fieldset>;
}
