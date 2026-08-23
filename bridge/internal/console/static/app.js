const elements = Object.fromEntries([
  "phase", "configured", "paired", "running", "agent-count", "approval",
  "join-code", "join-expiry", "cancel-enrollment", "configured-view",
  "device-title", "start-bridge", "stop-bridge", "resume-enrollment", "edit-config", "current-server",
  "current-team", "current-device", "config-path", "agent-list",
  "enrollment-form", "server-url", "device-name", "fingerprint-field",
  "fingerprint", "codex-enabled", "codex-fields", "codex-name", "codex-role",
  "codex-path", "codex-workspace", "codex-sandbox", "pi-enabled", "pi-fields",
  "pi-name", "pi-role", "pi-path", "pi-workspace", "pi-credential-env",
  "submit-enrollment", "cancel-edit", "auth-warning", "error"
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
  row.append(title, role, workspace);
  return row;
}

function fillConfigurationForm(state) {
  elements["server-url"].value = state.serverUrl || "http://127.0.0.1:3000";
  elements["device-name"].value = state.deviceName || "Local Bridge";
  elements.fingerprint.value = state.serverCertificateSha256 || "";
  elements["fingerprint-field"].classList.toggle("hidden", !elements["server-url"].value.startsWith("https://"));
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
  elements["agent-count"].textContent = `${state.agents.length} 个`;
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
  elements["fingerprint-field"].classList.toggle("hidden", !elements["server-url"].value.startsWith("https://"));
});
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
        serverCertificateSha256: elements.fingerprint.value,
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

setRuntime("codex", true);
setRuntime("pi", false);
void refresh();
setInterval(refresh, 1000);
