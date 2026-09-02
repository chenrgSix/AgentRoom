export interface PlanDiffEntry {
  kind: "added" | "removed" | "changed";
  path: string;
  before?: unknown;
  after?: unknown;
}

const maximumEntries = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function segment(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

export function diffPlanDefinitions(
  before: unknown,
  after: unknown
): PlanDiffEntry[] {
  const entries: PlanDiffEntry[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (entries.length >= maximumEntries || Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length && entries.length < maximumEntries; index += 1) {
        const next = `${path}[${index}]`;
        if (index >= left.length) entries.push({ kind: "added", path: next, after: right[index] });
        else if (index >= right.length) entries.push({ kind: "removed", path: next, before: left[index] });
        else visit(left[index], right[index], next);
      }
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        if (entries.length >= maximumEntries) break;
        const next = `${path}${segment(key)}`;
        if (!Object.hasOwn(left, key)) entries.push({ kind: "added", path: next, after: right[key] });
        else if (!Object.hasOwn(right, key)) entries.push({ kind: "removed", path: next, before: left[key] });
        else visit(left[key], right[key], next);
      }
      return;
    }
    entries.push({ kind: "changed", path, before: left, after: right });
  };
  visit(before, after, "$plan");
  return entries;
}

export function displayPlanDiffValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return "undefined";
  return rendered.length > 240 ? `${rendered.slice(0, 237)}...` : rendered;
}
