import type { Locale } from "../../i18n.js";
import type { Agent } from "../../models.js";
import type { DiscussionComposerOptions } from "./composer-storage.js";

interface DiscussionComposerPolicyProps {
  agents: Agent[];
  disabled: boolean;
  locale: Locale;
  onChange: (value: DiscussionComposerOptions) => void;
  value: DiscussionComposerOptions;
}

function t(zh: string, en: string, locale: Locale): string {
  return locale === "zh-CN" ? zh : en;
}

function quorumCapable(agent: Agent): boolean {
  return agent.integrationMode === "managed" && Boolean(agent.deviceId) &&
    agent.runtimePolicy?.filesystemAccess === "read-only" &&
    agent.capabilities?.supportsDiscussionSupplementalEvidence === true;
}

export function DiscussionComposerPolicy({
  agents,
  disabled,
  locale,
  onChange,
  value
}: DiscussionComposerPolicyProps) {
  const ineligible = agents.filter((agent) => !quorumCapable(agent));
  const update = <K extends keyof DiscussionComposerOptions>(
    key: K,
    next: DiscussionComposerOptions[K]
  ) => onChange({ ...value, [key]: next });
  return <details className="discussion-composer-policy">
    <summary>{t("高级讨论策略", "Advanced Discussion policy", locale)}</summary>
    <p>{t("这些设置只绑定下一次 Discussion；Server 会重新验证参与者和边界。", "These settings bind only the next Discussion; the Server revalidates participants and limits.", locale)}</p>
    <div className="discussion-composer-policy-grid">
      <label>{t("参与者选择", "Participant selection", locale)}
        <select disabled={disabled} onChange={(event) => update("participantSelectionMode", event.target.value as DiscussionComposerOptions["participantSelectionMode"])} value={value.participantSelectionMode}>
          <option value="question_focused">{t("按问题聚焦", "Question focused", locale)}</option>
          <option value="all_eligible">{t("全部合格参与者", "All eligible", locale)}</option>
        </select>
      </label>
      <label>{t("聚焦参与上限", "Focused participant limit", locale)}
        <input disabled={disabled || value.participantSelectionMode !== "question_focused"} max={5} min={2} onChange={(event) => update("focusedParticipantLimit", Number(event.target.value))} type="number" value={value.focusedParticipantLimit} />
      </label>
      <label>{t("本轮完成规则", "Wave completion", locale)}
        <select disabled={disabled} onChange={(event) => update("waveCompletionMode", event.target.value as DiscussionComposerOptions["waveCompletionMode"])} value={value.waveCompletionMode}>
          <option value="all_settled">{t("等待全部结束", "Wait for all", locale)}</option>
          <option disabled={ineligible.length > 0} value="read_only_quorum">{t("只读 Quorum + 迟到证据", "Read-only quorum + late evidence", locale)}</option>
        </select>
      </label>
      {value.waveCompletionMode === "read_only_quorum" && <>
        <label>{t("最少完成数", "Minimum completed", locale)}
          <input disabled={disabled} max={agents.length} min={2} onChange={(event) => update("quorumMinimumCompleted", Number(event.target.value))} type="number" value={value.quorumMinimumCompleted} />
        </label>
        <label>{t("软截止（秒）", "Soft deadline (seconds)", locale)}
          <input disabled={disabled} max={299} min={1} onChange={(event) => update("quorumSoftDeadlineSeconds", Number(event.target.value))} type="number" value={value.quorumSoftDeadlineSeconds} />
        </label>
      </>}
    </div>
    <ul className="discussion-quorum-eligibility">{agents.map((agent) => <li className={quorumCapable(agent) ? "eligible" : "ineligible"} key={agent.agentId}><strong>{agent.name}</strong><span>{quorumCapable(agent)
      ? t("managed · 只读 · 支持迟到证据", "managed · read-only · late evidence capable", locale)
      : t("不满足 read-only quorum 条件", "not eligible for read-only quorum", locale)}</span></li>)}</ul>
    {ineligible.length > 0 && <p className="discussion-quorum-warning">{t("当前选择包含不合格 Agent，因此已禁止 read-only quorum。普通 all-settled 讨论仍可使用。", "The selection contains ineligible Agents, so read-only quorum is disabled. Ordinary all-settled Discussion remains available.", locale)}</p>}
  </details>;
}
