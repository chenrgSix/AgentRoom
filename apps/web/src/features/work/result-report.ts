import type { ResultProjection, TaskProjection } from "@convene-wire/contracts/task-result";
import type { Locale } from "../../i18n.js";
import { workspaceNavigationUrl } from "../navigation/workspace-navigation.js";

// Report structure comes from the application. Submitted prose remains quoted text.
function literal(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/[\\`*_{}\[\]#!|~]/gu, "\\$&");
}
const quoted = (value: string) => literal(value).split(/\r?\n/u).map((line) => `> ${line}`).join("\n");

export function resultReport(task: TaskProjection, result: ResultProjection, locale: Locale, origin: string): string {
  if (result.taskId !== task.taskId || result.roomId !== task.roomId) throw new Error("Result scope mismatch");
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid report origin");
  const t = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const stale = result.proposal.definitionRevision !== task.definitionRevision || result.proposal.criteriaRevision !== task.criteriaRevision;
  const link = (tab: "results" | "artifacts" | "runs" | "discussion" | "overview", runId?: string) => new URL(`/${workspaceNavigationUrl({
    teamId: task.teamId, roomId: task.roomId, workTaskId: task.taskId, view: "work", tab, ...(runId ? { runId } : {})
  })}`, base.origin).href;
  const empty = t("无", "None");
  const lines = [
    `# TASK-${task.taskDisplayNumber} · ${literal(task.title)} · Result v${result.resultVersion}`,
    "", `[${t("打开任务结果", "Open Task Results")}](${link("results")})`, "",
    `- Task: ${literal(task.taskId)}`,
    `- Result: ${literal(result.resultId)}`,
    `- ${t("结果状态", "Result state")}: ${result.state}`,
    `- ${t("提议者结论", "Proposer outcome")}: ${result.proposal.outcome}`,
    `- ${t("提议时间", "Proposed at")}: ${result.proposedAt}`,
    `- ${t("提议者类型", "Proposed by")}: ${result.proposedBy.kind}`,
    `- ${t("定义 / 标准版本", "Definition / criteria revision")}: ${result.proposal.definitionRevision} / ${result.proposal.criteriaRevision}`,
    `- ${t("与当前任务比较", "Compared with current Task")}: ${stale ? t("旧版本结果", "Stale Result") : t("版本匹配", "Current revisions")}`,
    `- ${t("任务状态", "Task state")}: ${task.lifecycleState}`,
    `- ${t("作为任务完成依据", "Task completion Result")}: ${task.completionResultId === result.resultId ? t("是", "Yes") : t("否", "No")}`,
    "", `## ${t("结果摘要（提议者内容）", "Summary (proposer content)")}`, "", quoted(result.proposal.summary),
    "", `## ${t("人类审核", "Human review")}`, "",
    ...(result.review ? [
      `- ${t("决定", "Decision")}: ${result.review.decision}`,
      `- ${t("审核者", "Reviewer")}: ${literal(result.review.reviewedByMemberId)}`,
      `- ${t("时间 / 审核版本", "Time / review revision")}: ${result.review.reviewedAt} / ${result.review.reviewRevision}`,
      "", quoted(result.review.reason)
    ] : [t("尚无人类审核记录。", "No human review is recorded.")]),
    "", `## ${t("当前任务验收标准", "Current Task criteria")} · r${task.criteriaRevision}`, "",
    task.criteria.length ? task.criteria.toSorted((a, b) => a.ordinal - b.ordinal).map((criterion) =>
      `### ${literal(criterion.criterionKey)} · ${criterion.required ? t("必需", "Required") : t("可选", "Optional")}\n\n${quoted(criterion.description)}`).join("\n\n") : empty,
    "", `## ${t("结果中的标准声明", "Criterion claims in this Result")}`, "",
    result.proposal.criterionClaims.length ? result.proposal.criterionClaims.map((claim) =>
      `### ${literal(claim.criterionKey)} · ${claim.coverage}\n\n${quoted(claim.explanation)}\n\n${t("引用", "References")}: ${claim.evidenceRefIds.map(literal).join(", ") || empty}`).join("\n\n") : empty,
    "", `## ${t("证据引用", "Evidence references")}`, "",
    ...result.proposal.sources.map((source) => {
      const id = source.artifactId ?? source.runId ?? source.messageId ?? source.memoryId ?? source.discussionId ?? source.evidenceRefId;
      const tab = source.kind === "artifact" ? "artifacts" : source.kind === "run_event" ? "runs" : source.kind === "discussion" ? "discussion" : "overview";
      return `- ${literal(source.evidenceRefId)} · ${source.kind} · ${literal(id)}${source.sequence ? ` #${source.sequence}` : ""} · [${t("查看任务内来源", "Inspect source in Task")}](${link(tab, source.kind === "run_event" ? source.runId : undefined)})`;
    }),
    "", t("引用保留来源身份；引用存在不代表内容已核验。此报告未载入独立验证或仓库集成回执，请在任务证据页核查。", "References preserve source identities; a reference does not establish verified content. This report does not load independent verification or repository integration receipts; inspect the Task Evidence tab."),
    ...([[t("风险", "Risks"), result.proposal.risks], [t("开放问题", "Open questions"), result.proposal.openQuestions],
      [t("建议后续行动", "Proposed next actions"), result.proposal.nextActions.map((action) => action.description)]] as const)
      .flatMap(([heading, entries]) => ["", `## ${heading}`, "", entries.length ? entries.map(quoted).join("\n\n") : empty]),
    "", t("报告是导出时的快照；来源链接仍需要相应访问权限。", "This report is an export-time snapshot. Source links still require access."), ""
  ];
  return lines.join("\n");
}
