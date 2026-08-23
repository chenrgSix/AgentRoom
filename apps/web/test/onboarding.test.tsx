import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";

interface RequestRecord {
  body?: string;
  headers?: HeadersInit;
  method: string;
  path: string;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

test("Chinese-first onboarding persists locale and reaches Bridge approval", async () => {
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

  const requests: RequestRecord[] = [];
  const team = {
    teamId: "team_test",
    name: "Platform Team",
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  const room = {
    roomId: "room_test",
    teamId: team.teamId,
    name: "general",
    createdAt: "2026-08-23T00:01:00.000Z"
  };
  const member = {
    memberId: "member_test",
    teamId: team.teamId,
    userId: "user_test",
    displayName: "Local Owner",
    role: "owner",
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  const device = {
    deviceId: "device_test",
    name: "Alice Mac",
    status: "active" as const
  };
  const agent = {
    agentId: "agent_review",
    integrationMode: "fake" as const,
    name: "Review Bot",
    presence: "ready",
    role: "Teammate"
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    requests.push({
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      method,
      path
    });
    if (path === "/api/bootstrap") {
      return jsonResponse({
        user: { userId: "user_test", displayName: "Local Owner" },
        session: { token: "session_test" }
      });
    }
    if (path === "/api/teams" && method === "POST") {
      return jsonResponse({ team });
    }
    if (path === "/api/teams") {
      const teamWasCreated = requests.some((request) =>
        request.path === "/api/teams" && request.method === "POST"
      );
      return jsonResponse(teamWasCreated ? [team] : []);
    }
    if (path === `/api/teams/${team.teamId}/rooms` && method === "POST") {
      return jsonResponse(room);
    }
    if (
      path === `/api/teams/${team.teamId}/bridge-join-requests/approve` &&
      method === "POST"
    ) {
      return jsonResponse({
        status: "approved",
        deviceName: "Alice Mac",
        agentName: "Local Codex"
      });
    }
    if (path === `/api/rooms/${room.roomId}/messages?limit=100`) {
      return jsonResponse({ items: [] });
    }
    if (path === `/api/rooms/${room.roomId}/runs`) {
      return jsonResponse([]);
    }
    if (path === `/api/teams/${team.teamId}/devices/${device.deviceId}` && method === "DELETE") {
      return jsonResponse({ ...device, status: "revoked" });
    }
    if (path === `/api/teams/${team.teamId}/devices`) {
      return jsonResponse([device]);
    }
    if (path === `/api/teams/${team.teamId}/members`) {
      return jsonResponse([member]);
    }
    if (path.endsWith("/agents")) {
      return jsonResponse([agent]);
    }
    if (path.endsWith("/rooms")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const teamHeading = await screen.findByRole("heading", { name: "创建你的第一个 Team" });
    const teamStep = teamHeading.closest("section");
    assert.ok(teamStep);
    assert.equal(dom.window.document.documentElement.lang, "zh-CN");

    fireEvent.click(screen.getByRole("button", { name: "界面语言" }));
    await screen.findByRole("heading", { name: "Create your first Team" });
    assert.equal(localStorage.getItem("agent-room.locale"), "en");
    assert.equal(dom.window.document.documentElement.lang, "en");
    fireEvent.click(screen.getByRole("button", { name: "Interface language" }));
    await screen.findByRole("heading", { name: "创建你的第一个 Team" });
    assert.equal(localStorage.getItem("agent-room.locale"), "zh-CN");

    const nameInput = within(teamStep).getByLabelText("Team 名称") as HTMLInputElement;
    const createButton = within(teamStep).getByRole("button", { name: "创建 Team" });
    assert.equal(nameInput.required, true);
    assert.equal((createButton as HTMLButtonElement).disabled, false);

    fireEvent.change(nameInput, { target: { value: "Platform Team" } });
    fireEvent.click(createButton);

    await screen.findByRole("heading", { name: "创建一个对话房间" });
    await waitFor(() => {
      const request = requests.find((candidate) =>
        candidate.path === "/api/teams" && candidate.method === "POST"
      );
      assert.deepEqual(JSON.parse(request?.body ?? "{}"), { name: "Platform Team" });
    });
    const roomInput = screen.getByLabelText("房间名称") as HTMLInputElement;
    assert.equal(roomInput.required, true);
    assert.equal(
      (screen.getByRole("button", { name: "创建房间" }) as HTMLButtonElement).disabled,
      false
    );

    fireEvent.change(roomInput, { target: { value: "general" } });
    fireEvent.click(screen.getByRole("button", { name: "创建房间" }));
    await screen.findByRole("heading", { name: "在房间中开始对话 #general" });
    assert.equal(screen.queryByLabelText("新建假智能体名称"), null);
    assert.equal(screen.queryByLabelText("新 Team 名称"), null);
    const participants = screen.getByRole("region", { name: "房间成员" });
    within(participants).getByText("Local Owner");
    within(participants).getByText("Team 所有者");
    const roomSidebar = participants.closest("aside");
    assert.ok(roomSidebar);
    assert.equal(within(roomSidebar).queryByRole("navigation"), null);
    assert.equal(within(roomSidebar).queryByRole("contentinfo"), null);
    assert.equal(within(roomSidebar).queryByLabelText("新房间名称"), null);
    assert.equal((screen.getByLabelText("选择房间") as HTMLSelectElement).value, room.roomId);
    screen.getByLabelText("新房间名称");
    assert.equal(screen.queryByRole("combobox", { name: "提及智能体" }), null);
    const messageInput = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(messageInput, { target: { value: "请 @Rev" } });
    const mentionList = screen.getByRole("listbox", { name: "提及智能体" });
    const mentionOption = within(mentionList).getByRole("option", { name: /@Review Bot/u });
    fireEvent.click(mentionOption);
    assert.equal(messageInput.value, "请 @Review Bot ");
    screen.getByText("已提及 @Review Bot");
    fireEvent.click(screen.getByRole("button", { name: "智能体管理" }));

    await screen.findByRole("heading", { name: "智能体与设备" });
    screen.getByRole("heading", { name: "Team 智能体" });
    screen.getByText("托管本地 Codex");
    screen.getByText(/这不是智能体名称/u);

    fireEvent.click(screen.getByRole("tab", { name: "演示智能体" }));
    screen.getByText("仅用于模拟");
    screen.getByText(/不会调用 Codex 或其他模型/u);
    fireEvent.click(screen.getByRole("tab", { name: "托管 Codex" }));

    const joinCode = screen.getByLabelText("Bridge 审批码");
    fireEvent.change(joinCode, { target: { value: "ABCD-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "批准 Bridge" }));

    await screen.findByText(/已批准 Alice Mac 上的 Local Codex/u);
    await waitFor(() => {
      const request = requests.find((candidate) =>
        candidate.path === `/api/teams/${team.teamId}/bridge-join-requests/approve`
      );
      assert.deepEqual(JSON.parse(request?.body ?? "{}"), { code: "ABCD-1234" });
    });

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByRole("button", { name: "已撤销" });
    const revokeRequest = requests.find((candidate) =>
      candidate.path === `/api/teams/${team.teamId}/devices/${device.deviceId}` &&
      candidate.method === "DELETE"
    );
    assert.ok(revokeRequest);
    assert.equal(revokeRequest.body, undefined);
    assert.equal(new Headers(revokeRequest.headers).has("content-type"), false);
  } finally {
    cleanup();
    dom.window.close();
  }
});
