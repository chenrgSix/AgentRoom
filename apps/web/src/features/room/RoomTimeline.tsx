import { activeRunStates } from "../../api-client.js";
import {
  AgentRunActivity,
  diagnosticCategoryLabel,
  diagnosticGuidance,
  runStateLabel
} from "../run/RunActivity.js";
import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import { MarkdownMessage } from "../../MarkdownMessage.js";
import type {
  Agent,
  LocalSession,
  Member,
  Message,
  Run
} from "../../models.js";
import type { PendingRoomMessage } from "../../message-outbox.js";
import type {
  RunActivityProjection,
  RunOutputProjection
} from "../../room-sync.js";
import type { RunDiagnostic } from "../../run-diagnostics.js";

interface RoomTimelineProps {
  agentsById: Map<string, Agent>;
  composerBusy: boolean;
  locale: Locale;
  membersById: Map<string, Member>;
  messages: Message[];
  pendingMessages: PendingRoomMessage[];
  runActivities: Record<string, RunActivityProjection>;
  runDiagnostics: Record<string, RunDiagnostic | null>;
  runOutputs: Record<string, RunOutputProjection>;
  runs: Run[];
  runsById: Map<string, Run>;
  session: LocalSession | null;
  onCancelRun: (runId: string) => void | Promise<void>;
  onOpenWorkTask: (taskId: string, roomId: string) => void;
  onRetryPendingMessage: (message: PendingRoomMessage) => void | Promise<void>;
}

export function parseWorkTaskLink(
  href: string,
  origin: string
): { roomId: string; taskId: string } | null {
  try {
    const url = new URL(href, origin);
    const teamId = url.searchParams.get("team");
    const roomId = url.searchParams.get("room");
    const taskId = url.searchParams.get("workTask");
    if (
      url.origin === new URL(origin).origin &&
      teamId && /^team_[A-Za-z0-9_-]{8,128}$/u.test(teamId) &&
      roomId && /^room_[A-Za-z0-9_-]{8,128}$/u.test(roomId) &&
      taskId && /^task_[A-Za-z0-9_-]{8,128}$/u.test(taskId)
    ) return { roomId, taskId };
  } catch {
    // Untrusted links must never create a Work navigation intent.
  }
  return null;
}

export function RoomTimeline({
  agentsById,
  composerBusy,
  locale,
  membersById,
  messages,
  onCancelRun,
  onOpenWorkTask,
  onRetryPendingMessage,
  pendingMessages,
  runActivities,
  runDiagnostics,
  runOutputs,
  runs,
  runsById,
  session
}: RoomTimelineProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const navigateInternal = (href: string): void => {
    const target = parseWorkTaskLink(href, window.location.origin);
    if (target) onOpenWorkTask(target.taskId, target.roomId);
  };

  return (
    <section className="timeline" aria-label={t("roomMessages")}>
      {messages.map((message) => {
        const senderName = message.senderType === "agent"
          ? agentsById.get(message.senderId)?.name ?? t("agent")
          : message.senderType === "member"
            ? membersById.get(message.senderId)?.displayName ?? session?.displayName ?? ""
            : "ConveneWire";
        const avatarLabel = senderName.trim().slice(0, 1).toLocaleUpperCase(locale) || "A";
        const messageRuns = runs.filter(
          (run) => run.triggerMessageId === message.messageId
        );
        const sourceRun = message.senderType === "agent" && message.parentMessageId
          ? runs.find((run) =>
              run.triggerMessageId === message.parentMessageId &&
              run.targetAgentId === message.senderId
            )
          : undefined;

        return (
          <article className={`message ${message.senderType}-message`} key={message.messageId}>
            <span className={`avatar ${message.senderType}`}>{avatarLabel}</span>
            <div className="message-card">
              <header>
                <strong>{senderName}</strong>
                <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </header>
              <MarkdownMessage
                content={message.content}
                onInternalNavigate={navigateInternal}
              />
              {sourceRun && (
                <AgentRunActivity
                  active={false}
                  locale={locale}
                  projection={runActivities[sourceRun.runId]}
                />
              )}
              {(message.mentions.length > 0 || messageRuns.length > 0) && (
                <div className={`message-routing ${messageRuns.length > 0 ? "with-runs" : "mentions-only"}`}>
                  {messageRuns.length === 0 && message.mentions.map((mention) => (
                    <span className="mention-pill" key={mention.targetAgentId}>
                      @{mention.displayLabel}
                    </span>
                  ))}
                  {messageRuns.map((run) => (
                    <span
                      className={`run-card ${runDiagnostics[run.runId] ? "has-diagnostic" : ""}`}
                      key={run.runId}
                      title={run.runId}
                    >
                      <span className="run-card-agent">
                        <span aria-hidden="true" className={`run-dot ${run.state}`} />
                        <strong>{agentsById.get(run.targetAgentId)?.name ?? t("agent")}</strong>
                      </span>
                      <span className={`run-state ${run.state}`}>
                        {runStateLabel(run.state, locale)}
                      </span>
                      {activeRunStates.has(run.state) && (
                        <button type="button" onClick={() => void onCancelRun(run.runId)}>{t("cancel")}</button>
                      )}
                      {runDiagnostics[run.runId] && (
                        <span className="run-diagnostic" role="status">
                          <strong>
                            {diagnosticCategoryLabel(
                              runDiagnostics[run.runId]?.category ?? null,
                              locale
                            )}
                            {` · ${runDiagnostics[run.runId]?.code}`}
                            {runDiagnostics[run.runId]?.exitCode !== null &&
                              ` · ${locale === "zh-CN" ? "退出码" : "exit"} ${runDiagnostics[run.runId]?.exitCode}`}
                            {runDiagnostics[run.runId]?.retryable &&
                              ` · ${locale === "zh-CN" ? "可重试" : "retryable"}`}
                          </strong>
                          <small>
                            {diagnosticGuidance(
                              runDiagnostics[run.runId]?.category ?? null,
                              locale,
                              runDiagnostics[run.runId]?.code
                            )}
                          </small>
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </article>
        );
      })}
      {[...new Set([
        ...Object.keys(runOutputs),
        ...Object.keys(runActivities).filter((runId) => {
          const run = runsById.get(runId);
          return Boolean(run && activeRunStates.has(run.state));
        })
      ])].map((runId) => {
        const output = runOutputs[runId];
        const run = runsById.get(runId);
        if (!run) return null;
        const senderName = agentsById.get(run.targetAgentId)?.name ?? t("agent");
        const avatarLabel = senderName.trim().slice(0, 1)
          .toLocaleUpperCase(locale) || "A";
        return (
          <article className="message agent-message streaming-message" key={`stream-${runId}`}>
            <span className="avatar agent">{avatarLabel}</span>
            <div className="message-card">
              <header>
                <strong>{senderName}</strong>
                <span className="streaming-state" role="status">{t("generating")}</span>
              </header>
              <AgentRunActivity
                active
                locale={locale}
                projection={runActivities[runId]}
              />
              {output?.content && (
                <div className="streaming-content">
                  <MarkdownMessage content={output.content} streaming />
                  <span aria-hidden="true" className="streaming-cursor" />
                </div>
              )}
            </div>
          </article>
        );
      })}
      {pendingMessages.map((pending) => (
        <article className={`message member-message pending-message ${pending.status}`} key={pending.clientMessageId}>
          <span className="avatar member">
            {(session?.displayName ?? "M").slice(0, 1).toLocaleUpperCase(locale)}
          </span>
          <div className="message-card">
            <header>
              <strong>{session?.displayName}</strong>
              <span className={`pending-state ${pending.status}`}>
                {pending.status === "pending"
                  ? (locale === "zh-CN" ? "发送中…" : "Sending…")
                  : (locale === "zh-CN" ? "发送失败" : "Send failed")}
              </span>
            </header>
            <MarkdownMessage content={pending.content} />
            {pending.mentionAgentIds && pending.mentionAgentIds.length > 0 && (
              <div className="message-routing">
                {pending.mentionAgentIds.map((agentId) => (
                  <span className="mention-pill" key={agentId}>
                    @{agentsById.get(agentId)?.name ?? t("agent")}
                  </span>
                ))}
              </div>
            )}
            {pending.status === "failed" && (
              <button
                className="retry-message"
                disabled={composerBusy}
                onClick={() => void onRetryPendingMessage(pending)}
                type="button"
              >{locale === "zh-CN" ? "使用同一消息 ID 重试" : "Retry with the same Message ID"}</button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
