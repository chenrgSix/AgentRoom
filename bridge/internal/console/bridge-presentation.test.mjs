import assert from "node:assert/strict";
import test from "node:test";

import {
  agentPresentation,
  connectionPresentation
} from "./static/bridge-presentation.mjs";

test("online connection presents one calm owner-facing summary", () => {
  const view = connectionPresentation({
    bridgeRunning: true,
    serverUrl: "https://team.example.com:3000",
    connection: {state: "online", lastError: "stale raw failure"}
  });

  assert.equal(view.tone, "success");
  assert.equal(view.label, "已连接");
  assert.match(view.summary, /team\.example\.com:3000/);
  assert.equal(view.technicalDetail, "");
});

test("connection refusal explains the owner action without putting transport text in the summary", () => {
  const raw = 'bridge WebSocket dial: Get "http://127.0.0.1:3000/ws/bridge": dial tcp 127.0.0.1:3000: connect: connection refused';
  const view = connectionPresentation({
    bridgeRunning: true,
    serverUrl: "http://127.0.0.1:3000",
    connection: {state: "retrying", lastError: raw}
  });

  assert.equal(view.title, "中央服务未启动");
  assert.match(view.summary, /自动重新连接/);
  assert.doesNotMatch(view.summary, /dial tcp|WebSocket/);
  assert.equal(view.technicalDetail, raw);
});

test("credential, certificate, protocol, and unknown failures remain distinct", () => {
  const cases = [
    ["unexpected status 401 unauthorized", "中央服务拒绝了连接"],
    ["x509: certificate signed by unknown authority", "无法验证中央服务"],
    ["websocket: bad handshake", "Bridge 无法完成连接握手"],
    ["unclassified failure", "连接遇到问题"]
  ];

  for (const [lastError, title] of cases) {
    const view = connectionPresentation({
      bridgeRunning: true,
      connection: {state: "retrying", lastError}
    });
    assert.equal(view.title, title);
    assert.equal(view.technicalDetail, lastError);
  }
});

test("Agent presentation prioritizes availability and the local Workspace binding", () => {
  assert.deepEqual(agentPresentation({
    name: "Codex-设计",
    role: "产品经理",
    kind: "codex",
    runtimeState: "idle",
    executableReady: true,
    sandbox: "read-only",
    workspace: "/Users/owner/Code/ConveneWire",
    workspaceAlias: "Payments API",
    workspaceNetworkPolicy: "runtime-managed"
  }), {
    initials: "CO",
    kindLabel: "Codex",
    role: "产品经理",
    status: "可用",
    tone: "success",
    filesystemPolicy: "只读",
    networkPolicy: "跟随本机策略",
    sessionConflictPolicy: "占用时保留并重试",
    workspaceName: "Payments API",
    executableSummary: "Runtime 已找到"
  });

  const pi = agentPresentation({
    name: "我的 Pi",
    kind: "pi",
    runtimeState: "working",
    activeRuns: 2,
    executableReady: true,
    workspace: "C:\\work\\room"
  });
  assert.equal(pi.status, "执行中 · 2");
  assert.equal(pi.filesystemPolicy, "跟随本机策略");
  assert.equal(pi.networkPolicy, "本机策略");
  assert.equal(pi.sessionConflictPolicy, "");
  assert.equal(pi.workspaceName, "room");

  const stopped = agentPresentation({
    name: "Codex",
    kind: "codex",
    runtimeState: "idle",
    executableReady: true
  }, {bridgeRunning: false});
  assert.equal(stopped.status, "已配置");
  assert.equal(stopped.tone, "neutral");
});

test("Agent presentation exposes the configured Codex conflict strategy", () => {
  const view = agentPresentation({
    name: "Codex",
    kind: "codex",
    codexSessionConflictPolicy: "start_new"
  });
  assert.equal(view.sessionConflictPolicy, "占用时新建会话");
});
