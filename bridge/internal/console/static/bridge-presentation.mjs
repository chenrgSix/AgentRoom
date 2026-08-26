function serverLabel(value) {
  try {
    return new URL(value).host || "中央服务";
  } catch {
    return "中央服务";
  }
}

function hasAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

export function connectionPresentation(state) {
  const connection = state.connection || {
    state: state.bridgeRunning ? "connecting" : "stopped"
  };
  const technicalDetail = connection.lastError || state.lastError || "";
  const normalizedError = technicalDetail.toLowerCase();
  const server = serverLabel(state.serverUrl);

  if (!state.bridgeRunning || connection.state === "stopped") {
    return {
      state: "stopped",
      tone: "neutral",
      label: "已停止",
      title: "Bridge 当前已停止",
      summary: "本机 Agent 不会接收新任务。需要继续协作时重新启动即可。",
      server,
      action: "start",
      technicalDetail
    };
  }

  if (connection.state === "online") {
    return {
      state: "online",
      tone: "success",
      label: "已连接",
      title: "本机 Agent 已准备好",
      summary: `Bridge 已连接 ${server}，中央 Team 可以向可用 Agent 分配任务。`,
      server,
      action: "none",
      technicalDetail: ""
    };
  }

  if (hasAny(normalizedError, [/connection refused/, /connect: refused/])) {
    return {
      state: connection.state,
      tone: "warning",
      label: "正在重连",
      title: "中央服务未启动",
      summary: `${server} 当前没有响应。启动中央 Server 后，Bridge 会自动重新连接。`,
      server,
      action: "settings",
      technicalDetail
    };
  }

  if (hasAny(normalizedError, [/\b401\b/, /\b403\b/, /unauthori[sz]ed/, /forbidden/, /server token/])) {
    return {
      state: connection.state,
      tone: "danger",
      label: "需要检查",
      title: "中央服务拒绝了连接",
      summary: "请检查服务地址和中央 Token。现有 Team 配对不会因此失效。",
      server,
      action: "settings",
      technicalDetail
    };
  }

  if (hasAny(normalizedError, [/x509/, /certificate/, /tls/, /https/])) {
    return {
      state: connection.state,
      tone: "danger",
      label: "需要检查",
      title: "无法验证中央服务",
      summary: "请检查 HTTPS 证书和本机信任设置，不要绕过系统安全检查。",
      server,
      action: "settings",
      technicalDetail
    };
  }

  if (hasAny(normalizedError, [/handshake/, /websocket/, /protocol/, /unexpected status/])) {
    return {
      state: connection.state,
      tone: "danger",
      label: "版本或协议异常",
      title: "Bridge 无法完成连接握手",
      summary: "请确认中央 Server 与 Bridge 来自兼容版本，再查看技术详情。",
      server,
      action: "settings",
      technicalDetail
    };
  }

  if (hasAny(normalizedError, [/timeout/, /timed out/, /no route/, /network is unreachable/, /dial tcp/])) {
    return {
      state: connection.state,
      tone: "warning",
      label: "正在重连",
      title: "暂时无法到达中央服务",
      summary: "请检查网络和服务地址。Bridge 会保留配对并继续自动重试。",
      server,
      action: "settings",
      technicalDetail
    };
  }

  if (technicalDetail) {
    return {
      state: connection.state,
      tone: "danger",
      label: "需要处理",
      title: "连接遇到问题",
      summary: "Bridge 已保留本机配置和 Team 配对。请检查连接设置或展开技术详情。",
      server,
      action: "settings",
      technicalDetail
    };
  }

  return {
    state: connection.state,
    tone: "warning",
    label: connection.state === "retrying" ? "正在重连" : "正在连接",
    title: connection.state === "retrying" ? "正在重新连接中央服务" : "正在建立安全连接",
    summary: "无需重复配对。连接成功后，本机 Agent 会自动恢复为可用状态。",
    server,
    action: "none",
    technicalDetail: ""
  };
}

function workspaceName(value) {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "未设置工作区";
}

function initials(value) {
  const compact = [...String(value || "AR").trim().replace(/\s+/g, "")];
  return compact.slice(0, 2).join("").toUpperCase() || "AR";
}

export function agentPresentation(agent, {bridgeRunning} = {}) {
  const kindLabel = agent.kind === "codex"
    ? "Codex"
    : agent.kind === "pi"
    ? "Pi"
    : "Generic CLI";
  const activeRuns = Number(agent.activeRuns || 0);
  let status = "需要配置";
  let tone = "danger";
  if (activeRuns > 0 || agent.runtimeState === "working") {
    status = activeRuns > 0 ? `执行中 · ${activeRuns}` : "执行中";
    tone = "working";
  } else if (agent.runtimeState === "error") {
    status = "最近执行异常";
    tone = "danger";
  } else if (agent.executableReady && agent.runtimeState === "idle") {
    status = "可用";
    tone = "success";
  }
  if (bridgeRunning === false && activeRuns === 0) {
    status = agent.executableReady ? "已配置" : "需要配置";
    tone = "neutral";
  }

  const filesystemPolicy = agent.kind === "pi"
    ? "跟随本机策略"
    : agent.sandbox === "read-only"
    ? "只读"
    : agent.sandbox === "workspace-write"
    ? "可修改工作区"
    : "本机策略";

  return {
    initials: initials(agent.name),
    kindLabel,
    role: agent.role || "本机 Agent",
    status,
    tone,
    filesystemPolicy,
    workspaceName: workspaceName(agent.workspace),
    executableSummary: agent.executableReady ? "Runtime 已找到" : "Runtime 不可用"
  };
}
