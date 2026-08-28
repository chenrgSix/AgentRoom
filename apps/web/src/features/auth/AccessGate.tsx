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
  onSetupOwner,
  onToggleLocale,
  onToggleTheme,
  state,
  theme
}: AccessGateProps) {
  const [displayName, setDisplayName] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
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
            <h1>{t("ownerSignIn")}</h1>
            <p>{t("ownerSignInHelp")}</p>
            <form className="access-form" onSubmit={(event) => void recoverOwner(event)}>
              <label htmlFor="recover-owner-token">{t("recoveryKey")}</label>
              <input autoComplete="off" id="recover-owner-token" onChange={(event) => setRecoveryToken(event.target.value)} required type="password" value={recoveryToken} />
              <small>{t("recoveryKeyHelp")}</small>
              <button disabled={busy}>{busy ? t("signingIn") : t("recoverAccess")}</button>
            </form>
            <aside className="access-note">
              <strong>{t("memberAccess")}</strong>
              <p>{t("memberInvitationExplanation")}</p>
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
