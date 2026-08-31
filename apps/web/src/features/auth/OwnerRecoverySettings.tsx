import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { HttpRequestError, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";

interface Settings { revision: number; updatedAt: string | null }

export function OwnerRecoverySettings({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const zh = locale === "zh-CN";
  return <>
    <button className="owner-recovery-trigger" onClick={() => setOpen(true)} ref={trigger} type="button">
      {zh ? "恢复密钥" : "Recovery key"}
    </button>
    {open && createPortal(<RecoveryDialog locale={locale} onClose={() => {
      setOpen(false);
      trigger.current?.focus();
    }} />, document.body)}
  </>;
}

function RecoveryDialog({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const zh = locale === "zh-CN";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [candidate, setCandidate] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [failure, setFailure] = useState<"load" | "random" | "uncertain" | "conflict" | null>(null);
  const active = useRef(true);
  const submitting = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    active.current = true;
    closeButton.current?.focus();
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void jsonRequest<Settings>("/api/auth/owner-recovery").then((result) => {
      if (current) setSettings(result);
    }).catch(() => { if (current) setFailure("load"); });
    return () => { current = false; };
  }, []);

  function generate() {
    try {
      const bytes = window.crypto.getRandomValues(new Uint8Array(32));
      setCandidate(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
      bytes.fill(0);
      setConfirmed(false);
      setCopied(false);
      setCopyFailed(false);
      setFailure(null);
    } catch { setFailure("random"); }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(candidate);
      if (active.current) { setCopied(true); setCopyFailed(false); }
    } catch { if (active.current) setCopyFailed(true); }
  }

  async function replace() {
    if (submitting.current || !settings || !candidate || !confirmed || failure === "conflict") return;
    submitting.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await jsonRequest<Settings>("/api/auth/owner-recovery", {
        method: "PUT",
        headers: { "x-agent-room-recovery-token": candidate },
        body: JSON.stringify({ expectedRevision: settings.revision })
      });
      if (!active.current) return;
      setSettings(result);
      setCandidate("");
      setConfirmed(false);
      setCopied(false);
      setCopyFailed(false);
      setVisible(false);
      setSucceeded(true);
    } catch (error) {
      if (active.current) {
        setFailure(error instanceof HttpRequestError && error.status === 409 ? "conflict" : "uncertain");
      }
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <div className="modal-backdrop">
    <section aria-labelledby="owner-recovery-title" aria-modal="true" className="modal-card owner-recovery-dialog" role="dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!submitting.current) onClose();
        }
        if (event.key !== "Tab") return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="modal-heading">
        <h3 id="owner-recovery-title">{zh ? "重置 Owner 恢复密钥" : "Reset Owner recovery key"}</h3>
        <button aria-label={zh ? "关闭" : "Close"} disabled={busy} onClick={onClose} ref={closeButton} type="button">×</button>
      </div>
      <p>{zh
        ? "忘记旧密钥也没关系：当前 Owner 登录状态允许重置。新密钥生效后，旧密钥不能再登录，其他 Owner 网页会话将退出；当前页面和 Agent 配置不受影响。"
        : "Your current Owner session can reset a forgotten key. The old key will stop working and other Owner Web sessions will sign out. This page and Agent configuration stay available."}</p>
      {succeeded ? <p role="status">{zh
        ? "新恢复密钥已生效。请保管好刚才保存的密钥，下次需要恢复登录时使用。"
        : "The new recovery key is active. Keep the copy you saved for your next sign-in recovery."}</p> : <>
        <p>{zh
          ? "请先把新密钥保存到密码管理器等安全位置，再确认生效。关闭此窗口后无法再次查看；不要发送到聊天或房间。"
          : "Save the new key in a password manager or another private location before activating it. It cannot be viewed again after closing. Do not send it to a chat or Room."}</p>
        {!settings && !failure && <p role="status">{zh ? "正在检查权限…" : "Checking access…"}</p>}
        {settings && !candidate && <button onClick={generate} type="button">{zh ? "生成新恢复密钥" : "Generate a new recovery key"}</button>}
        {candidate && <form className="access-form" onSubmit={(event) => { event.preventDefault(); void replace(); }}>
          <label htmlFor="new-owner-recovery-key">{zh ? "新恢复密钥（尚未确认生效）" : "New recovery key (activation unconfirmed)"}</label>
          <input autoComplete="off" id="new-owner-recovery-key" readOnly spellCheck={false} type={visible ? "text" : "password"} value={candidate} />
          <div className="owner-recovery-actions">
            <button aria-pressed={visible} onClick={() => setVisible((value) => !value)} type="button">{visible ? (zh ? "隐藏" : "Hide") : (zh ? "显示密钥" : "Show key")}</button>
            <button onClick={() => void copy()} type="button">{copied ? (zh ? "已复制" : "Copied") : (zh ? "复制密钥" : "Copy key")}</button>
          </div>
          {copyFailed && <p role="alert">{zh ? "剪贴板不可用，请显示密钥并手动保存。" : "Clipboard unavailable. Show the key and save it manually."}</p>}
          <label className="recovery-confirmation">
            <input checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} required type="checkbox" />
            {zh ? "我已安全保存新密钥，确认让旧密钥失效。" : "I saved the new key privately and confirm invalidating the old key."}
          </label>
          <button disabled={!confirmed || busy || failure === "conflict"} type="submit">{busy
            ? (zh ? "正在确认…" : "Confirming…")
            : failure === "uncertain" ? (zh ? "重试确认同一密钥" : "Retry this same key")
              : (zh ? "确认重置" : "Confirm reset")}</button>
        </form>}
      </>}
      {failure && <p className="access-error" role="alert">{failure === "conflict"
        ? (zh ? "密钥已在其他操作中更改，本次候选密钥未生效。请关闭后重新打开，再生成并保存新密钥。" : "Another operation changed the key. This candidate is not active. Close and reopen before generating and saving a new key.")
        : failure === "uncertain"
          ? (zh ? "暂时无法确认是否已生效。请保留已保存的新密钥，并重试确认同一密钥；不要直接生成另一个。" : "Activation could not be confirmed. Keep your saved new key and retry this same key; do not generate a replacement yet.")
          : failure === "random"
              ? (zh ? "浏览器无法安全生成密钥，未进行任何修改。" : "Secure key generation is unavailable. Nothing changed.")
              : (zh ? "无法读取设置。请确认仍以安装 Owner 登录，关闭后重试。" : "Settings unavailable. Check your installation Owner session, then close and retry.")}</p>}
    </section>
  </div>;
}
