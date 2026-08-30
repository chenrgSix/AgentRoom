import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";
import { advanceWebSessionGeneration } from "../src/api-client.js";
import type { AgentTask, Message, Room, Run, Team } from "../src/models.js";

const now = "2026-08-31T10:00:00.000Z";
const user = { userId: "user_snapshot_race_0001", displayName: "Owner" };
const team: Team = { teamId: "team_snapshot_race_0001", name: "Snapshot Race", createdAt: now };
const room: Room = { roomId: "room_snapshot_race_0001", teamId: team.teamId, name: "snapshot-room", settingsRevision: 1, createdAt: now };
const member = { memberId: "member_snapshot_race_0001", teamId: team.teamId, userId: user.userId, displayName: "Owner", role: "owner", createdAt: now };
const originalTask: AgentTask = {
  taskId: "task_snapshot_original_0001", roomId: room.roomId, parentTaskId: null,
  title: "Original Task", goal: "Keep the original work separate.", state: "open",
  primaryAgentId: null, isDefault: true, updatedAt: now
};
const createdTask: AgentTask = { ...originalTask, taskId: "task_snapshot_created_0001", title: "New Task during initial output", isDefault: false };
const run: Run = {
  runId: "run_snapshot_race_0001", taskId: originalTask.taskId, triggerMessageId: "msg_snapshot_original_0001",
  targetAgentId: "agent_snapshot_race_0001", state: "working", updatedAt: now
};
const sentMessage: Message = {
  messageId: "msg_snapshot_sent_0001", roomId: room.roomId, taskId: createdTask.taskId,
  sequence: 1, senderType: "member", senderId: member.memberId, content: "Message for the new Task",
  mentions: [], parentMessageId: null, createdAt: now
};

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function assertSnapshotSelection(sendBeforeInitial: boolean) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://team.example.com/", pretendToBeVisual: true });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
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
  const originalFetch = globalThis.fetch;
  let resolveOutput!: (value: Response) => void;
  const initialOutput = new Promise<Response>((resolve) => { resolveOutput = resolve; });
  let outputReads = 0;
  let taskCreated = false;
  let messageSent = false;
  let changeReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path === "/api/auth/status") return json({ mode: "trusted-team", state: "authenticated", user, session: { expiresAt: "2099-09-30T00:00:00.000Z" } });
    if (path === "/api/teams") return json([team]);
    if (path.startsWith(`/api/teams/${team.teamId}/work-items?`)) return json({ items: [], nextCursor: null });
    if (path === `/api/teams/${team.teamId}/rooms`) return json([room]);
    if (path === `/api/teams/${team.teamId}/members`) return json([member]);
    if (["agents", "devices"].some((suffix) => path === `/api/teams/${team.teamId}/${suffix}`)) return json([]);
    if (path === `/api/rooms/${room.roomId}/settings`) return json({ room, participants: { memberIds: [member.memberId], agentIds: [] } });
    if (path === `/api/rooms/${room.roomId}/runs`) return json([run]);
    if (path === `/api/rooms/${room.roomId}/tasks`) {
      if (init.method === "POST") { taskCreated = true; return json(createdTask); }
      return json(taskCreated ? [originalTask, createdTask] : [originalTask]);
    }
    if (["discussions", "memory-candidates"].some((suffix) => path === `/api/rooms/${room.roomId}/${suffix}`)) return json([]);
    if (path.startsWith(`/api/runs/${run.runId}/events?`)) { outputReads += 1; return initialOutput; }
    if (path.endsWith("/clarifications")) return json([]);
    if (path.endsWith("/artifacts")) return json({ artifacts: [], nextCursor: null });
    if (path === `/api/rooms/${room.roomId}/messages` && init.method === "POST") { messageSent = true; return json({ message: sentMessage, runs: [] }); }
    if (path.startsWith(`/api/rooms/${room.roomId}/messages?`)) return json({
      items: messageSent ? [sentMessage] : [], nextCursor: null, olderCursor: null,
      syncCursor: messageSent ? "cursor_snapshot_live_1" : "cursor_snapshot_live_0"
    });
    if (path.includes("/changes?")) {
      changeReads += 1;
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    throw new Error(`Unexpected snapshot race request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await waitFor(() => assert.equal(outputReads, 1));
    fireEvent.click(page.getByRole("button", { name: "⌁ 对话", exact: true }));
    fireEvent.click(page.getByRole("button", { name: "+ 新任务" }));
    const dialog = within(await page.findByRole("dialog", { name: "创建长期任务" }));
    fireEvent.change(dialog.getByLabelText("任务名称"), { target: { value: createdTask.title } });
    fireEvent.change(dialog.getByLabelText("任务目标"), { target: { value: createdTask.goal } });
    fireEvent.click(dialog.getByRole("button", { name: "创建并切换" }));
    await waitFor(() => assert.equal((page.getByLabelText("当前任务") as HTMLSelectElement).value, createdTask.taskId));
    if (sendBeforeInitial) {
      fireEvent.change(page.getByLabelText("消息"), { target: { value: sentMessage.content } });
      fireEvent.click(page.getByRole("button", { name: "发送", exact: true }));
      await page.findByText(sentMessage.content);
      await waitFor(() => assert.equal((page.getByLabelText("当前任务") as HTMLSelectElement).options.length, 2));
    }
    fireEvent.change(page.getByLabelText("消息"), { target: { value: "Unsent follow-up for the newly created Task" } });
    await act(async () => { resolveOutput(json([])); await initialOutput; });
    await waitFor(() => assert.equal(changeReads, 1));
    assert.equal((page.getByLabelText("当前任务") as HTMLSelectElement).value, createdTask.taskId,
      "an older initial Task list must not replace the successfully refreshed Task selection");
    assert.equal((page.getByLabelText("消息") as HTMLTextAreaElement).value, "Unsent follow-up for the newly created Task");
    assert.ok(within(page.getByRole("region", { name: "房间成员", exact: true })).getByText(member.displayName),
      "late initial settings must still establish the authorized Room participants");
    if (sendBeforeInitial) assert.ok(page.getByText(sentMessage.content));
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const key of ["document", "HTMLElement", "localStorage", "sessionStorage", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"]) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

for (const sendBeforeInitial of [false, true]) {
  test(`late initial Room snapshot cannot remove the newly created Task or switch its draft ${sendBeforeInitial ? "after sending a message" : "without sending a message"}`,
    () => assertSnapshotSelection(sendBeforeInitial));
}
