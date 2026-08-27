import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import {
  AgentProvisioningPanel,
  provisioningRejectionLabel
} from "../src/features/agent/AgentProvisioningPanel.js";
import type {
  Agent,
  AgentProvisionRequest,
  AgentProvisionRequestStatus,
  Device
} from "../src/models.js";

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

const teamId = "team_provision";
const memberId = "member_alice";
const ownDevice: Device = {
  deviceId: "device_alice",
  ownerMemberId: memberId,
  name: "Alice Mac",
  status: "active"
};
const foreignDevice: Device = {
  deviceId: "device_bob",
  ownerMemberId: "member_bob",
  name: "Bob PC",
  status: "active"
};
const offlineDevice: Device = {
  deviceId: "device_offline",
  ownerMemberId: memberId,
  name: "Offline Mac",
  status: "active"
};
const ownTemplate: Agent = {
  agentId: "agent_alice_builder",
  ownerMemberId: memberId,
  deviceId: ownDevice.deviceId,
  enabled: true,
  integrationMode: "managed",
  name: "Alice Builder",
  presence: "ready",
  role: "Codex implementer"
};
const foreignTemplate: Agent = {
  ...ownTemplate,
  agentId: "agent_bob_builder",
  ownerMemberId: "member_bob",
  deviceId: foreignDevice.deviceId,
  name: "Bob Builder"
};
const offlineTemplate: Agent = {
  ...ownTemplate,
  agentId: "agent_alice_offline",
  deviceId: offlineDevice.deviceId,
  name: "Offline Builder",
  presence: "offline"
};

function requestRecord(
  body: {
    requestId: string;
    deviceId: string;
    templateAgentId: string;
    name: string;
    role: string;
  },
  status: AgentProvisionRequestStatus,
  rejectionReason: string | null = null
): AgentProvisionRequest {
  return {
    requestId: body.requestId,
    teamId,
    deviceId: body.deviceId,
    templateAgentId: body.templateAgentId,
    agentId: "agent_provisioned",
    requestedByMemberId: memberId,
    name: body.name,
    role: body.role,
    status,
    rejectionReason,
    createdAt: "2026-08-27T00:00:00.000Z",
    deliveredAt: status === "pending" ? null : "2026-08-27T00:00:01.000Z",
    respondedAt: ["accepted", "ready", "rejected"].includes(status)
      ? "2026-08-27T00:00:02.000Z"
      : null,
    readyAt: status === "ready" ? "2026-08-27T00:00:03.000Z" : null,
    updatedAt: "2026-08-27T00:00:03.000Z"
  };
}

test("all protocol rejection reasons have safe localized projections", () => {
  const expectations: Record<string, string> = {
    provisioning_disabled: "Bridge 已关闭中央创建",
    invalid_code: "管理码不正确或已过期",
    rate_limited: "管理码尝试过多，请稍后再试",
    busy: "Bridge 正在执行任务",
    template_not_found: "本地模板 Agent 已不存在",
    identity_conflict: "本地 Agent 身份发生冲突",
    invalid_request: "请求内容无效",
    configuration_failed: "Bridge 保存本地配置失败"
  };
  for (const [reason, label] of Object.entries(expectations)) {
    assert.equal(provisioningRejectionLabel(reason, "zh-CN"), label);
  }
  assert.equal(provisioningRejectionLabel("local_path=/private/secret", "zh-CN"),
    "Bridge 拒绝了本次请求。");
});

test("owning Member submits a code and follows delivered, accepted, and ready states", async () => {
  const dom = installDom();
  let history: AgentProvisionRequest[] = [];
  let currentStatus: AgentProvisionRequestStatus = "delivered";
  let submitted: Record<string, string> | null = null;
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    assert.equal(path, `/api/teams/${teamId}/agent-provision-requests`);
    if ((init.method ?? "GET") === "POST") {
      submitted = JSON.parse(String(init.body)) as Record<string, string>;
      history = [requestRecord(submitted as Parameters<typeof requestRecord>[0], "delivered")];
      return jsonResponse(history[0]);
    }
    if (history[0]) history = [{ ...history[0], status: currentStatus }];
    return jsonResponse(history);
  };

  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(
      <AgentProvisioningPanel
        agents={[ownTemplate, foreignTemplate, offlineTemplate]}
        currentMemberId={memberId}
        devices={[ownDevice, foreignDevice, offlineDevice]}
        locale="zh-CN"
        sessionToken="session_alice"
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    const device = await page.findByLabelText("我的在线 Bridge") as HTMLSelectElement;
    assert.equal(device.options.length, 1);
    assert.equal(device.value, ownDevice.deviceId);
    assert.equal(page.queryByText(foreignDevice.name), null);
    assert.equal(page.queryByText(offlineDevice.name), null);

    const template = page.getByLabelText("本地模板 Agent") as HTMLSelectElement;
    assert.equal(template.options.length, 1);
    assert.equal(template.value, ownTemplate.agentId);
    const role = page.getByLabelText("角色") as HTMLInputElement;
    await waitFor(() => assert.equal(role.value, ownTemplate.role));
    fireEvent.change(page.getByLabelText("新 Agent 名称"), {
      target: { value: "Release Reviewer" }
    });
    fireEvent.change(role, { target: { value: "Release reviewer" } });
    const code = page.getByLabelText("Bridge 管理码") as HTMLInputElement;
    fireEvent.change(code, { target: { value: "12345678" } });
    fireEvent.submit(page.getByRole("button", { name: "创建 Agent" }).closest("form")!);

    await page.findByText("Bridge 已收到", { selector: ".status-badge" });
    assert.equal(code.value, "");
    assert.deepEqual(submitted, {
      requestId: submitted?.requestId,
      deviceId: ownDevice.deviceId,
      templateAgentId: ownTemplate.agentId,
      name: "Release Reviewer",
      role: "Release reviewer",
      managementCode: "12345678"
    });
    assert.match(submitted?.requestId ?? "", /^agentprov_[A-Za-z0-9_-]{8,128}$/u);
    assert.deepEqual(Object.keys(submitted ?? {}).sort(), [
      "deviceId",
      "managementCode",
      "name",
      "requestId",
      "role",
      "templateAgentId"
    ]);
    assert.doesNotMatch(JSON.stringify(history), /managementCode|workspace|command|credential|tool/u);

    currentStatus = "accepted";
    fireEvent.click(page.getByRole("button", { name: "刷新状态" }));
    await page.findByText("本地已创建", { selector: ".status-badge" });
    currentStatus = "ready";
    fireEvent.click(page.getByRole("button", { name: "刷新状态" }));
    await page.findByText("已就绪", { selector: ".status-badge" });
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("offline retry reuses the request ID, clears each code, and renders safe rejection", async () => {
  const dom = installDom();
  let history: AgentProvisionRequest[] = [];
  let postCount = 0;
  const submissions: Array<Record<string, string>> = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = typeof input === "string" ? input : input.url;
    assert.equal(path, `/api/teams/${teamId}/agent-provision-requests`);
    if ((init.method ?? "GET") === "POST") {
      postCount += 1;
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      submissions.push(body);
      history = [requestRecord(body as Parameters<typeof requestRecord>[0],
        postCount === 1 ? "pending" : "delivered")];
      if (postCount === 1) {
        return jsonResponse({
          error: { message: "Bridge is offline; retry with the same request ID" }
        }, 409);
      }
      return jsonResponse(history[0]);
    }
    return jsonResponse(history);
  };

  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(
      <AgentProvisioningPanel
        agents={[ownTemplate]}
        currentMemberId={memberId}
        devices={[ownDevice]}
        locale="zh-CN"
        sessionToken={undefined}
        teamId={teamId}
      />
    );
    const page = within(dom.window.document.body);
    await page.findByLabelText("我的在线 Bridge");
    const role = page.getByLabelText("角色") as HTMLInputElement;
    await waitFor(() => assert.equal(role.value, ownTemplate.role));
    fireEvent.change(page.getByLabelText("新 Agent 名称"), {
      target: { value: "Retry Builder" }
    });
    const code = page.getByLabelText("Bridge 管理码") as HTMLInputElement;
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.submit(page.getByRole("button", { name: "创建 Agent" }).closest("form")!);

    await page.findByText("等待发送", { selector: ".status-badge" });
    assert.equal(code.value, "");
    fireEvent.click(page.getByRole("button", { name: "使用同一请求重试" }));
    fireEvent.change(code, { target: { value: "87654321" } });
    fireEvent.submit(page.getByRole("button", { name: "创建 Agent" }).closest("form")!);
    await page.findByText("Bridge 已收到", { selector: ".status-badge" });

    assert.equal(code.value, "");
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]?.requestId, submissions[1]?.requestId);
    assert.equal(submissions[0]?.managementCode, "654321");
    assert.equal(submissions[1]?.managementCode, "87654321");
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /654321|87654321/u);

    history = [{ ...history[0]!, status: "rejected", rejectionReason: "invalid_code" }];
    fireEvent.click(page.getByRole("button", { name: "刷新状态" }));
    await page.findByText("已拒绝", { selector: ".status-badge" });
    page.getByText("管理码不正确或已过期");
  } finally {
    cleanup();
    dom.window.close();
  }
});
