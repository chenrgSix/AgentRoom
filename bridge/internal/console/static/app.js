const elements = Object.fromEntries([
  "phase", "configured", "paired", "running", "connection-state", "agent-count", "approval",
  "join-code", "join-expiry", "cancel-enrollment", "configured-view",
  "device-title", "start-bridge", "stop-bridge", "resume-enrollment", "edit-connection", "add-agent", "current-server",
  "current-server-token",
  "current-team", "current-device", "config-path", "connection-detail", "last-connected", "connection-error", "agent-list",
  "enrollment-form", "server-url", "server-token", "device-name", "trust-mode", "fingerprint-field",
  "fingerprint", "codex-enabled", "codex-fields", "codex-name", "codex-role",
  "codex-path", "codex-workspace", "codex-sandbox", "pi-enabled", "pi-fields",
  "pi-name", "pi-role", "pi-path", "pi-workspace", "pi-credential-env",
  "pi-permission-policy",
  "codex-use-detected", "codex-preflight", "codex-preflight-result",
  "pi-use-detected", "pi-preflight", "pi-preflight-result",
  "submit-enrollment", "auth-warning", "error", "bridge-version",
  "login-startup-row", "login-startup", "login-startup-warning", "export-diagnostics",
  "diagnostics-result", "check-update", "update-result", "release-link",
  "agent-modal-backdrop", "agent-modal-title", "close-agent-modal", "cancel-agent-modal",
  "agent-modal-error",
  "agent-form", "agent-kind", "agent-name", "agent-role", "agent-path", "agent-workspace",
  "agent-sandbox-field", "agent-sandbox", "agent-credential-field", "agent-credential-env",
  "agent-pi-permission-policy", "save-agent",
  "agent-use-detected", "agent-preflight", "agent-preflight-result",
  "connection-modal-backdrop", "connection-modal-title", "close-connection-modal",
  "cancel-connection-modal", "connection-modal-error", "connection-form",
  "connection-server-url", "connection-server-token", "clear-server-token-field", "clear-server-token",
  "connection-trust-mode", "connection-fingerprint-field",
  "connection-fingerprint", "save-connection"
].map((id) => [id, document.getElementById(id)]));

const query = new URLSearchParams(window.location.search);
if (query.get("token")) {
  sessionStorage.setItem("agent-room-console-token", query.get("token"));
  history.replaceState(null, "", window.location.pathname);
}
const token = sessionStorage.getItem("agent-room-console-token") || "";
if (!token) elements["auth-warning"].classList.remove("hidden");
let currentState = null;
let editingAgentId = null;
let draftPreflightRunning = false;
const runtimeTestResults = new Map();

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

const runtimeLabels = {
  unavailable: "不可用",
  idle: "空闲",
  working: "执行中",
  error: "最近执行异常"
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

function showError(error) {
  const message = error ? String(error.message || error) : "";
  elements.error.textContent = message;
  elements.error.classList.toggle("hidden", !message);
  elements["agent-modal-error"].textContent = message;
  elements["agent-modal-error"].classList.toggle("hidden", !message);
  elements["connection-modal-error"].textContent = message;
  elements["connection-modal-error"].classList.toggle("hidden", !message);
}

function setRuntime(kind, enabled) {
  elements[`${kind}-fields`].classList.toggle("hidden", !enabled);
  for (const input of elements[`${kind}-fields`].querySelectorAll("input, select, button")) {
    input.disabled = !enabled;
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
    sandbox: kind === "codex" ? elements[`${prefix}-sandbox`].value : "",
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
  if (draftPreflightRunning) return;
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

function renderAgent(agent) {
  const row = document.createElement("article");
  row.className = "agent-row";
  const title = document.createElement("strong");
  const kindLabel = agent.kind === "codex" ? "Codex" : agent.kind === "pi" ? "Pi" : "Generic CLI";
  title.textContent = `${agent.name} · ${kindLabel}`;
  const role = document.createElement("span");
  role.textContent = agent.role;
  const workspace = document.createElement("span");
  workspace.textContent = agent.workspace;
  const status = document.createElement("span");
  status.className = `runtime-status ${agent.runtimeState || "unavailable"}`;
  const active = agent.activeRuns ? ` · ${agent.activeRuns} 个运行中` : "";
  status.textContent = `${runtimeLabels[agent.runtimeState] || agent.runtimeState}${active}`;
  const readiness = document.createElement("span");
  readiness.textContent = agent.executableReady ? "可执行文件可用" : "可执行文件不存在或不可执行";
  const permission = document.createElement("span");
  permission.textContent = agent.kind === "pi"
    ? "权限：跟随本机 Pi"
    : `沙箱：${agent.sandbox || "workspace-write"}`;
  const probe = document.createElement("div");
  probe.className = "runtime-test";
  const probeButton = document.createElement("button");
  probeButton.className = "secondary";
  probeButton.type = "button";
  probeButton.textContent = "测试运行";
  const probeSupported = agent.kind === "codex" || agent.kind === "pi";
  probeButton.disabled = !probeSupported || !agent.executableReady || agent.activeRuns > 0;
  const probeResult = document.createElement("span");
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
      : "按需启动一次受限本地调用，不会自动执行";
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
  probe.append(probeButton, probeResult);
  const editButton = document.createElement("button");
  editButton.className = "secondary agent-edit";
  editButton.type = "button";
  editButton.textContent = "编辑";
  editButton.disabled = currentState.agents.some((candidate) => candidate.activeRuns > 0) ||
    [...runtimeTestResults.values()].includes("running");
  editButton.addEventListener("click", () => openAgentModal(agent));
  row.append(title, role, status, readiness, permission, workspace, probe, editButton);
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

function syncAgentKindFields() {
  const codex = elements["agent-kind"].value === "codex";
  elements["agent-sandbox-field"].classList.toggle("hidden", !codex);
  elements["agent-credential-field"].classList.toggle("hidden", codex);
  elements["agent-pi-permission-policy"].classList.toggle("hidden", codex);
}

function openAgentModal(agent = null) {
  showError(null);
  editingAgentId = agent?.agentId || null;
  const kind = agent?.kind === "pi" ? "pi" : "codex";
  elements["agent-modal-title"].textContent = agent ? `编辑 ${agent.name}` : "添加智能体";
  elements["agent-kind"].value = kind;
  elements["agent-name"].value = agent?.name || (kind === "pi" ? "Local Pi" : "Local Codex");
  elements["agent-role"].value = agent?.role || (kind === "pi" ? "Reviewer" : "Implementation");
  elements["agent-path"].value = agent?.executablePath ||
    (kind === "pi" ? currentState.detectedPi : currentState.detectedCodex) || "";
  elements["agent-workspace"].value = agent?.workspace || currentState.agents[0]?.workspace || currentState.workspace || "";
  elements["agent-sandbox"].value = agent?.sandbox || "workspace-write";
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

function openConnectionModal() {
  showError(null);
  elements["connection-server-url"].value = currentState.serverUrl || "";
  elements["connection-server-token"].value = "";
  elements["connection-server-token"].placeholder = currentState.serverTokenConfigured
    ? "留空则保留当前 Token"
    : "输入中央服务管理员提供的 Token";
  elements["clear-server-token"].checked = false;
  elements["connection-trust-mode"].value = currentState.serverTrustMode || "system_ca";
  elements["connection-fingerprint"].value = currentState.serverCertificateSha256 || "";
  syncConnectionTrustFields();
  syncConnectionTokenFields();
  elements["connection-modal-backdrop"].classList.remove("hidden");
  elements["connection-server-url"].focus();
}

function closeConnectionModal() {
  elements["connection-modal-backdrop"].classList.add("hidden");
}

function render(state) {
  currentState = state;
  elements.phase.textContent = labels[state.phase] || state.phase;
  elements.phase.classList.toggle("running", state.bridgeRunning);
  elements.configured.textContent = state.configured ? "已创建" : "未创建";
  elements.paired.textContent = state.paired ? "已配对" : "未配对";
  elements.running.textContent = state.bridgeRunning ? "运行中" : "已停止";
  const connection = state.connection || {state: state.bridgeRunning ? "connecting" : "stopped"};
  elements["connection-state"].textContent = connectionLabels[connection.state] || connection.state;
  elements["agent-count"].textContent = `${state.agents.length} 个`;
  elements["bridge-version"].textContent = state.version || "dev";
  elements.error.textContent = state.lastError || "";
  elements.error.classList.toggle("hidden", !state.lastError);

  const waiting = state.phase === "waiting_approval";
  elements.approval.classList.toggle("hidden", !waiting);
  if (waiting) {
    elements["join-code"].textContent = state.joinCode;
    elements["join-expiry"].textContent = `有效期至 ${new Date(state.joinExpiresAt).toLocaleTimeString()}`;
  }

  elements["configured-view"].classList.toggle("hidden", !state.configured);
  elements["enrollment-form"].classList.toggle("hidden", state.configured || waiting);
  if (state.configured) {
    elements["device-title"].textContent = state.deviceName;
    elements["current-server"].textContent = state.serverUrl;
    elements["current-server-token"].textContent = state.serverTokenConfigured ? "已配置" : "未配置";
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
    elements["start-bridge"].disabled = state.bridgeRunning || !state.paired;
    elements["stop-bridge"].disabled = !state.bridgeRunning;
    elements["resume-enrollment"].classList.toggle("hidden", state.paired);
    const mutationBlocked = state.agents.some((agent) => agent.activeRuns > 0) ||
      [...runtimeTestResults.values()].includes("running") || draftPreflightRunning;
    elements["add-agent"].classList.toggle("hidden", !state.paired);
    elements["add-agent"].disabled = mutationBlocked;
    elements["edit-connection"].classList.toggle("hidden", !state.paired);
    elements["edit-connection"].disabled = mutationBlocked;
    elements["agent-list"].replaceChildren(...state.agents.map(renderAgent));
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
  elements["login-startup"].checked = Boolean(startup.enabled);
  const startupWarning = startup.pathMismatch ? "应用位置已变化，请关闭后重新开启此选项以修复。" : "";
  elements["login-startup-warning"].textContent = startupWarning;
  elements["login-startup-warning"].classList.toggle("hidden", !startupWarning);
  elements["submit-enrollment"].textContent = "生成加入码";
}

async function refresh() {
  if (!token) return;
  try {
    render(await request("/api/state"));
  } catch (error) {
    showError(error);
  }
}

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
elements["codex-enabled"].addEventListener("change", () => setRuntime("codex", elements["codex-enabled"].checked));
elements["pi-enabled"].addEventListener("change", () => setRuntime("pi", elements["pi-enabled"].checked));
elements["join-code"].addEventListener("click", async () => navigator.clipboard.writeText(elements["join-code"].textContent));
elements["add-agent"].addEventListener("click", () => openAgentModal());
elements["edit-connection"].addEventListener("click", openConnectionModal);
elements["agent-kind"].addEventListener("change", () => {
  const kind = elements["agent-kind"].value;
  if (!editingAgentId) {
    elements["agent-name"].value = kind === "pi" ? "Local Pi" : "Local Codex";
    elements["agent-role"].value = kind === "pi" ? "Reviewer" : "Implementation";
    elements["agent-path"].value = kind === "pi" ? currentState.detectedPi || "" : currentState.detectedCodex || "";
  }
  syncAgentKindFields();
});
elements["agent-use-detected"].addEventListener("click", () => {
  const kind = elements["agent-kind"].value;
  elements["agent-path"].value = kind === "pi"
    ? currentState.detectedPi || ""
    : currentState.detectedCodex || "";
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
    elements[`${kind}-path`].value = kind === "pi"
      ? currentState.detectedPi || ""
      : currentState.detectedCodex || "";
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
elements["agent-modal-backdrop"].addEventListener("click", (event) => {
  if (event.target === elements["agent-modal-backdrop"]) closeAgentModal();
});
elements["connection-modal-backdrop"].addEventListener("click", (event) => {
  if (event.target === elements["connection-modal-backdrop"]) closeConnectionModal();
});
document.addEventListener("keydown", (event) => {
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

elements["enrollment-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(null);
  elements["submit-enrollment"].disabled = true;
  const workspaceFallback = elements["codex-workspace"].value || elements["pi-workspace"].value;
  const runtimes = [{
    kind: "codex",
    enabled: elements["codex-enabled"].checked,
    name: elements["codex-name"].value,
    role: elements["codex-role"].value,
    executablePath: elements["codex-path"].value,
    workspace: elements["codex-workspace"].value || workspaceFallback,
    sandbox: elements["codex-sandbox"].value
  }, {
    kind: "pi",
    enabled: elements["pi-enabled"].checked,
    name: elements["pi-name"].value,
    role: elements["pi-role"].value,
    executablePath: elements["pi-path"].value,
    workspace: elements["pi-workspace"].value || workspaceFallback,
    credentialEnvironmentVariable: elements["pi-credential-env"].value
  }];
  try {
    await request("/api/enrollment/start", {
      method: "POST",
      body: JSON.stringify({
        serverUrl: elements["server-url"].value,
        serverToken: elements["server-token"].value.trim(),
        serverTrustMode: usesHTTPS(elements["server-url"].value)
          ? elements["trust-mode"].value
          : "system_ca",
        serverCertificateSha256: usesHTTPS(elements["server-url"].value) &&
          elements["trust-mode"].value === "pinned_sha256"
          ? elements.fingerprint.value
          : "",
        deviceName: elements["device-name"].value,
        runtimes
      })
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
  ["resume-enrollment", "/api/enrollment/start"],
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
syncTrustFields();
void refresh();
setInterval(refresh, 1000);
