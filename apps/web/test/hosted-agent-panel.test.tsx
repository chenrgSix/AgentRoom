import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HostedAgentPanel, hostedFailureHelp } from "../src/features/agent/HostedAgentPanel.js";
import {
  integrationLabel,
  presenceHelp
} from "../src/features/agent/AgentWorkspace.js";
import type {
  Agent,
  HostedAgentConfiguration,
  HostedProviderTestObservation,
  Room
} from "../src/models.js";

interface RequestRecord {
  body?: unknown;
  cache?: RequestCache;
  method: string;
  path: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
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

const teamId = "team_hosted_0001";
const rooms: Room[] = [{
  roomId: "room_general_0001",
  teamId,
  name: "general",
  settingsRevision: 1,
  createdAt: "2026-08-30T00:00:00.000Z"
}, {
  roomId: "room_archived_0001",
  teamId,
  name: "archived",
  settingsRevision: 1,
  createdAt: "2026-08-30T00:00:00.000Z",
  archivedAt: "2026-08-30T01:00:00.000Z"
}];

function observation(
  status: HostedProviderTestObservation["status"] = "succeeded",
  failureCode: string | null = null,
  revision = 1
): HostedProviderTestObservation {
  return {
    observationId: `op_test_${revision}`,
    teamId,
    agentId: "agent_hosted_0001",
    profileRevision: revision,
    provider: "openai_responses",
    model: revision === 1 ? "gpt-5.4" : "gpt-5.5",
    status,
    failureCode,
    observedAt: "2026-08-30T02:00:00.000Z"
  };
}

function configuration(
  overrides: Partial<HostedAgentConfiguration> = {}
): HostedAgentConfiguration {
  return {
    agentId: "agent_hosted_0001",
    teamId,
    name: "Central Reviewer",
    role: "Reviewer",
    enabled: true,
    presence: "ready",
    roomIds: [rooms[0]!.roomId],
    profileRevision: 1,
    provider: "openai_responses",
    model: "gpt-5.4",
    credentialConfigured: true,
    credentialRevoked: false,
    configurationLocked: false,
    hasActiveWork: false,
    latestTest: observation(),
    updatedAt: "2026-08-30T02:00:00.000Z",
    ...overrides
  };
}

test("non-Owners never render or load Hosted Agent configuration", async () => {
  const dom = installDom();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return jsonResponse([]);
  };
  const { cleanup, render, waitFor } = await import("@testing-library/react");
  try {
    const view = render(
      <HostedAgentPanel
        agents={[]}
        currentMemberIsOwner={false}
        locale="zh-CN"
        rooms={rooms}
        sessionToken="session_member"
        teamId={teamId}
      />
    );
    await waitFor(() => assert.equal(fetchCount, 0));
    assert.equal(view.container.textContent, "");
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("creation keeps Rooms explicit and clears API keys after failure and success", async () => {
  const dom = installDom();
  const requests: RequestRecord[] = [];
  const created = configuration({ roomIds: [], presence: "degraded" });
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({
      ...(body === undefined ? {} : { body }),
      ...(init.cache ? { cache: init.cache } : {}),
      method,
      path
    });
    if (path === `/api/teams/${teamId}/hosted-agents` && method === "GET") {
      return jsonResponse([]);
    }
    if (path === `/api/teams/${teamId}/hosted-agent-tests`) {
      return jsonResponse({
        error: { message: "provider rejected sk-failed-browser-secret" }
      }, 502);
    }
    if (path === `/api/teams/${teamId}/hosted-agents` && method === "POST") {
      return jsonResponse(created);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } =
    await import("@testing-library/react");
  try {
    render(
      <HostedAgentPanel
        agents={[]}
        currentMemberIsOwner
        locale="zh-CN"
        rooms={rooms}
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    await page.findByText("尚未配置中央 Agent；这是可选功能，不影响其他 Agent。");
    const createButton = page.getByRole("button", { name: "验证并创建" });
    const form = createButton.closest("form")!;
    const create = within(form);
    const roomCheckbox = create.getByRole("checkbox", { name: "# general" }) as HTMLInputElement;
    assert.equal(roomCheckbox.checked, false);
    assert.equal(create.queryByRole("checkbox", { name: "# archived" }), null);

    fireEvent.change(create.getByLabelText("Agent 名称"), {
      target: { value: "Central Reviewer" }
    });
    fireEvent.change(create.getByLabelText("Agent 角色"), {
      target: { value: "Reviewer" }
    });
    fireEvent.change(create.getByLabelText("模型"), {
      target: { value: "gpt-5.4" }
    });
    const apiKey = create.getByLabelText(/模型 API Key/u) as HTMLInputElement;
    fireEvent.change(apiKey, { target: { value: "sk-failed-browser-secret" } });
    fireEvent.click(create.getByText("只测试连接（可选）"));
    fireEvent.click(create.getByRole("button", { name: "测试连接" }));
    await page.findByRole("alert");
    await waitFor(() => assert.equal(apiKey.value, ""));
    assert.doesNotMatch(page.getByRole("alert").textContent ?? "", /sk-failed-browser-secret/u);

    fireEvent.change(apiKey, { target: { value: "sk-create-browser-secret" } });
    fireEvent.submit(form);
    await page.findByText("Central Reviewer", { selector: "h4" });
    await waitFor(() => assert.equal(apiKey.value, ""));

    const failedTestRequest = requests.find(({ path }) =>
      path === `/api/teams/${teamId}/hosted-agent-tests`
    );
    assert.deepEqual(failedTestRequest?.body, {
      provider: "openai_responses",
      model: "gpt-5.4",
      apiKey: "sk-failed-browser-secret"
    });
    const createRequest = requests.find(({ path, method }) =>
      path === `/api/teams/${teamId}/hosted-agents` && method === "POST"
    );
    assert.deepEqual(createRequest?.body, {
      name: "Central Reviewer",
      role: "Reviewer",
      provider: "openai_responses",
      model: "gpt-5.4",
      apiKey: "sk-create-browser-secret",
      roomIds: []
    });
    assert.ok(requests.every(({ path }) => !path.includes("sk-")));
    assert.ok(requests.every(({ cache }) => cache === "no-store"));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("late Hosted mutations cannot project an Agent into a different Team", async () => {
  const dom = installDom();
  const secondTeamId = "team_hosted_0002";
  const requests: RequestRecord[] = [];
  const changed: Agent[] = [];
  let resolveCreate: ((response: Response) => void) | undefined;
  const pendingCreate = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    requests.push({ method, path });
    if (method === "GET" && path.endsWith("/hosted-agents")) {
      return jsonResponse([]);
    }
    if (path === `/api/teams/${teamId}/hosted-agents` && method === "POST") {
      return pendingCreate;
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { act, cleanup, fireEvent, render, waitFor, within } =
    await import("@testing-library/react");
  try {
    const view = render(
      <HostedAgentPanel
        agents={[]}
        currentMemberIsOwner
        key={teamId}
        locale="zh-CN"
        onAgentChanged={(agent) => changed.push(agent)}
        rooms={rooms}
        sessionToken="session_owner_a"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    await page.findByText("尚未配置中央 Agent；这是可选功能，不影响其他 Agent。");
    const createButton = page.getByRole("button", { name: "验证并创建" });
    const create = within(createButton.closest("form")!);
    fireEvent.change(create.getByLabelText("Agent 名称"), {
      target: { value: "Late Team A Agent" }
    });
    fireEvent.change(create.getByLabelText("Agent 角色"), {
      target: { value: "Reviewer" }
    });
    fireEvent.change(create.getByLabelText("模型"), {
      target: { value: "gpt-5.4" }
    });
    fireEvent.change(create.getByLabelText(/模型 API Key/u), {
      target: { value: "sk-late-team-secret" }
    });
    fireEvent.submit(createButton.closest("form")!);
    await waitFor(() => assert.ok(resolveCreate));

    view.rerender(
      <HostedAgentPanel
        agents={[]}
        currentMemberIsOwner
        key={secondTeamId}
        locale="zh-CN"
        onAgentChanged={(agent) => changed.push(agent)}
        rooms={[]}
        sessionToken="session_owner_b"
        teamId={secondTeamId}
      />
    );
    await waitFor(() => assert.ok(requests.some(({ path }) =>
      path === `/api/teams/${secondTeamId}/hosted-agents`
    )));
    await act(async () => {
      resolveCreate!(jsonResponse(configuration({
        agentId: "agent_late_team_a",
        name: "Late Team A Agent",
        teamId
      })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(changed.length, 0);
    assert.equal(page.queryByText("Late Team A Agent"), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("validate-and-create needs one request and only links explicitly authorized current-Team Rooms", async () => {
  const dom = installDom();
  const requests: RequestRecord[] = [];
  const openedRooms: string[] = [];
  const foreignRoom: Room = { ...rooms[0]!, roomId: "room_foreign", teamId: "team_foreign", name: "private-other-team" };
  const unrelatedRoom: Room = { ...rooms[0]!, roomId: "room_unselected", name: "unselected" };
  const availableRooms = [...rooms, foreignRoom, unrelatedRoom];
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "GET") return jsonResponse([]);
    if (path === `/api/teams/${teamId}/hosted-agents`) return jsonResponse(configuration());
    throw new Error("A separate connection test must not be sent during creation");
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(
      <HostedAgentPanel agents={[]} currentMemberIsOwner locale="zh-CN" onOpenRoom={(roomId) => openedRooms.push(roomId)} rooms={availableRooms} sessionToken="session_owner" teamId={teamId} />
    );
    const page = within(dom.window.document.body);
    await page.findByText(/尚未配置中央 Agent/u);
    const form = page.getByRole("button", { name: "验证并创建" }).closest("form")!;
    const create = within(form);
    assert.ok(create.queryByRole("checkbox", { name: "# private-other-team" }) === null);
    assert.ok(create.queryByRole("checkbox", { name: "# archived" }) === null);
    assert.equal(form.querySelector("details")?.open, false);
    assert.match(create.getByText(/创建时会自动验证模型连接/u).textContent ?? "", /不需要先单独测试/u);
    fireEvent.change(create.getByLabelText("Agent 名称"), { target: { value: "Central Reviewer" } });
    fireEvent.change(create.getByLabelText("Agent 角色"), { target: { value: "Reviewer" } });
    fireEvent.change(create.getByLabelText("模型"), { target: { value: "gpt-5.4" } });
    fireEvent.click(create.getByRole("checkbox", { name: "# general" }));
    const key = create.getByLabelText(/模型 API Key/u) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-single-create-secret" } });
    fireEvent.submit(form);
    const roomLink = await page.findByRole("button", { name: "进入房间对话 · # general" });
    await waitFor(() => assert.equal(key.value, ""));
    assert.deepEqual(openedRooms, []);
    fireEvent.click(roomLink);
    assert.deepEqual(openedRooms, [rooms[0]!.roomId]);
    assert.equal(page.queryByRole("button", { name: /进入房间对话 · # unselected/u }), null);
    const posts = requests.filter(({ method }) => method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual((posts[0]!.body as { roomIds: string[] }).roomIds, [rooms[0]!.roomId]);
    assert.doesNotMatch(page.getByText(/Agent 已创建。进入已授权的房间/u).textContent ?? "", /sk-/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("uncertain creation refreshes without replay, clears the key, and preserves useful form fields", async () => {
  const dom = installDom();
  let reads = 0;
  let writes = 0;
  globalThis.fetch = async (_input, init = {}) => {
    if ((init.method ?? "GET") === "GET") {
      reads += 1;
      return jsonResponse(reads === 1 ? [] : [configuration()]);
    }
    writes += 1;
    return jsonResponse({ error: { message: "provider body sk-uncertain-secret" } }, 502);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<HostedAgentPanel agents={[]} currentMemberIsOwner locale="zh-CN" rooms={rooms} sessionToken="session_owner" teamId={teamId} />);
    const page = within(dom.window.document.body);
    await page.findByText(/尚未配置中央 Agent/u);
    const form = page.getByRole("button", { name: "验证并创建" }).closest("form")!;
    const create = within(form);
    fireEvent.change(create.getByLabelText("Agent 名称"), { target: { value: "Central Reviewer" } });
    fireEvent.change(create.getByLabelText("Agent 角色"), { target: { value: "Reviewer" } });
    fireEvent.change(create.getByLabelText("模型"), { target: { value: "gpt-5.4" } });
    const key = create.getByLabelText(/模型 API Key/u) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-uncertain-secret" } });
    fireEvent.submit(form);
    const error = await page.findByRole("alert");
    await waitFor(() => assert.equal(key.value, ""));
    assert.match(error.textContent ?? "", /避免重复创建/u);
    assert.doesNotMatch(error.textContent ?? "", /sk-uncertain-secret|provider body/u);
    assert.equal((create.getByLabelText("Agent 名称") as HTMLInputElement).value, "Central Reviewer");
    assert.equal((create.getByLabelText("模型") as HTMLInputElement).value, "gpt-5.4");
    assert.equal(reads, 2);
    assert.equal(writes, 1);
    assert.ok(page.getByText("Central Reviewer", { selector: "h4" }));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("changing Owner scope clears draft secrets and Room selections", async () => {
  const dom = installDom();
  globalThis.fetch = async () => jsonResponse([]);
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    const view = render(<HostedAgentPanel agents={[]} currentMemberIsOwner locale="zh-CN" rooms={rooms} sessionToken="session_owner" teamId={teamId} />);
    const page = within(dom.window.document.body);
    await page.findByText(/尚未配置中央 Agent/u);
    fireEvent.change(page.getByLabelText(/模型 API Key/u), { target: { value: "sk-draft-owner-secret" } });
    fireEvent.click(page.getByRole("checkbox", { name: "# general" }));
    view.rerender(<HostedAgentPanel agents={[]} currentMemberIsOwner={false} locale="zh-CN" rooms={rooms} sessionToken="session_member" teamId={teamId} />);
    assert.equal(view.container.textContent, "");
    view.rerender(<HostedAgentPanel agents={[]} currentMemberIsOwner locale="zh-CN" rooms={rooms} sessionToken="session_owner_new" teamId={teamId} />);
    await waitFor(() => assert.equal((page.getByLabelText(/模型 API Key/u) as HTMLInputElement).value, ""));
    assert.equal((page.getByRole("checkbox", { name: "# general" }) as HTMLInputElement).checked, false);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("safe provider failures explain a next action without echoing arbitrary codes", () => {
  assert.match(hostedFailureHelp("HOSTED_PROVIDER_AUTHENTICATION_FAILED", "zh-CN"), /API Key.*模型访问权限/u);
  assert.match(hostedFailureHelp("HOSTED_PROVIDER_RATE_LIMITED", "zh-CN"), /额度或请求频率/u);
  assert.match(hostedFailureHelp("HOSTED_PROVIDER_UNAVAILABLE", "en"), /outbound network/u);
  assert.match(hostedFailureHelp("HOSTED_PROVIDER_REQUEST_REJECTED", "en"), /model name/u);
  assert.match(hostedFailureHelp("HOSTED_PROVIDER_PROBE_TIMEOUT", "en"), /timed out/u);
  assert.doesNotMatch(hostedFailureHelp("sk-arbitrary-secret", "zh-CN"), /sk-arbitrary-secret/u);
  assert.doesNotMatch(hostedFailureHelp("constructor", "en"), /function|constructor/u);
});

test("authoritative refresh removes Room links after a grant is revoked", async () => {
  const dom = installDom();
  let listed = configuration();
  globalThis.fetch = async () => jsonResponse([listed]);
  const { cleanup, render, waitFor, within } = await import("@testing-library/react");
  try {
    const view = render(<HostedAgentPanel agents={[]} currentMemberIsOwner locale="zh-CN" onOpenRoom={() => {}} rooms={rooms} sessionToken="session_owner" teamId={teamId} />);
    const page = within(dom.window.document.body);
    await page.findByRole("button", { name: "进入房间对话 · # general" });
    listed = configuration({ roomIds: [], presence: "degraded" });
    view.rerender(<HostedAgentPanel agents={[{
      agentId: listed.agentId,
      enabled: true,
      integrationMode: "hosted",
      name: listed.name,
      presence: listed.presence,
      role: listed.role
    }]} currentMemberIsOwner locale="zh-CN" onOpenRoom={() => {}} rooms={rooms} sessionToken="session_owner" teamId={teamId} />);
    await waitFor(() => assert.ok(page.queryByRole("button", { name: "进入房间对话 · # general" }) === null));
    assert.ok(page.getByText(/连接测试成功不代表已获得房间访问权/u));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("profile actions use revisions, show only safe observations, and clear replacement keys", async () => {
  const dom = installDom();
  const requests: RequestRecord[] = [];
  let failProfileUpdate = true;
  const initial = {
    ...configuration(),
    apiKey: "server-must-not-render",
    ciphertext: "encrypted-material-must-not-render",
    resultProposal: "Result controls must not render"
  } as HostedAgentConfiguration;
  let listed = initial;
  const revised = configuration({
    model: "gpt-5.5",
    profileRevision: 2,
    latestTest: observation("succeeded", null, 2)
  });
  const recovered = configuration({
    model: "gpt-5.5",
    profileRevision: 3,
    latestTest: observation("succeeded", null, 3)
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({
      ...(body === undefined ? {} : { body }),
      ...(init.cache ? { cache: init.cache } : {}),
      method,
      path
    });
    if (path === `/api/teams/${teamId}/hosted-agents` && method === "GET") {
      return jsonResponse([listed]);
    }
    if (path === `/api/hosted-agents/${initial.agentId}/profile`) {
      if (failProfileUpdate) {
        failProfileUpdate = false;
        return jsonResponse({
          error: { message: "bad sk-replacement-failure-secret" }
        }, 409);
      }
      listed = listed.credentialRevoked ? recovered : revised;
      return jsonResponse(listed);
    }
    if (path === `/api/hosted-agents/${initial.agentId}/tests`) {
      const failed = observation("failed", "HOSTED_PROVIDER_UNAVAILABLE", 2);
      listed = { ...listed, latestTest: failed, presence: "degraded" };
      return jsonResponse(failed);
    }
    if (path === `/api/hosted-agents/${initial.agentId}/credential/revoke`) {
      listed = configuration({
        model: "gpt-5.5",
        profileRevision: 2,
        credentialRevoked: true,
        presence: "degraded",
        latestTest: observation("failed", "HOSTED_PROVIDER_UNAVAILABLE", 2)
      });
      return jsonResponse(listed);
    }
    if (path === `/api/agents/${initial.agentId}` && method === "PATCH") {
      return jsonResponse({
        agentId: initial.agentId,
        enabled: false,
        integrationMode: "hosted",
        name: initial.name,
        presence: "offline",
        role: initial.role
      } satisfies Agent);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } =
    await import("@testing-library/react");
  try {
    render(
      <HostedAgentPanel
        agents={[]}
        currentMemberIsOwner
        locale="zh-CN"
        rooms={rooms}
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    await page.findByText("Central Reviewer", { selector: "h4" });
    assert.equal(page.queryByText(/server-must-not-render/u), null);
    assert.equal(page.queryByText(/encrypted-material-must-not-render/u), null);
    assert.equal(page.queryByRole("button", { name: /Result/u }), null);
    assert.match(page.getByText("仅调用远程模型，不具备操作电脑、读写文件或执行命令的能力。").textContent ?? "", /执行命令/u);

    const replacementKey = page.getByLabelText(/替换 API Key（可选）/u) as HTMLInputElement;
    fireEvent.change(replacementKey, {
      target: { value: "sk-replacement-failure-secret" }
    });
    fireEvent.click(page.getByRole("button", { name: "保存配置" }));
    await page.findByRole("alert");
    await waitFor(() => assert.equal(replacementKey.value, ""));
    assert.doesNotMatch(page.getByRole("alert").textContent ?? "", /sk-replacement/u);

    fireEvent.change(page.getByLabelText("模型", { selector: ".hosted-profile-form input" }), {
      target: { value: "gpt-5.5" }
    });
    fireEvent.change(replacementKey, {
      target: { value: "sk-replacement-success-secret" }
    });
    fireEvent.click(page.getByRole("button", { name: "保存配置" }));
    await waitFor(() => assert.equal(replacementKey.value, ""));
    await page.findByText("2", { selector: ".hosted-profile-facts dd" });

    fireEvent.click(page.getByRole("button", { name: "测试已保存配置" }));
    await page.findByText("HOSTED_PROVIDER_UNAVAILABLE");
    fireEvent.change(replacementKey, {
      target: { value: "sk-cleared-by-revoke-secret" }
    });
    fireEvent.click(page.getByRole("button", { name: "撤销凭据" }));
    await page.findByText("已撤销");
    await waitFor(() => assert.equal(replacementKey.value, ""));
    const restoreButton = page.getByRole("button", {
      name: "使用新 API Key 恢复"
    });
    assert.equal(restoreButton.hasAttribute("disabled"), true);
    fireEvent.change(replacementKey, {
      target: { value: "sk-recover-revoked-secret" }
    });
    assert.equal(restoreButton.hasAttribute("disabled"), false);
    fireEvent.click(restoreButton);
    await page.findByText("已配置");
    await waitFor(() => assert.equal(replacementKey.value, ""));
    fireEvent.click(page.getByRole("button", { name: "停用" }));
    await page.findByRole("button", { name: "启用" });

    const profileRequests = requests.filter(({ path }) =>
      path === `/api/hosted-agents/${initial.agentId}/profile`
    );
    assert.deepEqual(profileRequests.map(({ body }) => body), [{
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      apiKey: "sk-replacement-failure-secret"
    }, {
      expectedProfileRevision: 1,
      model: "gpt-5.5",
      apiKey: "sk-replacement-success-secret"
    }, {
      expectedProfileRevision: 2,
      model: "gpt-5.5",
      apiKey: "sk-recover-revoked-secret"
    }]);
    assert.deepEqual(requests.find(({ path }) =>
      path.endsWith("/credential/revoke")
    )?.body, { expectedProfileRevision: 2 });
    assert.deepEqual(requests.find(({ path }) =>
      path === `/api/agents/${initial.agentId}`
    )?.body, { enabled: false });
    assert.ok(requests.every(({ path }) => !path.includes("sk-")));
    assert.ok(requests.every(({ cache }) => cache === "no-store"));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("configured tests reload authoritative Presence and synchronize the Agent roster", async () => {
  const dom = installDom();
  const changed: Agent[] = [];
  let listCount = 0;
  const degraded = configuration({
    presence: "degraded",
    latestTest: observation("failed", "HOSTED_PROVIDER_UNAVAILABLE")
  });
  const ready = configuration({
    presence: "ready",
    latestTest: observation("succeeded")
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    if (path === `/api/teams/${teamId}/hosted-agents` && method === "GET") {
      listCount += 1;
      return jsonResponse([listCount === 1 ? degraded : ready]);
    }
    if (path === `/api/hosted-agents/${degraded.agentId}/tests`) {
      return jsonResponse(observation("succeeded"));
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } =
    await import("@testing-library/react");
  try {
    render(
      <HostedAgentPanel
        agents={[{
          agentId: degraded.agentId,
          enabled: true,
          integrationMode: "hosted",
          name: degraded.name,
          presence: "degraded",
          role: degraded.role
        }]}
        currentMemberIsOwner
        locale="zh-CN"
        onAgentChanged={(agent) => changed.push(agent)}
        rooms={rooms}
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    const card = (await page.findByText("Central Reviewer", {
      selector: "h4"
    })).closest("article")!;
    assert.match(card.querySelector(".status-badge")?.textContent ?? "", /受限/u);
    fireEvent.click(within(card).getByRole("button", { name: "测试已保存配置" }));
    await waitFor(() => {
      assert.match(card.querySelector(".status-badge")?.textContent ?? "", /就绪/u);
      assert.equal(changed.at(-1)?.presence, "ready");
    });
    assert.equal(listCount, 2);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("queued work explicitly fences profile edits and stale mutations reload revisions", async () => {
  const dom = installDom();
  let current = configuration({
    presence: "ready",
    configurationLocked: true,
    hasActiveWork: true
  });
  let updateAttempted = false;
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    if (path === `/api/teams/${teamId}/hosted-agents` && method === "GET") {
      return jsonResponse([current]);
    }
    if (path === `/api/hosted-agents/${current.agentId}/profile`) {
      updateAttempted = true;
      current = configuration({
        model: "gpt-5.5",
        profileRevision: 2,
        presence: "ready",
        latestTest: observation("succeeded", null, 2)
      });
      return jsonResponse({ error: { code: "CONFLICT" } }, 409);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } =
    await import("@testing-library/react");
  try {
    const view = render(
      <HostedAgentPanel
        agents={[]}
        currentMemberIsOwner
        locale="zh-CN"
        rooms={rooms}
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    await page.findByText(/Agent 有排队中或执行中的工作/u);
    const modelInput = page.getByLabelText("模型", {
      selector: ".hosted-profile-form input"
    }) as HTMLInputElement;
    const replacementKey = page.getByLabelText(/替换 API Key（可选）/u) as HTMLInputElement;
    assert.equal(modelInput.disabled, true);
    assert.equal(replacementKey.disabled, true);
    assert.equal(page.getByRole("button", { name: "保存配置" }).hasAttribute("disabled"), true);
    assert.equal(updateAttempted, false);

    current = configuration({ presence: "ready" });
    view.rerender(
      <HostedAgentPanel
        agents={[{
          agentId: current.agentId,
          enabled: true,
          integrationMode: "hosted",
          name: current.name,
          presence: "ready",
          role: current.role
        }]}
        currentMemberIsOwner
        locale="zh-CN"
        rooms={rooms}
        sessionToken="session_owner"
        teamId={teamId}
      />
    );
    await waitFor(() => assert.equal(modelInput.disabled, false));
    fireEvent.change(modelInput, { target: { value: "gpt-5.5" } });
    fireEvent.change(replacementKey, { target: { value: "sk-stale-secret" } });
    fireEvent.click(page.getByRole("button", { name: "保存配置" }));
    await page.findByText(/已重新载入最新配置/u);
    await waitFor(() => {
      assert.equal(modelInput.value, "gpt-5.5");
      assert.equal(replacementKey.value, "");
      assert.ok(updateAttempted);
    });
    assert.match(page.getByText("2", {
      selector: ".hosted-profile-facts dd"
    }).textContent ?? "", /2/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Hosted labels state the same remote-only boundary in English and Chinese", () => {
  const hosted: Agent = {
    agentId: "agent_hosted_labels",
    enabled: true,
    integrationMode: "hosted",
    name: "Hosted",
    presence: "ready",
    role: "Reviewer"
  };
  assert.equal(integrationLabel("hosted", "en"), "Central Agent");
  assert.match(presenceHelp(hosted, "en"), /cannot operate a computer/u);
  assert.match(presenceHelp(hosted, "zh-CN"), /不能操作电脑/u);

  const html = renderToStaticMarkup(
    <HostedAgentPanel
      agents={[]}
      currentMemberIsOwner
      locale="en"
      rooms={rooms}
      sessionToken="session_owner"
      teamId={teamId}
    />
  );
  assert.match(html, /Remote model only/u);
  assert.match(html, /cannot operate a computer/u);
  assert.match(html, /authorized Room context/u);
  assert.doesNotMatch(html, />Result</u);
});

test("Hosted configuration collapses fields, profiles, Rooms, and actions on narrow screens", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.hosted-create-fields, \.hosted-profile-facts \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.hosted-room-picker > div \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.hosted-form-actions, \.hosted-profile-actions \{ align-items: stretch; flex-direction: column; \}/u);
  assert.match(css, /\.integration-badge\.hosted \{[^}]+\}/u);
  assert.doesNotMatch(css, /\.hosted-(?:agent|create|profile|room)[^{]*\{[^}]*min-width:\s*[4-9]\d\dpx/u);
});
