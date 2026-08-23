const elements = Object.fromEntries([
  "phase", "configured", "paired", "running", "connection-state", "agent-count", "approval",
  "join-code", "join-expiry", "cancel-enrollment", "configured-view",
  "device-title", "start-bridge", "stop-bridge", "resume-enrollment", "edit-config", "current-server",
  "current-team", "current-device", "config-path", "connection-detail", "last-connected", "connection-error", "agent-list",
  "enrollment-form", "server-url", "device-name", "trust-mode", "fingerprint-field",
  "fingerprint", "codex-enabled", "codex-fields", "codex-name", "codex-role",
  "codex-path", "codex-workspace", "codex-sandbox", "pi-enabled", "pi-fields",
  "pi-name", "pi-role", "pi-path", "pi-workspace", "pi-credential-env",
  "submit-enrollment", "cancel-edit", "auth-warning", "error", "bridge-version",
  "login-startup-row", "login-startup", "login-startup-warning", "export-diagnostics",
  "diagnostics-result", "check-update", "update-result", "release-link"
].map((id) => [id, document.getElementById(id)]));

const query = new URLSearchParams(window.location.search);
if (query.get("token")) {
  sessionStorage.setItem("agent-room-console-token", query.get("token"));
  history.replaceState(null, "", window.location.pathname);
}
const token = sessionStorage.getItem("agent-room-console-token") || "";
if (!token) elements["auth-warning"].classList.remove("hidden");
let currentState = null;
let editMode = false;

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
  elements.error.textContent = error ? String(error.message || error) : "";
  elements.error.classList.toggle("hidden", !error);
}

function setRuntime(kind, enabled) {
  elements[`${kind}-fields`].classList.toggle("hidden", !enabled);
  for (const input of elements[`${kind}-fields`].querySelectorAll("input, select")) {
    input.disabled = !enabled;
  }
}

function renderAgent(agent) {
  const row = document.createElement("article");
  row.className = "agent-row";
  const title = document.createElement("strong");
  title.textContent = `${agent.name} · ${agent.kind === "codex" ? "Codex" : "Pi"}`;
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
  row.append(title, role, status, readiness, workspace);
  return row;
}

function syncTrustFields() {
  const https = elements["server-url"].value.startsWith("https://");
  elements["trust-mode"].disabled = !https;
  elements["fingerprint-field"].classList.toggle(
    "hidden",
    !https || elements["trust-mode"].value !== "pinned_sha256"
  );
}

function fillConfigurationForm(state) {
  elements["server-url"].value = state.serverUrl || "http://127.0.0.1:3000";
  elements["device-name"].value = state.deviceName || "Local Bridge";
  elements["trust-mode"].value = state.serverTrustMode || "system_ca";
  elements.fingerprint.value = state.serverCertificateSha256 || "";
  syncTrustFields();
  const codex = state.agents.find((agent) => agent.kind === "codex");
  const pi = state.agents.find((agent) => agent.kind === "pi");
  elements["codex-enabled"].checked = Boolean(codex);
  elements["pi-enabled"].checked = Boolean(pi);
  setRuntime("codex", Boolean(codex));
  setRuntime("pi", Boolean(pi));
  if (codex) {
    elements["codex-name"].value = codex.name;
    elements["codex-role"].value = codex.role;
    elements["codex-path"].value = codex.executablePath;
    elements["codex-workspace"].value = codex.workspace;
    elements["codex-sandbox"].value = codex.sandbox || "workspace-write";
  } else {
    elements["codex-path"].value = state.detectedCodex || "";
    elements["codex-workspace"].value = state.agents[0]?.workspace || state.workspace || "";
  }
  if (pi) {
    elements["pi-name"].value = pi.name;
    elements["pi-role"].value = pi.role;
    elements["pi-path"].value = pi.executablePath;
    elements["pi-workspace"].value = pi.workspace;
    elements["pi-credential-env"].value = pi.credentialEnvironmentVariable || "";
  } else {
    elements["pi-path"].value = state.detectedPi || "";
    elements["pi-workspace"].value = state.agents[0]?.workspace || state.workspace || "";
  }
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
  elements["enrollment-form"].classList.toggle("hidden", (state.configured && !editMode) || waiting);
  if (state.configured) {
    elements["device-title"].textContent = state.deviceName;
    elements["current-server"].textContent = state.serverUrl;
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
    elements["edit-config"].classList.toggle("hidden", !state.paired);
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
  elements["cancel-edit"].classList.toggle("hidden", !editMode);
  elements["submit-enrollment"].textContent = editMode ? "保存并重启 Bridge" : "生成加入码";
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
elements["codex-enabled"].addEventListener("change", () => setRuntime("codex", elements["codex-enabled"].checked));
elements["pi-enabled"].addEventListener("change", () => setRuntime("pi", elements["pi-enabled"].checked));
elements["join-code"].addEventListener("click", async () => navigator.clipboard.writeText(elements["join-code"].textContent));
elements["edit-config"].addEventListener("click", () => {
  if (!currentState) return;
  editMode = true;
  fillConfigurationForm(currentState);
  render(currentState);
  elements["enrollment-form"].scrollIntoView({behavior: "smooth", block: "start"});
});
elements["cancel-edit"].addEventListener("click", () => {
  editMode = false;
  if (currentState) render(currentState);
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
    await request(editMode ? "/api/config" : "/api/enrollment/start", {
      method: editMode ? "PUT" : "POST",
      body: JSON.stringify({
        serverUrl: elements["server-url"].value,
        serverTrustMode: elements["server-url"].value.startsWith("https://")
          ? elements["trust-mode"].value
          : "system_ca",
        serverCertificateSha256: elements["server-url"].value.startsWith("https://") &&
          elements["trust-mode"].value === "pinned_sha256"
          ? elements.fingerprint.value
          : "",
        deviceName: elements["device-name"].value,
        runtimes
      })
    });
    editMode = false;
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
