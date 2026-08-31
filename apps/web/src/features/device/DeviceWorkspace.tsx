import { useState } from "react";
import { type Locale, translate } from "../../i18n.js";
import type { Agent, Device } from "../../models.js";
import { DevicePairingPanel } from "./DevicePairingPanel.js";
import { PanelDialog } from "../navigation/PanelDialog.js";

export function DeviceWorkspace({ agents, devices, locale, currentMemberId, currentMemberIsOwner, sessionToken, teamId, onRevokeDevice }: {
  agents: Agent[]; devices: Device[]; locale: Locale; currentMemberId: string | null;
  currentMemberIsOwner: boolean; sessionToken: string | undefined; teamId: string;
  onRevokeDevice: (device: Device) => void | Promise<void>;
}) {
  const zh = locale === "zh-CN";
  const [pairing, setPairing] = useState(false);
  const [search, setSearch] = useState("");
  const visible = devices.filter((device) => device.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="management-workspace device-workspace" aria-label={zh ? "设备管理" : "Device management"}>
    <div className="management-intro"><div><p>{zh ? "管理客户端的接入与授权。本机运行配置仍由客户端掌管。" : "Manage client access and authorization. Runtime settings stay on each client."}</p></div>
      {currentMemberIsOwner && <button className="primary-action" onClick={() => setPairing(true)} type="button">{zh ? "配对新设备" : "Pair a Device"}</button>}
    </div>
    <div className="inventory-toolbar"><input aria-label={zh ? "搜索设备" : "Search Devices"} placeholder={zh ? "按设备名称搜索" : "Search by Device name"} type="search" value={search} onChange={(event) => setSearch(event.target.value)} /><span>{zh ? `${devices.length} 台设备` : `${devices.length} Devices`}</span></div>
    <p className="inventory-help">{zh ? "授权有效不代表设备在线；下方就绪数量来自该设备上报的 Agent 状态。" : "Active authorization does not mean a Device is online. Ready counts reflect its reported Agent states."}</p>
    {visible.length === 0 ? <div className="panel-empty"><strong>{search ? (zh ? "没有匹配的设备" : "No matching Devices") : translate(locale, "noDevices")}</strong><p>{currentMemberIsOwner ? (zh ? "在要执行工作的电脑打开客户端，然后开始配对。" : "Open the client on the computer that will perform the work, then start pairing.") : translate(locale, "setupLocalMemberHelp")}</p></div> : (
      <div className="device-grid">
        {visible.map((device) => {
          const published = agents.filter((agent) => agent.deviceId === device.deviceId);
          const ready = published.filter((agent) => agent.enabled !== false && agent.presence === "ready").length;
          const canRevoke = currentMemberIsOwner || device.ownerMemberId === currentMemberId;
          return <article className="device-card" key={device.deviceId}>
            <span className="device-icon" aria-hidden="true">▣</span>
            <div className="device-identity"><strong>{device.name}</strong><small>{zh ? `${published.length} 个智能体 · ${ready} 个就绪` : `${published.length} Agents · ${ready} ready`}</small><details><summary>{zh ? "设备标识" : "Device identity"}</summary><code>{device.deviceId}</code></details></div>
            <span className={`status-badge ${device.status}`}>{device.status === "active" ? (zh ? "授权有效" : "Authorized") : translate(locale, "revoked")}</span>
            {canRevoke && <button disabled={device.status !== "active"} onClick={() => void onRevokeDevice(device)} type="button">{translate(locale, "revoke")}</button>}
          </article>;
        })}
      </div>
    )}
    {pairing && currentMemberIsOwner && <PanelDialog title={zh ? "配对新设备" : "Pair a Device"} locale={locale} onClose={() => setPairing(false)}>
      <DevicePairingPanel currentMemberIsOwner currentMemberId={currentMemberId} locale={locale} sessionToken={sessionToken} teamId={teamId} />
    </PanelDialog>}
  </section>;
}
