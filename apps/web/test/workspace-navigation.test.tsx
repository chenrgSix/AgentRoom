import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseWorkspaceNavigation, workspaceNavigationUrl, type WorkspaceNavigation
} from "../src/features/navigation/workspace-navigation.js";

const complete: WorkspaceNavigation = {
  teamId: "team_01234567", roomId: "room_01234567", workTaskId: "task_abcdefgh",
  view: "work", tab: "runs", runId: "run_01234567", scope: "team", lifecycleState: "review",
  ownerMemberId: "member_01234567", search: "检查 fix & #1"
};

function rejected(query: string, expected: RegExp): void {
  const result = parseWorkspaceNavigation(query);
  assert.equal(result.navigation, null);
  assert.match(result.error ?? "", expected);
}

test("navigation preserves the allowlisted intent and emits only a canonical query", () => {
  const query = workspaceNavigationUrl(complete);
  assert.ok(query.startsWith("?team="));
  assert.equal(query.includes("#"), false);
  assert.deepEqual(parseWorkspaceNavigation(query), { navigation: complete, error: null });
  assert.deepEqual(parseWorkspaceNavigation(query.slice(1)), { navigation: complete, error: null });
  const current = new URL(`/subpath/${query}`, "https://example.invalid");
  assert.equal(current.pathname, "/subpath/");
  assert.equal(current.searchParams.get("search"), complete.search);
  assert.equal(workspaceNavigationUrl({}), "");
});

test("empty queries have no intent and legacy workTask links do not need a Team", () => {
  for (const query of ["", "?", "?&&", "?unknown=safe", "?search=+++"]) {
    assert.deepEqual(parseWorkspaceNavigation(query), { navigation: null, error: null });
  }
  assert.deepEqual(parseWorkspaceNavigation("?workTask=task_abcdefgh"), {
    navigation: { workTaskId: "task_abcdefgh" }, error: null
  });
  assert.deepEqual(parseWorkspaceNavigation("?view=agents"), { navigation: { view: "agents" }, error: null });
  assert.deepEqual(parseWorkspaceNavigation("?task=task_01234567"), { navigation: { taskId: "task_01234567" }, error: null });
});

test("unknown sensitive parameters are never returned or serialized", () => {
  const secret = "DO_NOT_LEAK_CREDENTIAL";
  const parsed = parseWorkspaceNavigation(`?workTask=task_abcdefgh&token=${secret}&draft=${secret}&receipt=${secret}&__proto__=${secret}`);
  assert.deepEqual(parsed, { navigation: { workTaskId: "task_abcdefgh" }, error: null });
  assert.equal(workspaceNavigationUrl({ ...complete, token: secret, draft: secret } as WorkspaceNavigation), workspaceNavigationUrl(complete));
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  const invalid = parseWorkspaceNavigation(`?team=${secret}`);
  assert.match(invalid.error ?? "", /团队参数无效/u);
  assert.equal(JSON.stringify(invalid).includes(secret), false);
});

test("each known query key rejects duplicate and encoded aliases without accepting partial intent", () => {
  const valid = new URLSearchParams(workspaceNavigationUrl(complete));
  valid.set("task", "task_01234567");
  for (const [key, value] of valid) {
    const encodedKey = `%${key.charCodeAt(0).toString(16)}${key.slice(1)}`;
    rejected(`?view=work&${key === "view" ? "room=room_01234567" : `${key}=${encodeURIComponent(value)}`}&${encodedKey}=${encodeURIComponent(value)}`, /参数重复/u);
  }
  assert.deepEqual(parseWorkspaceNavigation("?unknown=1&unknown=2&view=room"), { navigation: { view: "room" }, error: null });
  rejected("?search=&search=", /搜索词参数重复/u);
});

test("ID validation matches the authoritative typed prefix and suffix boundaries", () => {
  const schema = JSON.parse(readFileSync(new URL("../../../packages/contracts/schemas/common/identifiers.schema.json", import.meta.url), "utf8"));
  const identifiers = [
    ["team", "teamId"], ["room", "roomId"], ["task", "taskId"], ["workTask", "taskId"],
    ["run", "runId"], ["owner", "memberId"]
  ] as const;
  for (const [key, definition] of identifiers) {
    const prefix = definition.slice(0, -2);
    const contract = new RegExp(schema.$defs[definition].pattern, "u");
    for (const suffix of ["a".repeat(7), "A0_-abcd", "z".repeat(128), "a".repeat(129), "你好你好你好你好", "abcdefgh/"]) {
      const value = `${prefix}_${suffix}`;
      const context = key === "run" ? "&workTask=task_01234567" : "";
      assert.equal(parseWorkspaceNavigation(`?${key}=${encodeURIComponent(value)}${context}`).error === null, contract.test(value), `${key} boundary`);
    }
    rejected(`?${key}=agent_01234567`, /参数无效/u);
    rejected(`?${key}=`, /参数无效/u);
    rejected(`?${key}=${prefix}_abcdefgh%0A`, /参数无效/u);
  }
});

test("only current view, tab, scope and lifecycle values are allowed", () => {
  for (const [key, values] of Object.entries({
    view: ["work", "room", "agents", "members"],
    tab: ["overview", "plan", "runs", "results", "artifacts", "discussion", "audit"],
    scope: ["mine", "team"], state: ["draft", "ready", "active", "review", "completed", "canceled"]
  })) {
    for (const value of values) assert.equal(parseWorkspaceNavigation(`?${key}=${value}${key === "tab" ? "&workTask=task_01234567" : ""}`).error, null);
    for (const value of ["", "unknown", "constructor", "toString", values[0]!.toUpperCase()]) rejected(`?${key}=${value}`, /参数无效/u);
  }
});

test("search is trimmed and bounded by Unicode code points without splitting supplementary characters", () => {
  const search = "😀".repeat(100);
  assert.deepEqual(parseWorkspaceNavigation(`?search=${encodeURIComponent(`  ${search}  `)}`), { navigation: { search }, error: null });
  assert.deepEqual(parseWorkspaceNavigation(workspaceNavigationUrl({ search: ` ${search} ` })), { navigation: { search }, error: null });
  rejected(`?search=${encodeURIComponent("😀".repeat(101))}`, /100 个字符/u);
  assert.throws(() => workspaceNavigationUrl({ search: "😀".repeat(101) }), /100 个字符/u);
  assert.equal(workspaceNavigationUrl({ search: "  " }), "");
  assert.equal(parseWorkspaceNavigation("?search=a+b%2Bc").navigation?.search, "a b+c");
});

test("raw query length is bounded before ignoring unknown parameters and malformed encodings fail closed", () => {
  const atLimit = `view=work&unknown=${"x".repeat(2048 - "view=work&unknown=".length)}`;
  assert.equal(atLimit.length, 2048);
  assert.deepEqual(parseWorkspaceNavigation(`?${atLimit}`), { navigation: { view: "work" }, error: null });
  rejected(`?${atLimit}x`, /2048 个字符/u);
  for (const query of ["?view=work&search=%", "?view=work&search=%FF", "?%ZZ=1", "?search=%ED%A0%80"]) rejected(query, /编码无效/u);
  const suffix = "a".repeat(128);
  const longest: WorkspaceNavigation = {
    ...complete, teamId: `team_${suffix}`, roomId: `room_${suffix}`,
    workTaskId: `task_${suffix}`, runId: `run_${suffix}`, ownerMemberId: `member_${suffix}`, search: "😀".repeat(100)
  };
  const query = workspaceNavigationUrl(longest);
  assert.ok(query.slice(1).length <= 2048);
  assert.deepEqual(parseWorkspaceNavigation(query), { navigation: longest, error: null });
});

test("serializer validates runtime values, strips only empty search and never mutates its input", () => {
  const navigation = Object.freeze({ ...complete, search: "  inspect  " });
  assert.equal(parseWorkspaceNavigation(workspaceNavigationUrl(navigation)).navigation?.search, "inspect");
  assert.equal(navigation.search, "  inspect  ");
  assert.throws(() => workspaceNavigationUrl({ view: "admin" } as unknown as WorkspaceNavigation), /视图参数无效/u);
  assert.throws(() => workspaceNavigationUrl({ ownerMemberId: "" }), /负责人参数无效/u);
  assert.throws(() => workspaceNavigationUrl({ search: 123 } as unknown as WorkspaceNavigation), /搜索词/u);
  assert.equal(workspaceNavigationUrl({ ...complete, workTaskId: undefined, tab: undefined, runId: undefined }).includes("workTask"), false);
});

test("conflicting Task surfaces and ownerless tab or Run intent fail closed", () => {
  const conflicts: Array<[WorkspaceNavigation, RegExp]> = [
    [{ taskId: "task_01234567", workTaskId: "task_abcdefgh" }, /不能同时/u],
    [{ taskId: "task_01234567", workTaskId: "task_01234567" }, /不能同时/u],
    [{ view: "room", workTaskId: "task_01234567" }, /不匹配/u],
    [{ view: "agents", workTaskId: "task_01234567", tab: "runs" }, /不匹配/u],
    [{ view: "members", runId: "run_01234567" }, /不匹配/u],
    [{ view: "work", taskId: "task_01234567" }, /不匹配/u],
    [{ view: "agents", taskId: "task_01234567" }, /不匹配/u],
    [{ tab: "results" }, /缺少工作任务/u],
    [{ runId: "run_01234567" }, /缺少工作任务/u]
  ];
  const keys: Record<string, string> = { taskId: "task", workTaskId: "workTask", runId: "run" };
  for (const [navigation, error] of conflicts) {
    const query = new URLSearchParams(Object.entries(navigation).map(([key, value]) => [keys[key] ?? key, String(value)]));
    rejected(`?${query}`, error);
    assert.throws(() => workspaceNavigationUrl(navigation), error);
  }
});
