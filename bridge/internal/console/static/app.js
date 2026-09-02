import { createClientEntryController } from "./client-entry.mjs";
import { pairingView } from "./pairing-view.mjs";
import {
  configuredPairingEntryView,
  configuredPairingLaunchView,
  pairingLinkFromHash,
  pairingOriginFromLink
} from "./device-pairing-launch.mjs";
import { detectedPathForDraft, runtimeDiscoveryView } from "./runtime-discovery.mjs";
import {
  applyAgentRuntimePolicy,
  applyCodexSessionConflictPolicy,
  applyEnrollmentCodexPolicy
} from "./runtime-policy.mjs";
import { createSessionGuideController } from "./session-guide.mjs";
import { agentPresentation, connectionPresentation } from "./bridge-presentation.mjs";
import { reasoningConsentView } from "./reasoning-consent-view.mjs";
import { initializeWorkspacePickers } from "./workspace-picker.mjs";
import { governedOwnerPresentation } from "./governed-owner-view.mjs";

const elements = Object.fromEntries([
  "open-client-team", "load-client-rooms", "open-client-room", "client-room", "client-entry-status", "client-entry-help",
  "app-sidebar", "setup-intro", "page-context", "page-title", "phase", "phase-label",
  "configured", "paired", "running", "connection-state", "agent-count", "approval",
  "join-code", "join-expiry", "cancel-enrollment", "configured-view", "approval-eyebrow", "approval-title",
  "device-title", "start-bridge", "stop-bridge", "edit-connection", "add-agent", "current-server",
  "agent-provisioning-form", "agent-provisioning-mode", "fixed-management-code-field",
  "fixed-management-code", "rotating-management-code-panel", "rotating-management-code",
  "rotating-management-code-expiry", "save-agent-provisioning", "agent-provisioning-result",
  "pairing-status", "pairing-binding", "pairing-guidance", "pairing-blocked", "pairing-backup",
  "use-pairing-link", "switch-central", "request-enrollment", "start-existing-pairing", "join-copy-result",
  "pairing-link-modal-backdrop", "configured-pairing-link", "pairing-link-modal-error",
  "close-pairing-link-modal", "cancel-pairing-link-modal", "continue-pairing-link",
  "pairing-modal-backdrop", "pairing-modal-title", "pairing-modal-guidance", "pairing-modal-retention",
  "pairing-central-addresses", "pairing-current-central", "pairing-target-central",
  "pairing-modal-blocked", "close-pairing-modal", "cancel-pairing-modal", "stop-for-pairing",
  "confirm-reenrollment", "pairing-modal-error",
  "current-server-token", "current-server-trust",
  "current-reasoning-sharing", "share-reasoning-summaries", "connection-share-reasoning-summaries",
  "stop-for-reasoning-consent", "edit-reasoning-consent", "reasoning-consent-guidance",
  "current-team", "current-device", "config-path", "connection-detail", "last-connected", "connection-error", "agent-list",
  "overview-agent-list", "overview-agent-count", "connection-summary", "connection-summary-label",
  "connection-server-label", "connection-summary-title", "connection-summary-copy",
  "connection-technical", "connection-technical-message", "connection-fix",
  "enrollment-form", "server-url", "server-token", "device-name", "trust-mode", "fingerprint-field",
  "fingerprint", "codex-enabled", "codex-fields", "codex-name", "codex-role",
  "codex-path", "codex-workspace", "codex-workspace-alias", "codex-sandbox", "codex-session-conflict-policy",
  "codex-session-ownership-policy-copy", "pi-enabled", "pi-fields",
  "pi-name", "pi-role", "pi-path", "pi-workspace", "pi-workspace-alias", "pi-credential-env",
  "pi-permission-policy",
  "codex-use-detected", "codex-preflight", "codex-preflight-result",
  "pi-use-detected", "pi-preflight", "pi-preflight-result",
  "device-pairing-link", "device-pairing-short-code", "submit-device-pairing",
  "submit-enrollment", "auth-warning", "error", "bridge-version",
  "login-startup-row", "login-startup", "login-startup-unsupported", "login-startup-warning", "export-diagnostics",
  "diagnostics-result", "check-update", "update-result", "release-link",
  "agent-modal-backdrop", "agent-modal-title", "close-agent-modal", "cancel-agent-modal",
  "agent-modal-error",
  "agent-form", "agent-kind", "agent-name", "agent-role", "agent-path", "agent-workspace", "agent-workspace-alias",
  "agent-generic-option", "agent-runtime-edit-help", "agent-generic-runtime-help", "agent-runtime-draft-actions",
  "agent-sandbox-field", "agent-sandbox", "agent-session-conflict-policy-field",
  "agent-session-conflict-policy", "agent-credential-field", "agent-credential-env",
  "agent-codex-session-ownership-policy", "agent-codex-session-ownership-policy-copy",
  "agent-pi-permission-policy", "save-agent",
  "agent-use-detected", "agent-preflight", "agent-preflight-result",
  "codex-discovery-status", "codex-discovery-help", "codex-install-link",
  "pi-discovery-status", "pi-discovery-help", "pi-install-link",
  "agent-discovery-status", "agent-discovery-help", "agent-install-link",
  "connection-modal-backdrop", "connection-modal-title", "close-connection-modal",
  "cancel-connection-modal", "connection-modal-error", "connection-form",
  "connection-server-url", "connection-server-token", "clear-server-token-field", "clear-server-token",
  "connection-trust-mode", "connection-fingerprint-field",
  "connection-fingerprint", "save-connection",
  "codex-session-guide", "close-codex-session-guide", "acknowledge-codex-session-guide",
  "refresh-governed-state", "governed-state-summary", "governed-inventory", "governed-action-result"
].map((id) => [id, document.getElementById(id)]));

const sessionGuide = createSessionGuideController(
  elements["codex-session-guide"],
  elements["close-codex-session-guide"]
);

const query = new URLSearchParams(window.location.search);
let pendingPairingLink = pairingLinkFromHash(window.location.hash);
if (query.get("token")) {
  sessionStorage.setItem("agent-room-console-token", query.get("token"));
  history.replaceState(null, "", window.location.pathname);
} else if (window.location.hash) {
  history.replaceState(null, "", window.location.pathname);
}
if (pendingPairingLink) {
  elements["device-pairing-link"].value = pendingPairingLink;
  elements["server-url"].value = pairingOriginFromLink(pendingPairingLink);
}
const token = sessionStorage.getItem("agent-room-console-token") || "";
if (!token) elements["auth-warning"].classList.remove("hidden");
let currentState = null;
let editingAgentId = null;
let draftPreflightRunning = false;
let enrollmentActionRunning = false;
let expectedPairingDeviceId = null;
let pairingReview = null;
let discoveryRunning = false;
let agentProvisioningDirty = false;
let activePage = "overview";
const runtimeTestResults = new Map();

// A WebView may treat a later activation as same-document navigation. Consume
// that fragment as well as the first page load, then remove proof from the URL.
window.addEventListener("hashchange", consumePairingLaunchHash);

function consumePairingLaunchHash() {
  const incoming = pairingLinkFromHash(window.location.hash);
  if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  if (!incoming) return;
  if (enrollmentActionRunning || currentState?.enrollment?.active) {
    showError(new Error("已有 Device 配对正在进行，请先完成或取消当前配对。"));
    return;
  }
  pendingPairingLink = incoming;
  elements["device-pairing-link"].value = incoming;
  elements["server-url"].value = pairingOriginFromLink(incoming);
  if (currentState) renderConfiguredPairingLaunch(currentState);
}

const pageCopy = {
  overview: {context: "本机执行环境", title: "概览"},
  agents: {context: "Runtime 与权限", title: "本机 Agent"},
  governed: {context: "只保存在这台设备", title: "受控开发"},
  settings: {context: "只保存在这台设备", title: "设置"}
};

function setPage(page, focus = false) {
  if (!pageCopy[page]) return;
  activePage = page;
  for (const panel of document.querySelectorAll("[data-page-panel]")) {
    panel.classList.toggle("hidden", panel.dataset.pagePanel !== page);
  }
  for (const item of document.querySelectorAll(".nav-item[data-page-target]")) {
    const selected = item.dataset.pageTarget === page;
    item.classList.toggle("active", selected);
    if (selected) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  elements["page-context"].textContent = pageCopy[page].context;
  elements["page-title"].textContent = pageCopy[page].title;
  if (focus) document.querySelector(`[data-page-panel="${page}"] h2`)?.focus?.();
  if (page === "governed") void refreshGovernedState();
}

function governedInventoryGroup(title, entries, renderEntry) {
  const section = document.createElement("section");
  section.className = "governed-inventory-group";
  const heading = document.createElement("h4");
  heading.textContent = `${title} · ${entries.length}`;
  section.append(heading);
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "暂无记录";
    section.append(empty);
    return section;
  }
  for (const entry of entries) section.append(renderEntry(entry));
  return section;
}

function governedIdentityRow(primary, secondary, status, action) {
  const row = document.createElement("div");
  row.className = "governed-identity-row";
  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = primary;
  const small = document.createElement("small");
  small.textContent = secondary;
  copy.append(strong, small);
  const state = document.createElement("span");
  state.textContent = status;
  row.append(copy, state);
  if (action) row.append(action);
  return row;
}

function renderGovernedState(state) {
  const presentation = governedOwnerPresentation(state);
  elements["governed-state-summary"].textContent = presentation.summary;
  elements["governed-inventory"].replaceChildren(...presentation.groups.map((group) =>
    governedInventoryGroup(group.title, group.rows, (row) => {
      let button;
      if (row.revocation) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "secondary compact-action";
        button.textContent = "撤销";
        button.addEventListener("click", () => void revokeGovernedGrant(row, button));
      }
      return governedIdentityRow(row.primary, row.secondary, row.status, button);
    })));
}

async function refreshGovernedState() {
  if (!token || !currentState?.configured || !currentState?.paired) return;
  elements["refresh-governed-state"].disabled = true;
  elements["governed-action-result"].textContent = "正在读取本机授权…";
  try {
    renderGovernedState(await request("/api/governed-owner-state"));
    elements["governed-action-result"].textContent = "已读取；列表不包含本机路径、命令或环境值。";
  } catch (error) {
    elements["governed-action-result"].textContent = "读取失败。";
    showError(error);
  } finally {
    elements["refresh-governed-state"].disabled = false;
  }
}

async function revokeGovernedGrant(row, button) {
  const confirmed = window.confirm(`撤销 ${row.primary}？当前 Bridge 和受控 Runtime 会先安全停止。`);
  if (!confirmed) return;
  button.disabled = true;
  elements["governed-action-result"].textContent = "正在停止当前执行并撤销授权…";
  try {
    await request(row.revocation.path, {
      method: "POST",
      body: JSON.stringify(row.revocation.body)
    });
    await refresh();
    await refreshGovernedState();
    elements["governed-action-result"].textContent = "授权已不可逆撤销；原有 Git 数据未删除。";
  } catch (error) {
    button.disabled = false;
    elements["governed-action-result"].textContent = "撤销失败，未假定授权状态。";
    showError(error);
  }
}

const labels = {
  unconfigured: "等待配置",
  ready: "已就绪",
  joining: "正在请求加入",
  waiting_approval: "等待 Owner 审批",
  running: "Bridge 运行中",
  error: "需要处理"
};

const connectionLabels = {
  stopped: "已停止",
  connecting: "连接中",
  online: "在线",
  retrying: "重连中"
};

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {...options, headers});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

const clientEntryController = createClientEntryController({elements, request});

function showError(error) {
  const message = error ? String(error.message || error) : "";
  elements.error.textContent = message;
  elements.error.classList.toggle("hidden", !message);
  elements["agent-modal-error"].textContent = message;
  elements["agent-modal-error"].classList.toggle("hidden", !message);
  elements["connection-modal-error"].textContent = message;
  elements["connection-modal-error"].classList.toggle("hidden", !message);
  elements["pairing-modal-error"].textContent = message;
  elements["pairing-modal-error"].classList.toggle("hidden", !message);
}

void initializeWorkspacePickers({onError: showError});

function setRuntime(kind, enabled) {
  elements[`${kind}-fields`].classList.toggle("hidden", !enabled);
  for (const input of elements[`${kind}-fields`].querySelectorAll("input, select, button")) {
    input.disabled = !enabled;
  }
  if (kind === "codex") {
    applyEnrollmentCodexPolicy(enabled, elements["codex-enabled"]);
  }
}

function runtimeDraft(kind, source) {
  const prefix = source === "agent" ? "agent" : kind;
  return {
    kind,
    enabled: true,
    name: elements[`${prefix}-name`].value,
    role: elements[`${prefix}-role`].value,
    executablePath: elements[`${prefix}-path`].value,
    workspace: elements[`${prefix}-workspace`].value,
    workspaceAlias: elements[`${prefix}-workspace-alias`].value,
    sandbox: kind === "codex" ? elements[`${prefix}-sandbox`].value : "",
    codexSessionConflictPolicy: kind === "codex"
      ? elements[`${prefix}-session-conflict-policy`].value
      : "",
    credentialEnvironmentVariable: kind === "pi"
      ? elements[`${prefix}-credential-env`].value
      : ""
  };
}

function probeSummary(result) {
  const exit = result.exitCode === undefined ? "" : ` · 退出码 ${result.exitCode}`;
  return result.passed
    ? `预检通过 · ${result.durationMillis} ms`
    : `预检失败 · ${result.code}${result.category ? ` · ${result.category}` : ""}${exit}`;
}

async function preflightDraft(kind, source, button, resultElement) {
  if (draftPreflightRunning || (kind !== "codex" && kind !== "pi")) return;
  draftPreflightRunning = true;
  button.disabled = true;
  const saveButton = source === "agent" ? elements["save-agent"] : elements["submit-enrollment"];
  saveButton.disabled = true;
  resultElement.className = "";
  resultElement.textContent = "正在执行受限预检…";
  showError(null);
  try {
    const result = await request("/api/runtime-preflight", {
      method: "POST",
      body: JSON.stringify(runtimeDraft(kind, source))
    });
    resultElement.className = result.passed ? "probe-passed" : "probe-failed";
    resultElement.textContent = probeSummary(result);
  } catch (error) {
    resultElement.className = "probe-failed";
    resultElement.textContent = "预检请求失败";
    showError(error);
  } finally {
    draftPreflightRunning = false;
    button.disabled = false;
    saveButton.disabled = false;
  }
}

function renderAgent(agent, {compact = false} = {}) {
  const view = agentPresentation(agent, {bridgeRunning: currentState.bridgeRunning});
  const row = document.createElement("article");
  row.className = "agent-row";
  row.classList.toggle("compact-agent", compact);

  const header = document.createElement("div");
  header.className = "agent-card-header";
  const avatar = document.createElement("span");
  avatar.className = "agent-avatar";
  avatar.textContent = view.initials;
  const identity = document.createElement("div");
  identity.className = "agent-identity";
  const title = document.createElement("strong");
  title.textContent = agent.name;
  const role = document.createElement("span");
  role.textContent = `${view.role} · ${view.kindLabel}`;
  identity.append(title, role);
  const status = document.createElement("span");
  status.className = `runtime-status ${view.tone}`;
  status.textContent = view.status;
  header.append(avatar, identity, status);

  const facts = document.createElement("div");
  facts.className = "agent-facts";
  const factRows = [
    ["文件策略", view.filesystemPolicy],
    ["网络策略", view.networkPolicy],
    ["工作区", view.workspaceName],
    ["Runtime", view.executableSummary, "runtime-fact"]
  ];
  if (view.sessionConflictPolicy) {
    factRows.splice(1, 0, ["会话占用", view.sessionConflictPolicy]);
  }
  for (const [label, value, className = ""] of factRows) {
    const fact = document.createElement("div");
    fact.className = `agent-fact ${className}`.trim();
    const factLabel = document.createElement("span");
    factLabel.textContent = label;
    const factValue = document.createElement("strong");
    factValue.textContent = value;
    fact.append(factLabel, factValue);
    facts.append(fact);
  }

  const actions = document.createElement("div");
  actions.className = "agent-actions";
  const probeButton = document.createElement("button");
  probeButton.className = "secondary";
  probeButton.type = "button";
  probeButton.textContent = compact ? "测试" : "测试运行";
  const probeSupported = agent.kind === "codex" || agent.kind === "pi";
  probeButton.disabled = currentState.enrollment?.active || !probeSupported || !agent.executableReady || agent.activeRuns > 0;
  const probeResult = document.createElement("span");
  probeResult.className = "agent-probe-result";
  const latestProbe = runtimeTestResults.get(agent.agentId);
  if (latestProbe === "running") {
    probeButton.disabled = true;
    probeResult.textContent = "正在执行只读自检…";
  } else if (latestProbe) {
    probeResult.className = latestProbe.passed ? "probe-passed" : "probe-failed";
    const exit = latestProbe.exitCode === undefined ? "" : ` · 退出码 ${latestProbe.exitCode}`;
    probeResult.textContent = latestProbe.passed
      ? `自检通过 · ${latestProbe.durationMillis} ms`
      : `自检失败 · ${latestProbe.code}${latestProbe.category ? ` · ${latestProbe.category}` : ""}${exit}`;
  } else {
    probeResult.textContent = !probeSupported
      ? "Generic CLI 不支持自动自检"
      : agent.activeRuns > 0
      ? "任务执行期间不可自检"
      : "尚未测试";
  }
  probeButton.addEventListener("click", async () => {
    runtimeTestResults.set(agent.agentId, "running");
    render(currentState);
    try {
      const result = await request("/api/runtime-tests", {
        method: "POST",
        body: JSON.stringify({agentId: agent.agentId})
      });
      runtimeTestResults.set(agent.agentId, result);
    } catch (error) {
      runtimeTestResults.delete(agent.agentId);
      showError(error);
    }
    if (currentState) render(currentState);
  });
  const editButton = document.createElement("button");
  editButton.className = "secondary agent-edit";
  editButton.type = "button";
  editButton.textContent = "编辑";
  editButton.disabled = currentState.enrollment?.active || currentState.agents.some((candidate) => candidate.activeRuns > 0) ||
    [...runtimeTestResults.values()].includes("running");
  editButton.addEventListener("click", () => openAgentModal(agent));
  actions.append(probeButton, probeResult, editButton);
  row.append(header, facts, actions);
  return row;
}

function usesHTTPS(value) {
  return value.trim().toLowerCase().startsWith("https://");
}

function syncTrustFields() {
  const https = usesHTTPS(elements["server-url"].value);
  elements["trust-mode"].disabled = !https;
  elements["fingerprint-field"].classList.toggle(
    "hidden",
    !https || elements["trust-mode"].value !== "pinned_sha256"
  );
}

function syncConnectionTrustFields() {
  const https = usesHTTPS(elements["connection-server-url"].value);
  elements["connection-trust-mode"].disabled = !https;
  elements["connection-fingerprint-field"].classList.toggle(
    "hidden",
    !https || elements["connection-trust-mode"].value !== "pinned_sha256"
  );
}

function syncConnectionTokenFields() {
  const configured = Boolean(currentState?.serverTokenConfigured);
  elements["clear-server-token"].disabled = !configured;
  if (!configured) elements["clear-server-token"].checked = false;
  elements["connection-server-token"].disabled = elements["clear-server-token"].checked;
}

function syncAgentProvisioningFields() {
  const mode = elements["agent-provisioning-mode"].value;
  elements["fixed-management-code-field"].classList.toggle("hidden", mode !== "fixed");
  elements["rotating-management-code-panel"].classList.toggle("hidden", mode !== "rotating");
  const fixedReady = mode !== "fixed" || /^[0-9]{8}$/.test(elements["fixed-management-code"].value);
  elements["save-agent-provisioning"].disabled = !fixedReady;
}

function syncAgentKindFields() {
  const kind = elements["agent-kind"].value;
  const codex = kind === "codex";
  const generic = kind === "generic";
  elements["agent-sandbox-field"].classList.toggle("hidden", !codex);
  elements["agent-session-conflict-policy-field"].classList.toggle("hidden", !codex);
  elements["agent-credential-field"].classList.toggle("hidden", kind !== "pi");
  elements["agent-path"].readOnly = generic;
  elements["agent-path"].setAttribute("aria-describedby", generic ? "agent-generic-runtime-help" : "agent-discovery-help");
  elements["agent-generic-runtime-help"].classList.toggle("hidden", !generic);
  elements["agent-runtime-draft-actions"].classList.toggle("hidden", generic);
  elements["agent-preflight"].disabled = generic || draftPreflightRunning;
  applyAgentRuntimePolicy(
    kind,
    elements["agent-kind"],
    elements["agent-codex-session-ownership-policy"],
    elements["agent-pi-permission-policy"]
  );
  applyCodexSessionConflictPolicy(
    elements["agent-session-conflict-policy"].value,
    elements["agent-codex-session-ownership-policy-copy"]
  );
  renderDiscovery("agent", kind);
}

function renderDiscovery(prefix, kind) {
  const preset = kind === "codex" || kind === "pi";
  elements[`${prefix}-discovery-status`].classList.toggle("hidden", !preset);
  elements[`${prefix}-discovery-help`].classList.toggle("hidden", !preset);
  elements[`${prefix}-use-detected`].disabled = !preset || discoveryRunning;
  if (!preset) {
    elements[`${prefix}-install-link`].classList.add("hidden");
    return;
  }
  if (!currentState) return;
  const view = runtimeDiscoveryView(kind, currentState);
  elements[`${prefix}-discovery-status`].textContent = view.status;
  elements[`${prefix}-discovery-help`].textContent = view.help;
  elements[`${prefix}-install-link`].classList.toggle("hidden", !view.showCodexInstall);
}

async function useDetectedRuntime(prefix, kind) {
  if (discoveryRunning || (kind !== "codex" && kind !== "pi")) return;
  const input = elements[`${prefix}-path`];
  const draftPath = input.value;
  const draftAgent = editingAgentId;
  discoveryRunning = true;
  showError(null);
  try {
    const discovered = await request("/api/runtime-discovery");
    currentState.runtimeDiscovery = discovered;
    currentState.detectedCodex = discovered.codex?.path || "";
    currentState.detectedPi = discovered.pi?.path || "";
    if (input.value === draftPath && (prefix !== "agent" ||
      (elements["agent-kind"].value === kind && editingAgentId === draftAgent))) {
      input.value = detectedPathForDraft(draftPath, discovered[kind]?.path);
    }
  } catch (error) {
    showError(error);
  } finally {
    discoveryRunning = false;
    renderDiscovery("codex", "codex");
    renderDiscovery("pi", "pi");
    renderDiscovery("agent", elements["agent-kind"].value);
  }
}

function openAgentModal(agent = null) {
  showError(null);
  editingAgentId = agent?.agentId || null;
  const kind = agent ? agent.kind : "codex";
  elements["agent-modal-title"].textContent = agent ? `编辑 ${agent.name}` : "添加智能体";
  elements["agent-generic-option"].disabled = kind !== "generic";
  elements["agent-generic-option"].hidden = kind !== "generic";
  elements["agent-kind"].disabled = Boolean(agent);
  elements["agent-kind"].value = kind;
  elements["agent-runtime-edit-help"].classList.toggle("hidden", !agent);
  elements["agent-name"].value = agent?.name || (kind === "pi" ? "Local Pi" : "Local Codex");
  elements["agent-role"].value = agent?.role || (kind === "pi" ? "Reviewer" : "Implementation");
  elements["agent-path"].value = agent ? agent.executablePath || "" : currentState.detectedCodex || "";
  elements["agent-workspace"].value = agent?.workspace || currentState.agents[0]?.workspace || currentState.workspace || "";
  elements["agent-workspace-alias"].value = agent?.workspaceAlias || "";
  elements["agent-sandbox"].value = agent?.sandbox || "workspace-write";
  elements["agent-session-conflict-policy"].value =
    agent?.codexSessionConflictPolicy || "preserve_and_retry";
  elements["agent-credential-env"].value = agent?.credentialEnvironmentVariable || "";
  elements["agent-preflight-result"].className = "";
  elements["agent-preflight-result"].textContent = "先验证当前表单；不会写入文件或重启 Bridge。";
  syncAgentKindFields();
  elements["agent-modal-backdrop"].classList.remove("hidden");
  elements["agent-name"].focus();
}

function closeAgentModal() {
  editingAgentId = null;
  elements["agent-modal-backdrop"].classList.add("hidden");
}

function openConnectionModal(focusReasoningConsent = false) {
  showError(null);
  elements["connection-server-url"].value = currentState.serverUrl || "";
  elements["connection-server-token"].value = "";
  elements["connection-server-token"].placeholder = currentState.serverTokenConfigured
    ? "留空则保留当前 Token"
    : "输入中央服务管理员提供的 Token";
  elements["clear-server-token"].checked = false;
  elements["connection-trust-mode"].value = currentState.serverTrustMode || "system_ca";
  elements["connection-fingerprint"].value = currentState.serverCertificateSha256 || "";
  elements["connection-share-reasoning-summaries"].checked = Boolean(currentState.shareReasoningSummaries);
  syncConnectionTrustFields();
  syncConnectionTokenFields();
  elements["connection-modal-backdrop"].classList.remove("hidden");
  elements[focusReasoningConsent ? "connection-share-reasoning-summaries" : "connection-server-url"].focus();
}

function closeConnectionModal() {
  elements["connection-modal-backdrop"].classList.add("hidden");
}

function render(state) {
  currentState = state;
  clientEntryController.render(state);
  const waiting = Boolean(state.enrollment?.active);
  renderDiscovery("codex", "codex");
  renderDiscovery("pi", "pi");
  renderDiscovery("agent", elements["agent-kind"].value);
  document.body.classList.toggle("configured-mode", state.configured);
  elements["app-sidebar"].classList.toggle("hidden", !state.configured);
  elements["setup-intro"].classList.toggle("hidden", state.configured || waiting);
  if (state.configured) {
    setPage(activePage);
  } else {
    elements["page-context"].textContent = waiting ? "Team 审批" : "首次设置";
    elements["page-title"].textContent = waiting ? "等待 Owner 批准" : "开始使用 Bridge";
  }
  elements["phase-label"].textContent = state.configured && !state.bridgeRunning
    ? "Bridge 已停止"
    : (labels[state.phase] || state.phase);
  elements.phase.classList.toggle("running", state.bridgeRunning);
  elements.configured.textContent = state.configured ? "已创建" : "未创建";
  elements.paired.textContent = state.paired ? "已保存配对" : "未配对";
  elements.running.textContent = state.bridgeRunning ? "运行中" : "已停止";
  const connection = state.connection || {state: state.bridgeRunning ? "connecting" : "stopped"};
  const connectionView = connectionPresentation(state);
  elements["connection-state"].textContent = connectionLabels[connection.state] || connection.state;
  elements["agent-count"].textContent = `${state.agents.length} 个`;
  elements["overview-agent-count"].textContent = `${state.agents.length} 个 Agent`;
  elements["bridge-version"].textContent = state.version || "dev";
  elements["connection-summary"].className = `connection-card ${connectionView.tone}`;
  elements["connection-summary-label"].textContent = connectionView.label;
  elements["connection-server-label"].textContent = connectionView.server;
  elements["connection-summary-title"].textContent = connectionView.title;
  elements["connection-summary-copy"].textContent = connectionView.summary;
  elements["connection-technical"].classList.toggle("hidden", !connectionView.technicalDetail);
  elements["connection-technical-message"].textContent = connectionView.technicalDetail;
  elements["connection-fix"].classList.toggle("hidden", connectionView.action !== "settings");
  elements["start-bridge"].classList.toggle("hidden", connectionView.action !== "start");
  elements["stop-bridge"].classList.toggle("hidden", !state.bridgeRunning);

  const pairing = pairingView(state);
  elements["pairing-status"].textContent = pairing.status;
  elements["pairing-binding"].textContent = pairing.binding;
  elements["pairing-guidance"].textContent = pairing.guidance;
  elements["pairing-blocked"].textContent = pairing.blockedReason;
  elements["request-enrollment"].classList.toggle("hidden", !pairing.showRequest);
  elements["request-enrollment"].textContent = pairing.requestLabel;
  elements["request-enrollment"].disabled = enrollmentActionRunning || !pairing.canRequest;
  elements["use-pairing-link"].disabled = enrollmentActionRunning || Boolean(state.enrollment?.active);
  elements["switch-central"].disabled = elements["use-pairing-link"].disabled;
  elements["start-existing-pairing"].classList.toggle("hidden", !state.paired);
  elements["start-existing-pairing"].disabled = !pairing.canStartExisting;
  const backup = state.enrollment?.backupConfigPath;
  elements["pairing-backup"].classList.toggle("hidden", !backup);
  elements["pairing-backup"].textContent = backup ? `旧配置备份：${backup}（旧数据目录保持原样）` : "";
  elements.approval.classList.toggle("hidden", !pairing.showApproval);
  elements["approval-eyebrow"].textContent = pairing.approvalEyebrow;
  elements["approval-title"].textContent = pairing.approvalTitle;
  if (elements["join-code"].textContent !== pairing.codeText) {
    elements["join-copy-result"].textContent = pairing.canCopy ? "点击代码复制；也可手动选择代码。" : "";
  }
  elements["join-code"].textContent = pairing.codeText;
  elements["join-code"].disabled = !pairing.canCopy;
  elements["join-expiry"].textContent = pairing.expiry;
  elements["cancel-enrollment"].disabled = !pairing.canCancel || enrollmentActionRunning;

  elements["configured-view"].classList.toggle("hidden", !state.configured);
  elements["enrollment-form"].classList.toggle("hidden", state.configured || waiting);
  if (state.configured) {
    elements["device-title"].textContent = state.deviceName;
    elements["current-server"].textContent = state.serverUrl;
    elements["current-server-token"].textContent = state.serverTokenConfigured ? "已配置" : "未配置";
    const trustMode = state.activeServerTrustMode || state.serverTrustMode || "system_ca";
    elements["current-server-trust"].textContent = trustMode === "private_scoped_ca"
      ? `Bridge 定向私有 CA · epoch ${state.serverTrustEpoch} · SHA-256 ${state.serverCaDigestPrefix}…`
      : (trustMode === "system_ca" ? "系统 CA（公开证书默认）" : "叶证书指纹（高级兼容）");
    elements["current-reasoning-sharing"].textContent = state.shareReasoningSummaries ? "已授权（仅公开摘要）" : "未授权（不共享摘要）";
    elements["current-team"].textContent = state.teamId || "等待配对";
    elements["current-device"].textContent = state.deviceId || "等待配对";
    elements["config-path"].textContent = state.configPath;
    elements["connection-detail"].textContent = connection.state === "retrying"
      ? `${connectionLabels[connection.state]} · 第 ${connection.attempt || 1} 次尝试`
      : (connectionLabels[connection.state] || connection.state);
    elements["last-connected"].textContent = connection.lastConnectedAt
      ? new Date(connection.lastConnectedAt).toLocaleString()
      : "尚未连接";
    elements["connection-error"].textContent = connection.lastError || "";
    elements["connection-error"].classList.toggle("hidden", !connection.lastError);
    elements["start-bridge"].disabled = !pairing.canStartExisting;
    elements["stop-bridge"].disabled = !state.bridgeRunning;
    const interactionBusy = waiting || [...runtimeTestResults.values()].includes("running") || draftPreflightRunning;
    const mutationBlocked = interactionBusy || state.agents.some((agent) => agent.activeRuns > 0);
    elements["add-agent"].classList.toggle("hidden", !state.paired);
    elements["add-agent"].disabled = mutationBlocked;
    elements["edit-connection"].classList.toggle("hidden", !state.paired);
    elements["edit-connection"].disabled = mutationBlocked;
    const consentView = reasoningConsentView(state, interactionBusy);
    elements["stop-for-reasoning-consent"].classList.toggle("hidden", consentView.action !== "stop");
    elements["edit-reasoning-consent"].classList.toggle("hidden", consentView.action !== "edit");
    elements["stop-for-reasoning-consent"].disabled = consentView.disabled;
    elements["edit-reasoning-consent"].disabled = consentView.disabled;
    elements["reasoning-consent-guidance"].textContent = consentView.guidance;
    if (!agentProvisioningDirty) {
      const provisioning = state.agentProvisioning || {mode: "disabled"};
      elements["agent-provisioning-mode"].value = provisioning.mode || "disabled";
      elements["fixed-management-code"].value = "";
      elements["fixed-management-code"].placeholder = provisioning.fixedCodeConfigured
        ? "已设置；输入新的 8 位码可替换"
        : "输入 8 位数字";
    }
    const provisioning = state.agentProvisioning || {mode: "disabled"};
    elements["rotating-management-code"].textContent = provisioning.rotatingCode || "------";
    elements["rotating-management-code-expiry"].textContent = provisioning.rotatesAt
      ? `将在 ${new Date(provisioning.rotatesAt).toLocaleTimeString()} 自动轮换`
      : "";
    syncAgentProvisioningFields();
    elements["agent-provisioning-mode"].disabled = mutationBlocked;
    elements["fixed-management-code"].disabled = mutationBlocked;
    if (mutationBlocked) elements["save-agent-provisioning"].disabled = true;
    elements["connection-fix"].disabled = mutationBlocked;
    elements["agent-list"].replaceChildren(...state.agents.map(renderAgent));
    elements["overview-agent-list"].replaceChildren(
      ...state.agents.map((agent) => renderAgent(agent, {compact: true}))
    );
  } else {
    if (!elements["device-name"].value) elements["device-name"].value = "Local Bridge";
    if (!elements["codex-path"].value) elements["codex-path"].value = state.detectedCodex || "";
    if (!elements["pi-path"].value) elements["pi-path"].value = state.detectedPi || "";
    for (const workspace of document.querySelectorAll(".workspace")) {
      if (!workspace.value) workspace.value = state.workspace || "";
    }
  }
  const startup = state.loginStartup || {supported: false, enabled: false};
  elements["login-startup-row"].classList.toggle("hidden", !startup.supported);
  elements["login-startup-unsupported"].classList.toggle("hidden", startup.supported);
  elements["login-startup"].checked = Boolean(startup.enabled);
  const startupWarning = startup.pathMismatch ? "应用位置已变化，请关闭后重新开启此选项以修复。" : "";
  elements["login-startup-warning"].textContent = startupWarning;
  elements["login-startup-warning"].classList.toggle("hidden", !startupWarning);
  elements["submit-enrollment"].textContent = "使用旧版加入码";
  elements["submit-enrollment"].disabled = waiting || enrollmentActionRunning || draftPreflightRunning;
  elements["submit-device-pairing"].disabled = waiting || enrollmentActionRunning || draftPreflightRunning;
  renderConfiguredPairingLaunch(state);
}

function renderConfiguredPairingLaunch(state) {
  const view = configuredPairingLaunchView(pendingPairingLink, state);
  if (!view.show) return;
  if (!pairingReview || pairingReview.link !== pendingPairingLink) {
    pairingReview = {link: pendingPairingLink, serverUrl: state.serverUrl, deviceId: state.paired ? state.deviceId : null};
  }
  const stale = pairingReview.serverUrl !== state.serverUrl || pairingReview.deviceId !== (state.paired ? state.deviceId : null);
  const switching = pairingOriginFromLink(pairingReview.link) !== pairingReview.serverUrl;
  elements["pairing-modal-title"].textContent = switching ? "切换 Central 并重新配对" : view.mode === "replace"
    ? "使用链接重新配对"
    : "继续未完成的 Device 配对";
  elements["pairing-modal-guidance"].textContent = switching
    ? "确认后将向下方新 Central 申请配对。请在新 Central 核对确认短语并由 Owner 批准，成功后才切换连接。旧 Team 历史不会迁移，旧设备不会自动撤销。"
    : view.mode === "replace"
    ? "该链接会向当前 Central 申请新的 Device 身份。只有确认短语一致并由 Owner 批准后，Bridge 才会切换身份。"
    : "这台 Bridge 已保存本机配置但还没有 Device 凭据。确认后将使用该链接继续配对。";
  elements["pairing-modal-retention"].textContent = switching
    ? "保留本机 Agent、Runtime 和工作区。失败或取消保留旧配置；成功后保存旧配置备份。旧凭据与证书信任不带入新 Central；思考摘要共享和远程添加 Agent 授权将关闭，可在切换后重新设置。"
    : view.mode === "replace"
    ? "旧身份、旧数据与全部本机 Agent 配置在新身份安全保存前保持不变；失败或取消仍可使用旧配对。"
    : "本机 Runtime、Workspace 与隐私设置保持不变；配对链接不会覆盖它们。";
  elements["pairing-central-addresses"].classList.toggle("hidden", !switching);
  elements["pairing-current-central"].textContent = pairingReview.serverUrl;
  elements["pairing-target-central"].textContent = pairingOriginFromLink(pairingReview.link);
  const blockedReason = stale ? "当前配对或 Central 已变化，请关闭确认窗口后重试。" : view.blockedReason;
  elements["pairing-modal-blocked"].textContent = blockedReason;
  elements["pairing-modal-blocked"].classList.toggle("hidden", !blockedReason);
  elements["stop-for-pairing"].classList.toggle("hidden", stale || !view.showStop);
  elements["confirm-reenrollment"].textContent = switching ? "确认切换并配对" : "确认申请新身份";
  elements["confirm-reenrollment"].disabled = enrollmentActionRunning || stale || !view.canConfirm;
  elements["pairing-modal-backdrop"].classList.remove("hidden");
}

async function refresh() {
  if (!token) return;
  try {
    render(await request("/api/state"));
  } catch (error) {
    showError(error);
  }
}

for (const target of document.querySelectorAll("[data-page-target]")) {
  target.addEventListener("click", () => setPage(target.dataset.pageTarget, true));
}

elements["refresh-governed-state"].addEventListener("click", () => void refreshGovernedState());

elements["connection-fix"].addEventListener("click", () => {
  setPage("settings");
  openConnectionModal();
});

elements["server-url"].addEventListener("input", () => {
  syncTrustFields();
});
elements["trust-mode"].addEventListener("change", syncTrustFields);
elements["connection-server-url"].addEventListener("input", syncConnectionTrustFields);
elements["connection-trust-mode"].addEventListener("change", syncConnectionTrustFields);
elements["clear-server-token"].addEventListener("change", () => {
  if (elements["clear-server-token"].checked) elements["connection-server-token"].value = "";
  syncConnectionTokenFields();
});
elements["agent-provisioning-mode"].addEventListener("change", () => {
  agentProvisioningDirty = true;
  syncAgentProvisioningFields();
});
elements["fixed-management-code"].addEventListener("input", () => {
  agentProvisioningDirty = true;
  elements["fixed-management-code"].value = elements["fixed-management-code"].value.replace(/[^0-9]/g, "");
  syncAgentProvisioningFields();
});
elements["rotating-management-code"].addEventListener("click", async () => {
  const code = currentState?.agentProvisioning?.rotatingCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    elements["agent-provisioning-result"].textContent = "动态管理码已复制。";
  } catch {
    elements["agent-provisioning-result"].textContent = "无法自动复制，请手动选择代码。";
  }
});
elements["codex-enabled"].addEventListener("change", () => setRuntime("codex", elements["codex-enabled"].checked));
elements["server-url"].addEventListener("input", () => { elements["share-reasoning-summaries"].checked = false; });
elements["connection-server-url"].addEventListener("input", () => { elements["connection-share-reasoning-summaries"].checked = false; });
elements["pi-enabled"].addEventListener("change", () => setRuntime("pi", elements["pi-enabled"].checked));
elements["join-code"].addEventListener("click", async () => {
  if (!currentState || !pairingView(currentState).canCopy) return;
  try {
    await navigator.clipboard.writeText(currentState.joinCode);
    elements["join-copy-result"].textContent = "审批码已复制。请交给目标 Team 的 Owner 审批。";
  } catch {
    elements["join-copy-result"].textContent = "无法自动复制，请手动选择并复制上方审批码。";
  }
});

function renderPairingLinkEntry() {
  const view = configuredPairingEntryView(
    elements["configured-pairing-link"].value,
    currentState
  );
  elements["pairing-link-modal-error"].textContent = view.error;
  elements["pairing-link-modal-error"].classList.toggle("hidden", !view.error);
  elements["continue-pairing-link"].disabled = !view.canContinue;
  return view;
}

function closePairingLinkModal() {
  elements["configured-pairing-link"].value = "";
  elements["pairing-link-modal-error"].textContent = "";
  elements["pairing-link-modal-error"].classList.add("hidden");
  elements["continue-pairing-link"].disabled = true;
  elements["pairing-link-modal-backdrop"].classList.add("hidden");
}

for (const id of ["use-pairing-link", "switch-central"]) {
  elements[id].addEventListener("click", () => {
    closePairingLinkModal();
    elements["pairing-link-modal-backdrop"].classList.remove("hidden");
    elements["configured-pairing-link"].focus();
  });
}
elements["configured-pairing-link"].addEventListener("input", renderPairingLinkEntry);
for (const id of ["close-pairing-link-modal", "cancel-pairing-link-modal"]) {
  elements[id].addEventListener("click", closePairingLinkModal);
}
elements["continue-pairing-link"].addEventListener("click", () => {
  const view = renderPairingLinkEntry();
  if (!view.canContinue || !currentState?.configured) return;
  pendingPairingLink = elements["configured-pairing-link"].value.trim();
  closePairingLinkModal();
  renderConfiguredPairingLaunch(currentState);
});

function closePairingModal() {
  if (enrollmentActionRunning) return;
  elements["pairing-modal-backdrop"].classList.add("hidden");
  expectedPairingDeviceId = null;
  pairingReview = null;
  if (pendingPairingLink) {
    pendingPairingLink = "";
    elements["device-pairing-link"].value = "";
  }
}

async function requestConfiguredDevicePairing() {
  if (enrollmentActionRunning || !pendingPairingLink || !currentState?.configured || !pairingReview) return;
  const review = pairingReview;
  if (review.link !== pendingPairingLink || review.serverUrl !== currentState.serverUrl ||
      review.deviceId !== (currentState.paired ? currentState.deviceId : null) ||
      !configuredPairingLaunchView(review.link, currentState).canConfirm) return;
  enrollmentActionRunning = true;
  elements["confirm-reenrollment"].disabled = true;
  showError(null);
  try {
    const switchConfirmation = {
      expectedServerUrl: review.serverUrl,
      confirmCentralSwitch: pairingOriginFromLink(review.link) !== review.serverUrl
    };
    if (review.deviceId) {
      await request("/api/device-pairing/restart", {
        method: "POST",
        body: JSON.stringify({
          pairingLink: review.link,
          confirmNewDevice: true,
          expectedDeviceId: review.deviceId,
          ...switchConfirmation
        })
      });
    } else {
      await request("/api/device-pairing/start", {
        method: "POST",
        body: JSON.stringify({pairingLink: review.link, ...switchConfirmation})
      });
    }
    pendingPairingLink = "";
    elements["device-pairing-link"].value = "";
    elements["pairing-modal-backdrop"].classList.add("hidden");
    expectedPairingDeviceId = null;
    pairingReview = null;
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    enrollmentActionRunning = false;
    if (currentState) renderConfiguredPairingLaunch(currentState);
  }
}
async function requestEnrollment(expectedDeviceId = null) {
  if (enrollmentActionRunning) return;
  enrollmentActionRunning = true;
  elements["confirm-reenrollment"].disabled = true;
  showError(null);
  try {
    if (currentState.enrollment?.active && pairingView(currentState).canRequest) {
      await request("/api/enrollment/cancel", {method: "POST"});
    }
    await request(expectedDeviceId ? "/api/enrollment/restart" : "/api/enrollment/start", {
      method: "POST",
      ...(expectedDeviceId ? {body: JSON.stringify({confirmNewDevice: true, expectedDeviceId})} : {})
    });
    elements["pairing-modal-backdrop"].classList.add("hidden");
    expectedPairingDeviceId = null;
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    enrollmentActionRunning = false;
    elements["confirm-reenrollment"].disabled = false;
  }
}
elements["request-enrollment"].addEventListener("click", () => {
  if (currentState.paired) {
    pendingPairingLink = "";
    pairingReview = null;
    expectedPairingDeviceId = currentState.deviceId;
    showError(null);
    elements["pairing-modal-title"].textContent = "申请新审批码";
    elements["pairing-modal-guidance"].textContent = "这不是普通重连。审批成功后，将在审批所选 Team 中创建新的 Device 和 Agent 身份；旧 Agent 不会自动迁移或撤销，也不会恢复旧 Team 的访问权限。";
    elements["pairing-modal-retention"].textContent = "保留所有本机智能体配置。新凭据保存成功前不替换旧配对；成功后旧数据仍保留，并生成 previous-bridge.json 备份。";
    elements["pairing-modal-blocked"].classList.add("hidden");
    elements["stop-for-pairing"].classList.add("hidden");
    elements["pairing-central-addresses"].classList.add("hidden");
    elements["confirm-reenrollment"].textContent = "确认申请新身份";
    elements["confirm-reenrollment"].disabled = false;
    elements["pairing-modal-backdrop"].classList.remove("hidden");
    elements["cancel-pairing-modal"].focus();
  } else {
    void requestEnrollment();
  }
});
elements["confirm-reenrollment"].addEventListener("click", () => {
  if (pendingPairingLink) void requestConfiguredDevicePairing();
  else if (expectedPairingDeviceId) void requestEnrollment(expectedPairingDeviceId);
});
elements["stop-for-pairing"].addEventListener("click", async () => {
  elements["stop-for-pairing"].disabled = true;
  showError(null);
  try {
    await request("/api/bridge/stop", {method: "POST"});
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    elements["stop-for-pairing"].disabled = false;
  }
});
for (const id of ["close-pairing-modal", "cancel-pairing-modal"]) {
  elements[id].addEventListener("click", closePairingModal);
}
elements["add-agent"].addEventListener("click", () => openAgentModal());
elements["edit-connection"].addEventListener("click", () => openConnectionModal());
elements["edit-reasoning-consent"].addEventListener("click", () => openConnectionModal(true));
elements["stop-for-reasoning-consent"].addEventListener("click", async () => {
  elements["stop-for-reasoning-consent"].disabled = true;
  showError(null);
  try {
    await request("/api/reasoning-consent/prepare", {method: "POST"});
    await refresh();
  } catch (error) {
    showError(error);
    elements["stop-for-reasoning-consent"].disabled = false;
  }
});
elements["agent-kind"].addEventListener("change", () => {
  const kind = elements["agent-kind"].value;
  if (!editingAgentId) {
    elements["agent-name"].value = kind === "pi" ? "Local Pi" : "Local Codex";
    elements["agent-role"].value = kind === "pi" ? "Reviewer" : "Implementation";
    elements["agent-path"].value = kind === "pi" ? currentState.detectedPi || "" : currentState.detectedCodex || "";
  }
  syncAgentKindFields();
});
elements["agent-session-conflict-policy"].addEventListener("change", syncAgentKindFields);
elements["codex-session-conflict-policy"].addEventListener("change", () => {
  applyCodexSessionConflictPolicy(
    elements["codex-session-conflict-policy"].value,
    elements["codex-session-ownership-policy-copy"]
  );
});
elements["agent-use-detected"].addEventListener("click", () => {
  const kind = elements["agent-kind"].value;
  void useDetectedRuntime("agent", kind);
});
elements["agent-preflight"].addEventListener("click", () => {
  void preflightDraft(
    elements["agent-kind"].value,
    "agent",
    elements["agent-preflight"],
    elements["agent-preflight-result"]
  );
});
for (const kind of ["codex", "pi"]) {
  elements[`${kind}-use-detected`].addEventListener("click", () => {
    void useDetectedRuntime(kind, kind);
  });
  elements[`${kind}-preflight`].addEventListener("click", () => {
    void preflightDraft(
      kind,
      kind,
      elements[`${kind}-preflight`],
      elements[`${kind}-preflight-result`]
    );
  });
}
for (const id of ["close-agent-modal", "cancel-agent-modal"]) {
  elements[id].addEventListener("click", closeAgentModal);
}
for (const id of ["close-connection-modal", "cancel-connection-modal"]) {
  elements[id].addEventListener("click", closeConnectionModal);
}
for (const trigger of document.querySelectorAll("[data-open-codex-session-guide]")) {
  trigger.addEventListener("click", (event) => sessionGuide.open(event.currentTarget));
}
for (const id of ["close-codex-session-guide", "acknowledge-codex-session-guide"]) {
  elements[id].addEventListener("click", () => sessionGuide.close());
}
elements["agent-modal-backdrop"].addEventListener("click", (event) => {
  if (event.target === elements["agent-modal-backdrop"]) closeAgentModal();
});
elements["pairing-link-modal-backdrop"].addEventListener("click", (event) => {
  if (event.target === elements["pairing-link-modal-backdrop"]) closePairingLinkModal();
});
elements["connection-modal-backdrop"].addEventListener("click", (event) => {
  if (event.target === elements["connection-modal-backdrop"]) closeConnectionModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePairingModal();
  if (event.key === "Escape" && !elements["pairing-link-modal-backdrop"].classList.contains("hidden")) {
    closePairingLinkModal();
  }
  if (event.key === "Escape" && !elements["agent-modal-backdrop"].classList.contains("hidden")) {
    closeAgentModal();
  }
  if (event.key === "Escape" && !elements["connection-modal-backdrop"].classList.contains("hidden")) {
    closeConnectionModal();
  }
});

elements["connection-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);
  elements["save-connection"].disabled = true;
  const serverUrl = elements["connection-server-url"].value.trim();
  const https = usesHTTPS(serverUrl);
  const trustMode = https ? elements["connection-trust-mode"].value : "system_ca";
  try {
    await request("/api/connection-settings", {
      method: "PUT",
      body: JSON.stringify({
        serverUrl,
        serverToken: elements["connection-server-token"].value.trim(),
        clearServerToken: elements["clear-server-token"].checked,
        shareReasoningSummaries: elements["connection-share-reasoning-summaries"].checked,
        serverTrustMode: trustMode,
        serverCertificateSha256: https && trustMode === "pinned_sha256"
          ? elements["connection-fingerprint"].value
          : ""
      })
    });
    closeConnectionModal();
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    elements["save-connection"].disabled = false;
  }
});

elements["agent-provisioning-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = elements["agent-provisioning-mode"].value;
  elements["save-agent-provisioning"].disabled = true;
  elements["agent-provisioning-result"].textContent = "正在保存…";
  showError(null);
  try {
    await request("/api/agent-provisioning", {
      method: "PUT",
      body: JSON.stringify({
        mode,
        ...(mode === "fixed" ? {fixedCode: elements["fixed-management-code"].value} : {})
      })
    });
    agentProvisioningDirty = false;
    elements["fixed-management-code"].value = "";
    elements["agent-provisioning-result"].textContent = "已保存；Bridge 已按新模式安全重连。";
    await refresh();
  } catch (error) {
    elements["agent-provisioning-result"].textContent = "保存失败。";
    showError(error);
  } finally {
    syncAgentProvisioningFields();
  }
});

elements["agent-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);
  elements["save-agent"].disabled = true;
  const agentId = editingAgentId;
  const kind = elements["agent-kind"].value;
  try {
    await request(agentId ? `/api/agents/${encodeURIComponent(agentId)}` : "/api/agents", {
      method: agentId ? "PUT" : "POST",
      body: JSON.stringify(runtimeDraft(kind, "agent"))
    });
    closeAgentModal();
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    elements["save-agent"].disabled = false;
  }
});

function enrollmentPayload() {
  const workspaceFallback = elements["codex-workspace"].value || elements["pi-workspace"].value;
  const runtimes = [{
    kind: "codex",
    enabled: elements["codex-enabled"].checked,
    name: elements["codex-name"].value,
    role: elements["codex-role"].value,
    executablePath: elements["codex-path"].value,
    workspace: elements["codex-workspace"].value || workspaceFallback,
    workspaceAlias: elements["codex-workspace-alias"].value,
    sandbox: elements["codex-sandbox"].value,
    codexSessionConflictPolicy: elements["codex-session-conflict-policy"].value
  }, {
    kind: "pi",
    enabled: elements["pi-enabled"].checked,
    name: elements["pi-name"].value,
    role: elements["pi-role"].value,
    executablePath: elements["pi-path"].value,
    workspace: elements["pi-workspace"].value || workspaceFallback,
    workspaceAlias: elements["pi-workspace-alias"].value,
    credentialEnvironmentVariable: elements["pi-credential-env"].value
  }];
  return {
    serverUrl: elements["server-url"].value,
    serverToken: elements["server-token"].value.trim(),
    shareReasoningSummaries: elements["share-reasoning-summaries"].checked,
    serverTrustMode: usesHTTPS(elements["server-url"].value)
      ? elements["trust-mode"].value
      : "system_ca",
    serverCertificateSha256: usesHTTPS(elements["server-url"].value) &&
      elements["trust-mode"].value === "pinned_sha256"
      ? elements.fingerprint.value
      : "",
    deviceName: elements["device-name"].value,
    runtimes
  };
}

elements["submit-device-pairing"].addEventListener("click", async () => {
  showError(null);
  if (!elements["enrollment-form"].reportValidity()) return;
  const pairingLink = elements["device-pairing-link"].value.trim();
  const pairingShortCode = elements["device-pairing-short-code"].value.trim();
  if ((pairingLink === "") === (pairingShortCode === "")) {
    showError(new Error("请只填写一个 Device 配对链接或短码"));
    return;
  }
  elements["submit-device-pairing"].disabled = true;
  try {
    await request("/api/device-pairing/start", {
      method: "POST",
      body: JSON.stringify({...enrollmentPayload(), pairingLink, pairingShortCode})
    });
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    elements["submit-device-pairing"].disabled = false;
  }
});

elements["device-pairing-link"].addEventListener("input", () => {
  const origin = pairingOriginFromLink(elements["device-pairing-link"].value);
  if (origin) elements["server-url"].value = origin;
});

elements["enrollment-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);
  elements["submit-enrollment"].disabled = true;
  try {
    await request("/api/enrollment/start", {
      method: "POST",
      body: JSON.stringify(enrollmentPayload())
    });
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    elements["submit-enrollment"].disabled = false;
  }
});

for (const [id, path] of [
  ["cancel-enrollment", "/api/enrollment/cancel"],
  ["start-existing-pairing", "/api/bridge/start"],
  ["start-bridge", "/api/bridge/start"],
  ["stop-bridge", "/api/bridge/stop"]
]) {
  elements[id].addEventListener("click", async () => {
    try {
      await request(path, {method: "POST"});
      await refresh();
    } catch (error) {
      showError(error);
    }
  });
}

elements["login-startup"].addEventListener("change", async () => {
  const enabled = elements["login-startup"].checked;
  elements["login-startup"].disabled = true;
  try {
    await request("/api/login-startup", {
      method: "PUT",
      body: JSON.stringify({enabled})
    });
    await refresh();
  } catch (error) {
    elements["login-startup"].checked = !enabled;
    showError(error);
  } finally {
    elements["login-startup"].disabled = false;
  }
});

elements["export-diagnostics"].addEventListener("click", async () => {
  elements["export-diagnostics"].disabled = true;
  try {
    const result = await request("/api/diagnostics/export", {method: "POST"});
    elements["diagnostics-result"].textContent = `已导出 ${result.filename} · SHA-256 ${result.sha256.slice(0, 12)}…`;
  } catch (error) {
    showError(error);
  } finally {
    elements["export-diagnostics"].disabled = false;
  }
});

elements["check-update"].addEventListener("click", async () => {
  elements["check-update"].disabled = true;
  elements["release-link"].classList.add("hidden");
  try {
    const result = await request("/api/update/check", {method: "POST"});
    if (!result.currentComparable) {
      elements["update-result"].textContent = `当前为开发版本；最新稳定版 ${result.latestVersion}`;
    } else if (result.updateAvailable) {
      elements["update-result"].textContent = `发现新版本 ${result.latestVersion}，请手动下载并校验。`;
    } else if (result.currentPrerelease) {
      elements["update-result"].textContent = `当前为预览版 ${result.currentVersion}；最新稳定版 ${result.latestVersion}`;
    } else {
      elements["update-result"].textContent = `已是最新稳定版（${result.latestVersion}）`;
    }
    elements["release-link"].href = result.releaseUrl;
    elements["release-link"].classList.remove("hidden");
  } catch (error) {
    elements["update-result"].textContent = "检查失败";
    showError(error);
  } finally {
    elements["check-update"].disabled = false;
  }
});

setRuntime("codex", true);
setRuntime("pi", false);
applyCodexSessionConflictPolicy(
  elements["codex-session-conflict-policy"].value,
  elements["codex-session-ownership-policy-copy"]
);
syncTrustFields();
void refresh();
setInterval(refresh, 1000);
