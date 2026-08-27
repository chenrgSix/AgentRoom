import React, {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";

import { jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import type {
  Agent,
  AgentProvisionRequest,
  AgentProvisionRequestStatus,
  Device
} from "../../models.js";

const activeStatuses = new Set<AgentProvisionRequestStatus>([
  "pending",
  "delivered",
  "accepted"
]);
const onlinePresences = new Set(["ready", "busy", "degraded"]);

const rejectionLabels: Record<string, { "zh-CN": string; en: string }> = {
  busy: { "zh-CN": "Bridge 正在执行任务", en: "The Bridge is running active work" },
  configuration_failed: { "zh-CN": "Bridge 保存本地配置失败", en: "The Bridge could not save its local configuration" },
  identity_conflict: { "zh-CN": "本地 Agent 身份发生冲突", en: "The local Agent identity conflicts with existing configuration" },
  invalid_code: { "zh-CN": "管理码不正确或已过期", en: "The management code is invalid or expired" },
  invalid_request: { "zh-CN": "请求内容无效", en: "The request is invalid" },
  provisioning_disabled: { "zh-CN": "Bridge 已关闭中央创建", en: "Central creation is disabled on the Bridge" },
  rate_limited: { "zh-CN": "管理码尝试过多，请稍后再试", en: "Too many code attempts; try again later" },
  template_not_found: { "zh-CN": "本地模板 Agent 已不存在", en: "The local template Agent no longer exists" }
};

export function createAgentProvisionRequestId(randomValue?: string): string {
  const source = randomValue ?? globalThis.crypto.randomUUID();
  const normalized = source.replace(/[^A-Za-z0-9_-]/gu, "");
  if (normalized.length < 8) {
    throw new Error("Agent provisioning request ID source is too short");
  }
  return `agentprov_${normalized.slice(0, 128)}`;
}

export function provisioningStatusLabel(
  status: AgentProvisionRequestStatus,
  locale: Locale
): string {
  const labels: Record<AgentProvisionRequestStatus, { "zh-CN": string; en: string }> = {
    pending: { "zh-CN": "等待发送", en: "Pending" },
    delivered: { "zh-CN": "Bridge 已收到", en: "Delivered" },
    accepted: { "zh-CN": "本地已创建", en: "Accepted locally" },
    ready: { "zh-CN": "已就绪", en: "Ready" },
    rejected: { "zh-CN": "已拒绝", en: "Rejected" }
  };
  return labels[status][locale];
}

export function provisioningRejectionLabel(
  reason: string | null,
  locale: Locale
): string {
  if (reason && rejectionLabels[reason]) return rejectionLabels[reason][locale];
  return locale === "zh-CN"
    ? "Bridge 拒绝了本次请求。"
    : "The Bridge rejected this request.";
}

function requestHelp(request: AgentProvisionRequest, locale: Locale): string {
  if (request.status === "pending") {
    return locale === "zh-CN"
      ? "Bridge 当前可能离线；保持创建信息不变，重新输入管理码即可重试。"
      : "The Bridge may be offline. Keep these fields unchanged and re-enter the code to retry.";
  }
  if (request.status === "delivered") {
    return locale === "zh-CN"
      ? "请求已送达，正在等待 Bridge 本地校验。"
      : "The request reached the Bridge and is awaiting local authorization.";
  }
  if (request.status === "accepted") {
    return locale === "zh-CN"
      ? "Bridge 已原子保存配置，正在重连并发布新 Agent。"
      : "The Bridge saved the local configuration and is reconnecting to publish the Agent.";
  }
  if (request.status === "ready") {
    return locale === "zh-CN"
      ? "新 Agent 已由 Bridge 发布，可以加入房间。"
      : "The new Agent was published by the Bridge and can now join Rooms.";
  }
  return provisioningRejectionLabel(request.rejectionReason, locale);
}

function mergeRequest(
  current: AgentProvisionRequest[],
  incoming: AgentProvisionRequest
): AgentProvisionRequest[] {
  return [
    incoming,
    ...current.filter(({ requestId }) => requestId !== incoming.requestId)
  ];
}

function retriesSameRequest(request: AgentProvisionRequest): boolean {
  return request.status === "pending" ||
    request.status === "delivered" ||
    (request.status === "rejected" &&
      request.rejectionReason === "configuration_failed");
}

interface AgentProvisioningPanelProps {
  agents: Agent[];
  currentMemberId: string | null;
  devices: Device[];
  locale: Locale;
  sessionToken: string | undefined;
  teamId: string;
}

export function AgentProvisioningPanel({
  agents,
  currentMemberId,
  devices,
  locale,
  sessionToken,
  teamId
}: AgentProvisioningPanelProps) {
  const [requests, setRequests] = useState<AgentProvisionRequest[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [templateAgentId, setTemplateAgentId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [managementCode, setManagementCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const ownedTemplates = useMemo(() => agents.filter((agent) =>
    currentMemberId !== null &&
    agent.ownerMemberId === currentMemberId &&
    agent.integrationMode === "managed" &&
    agent.enabled !== false &&
    agent.deviceId !== null &&
    agent.deviceId !== undefined &&
    onlinePresences.has(agent.presence)
  ), [agents, currentMemberId]);
  const eligibleDevices = useMemo(() => devices.filter((device) =>
    currentMemberId !== null &&
    device.ownerMemberId === currentMemberId &&
    device.status === "active" &&
    device.supportsAgentProvisioning === true &&
    ownedTemplates.some((agent) => agent.deviceId === device.deviceId)
  ), [currentMemberId, devices, ownedTemplates]);
  const deviceTemplates = useMemo(() => ownedTemplates.filter((agent) =>
    agent.deviceId === deviceId
  ), [deviceId, ownedTemplates]);

  const refreshRequests = useCallback(async (signal?: AbortSignal) => {
    if (!currentMemberId) {
      setRequests([]);
      return;
    }
    const next = await jsonRequest<AgentProvisionRequest[]>(
      `/api/teams/${teamId}/agent-provision-requests`,
      signal ? { signal } : {},
      sessionToken
    );
    setRequests(next);
  }, [currentMemberId, sessionToken, teamId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    void refreshRequests(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setLoadError(String(reason));
    });
    return () => controller.abort();
  }, [refreshRequests]);

  const hasActiveRequest = requests.some(({ status }) => activeStatuses.has(status));
  useEffect(() => {
    if (!hasActiveRequest) return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      void refreshRequests(controller.signal).catch((reason: unknown) => {
        if (!controller.signal.aborted) setLoadError(String(reason));
      });
    }, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [hasActiveRequest, refreshRequests]);

  useEffect(() => {
    if (!eligibleDevices.some((device) => device.deviceId === deviceId)) {
      setDeviceId(eligibleDevices[0]?.deviceId ?? "");
    }
  }, [deviceId, eligibleDevices]);

  useEffect(() => {
    if (!deviceTemplates.some((agent) => agent.agentId === templateAgentId)) {
      const first = deviceTemplates[0];
      setTemplateAgentId(first?.agentId ?? "");
      setRole(first?.role ?? "");
    }
  }, [deviceTemplates, templateAgentId]);

  function populateRequest(request: AgentProvisionRequest) {
    setDeviceId(request.deviceId);
    setTemplateAgentId(request.templateAgentId);
    setName(request.name);
    setRole(request.role);
    setManagementCode("");
    setSubmitError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedRole = role.trim();
    if (!/^(?:[0-9]{6}|[0-9]{8})$/u.test(managementCode)) {
      setSubmitError(locale === "zh-CN"
        ? "管理码必须是 6 位动态码或 8 位固定码。"
        : "Enter a 6-digit rotating code or an 8-digit fixed code.");
      setManagementCode("");
      return;
    }
    const retry = requests.find((request) =>
      retriesSameRequest(request) &&
      request.deviceId === deviceId &&
      request.templateAgentId === templateAgentId &&
      request.name === normalizedName &&
      request.role === normalizedRole
    );
    const requestId = retry?.requestId ?? createAgentProvisionRequestId();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await jsonRequest<AgentProvisionRequest>(
        `/api/teams/${teamId}/agent-provision-requests`,
        {
          method: "POST",
          body: JSON.stringify({
            requestId,
            deviceId,
            templateAgentId,
            name: normalizedName,
            role: normalizedRole,
            managementCode
          })
        },
        sessionToken
      );
      setRequests((current) => mergeRequest(current, result));
      setName("");
    } catch (reason) {
      setSubmitError(String(reason));
      try {
        await refreshRequests();
      } catch {
        // Keep the original submission error. A later manual refresh can recover status.
      }
    } finally {
      setManagementCode("");
      setSubmitting(false);
    }
  }

  async function manualRefresh() {
    setRefreshing(true);
    setLoadError(null);
    try {
      await refreshRequests();
    } catch (reason) {
      setLoadError(String(reason));
    } finally {
      setRefreshing(false);
    }
  }

  const selectedTemplate = deviceTemplates.find(({ agentId }) =>
    agentId === templateAgentId
  );
  const canSubmit = Boolean(
    deviceId && templateAgentId && name.trim() && role.trim() && !submitting
  );

  return (
    <section className="control-panel provisioning-panel" aria-labelledby="agent-provisioning-title">
      <div className="panel-header provisioning-heading">
        <div>
          <p className="eyebrow">{locale === "zh-CN" ? "Bridge 本地授权" : "BRIDGE-LOCAL AUTHORITY"}</p>
          <h3 id="agent-provisioning-title">
            {locale === "zh-CN" ? "从我的 Bridge 创建 Agent" : "Create an Agent on my Bridge"}
          </h3>
        </div>
        <span>{locale === "zh-CN" ? "6 / 8 位管理码" : "6 / 8 digit code"}</span>
      </div>

      <p className="provisioning-intro">
        {locale === "zh-CN"
          ? "选择自己在线 Device 上的现有 Agent 作为模板。Bridge 只复制本地配置并修改名称与角色；中央服务不会获得命令、工作区、凭据、工具或权限配置。"
          : "Choose an existing Agent on your own online Device. The Bridge clones its local settings and changes only name and role; commands, Workspace, credentials, tools, and permissions never reach the central service."}
      </p>

      {eligibleDevices.length === 0 ? (
        <p className="device-empty provisioning-empty">
          {locale === "zh-CN"
            ? "暂无属于你的在线 Bridge 模板。请先配对并启动至少一个托管 Agent。"
            : "No online Bridge template belongs to you. Pair and start a managed Agent first."}
        </p>
      ) : (
        <form className="provisioning-form" onSubmit={submit}>
          <label htmlFor="provision-device">{locale === "zh-CN" ? "我的在线 Bridge" : "My online Bridge"}</label>
          <select
            id="provision-device"
            onChange={(event) => setDeviceId(event.target.value)}
            value={deviceId}
          >
            {eligibleDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>{device.name}</option>
            ))}
          </select>

          <label htmlFor="provision-template">{locale === "zh-CN" ? "本地模板 Agent" : "Local template Agent"}</label>
          <select
            id="provision-template"
            onChange={(event) => {
              const nextId = event.target.value;
              setTemplateAgentId(nextId);
              setRole(deviceTemplates.find(({ agentId }) => agentId === nextId)?.role ?? "");
            }}
            value={templateAgentId}
          >
            {deviceTemplates.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>{agent.name} · {agent.role}</option>
            ))}
          </select>

          <div className="provisioning-fields">
            <div>
              <label htmlFor="provision-name">{locale === "zh-CN" ? "新 Agent 名称" : "New Agent name"}</label>
              <input
                autoComplete="off"
                id="provision-name"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder={selectedTemplate
                  ? (locale === "zh-CN" ? `${selectedTemplate.name} 的副本` : `${selectedTemplate.name} copy`)
                  : ""}
                required
                value={name}
              />
            </div>
            <div>
              <label htmlFor="provision-role">{locale === "zh-CN" ? "角色" : "Role"}</label>
              <input
                autoComplete="off"
                id="provision-role"
                maxLength={80}
                onChange={(event) => setRole(event.target.value)}
                required
                value={role}
              />
            </div>
          </div>

          <label htmlFor="provision-management-code">{locale === "zh-CN" ? "Bridge 管理码" : "Bridge management code"}</label>
          <div className="provisioning-code-row">
            <input
              aria-describedby="provision-management-code-help"
              autoComplete="one-time-code"
              id="provision-management-code"
              inputMode="numeric"
              maxLength={8}
              onChange={(event) => setManagementCode(event.target.value.replace(/\D/gu, "").slice(0, 8))}
              pattern="(?:[0-9]{6}|[0-9]{8})"
              placeholder={locale === "zh-CN" ? "6 位动态码或 8 位固定码" : "6 rotating or 8 fixed digits"}
              required
              type="password"
              value={managementCode}
            />
            <button disabled={!canSubmit} type="submit">
              {submitting
                ? (locale === "zh-CN" ? "正在提交…" : "Submitting…")
                : (locale === "zh-CN" ? "创建 Agent" : "Create Agent")}
            </button>
          </div>
          <small id="provision-management-code-help">
            {locale === "zh-CN"
              ? "管理码只随本次请求发送，提交后立即清空；固定码可重复授权，动态码在当前周期内可重复使用。"
              : "The code is sent only with this request and cleared immediately. Fixed codes are reusable; rotating codes are reusable during their current interval."}
          </small>
        </form>
      )}

      {submitError && <p className="provisioning-error" role="alert">{submitError}</p>}

      <div className="provisioning-history" aria-live="polite">
        <div className="provisioning-history-heading">
          <strong>{locale === "zh-CN" ? "最近创建请求" : "Recent creation requests"}</strong>
          <button disabled={refreshing} onClick={() => void manualRefresh()} type="button">
            {refreshing
              ? (locale === "zh-CN" ? "刷新中…" : "Refreshing…")
              : (locale === "zh-CN" ? "刷新状态" : "Refresh status")}
          </button>
        </div>
        {loadError && <p className="provisioning-error" role="alert">{loadError}</p>}
        {requests.length === 0 ? (
          <p className="provisioning-history-empty">
            {locale === "zh-CN" ? "还没有创建请求。" : "No creation requests yet."}
          </p>
        ) : (
          <ol className="provisioning-request-list">
            {requests.slice(0, 6).map((request) => {
              const canPopulate = eligibleDevices.some(({ deviceId: id }) => id === request.deviceId) &&
                ownedTemplates.some(({ agentId }) => agentId === request.templateAgentId);
              return (
                <li key={request.requestId}>
                  <div>
                    <strong>{request.name}</strong>
                    <span className={`status-badge ${request.status}`}>
                      {provisioningStatusLabel(request.status, locale)}
                    </span>
                  </div>
                  <small>{request.role}</small>
                  <p>{requestHelp(request, locale)}</p>
                  {(["pending", "delivered", "rejected"].includes(request.status)) &&
                    canPopulate && (
                    <button onClick={() => populateRequest(request)} type="button">
                      {retriesSameRequest(request)
                        ? (locale === "zh-CN" ? "使用同一请求重试" : "Retry the same request")
                        : (locale === "zh-CN" ? "重新填写" : "Fill again")}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
