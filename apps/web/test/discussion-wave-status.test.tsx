import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true
  });
  return dom;
}

const owner = {
  createdAt: "2026-08-24T00:00:00.000Z",
  displayName: "Local Owner",
  memberId: "member_owner",
  role: "owner",
  teamId: "team_test",
  userId: "user_owner"
};
const team = {
  createdAt: "2026-08-24T00:00:00.000Z",
  name: "Wave Team",
  teamId: "team_test"
};
const room = {
  createdAt: "2026-08-24T00:00:00.000Z",
  name: "general",
  roomId: "room_test",
  teamId: team.teamId
};
const agents = [{
  agentId: "agent_solver",
  integrationMode: "managed",
  name: "方案智能体",
  presence: "ready",
  role: "Codex implementer"
}, {
  agentId: "agent_reviewer",
  integrationMode: "managed",
  name: "评审智能体",
  presence: "ready",
  role: "Teammate"
}];

function installFixture(input: {
  discussionState: "waiting_human" | "completed";
  currentWave: number;
  messages?: unknown[];
  runs: unknown[];
  turns: unknown[];
  waves: unknown[];
}): void {
  const discussion = {
    budget: { durationSeconds: 12, turnsUsed: input.currentWave },
    currentTurn: input.turns.length,
    currentWave: input.currentWave,
    discussionId: "discussion_test",
    goal: "确定可靠的交付方案",
    progress: { confidence: 0.7, openQuestions: [], plateauCount: 0 },
    state: input.discussionState,
    stateReason: input.discussionState === "completed" ? "finalized" : "all_runs_failed"
  };
  globalThis.fetch = async (request) => {
    const path = typeof request === "string" ? request : request.url;
    if (path === "/api/auth/status") {
      return jsonResponse({
        mode: "trusted-team",
        session: { expiresAt: "2026-09-24T00:00:00.000Z" },
        state: "authenticated",
        user: { displayName: owner.displayName, userId: owner.userId }
      });
    }
    if (path === "/api/teams") return jsonResponse([team]);
    if (path === `/api/teams/${team.teamId}/rooms`) return jsonResponse([room]);
    if (path === `/api/teams/${team.teamId}/agents`) return jsonResponse(agents);
    if (path === `/api/teams/${team.teamId}/members`) return jsonResponse([owner]);
    if (path === `/api/teams/${team.teamId}/devices`) return jsonResponse([]);
    if (path === `/api/rooms/${room.roomId}/participants`) {
      return jsonResponse({
        memberIds: [owner.memberId],
        agentIds: agents.map(({ agentId }) => agentId)
      });
    }
    if (path === `/api/rooms/${room.roomId}/messages?limit=100&tail=true`) {
      return jsonResponse({
        items: input.messages ?? [],
        nextCursor: null,
        syncCursor: "cursor-empty"
      });
    }
    if (path === `/api/rooms/${room.roomId}/runs`) return jsonResponse(input.runs);
    if (path === `/api/rooms/${room.roomId}/discussions`) {
      return jsonResponse([{
        discussion,
        participants: agents.map(({ agentId }) => ({ agentId, role: "participant" })),
        turns: input.turns,
        waves: input.waves
      }]);
    }
    if (path.startsWith(`/api/teams/${team.teamId}/changes?after=`)) {
      return jsonResponse({ changed: false, cursor: 0, reset: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}

test("waiting Discussion keeps the just-closed partial Wave visible", async () => {
  const dom = installDom();
  installFixture({
    currentWave: 2,
    discussionState: "waiting_human",
    runs: [{
      runId: "run_solver",
      state: "completed",
      targetAgentId: agents[0]!.agentId,
      triggerMessageId: "message_wave_2",
      updatedAt: "2026-08-24T00:02:00.000Z"
    }, {
      runId: "run_reviewer",
      state: "failed",
      targetAgentId: agents[1]!.agentId,
      triggerMessageId: "message_wave_2",
      updatedAt: "2026-08-24T00:02:01.000Z"
    }],
    turns: [{
      kind: "discussion",
      runId: "run_solver",
      speakerAgentId: agents[0]!.agentId,
      state: "completed",
      terminalReason: null,
      turnId: "turn_solver",
      waveId: "wave_2",
      waveMemberOrdinal: 1
    }, {
      kind: "discussion",
      runId: "run_reviewer",
      speakerAgentId: agents[1]!.agentId,
      state: "failed",
      terminalReason: "run_failed",
      turnId: "turn_reviewer",
      waveId: "wave_2",
      waveMemberOrdinal: 2
    }],
    waves: [{
      expectedMembers: 2,
      ordinal: 1,
      phase: "contribution",
      state: "completed",
      waveId: "wave_1"
    }, {
      expectedMembers: 2,
      ordinal: 2,
      phase: "review",
      state: "partial",
      waveId: "wave_2"
    }]
  });

  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    const view = render(<App />);
    const panel = await view.findByRole("region", { name: "当前智能体讨论" });
    const dock = panel.closest(".room-dock");
    assert.ok(dock, "Discussion status should live in the Room dock");
    assert.equal(panel.closest("form"), null, "Discussion status should not expand the composer form");
    assert.ok(dock.querySelector("form.composer"), "Room dock should keep a separate composer");
    within(panel).getByText("等待你的决定");
    within(panel).getByText("部分完成");
    within(panel).getByText("2/2 已结束");
    const progress = within(panel).getByRole("list", { name: "第2轮并行进度" });
    const failedMember = within(progress).getByText("评审智能体").closest("li");
    assert.ok(failedMember);
    within(failedMember).getByText("失败");
    within(failedMember).getByText("原因：执行失败");
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Room dock participates in layout instead of overlaying the timeline", async () => {
  const stylesheet = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const timelineRule = stylesheet.match(/\.timeline\s*\{[^}]+\}/u)?.[0] ?? "";
  const composerRule = stylesheet.match(/\.composer\s*\{[^}]+\}/u)?.[0] ?? "";
  const dockRule = stylesheet.match(/\.room-dock\s*\{[^}]+\}/u)?.[0] ?? "";

  assert.match(timelineRule, /overflow-y:\s*auto/u);
  assert.doesNotMatch(composerRule, /position:\s*absolute/u);
  assert.match(dockRule, /flex:\s*0 0 auto/u);
});

test("Run status replaces duplicate Mention metadata in a Member message", async () => {
  const dom = installDom();
  installFixture({
    currentWave: 1,
    discussionState: "completed",
    messages: [{
      content: "请分析这个交付方案",
      createdAt: "2026-08-24T00:01:00.000Z",
      mentions: [{
        displayLabel: "方案智能体 / Codex implementer",
        targetAgentId: agents[0]!.agentId
      }],
      messageId: "message_prompt",
      roomId: room.roomId,
      senderId: owner.memberId,
      senderType: "member",
      sequence: 1
    }],
    runs: [{
      runId: "run_solver",
      state: "completed",
      targetAgentId: agents[0]!.agentId,
      triggerMessageId: "message_prompt",
      updatedAt: "2026-08-24T00:02:00.000Z"
    }],
    turns: [{
      kind: "discussion",
      runId: "run_solver",
      speakerAgentId: agents[0]!.agentId,
      state: "completed",
      terminalReason: null,
      turnId: "turn_solver",
      waveId: "wave_1",
      waveMemberOrdinal: 1
    }],
    waves: [{
      expectedMembers: 1,
      ordinal: 1,
      phase: "contribution",
      state: "completed",
      waveId: "wave_1"
    }]
  });

  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    const view = render(<App />);
    const prompt = await view.findByText("请分析这个交付方案");
    const message = prompt.closest("article");
    assert.ok(message);
    assert.ok(message.querySelector(".message-routing.with-runs"));
    assert.equal(message.querySelectorAll(".run-card").length, 1);
    assert.equal(message.querySelector(".mention-pill"), null);
    within(message).getByText("方案智能体");
    within(message).getByText("已完成");
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("completed Discussion keeps a failed finalization Wave and its reasons visible", async () => {
  const dom = installDom();
  installFixture({
    currentWave: 2,
    discussionState: "completed",
    runs: [{
      runId: "run_finalizer",
      state: "failed",
      targetAgentId: agents[1]!.agentId,
      triggerMessageId: "message_finalization",
      updatedAt: "2026-08-24T00:03:00.000Z"
    }],
    turns: [{
      kind: "finalization",
      runId: "run_finalizer",
      speakerAgentId: agents[1]!.agentId,
      state: "failed",
      terminalReason: "run_outcome_unknown",
      turnId: "turn_finalizer",
      waveId: "wave_finalization",
      waveMemberOrdinal: 1
    }],
    waves: [{
      expectedMembers: 2,
      ordinal: 1,
      phase: "contribution",
      state: "completed",
      waveId: "wave_1"
    }, {
      expectedMembers: 1,
      ordinal: 2,
      phase: "finalization",
      state: "failed",
      waveId: "wave_finalization"
    }]
  });

  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    const view = render(<App />);
    const panel = await view.findByRole("region", { name: "当前智能体讨论" });
    within(panel).getByText("已完成");
    within(panel).getByText("结论生成");
    const summary = panel.querySelector(".discussion-wave-summary");
    assert.ok(summary);
    within(summary as HTMLElement).getByText("失败");
    const progress = within(panel).getByRole("list", { name: "结论生成进度" });
    const finalizer = within(progress).getByText("评审智能体").closest("li");
    assert.ok(finalizer);
    within(finalizer).getByText("原因：执行结果未知");
    assert.equal(within(panel).queryByRole("button", { name: "立即停止" }), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});
