import { type FormEvent, useState } from "react";

import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { AuthGateState, Theme } from "../../models.js";
import { errorLabel } from "../../presentation.js";

interface AccessGateProps {
  busy: boolean;
  error: string | null;
  locale: Locale;
  onClaimInvitation: () => Promise<void>;
  onEnterLocal: () => Promise<void>;
  onRecoverOwner: (recoveryToken: string) => Promise<void>;
  onRecoverMember?: (recoveryToken: string) => Promise<void>;
  onSetupOwner: (displayName: string, recoveryToken: string) => Promise<void>;
  onToggleLocale: () => void;
  onToggleTheme: () => void;
  state: Exclude<AuthGateState, "authenticated">;
  theme: Theme;
}

export function AccessGate({
  busy,
  error,
  locale,
  onClaimInvitation,
  onEnterLocal,
  onRecoverOwner,
  onRecoverMember,
  onSetupOwner,
  onToggleLocale,
  onToggleTheme,
  state,
  theme
}: AccessGateProps) {
  const [displayName, setDisplayName] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [memberRecoveryToken, setMemberRecoveryToken] = useState("");
  const t = (key: TranslationKey) => translate(locale, key);

  async function setupOwner(event: FormEvent) {
    event.preventDefault();
    const submittedRecoveryToken = recoveryToken;
    setRecoveryToken("");
    await onSetupOwner(displayName.trim(), submittedRecoveryToken);
  }

  async function recoverOwner(event: FormEvent) {
    event.preventDefault();
    const submittedRecoveryToken = recoveryToken;
    setRecoveryToken("");
    await onRecoverOwner(submittedRecoveryToken);
  }

  async function recoverMember(event: FormEvent) {
    event.preventDefault();
    if (!onRecoverMember || busy) return;
    const submittedToken = memberRecoveryToken.trim();
    setMemberRecoveryToken("");
    await onRecoverMember(submittedToken);
  }

  return (
    <main className="access-shell">
      <div className="access-toolbar">
        <button aria-label={t("language")} onClick={onToggleLocale} title={t("language")} type="button">
          {locale === "zh-CN" ? "EN" : "中"}
        </button>
        <button aria-label={t("theme")} onClick={onToggleTheme} title={theme === "dark" ? t("switchToLight") : t("switchToDark")} type="button">
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
      <section className="access-card" aria-live="polite">
        <div className="brand-mark" aria-label="ConveneWire">CW</div>
        <p className="eyebrow">{t("secureTeamAccess")}</p>
        {state === "loading" && (
          <>
            <h1>{t("accessLoading")}</h1>
            <p>{t("accessLoadingHelp")}</p>
          </>
        )}
        {state === "local_bootstrap" && (
          <>
            <h1>{t("localAccess")}</h1>
            <p>{t("localAccessHelp")}</p>
            <button className="access-primary" disabled={busy} onClick={() => void onEnterLocal()} type="button">
              {t("enterLocalWorkspace")}
            </button>
          </>
        )}
        {state === "setup_required" && (
          <>
            <h1>{t("setupOwner")}</h1>
            <p>{t("setupOwnerHelp")}</p>
            <form className="access-form" onSubmit={(event) => void setupOwner(event)}>
              <label htmlFor="owner-display-name">{t("ownerDisplayName")}</label>
              <input autoComplete="name" id="owner-display-name" onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
              <label htmlFor="setup-recovery-token">{t("recoveryKey")}</label>
              <input autoComplete="off" id="setup-recovery-token" onChange={(event) => setRecoveryToken(event.target.value)} required type="password" value={recoveryToken} />
              <small>{t("recoveryKeyHelp")}</small>
              <button disabled={busy}>{busy ? t("signingIn") : t("finishSetup")}</button>
            </form>
          </>
        )}
        {state === "sign_in_required" && (
          <>
            <h1>{locale === "zh-CN" ? "回到你的 Team" : "Back to your Team"}</h1>
            <p>{locale === "zh-CN" ? "恢复原来的身份，继续之前的工作。" : "Return to your existing identity and continue your work."}</p>
            {onRecoverMember && (
              <form className="access-form" aria-label={locale === "zh-CN" ? "成员重新登录" : "Member sign-in"} onSubmit={(event) => void recoverMember(event)}>
                <h2>{locale === "zh-CN" ? "成员重新登录" : "Member sign-in"}</h2>
                <small>{locale === "zh-CN" ? "换浏览器或会话过期？请让 Team Owner 在成员管理中为你生成恢复码；不要用新邀请替代原身份。" : "Changed browsers or lost your session? Ask your Team Owner for a recovery code from member management. A new invitation creates a different identity."}</small>
                <label htmlFor="recover-member-token">{locale === "zh-CN" ? "一次性成员恢复码" : "One-time member recovery code"}</label>
                <input autoComplete="off" id="recover-member-token" maxLength={128} onChange={(event) => setMemberRecoveryToken(event.target.value)} required type="password" value={memberRecoveryToken} />
                <small>{locale === "zh-CN" ? "15 分钟内有效，只能使用一次。成功后保留原身份并退出旧网页会话；失败或响应丢失时请联系 Owner 获取新码。" : "Valid for 15 minutes and one use. Recovery preserves your identity and signs out old Web sessions. If it fails or the response is lost, ask the Owner for a new code."}</small>
                <button disabled={busy || memberRecoveryToken.trim().length === 0}>{busy ? t("signingIn") : (locale === "zh-CN" ? "恢复原成员身份" : "Recover my member identity")}</button>
              </form>
            )}
            <form className="access-form" onSubmit={(event) => void recoverOwner(event)}>
              <h2>{t("ownerSignIn")}</h2>
              <small>{t("ownerSignInHelp")}</small>
              <label htmlFor="recover-owner-token">{t("recoveryKey")}</label>
              <input autoComplete="off" id="recover-owner-token" onChange={(event) => setRecoveryToken(event.target.value)} required type="password" value={recoveryToken} />
              <small>{t("recoveryKeyHelp")}</small>
              <button disabled={busy}>{busy ? t("signingIn") : t("recoverAccess")}</button>
            </form>
            <aside className="access-note">
              <strong>{locale === "zh-CN" ? "第一次加入？" : "Joining for the first time?"}</strong>
              <p>{locale === "zh-CN" ? "请让 Team Owner 提供成员邀请。已有成员请使用恢复码，避免创建重复身份。" : "Ask the Team Owner for a member invitation. Existing members should use a recovery code to avoid creating a duplicate identity."}</p>
            </aside>
          </>
        )}
        {state === "claim_required" && (
          <>
            <h1>{t("invitedToTeam")}</h1>
            <p>{t("invitationClaimHelp")}</p>
            <button className="access-primary" disabled={busy} onClick={() => void onClaimInvitation()} type="button">
              {busy ? t("joiningTeam") : t("joinTeam")}
            </button>
          </>
        )}
        {error && <div className="access-error" role="alert">{errorLabel(error, locale)}</div>}
      </section>
    </main>
  );
}
