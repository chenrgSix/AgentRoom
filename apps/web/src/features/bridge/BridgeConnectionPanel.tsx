import type { FormEvent } from "react";

import { bridgeServerURL } from "../../api-client.js";
import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { ConnectionMode } from "../../models.js";

interface BridgeConnectionPanelProps {
  busy: boolean;
  connectionMode: ConnectionMode;
  deviceName: string;
  joinCode: string;
  locale: Locale;
  manualAgentName: string;
  agentName: string;
  setupOutput: string | null;
  onApproveBridgeJoin: (event: FormEvent) => void | Promise<void>;
  onConnectionModeChange: (mode: ConnectionMode) => void;
  onCreateBridgeInvite: (event: FormEvent) => void | Promise<void>;
  onCreateFakeAgent: (event: FormEvent) => void | Promise<void>;
  onCreateManualAgent: (event: FormEvent) => void | Promise<void>;
  onDeviceNameChange: (value: string) => void;
  onJoinCodeChange: (value: string) => void;
  onManualAgentNameChange: (value: string) => void;
  onAgentNameChange: (value: string) => void;
}

export function BridgeConnectionPanel({
  agentName,
  busy,
  connectionMode,
  deviceName,
  joinCode,
  locale,
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
  setupOutput
}: BridgeConnectionPanelProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const serverURL = bridgeServerURL();

  return (
    <section className="control-panel connection-center" aria-labelledby="connection-center-title">
      <div className="panel-header">
        <div><p className="eyebrow">{t("connectionCenter")}</p><h3 id="connection-center-title">{t("addAgent")}</h3></div>
      </div>
      <div className="connection-tabs" role="tablist" aria-label={t("connectionMethods")}>
        <button aria-selected={connectionMode === "managed"} onClick={() => onConnectionModeChange("managed")} role="tab" type="button">{t("managedCodex")}</button>
        <button aria-selected={connectionMode === "mcp"} onClick={() => onConnectionModeChange("mcp")} role="tab" type="button">{t("mcpClient")}</button>
        <button aria-selected={connectionMode === "demo"} onClick={() => onConnectionModeChange("demo")} role="tab" type="button">{t("demoAgent")}</button>
      </div>

      {connectionMode === "managed" && (
        <div className="connection-content" role="tabpanel">
          <div className="method-heading"><span className="method-icon">⌘</span><div><strong>{t("managedLocalCodex")}</strong><p>{t("managedCodexHelp")}</p></div></div>
          <ol className="setup-steps">
            <li><span>1</span><div><strong>{t("startBridge")}</strong><p>{t("startBridgeHelp")}</p></div></li>
          </ol>
          <div className="command-box"><code>convenewire-bridge join --server {serverURL}</code><button onClick={() => void navigator.clipboard.writeText(`convenewire-bridge join --server ${serverURL}`)} type="button">{t("copy")}</button></div>
          <ol className="setup-steps" start={2}>
            <li><span>2</span><div><strong>{t("approveCodeTitle")}</strong><p>{t("approveCodeHelp")}</p></div></li>
          </ol>
          <form className="approval-form" onSubmit={(event) => void onApproveBridgeJoin(event)}>
            <label htmlFor="bridge-approval-code">{t("bridgeApprovalCode")}</label>
            <div>
              <input
                aria-label={t("bridgeApprovalCode")}
                autoCapitalize="characters"
                autoComplete="off"
                id="bridge-approval-code"
                onChange={(event) => onJoinCodeChange(event.target.value.toUpperCase())}
                placeholder="ABCD-1234"
                required
                value={joinCode}
              />
              <button disabled={busy}>{busy ? t("approving") : t("approveBridge")}</button>
            </div>
          </form>
          <details className="legacy-pairing">
            <summary>{t("legacyPairing")}</summary>
            <form className="approval-form compact" onSubmit={(event) => void onCreateBridgeInvite(event)}>
              <label htmlFor="legacy-device-name">{t("deviceName")}</label>
              <div>
                <input id="legacy-device-name" aria-label={t("bridgeDeviceName")} onChange={(event) => onDeviceNameChange(event.target.value)} placeholder={locale === "zh-CN" ? "小陈的 Mac" : "Bob's Mac"} required value={deviceName} />
                <button disabled={busy}>{t("createCode")}</button>
              </div>
            </form>
          </details>
        </div>
      )}

      {connectionMode === "mcp" && (
        <div className="connection-content" role="tabpanel">
          <div className="method-heading"><span className="method-icon">M</span><div><strong>{t("mcpParticipant")}</strong><p>{t("mcpHelp")}</p></div></div>
          <form className="approval-form" onSubmit={(event) => void onCreateManualAgent(event)}>
            <label htmlFor="manual-agent-name">{t("agentDisplayName")}</label>
            <div>
              <input id="manual-agent-name" aria-label={t("manualAgentName")} onChange={(event) => onManualAgentNameChange(event.target.value)} placeholder="Codex via MCP" required value={manualAgentName} />
              <button disabled={busy}>{t("createMcpToken")}</button>
            </div>
          </form>
        </div>
      )}

      {connectionMode === "demo" && (
        <div className="connection-content" role="tabpanel">
          <div className="demo-warning"><strong>{t("simulationOnly")}</strong><p>{t("demoAgentHelp")}</p></div>
          <form className="approval-form" onSubmit={(event) => void onCreateFakeAgent(event)}>
            <label htmlFor="demo-agent-name">{t("demoAgentName")}</label>
            <div>
              <input id="demo-agent-name" aria-label={t("demoAgentName")} onChange={(event) => onAgentNameChange(event.target.value)} placeholder={locale === "zh-CN" ? "评审助手" : "Review Bot"} required value={agentName} />
              <button disabled={busy}>{t("addDemoAgent")}</button>
            </div>
          </form>
        </div>
      )}

      {setupOutput && (
        <div className="setup-output management-output" aria-live="polite">
          <div><strong>{t("setupResult")}</strong><button type="button" onClick={() => void navigator.clipboard.writeText(setupOutput)}>{t("copy")}</button></div>
          <pre>{setupOutput}</pre>
        </div>
      )}
    </section>
  );
}
