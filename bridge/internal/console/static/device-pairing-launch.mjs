// Match pairing.MaxSessionLinkBytes. The outer fragment may percent-encode
// every byte; its bound is not the decoded link's bound.
export const maximumPairingLinkBytes = 16 * 1024;
const maximumPairingHashChars = 3 * maximumPairingLinkBytes + "#pairingLink=".length;

export function pairingLinkFromHash(hash) {
  if (typeof hash !== "string" || hash.length > maximumPairingHashChars || !hash.startsWith("#")) return "";
  const values = new URLSearchParams(hash.slice(1));
  if ([...values.keys()].some((key) => key !== "pairingLink")) return "";
  const links = values.getAll("pairingLink");
  if (links.length !== 1) return "";
  const link = links[0].trim();
  return pairingOriginFromLink(link) ? link : "";
}

export function pairingOriginFromLink(link) {
  if (typeof link !== "string" || link.length > maximumPairingLinkBytes ||
      new TextEncoder().encode(link).length > maximumPairingLinkBytes) return "";
  let parsed;
  try {
    parsed = new URL(link.trim());
  } catch {
    return "";
  }
  if (parsed.username !== "" || parsed.password !== "") return "";
  const custom = parsed.protocol === "convenewire:" || parsed.protocol === "agentroom:";
  if (custom) {
    if (parsed.host !== "pair-device" || parsed.pathname !== "") return "";
  } else if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.pathname !== "/device-pairing") return "";
  const keys = custom ? ["origin", "pairingSessionId", "expiresAt"] : ["pairingSessionId", "expiresAt"];
  if ([...parsed.searchParams.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => parsed.searchParams.getAll(key).length !== 1 || !parsed.searchParams.get(key))) return "";
  const value = custom ? parsed.searchParams.get("origin") : parsed.origin;
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

export function configuredPairingEntryView(link, state) {
  if (!state?.configured) {
    return {canContinue: false, error: ""};
  }
  if (state.enrollment?.active) {
    return {
      canContinue: false,
      error: "已有 Device 配对正在进行，请先完成或取消当前配对。"
    };
  }
  if (typeof link !== "string" || link.trim() === "") {
    return {canContinue: false, error: ""};
  }
  const origin = pairingOriginFromLink(link);
  if (!origin) {
    return {
      canContinue: false,
      error: "请粘贴完整的 Device 配对链接（convenewire:// 或 HTTPS 链接）。"
    };
  }
  if (origin !== state.serverUrl) {
    return {
      canContinue: false,
      error: "该配对链接不属于当前 Central；不会覆盖现有连接。"
    };
  }
  return {canContinue: true, error: ""};
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
