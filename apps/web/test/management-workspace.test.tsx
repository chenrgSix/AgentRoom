import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { AgentWorkspace } from "../src/features/agent/AgentWorkspace.js";
import { DeviceWorkspace } from "../src/features/device/DeviceWorkspace.js";
import { HostedAgentPanel } from "../src/features/agent/HostedAgentPanel.js";
import type { Agent, Device, HostedAgentConfiguration, Room } from "../src/models.js";

const teamId = "team_management_0001";
const memberId = "member_management_0001";
const room: Room = { roomId: "room_management_0001", teamId, name: "general", settingsRevision: 1, createdAt: "2026-08-31T00:00:00Z" };
const devices: Device[] = [{ deviceId: "device_management_0001", ownerMemberId: memberId, name: "My Mac", status: "active" },
  { deviceId: "device_management_0002", ownerMemberId: "member_other_0001", name: "Other Mac", status: "active" }];
const agents: Agent[] = [
  { agentId: "agent_management_0001", name: "Central Reviewer", role: "Reviewer", integrationMode: "hosted", enabled: true, presence: "ready" },
  { agentId: "agent_management_0002", name: "Local Builder", role: "Builder", deviceId: devices[0]!.deviceId, ownerMemberId: memberId, integrationMode: "managed", enabled: true, presence: "offline" },
  { agentId: "agent_management_0003", name: "Disabled helper", role: "Helper", integrationMode: "fake", enabled: false, presence: "ready" }
];
const config: HostedAgentConfiguration = { ...agents[0]!, teamId, role: "Reviewer", enabled: true, presence: "ready", roomIds: [room.roomId],
  profileRevision: 1, provider: "openai_responses", model: "synthetic-model", credentialConfigured: true,
  credentialRevoked: false, configurationLocked: false, hasActiveWork: false, latestTest: null, updatedAt: room.createdAt };
const otherConfig: HostedAgentConfiguration = { ...config, agentId: "agent_other_0001", name: "Other Hosted Agent" };

async function fixture(t: TestContext) {
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const originalFetch = globalThis.fetch;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://management.example.test/" });
  for (const [name, value] of Object.entries({ document: dom.window.document, window: dom.window, HTMLElement: dom.window.HTMLElement,
    navigator: dom.window.navigator, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); requests.push(url);
    assert.equal(url, `/api/teams/${teamId}/hosted-agents`);
    return new Response(JSON.stringify([config, otherConfig]), { headers: { "content-type": "application/json" } });
  };
  const testing = await import("@testing-library/react");
  t.after(async () => {
    testing.cleanup();
    await testing.act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const name of ["document", "window", "HTMLElement", "navigator", "sessionStorage", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (descriptors[name]) Object.defineProperty(globalThis, name, descriptors[name]!); else Reflect.deleteProperty(globalThis, name);
    }
  });
  const props: React.ComponentProps<typeof AgentWorkspace> = {
    agents, agentName: "", busy: false, connectionMode: "managed", currentMemberIsOwner: true, currentMemberId: memberId,
    devices, deviceName: "", joinCode: "", lifecycleBusy: false, locale: "en", manualAgentName: "", readyAgents: 1,
    rooms: [room], setupOutput: null, sessionToken: "synthetic-session", teamId,
    onAgentNameChange() {}, onApproveBridgeJoin() {}, onConnectionModeChange() {}, onCreateBridgeInvite() {}, onCreateFakeAgent() {},
    onCreateManualAgent() {}, onDeviceNameChange() {}, onJoinCodeChange() {}, onManualAgentNameChange() {}, onAgentChanged() {},
    onSetupClosed() {}, onDevices() {}, onSetAgentEnabled() {}
  };
  return { ...testing, dom, requests, props, page: testing.within(dom.window.document.body) };
}

test("inventory does not mount any configuration or pairing flow and filters without requests", async (t) => {
  const f = await fixture(t);
  f.render(<AgentWorkspace {...f.props} />);
  assert.equal(f.page.queryByRole("dialog"), null);
  assert.equal(f.page.queryByLabelText(/API Key/u), null);
  assert.deepEqual(f.requests, []);
  f.fireEvent.change(f.page.getByRole("searchbox", { name: "Search Agents" }), { target: { value: "builder" } });
  assert.ok(f.page.getByRole("button", { name: "View Local Builder" }));
  assert.equal(f.page.queryByRole("button", { name: "View Central Reviewer" }), null);
  f.fireEvent.change(f.page.getByRole("combobox", { name: "Agent status" }), { target: { value: "ready" } });
  assert.ok(f.page.getByText("No matching Agents"));
  f.fireEvent.change(f.page.getByRole("searchbox", { name: "Search Agents" }), { target: { value: "" } });
  assert.ok(f.page.getByRole("button", { name: "View Central Reviewer" }));
  assert.equal(f.page.queryByRole("button", { name: "View Disabled helper" }), null);
  f.fireEvent.change(f.page.getByRole("combobox", { name: "Integration type" }), { target: { value: "managed" } });
  assert.ok(f.page.getByText("No matching Agents"));
  assert.deepEqual(f.requests, []);
});

test("single-Agent configuration excludes creation and other profiles, clears secrets on Escape and restores focus", async (t) => {
  const f = await fixture(t);
  f.render(<AgentWorkspace {...f.props} />);
  const trigger = f.page.getByRole("button", { name: "View Central Reviewer" });
  trigger.focus(); f.fireEvent.click(trigger);
  const dialog = f.page.getByRole("dialog", { name: "Central Reviewer" });
  await f.page.findByDisplayValue("synthetic-model");
  assert.equal(f.within(dialog).queryByText("Other Hosted Agent"), null);
  assert.equal(f.within(dialog).queryByLabelText("Agent name"), null);
  const key = dialog.querySelector('input[type="password"]')!;
  f.fireEvent.change(key, { target: { value: "synthetic-do-not-keep-key" } });
  const close = f.page.getByRole("button", { name: "Close", exact: true });
  close.focus(); f.fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  assert.equal(dialog.contains(f.dom.window.document.activeElement), true);
  f.fireEvent.keyDown(dialog, { key: "Escape" });
  assert.equal(f.page.queryByRole("dialog"), null);
  assert.equal(f.dom.window.document.activeElement, trigger);
  assert.equal(f.dom.window.document.body.innerHTML.includes("synthetic-do-not-keep-key"), false);
  f.fireEvent.click(trigger);
  await f.page.findByDisplayValue("synthetic-model");
  assert.equal((f.page.getByRole("dialog").querySelector('input[type="password"]') as HTMLInputElement).value, "");
  assert.equal(JSON.stringify(f.dom.window.sessionStorage).includes("synthetic-do-not-keep-key"), false);
});

test("creation opens only on demand and closing removes the API-key field without submitting", async (t) => {
  const f = await fixture(t);
  f.render(<AgentWorkspace {...f.props} />);
  f.fireEvent.click(f.page.getByRole("button", { name: "Add an Agent", exact: true }));
  assert.equal(f.page.queryByLabelText("Agent name"), null);
  f.fireEvent.click(f.page.getByRole("button", { name: "Create a Central Agent", exact: true }));
  await f.page.findByLabelText("Agent name");
  assert.equal(f.page.queryByText("Other Hosted Agent"), null);
  f.fireEvent.change(f.page.getByRole("dialog").querySelector('input[type="password"]')!, { target: { value: "synthetic-unsent-key" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Close", exact: true }));
  assert.equal(f.page.queryByLabelText("Agent name"), null);
  assert.equal(f.dom.window.document.body.innerHTML.includes("synthetic-unsent-key"), false);
  assert.ok(f.requests.every((url) => url.endsWith("/hosted-agents")));
});

test("ordinary members cannot mount Hosted configuration or its write controls", async (t) => {
  const f = await fixture(t);
  f.render(<AgentWorkspace {...f.props} currentMemberIsOwner={false} />);
  f.fireEvent.click(f.page.getByRole("button", { name: "View Central Reviewer" }));
  assert.equal(f.page.getByRole("dialog").querySelector('input[type="password"]'), null);
  assert.equal(f.page.queryByRole("button", { name: "Disable", exact: true }), null);
  f.fireEvent.click(f.page.getByRole("button", { name: "Close", exact: true }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Add an Agent", exact: true }));
  assert.equal((f.page.getByRole("button", { name: "Create a Central Agent", exact: true }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(f.requests, []);
});

test("local Agent detail links to Device management without exposing a Central runtime editor", async (t) => {
  const f = await fixture(t); let opened = 0;
  f.render(<AgentWorkspace {...f.props} onDevices={() => { opened += 1; }} />);
  f.fireEvent.click(f.page.getByRole("button", { name: "View Local Builder" }));
  const dialog = f.page.getByRole("dialog", { name: "Local Builder" });
  assert.match(dialog.textContent ?? "", /configured in the local client/u);
  assert.equal(dialog.querySelectorAll("input").length, 0);
  f.fireEvent.click(f.page.getByRole("button", { name: "View Devices" }));
  assert.equal(opened, 1); assert.deepEqual(f.requests, []);
});

test("Device inventory separates authorization from readiness and scopes revoke and pairing controls", async (t) => {
  const f = await fixture(t);
  const props = { agents, devices, locale: "en" as const, currentMemberId: memberId, currentMemberIsOwner: false, sessionToken: undefined, teamId, onRevokeDevice() {} };
  const view = f.render(<DeviceWorkspace {...props} />);
  assert.equal(f.page.getAllByRole("button", { name: "Revoke", exact: true }).length, 1);
  assert.equal(f.page.queryByRole("button", { name: "Pair a Device" }), null);
  assert.ok(f.page.getByText("1 Agents · 0 ready"));
  assert.match(f.page.getByText(/Active authorization/u).textContent ?? "", /does not mean a Device is online/u);
  view.rerender(<DeviceWorkspace {...props} currentMemberIsOwner />);
  assert.equal(f.page.getAllByRole("button", { name: "Revoke", exact: true }).length, 2);
  assert.equal(f.page.queryByRole("dialog"), null);
  f.fireEvent.click(f.page.getByRole("button", { name: "Pair a Device" }));
  assert.ok(f.page.getByRole("dialog", { name: "Pair a Device" }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Close", exact: true }));
  assert.equal(f.page.queryByRole("dialog"), null);
  assert.deepEqual(f.requests, []);
});

test("changing the selected Hosted profile retires its credential draft and stale scope", async (t) => {
  const f = await fixture(t);
  const props = { agents, currentMemberIsOwner: true, locale: "en" as const, rooms: [room], sessionToken: undefined, teamId };
  const view = f.render(<HostedAgentPanel {...props} presentation={{ kind: "profile", agentId: config.agentId }} />);
  await f.page.findByDisplayValue("synthetic-model");
  f.fireEvent.change(f.dom.window.document.querySelector('input[type="password"]')!, { target: { value: "old-profile-key" } });
  view.rerender(<HostedAgentPanel {...props} presentation={{ kind: "profile", agentId: otherConfig.agentId }} />);
  await f.page.findByRole("heading", { name: otherConfig.name });
  assert.equal(f.page.queryByRole("heading", { name: config.name }), null);
  assert.equal((f.dom.window.document.querySelector('input[type="password"]') as HTMLInputElement).value, "");
  assert.equal(f.dom.window.document.body.innerHTML.includes("old-profile-key"), false);
});
