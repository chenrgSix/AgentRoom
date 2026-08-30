import { type FormEvent, useEffect, useRef, useState } from "react";

import { jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import type { Member } from "../../models.js";

interface MemberRecovery {
  recoveryId: string;
  teamId: string;
  memberId: string;
  displayName: string;
  expiresAt: string;
  token: string;
}

interface MemberRecoveryPanelProps {
  locale: Locale;
  members: Member[];
  teamId: string;
}

export function MemberRecoveryPanel({ locale, members, teamId }: MemberRecoveryPanelProps) {
  const zh = locale === "zh-CN";
  const [memberId, setMemberId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [recovery, setRecovery] = useState<MemberRecovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<"expired" | "revoked" | null>(null);
  const [failure, setFailure] = useState<"issue" | "copy" | "revoke" | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const candidates = members.filter((member) => member.role === "member" && member.userId);
  const selectedMember = candidates.find((member) => member.memberId === memberId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!recovery) return;
    const timeout = setTimeout(() => {
      setRecovery(null);
      setCopied(false);
      setNotice("expired");
    }, Math.max(0, Date.parse(recovery.expiresAt) - Date.now()));
    return () => clearTimeout(timeout);
  }, [recovery]);

  function selectMember(value: string) {
    generation.current += 1;
    setMemberId(value);
    setRecovery(null);
    setConfirmed(false);
    setCopied(false);
    setFailure(null);
    setNotice(null);
    setBusy(false);
  }

  async function issue(event: FormEvent) {
    event.preventDefault();
    if (!selectedMember || !confirmed || busy) return;
    const attempt = ++generation.current;
    setBusy(true);
    setRecovery(null);
    setCopied(false);
    setFailure(null);
    setNotice(null);
    try {
      const result = await jsonRequest<MemberRecovery>(
        `/api/teams/${teamId}/members/${memberId}/recovery`, { method: "POST" }
      );
      if (mounted.current && generation.current === attempt) setRecovery(result);
    } catch {
      if (mounted.current && generation.current === attempt) setFailure("issue");
    } finally {
      if (mounted.current && generation.current === attempt) setBusy(false);
    }
  }

  async function copy() {
    if (!recovery) return;
    const attempt = generation.current;
    try {
      await navigator.clipboard.writeText(recovery.token);
      if (mounted.current && generation.current === attempt) {
        setCopied(true);
        setFailure(null);
      }
    } catch {
      if (mounted.current && generation.current === attempt) setFailure("copy");
    }
  }

  async function revoke() {
    if (!recovery || busy) return;
    const attempt = generation.current;
    setBusy(true);
    setFailure(null);
    try {
      await jsonRequest(
        `/api/teams/${teamId}/members/${recovery.memberId}/recovery/${recovery.recoveryId}`,
        { method: "DELETE" }
      );
      if (mounted.current && generation.current === attempt) {
        setRecovery(null);
        setCopied(false);
        setNotice("revoked");
      }
    } catch {
      if (mounted.current && generation.current === attempt) setFailure("revoke");
    } finally {
      if (mounted.current && generation.current === attempt) setBusy(false);
    }
  }

  return (
    <section className="control-panel member-recovery-panel" aria-labelledby="member-recovery-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{zh ? "找回原身份" : "Return to an existing identity"}</p>
          <h3 id="member-recovery-title">{zh ? "帮助成员重新登录" : "Help a member sign in again"}</h3>
        </div>
      </div>
      <p className="invitation-help">
        {zh
          ? "成员换浏览器或会话过期时，请发恢复码，不要重新邀请。恢复后保留原来的房间、任务和设备归属，并退出该成员的旧网页会话。"
          : "When a member changes browsers or their session expires, send a recovery code instead of a new invitation. Their Rooms, Tasks and Device ownership stay intact; old Web sessions are signed out."}
      </p>
      <p className="invitation-help">
        {zh
          ? "仅支持只属于当前 Team 的普通成员。Owner 和跨 Team 身份不能通过此入口恢复。"
          : "Available only for ordinary members belonging to this Team alone. Owner and multi-Team identities cannot use this recovery path."}
      </p>
      {candidates.length === 0 ? (
        <p>{zh ? "暂无可恢复的普通成员。" : "There are no ordinary members to recover."}</p>
      ) : (
        <form className="access-form" onSubmit={(event) => void issue(event)}>
          <label htmlFor="recovery-member">{zh ? "需要恢复的成员" : "Member to recover"}</label>
          <select id="recovery-member" onChange={(event) => selectMember(event.target.value)} required value={memberId}>
            <option value="">{zh ? "选择已有成员" : "Select an existing member"}</option>
            {candidates.map((member) => (
              <option key={member.memberId} value={member.memberId}>{member.displayName}</option>
            ))}
          </select>
          <label className="recovery-confirmation">
            <input checked={confirmed} disabled={!selectedMember || busy} onChange={(event) => setConfirmed(event.target.checked)} required type="checkbox" />
            {zh ? "我已通过可信渠道确认对方身份，将私下发送恢复码。" : "I verified this person's identity through a trusted channel and will share the code privately."}
          </label>
          <button disabled={!selectedMember || !confirmed || busy}>
            {busy ? (zh ? "处理中…" : "Working…") : (zh ? "生成 15 分钟恢复码" : "Create a 15-minute recovery code")}
          </button>
        </form>
      )}
      {recovery && selectedMember && (
        <div className="member-invitation-result" aria-live="polite">
          <strong>{zh ? `${recovery.displayName} 的一次性恢复码` : `One-time code for ${recovery.displayName}`}</strong>
          <p>{zh ? "让成员打开中央服务登录页，在“成员重新登录”中粘贴。此码只显示这一次；重新生成会让旧码失效。" : "Ask the member to open Central's sign-in page and paste this under “Member sign-in”. The code is shown only now; generating another invalidates the old code."}</p>
          <div className="invitation-link">
            <input aria-label={zh ? "一次性成员恢复码" : "One-time member recovery code"} autoComplete="off" readOnly type="password" value={recovery.token} />
            <button disabled={busy} onClick={() => void copy()} type="button">{copied ? (zh ? "已复制" : "Copied") : (zh ? "复制恢复码" : "Copy code")}</button>
          </div>
          <small>{zh ? "有效期至" : "Expires"} {new Date(recovery.expiresAt).toLocaleString(locale)}</small>
          <button disabled={busy} onClick={() => void revoke()} type="button">{zh ? "撤销这个恢复码" : "Revoke this code"}</button>
        </div>
      )}
      {notice && <p role="status">{notice === "expired"
        ? (zh ? "恢复码已过期，请重新生成。" : "The recovery code expired. Create a new one.")
        : (zh ? "这个恢复码已失效；如已使用，不会撤销已恢复的会话。" : "This code is no longer usable. If it was already used, the restored session is unchanged.")}</p>}
      {failure && <p className="access-error" role="alert">{failure === "copy"
        ? (zh ? "无法访问剪贴板，请检查浏览器权限后重试。" : "Clipboard access failed. Check browser permissions and retry.")
        : failure === "revoke"
          ? (zh ? "未能确认撤销。请重试，或生成新码使旧码失效。" : "Revocation could not be confirmed. Retry, or create a new code to invalidate the old one.")
          : (zh ? "无法生成恢复码。请确认 Owner 会话有效，且该成员只属于当前 Team、不是 Owner；重试会替换之前未使用的码。" : "Could not create a code. Check your Owner session and that this is an ordinary, single-Team member. Retrying replaces any previous unused code.")}</p>}
    </section>
  );
}
