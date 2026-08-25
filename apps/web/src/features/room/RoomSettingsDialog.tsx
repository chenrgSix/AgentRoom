import type { FormEvent } from "react";

import { roleLabel } from "../agent/AgentWorkspace.js";
import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type {
  Agent,
  Member,
  Room,
  RoomCollaborationPolicy
} from "../../models.js";

interface RoomSettingsDialogProps {
  agents: Agent[];
  busy: boolean;
  locale: Locale;
  members: Member[];
  participantAgentIds: string[];
  participantMemberIds: string[];
  policy: RoomCollaborationPolicy;
  room: Room;
  onClose: () => void;
  onPolicyChange: (policy: RoomCollaborationPolicy) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onToggleAgent: (agentId: string) => void;
  onToggleMember: (memberId: string) => void;
}

export function RoomSettingsDialog({
  agents,
  busy,
  locale,
  members,
  onClose,
  onPolicyChange,
  onSubmit,
  onToggleAgent,
  onToggleMember,
  participantAgentIds,
  participantMemberIds,
  policy,
  room
}: RoomSettingsDialogProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section aria-labelledby="room-settings-dialog-title" aria-modal="true" className="modal-card participant-modal" role="dialog">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">#{room.name}</p>
            <h3 id="room-settings-dialog-title">{t("roomSettings")}</h3>
          </div>
          <button aria-label={t("cancel")} onClick={onClose} type="button">×</button>
        </div>
        <p>{t("roomSettingsHelp")}</p>
        <form className="modal-form" onSubmit={(event) => void onSubmit(event)}>
          <fieldset className="room-policy-editor">
            <legend>{locale === "zh-CN" ? "Agent 协作" : "Agent collaboration"}</legend>
            <div className="room-policy-options">
              <label className="room-policy-switch">
                <input checked={policy.allowDiscussion} onChange={(event) => onPolicyChange({ ...policy, allowDiscussion: event.target.checked })} type="checkbox" />
                <span>
                  <strong>{locale === "zh-CN" ? "允许多 Agent 讨论" : "Allow multi-Agent Discussions"}</strong>
                  <small>{locale === "zh-CN"
                    ? "开启后，多 Agent 提及进入有轮次和结论的讨论；关闭后只并行回复一次。"
                    : "When on, multi-Agent mentions start a governed Discussion; when off, each Agent replies once."}</small>
                </span>
              </label>
              <label className="room-policy-switch">
                <input checked={policy.allowAll} onChange={(event) => onPolicyChange({ ...policy, allowAll: event.target.checked })} type="checkbox" />
                <span>
                  <strong>{locale === "zh-CN" ? "允许 @all" : "Allow @all"}</strong>
                  <small>{locale === "zh-CN"
                    ? "允许成员用精确 @all 指令选择当前房间全部已启用 Agent。"
                    : "Let members use the exact @all command for every enabled Agent in this Room."}</small>
                </span>
              </label>
              <label className="room-policy-switch">
                <input checked={policy.allowAgentMentions} onChange={(event) => onPolicyChange({ ...policy, allowAgentMentions: event.target.checked })} type="checkbox" />
                <span>
                  <strong>{locale === "zh-CN" ? "允许 Agent 互相点名" : "Allow Agent-to-Agent mentions"}</strong>
                  <small>{locale === "zh-CN"
                    ? "Agent 回复中的完整名称 @指令可触发受限接力；模糊名称不会路由。"
                    : "Exact full-name @ commands in Agent replies can trigger bounded handoffs; fuzzy names never route."}</small>
                </span>
              </label>
            </div>
            <label className="room-policy-depth">
              <span>
                <strong>{locale === "zh-CN" ? "最大接力深度" : "Maximum handoff depth"}</strong>
                <small>{locale === "zh-CN" ? "限制 Agent 连续互相点名的层数" : "Limits chained Agent-to-Agent mentions"}</small>
              </span>
              <select
                aria-label={locale === "zh-CN" ? "最大接力深度" : "Maximum handoff depth"}
                disabled={!policy.allowAgentMentions}
                onChange={(event) => onPolicyChange({
                  ...policy,
                  maxAgentMentionDepth: Number(event.target.value)
                })}
                value={policy.maxAgentMentionDepth}
              >
                {[1, 2, 3, 4].map((depth) => (
                  <option key={depth} value={depth}>{depth}</option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset className="participant-editor-group">
            <legend>{t("teamMembers")}</legend>
            <div className="participant-editor-list">
              {members.map((member) => (
                <label key={member.memberId}>
                  <input checked={participantMemberIds.includes(member.memberId)} disabled={member.role === "owner"} onChange={() => onToggleMember(member.memberId)} type="checkbox" />
                  <span><strong>{member.displayName}</strong><small>{member.role === "owner" ? t("teamOwner") : t("teamMember")}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="participant-editor-group">
            <legend>{t("teamAgents")} · {locale === "zh-CN" ? "单独启用" : "Per-Agent access"}</legend>
            <div className="participant-editor-list">
              {agents.map((agent) => (
                <label key={agent.agentId}>
                  <input checked={participantAgentIds.includes(agent.agentId)} disabled={agent.enabled === false} onChange={() => onToggleAgent(agent.agentId)} type="checkbox" />
                  <span><strong>{agent.name}</strong><small>{roleLabel(agent.role, locale)}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="modal-actions">
            <button className="secondary-action" onClick={onClose} type="button">{t("cancel")}</button>
            <button className="primary-action" disabled={busy}>{busy ? t("saving") : t("save")}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
