import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { createServerApp } from "../../server/src/app.js";
import { openDatabase } from "../../server/src/data/database.js";
import { RunRepository } from "../../server/src/run/run-repository.js";
import { App } from "../src/App.js";
import { advanceWebSessionGeneration, webSessionExpiredEvent } from "../src/api-client.js";
import { RunRecoveryControls } from "../src/features/work/RunRecoveryControls.js";
import { TaskWorkDetail } from "../src/features/work/TaskWorkDetail.js";
import { readRecoveryReceipt, type RecoveryCommand } from "../src/features/work/recovery-receipt.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  advanceWebSessionGeneration();
  return dom;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const task = {
  taskId: "task_recovery_session_0001", teamId: "team_recovery_session_0001",
  roomId: "room_recovery_session_0001", ownerMemberId: "member_recovery_session_0001",
  taskDisplayNumber: 1, title: "Recovery session test", goal: "Keep the original recovery identity",
  lifecycleState: "active", schedulingState: "enabled", priority: "normal", isDefault: true,
  taskRevision: 1, definitionRevision: 1, criteriaRevision: 1, criteria: [], assignments: [],
  budgetPolicy: { maxRunAttempts: 5, maxExecutionDurationSeconds: 3600 },
  budgetUsage: { runAttempts: 1, executionDurationSeconds: 0 },
  attentionReasons: [], nextAction: { reason: "none", actorKind: "none" },
  completionPolicy: "owner_confirmed"
} as TaskProjection;

const run = { runId: "run_recovery_session_0001", targetAgentId: "agent_recovery_session_0001", state: "failed" };
const receiptScope = { memberId: task.ownerMemberId, teamId: task.teamId, taskId: task.taskId, runId: run.runId };

for (const kind of ["ack", "retry"] as const) {
  for (const outcome of ["success", "transport-failure"] as const) {
    test(`detached ${kind} preserves its receipt and never refreshes after a late ${outcome}`, async () => {
      const dom = installDom();
      const originalFetch = globalThis.fetch;
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      let changed = 0;
      const writes: RecoveryCommand[] = [];
      globalThis.fetch = async (_input, init = {}) => {
        if (init.method !== "POST") return json({ acknowledgement: null });
        writes.push(JSON.parse(String(init.body)) as RecoveryCommand);
        return new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
      };
      const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
      try {
        const view = render(<RunRecoveryControls
          canManage evidenceReady locale="en" memberId={task.ownerMemberId}
          onChanged={() => { changed += 1; }}
          run={{ ...run, state: kind === "ack" ? "outcome_unknown" : "failed" }}
          task={task} token="original-session"
        />);
        const page = within(dom.window.document.body);
        if (kind === "ack") {
          fireEvent.change(await page.findByRole("textbox", { name: "Observed outcome and acknowledgement reason" }), {
            target: { value: "Verified the original external effects." }
          });
          fireEvent.click(page.getByRole("checkbox", { name: "I have checked the evidence and external effects." }));
          fireEvent.click(page.getByRole("button", { name: "Record acknowledgement" }));
        } else {
          fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
          fireEvent.click(page.getByRole("button", { name: "Start new attempt" }));
        }
        await waitFor(() => assert.equal(writes.length, 1));
        const receipt = readRecoveryReceipt(receiptScope, kind);
        assert.deepEqual(receipt, writes[0]);
        view.unmount();
        await act(async () => {
          if (outcome === "transport-failure") reject(new Error("Response was lost"));
          else resolve(json(kind === "ack"
            ? { runId: run.runId, reason: receipt!.reason, taskRevisionAfter: 2 }
            : { runId: "run_recovery_child_0001" }));
          await setImmediate();
        });
        assert.equal(changed, 0, "a detached mutation must not call the old detail refresh");
        assert.deepEqual(readRecoveryReceipt(receiptScope, kind), receipt);
      } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
    });
  }
}

test("a replacement token keeps the same Run receipt isolated from the old control's late success", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let changed = 0;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { finish = resolve; });
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    const props = {
      canManage: true, evidenceReady: true, locale: "en" as const,
      memberId: task.ownerMemberId, onChanged: () => { changed += 1; }, run, task
    };
    const view = render(<RunRecoveryControls {...props} token="original-session" />);
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
    fireEvent.click(page.getByRole("button", { name: "Start new attempt" }));
    await waitFor(() => assert.equal(typeof finish, "function"));
    const receipt = readRecoveryReceipt(receiptScope, "retry");
    assert.ok(receipt);
    view.rerender(<RunRecoveryControls {...props} token="replacement-session" />);
    await page.findByRole("button", { name: "Check previous new attempt" });
    await act(async () => { finish(json({ runId: "run_recovery_child_0001" })); await setImmediate(); });
    assert.equal(changed, 0);
    assert.deepEqual(readRecoveryReceipt(receiptScope, "retry"), receipt);
    assert.equal((page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }) as HTMLInputElement).disabled, false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("an unmounted detail stops before issuing dependent requests from a late Task response", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Promise<Response>((resolve) => { finish = resolve; });
  };
  const { act, cleanup, render, waitFor } = await import("@testing-library/react");
  try {
    const view = render(<TaskWorkDetail
      agentNames={new Map()} currentMember={null} locale="en" memberNames={new Map()}
      onBack={() => undefined} onChanged={() => undefined} onOpenRoom={() => undefined}
      onOpenTask={() => undefined} refreshKey="1" roomNames={new Map()} taskId={task.taskId}
      token="original-session"
    />);
    await waitFor(() => assert.equal(requests.length, 1));
    view.unmount();
    await act(async () => { finish(json(task)); await setImmediate(); });
    assert.deepEqual(requests, [`/api/tasks/${task.taskId}`]);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a committed retry's late response cannot revoke a replacement local session and its receipt replays once", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-recovery-session-test-"));
  let app: Awaited<ReturnType<typeof createServerApp>> | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const databasePath = path.join(directory, "server.sqlite");
  const now = "2026-08-31T12:00:00.000Z";
  app = await createServerApp({ databasePath, clock: () => now, logger: false });
  const server = app;
  async function request(method: "GET" | "POST", url: string, payload?: object, authorization?: string) {
    const response = await server.inject({
      method, url, ...(payload ? { payload } : {}), headers: authorization ? { authorization } : {}
    });
    assert.equal(response.statusCode, 200, `${method} ${url} returned ${response.statusCode}`);
    return response.json();
  }
  const bootstrap = await request("POST", "/api/bootstrap", { userId: "user_recovery_session_0001", displayName: "Recovery Owner" });
  const seedAuthorization = `Bearer ${bootstrap.session.token as string}`;
  const team = await request("POST", "/api/teams", { name: "Recovery Team" }, seedAuthorization);
  const teamId = team.team.teamId as string;
  const room = await request("POST", `/api/teams/${teamId}/rooms`, { name: "recovery-room" }, seedAuthorization);
  const agent = await request("POST", `/api/teams/${teamId}/manual-agents`, { name: "Recovery Manual", role: "Isolated test" }, seedAuthorization);
  const created = await request("POST", `/api/rooms/${room.roomId as string}/tasks`, {
    title: "Retry without losing the replacement session", goal: "Do not execute any external operation",
    assignments: [{ agentId: agent.agent.agentId, role: "primary" }],
    budgetPolicy: { maxRunAttempts: 5, maxExecutionDurationSeconds: 3600 }
  }, seedAuthorization) as TaskProjection;
  const routed = await request("POST", `/api/rooms/${room.roomId as string}/messages`, {
    taskId: created.taskId, content: "Synthetic recovery test", mentionAgentId: agent.agent.agentId
  }, seedAuthorization);
  const runId = routed.runs[0].runId as string;
  // A manual Agent and a temporary DB produce the terminal fixture without a Runtime/provider.
  const database = openDatabase(databasePath);
  try {
    const runs = new RunRepository(database);
    runs.applyEvent(runId, { type: "status", sequence: 1, status: "working" }, now);
    runs.applyEvent(runId, { type: "status", sequence: 2, status: "failed" }, now);
  } finally { database.close(); }

  const dom = installDom();
  const originalFetch = globalThis.fetch;
  localStorage.setItem("agent-room.locale", "en");
  localStorage.setItem("agent-room.local-user", JSON.stringify(bootstrap.user));
  let oldAuthorization: string | undefined;
  let newAuthorization: string | undefined;
  let releaseRetry!: () => void;
  let afterReentry = false;
  let expired = 0;
  const staleRequests: string[] = [];
  const writes: RecoveryCommand[] = [];
  const retryRunIds: string[] = [];
  window.addEventListener(webSessionExpiredEvent, () => { expired += 1; });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (url.includes("/changes?")) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    if (afterReentry && headers.authorization === oldAuthorization) staleRequests.push(url);
    const response = await server.inject({
      method: (init.method ?? "GET") as "GET" | "POST" | "DELETE", url, headers,
      ...(init.body ? { payload: String(init.body) } : {})
    });
    if (url === "/api/bootstrap") {
      if (!oldAuthorization) oldAuthorization = `Bearer ${response.json().session.token as string}`;
      else newAuthorization = `Bearer ${response.json().session.token as string}`;
    }
    const browserResponse = new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    if (url === `/api/runs/${runId}/retry`) {
      writes.push(JSON.parse(String(init.body)) as RecoveryCommand);
      assert.equal(response.statusCode, 200);
      retryRunIds.push(response.json().runId as string);
      if (writes.length === 1) return new Promise<Response>((resolve) => { releaseRetry = () => resolve(browserResponse); });
    }
    return browserResponse;
  };
  const scope = { memberId: team.owner.memberId as string, teamId, taskId: created.taskId, runId };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByRole("button", { name: `Open TASK-${created.taskDisplayNumber}` }));
    await page.findByRole("heading", { name: created.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    const authorize = await page.findByRole("checkbox", { name: "I explicitly authorize one new execution attempt." });
    await waitFor(() => assert.equal((authorize as HTMLInputElement).disabled, false));
    fireEvent.click(authorize);
    fireEvent.click(page.getByRole("button", { name: "Start new attempt" }));
    await waitFor(() => assert.equal(typeof releaseRetry, "function"));
    const receipt = readRecoveryReceipt(scope, "retry");
    assert.deepEqual(receipt, writes[0]);
    assert.ok(receipt);

    const signOut = page.getAllByRole("button", { name: "Sign out" }).find((button) => button.className.includes("header"))!;
    assert.equal((signOut as HTMLButtonElement).disabled, false);
    fireEvent.click(signOut);
    const reenter = await page.findByRole("button", { name: "Enter local workspace" });
    const revoked = await server.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: oldAuthorization } });
    assert.equal(revoked.statusCode, 401, "normal logout revoked the original Bearer token");
    fireEvent.click(reenter);
    await page.findByRole("button", { name: `Open TASK-${created.taskDisplayNumber}` });
    assert.notEqual(newAuthorization, oldAuthorization);
    const active = await server.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: newAuthorization } });
    assert.equal(active.statusCode, 200);
    afterReentry = true;
    await act(async () => { releaseRetry(); await setImmediate(); });
    assert.deepEqual(staleRequests, [], "the stale catch must not start a current-generation request with its old token");
    assert.equal(expired, 0);
    assert.equal(page.queryByRole("button", { name: "Enter local workspace" }), null);
    assert.deepEqual(readRecoveryReceipt(scope, "retry"), receipt, "the exact uncertain command survives reauthentication");

    fireEvent.click(page.getByRole("button", { name: `Open TASK-${created.taskDisplayNumber}` }));
    await page.findByRole("heading", { name: created.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    fireEvent.click(page.getByRole("button", { name: /Attempt 1/u }));
    const replay = await page.findByRole("button", { name: "Check previous new attempt" });
    const replayAuthorization = page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." });
    await waitFor(() => assert.equal((replayAuthorization as HTMLInputElement).disabled, false));
    fireEvent.click(replayAuthorization);
    fireEvent.click(replay);
    await waitFor(() => assert.equal(writes.length, 2));
    await waitFor(() => assert.equal(readRecoveryReceipt(scope, "retry"), null));
    assert.deepEqual(writes[1], receipt);
    assert.equal(retryRunIds[1], retryRunIds[0], "explicit receipt replay resolves the one committed retry");
    assert.deepEqual(staleRequests, []);
    assert.equal(expired, 0);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});
