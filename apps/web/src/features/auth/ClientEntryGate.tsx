import { useEffect, useRef, useState } from "react";
import type { ClientEntryIdentity } from "@convene-wire/contracts/pairing-session";
import { jsonRequest } from "../../api-client.js";
import type { AuthenticatedUser, AuthMode } from "../../models.js";

export interface ClientEntrySession {
  user: AuthenticatedUser;
  mode: AuthMode;
  session: { expiresAt: string; token?: string };
  identity: ClientEntryIdentity;
}

/** null = ordinary navigation; empty string = present but invalid entry proof. */
export function clientEntryFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has("clientEntry")) return null;
  if (hash.length > 160 || [...params.keys()].length !== 1) return "";
  const ticket = params.get("clientEntry") ?? "";
  return /^[A-Za-z0-9_-]{43,128}$/u.test(ticket) ? ticket : "";
}

export function ClientEntryGate({ ticket, onEntered, onCancel }: {
  ticket: string; onEntered: (session: ClientEntrySession) => void; onCancel: () => void;
}) {
  const [identity, setIdentity] = useState<ClientEntryIdentity | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [zh, setZh] = useState(localStorage.getItem("agent-room.locale") !== "en");
  useEffect(() => {
    let stopped = false;
    setIdentity(null); setError(false);
    if (!ticket) { setError(true); return; }
    void jsonRequest<ClientEntryIdentity>("/api/auth/client-entry/preview", {
      method: "POST", body: JSON.stringify({ ticket })
    }).then((value) => { if (!stopped) setIdentity(value); }).catch(() => { if (!stopped) setError(true); });
    return () => { stopped = true; };
  }, [ticket]);

  async function enter() {
    if (!identity || submitting.current || error) return;
    submitting.current = true; setBusy(true);
    try {
      const result = await jsonRequest<ClientEntrySession>("/api/auth/client-entry/claim", {
        method: "POST", body: JSON.stringify({ ticket })
      });
      if (result.identity.teamId !== identity.teamId || result.identity.memberId !== identity.memberId ||
        result.identity.roomId !== identity.roomId || result.user.clientTeamId !== identity.teamId) {
        throw new Error("Client entry identity changed");
      }
      onEntered(result);
    } catch {
      // A consumed ticket is never automatically replayed after response loss.
      setError(true);
    } finally {
      submitting.current = false; setBusy(false);
    }
  }

  return <main className="access-shell client-entry-shell">
    <div className="access-toolbar"><button type="button" onClick={() => setZh(!zh)}>{zh ? "EN" : "中"}</button></div>
    <section className="access-card" aria-live="polite">
      <div className="brand-mark">CW</div><p className="eyebrow">{zh ? "从客户端进入协作" : "ENTER FROM YOUR CLIENT"}</p>
      <h1>{zh ? "确认你的成员身份" : "Confirm your member identity"}</h1>
      {identity && <><p className="client-entry-identity"><strong>{identity.displayName}</strong> · {identity.teamName}</p>
        <p>{identity.roomId ? `# ${identity.rooms.find((room) => room.roomId === identity.roomId)?.name ?? (zh ? "已授权房间" : "Authorized Room")}` : (zh ? "进入 Team 工作台" : "Open the Team workbench")}</p>
        <p>{zh ? "继续后，此浏览器将使用以上成员身份，仅进入这个 Team 的已授权房间。客户端入口不提供管理员权限。" : "Continue with this member identity in this browser, limited to authorized Rooms in this Team. Client entry does not grant administrator authority."}</p></>}
      {!identity && !error && <p>{zh ? "正在核对客户端授权…" : "Checking client authorization…"}</p>}
      {error && <p role="alert">{zh ? "入口已过期、已使用或授权已变化。请回到客户端重新点击进入；不会自动重复登录。" : "Entry expired, was used, or access changed. Return to the client and open a fresh entry; sign-in is never automatically replayed."}</p>}
      <button className="access-primary" type="button" disabled={!identity || busy || error} onClick={() => void enter()}>{busy ? (zh ? "正在进入…" : "Entering…") : (zh ? "确认并进入" : "Confirm and enter")}</button>
      <button className="secondary-action" type="button" disabled={busy} onClick={onCancel}>{zh ? "取消，保留原登录" : "Cancel; keep current sign-in"}</button>
    </section>
  </main>;
}
