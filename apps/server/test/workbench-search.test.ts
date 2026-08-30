import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { TaskProjection, WorkbenchPage } from "@convene-wire/contracts/task-result";

import { createServerApp } from "../src/app.js";
import { openDatabase } from "../src/data/database.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-workbench-search-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({
    databasePath,
    clock: () => "2026-08-31T10:00:00.000Z",
    logger: false
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = await app.inject({
    method: "POST", url: "/api/bootstrap",
    payload: { userId: "user_workbench_search_owner", displayName: "Owner" }
  });
  assert.equal(owner.statusCode, 200);
  const ownerHeaders = { authorization: `Bearer ${owner.json().session.token as string}` };
  const createdTeam = await app.inject({
    method: "POST", url: "/api/teams", headers: ownerHeaders,
    payload: { name: "Search Team" }
  });
  assert.equal(createdTeam.statusCode, 200);
  const teamId = createdTeam.json().team.teamId as string;
  const ownerMemberId = createdTeam.json().owner.memberId as string;
  const createRoom = async (name: string) => {
    const response = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/rooms`, headers: ownerHeaders,
      payload: { name }
    });
    assert.equal(response.statusCode, 200);
    return response.json().roomId as string;
  };
  const visibleRoomId = await createRoom("Visible Room");
  const hiddenRoomId = await createRoom("Private Room");
  const member = await app.inject({
    method: "POST", url: "/api/bootstrap",
    payload: { userId: "user_workbench_search_member", displayName: "Member" }
  });
  assert.equal(member.statusCode, 200);
  const memberHeaders = { authorization: `Bearer ${member.json().session.token as string}` };
  const createdMember = await app.inject({
    method: "POST", url: `/api/teams/${teamId}/members`, headers: ownerHeaders,
    payload: { userId: "user_workbench_search_member", displayName: "Member" }
  });
  assert.equal(createdMember.statusCode, 200);
  const memberId = createdMember.json().memberId as string;
  for (const [roomId, memberIds] of [
    [visibleRoomId, [ownerMemberId, memberId]],
    [hiddenRoomId, [ownerMemberId]]
  ] as const) {
    const response = await app.inject({
      method: "PUT", url: `/api/rooms/${roomId}/participants`, headers: ownerHeaders,
      payload: { memberIds, agentIds: [] }
    });
    assert.equal(response.statusCode, 200);
  }
  return {
    app, databasePath, teamId, visibleRoomId, hiddenRoomId, ownerHeaders, memberHeaders,
    async create(title: string, roomId = visibleRoomId, headers = ownerHeaders): Promise<TaskProjection> {
      const created = await app.inject({
        method: "POST", url: `/api/rooms/${roomId}/tasks`, headers,
        payload: { title, goal: "Verify authorized Workbench search." }
      });
      assert.equal(created.statusCode, 200, created.body);
      const task = await app.inject({
        method: "GET", url: `/api/tasks/${created.json().taskId as string}`, headers
      });
      assert.equal(task.statusCode, 200, task.body);
      return task.json<TaskProjection>();
    },
    query(parameters: Record<string, string> = {}, headers = ownerHeaders, targetTeamId = teamId) {
      const query = new URLSearchParams({ scope: "team", ...parameters });
      return app.inject({
        method: "GET", url: `/api/teams/${targetTeamId}/work-items?${query.toString()}`, headers
      });
    }
  };
}

function taskIds(page: WorkbenchPage): string[] {
  return page.items.map(({ taskId }) => taskId).sort();
}

test("Workbench search matches trimmed case-insensitive literal titles, never SQL or wildcard expressions", async (t) => {
  const f = await fixture(t);
  const plan = await f.create("Ship Release PLAN");
  const unicode = await f.create("PréPARER 中文复核 😀");
  const percent = await f.create("A literal 100% completion check");
  const underscore = await f.create("A literal_under_score check");
  const injection = await f.create("A literal ' OR 1=1 -- query");
  const slash = await f.create("A literal \\ escape check");
  for (const [search, expected] of [
    ["  release plan  ", plan], ["préparer", unicode], ["中文复核", unicode],
    ["%", percent], ["_", underscore], ["' OR 1=1 --", injection], ["\\", slash]
  ] as const) {
    const response = await f.query({ search });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(taskIds(response.json<WorkbenchPage>()), [expected.taskId], search);
  }
  const noHit = await f.query({ search: "%_" });
  assert.deepEqual(noHit.json(), { items: [], nextCursor: null });
});

test("numeric and TASK-n searches also match only the exact Team display number", async (t) => {
  const f = await fixture(t);
  const numbered = await f.create("Shipping work");
  const number = numbered.taskDisplayNumber;
  const numericTitle = await f.create(`Reference ${number} in a title`);
  const prefixedTitle = await f.create(`Notes for TASK-${number}`);
  for (const [search, expected] of [
    [String(number), [numbered.taskId, numericTitle.taskId, prefixedTitle.taskId]],
    [`  task-${number} `, [numbered.taskId, prefixedTitle.taskId]],
    [`TASK-0${number}`, [numbered.taskId]],
    [`TASK-${number + 1000}`, []], ["9007199254740993", []], ["TASK-0", []]
  ] as const) {
    const response = await f.query({ search });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(taskIds(response.json<WorkbenchPage>()), [...expected].sort(), search);
  }
});

test("search stays inside Team, Room and Mine authorization before matching titles or numbers", async (t) => {
  const f = await fixture(t);
  const shared = await f.create("Needle shared with the member");
  const own = await f.create("Needle owned by the member", f.visibleRoomId, f.memberHeaders);
  const hidden = await f.create("Needle in a private Room", f.hiddenRoomId);
  const team = await f.query({ search: "NEEDLE" }, f.memberHeaders);
  assert.equal(team.statusCode, 200);
  assert.deepEqual(taskIds(team.json<WorkbenchPage>()), [shared.taskId, own.taskId].sort());
  const mine = await f.query({ search: "needle", scope: "mine" }, f.memberHeaders);
  assert.deepEqual(taskIds(mine.json<WorkbenchPage>()), [own.taskId]);
  for (const parameters of [
    { search: "Needle", roomId: f.hiddenRoomId },
    { search: String(hidden.taskDisplayNumber) },
    { search: `TASK-${hidden.taskDisplayNumber}` }
  ]) {
    const response = await f.query(parameters, f.memberHeaders);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { items: [], nextCursor: null });
    assert.equal(response.body.includes(hidden.taskId), false);
  }
  const invalidForeign = await f.query({ search: "x".repeat(101) }, f.memberHeaders, "team_foreign_search_0001");
  assert.equal(invalidForeign.statusCode, 403, "Team authorization precedes search validation");
  const repeatedForeign = await f.app.inject({
    method: "GET", url: "/api/teams/team_foreign_search_0001/work-items?search=a&search=b",
    headers: f.memberHeaders
  });
  assert.equal(repeatedForeign.statusCode, 403, "Team authorization also precedes scalar parsing");
  const anonymous = await f.app.inject({
    method: "GET", url: `/api/teams/${f.teamId}/work-items?search=Needle`
  });
  assert.equal(anonymous.statusCode, 401);
});

test("search cursors normalize whitespace and case, preserve ordering, and reject changed searches", async (t) => {
  const f = await fixture(t);
  const expected = await Promise.all([f.create("Plan Alpha"), f.create("Plan Bravo"), f.create("Plan Charlie")]);
  await f.create("Unrelated work");
  const first = await f.query({ search: " PLAN ", limit: "1" });
  assert.equal(first.statusCode, 200, first.body);
  const firstPage = first.json<WorkbenchPage>();
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const second = await f.query({ search: "plan", limit: "2", cursor: firstPage.nextCursor });
  assert.equal(second.statusCode, 200, second.body);
  const secondPage = second.json<WorkbenchPage>();
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items].map(({ taskId }) => taskId),
    expected.map(({ taskId }) => taskId).sort()
  );
  for (const search of [undefined, "other", "   "]) {
    const changed = await f.query({
      cursor: firstPage.nextCursor,
      ...(search === undefined ? {} : { search })
    });
    assert.equal(changed.statusCode, 400);
    assert.match(changed.json().error.message, /does not match/u);
  }
});

test("omitted and blank searches retain the pre-search cursor fingerprint", async (t) => {
  const f = await fixture(t);
  await f.create("One legacy-compatible task");
  const first = await f.query({ limit: "1" });
  assert.equal(first.statusCode, 200);
  const firstPage = first.json<WorkbenchPage>();
  assert.ok(firstPage.nextCursor);
  const cursor = JSON.parse(Buffer.from(firstPage.nextCursor, "base64url").toString("utf8")) as { filterFingerprint: string };
  const legacyFingerprint = createHash("sha256").update(JSON.stringify({
    scope: "team", attention: [], lifecycleState: [], priority: [],
    ownerMemberId: null, roomId: null, agentId: null, updatedAfter: null, updatedBefore: null
  })).digest("base64url").slice(0, 24);
  assert.equal(cursor.filterFingerprint, legacyFingerprint);
  for (const search of ["", " \t\n "]) {
    const blank = await f.query({ search, limit: "1" });
    assert.equal(blank.statusCode, 200);
    assert.deepEqual(blank.json(), firstPage);
    const continued = await f.query({ search, limit: "1", cursor: firstPage.nextCursor });
    assert.equal(continued.statusCode, 200);
    assert.notEqual(continued.json<WorkbenchPage>().items[0]?.taskId, firstPage.items[0]?.taskId);
  }
  const changed = await f.query({ search: "legacy", cursor: firstPage.nextCursor });
  assert.equal(changed.statusCode, 400);
});

test("mixed-case and punctuation Task IDs at one timestamp paginate in one binary total order", async (t) => {
  const f = await fixture(t);
  const template = await f.create("Template outside the matching search");
  const expected = [
    "task_-aaaaaaa", "task_A-aaaaaa", "task_A_aaaaaa", "task_Aaaaaaaa",
    "task_Zzzzzzzz", "task__aaaaaaa", "task_aaaaaaaa", "task_zzzzzzzz"
  ];
  const database = openDatabase(f.databasePath);
  try {
    const tasks = new AgentTaskRepository(database);
    const original = tasks.get(template.taskId)!;
    // Seed exact contract-valid IDs through the repository, retaining all the
    // real Task revisions/ownership while removing random-ID test flakiness.
    for (const taskId of expected.toReversed()) {
      tasks.create({ ...original, taskId, title: `Binary order ${taskId}`,
        taskDisplayNumber: tasks.nextDisplayNumber(f.teamId) });
    }
  } finally { database.close(); }

  for (const search of ["Binary order", undefined]) {
    const parameters = search ? { search } : {};
    const all = await f.query(parameters);
    assert.equal(all.statusCode, 200, all.body);
    const allItems = all.json<WorkbenchPage>().items;
    assert.ok(allItems.every(({ updatedAt }) => updatedAt === "2026-08-31T10:00:00.000Z"));
    const expectedIds = search ? expected : allItems.map(({ taskId }) => taskId).sort();
    for (const limit of [1, 2, 3]) {
      const received: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = await f.query({ ...parameters, limit: String(limit), ...(cursor ? { cursor } : {}) });
        assert.equal(response.statusCode, 200, response.body);
        const page = response.json<WorkbenchPage>();
        assert.ok(page.items.length <= limit);
        received.push(...page.items.map(({ taskId }) => taskId));
        cursor = page.nextCursor;
        if (cursor) {
          assert.equal(cursors.has(cursor), false, "the next cursor must advance");
          cursors.add(cursor);
          assert.ok(cursors.size < expectedIds.length, "pagination must terminate");
        }
      } while (cursor);
      assert.deepEqual(received, expectedIds, `${search ?? "no search"}, page size ${limit}`);
      assert.equal(new Set(received).size, expectedIds.length, "every authorized Task appears exactly once");
    }
    assert.deepEqual(allItems.map(({ taskId }) => taskId), expectedIds, "full pages use the same total order");
  }
});

test("search validation enforces one string and a trimmed 100-code-point bound", async (t) => {
  const f = await fixture(t);
  for (const search of ["x".repeat(100), "😀".repeat(100), `  ${"x".repeat(100)}  `]) {
    const response = await f.query({ search });
    assert.equal(response.statusCode, 200, response.body);
  }
  for (const search of ["x".repeat(101), "😀".repeat(101)]) {
    const response = await f.query({ search });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /at most 100 characters/u);
  }
  const repeated = await f.app.inject({
    method: "GET", url: `/api/teams/${f.teamId}/work-items?search=a&search=b`, headers: f.ownerHeaders
  });
  assert.equal(repeated.statusCode, 400);
  assert.match(repeated.json().error.message, /search must be singular/u);
});
