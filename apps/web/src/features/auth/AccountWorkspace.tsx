import type { Locale } from "../../i18n.js";
import type { AuthMode, LocalSession, Theme } from "../../models.js";
import { OwnerRecoverySettings } from "./OwnerRecoverySettings.js";

export function AccountWorkspace({ session, authMode, locale, theme, onLocale, onTheme }: {
  session: LocalSession; authMode: AuthMode | null; locale: Locale; theme: Theme;
  onLocale: () => void; onTheme: () => void;
}) {
  const zh = locale === "zh-CN";
  return <section className="management-workspace account-workspace" aria-label={zh ? "账户与安全" : "Account & security"}>
    <section className="control-panel">
      <h3>{zh ? "当前账户" : "Your account"}</h3>
      <dl className="account-facts">
        <div><dt>{zh ? "身份" : "Identity"}</dt><dd>{session.displayName}</dd></div>
        <div><dt>{zh ? "登录方式" : "Access mode"}</dt><dd>{session.clientTeamId ? (zh ? "客户端成员入口（普通成员权限）" : "Client entry (member authority)") : authMode === "trusted-team" ? (zh ? "可信团队" : "Trusted Team") : (zh ? "本机模式" : "Local mode")}</dd></div>
      </dl>
    </section>
    <section className="control-panel">
      <h3>{zh ? "界面偏好" : "Appearance"}</h3>
      <div className="account-preference"><span>{zh ? "语言" : "Language"}</span><button onClick={onLocale} type="button">{zh ? "切换为 English" : "切换为简体中文"}</button></div>
      <div className="account-preference"><span>{zh ? "主题" : "Theme"}</span><button onClick={onTheme} type="button">{theme === "dark" ? (zh ? "切换浅色" : "Use light theme") : (zh ? "切换深色" : "Use dark theme")}</button></div>
    </section>
    <section className="control-panel">
      <h3>{zh ? "登录恢复" : "Login recovery"}</h3>
      <p>{authMode !== "trusted-team"
        ? (zh ? "本机模式不使用 Owner 登录恢复密钥。" : "Local mode does not use an Owner login recovery key.")
        : session.canManageOwnerRecovery
          ? (zh ? "更换此中央服务的 Owner 登录恢复密钥。不会修改智能体的 API 配置。" : "Replace this Central's Owner login recovery key without changing Agent API configuration.")
          : (zh ? "如需恢复账户访问，请联系团队 Owner。中央服务的登录恢复密钥仅由安装 Owner 管理。" : "Contact your Team Owner for account recovery. Only the installation Owner manages the Central login recovery key.")}</p>
      {authMode === "trusted-team" && session.canManageOwnerRecovery && <OwnerRecoverySettings key={session.userId} locale={locale} />}
    </section>
  </section>;
}
