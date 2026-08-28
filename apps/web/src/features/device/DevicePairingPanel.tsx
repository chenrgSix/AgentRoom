import type {
  DevicePairingSessionCreated,
  DevicePairingSessionCreatedTrust,
  DevicePairingSessionOwnerProjection,
  DevicePairingSessionOwnerProjectionTrust
} from "@agent-room/contracts/pairing-session";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { bridgeServerURL, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";

type PairingAction = "approve" | "reject" | "cancel";

interface PendingDecision {
  action: PairingAction;
  expectedState: "issued" | "claimed";
  operationId: string;
  reason?: string;
}

interface StoredPairingAttempt {
  version: 1;
  claimSecret: string;
  createOperationId: string;
  ownerMemberId: string;
  startedAt: string;
  teamId: string;
  created?: DevicePairingSessionCreated;
  projection?: DevicePairingSessionOwnerProjection;
  decision?: PendingDecision;
}

interface DevicePairingPanelProps {
  currentMemberIsOwner: boolean;
  currentMemberId: string | null;
  locale: Locale;
  sessionToken: string | undefined;
  teamId: string;
}

const terminalStates = new Set([
  "consumed",
  "rejected",
  "canceled",
  "expired"
]);
const recoverableStates = new Set(["issued", "claimed", "approved"]);
const installationIdPattern = /^install_[A-Za-z0-9_-]{16,128}$/u;
const caDigestPattern = /^[a-f0-9]{64}$/u;

function exactHTTPSOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Device pairing trust origin is invalid");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== "" || parsed.pathname !== "/" ||
    parsed.search !== "" || parsed.hash !== "" || parsed.origin !== value
  ) {
    throw new Error("Device pairing trust origin is invalid");
  }
  return value;
}

function safeTrust(
  value: DevicePairingSessionCreatedTrust | DevicePairingSessionOwnerProjectionTrust | undefined,
  expectedOrigin: string
): DevicePairingSessionCreatedTrust | undefined {
  if (value === undefined) return undefined;
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "caCertificateSha256,installationId,mode,origin,trustEpoch" ||
    value.mode !== "private_scoped_ca" ||
    exactHTTPSOrigin(value.origin) !== expectedOrigin ||
    !installationIdPattern.test(value.installationId) ||
    !Number.isSafeInteger(value.trustEpoch) || value.trustEpoch < 1 ||
    value.trustEpoch > 2_147_483_647 ||
    !caDigestPattern.test(value.caCertificateSha256)
  ) {
    throw new Error("Device pairing trust descriptor is invalid");
  }
  return {
    caCertificateSha256: value.caCertificateSha256,
    installationId: value.installationId,
    mode: value.mode,
    origin: value.origin,
    trustEpoch: value.trustEpoch
  };
}

function sameTrust(
  left: DevicePairingSessionCreatedTrust | undefined,
  right: DevicePairingSessionCreatedTrust | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.mode === right.mode && left.origin === right.origin &&
    left.installationId === right.installationId &&
    left.trustEpoch === right.trustEpoch &&
    left.caCertificateSha256 === right.caCertificateSha256;
}

function storageKey(teamId: string, memberId: string): string {
  return `agent-room.device-pairing.${teamId}.${memberId}`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return globalThis.btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

export function createPairingOperationId(randomValue?: string): string {
  const source = randomValue ?? globalThis.crypto.randomUUID();
  const normalized = source.replace(/[^A-Za-z0-9_-]/gu, "");
  if (normalized.length < 8) {
    throw new Error("Device pairing operation ID source is too short");
  }
  return `op_${normalized.slice(0, 128)}`;
}

function readStoredAttempt(
  teamId: string,
  memberId: string
): StoredPairingAttempt | null {
  try {
    const key = storageKey(teamId, memberId);
    const raw = globalThis.sessionStorage.getItem(key);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Partial<StoredPairingAttempt>;
    if (
      candidate.version !== 1 ||
      typeof candidate.claimSecret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(candidate.claimSecret) ||
      typeof candidate.createOperationId !== "string" ||
      !/^op_[A-Za-z0-9_-]{8,128}$/u.test(candidate.createOperationId) ||
      typeof candidate.startedAt !== "string" ||
      candidate.teamId !== teamId ||
      candidate.ownerMemberId !== memberId
    ) {
      globalThis.sessionStorage.removeItem(key);
      return null;
    }
    if (candidate.created !== undefined) {
      candidate.created = safeCreated(
        candidate.created,
        teamId,
        memberId,
        new URL(bridgeServerURL()).origin
      );
    }
    if (candidate.projection !== undefined) {
      if (!candidate.created) {
        globalThis.sessionStorage.removeItem(key);
        return null;
      }
      candidate.projection = safeProjection(
        candidate.projection,
        teamId,
        candidate.created.pairingSessionId,
        memberId,
        new URL(bridgeServerURL()).origin,
        candidate.created.trust
      );
    }
    if (candidate.projection && terminalStates.has(candidate.projection.state)) {
      globalThis.sessionStorage.removeItem(key);
      return null;
    }
    return candidate as StoredPairingAttempt;
  } catch {
    return null;
  }
}

function persistAttempt(
  teamId: string,
  memberId: string,
  attempt: StoredPairingAttempt
): void {
  try {
    globalThis.sessionStorage.setItem(
      storageKey(teamId, memberId),
      JSON.stringify(attempt)
    );
  } catch {
    // Pairing can continue in memory when session storage is unavailable.
  }
}

function forgetAttempt(teamId: string, memberId: string): void {
  try {
    globalThis.sessionStorage.removeItem(storageKey(teamId, memberId));
  } catch {
    // The in-memory projection still reaches a safe terminal state.
  }
}

function safeCreated(
  value: DevicePairingSessionCreated,
  teamId: string,
  memberId: string,
  expectedOrigin: string
): DevicePairingSessionCreated {
  if (
    value.teamId !== teamId ||
    value.ownerMemberId !== memberId ||
    value.state !== "issued" ||
    !/^pairing_[A-Za-z0-9_-]{8,128}$/u.test(value.pairingSessionId) ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/u.test(value.shortCode) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.now()
  ) {
    throw new Error("Device pairing creation response is invalid");
  }
  const trust = safeTrust(value.trust, expectedOrigin);
  return {
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ownerMemberId: value.ownerMemberId,
    pairingSessionId: value.pairingSessionId,
    shortCode: value.shortCode,
    state: value.state,
    teamId: value.teamId,
    ...(trust === undefined ? {} : { trust })
  };
}

function safeProjection(
  value: DevicePairingSessionOwnerProjection,
  teamId: string,
  pairingSessionId: string,
  memberId: string,
  expectedOrigin: string,
  expectedTrust: DevicePairingSessionCreatedTrust | undefined
): DevicePairingSessionOwnerProjection {
  if (
    value.teamId !== teamId ||
    value.ownerMemberId !== memberId ||
    value.pairingSessionId !== pairingSessionId ||
    ![
      "issued",
      "claimed",
      "approved",
      "consumed",
      "rejected",
      "canceled",
      "expired"
    ].includes(value.state) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new Error("Device pairing status response is invalid");
  }
  const trust = safeTrust(value.trust, expectedOrigin);
  if (!sameTrust(trust, expectedTrust)) {
    throw new Error("Device pairing status changed its trust descriptor");
  }
  if (trust && value.device && value.device.supportsScopedPrivateTrust !== true) {
    throw new Error("Device pairing status omitted scoped trust capability");
  }
  return {
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ownerMemberId: value.ownerMemberId,
    pairingSessionId: value.pairingSessionId,
    state: value.state,
    teamId: value.teamId,
    ...(value.claimedAt === undefined ? {} : { claimedAt: value.claimedAt }),
    ...(value.consumedAt === undefined ? {} : { consumedAt: value.consumedAt }),
    ...(value.decidedAt === undefined ? {} : { decidedAt: value.decidedAt }),
    ...(value.device === undefined ? {} : {
      device: {
        bridgeVersion: value.device.bridgeVersion,
        displayName: value.device.displayName,
        platform: value.device.platform,
        ...(value.device.supportsScopedPrivateTrust === undefined
          ? {}
          : { supportsScopedPrivateTrust: value.device.supportsScopedPrivateTrust })
      }
    }),
    ...(value.deviceId === undefined ? {} : { deviceId: value.deviceId }),
    ...(value.pairingAttemptId === undefined
      ? {}
      : { pairingAttemptId: value.pairingAttemptId }),
    ...(value.verificationPhrase === undefined
      ? {}
      : { verificationPhrase: value.verificationPhrase }),
    ...(trust === undefined ? {} : { trust })
  };
}

export function buildDevicePairingLink(
  origin: string,
  created: DevicePairingSessionCreated,
  claimSecret: string
): string {
  const normalizedOrigin = new URL(origin).origin;
  const trust = safeTrust(created.trust, normalizedOrigin);
  const parameters = new URLSearchParams({
    origin: normalizedOrigin,
    pairingSessionId: created.pairingSessionId,
    expiresAt: created.expiresAt
  });
  const fragment = new URLSearchParams({ claimSecret });
  if (trust) {
    fragment.set("trustMode", trust.mode);
    fragment.set("trustOrigin", trust.origin);
    fragment.set("installationId", trust.installationId);
    fragment.set("trustEpoch", String(trust.trustEpoch));
    fragment.set("caCertificateSha256", trust.caCertificateSha256);
  }
  return `agentroom://pair-device?${parameters.toString()}#${fragment.toString()}`;
}

function stateLabel(state: string, locale: Locale): string {
  const labels: Record<string, { "zh-CN": string; en: string }> = {
    issued: { "zh-CN": "等待 Device 认领", en: "Waiting for Device" },
    claimed: { "zh-CN": "等待核对与批准", en: "Verify and approve" },
    approved: { "zh-CN": "已批准，等待 Device 完成", en: "Approved; waiting for Device" },
    consumed: { "zh-CN": "配对完成", en: "Pairing complete" },
    rejected: { "zh-CN": "已拒绝", en: "Rejected" },
    canceled: { "zh-CN": "已取消", en: "Canceled" },
    expired: { "zh-CN": "已过期", en: "Expired" }
  };
  return labels[state]?.[locale] ?? state;
}

function actionLabel(action: PairingAction, locale: Locale): string {
  const labels = {
    approve: { "zh-CN": "批准", en: "approval" },
    reject: { "zh-CN": "拒绝", en: "rejection" },
    cancel: { "zh-CN": "取消", en: "cancelation" }
  };
  return labels[action][locale];
}

export function DevicePairingPanel({
  currentMemberIsOwner,
  currentMemberId,
  locale,
  sessionToken,
  teamId
}: DevicePairingPanelProps) {
  const [storedAttempt, setAttempt] = useState<StoredPairingAttempt | null>(() =>
    currentMemberId ? readStoredAttempt(teamId, currentMemberId) : null
  );
  const [terminalProjection, setTerminalProjection] =
    useState<DevicePairingSessionOwnerProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phraseConfirmed, setPhraseConfirmed] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scope = `${teamId}:${currentMemberId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const attempt = storedAttempt?.teamId === teamId &&
    storedAttempt.ownerMemberId === currentMemberId
    ? storedAttempt
    : null;

  const projection = attempt?.projection ?? terminalProjection;
  const state = projection?.state ?? attempt?.created?.state;
  const pairingLink = useMemo(() => attempt?.created
    ? buildDevicePairingLink(bridgeServerURL(), attempt.created, attempt.claimSecret)
    : null, [attempt]);

  function commitAttempt(next: StoredPairingAttempt): void {
    if (!currentMemberId) return;
    const nextState = next.projection?.state ?? next.created?.state;
    if (nextState && terminalStates.has(nextState) && next.projection) {
      setTerminalProjection(next.projection);
      setAttempt(null);
      forgetAttempt(teamId, currentMemberId);
    } else {
      setAttempt(next);
      persistAttempt(teamId, currentMemberId, next);
    }
  }

  async function createSession(): Promise<void> {
    if (attempt?.created || !currentMemberId) return;
    const requestScope = scope;
    const pending = attempt ?? {
      version: 1 as const,
      claimSecret: randomBase64Url(32),
      createOperationId: createPairingOperationId(),
      ownerMemberId: currentMemberId,
      startedAt: new Date().toISOString(),
      teamId
    };
    setTerminalProjection(null);
    commitAttempt(pending);
    setBusy(true);
    setError(null);
    try {
      const response = await jsonRequest<DevicePairingSessionCreated>(
        `/api/teams/${teamId}/device-pairing-sessions`,
        {
          method: "POST",
          body: JSON.stringify({
            operationId: pending.createOperationId,
            claimSecret: pending.claimSecret
          })
        },
        sessionToken
      );
      if (scopeRef.current !== requestScope) return;
      const created = safeCreated(
        response,
        teamId,
        currentMemberId,
        new URL(bridgeServerURL()).origin
      );
      commitAttempt({
        ...pending,
        created,
        projection: {
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
          ownerMemberId: created.ownerMemberId,
          pairingSessionId: created.pairingSessionId,
          state: "issued",
          teamId: created.teamId,
          ...(created.trust === undefined ? {} : { trust: created.trust })
        }
      });
    } catch (reason) {
      if (scopeRef.current === requestScope) setError(String(reason));
    } finally {
      if (scopeRef.current === requestScope) setBusy(false);
    }
  }

  async function fetchProjection(
    source: StoredPairingAttempt,
    signal?: AbortSignal
  ): Promise<DevicePairingSessionOwnerProjection> {
    if (!source.created || !currentMemberId) {
      throw new Error("Device pairing session is not created");
    }
    const response = await jsonRequest<DevicePairingSessionOwnerProjection>(
      `/api/teams/${teamId}/device-pairing-sessions/${source.created.pairingSessionId}`,
      signal ? { signal } : {},
      sessionToken
    );
    return safeProjection(
      response,
      teamId,
      source.created.pairingSessionId,
      currentMemberId,
      new URL(bridgeServerURL()).origin,
      source.created.trust
    );
  }

  function decisionReached(
    decision: PendingDecision | undefined,
    nextState: string
  ): boolean {
    if (!decision) return false;
    if (decision.action === "approve") {
      return nextState === "approved" || nextState === "consumed";
    }
    if (decision.action === "reject") return nextState === "rejected";
    return nextState === "canceled";
  }

  async function reconcile(source = attempt, signal?: AbortSignal): Promise<void> {
    if (!source?.created) return;
    const requestScope = scope;
    const nextProjection = await fetchProjection(source, signal);
    if (scopeRef.current !== requestScope) return;
    let next: StoredPairingAttempt = {
      ...source,
      projection: nextProjection
    };
    if (decisionReached(source.decision, nextProjection.state)) {
      const { decision: completedDecision, ...withoutDecision } = next;
      void completedDecision;
      next = withoutDecision;
    }
    commitAttempt(next);
    if (nextProjection.state !== "claimed") setPhraseConfirmed(false);
  }

  async function manualRefresh(): Promise<void> {
    const requestScope = scope;
    setRefreshing(true);
    setError(null);
    try {
      await reconcile();
    } catch (reason) {
      if (scopeRef.current === requestScope) setError(String(reason));
    } finally {
      if (scopeRef.current === requestScope) setRefreshing(false);
    }
  }

  async function sendDecision(decision: PendingDecision): Promise<void> {
    if (!attempt?.created || !currentMemberId) return;
    const requestScope = scope;
    const pending = { ...attempt, decision };
    commitAttempt(pending);
    setBusy(true);
    setError(null);
    try {
      const response = await jsonRequest<DevicePairingSessionOwnerProjection>(
        `/api/teams/${teamId}/device-pairing-sessions/${attempt.created.pairingSessionId}/${decision.action}`,
        {
          method: "POST",
          body: JSON.stringify({
            operationId: decision.operationId,
            expectedState: decision.expectedState,
            ...(decision.reason ? { reason: decision.reason } : {})
          })
        },
        sessionToken
      );
      const nextProjection = safeProjection(
        response,
        teamId,
        attempt.created.pairingSessionId,
        currentMemberId,
        new URL(bridgeServerURL()).origin,
        attempt.created.trust
      );
      if (scopeRef.current !== requestScope) return;
      const { decision: completedDecision, ...withoutDecision } = pending;
      void completedDecision;
      commitAttempt({ ...withoutDecision, projection: nextProjection });
      setPhraseConfirmed(false);
    } catch (reason) {
      if (scopeRef.current !== requestScope) return;
      setError(String(reason));
      try {
        await reconcile(pending);
      } catch {
        // Preserve the original ambiguous command error and stable decision identity.
      }
    } finally {
      if (scopeRef.current === requestScope) setBusy(false);
    }
  }

  function beginDecision(action: PairingAction): void {
    if (!state || (state !== "issued" && state !== "claimed")) return;
    void sendDecision({
      action,
      expectedState: action === "cancel" ? state : "claimed",
      operationId: createPairingOperationId(),
      ...(action === "reject" && rejectionReason.trim()
        ? { reason: rejectionReason.trim() }
        : {})
    });
  }

  useEffect(() => {
    if (!pairingLink || state !== "issued") {
      setQrSvg(null);
      return;
    }
    let active = true;
    void import("qrcode").then(({ default: QRCode }) => QRCode.toString(pairingLink, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 220
    })).then((svg) => {
      if (active) setQrSvg(svg);
    }).catch((reason: unknown) => {
      if (active) setError(String(reason));
    });
    return () => {
      active = false;
    };
  }, [pairingLink, state]);

  useEffect(() => {
    if (!currentMemberIsOwner || !attempt?.created || !state ||
      !recoverableStates.has(state)) return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      void reconcile(attempt, controller.signal).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(String(reason));
      });
    }, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [
    attempt?.created?.pairingSessionId,
    attempt?.decision?.operationId,
    currentMemberIsOwner,
    scope,
    state
  ]);

  useEffect(() => {
    setAttempt(currentMemberIsOwner && currentMemberId
      ? readStoredAttempt(teamId, currentMemberId)
      : null);
    setTerminalProjection(null);
    setBusy(false);
    setRefreshing(false);
    setError(null);
    setPhraseConfirmed(false);
    setRejectionReason("");
  }, [currentMemberId, currentMemberIsOwner, teamId]);

  if (!currentMemberIsOwner || !currentMemberId) return null;

  const zh = locale === "zh-CN";
  const retryDecision = attempt?.decision;
  const activeTrust = attempt?.created?.trust ?? projection?.trust;

  return (
    <section className="control-panel device-pairing-panel" aria-labelledby="device-pairing-title">
      <div className="panel-header device-pairing-heading">
        <div>
          <p className="eyebrow">{zh ? "一次配对" : "ONE-TIME PAIRING"}</p>
          <h3 id="device-pairing-title">{zh ? "连接一台 Device" : "Connect a Device"}</h3>
        </div>
        {state && <span className={`pairing-state ${state}`}>{stateLabel(state, locale)}</span>}
      </div>

      <p className="device-pairing-intro">
        {zh
          ? "在这台浏览器生成一次性配对证明，再到新 Device 打开 AgentRoom。中央服务不会下发 Server Token、Device 凭据、Runtime 配置或 Workspace 路径。"
          : "Create a one-time proof in this tab, then open AgentRoom on the new Device. The Server never sends a Server Token, Device credential, Runtime configuration, or Workspace path."}
      </p>

      {attempt?.created && (
        <div className={`pairing-trust-note ${activeTrust ? "private" : "public"}`}>
          <strong>
            {activeTrust
              ? (zh ? "Bridge 定向私有 CA" : "Bridge-scoped private CA")
              : (zh ? "系统 CA 信任（默认）" : "System CA trust (default)")}
          </strong>
          {activeTrust
            ? <>
                <p>
                  {zh
                    ? "CA 只写入这台 Bridge，并且只信任下方 Central 的精确地址；无需在 Windows 或 macOS 安装 CA。"
                    : "The CA is stored only by this Bridge and trusts only the exact Central origin below. No Windows or macOS CA installation is required."}
                </p>
                <code>{activeTrust.origin}</code>
                <small>
                  epoch {activeTrust.trustEpoch} · SHA-256 {activeTrust.caCertificateSha256.slice(0, 12)}…
                </small>
                <p>
                  {zh
                    ? "此信任不适用于浏览器，也不会绕过浏览器证书校验。首次配对必须使用此链接或二维码。"
                    : "This trust does not apply to browsers or bypass browser certificate checks. First pairing must use this link or QR code."}
                </p>
              </>
            : <p>
                {zh
                  ? "链接不携带 CA 覆盖；Bridge 使用操作系统的公开 CA 与主机名校验。"
                  : "The link carries no CA override; Bridge uses operating-system public CA and hostname validation."}
              </p>}
        </div>
      )}

      {!attempt?.created && !terminalProjection && (
        <div className="device-pairing-start">
          <button disabled={busy} onClick={() => void createSession()} type="button">
            {busy
              ? (zh ? "正在创建…" : "Creating…")
              : attempt
                ? (zh ? "用同一证明重试创建" : "Retry with the same proof")
                : (zh ? "创建设备配对" : "Create Device pairing")}
          </button>
          {attempt && (
            <small>
              {zh
                ? "上次响应不明确；重试会复用同一 operationId 与 claimSecret，不会创建重复意图。"
                : "The previous response was ambiguous. Retry reuses the same operationId and claimSecret."}
            </small>
          )}
        </div>
      )}

      {attempt?.created && state === "issued" && pairingLink && (
        <div className="pairing-issued-grid">
          <div className="pairing-qr-card">
            {qrSvg
              ? <img
                  alt={zh ? "Device 配对二维码" : "Device pairing QR code"}
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
                />
              : <span aria-live="polite">{zh ? "正在生成二维码…" : "Generating QR code…"}</span>}
            <small>{zh ? "使用新 Device 扫描" : "Scan on the new Device"}</small>
          </div>
          <div className="pairing-share-options">
            <label htmlFor="device-pairing-link">{zh ? "一次性配对链接" : "One-time pairing link"}</label>
            <div className="pairing-link-row">
              <input id="device-pairing-link" readOnly value={pairingLink} />
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(pairingLink).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1_500);
                  }).catch(() => setCopied(false));
                }}
                type="button"
              >
                {copied ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}
              </button>
            </div>
            {activeTrust
              ? <span className="pairing-or">
                  {zh
                    ? "私有 CA 首次配对不提供短码入口；短码不能证明服务器身份。"
                    : "Private-CA first pairing does not offer short-code entry; a short code cannot prove server identity."}
                </span>
              : <>
                  <span className="pairing-or">{zh ? "或手动输入短码" : "or enter the short code"}</span>
                  <strong className="pairing-short-code">{attempt.created.shortCode}</strong>
                </>}
            <small>
              {zh ? `有效期至 ${new Date(attempt.created.expiresAt).toLocaleString()}` :
                `Expires ${new Date(attempt.created.expiresAt).toLocaleString()}`}
            </small>
          </div>
        </div>
      )}

      {projection?.state === "claimed" && projection.device && (
        <div className="pairing-verification">
          <div className="pairing-device-summary">
            <div>
              <small>{zh ? "待批准 Device" : "Device awaiting approval"}</small>
              <strong>{projection.device.displayName}</strong>
            </div>
            <span>{projection.device.platform} · Bridge {projection.device.bridgeVersion}</span>
          </div>
          <div className="pairing-phrase">
            <small>{zh ? "请与 Device 屏幕逐字核对" : "Compare exactly with the Device screen"}</small>
            <strong>{projection.verificationPhrase}</strong>
          </div>
          <label className="pairing-confirmation">
            <input
              checked={phraseConfirmed}
              onChange={(event) => setPhraseConfirmed(event.target.checked)}
              type="checkbox"
            />
            {zh ? "我已确认两边短语完全一致" : "I confirmed that both phrases match exactly"}
          </label>
          <label htmlFor="device-pairing-rejection-reason">
            {zh ? "拒绝原因（可选）" : "Rejection reason (optional)"}
          </label>
          <input
            id="device-pairing-rejection-reason"
            maxLength={280}
            onChange={(event) => setRejectionReason(event.target.value)}
            value={rejectionReason}
          />
          <div className="pairing-actions">
            <button
              className="primary-action"
              disabled={busy || !phraseConfirmed}
              onClick={() => beginDecision("approve")}
              type="button"
            >
              {zh ? "批准此 Device" : "Approve this Device"}
            </button>
            <button disabled={busy} onClick={() => beginDecision("reject")} type="button">
              {zh ? "拒绝" : "Reject"}
            </button>
            <button disabled={busy} onClick={() => beginDecision("cancel")} type="button">
              {zh ? "取消配对" : "Cancel pairing"}
            </button>
          </div>
        </div>
      )}

      {projection?.state === "approved" && (
        <p className="pairing-terminal-note" aria-live="polite">
          {zh
            ? "批准已记录。Device 正在用本地 pollSecret 完成凭据提升，请勿关闭 AgentRoom。"
            : "Approval is recorded. The Device is promoting its local pollSecret; keep AgentRoom open."}
        </p>
      )}

      {state && terminalStates.has(state) && (
        <div className="pairing-terminal-summary">
          <p className={`pairing-terminal-note ${state}`} aria-live="polite">
            {state === "consumed"
              ? (zh ? "Device 已安全配对；一次性证明已从此标签页清除。" : "The Device is paired; the one-time proof was cleared from this tab.")
              : (zh ? `本次配对${stateLabel(state, locale)}；本地一次性证明已清除。` : `This pairing is ${stateLabel(state, locale).toLowerCase()}; its local proof was cleared.`)}
          </p>
          <button onClick={() => setTerminalProjection(null)} type="button">
            {zh ? "配对另一台 Device" : "Pair another Device"}
          </button>
        </div>
      )}

      {attempt?.created && state === "issued" && (
        <div className="pairing-actions pairing-issued-actions">
          <button disabled={busy} onClick={() => beginDecision("cancel")} type="button">
            {zh ? "取消本次配对" : "Cancel this pairing"}
          </button>
        </div>
      )}

      {retryDecision && state && recoverableStates.has(state) && (
        <button
          className="pairing-retry-action"
          disabled={busy}
          onClick={() => void sendDecision(retryDecision)}
          type="button"
        >
          {zh
            ? `用同一 operationId 重试${actionLabel(retryDecision.action, locale)}`
            : `Retry ${actionLabel(retryDecision.action, locale)} with the same operationId`}
        </button>
      )}

      {attempt?.created && state && recoverableStates.has(state) && (
        <button
          className="pairing-refresh-action"
          disabled={refreshing}
          onClick={() => void manualRefresh()}
          type="button"
        >
          {refreshing ? (zh ? "刷新中…" : "Refreshing…") : (zh ? "刷新配对状态" : "Refresh pairing status")}
        </button>
      )}

      {error && <p className="provisioning-error" role="alert">{error}</p>}
    </section>
  );
}
