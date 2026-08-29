export function pairingLinkFromHash(hash) {
  if (typeof hash !== "string" || hash.length > 8192 || !hash.startsWith("#")) return "";
  const values = new URLSearchParams(hash.slice(1));
  if ([...values.keys()].some((key) => key !== "pairingLink")) return "";
  const links = values.getAll("pairingLink");
  if (links.length !== 1) return "";
  const link = links[0].trim();
  if (
    !link.startsWith("convenewire://pair-device?") &&
    !link.startsWith("agentroom://pair-device?")
  ) return "";
  return link;
}

export function pairingOriginFromLink(link) {
  if (typeof link !== "string" || link.length > 8192) return "";
  let parsed;
  try {
    parsed = new URL(link.trim());
  } catch {
    return "";
  }
  if (
    (parsed.protocol !== "convenewire:" && parsed.protocol !== "agentroom:") ||
    parsed.hostname !== "pair-device" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    [...parsed.searchParams.keys()].some((key) =>
      key !== "origin" && key !== "pairingSessionId" && key !== "expiresAt"
    ) ||
    parsed.searchParams.getAll("origin").length !== 1 ||
    parsed.searchParams.getAll("pairingSessionId").length !== 1 ||
    parsed.searchParams.getAll("expiresAt").length !== 1
  ) return "";
  const value = parsed.searchParams.get("origin")?.trim() || "";
  let origin;
  try {
    origin = new URL(value);
  } catch {
    return "";
  }
  const loopback = origin.protocol === "http:" &&
    (origin.hostname === "localhost" || origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]");
  if (
    (origin.protocol !== "https:" && !loopback) ||
    origin.username !== "" || origin.password !== "" ||
    origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
    origin.origin !== value
  ) return "";
  return origin.origin;
}

export function configuredPairingLaunchView(link, state) {
  const origin = pairingOriginFromLink(link);
  if (!origin || !state?.configured || state.enrollment?.active) {
    return {show: false, mode: "", canConfirm: false, showStop: false, blockedReason: ""};
  }
  const sameOrigin = origin === state.serverUrl;
  const activeRuns = state.agents?.some((agent) => agent.activeRuns > 0) || false;
  const blockedReason = !sameOrigin
    ? "该配对链接不属于当前 Central；不会覆盖现有连接。"
    : activeRuns
      ? "请等待当前 Team 任务结束；重新配对不会中断正在运行的任务。"
      : state.enrollment?.blockedReason || "";
  return {
    show: true,
    mode: state.paired ? "replace" : "complete",
    canConfirm: sameOrigin && Boolean(state.enrollment?.canRequest),
    showStop: sameOrigin && Boolean(state.bridgeRunning) && !activeRuns,
    blockedReason
  };
}
