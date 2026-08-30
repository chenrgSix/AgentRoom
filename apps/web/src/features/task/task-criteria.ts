import type { TaskProjection } from "@convene-wire/contracts/task-result";

import type { Locale } from "../../i18n.js";

export function parseTaskCriteria(value: string, locale: Locale = "en"): TaskProjection["criteria"] {
  const descriptions = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (descriptions.length > 100) {
    throw new Error(locale === "zh-CN" ? "验收标准最多 100 条。" : "Use at most 100 acceptance criteria.");
  }
  if (descriptions.some((description) => description.length > 2000)) {
    throw new Error(locale === "zh-CN" ? "每条验收标准最多 2,000 个字符。" : "Each acceptance criterion must be at most 2,000 characters.");
  }
  return descriptions.map((description, index) => ({
    criterionKey: `criterion_web_${String(index + 1).padStart(8, "0")}`,
    description,
    required: true,
    ordinal: index + 1
  }));
}

export function appendCriteriaTemplate(value: string, template: string[]): string {
  const existing = new Set(value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  return [value.trim(), ...template.filter((line) => !existing.has(line))].filter(Boolean).join("\n");
}
