import type { LifecycleState } from "@convene-wire/contracts/task-result";

import type { WorkspaceView } from "../../models.js";
import type { TaskWorkDetailTab } from "../work/TaskWorkDetail.js";

/** Untrusted location intent only; App must resolve every resource against current access. */
export interface WorkspaceNavigation {
  teamId?: string | undefined;
  roomId?: string | undefined;
  taskId?: string | undefined;
  workTaskId?: string | undefined;
  view?: WorkspaceView | undefined;
  tab?: TaskWorkDetailTab | undefined;
  runId?: string | undefined;
  scope?: "mine" | "team" | undefined;
  lifecycleState?: LifecycleState | undefined;
  ownerMemberId?: string | undefined;
  search?: string | undefined;
}

const views: Record<WorkspaceView, true> = {
  work: true, room: true, agents: true, devices: true, members: true, security: true
};

export function isManagementView(view: WorkspaceView): boolean {
  return view !== "work" && view !== "room";
}
const tabs: Record<TaskWorkDetailTab, true> = {
  overview: true, plan: true, evidence: true, runs: true, results: true, artifacts: true,
  discussion: true, audit: true
};
const states: Record<LifecycleState, true> = {
  draft: true, ready: true, active: true, review: true, completed: true, canceled: true
};
const memberOf = (values: object) => (value: string) => Object.hasOwn(values, value);
// Keep these type-specific prefixes and suffix limits aligned with identifiers.schema.json.
const identifier = (prefix: string) => {
  const pattern = new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,128}$`, "u");
  // Require a whole-string match: '$' alone also matches before a final newline.
  return (value: string) => pattern.exec(value)?.[0] === value;
};

interface Field {
  key: string;
  property: keyof WorkspaceNavigation;
  label: string;
  valid: (value: string) => boolean;
}

const fields: readonly Field[] = [
  { key: "team", property: "teamId", label: "团队", valid: identifier("team") },
  { key: "room", property: "roomId", label: "房间", valid: identifier("room") },
  { key: "task", property: "taskId", label: "房间任务", valid: identifier("task") },
  { key: "workTask", property: "workTaskId", label: "工作任务", valid: identifier("task") },
  { key: "view", property: "view", label: "工作区视图", valid: memberOf(views) },
  { key: "tab", property: "tab", label: "任务页签", valid: memberOf(tabs) },
  { key: "run", property: "runId", label: "运行", valid: identifier("run") },
  { key: "scope", property: "scope", label: "工作范围", valid: memberOf({ mine: true, team: true }) },
  { key: "state", property: "lifecycleState", label: "任务状态", valid: memberOf(states) },
  { key: "owner", property: "ownerMemberId", label: "任务负责人", valid: identifier("member") },
  { key: "search", property: "search", label: "搜索词", valid: (value) => [...value].length <= 100 }
];

function normalizedValue(field: Field, value: string): string {
  return field.property === "search" ? value.trim() : value;
}

function invalidField(field: Field): string {
  return field.property === "search" ? "链接中的搜索词不能超过 100 个字符。" : `链接中的${field.label}参数无效。`;
}

function conflictingIntent(navigation: WorkspaceNavigation): string | null {
  if (navigation.taskId && navigation.workTaskId) return "链接不能同时指定房间任务和工作任务。";
  if (navigation.view && navigation.view !== "work" && (navigation.workTaskId || navigation.tab || navigation.runId)) {
    return "链接中的工作任务、页签或运行与工作区视图不匹配。";
  }
  if (navigation.view && navigation.view !== "room" && navigation.taskId) return "链接中的房间任务与工作区视图不匹配。";
  if ((navigation.tab || navigation.runId) && !navigation.workTaskId) return "链接中的页签或运行缺少工作任务。";
  return null;
}

/** Accepts location.search (or its query without '?'); no Team/default view is inferred. */
export function parseWorkspaceNavigation(search: string): { navigation: WorkspaceNavigation | null; error: string | null } {
  const query = search.startsWith("?") ? search.slice(1) : search;
  // Bound the raw query, including unknown parameters, before decoding it.
  if (query.length > 2048) return { navigation: null, error: "链接参数过长，最多允许 2048 个字符。" };
  const navigation: WorkspaceNavigation = {};
  const seen = new Set<string>();
  for (const part of query.split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent((separator < 0 ? part : part.slice(0, separator)).replace(/\+/gu, " "));
      value = decodeURIComponent((separator < 0 ? "" : part.slice(separator + 1)).replace(/\+/gu, " "));
    } catch {
      return { navigation: null, error: "链接参数编码无效。" };
    }
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    if (seen.has(key)) return { navigation: null, error: `链接中的${field.label}参数重复。` };
    seen.add(key);
    value = normalizedValue(field, value);
    if (!field.valid(value)) return { navigation: null, error: invalidField(field) };
    if (field.property === "search" && !value) continue;
    (navigation as Record<string, string>)[field.property] = value;
  }
  const error = conflictingIntent(navigation);
  return { navigation: error || !Object.keys(navigation).length ? null : navigation, error };
}

/** Returns only '?query' (or ''), never origin/path/hash or unknown/sensitive fields. */
export function workspaceNavigationUrl(navigation: WorkspaceNavigation): string {
  const conflict = conflictingIntent(navigation);
  if (conflict) throw new Error(conflict);
  const params = new URLSearchParams();
  for (const field of fields) {
    const candidate = navigation[field.property];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") throw new Error(invalidField(field));
    const value = normalizedValue(field, candidate);
    if (!field.valid(value)) throw new Error(invalidField(field));
    if (field.property === "search" && !value) continue;
    params.set(field.key, value);
  }
  const query = params.toString();
  if (query.length > 2048) throw new Error("链接参数过长，最多允许 2048 个字符。");
  return query ? `?${query}` : "";
}
