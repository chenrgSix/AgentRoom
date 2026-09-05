import type { AttentionElement, Priority } from "@convene-wire/contracts/task-result";

export const attentionFilters: ReadonlyArray<{ value: AttentionElement; zh: string; en: string }> = [
  { value: "needs_input", zh: "待输入", en: "Needs input" },
  { value: "needs_approval", zh: "待审核", en: "Needs review" },
  { value: "blocked", zh: "已阻塞", en: "Blocked" },
  { value: "outcome_unknown", zh: "结果未知", en: "Unknown outcome" },
  { value: "result_stale", zh: "结果过期", en: "Stale Result" },
  { value: "overdue", zh: "已逾期", en: "Overdue" },
  { value: "paused", zh: "已暂停", en: "Paused" },
  { value: "budget_exhausted", zh: "预算用尽", en: "Budget exhausted" },
  { value: "runtime_unavailable", zh: "运行时不可用", en: "Runtime unavailable" },
  { value: "result_rejected", zh: "结果被拒绝", en: "Result rejected" }
];

export interface WorkFilters {
  attention?: AttentionElement | "" | undefined;
  filterRoomId?: string | undefined;
  filterAgentId?: string | undefined;
  priority?: Priority | "" | undefined;
}
