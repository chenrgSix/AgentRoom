import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";

interface RequestRecord {
  body?: string;
  credentials?: RequestCredentials;
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
  const secondTeam = {
    teamId: "team_second",
    name: "Research Team",
    createdAt: "2026-08-23T00:10:00.000Z"
  };
  const roomPolicy = {
    allowDiscussion: true,
    allowAll: true,
    allowAgentMentions: true,
    maxAgentMentionDepth: 4
  };
  const room = {
    roomId: "room_test",
    teamId: team.teamId,
    name: "general",
    collaborationPolicy: roomPolicy,
    settingsRevision: 1,
    createdAt: "2026-08-23T00:01:00.000Z"
  };
  const roomTask = {
    taskId: "task_default",
    roomId: room.roomId,
    parentTaskId: null,
    title: "Room work",
    goal: "Continue Room work.",
    state: "open",
    primaryAgentId: null,
    isDefault: true,
    updatedAt: "2026-08-23T00:01:00.000Z"
  };
  const roomTasks = [roomTask];
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
    ownerMemberId: member.memberId,
    name: "Alice Mac",
    status: "active" as const,
    supportsAgentProvisioning: true
  };
  const agent = {
    agentId: "agent_review",
    integrationMode: "fake" as const,
    name: "Review Bot",
    presence: "ready",
    role: "Teammate"
  };
  const secondAgent = {
    agentId: "agent_builder",
    ownerMemberId: member.memberId,
    deviceId: device.deviceId,
    integrationMode: "managed" as const,
    name: "Local Codex",
    presence: "ready",
    role: "Codex implementer"
  };
  const memberMessage = {
    messageId: "message_member",
    roomId: room.roomId,
    taskId: roomTask.taskId,
    sequence: 1,
    senderType: "member" as const,
    senderId: member.memberId,
    content: "请回答",
    mentions: [],
    createdAt: "2026-08-23T00:02:00.000Z"
  };
  const agentMessage = {
    messageId: "message_agent",
    roomId: room.roomId,
    taskId: roomTask.taskId,
    sequence: 2,
    senderType: "agent" as const,
    senderId: agent.agentId,
    content: "已经完成",
    mentions: [],
    createdAt: "2026-08-23T00:03:00.000Z"
  };
  const streamAgentMessage = {
    ...agentMessage,
    messageId: "message_stream_final",
    sequence: 3,
    senderId: secondAgent.agentId,
    content: "流式最终回复",
    createdAt: "2026-08-23T00:04:03.000Z"
  };
  let messageWasSent = false;
  let roomWasCreated = false;
  let teamNameValue = team.name;
  let teamArchivedAt: string | null = null;
  let roomNameValue = room.name;
  let roomArchivedAt: string | null = null;
  let reviewAgentEnabled = true;
  const failedClientMessageIds = new Set<string>();
  let roomAgentIds = [agent.agentId, secondAgent.agentId];
  let roomSettingsRevision = room.settingsRevision;
  let discussionState = "";
  let discussionGoal = "确定交付恢复规则";
  let discussionChangeDelivered = false;
  let streamFinal = false;
  let streamChangeDelivered = false;
  let provisionRequest: Record<string, unknown> | null = null;
  let provisionReady = false;
  const discussionRuns = [{
    runId: "run_review",
    taskId: roomTask.taskId,
    triggerMessageId: "message_wave_review",
    targetAgentId: agent.agentId,
    state: "completed" as const,
    updatedAt: "2026-08-23T00:04:01.000Z"
  }, {
    runId: "run_builder",
    taskId: roomTask.taskId,
    triggerMessageId: "message_wave_builder",
    targetAgentId: secondAgent.agentId,
    state: "working" as const,
    updatedAt: "2026-08-23T00:04:02.000Z"
  }];
  const discussionView = () => ({
    discussion: {
      discussionId: "discussion_test",
      taskId: roomTask.taskId,
      goal: discussionGoal,
      state: discussionState || "active",
      stateReason: discussionState === "stop_requested" ? "user_requested_finish" : null,
      currentTurn: 2,
      currentWave: 1,
      progress: {
        confidence: null,
        openQuestions: [],
        plateauCount: 0
      },
      budget: { turnsUsed: 1, durationSeconds: 3 }
    },
    participants: [
      { agentId: agent.agentId, role: "participant" },
      { agentId: secondAgent.agentId, role: "participant" }
    ],
    waves: [{
      waveId: "wave_contribution_1",
      ordinal: 1,
      phase: "contribution",
      state: "open",
      expectedMembers: 2
    }],
    turns: [{
      turnId: "turn_review",
      kind: "discussion",
      speakerAgentId: agent.agentId,
      runId: "run_review",
      state: "completed",
      waveId: "wave_contribution_1",
      waveMemberOrdinal: 1,
      terminalReason: null
    }, {
      turnId: "turn_builder",
      kind: "discussion",
      speakerAgentId: secondAgent.agentId,
      runId: "run_builder",
      state: "working",
      waveId: "wave_contribution_1",
      waveMemberOrdinal: 2,
      terminalReason: null
    }]
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    requests.push({
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(init.credentials ? { credentials: init.credentials } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      method,
      path
    });
    if (path === "/api/auth/status") {
      return jsonResponse({ mode: "local", state: "local_bootstrap" });
    }
    if (path === "/api/bootstrap") {
      return jsonResponse({
        user: { userId: "user_test", displayName: "Local Owner" },
        session: { token: "session_test" }
      });
    }
    if (path === "/api/teams" && method === "POST") {
      const name = (JSON.parse(String(init.body)) as { name: string }).name;
      return jsonResponse({ team: name === secondTeam.name ? secondTeam : team });
    }
    if (path === "/api/teams?includeArchived=true") {
      const createdNames = requests
        .filter((request) => request.path === "/api/teams" && request.method === "POST")
        .map((request) => (JSON.parse(request.body ?? "{}") as { name?: string }).name);
      return jsonResponse([
        ...(createdNames.includes(team.name)
          ? [{ ...team, name: teamNameValue, archivedAt: teamArchivedAt }]
          : []),
        ...(createdNames.includes(secondTeam.name) ? [secondTeam] : [])
      ]);
    }
    if (path === "/api/teams") {
      const createdNames = requests
        .filter((request) => request.path === "/api/teams" && request.method === "POST")
        .map((request) => (JSON.parse(request.body ?? "{}") as { name?: string }).name);
      return jsonResponse([
        ...(createdNames.includes(team.name) && !teamArchivedAt
          ? [{ ...team, name: teamNameValue, archivedAt: null }]
          : []),
        ...(createdNames.includes(secondTeam.name) ? [secondTeam] : [])
      ]);
    }
    if (path === `/api/teams/${team.teamId}` && method === "PATCH") {
      const update = JSON.parse(String(init.body)) as { name?: string; archived?: boolean };
      if (update.name) teamNameValue = update.name;
      if (update.archived !== undefined) {
        teamArchivedAt = update.archived ? "2026-08-24T00:00:00.000Z" : null;
      }
      return jsonResponse({ ...team, name: teamNameValue, archivedAt: teamArchivedAt });
    }
    if (path === `/api/teams/${team.teamId}/rooms` && method === "POST") {
      roomWasCreated = true;
      return jsonResponse({ ...room, settingsRevision: roomSettingsRevision });
    }
    if (path === `/api/teams/${team.teamId}/rooms`) {
      return jsonResponse(roomWasCreated && !roomArchivedAt
          ? [{
              ...room,
              name: roomNameValue,
              settingsRevision: roomSettingsRevision,
              archivedAt: null
            }]
        : []);
    }
    if (path === `/api/teams/${team.teamId}/rooms?includeArchived=true`) {
      return jsonResponse(roomWasCreated
        ? [{
            ...room,
            name: roomNameValue,
            settingsRevision: roomSettingsRevision,
            archivedAt: roomArchivedAt
          }]
        : []);
    }
    if (path === `/api/teams/${secondTeam.teamId}/rooms?includeArchived=true`) {
      return jsonResponse([]);
    }
    if (path === `/api/rooms/${room.roomId}` && method === "PATCH") {
      const update = JSON.parse(String(init.body)) as { name?: string; archived?: boolean };
      if (update.name) roomNameValue = update.name;
      if (update.archived !== undefined) {
        roomArchivedAt = update.archived ? "2026-08-24T00:00:00.000Z" : null;
      }
      return jsonResponse({
        ...room,
        name: roomNameValue,
        settingsRevision: roomSettingsRevision,
        archivedAt: roomArchivedAt
      });
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
    if (path === `/api/rooms/${room.roomId}/messages` && method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        clientMessageId: string;
        content: string;
      };
      if (body.content === "需要重试" && !failedClientMessageIds.has(body.clientMessageId)) {
        failedClientMessageIds.add(body.clientMessageId);
        return new Response(JSON.stringify({ error: "temporary failure" }), {
          headers: { "content-type": "application/json" },
          status: 503
        });
      }
      messageWasSent = true;
      return jsonResponse({
        message: { ...memberMessage, content: body.content },
        runs: []
      });
    }
    if (path === `/api/rooms/${room.roomId}/messages?limit=100&tail=true`) {
      return jsonResponse({
        items: messageWasSent ? [memberMessage, agentMessage] : [],
        nextCursor: null,
        syncCursor: "cursor-latest"
      });
    }
    if (path === `/api/rooms/${room.roomId}/messages?limit=100&cursor=cursor-latest`) {
      return jsonResponse({
        items: streamFinal ? [streamAgentMessage] : [],
        nextCursor: null,
        syncCursor: streamFinal ? "cursor-stream-final" : "cursor-latest"
      });
    }
    if (path === `/api/rooms/${room.roomId}/runs`) {
      return jsonResponse(discussionState ? discussionRuns : []);
    }
    if (path === `/api/rooms/${room.roomId}/tasks` && method === "POST") {
      const body = JSON.parse(String(init.body)) as { title: string; goal: string };
      const task = {
        ...roomTask,
        taskId: "task_oauth",
        title: body.title,
        goal: body.goal,
        isDefault: false,
        updatedAt: "2026-08-23T00:05:00.000Z"
      };
      roomTasks.push(task);
      return jsonResponse(task);
    }
    if (path === `/api/rooms/${room.roomId}/tasks`) {
      return jsonResponse(roomTasks);
    }
    if (path.startsWith("/api/tasks/") && path.endsWith("/clarifications")) {
      return jsonResponse([]);
    }
    if (path.startsWith("/api/tasks/") && path.endsWith("/artifacts")) {
      return jsonResponse({ revision: 0, artifacts: [] });
    }
    if (path.startsWith("/api/runs/run_builder/events?after=")) {
      const after = Number.parseInt(path.split("after=")[1] ?? "0", 10);
      if (after === 0) {
        return jsonResponse([
          { sequence: 1, event: { type: "status", sequence: 1, status: "working" } },
          {
            sequence: 2,
            event: { type: "output", sequence: 2, content: "正在分析中央服务输出" }
          }
        ]);
      }
      if (after === 2 && streamFinal) {
        return jsonResponse([
          {
            sequence: 3,
            event: { type: "reply", sequence: 3, content: "流式最终回复" }
          },
          { sequence: 4, event: { type: "status", sequence: 4, status: "completed" } }
        ]);
      }
      return jsonResponse([]);
    }
    if (path === `/api/rooms/${room.roomId}/settings` && method === "PUT") {
      const updated = JSON.parse(String(init.body)) as {
        memberIds: string[];
        agentIds: string[];
        collaborationPolicy: typeof roomPolicy;
        expectedRevision: number;
      };
      assert.equal(updated.expectedRevision, roomSettingsRevision);
      roomAgentIds = updated.agentIds;
      Object.assign(roomPolicy, updated.collaborationPolicy);
      roomSettingsRevision += 1;
      return jsonResponse({
        room: {
          ...room,
          name: roomNameValue,
          settingsRevision: roomSettingsRevision,
          archivedAt: roomArchivedAt
        },
        participants: {
          memberIds: updated.memberIds,
          agentIds: updated.agentIds
        }
      });
    }
    if (path === `/api/rooms/${room.roomId}/settings`) {
      return jsonResponse({
        room: {
          ...room,
          name: roomNameValue,
          settingsRevision: roomSettingsRevision,
          archivedAt: roomArchivedAt
        },
        participants: {
          memberIds: [member.memberId],
          agentIds: roomAgentIds
        }
      });
    }
    if (path === `/api/rooms/${room.roomId}/participants`) {
      return jsonResponse({ memberIds: [member.memberId], agentIds: roomAgentIds });
    }
    if (path === `/api/rooms/${room.roomId}/discussions` && method === "POST") {
      discussionGoal = (JSON.parse(String(init.body)) as { goal: string }).goal;
      discussionState = "active";
      return jsonResponse(discussionView());
    }
    if (path === `/api/rooms/${room.roomId}/discussions`) {
      return jsonResponse(discussionState ? [discussionView()] : []);
    }
    if (path === "/api/discussions/discussion_test/actions" && method === "POST") {
      const action = JSON.parse(String(init.body)) as { action: string };
      discussionState = action.action === "finish" ? "stop_requested" : discussionState;
      return jsonResponse(discussionView());
    }
    if (path === `/api/teams/${team.teamId}/devices/${device.deviceId}` && method === "DELETE") {
      return jsonResponse({ ...device, status: "revoked" });
    }
    if (path === `/api/teams/${team.teamId}/devices`) {
      return jsonResponse([device]);
    }
    if (path === `/api/teams/${secondTeam.teamId}/devices`) {
      return jsonResponse([]);
    }
    if (path === `/api/teams/${team.teamId}/agent-provision-requests` && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      provisionRequest = {
        requestId: body.requestId,
        teamId: team.teamId,
        deviceId: body.deviceId,
        templateAgentId: body.templateAgentId,
        agentId: "agent_release_reviewer",
        requestedByMemberId: member.memberId,
        name: body.name,
        role: body.role,
        status: "delivered",
        rejectionReason: null,
        createdAt: "2026-08-23T00:20:00.000Z",
        deliveredAt: "2026-08-23T00:20:01.000Z",
        respondedAt: null,
        readyAt: null,
        updatedAt: "2026-08-23T00:20:01.000Z"
      };
      return jsonResponse(provisionRequest);
    }
    if (path === `/api/teams/${team.teamId}/agent-provision-requests`) {
      return jsonResponse(provisionRequest
        ? [{
            ...provisionRequest,
            status: provisionReady ? "ready" : "delivered",
            respondedAt: provisionReady ? "2026-08-23T00:20:02.000Z" : null,
            readyAt: provisionReady ? "2026-08-23T00:20:03.000Z" : null,
            updatedAt: provisionReady
              ? "2026-08-23T00:20:03.000Z"
              : "2026-08-23T00:20:01.000Z"
          }]
        : []);
    }
    if (path === `/api/teams/${team.teamId}/members`) {
      return jsonResponse([member]);
    }
    if (path === `/api/teams/${secondTeam.teamId}/members`) {
      return jsonResponse([{ ...member, memberId: "member_second", teamId: secondTeam.teamId }]);
    }
    if (path === `/api/agents/${agent.agentId}` && method === "PATCH") {
      reviewAgentEnabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      return jsonResponse({ ...agent, enabled: reviewAgentEnabled });
    }
    if (path.endsWith("/agents")) {
      return jsonResponse([{ ...agent, enabled: reviewAgentEnabled }, secondAgent]);
    }
    if (path.endsWith("/rooms")) {
      return jsonResponse([]);
    }
    if (/^\/api\/teams\/[^/]+\/changes\?after=/u.test(path)) {
      if (discussionState && !discussionChangeDelivered) {
        discussionChangeDelivered = true;
        return jsonResponse({ changed: true, cursor: 1, reset: false });
      }
      if (streamFinal && !streamChangeDelivered) {
        streamChangeDelivered = true;
        return jsonResponse({ changed: true, cursor: 2, reset: false });
      }
      return jsonResponse({
        changed: false,
        cursor: streamChangeDelivered ? 2 : discussionChangeDelivered ? 1 : 0,
        reset: false
      });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const teamHeading = await screen.findByRole("heading", { name: "创建你的第一个 Team" });
    const teamStep = teamHeading.closest("section");
    assert.ok(teamStep);
    assert.equal(dom.window.document.documentElement.lang, "zh-CN");
    assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
    assert.equal(requests[0]?.path, "/api/auth/status");
    assert.equal(requests.every(({ credentials }) => credentials === "same-origin"), true);

    fireEvent.click(screen.getByRole("button", { name: "主题" }));
    await waitFor(() => assert.equal(dom.window.document.documentElement.dataset.theme, "light"));
    assert.equal(localStorage.getItem("agent-room.theme"), "light");
    fireEvent.click(screen.getByRole("button", { name: "主题" }));
    await waitFor(() => assert.equal(dom.window.document.documentElement.dataset.theme, "dark"));
    assert.equal(localStorage.getItem("agent-room.theme"), "dark");

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
    fireEvent.click(screen.getByRole("button", { name: "新建 Team" }));
    const teamDialog = screen.getByRole("dialog", { name: "新建 Team" });
    fireEvent.change(within(teamDialog).getByLabelText("新 Team 名称"), {
      target: { value: secondTeam.name }
    });
    fireEvent.click(within(teamDialog).getByRole("button", { name: "创建 Team" }));
    await screen.findByRole("heading", { name: "创建一个对话房间" });
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "新建 Team" }), null));
    assert.ok(screen.getByTitle(secondTeam.name).classList.contains("active"));
    fireEvent.click(screen.getByTitle(team.name));
    await screen.findByRole("heading", { name: "在房间中开始对话 #general" });
    assert.equal(screen.queryByLabelText("新建假智能体名称"), null);
    assert.equal(screen.queryByLabelText("新 Team 名称"), null);
    const participants = screen.getByRole("region", { name: "房间成员" });
    await within(participants).findByText("Local Owner");
    within(participants).getByText("Team 所有者");
    const roomSidebar = participants.closest("aside");
    assert.ok(roomSidebar);
    assert.equal(within(roomSidebar).queryByRole("navigation"), null);
    assert.equal(within(roomSidebar).queryByRole("contentinfo"), null);
    assert.equal(within(roomSidebar).queryByLabelText("新房间名称"), null);
    assert.equal((screen.getByLabelText("选择房间") as HTMLSelectElement).value, room.roomId);
    screen.getByLabelText("新房间名称");
    assert.equal(screen.queryByRole("combobox", { name: "提及智能体" }), null);

    fireEvent.click(screen.getByRole("button", { name: "资源生命周期" }));
    const lifecycleDialog = await screen.findByRole("dialog", { name: "管理 Team 与房间" });
    const lifecycleTeamName = within(lifecycleDialog).getByLabelText("Team 名称");
    fireEvent.change(lifecycleTeamName, { target: { value: "Delivery Team" } });
    const teamResource = lifecycleTeamName.closest("section");
    assert.ok(teamResource);
    fireEvent.click(within(teamResource).getByRole("button", { name: "保存名称" }));
    await within(lifecycleDialog).findByText("Delivery Team");

    const lifecycleRoomName = within(lifecycleDialog).getByLabelText("general 房间名称");
    fireEvent.change(lifecycleRoomName, { target: { value: "delivery" } });
    const roomResource = lifecycleRoomName.closest("section");
    assert.ok(roomResource);
    fireEvent.click(within(roomResource).getByRole("button", { name: "保存名称" }));
    const renamedRoomInput = await within(lifecycleDialog).findByLabelText("delivery 房间名称");
    const renamedRoomResource = renamedRoomInput.closest("section");
    assert.ok(renamedRoomResource);
    fireEvent.click(within(lifecycleDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => assert.equal(
      screen.queryByRole("dialog", { name: "管理 Team 与房间" }),
      null
    ));
    await screen.findByRole("heading", { name: "# delivery" });

    fireEvent.click(screen.getByRole("button", { name: "房间操作" }));
    let roomActions = screen.getByRole("menu", { name: "房间操作" });
    within(roomActions).getByText("归档后可从资源生命周期恢复。");
    fireEvent.click(within(roomActions).getByRole("menuitem", { name: "归档房间" }));
    let archiveDialog = screen.getByRole("dialog", { name: "归档 #delivery" });
    within(archiveDialog).getByText(/消息、运行、讨论和稳定 ID 都会保留/u);
    fireEvent.click(within(archiveDialog).getAllByRole("button", { name: "取消" }).at(-1)!);
    assert.equal(screen.queryByRole("dialog", { name: "归档 #delivery" }), null);

    fireEvent.click(screen.getByRole("button", { name: "房间操作" }));
    roomActions = screen.getByRole("menu", { name: "房间操作" });
    fireEvent.click(within(roomActions).getByRole("menuitem", { name: "归档房间" }));
    archiveDialog = screen.getByRole("dialog", { name: "归档 #delivery" });
    fireEvent.click(within(archiveDialog).getByRole("button", { name: "确认归档房间" }));
    await screen.findByRole("heading", { name: "选择一个房间" });
    const shortcutArchiveRequest = requests.findLast((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}` &&
      candidate.method === "PATCH" &&
      JSON.parse(candidate.body ?? "{}").archived === true
    );
    assert.ok(shortcutArchiveRequest);

    fireEvent.click(screen.getByRole("button", { name: "资源生命周期" }));
    const reopenedLifecycleDialog = await screen.findByRole("dialog", { name: "管理 Team 与房间" });
    const restoreRoom = await within(reopenedLifecycleDialog).findByRole("button", { name: "恢复房间" });
    fireEvent.click(restoreRoom);
    await within(reopenedLifecycleDialog).findByRole("button", { name: "归档房间" });

    const currentTeamResource = within(reopenedLifecycleDialog).getByLabelText("Team 名称")
      .closest("section");
    assert.ok(currentTeamResource);
    fireEvent.click(within(currentTeamResource).getByRole("button", { name: "归档 Team" }));
    const restoreTeam = await within(reopenedLifecycleDialog).findByRole("button", { name: "恢复 Team" });
    fireEvent.click(restoreTeam);
    await within(reopenedLifecycleDialog).findByRole("button", { name: "归档 Team" });
    fireEvent.click(within(reopenedLifecycleDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => assert.equal(
      screen.queryByRole("dialog", { name: "管理 Team 与房间" }),
      null
    ));
    fireEvent.click(screen.getByTitle("Delivery Team"));
    await screen.findByRole("heading", { name: "在房间中开始对话 #delivery" });
    await within(screen.getByRole("region", { name: "房间成员" })).findByText("Review Bot");

    const messageInput = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(messageInput, { target: { value: "请 @Rev" } });
    within(screen.getByRole("listbox", { name: "提及智能体" }))
      .getByRole("option", { name: /@Review Bot/u });
    fireEvent.keyDown(messageInput, { key: "Enter" });
    assert.equal(messageInput.value, "请 @Review Bot ");
    screen.getByRole("button", { name: "移除提及 Review Bot（Team 成员）" });
    fireEvent.change(messageInput, { target: { value: "请" } });
    assert.equal(screen.queryByRole("button", { name: "移除提及 Review Bot（Team 成员）" }), null);
    fireEvent.click(screen.getByRole("button", { name: "智能体管理" }));

    await screen.findByRole("heading", { name: "智能体与设备" });
    screen.getByRole("heading", { name: "Team 智能体" });
    screen.getByText("托管本地 Codex");
    screen.getByText(/这不是智能体名称/u);
    await screen.findByRole("heading", { name: "从我的 Bridge 创建 Agent" });
    assert.equal(
      (screen.getByLabelText("我的在线 Bridge") as HTMLSelectElement).value,
      device.deviceId
    );
    assert.equal(
      (screen.getByLabelText("本地模板 Agent") as HTMLSelectElement).value,
      secondAgent.agentId
    );
    fireEvent.change(screen.getByLabelText("新 Agent 名称"), {
      target: { value: "Release Reviewer" }
    });
    fireEvent.change(screen.getByLabelText("角色"), {
      target: { value: "Release reviewer" }
    });
    const managementCode = screen.getByLabelText("Bridge 管理码") as HTMLInputElement;
    fireEvent.change(managementCode, { target: { value: "246810" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建 Agent" }).closest("form")!);
    await screen.findByText("Bridge 已收到", { selector: ".status-badge" });
    assert.equal(managementCode.value, "");
    const provisionPost = requests.find((candidate) =>
      candidate.path === `/api/teams/${team.teamId}/agent-provision-requests` &&
      candidate.method === "POST"
    );
    const provisionBody = JSON.parse(provisionPost?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(provisionBody, {
      requestId: provisionBody.requestId,
      deviceId: device.deviceId,
      templateAgentId: secondAgent.agentId,
      name: "Release Reviewer",
      role: "Release reviewer",
      managementCode: "246810"
    });
    assert.doesNotMatch(
      JSON.stringify(provisionRequest),
      /246810|managementCode|workspace|command|credential|tool/u
    );
    provisionReady = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await screen.findByText("已就绪", { selector: ".status-badge" });
    const reviewCard = screen.getByRole("heading", { name: "Review Bot" }).closest("article");
    assert.ok(reviewCard);
    fireEvent.click(within(reviewCard).getByRole("button", { name: "停用" }));
    const enableReview = await within(reviewCard).findByRole("button", { name: "重新启用" });
    fireEvent.click(enableReview);
    await within(reviewCard).findByRole("button", { name: "停用" });

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

    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("button", { name: "+ 新任务" }));
    const taskDialog = await screen.findByRole("dialog", { name: "创建长期任务" });
    fireEvent.change(within(taskDialog).getByLabelText("任务名称"), {
      target: { value: "OAuth 迁移" }
    });
    fireEvent.change(within(taskDialog).getByLabelText("目标与完成口径"), {
      target: { value: "完成 OAuth 迁移并通过回归测试。" }
    });
    fireEvent.click(within(taskDialog).getByRole("button", { name: "创建并切换" }));
    await waitFor(() => assert.equal(
      (screen.getByLabelText("当前任务") as HTMLSelectElement).value,
      "task_oauth"
    ));
    const createTaskRequest = requests.find((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}/tasks` &&
      candidate.method === "POST"
    );
    assert.deepEqual(JSON.parse(createTaskRequest?.body ?? "{}"), {
      title: "OAuth 迁移",
      goal: "完成 OAuth 迁移并通过回归测试。"
    });
    fireEvent.change(screen.getByLabelText("当前任务"), {
      target: { value: roomTask.taskId }
    });

    const roomMessageInput = screen.getByLabelText("消息");
    fireEvent.change(roomMessageInput, { target: { value: "请回答" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const timeline = await screen.findByRole("region", { name: "房间消息" });
    within(timeline).getByText("Review Bot");
    within(timeline).getByText("已经完成");
    const plainMessageBody = JSON.parse(requests.find((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}/messages` &&
      candidate.method === "POST"
    )?.body ?? "{}") as { clientMessageId: string; content: string };
    assert.equal(plainMessageBody.content, "请回答");
    assert.match(plainMessageBody.clientMessageId, /^client_[A-Za-z0-9_-]{8,128}$/u);

    assert.equal(screen.queryByRole("tab", { name: "发起讨论" }), null);
    fireEvent.change(roomMessageInput, { target: { value: "请 @Rev" } });
    fireEvent.click(within(screen.getByRole("listbox", { name: "提及智能体" }))
      .getByRole("option", { name: /@Review Bot/u }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const messageRequests = requests.filter((candidate) =>
        candidate.path === `/api/rooms/${room.roomId}/messages` &&
        candidate.method === "POST"
      );
      const body = JSON.parse(messageRequests.at(-1)?.body ?? "{}") as {
        clientMessageId: string;
        content: string;
        mentionAgentId: string;
      };
      assert.equal(body.content, "请 @Review Bot ");
      assert.equal(body.mentionAgentId, agent.agentId);
      assert.match(body.clientMessageId, /^client_[A-Za-z0-9_-]{8,128}$/u);
    });

    fireEvent.change(roomMessageInput, {
      target: { value: "请 @Local Codex 精确执行" }
    });
    screen.getByText("精确匹配：@Local Codex");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const messageRequests = requests.filter((candidate) =>
        candidate.path === `/api/rooms/${room.roomId}/messages` &&
        candidate.method === "POST"
      );
      const body = JSON.parse(messageRequests.at(-1)?.body ?? "{}") as {
        content: string;
        mentionAgentId: string;
      };
      assert.equal(body.content, "请 @Local Codex 精确执行");
      assert.equal(body.mentionAgentId, secondAgent.agentId);
    });

    const keepMentionsSwitch = screen.getByRole("switch", { name: "保留上次 @" }) as HTMLInputElement;
    assert.equal(keepMentionsSwitch.checked, false);
    fireEvent.click(keepMentionsSwitch);
    fireEvent.change(roomMessageInput, { target: { value: "@Local Codex 连续对话第一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.equal((roomMessageInput as HTMLTextAreaElement).value, "@Local Codex "));
    screen.getByRole("button", { name: "移除提及 Local Codex（Codex 执行者）" });
    assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(roomMessageInput, { target: { value: "@Local Codex 接着解释" } });
    await waitFor(() => assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const lastMessage = requests.findLast((candidate) => candidate.method === "POST" && candidate.path.endsWith("/messages"));
      assert.equal(JSON.parse(lastMessage?.body ?? "{}").content, "@Local Codex 接着解释");
      assert.equal(JSON.parse(lastMessage?.body ?? "{}").mentionAgentId, secondAgent.agentId);
    });
    fireEvent.change(roomMessageInput, { target: { value: "@Local Codex 保留这段新正文" } });
    fireEvent.click(keepMentionsSwitch);
    assert.equal((roomMessageInput as HTMLTextAreaElement).value, "保留这段新正文");
    assert.equal(screen.queryByRole("button", { name: "移除提及 Local Codex（Codex 执行者）" }), null);

    fireEvent.change(roomMessageInput, { target: { value: "确定交付恢复规则 @all" } });
    screen.getByText("精确指令 @all · 将路由当前房间 2 个智能体");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const discussionPanel = await screen.findByRole("region", { name: "当前智能体讨论" });
    within(discussionPanel).getByText("讨论中 · 第1轮");
    within(discussionPanel).getByText("确定交付恢复规则 @all");
    within(discussionPanel).getByLabelText("智能体进度 1/2");
    assert.equal(within(discussionPanel).queryByRole("list", { name: "第1轮并行进度" }), null);
    fireEvent.click(within(discussionPanel).getByRole("button", { name: /展开讨论详情/u }));
    within(discussionPanel).getByText("1/2 已结束");
    const waveProgress = within(discussionPanel).getByRole("list", { name: "第1轮并行进度" });
    assert.equal(within(waveProgress).getAllByRole("listitem").length, 2);
    const reviewProgress = within(waveProgress).getByText("Review Bot").closest("li");
    const builderProgress = within(waveProgress).getByText("Local Codex").closest("li");
    assert.ok(reviewProgress);
    assert.ok(builderProgress);
    within(reviewProgress).getByText("已完成");
    within(builderProgress).getByText("执行中");
    fireEvent.click(screen.getByRole("button", { name: "房间操作" }));
    const activeRoomActions = screen.getByRole("menu", { name: "房间操作" });
    const blockedArchive = within(activeRoomActions).getByRole("menuitem", { name: "归档房间" }) as HTMLButtonElement;
    assert.equal(blockedArchive.disabled, true);
    within(activeRoomActions).getByText("存在活动运行或讨论，暂时无法归档。");
    assert.equal(screen.queryByRole("dialog", { name: /归档 #/u }), null);
    fireEvent.click(screen.getByRole("button", { name: "房间操作" }));
    await within(timeline).findByText("正在分析中央服务输出");
    within(timeline).getByText("正在生成…");
    await waitFor(() => {
      const request = requests.find((candidate) =>
        candidate.path === `/api/rooms/${room.roomId}/discussions` &&
        candidate.method === "POST"
      );
      assert.deepEqual(JSON.parse(request?.body ?? "{}"), {
        taskId: roomTask.taskId,
        goal: "确定交付恢复规则 @all",
        participantAgentIds: [agent.agentId, secondAgent.agentId],
        mode: "round_robin",
        outputMode: "final_answer"
      });
    });
    streamFinal = true;
    await within(timeline).findByText("流式最终回复");
    await waitFor(() => assert.equal(within(timeline).queryByText("正在生成…"), null));
    assert.equal(within(timeline).getAllByText("流式最终回复").length, 1);
    fireEvent.click(within(discussionPanel).getByRole("button", { name: "结束并生成结论" }));
    await screen.findByText("将在本轮后停止");

    let currentParticipants = screen.getByRole("region", { name: "房间成员" });
    fireEvent.click(within(currentParticipants).getByRole("button", { name: "房间设置" }));
    let participantDialog = await screen.findByRole("dialog", { name: "房间设置" });
    const ownerCheckbox = within(participantDialog).getByRole("checkbox", {
      name: /Local Owner/u
    }) as HTMLInputElement;
    assert.equal(ownerCheckbox.checked, true);
    assert.equal(ownerCheckbox.disabled, true);
    fireEvent.change(within(participantDialog).getByRole("combobox", { name: "最大接力深度" }), {
      target: { value: "2" }
    });
    fireEvent.click(within(participantDialog).getByRole("checkbox", { name: /允许多 Agent 讨论/u }));
    fireEvent.click(within(participantDialog).getByRole("checkbox", { name: /允许 @all/u }));
    fireEvent.click(within(participantDialog).getByRole("checkbox", { name: /允许 Agent 互相点名/u }));
    let saveButton = await within(participantDialog).findByRole("button", { name: "保存" });
    await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, false));
    await act(async () => {
      fireEvent.click(saveButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => assert.equal(
      screen.queryByRole("dialog", { name: "房间设置" }),
      null
    ));
    const policyRequest = requests.findLast((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}/settings` &&
      candidate.method === "PUT"
    );
    assert.deepEqual(JSON.parse(policyRequest?.body ?? "{}"), {
      memberIds: [member.memberId],
      agentIds: [agent.agentId, secondAgent.agentId],
      collaborationPolicy: {
        allowDiscussion: false,
        allowAll: false,
        allowAgentMentions: false,
        maxAgentMentionDepth: 2
      },
      expectedRevision: 1
    });
    screen.getByText("单次并行回复");
    screen.getByText("禁用 @all");
    screen.getByText("Agent 接力关闭");

    const discussionRequestsBeforeOneShot = requests.filter((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}/discussions` &&
      candidate.method === "POST"
    ).length;
    fireEvent.change(roomMessageInput, {
      target: { value: "@all 请一起分析" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    assert.equal(
      screen.getByRole("alert").textContent,
      "操作失败：当前房间设置不允许使用 @all。"
    );
    fireEvent.change(roomMessageInput, {
      target: { value: "请 @Review Bot 和 @Local Codex 各回复一次" }
    });
    assert.equal(screen.queryByRole("alert"), null);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const messageRequests = requests.filter((candidate) =>
        candidate.path === `/api/rooms/${room.roomId}/messages` &&
        candidate.method === "POST"
      );
      const body = JSON.parse(messageRequests.at(-1)?.body ?? "{}") as {
        content: string;
        mentionAgentIds: string[];
      };
      assert.equal(body.content, "请 @Review Bot 和 @Local Codex 各回复一次");
      assert.deepEqual(body.mentionAgentIds, [agent.agentId, secondAgent.agentId]);
    });
    assert.equal(requests.filter((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}/discussions` &&
      candidate.method === "POST"
    ).length, discussionRequestsBeforeOneShot);

    currentParticipants = screen.getByRole("region", { name: "房间成员" });
    fireEvent.click(within(currentParticipants).getByRole("button", { name: "房间设置" }));
    participantDialog = await screen.findByRole("dialog", { name: "房间设置" });
    fireEvent.click(within(participantDialog).getByRole("checkbox", { name: /Local Codex/u }));
    saveButton = within(participantDialog).getByRole("button", { name: "保存" });
    await act(async () => {
      fireEvent.click(saveButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "房间设置" }), null));
    const participantRequest = requests.findLast((candidate) =>
      candidate.path === `/api/rooms/${room.roomId}/settings` &&
      candidate.method === "PUT"
    );
    assert.deepEqual(JSON.parse(participantRequest?.body ?? "{}"), {
      memberIds: [member.memberId],
      agentIds: [agent.agentId],
      collaborationPolicy: {
        allowDiscussion: false,
        allowAll: false,
        allowAgentMentions: false,
        maxAgentMentionDepth: 2
      },
      expectedRevision: 2
    });
    currentParticipants = screen.getByRole("region", { name: "房间成员" });
    assert.equal(within(currentParticipants).queryByText("Local Codex"), null);
    fireEvent.change(roomMessageInput, { target: { value: "请 @Local" } });
    const filteredSuggestions = screen.getByRole("listbox", { name: "提及智能体" });
    assert.equal(within(filteredSuggestions).queryByRole("option", { name: /@Local Codex/u }), null);
    fireEvent.change(roomMessageInput, { target: { value: "需要重试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const retryButton = await screen.findByRole("button", { name: "使用同一消息 ID 重试" });
    assert.equal((roomMessageInput as HTMLTextAreaElement).value, "");
    fireEvent.click(retryButton);
    await waitFor(() => assert.equal(
      screen.queryByRole("button", { name: "使用同一消息 ID 重试" }),
      null
    ));
    const retryRequests = requests.filter((candidate) => {
      if (
        candidate.path !== `/api/rooms/${room.roomId}/messages` ||
        candidate.method !== "POST"
      ) return false;
      return (JSON.parse(candidate.body ?? "{}") as { content?: string }).content === "需要重试";
    });
    assert.equal(retryRequests.length, 2);
    assert.equal(
      (JSON.parse(retryRequests[0]?.body ?? "{}") as { clientMessageId: string })
        .clientMessageId,
      (JSON.parse(retryRequests[1]?.body ?? "{}") as { clientMessageId: string })
        .clientMessageId
    );
  } finally {
    cleanup();
    dom.window.close();
  }
});
