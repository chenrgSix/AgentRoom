import React, { type FormEvent, useEffect, useState } from "react";

import { BridgeConnectionPanel } from "../bridge/BridgeConnectionPanel.js";
import { PanelDialog } from "../navigation/PanelDialog.js";
import { AgentProvisioningPanel } from "./AgentProvisioningPanel.js";
import { AgentSetupChoices, type AgentSetupTarget } from "./AgentSetupChoices.js";
import { HostedAgentPanel } from "./HostedAgentPanel.js";
import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { Agent, ConnectionMode, Device, Room } from "../../models.js";

export function integrationLabel(mode: Agent["integrationMode"], locale: Locale): string {
  if (mode === "managed") return translate(locale, "managedBridge");
  if (mode === "manual") return translate(locale, "mcpParticipant");
  if (mode === "hosted") return translate(locale, "centralHostedAgent");
  return translate(locale, "demoRuntime");
}

export function presenceHelp(agent: Agent, locale: Locale): string {
  if (locale === "en") {
    if (agent.integrationMode === "fake") return "Simulation only; does not call a model";
    if (agent.integrationMode === "hosted") {
      return "Remote model only; cannot operate a computer, read or write files, or execute commands";
    }
    if (agent.presence === "ready") return "Ready to receive Team tasks";
    if (agent.presence === "busy") return "Working on a Team task";
    if (agent.presence === "degraded") return "Connected with limited capability";
    if (agent.presence === "manual") return "Pulls work through MCP when the client is active";
    return "Start its Bridge or MCP client to make it available";
  }
  if (agent.integrationMode === "fake") return "仅用于模拟，不会调用模型";
  if (agent.integrationMode === "hosted") {
    return "仅调用远程模型，不能操作电脑、读写文件或执行命令";
  }
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

export function filesystemAccessLabel(
  policy: Agent["runtimePolicy"],
  locale: Locale
): string {
  if (locale === "en") {
    if (policy?.filesystemAccess === "read-only") return "Read only";
    if (policy?.filesystemAccess === "workspace-write") return "Workspace write";
    if (policy?.filesystemAccess === "local-policy") return "Local policy";
    return "Not reported";
  }
  if (policy?.filesystemAccess === "read-only") return "只读";
  if (policy?.filesystemAccess === "workspace-write") return "工作区可写";
  if (policy?.filesystemAccess === "local-policy") return "遵循本机策略";
  return "未上报";
}

function filesystemAccessHelp(
  policy: Agent["runtimePolicy"],
  locale: Locale
): string {
  if (locale === "en") {
    if (policy?.filesystemAccess === "read-only") {
      return "This managed Runtime cannot write to its Workspace.";
    }
    if (policy?.filesystemAccess === "workspace-write") {
      return "This managed Runtime can write within its local Workspace limits.";
    }
    if (policy?.filesystemAccess === "local-policy") {
      return "File access follows local Runtime policy; its details stay on the Device.";
    }
    return "This Agent has not published a file-access summary.";
  }
  if (policy?.filesystemAccess === "read-only") {
    return "该托管 Runtime 不能写入其工作区。";
  }
  if (policy?.filesystemAccess === "workspace-write") {
    return "该托管 Runtime 可在本机工作区限制内写入。";
  }
  if (policy?.filesystemAccess === "local-policy") {
    return "文件访问遵循本机 Runtime 策略，具体配置不会上传。";
  }
  return "该 Agent 尚未上报文件访问摘要。";
}

export function AgentPolicySummary({
  locale,
  policy
}: {
  locale: Locale;
  policy: Agent["runtimePolicy"];
}) {
  return (
    <dl className="agent-policy-summary">
      <div>
        <dt>{locale === "zh-CN" ? "文件访问" : "File access"}</dt>
        <dd>
          <span
            className={`policy-badge ${policy?.filesystemAccess ?? "unreported"}`}
            title={filesystemAccessHelp(policy, locale)}
          >
            {filesystemAccessLabel(policy, locale)}
          </span>
        </dd>
      </div>
    </dl>
  );
}

interface AgentWorkspaceProps {
  agentName: string;
  agents: Agent[];
  busy: boolean;
  connectionMode: ConnectionMode;
  currentMemberIsOwner: boolean;
  currentMemberId: string | null;
  devices: Device[];
  deviceName: string;
  joinCode: string;
  lifecycleBusy: boolean;
  locale: Locale;
  manualAgentName: string;
  readyAgents: number;
  rooms: Room[];
  setupOutput: string | null;
  setupTarget?: AgentSetupTarget | null;
  sessionToken: string | undefined;
  teamId: string;
  onAgentNameChange: (value: string) => void;
  onApproveBridgeJoin: (event: FormEvent) => void | Promise<void>;
  onConnectionModeChange: (mode: ConnectionMode) => void;
  onCreateBridgeInvite: (event: FormEvent) => void | Promise<void>;
  onCreateFakeAgent: (event: FormEvent) => void | Promise<void>;
  onCreateManualAgent: (event: FormEvent) => void | Promise<void>;
  onDeviceNameChange: (value: string) => void;
  onJoinCodeChange: (value: string) => void;
  onManualAgentNameChange: (value: string) => void;
  onAgentChanged: (agent: Agent) => void;
  onSetupClosed: () => void;
  onDevices: () => void;
  onOpenHostedRoom?: (roomId: string) => void;
  onSetAgentEnabled: (agent: Agent, enabled: boolean) => void | Promise<void>;
}

type SetupFlow = AgentSetupTarget | "choose" | "mcp" | "template" | "legacy";

export function AgentWorkspace(props: AgentWorkspaceProps) {
  const { agents, busy, currentMemberIsOwner, currentMemberId, devices, lifecycleBusy, locale,
    onAgentChanged, onOpenHostedRoom, onSetAgentEnabled, readyAgents, rooms, sessionToken, setupTarget, teamId } = props;
  const t = (key: TranslationKey) => translate(locale, key);
  const zh = locale === "zh-CN";
  const [flow, setFlow] = useState<SetupFlow | null>(setupTarget ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const selectedAgent = agents.find((agent) => agent.agentId === selectedId);
  const visible = agents.filter((agent) => {
    const term = search.trim().toLocaleLowerCase();
    return (!term || `${agent.name} ${agent.role}`.toLocaleLowerCase().includes(term)) &&
      (kind === "all" || agent.integrationMode === kind) &&
      (status === "all" || (status === "disabled" ? agent.enabled === false :
        agent.enabled !== false && (status === "ready" ? agent.presence === "ready" : agent.presence !== "ready")));
  });
  useEffect(() => { if (setupTarget) setFlow(setupTarget); }, [setupTarget]);
  const close = () => { setFlow(null); setSelectedId(null); props.onSetupClosed(); };
  const selectSetup = (target: SetupFlow) => {
    if (target === "hosted" && !currentMemberIsOwner) return;
    props.onSetupClosed();
    setFlow(target);
    if (target === "demo" || target === "mcp" || target === "legacy") {
      props.onConnectionModeChange(target === "legacy" ? "managed" : target);
    }
  };

  return (
    <section className="management-workspace agent-workspace" aria-label={t("agentManagement")}>
      <div className="management-intro">
        <div><p>{zh ? "让合适的智能体加入协作。运行方式与权限，在配置时按需查看。" : "Bring the right Agents into your work. Inspect runtime capabilities and permissions when configuring."}</p></div>
        <button className="primary-action" onClick={() => selectSetup("choose")} type="button">{zh ? "新增智能体" : "Add an Agent"}</button>
      </div>
      <div className="inventory-toolbar">
        <input aria-label={zh ? "搜索智能体" : "Search Agents"} placeholder={zh ? "搜索名称或角色" : "Search name or role"} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select aria-label={zh ? "智能体状态" : "Agent status"} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">{zh ? "全部状态" : "All states"}</option><option value="ready">{zh ? "就绪" : "Ready"}</option><option value="other">{zh ? "未就绪" : "Not ready"}</option><option value="disabled">{zh ? "已停用" : "Disabled"}</option>
        </select>
        <select aria-label={zh ? "接入类型" : "Integration type"} value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="all">{zh ? "全部类型" : "All types"}</option>
          {(["hosted", "managed", "manual", "fake"] as const).map((mode) => <option key={mode} value={mode}>{integrationLabel(mode, locale)}</option>)}
        </select>
      </div>
      <p className="inventory-help" role="status">{zh ? `${agents.length} 个智能体 · ${readyAgents} 个就绪 · 显示 ${visible.length} 个` : `${agents.length} Agents · ${readyAgents} ready · ${visible.length} shown`}</p>
      {visible.length === 0 ? <div className="panel-empty">
        <strong>{agents.length ? (zh ? "没有匹配的智能体" : "No matching Agents") : t("noAgents")}</strong>
        <p>{agents.length ? (zh ? "试试其他搜索词或筛选条件。" : "Try a different search or filter.") : (zh ? "可以直接连接模型 API，也可以接入自己电脑上的客户端。" : "Connect a model API directly, or bring a client running on your computer.")}</p>
      </div> : <div className="agent-inventory">
        {visible.map((agent) => <article className={`agent-inventory-row ${agent.enabled === false ? "disabled" : ""}`} key={agent.agentId}>
          <span className="agent-avatar" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span>
          <div className="agent-inventory-name"><h3>{agent.name}</h3><p>{roleLabel(agent.role, locale)}</p></div>
          <span className={`integration-badge ${agent.integrationMode}`}>{integrationLabel(agent.integrationMode, locale)}</span>
          <span className={`status-badge ${agent.enabled === false ? "offline" : agent.presence}`}><span className={`presence-dot ${agent.enabled === false ? "offline" : agent.presence}`} />
            {agent.enabled === false ? (zh ? "已停用" : "Disabled") : presenceLabel(agent.presence, locale)}
          </span>
          <button aria-label={zh ? `查看 ${agent.name}` : `View ${agent.name}`} onClick={() => setSelectedId(agent.agentId)} type="button">{zh ? "查看" : "View"}<span aria-hidden="true"> →</span></button>
        </article>)}
      </div>}
      {selectedAgent && <PanelDialog title={selectedAgent.name} locale={locale} onClose={close}>
        {selectedAgent.integrationMode === "hosted" && currentMemberIsOwner ? (
          <HostedAgentPanel agents={agents} currentMemberIsOwner locale={locale} onAgentChanged={onAgentChanged}
            onOpenRoom={onOpenHostedRoom} rooms={rooms} sessionToken={sessionToken} teamId={teamId}
            presentation={{ kind: "profile", agentId: selectedAgent.agentId }} />
        ) : <div className="agent-detail">
          <p>{roleLabel(selectedAgent.role, locale)} · {integrationLabel(selectedAgent.integrationMode, locale)}</p>
          <p>{presenceHelp(selectedAgent, locale)}</p>
          {selectedAgent.integrationMode !== "hosted" && <AgentPolicySummary locale={locale} policy={selectedAgent.runtimePolicy} />}
          {selectedAgent.integrationMode === "managed" && <>
            <p>{zh ? "名称、命令、工作区和模型凭据由本机客户端配置，不会在中央服务覆盖。" : "Names, commands, Workspaces and model credentials are configured in the local client, never overwritten here."}</p>
            <button onClick={props.onDevices} type="button">{zh ? "查看设备" : "View Devices"}</button>
          </>}
          {currentMemberIsOwner && <button disabled={lifecycleBusy} onClick={() => void onSetAgentEnabled(selectedAgent, selectedAgent.enabled === false)} type="button">
            {selectedAgent.enabled === false ? (zh ? "重新启用" : "Enable") : (zh ? "停用" : "Disable")}
          </button>}
        </div>}
      </PanelDialog>}
      {flow && <PanelDialog title={flow === "hosted" ? t("setupHostedTitle") : flow === "local" ? t("setupLocalTitle") :
        flow === "template" ? (zh ? "从本机模板创建" : "Create from a local template") : (zh ? "新增智能体" : "Add an Agent")} locale={locale} onClose={close}>
        {flow !== "choose" && <button className="setup-back" onClick={() => selectSetup("choose")} type="button">{zh ? "← 其他接入方式" : "← Other setup options"}</button>}
        {flow === "choose" && <>
          <AgentSetupChoices currentMemberIsOwner={currentMemberIsOwner} locale={locale} onSelect={selectSetup} />
          <button className="setup-secondary" onClick={() => selectSetup("mcp")} type="button">{zh ? "接入 MCP 客户端" : "Connect an MCP client"}</button>
        </>}
        {flow === "hosted" && currentMemberIsOwner && <HostedAgentPanel
          agents={agents} currentMemberIsOwner locale={locale} onAgentChanged={onAgentChanged} onOpenRoom={onOpenHostedRoom}
          rooms={rooms} sessionToken={sessionToken} teamId={teamId} presentation={{ kind: "create" }} />}
        {flow === "local" && <div className="local-setup-options">
          <p>{t("setupLocalDescription")}</p><p>{t("setupLocalBoundary")}</p>
          <button onClick={props.onDevices} type="button">{zh ? "前往设备管理与配对" : "Manage and pair Devices"}</button>
          <button onClick={() => selectSetup("template")} type="button">{zh ? "从我的在线客户端模板创建" : "Create from my online client template"}</button>
          {currentMemberIsOwner ? <button className="setup-secondary" onClick={() => selectSetup("legacy")} type="button">{zh ? "高级：命令行与旧版接入" : "Advanced: CLI and legacy enrollment"}</button> : <p>{t("setupLocalMemberHelp")}</p>}
        </div>}
        {flow === "template" && <AgentProvisioningPanel agents={agents} currentMemberId={currentMemberId} devices={devices} locale={locale} sessionToken={sessionToken} teamId={teamId} />}
        {(flow === "demo" || flow === "mcp" || flow === "legacy") && <BridgeConnectionPanel
          agentName={props.agentName} busy={busy} connectionMode={props.connectionMode} deviceName={props.deviceName} joinCode={props.joinCode}
          locale={locale} manualAgentName={props.manualAgentName} onAgentNameChange={props.onAgentNameChange}
          onApproveBridgeJoin={props.onApproveBridgeJoin} onConnectionModeChange={props.onConnectionModeChange}
          onCreateBridgeInvite={props.onCreateBridgeInvite} onCreateFakeAgent={props.onCreateFakeAgent} onCreateManualAgent={props.onCreateManualAgent}
          onDeviceNameChange={props.onDeviceNameChange} onJoinCodeChange={props.onJoinCodeChange} onManualAgentNameChange={props.onManualAgentNameChange}
          setupOutput={props.setupOutput} showMethodTabs={false} />}
      </PanelDialog>}
    </section>
  );
}
