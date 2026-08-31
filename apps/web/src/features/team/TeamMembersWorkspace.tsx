import { type FormEvent, useState } from "react";

import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type {
  AuthMode,
  Member,
  MemberInvitation,
  Team
} from "../../models.js";
import { MemberRecoveryPanel } from "./MemberRecoveryPanel.js";
import { PanelDialog } from "../navigation/PanelDialog.js";

interface TeamMembersWorkspaceProps {
  authMode: AuthMode | null;
  currentMember: Member | null;
  invitationCopied: boolean;
  locale: Locale;
  memberInvitation: MemberInvitation | null;
  memberInviteName: string;
  members: Member[];
  selectedTeam: Team;
  sessionUserId: string | null;
  teamBusy: boolean;
  onCopyInvitation: () => void | Promise<void>;
  onCreateInvitation: (event: FormEvent) => void | Promise<void>;
  onMemberInviteNameChange: (value: string) => void;
  onDismissInvitation?: () => void;
}

export function TeamMembersWorkspace({
  authMode,
  currentMember,
  invitationCopied,
  locale,
  memberInvitation,
  memberInviteName,
  members,
  onCopyInvitation,
  onCreateInvitation,
  onMemberInviteNameChange,
  onDismissInvitation,
  selectedTeam,
  sessionUserId,
  teamBusy
}: TeamMembersWorkspaceProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [action, setAction] = useState<"invite" | "recover" | null>(null);

  return (
    <section className="management-workspace member-workspace" aria-label={t("teamMembers")}>
      <div className="management-intro">
        <div>
          <p>{t("membersDescription")}</p>
        </div>
        {authMode === "trusted-team" && currentMember?.role === "owner" && <div className="member-actions">
          <button className="primary-action" onClick={() => setAction("invite")} type="button">{t("inviteMember")}</button>
          <button onClick={() => setAction("recover")} type="button">{locale === "zh-CN" ? "恢复成员访问" : "Recover member access"}</button>
        </div>}
      </div>

      <div className="member-management-grid">
        <section className="control-panel" aria-labelledby="member-roster-title">
          <div className="panel-header">
            <div><p className="eyebrow">{t("memberRoster")}</p><h3 id="member-roster-title">{selectedTeam.name}</h3></div>
            <span>{locale === "zh-CN" ? `${members.length} 位成员` : `${members.length} members`}</span>
          </div>
          <div className="member-roster">
            {members.map((member) => (
              <article className="member-card" key={member.memberId}>
                <span className="participant-avatar human">{member.displayName.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{member.displayName}</strong>
                  <small>{member.role === "owner" ? t("teamOwner") : t("teamMember")}</small>
                </div>
                {member.userId === sessionUserId && <span className="current-user-badge">{t("currentAccount")}</span>}
              </article>
            ))}
          </div>
        </section>

        {action === "invite" && authMode === "trusted-team" && currentMember?.role === "owner" && <PanelDialog title={t("inviteMember")} locale={locale} onClose={() => { setAction(null); onDismissInvitation?.(); }}>
        <section className="control-panel member-invitation-panel" aria-labelledby="member-invitation-title">
          <div className="panel-header">
            <div><p className="eyebrow">{t("privateInvitation")}</p><h3 id="member-invitation-title">{t("inviteMember")}</h3></div>
          </div>
          {authMode !== "trusted-team" ? (
            <div className="panel-empty compact">
              <strong>{t("trustedModeRequired")}</strong>
              <p>{t("trustedModeRequiredHelp")}</p>
            </div>
          ) : currentMember?.role !== "owner" ? (
            <div className="panel-empty compact">
              <strong>{t("ownerOnlyInvites")}</strong>
              <p>{t("ownerOnlyInvitesHelp")}</p>
            </div>
          ) : (
            <>
              <p className="invitation-help">{t("invitationHelp")}</p>
              <form className="approval-form" onSubmit={(event) => void onCreateInvitation(event)}>
                <label htmlFor="member-invite-name">{t("memberDisplayName")}</label>
                <div>
                  <input id="member-invite-name" onChange={(event) => onMemberInviteNameChange(event.target.value)} placeholder={locale === "zh-CN" ? "例如：小李" : "For example: Bob"} required value={memberInviteName} />
                  <button disabled={teamBusy}>{teamBusy ? t("creating") : t("createInvitation")}</button>
                </div>
              </form>
              {memberInvitation && (
                <div className="member-invitation-result" aria-live="polite">
                  <strong>{t("invitationCreated")}</strong>
                  <p>{t("invitationSharePrivately")}</p>
                  <div className="invitation-link">
                    <input aria-label={t("invitationLink")} readOnly value={memberInvitation.claimUrl} />
                    <button onClick={() => void onCopyInvitation()} type="button">
                      {invitationCopied ? t("copied") : t("copyLink")}
                    </button>
                  </div>
                  <small>{t("invitationExpires")} {new Date(memberInvitation.expiresAt).toLocaleString(locale)}</small>
                </div>
              )}
            </>
          )}
        </section>
        </PanelDialog>}
        {action === "recover" && authMode === "trusted-team" && currentMember?.role === "owner" && (
          <PanelDialog title={locale === "zh-CN" ? "恢复成员访问" : "Recover member access"} locale={locale} onClose={() => setAction(null)}>
          <MemberRecoveryPanel
            key={`${selectedTeam.teamId}:${currentMember.memberId}`}
            locale={locale}
            members={members}
            teamId={selectedTeam.teamId}
          />
          </PanelDialog>
        )}
      </div>
    </section>
  );
}
