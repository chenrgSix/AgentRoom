import type { FormEvent } from "react";

import { BridgeConnectionPanel } from "../bridge/BridgeConnectionPanel.js";
import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { Agent, ConnectionMode, Device } from "../../models.js";

export function integrationLabel(mode: Agent["integrationMode"], locale: Locale): string {
  if (mode === "managed") return translate(locale, "managedBridge");
  if (mode === "manual") return translate(locale, "mcpParticipant");
  return translate(locale, "demoRuntime");
}

export function presenceHelp(agent: Agent, locale: Locale): string {
  if (locale === "en") {
    if (agent.integrationMode === "fake") return "Simulation only; does not call a model";
    if (agent.presence === "ready") return "Ready to receive Team tasks";
    if (agent.presence === "busy") return "Working on a Team task";
    if (agent.presence === "degraded") return "Connected with limited capability";
    if (agent.presence === "manual") return "Pulls work through MCP when the client is active";
    return "Start its Bridge or MCP client to make it available";
  }
  if (agent.integrationMode === "fake") return "仅用于模拟，不会调用模型";
  if (agent.presence === "ready") return "已就绪，可以接收 Team 任务";
  if (agent.presence === "busy") return "正在执行 Team 任务";
  if (agent.presence === "degraded") return "已连接，但部分能力不可用";
  if (agent.presence === "manual") return "MCP 客户端运行时会主动拉取任务";
  return "请启动对应的 Bridge 或 MCP 客户端";
}

export function presenceLabel(presence: string, locale: Locale): string {
  if (locale === "en") return presence.replace("_", " ");
  const labels: Record<string, string> = {
    active: "活跃",
    busy: "忙碌",
    degraded: "受限",
    manual: "手动",
    offline: "离线",
    ready: "就绪",
    revoked: "已撤销"
  };
  return labels[presence] ?? presence;
}

export function roleLabel(role: string, locale: Locale): string {
  if (locale === "en") return role;
  const labels: Record<string, string> = {
    "Codex implementer": "Codex 执行者",
    "MCP participant": "MCP 参与者",
    Teammate: "Team 成员"
  };
  return labels[role] ?? role;
}

interface AgentWorkspaceProps {
  activeDevices: number;
  agentName: string;
  agents: Agent[];
  busy: boolean;
  connectionMode: ConnectionMode;
  currentMemberIsOwner: boolean;
  devices: Device[];
  deviceName: string;
  joinCode: string;
  lifecycleBusy: boolean;
  locale: Locale;
  managedAgents: number;
  manualAgentName: string;
  readyAgents: number;
  setupOutput: string | null;
  onAgentNameChange: (value: string) => void;
  onApproveBridgeJoin: (event: FormEvent) => void | Promise<void>;
  onConnectionModeChange: (mode: ConnectionMode) => void;
  onCreateBridgeInvite: (event: FormEvent) => void | Promise<void>;
  onCreateFakeAgent: (event: FormEvent) => void | Promise<void>;
  onCreateManualAgent: (event: FormEvent) => void | Promise<void>;
  onDeviceNameChange: (value: string) => void;
  onJoinCodeChange: (value: string) => void;
  onManualAgentNameChange: (value: string) => void;
  onRevokeDevice: (device: Device) => void | Promise<void>;
  onSetAgentEnabled: (agent: Agent, enabled: boolean) => void | Promise<void>;
}

export function AgentWorkspace({
  activeDevices,
  agentName,
  agents,
  busy,
  connectionMode,
  currentMemberIsOwner,
  devices,
  deviceName,
  joinCode,
  lifecycleBusy,
  locale,
  managedAgents,
  manualAgentName,
  onAgentNameChange,
  onApproveBridgeJoin,
  onConnectionModeChange,
  onCreateBridgeInvite,
  onCreateFakeAgent,
  onCreateManualAgent,
  onDeviceNameChange,
  onJoinCodeChange,
  onManualAgentNameChange,
  onRevokeDevice,
  onSetAgentEnabled,
  readyAgents,
  setupOutput
}: AgentWorkspaceProps) {
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <section className="management-workspace" aria-label={t("agentManagement")}>
      <div className="management-intro">
        <div>
          <p className="eyebrow">{t("teamControlPlane")}</p>
          <h3>{t("manageRuntimes")}</h3>
          <p>{t("manageDescription")}</p>
        </div>
        <button className="primary-action" onClick={() => onConnectionModeChange("managed")} type="button">
          {t("connectAgent")}
        </button>
      </div>

      <div className="metric-grid" aria-label={t("agentStatusSummary")}>
        <article className="metric-card"><strong>{agents.length}</strong><span>{t("totalAgents")}</span></article>
        <article className="metric-card"><strong>{readyAgents}</strong><span>{t("readyNow")}</span></article>
        <article className="metric-card"><strong>{managedAgents}</strong><span>{t("managedBridgeCount")}</span></article>
        <article className="metric-card"><strong>{activeDevices}</strong><span>{t("activeDevices")}</span></article>
      </div>

      <div className="management-grid">
        <section className="control-panel agent-library" aria-labelledby="agent-library-title">
          <div className="panel-header">
            <div><p className="eyebrow">{t("agentLibrary")}</p><h3 id="agent-library-title">{t("teamAgents")}</h3></div>
            <span>{locale === "zh-CN" ? `已注册 ${agents.length} 个` : `${agents.length} ${t("registered")}`}</span>
          </div>
          {agents.length === 0 ? (
            <div className="panel-empty">
              <span>✦</span>
              <strong>{t("noAgents")}</strong>
              <p>{t("noAgentsHelp")}</p>
            </div>
          ) : (
            <div className="agent-card-grid">
              {agents.map((agent) => (
                <article className={`agent-card ${agent.enabled === false ? "disabled" : ""}`} key={agent.agentId}>
                  <div className="agent-card-top">
                    <span className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
                    <span className={`status-badge ${agent.enabled === false ? "offline" : agent.presence}`}>
                      <span className={`presence-dot ${agent.enabled === false ? "offline" : agent.presence}`} />
                      {agent.enabled === false
                        ? (locale === "zh-CN" ? "已停用" : "Disabled")
                        : presenceLabel(agent.presence, locale)}
                    </span>
                  </div>
                  <div className="agent-card-copy">
                    <h4>{agent.name}</h4>
                    <p>{roleLabel(agent.role, locale)}</p>
                  </div>
                  <span className={`integration-badge ${agent.integrationMode}`}>
                    {integrationLabel(agent.integrationMode, locale)}
                  </span>
                  <small>{presenceHelp(agent, locale)}</small>
                  {currentMemberIsOwner && (
                    <button
                      className="agent-enable-action"
                      disabled={lifecycleBusy}
                      onClick={() => void onSetAgentEnabled(agent, agent.enabled === false)}
                      type="button"
                    >
                      {agent.enabled === false
                        ? (locale === "zh-CN" ? "重新启用" : "Enable")
                        : (locale === "zh-CN" ? "停用" : "Disable")}
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <BridgeConnectionPanel
          agentName={agentName}
          busy={busy}
          connectionMode={connectionMode}
          deviceName={deviceName}
          joinCode={joinCode}
          locale={locale}
          manualAgentName={manualAgentName}
          onAgentNameChange={onAgentNameChange}
          onApproveBridgeJoin={onApproveBridgeJoin}
          onConnectionModeChange={onConnectionModeChange}
          onCreateBridgeInvite={onCreateBridgeInvite}
          onCreateFakeAgent={onCreateFakeAgent}
          onCreateManualAgent={onCreateManualAgent}
          onDeviceNameChange={onDeviceNameChange}
          onJoinCodeChange={onJoinCodeChange}
          onManualAgentNameChange={onManualAgentNameChange}
          setupOutput={setupOutput}
        />
      </div>

      <section className="control-panel device-panel" aria-labelledby="device-panel-title">
        <div className="panel-header">
          <div><p className="eyebrow">{t("trustedDevices")}</p><h3 id="device-panel-title">{t("bridgeDevices")}</h3></div>
          <span>{locale === "zh-CN" ? `${activeDevices} 台活跃` : `${activeDevices} active`}</span>
        </div>
        {devices.length === 0 ? (
          <p className="device-empty">{t("noDevices")}</p>
        ) : (
          <div className="device-grid">
            {devices.map((device) => (
              <article className="device-card" key={device.deviceId}>
                <span className="device-icon">▣</span>
                <div><strong>{device.name}</strong><small>{device.deviceId}</small></div>
                <span className={`status-badge ${device.status}`}>{presenceLabel(device.status, locale)}</span>
                <button disabled={device.status !== "active"} onClick={() => void onRevokeDevice(device)} type="button">{device.status === "active" ? t("revoke") : t("revoked")}</button>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
