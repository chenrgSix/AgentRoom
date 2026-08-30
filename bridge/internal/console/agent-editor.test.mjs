import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { detectedPathForDraft, runtimeDiscoveryView } from "./static/runtime-discovery.mjs";
import { applyAgentRuntimePolicy, applyCodexSessionConflictPolicy } from "./static/runtime-policy.mjs";

const source = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./static/index.html", import.meta.url), "utf8");

function control() {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    value: "", textContent: "", className: "", disabled: false, readOnly: false, hidden: false,
    listeners,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        if (force ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      }
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name),
    addEventListener: (name, listener) => listeners.set(name, listener),
    focus() {}
  };
}

function editorFixture() {
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], control()]));
  const kinds = [...html.match(/<select id="agent-kind"[^>]*>([\s\S]*?)<\/select>/)[1].matchAll(/value="([^"]+)"/g)]
    .map((match) => match[1]);
  let selectedKind = "codex";
  Object.defineProperty(elements["agent-kind"], "value", {
    get: () => selectedKind,
    set(value) { selectedKind = kinds.includes(value) ? value : ""; }
  });
  const requests = [];
  const context = vm.createContext({
    elements,
    currentState: {agents: [], detectedCodex: "/detected/codex", detectedPi: "/detected/pi", workspace: "/workspace"},
    editingAgentId: null, discoveryRunning: false, draftPreflightRunning: false,
    detectedPathForDraft, runtimeDiscoveryView, applyAgentRuntimePolicy, applyCodexSessionConflictPolicy,
    showError() {}, async refresh() {},
    async request(path, options) {
      requests.push({path, ...options});
      return {codex: {path: "/refreshed/codex"}, pi: {path: "/refreshed/pi"}, passed: true, durationMillis: 1};
    }
  });
  // Execute the actual embedded controller functions and submit handler, not a parallel view model.
  const declarations = [...source.matchAll(/^(?:async )?function ([a-zA-Z0-9_]+)\(/gm)];
  for (const name of ["runtimeDraft", "probeSummary", "preflightDraft", "syncAgentKindFields", "renderDiscovery", "useDetectedRuntime", "openAgentModal", "closeAgentModal"]) {
    const index = declarations.findIndex((match) => match[1] === name);
    assert.notEqual(index, -1, `missing embedded function ${name}`);
    vm.runInContext(source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length), context);
  }
  const submitStart = source.indexOf('elements["agent-form"].addEventListener("submit"');
  vm.runInContext(source.slice(submitStart, source.indexOf("\nfunction enrollmentPayload()", submitStart)), context);
  return {context, elements, requests};
}

const genericAgent = {
  agentId: "agent_owner_cli", kind: "generic", name: "Owner CLI", role: "Builder",
  executablePath: "owner-cli", workspace: "/private/workspace", workspaceAlias: "Private Workspace"
};

test("Generic edit submits the saved kind and executable with only visible metadata changes", async () => {
  const {context, elements, requests} = editorFixture();
  context.openAgentModal(genericAgent);
  assert.equal(elements["agent-kind"].value, "generic");
  assert.equal(elements["agent-kind"].disabled, true);
  assert.equal(elements["agent-path"].readOnly, true);
  assert.equal(elements["agent-path"].value, "owner-cli");
  assert.equal(elements["agent-generic-runtime-help"].classList.contains("hidden"), false);
  assert.equal(elements["agent-runtime-edit-help"].classList.contains("hidden"), false);
  assert.match(html, /Generic CLI/);
  assert.match(html, /独立.*配置/);
  elements["agent-name"].value = "Renamed CLI";
  elements["agent-role"].value = "Planner";
  elements["agent-workspace-alias"].value = "Safe Alias";
  await elements["agent-form"].listeners.get("submit")({preventDefault() {}});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/api/agents/${genericAgent.agentId}`);
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(JSON.parse(requests[0].body), {
    kind: "generic", enabled: true, name: "Renamed CLI", role: "Planner",
    executablePath: "owner-cli", workspace: "/private/workspace", workspaceAlias: "Safe Alias",
    sandbox: "", codexSessionConflictPolicy: "", credentialEnvironmentVariable: ""
  });
});

test("Generic editing hides preset discovery and policies and cannot execute a preset probe", async () => {
  const {context, elements, requests} = editorFixture();
  context.openAgentModal(genericAgent);
  for (const id of ["agent-runtime-draft-actions", "agent-discovery-status", "agent-discovery-help", "agent-install-link", "agent-sandbox-field", "agent-session-conflict-policy-field", "agent-credential-field", "agent-codex-session-ownership-policy", "agent-pi-permission-policy"]) {
    assert.equal(elements[id].classList.contains("hidden"), true, id);
  }
  assert.equal(elements["agent-kind"].getAttribute("aria-describedby"), "agent-generic-runtime-help");
  assert.equal(elements["agent-preflight"].disabled, true);
  assert.equal(elements["agent-use-detected"].disabled, true);
  await context.useDetectedRuntime("agent", "generic");
  await context.preflightDraft("generic", "agent", elements["agent-preflight"], elements["agent-preflight-result"]);
  assert.equal(requests.length, 0);
  assert.equal(elements["agent-path"].value, "owner-cli");
});

test("new Agent creation remains selectable between Codex and Pi after a Generic edit", async () => {
  const {context, elements, requests} = editorFixture();
  context.openAgentModal(genericAgent);
  context.closeAgentModal();
  context.openAgentModal();
  assert.equal(elements["agent-kind"].disabled, false);
  assert.equal(elements["agent-kind"].value, "codex");
  assert.equal(elements["agent-generic-option"].disabled, true);
  assert.equal(elements["agent-generic-option"].hidden, true);
  assert.equal(elements["agent-path"].readOnly, false);
  assert.equal(elements["agent-generic-runtime-help"].classList.contains("hidden"), true);
  assert.equal(elements["agent-runtime-edit-help"].classList.contains("hidden"), true);
  assert.equal(elements["agent-runtime-draft-actions"].classList.contains("hidden"), false);
  assert.equal(elements["agent-preflight"].disabled, false);
  for (const kind of ["codex", "pi"]) {
    context.openAgentModal();
    elements["agent-kind"].value = kind;
    context.syncAgentKindFields();
    assert.equal(elements["agent-kind"].value, kind);
    assert.equal(elements["agent-kind"].disabled, false);
    await elements["agent-form"].listeners.get("submit")({preventDefault() {}});
    assert.equal(requests.at(-1).method, "POST");
    assert.equal(requests.at(-1).path, "/api/agents");
    assert.equal(JSON.parse(requests.at(-1).body).kind, kind);
  }
});

test("existing Codex and Pi keep their editable same-kind settings and explicit preflight", async () => {
  const {context, elements, requests} = editorFixture();
  for (const kind of ["codex", "pi"]) {
    context.openAgentModal({...genericAgent, kind, executablePath: `/local/${kind}`});
    assert.equal(elements["agent-kind"].value, kind);
    assert.equal(elements["agent-kind"].disabled, true);
    assert.equal(elements["agent-path"].readOnly, false);
    assert.equal(elements["agent-sandbox-field"].classList.contains("hidden"), kind !== "codex");
    assert.equal(elements["agent-credential-field"].classList.contains("hidden"), kind !== "pi");
    assert.equal(elements["agent-runtime-draft-actions"].classList.contains("hidden"), false);
    assert.equal(requests.length, kind === "codex" ? 0 : 1, "opening an edit must not run a probe");
    await context.preflightDraft(kind, "agent", elements["agent-preflight"], elements["agent-preflight-result"]);
    assert.equal(requests.at(-1).path, "/api/runtime-preflight");
    assert.equal(JSON.parse(requests.at(-1).body).kind, kind);
  }
});

test("late preset discovery cannot overwrite a subsequently opened Generic profile", async () => {
  const {context, elements} = editorFixture();
  let resolveDiscovery;
  context.request = () => new Promise((resolve) => { resolveDiscovery = resolve; });
  context.openAgentModal({...genericAgent, agentId: "agent_codex_editor", kind: "codex"});
  const discovery = context.useDetectedRuntime("agent", "codex");
  context.closeAgentModal();
  context.openAgentModal(genericAgent);
  resolveDiscovery({codex: {path: "/refreshed/codex"}});
  await discovery;
  assert.equal(elements["agent-kind"].value, "generic");
  assert.equal(elements["agent-path"].value, "owner-cli");
  assert.equal(elements["agent-path"].readOnly, true);
  assert.equal(elements["agent-use-detected"].disabled, true);
  assert.equal(elements["agent-discovery-status"].classList.contains("hidden"), true);
});
