import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { BridgeJoinApproval } from "@agent-room/contracts/bridge-messages";

import { type Locale, type TranslationKey, translate } from "./i18n.js";
import { createSingleFlight, mergeRoomMessages } from "./room-sync.js";
import {
  loadRunDiagnostic,
  type RunDiagnostic,
  type RuntimeFailureCategory
} from "./run-diagnostics.js";
import {
  removeVisibleMentionToken,
  retainVisibleMentionIds
} from "./structured-mentions.js";

interface Team {
  teamId: string;
  name: string;
  createdAt: string;
}

interface Member {
  memberId: string;
  teamId: string;
  userId: string | null;
  displayName: string;
  role: "owner" | "member";
  createdAt: string;
}

interface Room {
  roomId: string;
  teamId: string;
  name: string;
  createdAt: string;
}

interface Agent {
  agentId: string;
  name: string;
  role: string;
  integrationMode: "managed" | "manual" | "fake";
  presence: string;
}

interface Message {
  messageId: string;
  roomId: string;
  sequence: number;
  senderType: "member" | "agent" | "system";
  senderId: string;
  content: string;
  mentions: Array<{
    targetType: "agent";
    targetAgentId: string;
    displayLabel: string;
  }>;
  createdAt: string;
}

interface RoomMessagePage {
  items: Message[];
  nextCursor: string | null;
  syncCursor?: string;
}

interface Device {
  deviceId: string;
  name: string;
  status: "active" | "revoked";
}

interface Run {
  runId: string;
  triggerMessageId: string;
  targetAgentId: string;
  state: "queued" | "delivered" | "working" | "input_required" | "completed" | "failed" | "canceled" | "expired" | "outcome_unknown";
  updatedAt: string;
}

type DiscussionState =
  | "active"
  | "stop_requested"
  | "waiting_human"
  | "awaiting_extension"
  | "paused"
  | "finalizing"
  | "completed"
  | "canceled"
  | "terminated";

interface DiscussionView {
  discussion: {
    discussionId: string;
    goal: string;
    state: DiscussionState;
    stateReason: string | null;
    currentTurn: number;
    currentWave: number;
    progress: {
      confidence: number | null;
      openQuestions: Array<{
        id: string;
        question: string;
        importance: "low" | "medium" | "high";
      }>;
      plateauCount: number;
    };
    budget: {
      turnsUsed: number;
      durationSeconds: number;
    };
  };
  participants: Array<{
    agentId: string;
    role: "participant" | "reviewer";
  }>;
  waves: Array<{
    waveId: string;
    ordinal: number;
    phase: "contribution" | "review" | "finalization";
    state: "open" | "completed" | "partial" | "failed" | "canceled";
    expectedMembers: number;
  }>;
  turns: Array<{
    turnId: string;
    kind: "discussion" | "finalization";
    speakerAgentId: string;
    runId: string | null;
    state: "planned" | "queued" | "working" | "completed" | "failed" | "canceled";
    waveId: string | null;
    waveMemberOrdinal: number | null;
    terminalReason: string | null;
  }>;
}

interface LocalSession {
  userId: string;
  displayName: string;
  token?: string;
}

type AuthMode = "local" | "trusted-team";
type AuthGateState =
  | "loading"
  | "local_bootstrap"
  | "setup_required"
  | "sign_in_required"
  | "claim_required"
  | "authenticated";

interface AuthenticatedUser {
  userId: string;
  displayName: string;
  createdAt?: string;
}

type AuthStatus = {
  mode: AuthMode;
  state: Exclude<AuthGateState, "loading" | "claim_required">;
  user?: AuthenticatedUser;
  session?: { expiresAt: string };
};

interface MemberInvitation {
  invitationId: string;
  teamId: string;
  displayName: string;
  expiresAt: string;
  claimUrl: string;
}

interface MentionSearch {
  end: number;
  query: string;
  start: number;
}

const userKey = "agent-room.local-user";
const localeKey = "agent-room.locale";
const themeKey = "agent-room.theme";

type WorkspaceView = "room" | "agents" | "members";
type ConnectionMode = "managed" | "mcp" | "demo";
type Theme = "dark" | "light";

function integrationLabel(mode: Agent["integrationMode"], locale: Locale): string {
  if (mode === "managed") return translate(locale, "managedBridge");
  if (mode === "manual") return translate(locale, "mcpParticipant");
  return translate(locale, "demoRuntime");
}

function presenceHelp(agent: Agent, locale: Locale): string {
  if (locale === "en") {
    if (agent.integrationMode === "fake") return "Simulation only; does not call a model";
    if (agent.presence === "ready") return "Ready to receive Team tasks";
    if (agent.presence === "busy") return "Working on a Team task";
    if (agent.presence === "degraded") return "Connected with limited capability";
    if (agent.presence === "manual") return "Pulls work through MCP when the client is active";
    return "Start its Bridge or MCP client to make it available";
  }
  if (agent.integrationMode === "fake") return "仅用于模拟，不会调用模型";
  if (agent.presence === "ready") return "已就绪，可以接收 Team 任务";
  if (agent.presence === "busy") return "正在执行 Team 任务";
  if (agent.presence === "degraded") return "已连接，但部分能力不可用";
  if (agent.presence === "manual") return "MCP 客户端运行时会主动拉取任务";
  return "请启动对应的 Bridge 或 MCP 客户端";
}

function presenceLabel(presence: string, locale: Locale): string {
  if (locale === "en") return presence.replace("_", " ");
  const labels: Record<string, string> = {
    active: "活跃",
    busy: "忙碌",
    degraded: "受限",
    manual: "手动",
    offline: "离线",
    ready: "就绪",
    revoked: "已撤销"
  };
  return labels[presence] ?? presence;
}

function runStateLabel(state: Run["state"], locale: Locale): string {
  if (locale === "en") return state.replace("_", " ");
  const labels: Record<Run["state"], string> = {
    canceled: "已取消",
    completed: "已完成",
    delivered: "已投递",
    expired: "已过期",
    failed: "失败",
    input_required: "等待输入",
    outcome_unknown: "结果未知",
    queued: "排队中",
    working: "执行中"
  };
  return labels[state];
}

function diagnosticCategoryLabel(
  category: RuntimeFailureCategory | null,
  locale: Locale
): string {
  if (!category) return locale === "zh-CN" ? "运行时" : "Runtime";
  if (locale === "en") return category.replace("_", " ");
  const labels: Record<RuntimeFailureCategory, string> = {
    start: "启动",
    authentication: "身份认证",
    rate_limit: "调用限流",
    network: "网络",
    model: "模型",
    configuration: "配置",
    unknown: "未知"
  };
  return labels[category];
}

function diagnosticGuidance(
  category: RuntimeFailureCategory | null,
  locale: Locale
): string {
  if (locale === "en") {
    const guidance: Record<RuntimeFailureCategory, string> = {
      start: "Open Bridge and verify the Runtime executable.",
      authentication: "Sign in to the Runtime or refresh its API credential.",
      rate_limit: "Wait briefly, then retry the task.",
      network: "Check this device's network and provider access.",
      model: "Check the configured model and provider availability.",
      configuration: "Open Bridge, review the Runtime preset, then run its self-test.",
      unknown: "Export Bridge diagnostics if the retry also fails."
    };
    return guidance[category ?? "unknown"];
  }
  const guidance: Record<RuntimeFailureCategory, string> = {
    start: "请打开 Bridge，检查运行时程序是否可执行。",
    authentication: "请在本机重新登录运行时，或更新对应凭证。",
    rate_limit: "请稍等片刻后重试任务。",
    network: "请检查这台设备的网络和模型服务连接。",
    model: "请检查所选模型及其服务是否可用。",
    configuration: "请打开 Bridge 检查运行时预设，然后执行自检。",
    unknown: "若重试仍失败，请从 Bridge 导出诊断信息。"
  };
  return guidance[category ?? "unknown"];
}

function discussionStateLabel(state: DiscussionState, locale: Locale): string {
  if (locale === "en") {
    return state.replaceAll("_", " ");
  }
  const labels: Record<DiscussionState, string> = {
    active: "讨论中",
    stop_requested: "将在本轮后停止",
    waiting_human: "等待你的决定",
    awaiting_extension: "等待继续讨论",
    paused: "已暂停",
    finalizing: "正在生成结论",
    completed: "已完成",
    canceled: "已立即停止",
    terminated: "已达到安全上限"
  };
  return labels[state];
}

type WaveMemberState = "queued" | "working" | "completed" | "failed" | "canceled";

type DiscussionWave = DiscussionView["waves"][number];

function waveMemberState(
  turn: DiscussionView["turns"][number],
  run: Run | undefined
): WaveMemberState {
  if (turn.state === "completed") return "completed";
  if (turn.state === "failed") return "failed";
  if (turn.state === "canceled") return "canceled";
  if (run) {
    if (run.state === "completed") return "completed";
    if (run.state === "canceled") return "canceled";
    if (["failed", "expired", "outcome_unknown"].includes(run.state)) {
      return "failed";
    }
    if (["working", "input_required"].includes(run.state)) return "working";
    return "queued";
  }
  if (turn.state === "working") return "working";
  return "queued";
}

function waveMemberStateLabel(state: WaveMemberState, locale: Locale): string {
  if (locale === "en") {
    const labels: Record<WaveMemberState, string> = {
      canceled: "Canceled",
      completed: "Completed",
      failed: "Failed",
      queued: "Queued",
      working: "Working"
    };
    return labels[state];
  }
  const labels: Record<WaveMemberState, string> = {
    canceled: "已取消",
    completed: "已完成",
    failed: "失败",
    queued: "排队中",
    working: "执行中"
  };
  return labels[state];
}

function waveStateLabel(state: DiscussionWave["state"], locale: Locale): string {
  if (locale === "en") {
    const labels: Record<DiscussionWave["state"], string> = {
      canceled: "Canceled",
      completed: "Completed",
      failed: "Failed",
      open: "In progress",
      partial: "Partially completed"
    };
    return labels[state];
  }
  const labels: Record<DiscussionWave["state"], string> = {
    canceled: "已取消",
    completed: "已完成",
    failed: "失败",
    open: "进行中",
    partial: "部分完成"
  };
  return labels[state];
}

function wavePhaseLabel(phase: DiscussionWave["phase"], locale: Locale): string {
  if (locale === "en") {
    return phase === "finalization"
      ? "Conclusion generation"
      : phase === "review" ? "Parallel review" : "Parallel contribution";
  }
  return phase === "finalization"
    ? "结论生成"
    : phase === "review" ? "并行复核" : "并行讨论";
}

function terminalReasonLabel(reason: string, locale: Locale): string {
  const normalized = reason.replaceAll("_", " ");
  if (locale === "en") {
    const labels: Record<string, string> = {
      completed_without_reply: "Completed without a reply",
      agent_unavailable: "Agent unavailable",
      discussion_canceled_before_dispatch: "Discussion canceled before dispatch",
      input_required: "Human input required",
      late_duplicate: "Late duplicate result",
      run_canceled: "Run canceled",
      run_expired: "Run expired",
      run_failed: "Run failed",
      run_outcome_unknown: "Run outcome unknown",
      runtime_failure: "Runtime failure"
    };
    return labels[reason] ?? normalized;
  }
  const labels: Record<string, string> = {
    completed_without_reply: "已结束但没有返回回复",
    agent_unavailable: "智能体不可用",
    discussion_canceled_before_dispatch: "投递前讨论已取消",
    input_required: "需要人工输入",
    late_duplicate: "收到重复的迟到结果",
    run_canceled: "执行已取消",
    run_expired: "执行已过期",
    run_failed: "执行失败",
    run_outcome_unknown: "执行结果未知",
    runtime_failure: "运行时失败"
  };
  return labels[reason] ?? reason;
}

function roleLabel(role: string, locale: Locale): string {
  if (locale === "en") return role;
  const labels: Record<string, string> = {
    "Codex implementer": "Codex 执行者",
    "MCP participant": "MCP 参与者",
    Teammate: "Team 成员"
  };
  return labels[role] ?? role;
}

function errorLabel(error: string, locale: Locale): string {
  if (locale === "en") return error;
  if (error.includes("Failed to fetch")) return "无法连接到主服务，请检查服务是否正在运行。";
  if (error.includes("Unexpected end of JSON input")) return "主服务返回了无效响应，请稍后重试。";
  const requestFailure = /Request failed \((\d+)\)/u.exec(error);
  if (requestFailure) return `请求失败（HTTP ${requestFailure[1]}）`;
  return `操作失败：${error}`;
}

function bridgeServerURL(): string {
  const configured = import.meta.env?.VITE_AGENT_ROOM_SERVER_URL?.trim();
  if (configured) return configured.replace(/\/$/u, "");
  if (window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  return window.location.origin;
}

async function jsonRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json() as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  }
  return body;
}

async function localBootstrap(): Promise<LocalSession> {
  const saved = localStorage.getItem(userKey);
  const existing = saved
    ? JSON.parse(saved) as { userId: string; displayName: string }
    : null;
  const displayName = existing?.displayName ?? "Local Owner";
  const result = await jsonRequest<{
    user: { userId: string; displayName: string };
    session: { token: string };
  }>("/api/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      displayName,
      ...(existing ? { userId: existing.userId } : {})
    })
  });
  localStorage.setItem(userKey, JSON.stringify(result.user));
  return {
    userId: result.user.userId,
    displayName: result.user.displayName,
    token: result.session.token
  };
}

function invitationTokenFromFragment(fragment: string): string | null {
  const match = /^#\/join\/([A-Za-z0-9_-]{16,256})$/u.exec(fragment);
  return match?.[1] ?? null;
}

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

function AccessGate({
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
        <div className="brand-mark" aria-label="Agent Room">AR</div>
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

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(themeKey) === "light" ? "light" : "dark"
  );
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem(localeKey) === "en" ? "en" : "zh-CN"
  );
  const [session, setSession] = useState<LocalSession | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [authState, setAuthState] = useState<AuthGateState>("loading");
  const [pendingInvitationToken, setPendingInvitationToken] = useState<string | null>(() =>
    invitationTokenFromFragment(window.location.hash)
  );
  const [teams, setTeams] = useState<Team[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runDiagnostics, setRunDiagnostics] = useState<
    Record<string, RunDiagnostic | null>
  >({});
  const [discussions, setDiscussions] = useState<DiscussionView[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("room");
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("managed");
  const [teamName, setTeamName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [manualAgentName, setManualAgentName] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [setupOutput, setSetupOutput] = useState<string | null>(null);
  const [memberInviteName, setMemberInviteName] = useState("");
  const [memberInvitation, setMemberInvitation] = useState<MemberInvitation | null>(null);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [messageContent, setMessageContent] = useState("");
  const [discussionGoalEditId, setDiscussionGoalEditId] = useState<string | null>(null);
  const [discussionGoalDraft, setDiscussionGoalDraft] = useState("");
  const [mentionAgentIds, setMentionAgentIds] = useState<string[]>([]);
  const [mentionSearch, setMentionSearch] = useState<MentionSearch | null>(null);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageSyncRef = useRef<{
    roomId: string;
    cursor: string | null;
    sequence: number;
  } | null>(null);
  const diagnosticRequestsRef = useRef(new Set<string>());

  const selectedTeam = useMemo(
    () => teams.find((team) => team.teamId === selectedTeamId) ?? null,
    [selectedTeamId, teams]
  );
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.roomId === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents]
  );
  const membersById = useMemo(
    () => new Map(members.map((member) => [member.memberId, member])),
    [members]
  );
  const runsById = useMemo(
    () => new Map(runs.map((run) => [run.runId, run])),
    [runs]
  );
  const mentionOptions = useMemo(() => {
    if (!mentionSearch) return [];
    const query = mentionSearch.query.toLocaleLowerCase(locale);
    return agents.filter((agent) =>
      !mentionAgentIds.includes(agent.agentId) && (
        agent.name.toLocaleLowerCase(locale).includes(query) ||
        roleLabel(agent.role, locale).toLocaleLowerCase(locale).includes(query)
      )
    ).slice(0, 8);
  }, [agents, locale, mentionAgentIds, mentionSearch]);
  const selectedMentionAgents = mentionAgentIds.flatMap((agentId) => {
    const agent = agentsById.get(agentId);
    return agent ? [agent] : [];
  });
  const readyAgents = agents.filter((agent) => agent.presence === "ready").length;
  const managedAgents = agents.filter((agent) => agent.integrationMode === "managed").length;
  const activeDevices = devices.filter((device) => device.status === "active").length;
  const currentMember = members.find((member) => member.userId === session?.userId) ?? null;
  const t = (key: TranslationKey) => translate(locale, key);
  const activeDiscussion = [...discussions].reverse().find(({ discussion }) =>
    !["completed", "canceled", "terminated"].includes(discussion.state)
  ) ?? null;
  const visibleDiscussion = activeDiscussion ?? discussions.at(-1) ?? null;
  const activeWave = visibleDiscussion?.waves.find(({ ordinal, state }) =>
    state === "open" && ordinal === visibleDiscussion.discussion.currentWave
  ) ?? visibleDiscussion?.waves.findLast(({ state }) => state === "open")
    ?? visibleDiscussion?.waves.findLast(({ ordinal }) =>
      ordinal === visibleDiscussion.discussion.currentWave
    )
    ?? visibleDiscussion?.waves.at(-1)
    ?? null;
  const activeWaveMembers = visibleDiscussion && activeWave
    ? visibleDiscussion.turns
      .filter(({ waveId }) => waveId === activeWave.waveId)
      .sort((left, right) =>
        (left.waveMemberOrdinal ?? Number.MAX_SAFE_INTEGER) -
        (right.waveMemberOrdinal ?? Number.MAX_SAFE_INTEGER)
      )
      .map((turn) => ({
        agent: agentsById.get(turn.speakerAgentId),
        state: waveMemberState(turn, turn.runId ? runsById.get(turn.runId) : undefined),
        turn
      }))
    : [];
  const activeWaveExpectedMembers = activeWave
    ? Math.max(activeWave.expectedMembers, activeWaveMembers.length)
    : 0;
  const activeWaveEndedMembers = activeWaveMembers.filter(({ state }) =>
    state === "completed" || state === "failed" || state === "canceled"
  ).length;
  const activeDiscussionWaveNumber = visibleDiscussion && activeWave && activeWave.phase !== "finalization"
    ? activeWave.ordinal || visibleDiscussion.waves.filter(({ ordinal, phase }) =>
      phase !== "finalization" && ordinal <= activeWave.ordinal
    ).length
    : 0;

  useEffect(() => {
    localStorage.setItem(localeKey, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    localStorage.setItem(themeKey, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useLayoutEffect(() => {
    if (!pendingInvitationToken) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`
    );
  }, []);

  useEffect(() => {
    setMentionAgentIds((current) => {
      const retained = current.filter((agentId) =>
        agents.some((agent) => agent.agentId === agentId)
      );
      return retained.length === current.length ? current : retained;
    });
  }, [agents]);

  async function loadTeams(activeSession: LocalSession) {
    const next = await jsonRequest<Team[]>("/api/teams", {}, activeSession.token);
    setTeams(next);
    setSelectedTeamId((current) => current ?? next[0]?.teamId ?? null);
  }

  async function activateSession(
    user: AuthenticatedUser,
    mode: AuthMode,
    token?: string
  ) {
    const next: LocalSession = {
      userId: user.userId,
      displayName: user.displayName,
      ...(token ? { token } : {})
    };
    setAuthMode(mode);
    setSession(next);
    setAuthState("authenticated");
    await loadTeams(next);
  }

  async function enterLocalSession() {
    setBusy(true);
    setError(null);
    try {
      const next = await localBootstrap();
      setAuthMode("local");
      setSession(next);
      setAuthState("authenticated");
      await loadTeams(next);
    } catch (reason) {
      setAuthState("local_bootstrap");
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function setupOwner(displayName: string, recoveryToken: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await jsonRequest<{
        user: AuthenticatedUser;
        session: { expiresAt: string };
      }>("/api/auth/setup", {
        method: "POST",
        headers: { "x-agent-room-recovery-token": recoveryToken },
        body: JSON.stringify({ displayName })
      });
      await activateSession(result.user, "trusted-team");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function recoverOwner(recoveryToken: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await jsonRequest<{
        user: AuthenticatedUser;
        session: { expiresAt: string };
      }>("/api/auth/recover-owner", {
        method: "POST",
        headers: { "x-agent-room-recovery-token": recoveryToken }
      });
      await activateSession(result.user, "trusted-team");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function claimInvitation() {
    if (!pendingInvitationToken) return;
    setBusy(true);
    setError(null);
    try {
      const result = await jsonRequest<{
        user: AuthenticatedUser;
        member: Member;
        session: { expiresAt: string };
      }>("/api/auth/member-invitations/claim", {
        method: "POST",
        body: JSON.stringify({ token: pendingInvitationToken })
      });
      setPendingInvitationToken(null);
      await activateSession(result.user, "trusted-team");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    void jsonRequest<AuthStatus>("/api/auth/status")
      .then(async (status) => {
        if (stopped) return;
        setAuthMode(status.mode);
        if (pendingInvitationToken && status.mode === "trusted-team") {
          setAuthState("claim_required");
          return;
        }
        if (pendingInvitationToken) setPendingInvitationToken(null);
        if (status.state === "authenticated") {
          if (!status.user) throw new Error("Authenticated status is missing its User");
          await activateSession(status.user, status.mode);
          return;
        }
        if (status.state === "local_bootstrap") {
          setAuthState("local_bootstrap");
          await enterLocalSession();
          return;
        }
        setAuthState(status.state);
      })
      .catch((reason: unknown) => {
        if (!stopped) setError(String(reason));
      });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!session || !selectedTeamId) {
      setRooms([]);
      setMembers([]);
      setAgents([]);
      return;
    }
    setError(null);
    void Promise.all([
      jsonRequest<Room[]>(
        `/api/teams/${selectedTeamId}/rooms`,
        {},
        session.token
      ),
      jsonRequest<Agent[]>(
        `/api/teams/${selectedTeamId}/agents`,
        {},
        session.token
      ),
      jsonRequest<Member[]>(
        `/api/teams/${selectedTeamId}/members`,
        {},
        session.token
      ),
      jsonRequest<Device[]>(
        `/api/teams/${selectedTeamId}/devices`,
        {},
        session.token
      )
    ]).then(([nextRooms, nextAgents, nextMembers, nextDevices]) => {
      setRooms(nextRooms);
      setAgents(nextAgents);
      setMembers(nextMembers);
      setDevices(nextDevices);
      setMentionAgentIds((current) => current.filter((agentId) =>
        nextAgents.some((agent) => agent.agentId === agentId)
      ));
      setSelectedRoomId((current) =>
        nextRooms.some((room) => room.roomId === current)
          ? current
          : nextRooms[0]?.roomId ?? null
      );
    }).catch((reason: unknown) => setError(String(reason)));
  }, [selectedTeamId, session]);

  useEffect(() => {
    if (!session || !selectedRoomId) {
      setMessages([]);
      setRuns([]);
      setRunDiagnostics({});
      diagnosticRequestsRef.current.clear();
      setDiscussions([]);
      messageSyncRef.current = null;
      return;
    }
    let stopped = false;
    messageSyncRef.current = {
      roomId: selectedRoomId,
      cursor: null,
      sequence: 0
    };
    setMessages([]);
    setRunDiagnostics({});
    diagnosticRequestsRef.current.clear();
    void Promise.all([
      jsonRequest<RoomMessagePage>(
        `/api/rooms/${selectedRoomId}/messages?limit=100&tail=true`,
        {},
        session.token
      ),
      jsonRequest<Run[]>(
        `/api/rooms/${selectedRoomId}/runs`,
        {},
        session.token
      ),
      jsonRequest<DiscussionView[]>(
        `/api/rooms/${selectedRoomId}/discussions`,
        {},
        session.token
      )
    ]).then(([page, nextRuns, nextDiscussions]) => {
      if (stopped) return;
      setMessages(page.items);
      messageSyncRef.current = {
        roomId: selectedRoomId,
        cursor: page.syncCursor ?? null,
        sequence: page.items.at(-1)?.sequence ?? 0
      };
      setRuns(nextRuns);
      setDiscussions(nextDiscussions);
    })
      .catch((reason: unknown) => {
        if (!stopped) setError(String(reason));
      });
    return () => {
      stopped = true;
    };
  }, [selectedRoomId, session]);

  useEffect(() => {
    if (!session || !selectedTeamId || !selectedRoomId) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const sync = messageSyncRef.current?.roomId === selectedRoomId
          ? messageSyncRef.current
          : null;
        let cursor = sync?.cursor ?? null;
        let sequence = sync?.sequence ?? 0;
        const changedMessages: Message[] = [];
        for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
          const messagePath = cursor
            ? `/api/rooms/${selectedRoomId}/messages?limit=100&cursor=${encodeURIComponent(cursor)}`
            : `/api/rooms/${selectedRoomId}/messages?limit=100&tail=true`;
          const page = await jsonRequest<RoomMessagePage>(
            messagePath, {}, session.token
          );
          changedMessages.push(...page.items);
          sequence = Math.max(sequence, page.items.at(-1)?.sequence ?? sequence);
          cursor = page.nextCursor ?? page.syncCursor ?? cursor;
          if (!page.nextCursor) break;
        }
        const [
          nextAgents,
          nextMembers,
          nextDevices,
          nextRuns,
          nextDiscussions
        ] = await Promise.all([
          jsonRequest<Agent[]>(
            `/api/teams/${selectedTeamId}/agents`, {}, session.token
          ),
          jsonRequest<Member[]>(
            `/api/teams/${selectedTeamId}/members`, {}, session.token
          ),
          jsonRequest<Device[]>(
            `/api/teams/${selectedTeamId}/devices`, {}, session.token
          ),
          jsonRequest<Run[]>(
            `/api/rooms/${selectedRoomId}/runs`, {}, session.token
          ),
          jsonRequest<DiscussionView[]>(
            `/api/rooms/${selectedRoomId}/discussions`, {}, session.token
          )
        ]);
        if (!stopped) {
          setAgents(nextAgents);
          setMembers(nextMembers);
          setDevices(nextDevices);
          setMessages((current) => mergeRoomMessages(current, changedMessages));
          const currentSync = messageSyncRef.current;
          if (
            !currentSync ||
            currentSync.roomId !== selectedRoomId ||
            sequence >= currentSync.sequence
          ) {
            messageSyncRef.current = {
              roomId: selectedRoomId,
              cursor,
              sequence
            };
          }
          setRuns(nextRuns);
          setDiscussions(nextDiscussions);
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
    };
    const refreshSingleFlight = createSingleFlight(refresh);
    const timer = window.setInterval(() => void refreshSingleFlight(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [selectedRoomId, selectedTeamId, session]);

  useEffect(() => {
    if (!session || !selectedRoomId) return;
    const failedRuns = runs.filter(({ state }) =>
      ["failed", "expired", "outcome_unknown"].includes(state)
    );
    for (const run of failedRuns) {
      if (diagnosticRequestsRef.current.has(run.runId)) continue;
      diagnosticRequestsRef.current.add(run.runId);
      void loadRunDiagnostic(
        run.runId,
        (path) => jsonRequest(path, {}, session.token)
      ).then((diagnostic) => {
        if (messageSyncRef.current?.roomId === selectedRoomId) {
          setRunDiagnostics((current) => ({
            ...current,
            [run.runId]: diagnostic
          }));
        }
      }).catch((reason: unknown) => {
        diagnosticRequestsRef.current.delete(run.runId);
        if (messageSyncRef.current?.roomId === selectedRoomId) {
          setError(String(reason));
        }
      });
    }
  }, [runs, selectedRoomId, session]);

  async function createTeam(event: FormEvent) {
    event.preventDefault();
    if (!session || !teamName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await jsonRequest<{ team: Team }>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: teamName })
      }, session.token);
      setTeamName("");
      await loadTeams(session);
      setSelectedTeamId(created.team.teamId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !roomName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const room = await jsonRequest<Room>(
        `/api/teams/${selectedTeamId}/rooms`,
        { method: "POST", body: JSON.stringify({ name: roomName }) },
        session.token
      );
      setRoomName("");
      setRooms((current) => [...current, room]);
      setSelectedRoomId(room.roomId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createMemberInvitation(event: FormEvent) {
    event.preventDefault();
    if (
      !session ||
      !selectedTeamId ||
      authMode !== "trusted-team" ||
      currentMember?.role !== "owner" ||
      !memberInviteName.trim()
    ) return;
    setBusy(true);
    setError(null);
    try {
      const invitation = await jsonRequest<MemberInvitation>(
        `/api/teams/${selectedTeamId}/member-invitations`,
        {
          method: "POST",
          body: JSON.stringify({ displayName: memberInviteName.trim() })
        },
        session.token
      );
      setMemberInviteName("");
      setMemberInvitation(invitation);
      setInvitationCopied(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copyMemberInvitation() {
    if (!memberInvitation) return;
    try {
      await navigator.clipboard.writeText(memberInvitation.claimUrl);
      setInvitationCopied(true);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function signOut() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await jsonRequest<{ status: "signed_out" }>(
        "/api/auth/session",
        { method: "DELETE" },
        session.token
      );
      setSession(null);
      setTeams([]);
      setRooms([]);
      setMembers([]);
      setAgents([]);
      setDevices([]);
      setMessages([]);
      setRuns([]);
      setDiscussions([]);
      setSelectedTeamId(null);
      setSelectedRoomId(null);
      setMemberInvitation(null);
      setAuthState(authMode === "local" ? "local_bootstrap" : "sign_in_required");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createFakeAgent(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !agentName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await jsonRequest<Agent>(
        `/api/teams/${selectedTeamId}/fake-agents`,
        {
          method: "POST",
          body: JSON.stringify({ name: agentName, role: "Teammate" })
        },
        session.token
      );
      setAgentName("");
      setAgents((current) => [...current, agent]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createManualAgent(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !manualAgentName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await jsonRequest<{
        agent: Agent;
        credential: { token: string };
      }>(`/api/teams/${selectedTeamId}/manual-agents`, {
        method: "POST",
        body: JSON.stringify({ name: manualAgentName, role: "MCP participant" })
      }, session.token);
      setAgents((current) => [...current, result.agent]);
      setManualAgentName("");
      setSetupOutput([
        `export AGENT_ROOM_MCP_TOKEN='${result.credential.token}'`,
        `codex mcp add agent-room --url ${window.location.origin}/mcp --bearer-token-env-var AGENT_ROOM_MCP_TOKEN`
      ].join("\n"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createBridgeInvite(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !deviceName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const invite = await jsonRequest<{
        code: string;
        deviceName: string;
        expiresAt: string;
      }>(`/api/teams/${selectedTeamId}/bridge-invites`, {
        method: "POST",
        body: JSON.stringify({ deviceName })
      }, session.token);
      setDeviceName("");
      setSetupOutput([
        locale === "zh-CN"
          ? `# 配对码将在 ${invite.expiresAt} 过期`
          : `# Pairing code expires at ${invite.expiresAt}`,
        `agentroom-bridge pair --config bridge.json --code '${invite.code}'`
      ].join("\n"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function approveBridgeJoin(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !joinCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const approved = await jsonRequest<BridgeJoinApproval>(
        `/api/teams/${selectedTeamId}/bridge-join-requests/approve`,
        {
          method: "POST",
          body: JSON.stringify({ code: joinCode })
        },
        session.token
      );
      setJoinCode("");
      setSetupOutput(
        locale === "zh-CN"
          ? `已批准 ${approved.deviceName} 上的 ${approved.agentName}。客户端将自动完成注册并上线。`
          : `Approved ${approved.agentName} on ${approved.deviceName}. ` +
            "The client will finish registration and come online automatically."
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function revokeDevice(device: Device) {
    if (!session || !selectedTeamId || device.status !== "active") return;
    setError(null);
    try {
      const revoked = await jsonRequest<Device>(
        `/api/teams/${selectedTeamId}/devices/${device.deviceId}`,
        { method: "DELETE" },
        session.token
      );
      setDevices((current) => current.map((item) =>
        item.deviceId === revoked.deviceId ? revoked : item
      ));
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function refreshRoomState() {
    if (!session || !selectedRoomId) return;
    const [page, nextRuns, nextDiscussions] = await Promise.all([
      jsonRequest<RoomMessagePage>(
        `/api/rooms/${selectedRoomId}/messages?limit=100&tail=true`, {}, session.token
      ),
      jsonRequest<Run[]>(
        `/api/rooms/${selectedRoomId}/runs`, {}, session.token
      ),
      jsonRequest<DiscussionView[]>(
        `/api/rooms/${selectedRoomId}/discussions`, {}, session.token
      )
    ]);
    setMessages((current) => mergeRoomMessages(current, page.items));
    const sequence = page.items.at(-1)?.sequence ?? 0;
    const currentSync = messageSyncRef.current;
    if (
      !currentSync ||
      currentSync.roomId !== selectedRoomId ||
      sequence >= currentSync.sequence
    ) {
      messageSyncRef.current = {
        roomId: selectedRoomId,
        cursor: page.syncCursor ?? currentSync?.cursor ?? null,
        sequence
      };
    }
    setRuns(nextRuns);
    setDiscussions(nextDiscussions);
  }

  async function submitComposer(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedRoomId || !messageContent.trim()) return;
    if (mentionAgentIds.length >= 2 && activeDiscussion) {
      setError(locale === "zh-CN"
        ? "当前房间已有协作讨论，请先结束或停止后再发起新的协作。"
        : "This Room already has an active Discussion. Finish or stop it before starting another.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mentionAgentIds.length >= 2) {
        await jsonRequest<DiscussionView>(
          `/api/rooms/${selectedRoomId}/discussions`,
          {
            method: "POST",
            body: JSON.stringify({
              goal: messageContent,
              participantAgentIds: mentionAgentIds,
              mode: "round_robin",
              outputMode: "final_answer"
            })
          },
          session.token
        );
      } else {
        await jsonRequest<{ message: Message; runs: Run[] }>(
          `/api/rooms/${selectedRoomId}/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              content: messageContent,
              ...(mentionAgentIds[0] ? { mentionAgentId: mentionAgentIds[0] } : {})
            })
          },
          session.token
        );
      }
      setMessageContent("");
      setMentionAgentIds([]);
      setMentionSearch(null);
      await refreshRoomState();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function controlDiscussion(
    discussionId: string,
    action: "finish" | "stop_after_turn" | "pause" | "cancel" | "continue"
  ) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await jsonRequest<DiscussionView>(
        `/api/discussions/${discussionId}/actions`,
        { method: "POST", body: JSON.stringify({ action }) },
        session.token
      );
      await refreshRoomState();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function editDiscussionGoal(view: DiscussionView) {
    setDiscussionGoalEditId(view.discussion.discussionId);
    setDiscussionGoalDraft(view.discussion.goal);
  }

  function cancelDiscussionGoalEdit() {
    setDiscussionGoalEditId(null);
    setDiscussionGoalDraft("");
  }

  async function saveDiscussionGoal() {
    if (!session || !discussionGoalEditId || !discussionGoalDraft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jsonRequest<DiscussionView>(
        `/api/discussions/${discussionGoalEditId}/actions`,
        {
          method: "POST",
          body: JSON.stringify({ action: "adjust_goal", goal: discussionGoalDraft })
        },
        session.token
      );
      cancelDiscussionGoalEdit();
      await refreshRoomState();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function handleMessageChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const nextContent = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart ?? nextContent.length;
    const beforeCursor = nextContent.slice(0, cursor);
    const match = /(?:^|\s)@([^@\s]*)$/u.exec(beforeCursor);

    setMessageContent(nextContent);
    setMentionAgentIds((current) =>
      retainVisibleMentionIds(nextContent, current, agentsById)
    );
    if (match) {
      setMentionSearch({
        end: cursor,
        query: match[1] ?? "",
        start: beforeCursor.lastIndexOf("@")
      });
      setMentionOptionIndex(0);
    } else {
      setMentionSearch(null);
    }
  }

  function selectMention(agent: Agent) {
    if (!mentionSearch) return;
    if (mentionAgentIds.length >= 5) {
      setError(locale === "zh-CN"
        ? "一次协作最多可以提及 5 个智能体。"
        : "A collaboration can mention at most 5 Agents.");
      setMentionSearch(null);
      return;
    }
    const nextContent = [
      messageContent.slice(0, mentionSearch.start),
      `@${agent.name} `,
      messageContent.slice(mentionSearch.end)
    ].join("");
    setMessageContent(nextContent);
    setMentionAgentIds((current) => current.includes(agent.agentId)
      ? current
      : [...current, agent.agentId]
    );
    setError(null);
    setMentionSearch(null);
    setMentionOptionIndex(0);
  }

  function removeMention(agent: Agent) {
    setMessageContent((current) => removeVisibleMentionToken(current, agent.name));
    setMentionAgentIds((current) => current.filter((agentId) => agentId !== agent.agentId));
    setMentionSearch(null);
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionSearch) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionSearch(null);
      return;
    }
    if (mentionOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionOptionIndex((current) => (current + 1) % mentionOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionOptionIndex((current) =>
        (current - 1 + mentionOptions.length) % mentionOptions.length
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectMention(mentionOptions[mentionOptionIndex] ?? mentionOptions[0]!);
    }
  }

  async function cancelRun(runId: string) {
    if (!session) return;
    setError(null);
    try {
      const updated = await jsonRequest<Run>(`/api/runs/${runId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Canceled from Team Room" })
      }, session.token);
      setRuns((current) => current.map((run) =>
        run.runId === updated.runId ? updated : run
      ));
    } catch (reason) {
      setError(String(reason));
    }
  }

  function revealConnectionSetup() {
    setConnectionMode("managed");
    setActiveView("agents");
  }

  function revealTeamMembers() {
    setMemberInvitation(null);
    setInvitationCopied(false);
    setActiveView("members");
  }

  if (authState !== "authenticated") {
    return (
      <AccessGate
        busy={busy}
        error={error}
        locale={locale}
        onClaimInvitation={claimInvitation}
        onEnterLocal={enterLocalSession}
        onRecoverOwner={recoverOwner}
        onSetupOwner={setupOwner}
        onToggleLocale={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")}
        onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
        state={authState}
        theme={theme}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="team-rail" aria-label={t("teamSpace")}>
        <div className="brand-mark" aria-label="Agent Room">AR</div>
        <div className="team-list">
          {teams.map((team) => (
            <button
              className={team.teamId === selectedTeamId ? "team-chip active" : "team-chip"}
              key={team.teamId}
              onClick={() => setSelectedTeamId(team.teamId)}
              title={team.name}
            >
              {team.name.slice(0, 2).toUpperCase()}
            </button>
          ))}
        </div>
        {selectedTeam && (
          <div className="rail-actions">
            <button
              aria-label={t("teamMembers")}
              className={activeView === "members" ? "rail-manage active" : "rail-manage"}
              onClick={revealTeamMembers}
              title={t("teamMembers")}
              type="button"
            >♙</button>
            <button
              aria-label={t("agentManagement")}
              className={activeView === "agents" ? "rail-manage active" : "rail-manage"}
              onClick={revealConnectionSetup}
              title={t("agentManagement")}
              type="button"
            >✦</button>
          </div>
        )}
      </aside>

      <aside className="room-sidebar">
        <header>
          <p className="eyebrow">{t("teamSpace")}</p>
          <h1>{selectedTeam?.name ?? "Agent Room"}</h1>
        </header>
        {selectedTeam && selectedRoom && (
          <section className="participant-panel" aria-label={t("roomParticipants")}>
            <div className="participant-heading">
              <div><strong>{t("roomParticipants")}</strong><small>#{selectedRoom.name}</small></div>
              <span>{members.length + agents.length}</span>
            </div>
            <div className="participant-list">
              {members.length === 0 && agents.length === 0 ? (
                <p>{t("noParticipants")}</p>
              ) : (
                <>
                  {members.map((member) => (
                    <article className="participant-row" key={member.memberId}>
                      <span className="participant-avatar human">{member.displayName.slice(0, 1).toUpperCase()}</span>
                      <div><strong>{member.displayName}</strong><small>{member.role === "owner" ? t("teamOwner") : t("teamMember")}</small></div>
                      <span className="participant-kind">{locale === "zh-CN" ? "成员" : "Human"}</span>
                    </article>
                  ))}
                  {agents.map((agent) => (
                    <article className="participant-row" key={agent.agentId}>
                      <span className="participant-avatar agent">{agent.name.slice(0, 1).toUpperCase()}</span>
                      <div><strong>{agent.name}</strong><small>{roleLabel(agent.role, locale)}</small></div>
                      <span className={`presence-dot ${agent.presence}`} title={presenceLabel(agent.presence, locale)} />
                    </article>
                  ))}
                </>
              )}
            </div>
          </section>
        )}
      </aside>

      <main className="workspace">
        <nav className="mobile-nav" aria-label={t("workspace")}>
          <strong>{selectedTeam?.name ?? "Agent Room"}</strong>
          <div>
            {selectedTeam && (
              <>
                <button className={activeView === "room" ? "active" : ""} onClick={() => setActiveView("room")} type="button">{t("chat")}</button>
                <button className={activeView === "members" ? "active" : ""} onClick={revealTeamMembers} type="button">{t("teamMembers")}</button>
                <button className={activeView === "agents" ? "active" : ""} onClick={() => setActiveView("agents")} type="button">{t("agents")}</button>
              </>
            )}
            <button aria-label={locale === "zh-CN" ? "移动端界面语言" : "Mobile interface language"} onClick={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")} type="button">{locale === "zh-CN" ? "EN" : "中"}</button>
            <button
              aria-label={locale === "zh-CN" ? "移动端主题" : "Mobile theme"}
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              title={theme === "dark" ? t("switchToLight") : t("switchToDark")}
              type="button"
            >{theme === "dark" ? "☀" : "☾"}</button>
            <button className="mobile-sign-out" disabled={busy} onClick={() => void signOut()} type="button">{t("signOut")}</button>
          </div>
        </nav>
        <header className="workspace-header">
          <div>
            <p className="eyebrow">
              {activeView === "agents" && selectedTeam
                ? t("controlPlane")
                : activeView === "members" && selectedTeam ? t("teamAccess") : t("room")}
            </p>
            <h2>
              {activeView === "agents" && selectedTeam
                ? t("agentsDevices")
                : activeView === "members" && selectedTeam
                  ? t("teamMembers")
                : selectedRoom ? `# ${selectedRoom.name}` : t("chooseRoom")}
            </h2>
          </div>
          <div className="workspace-controls">
            {selectedTeam && selectedRoom && (
              <>
                <button
                  className={activeView === "room" ? "header-chat active" : "header-chat"}
                  onClick={() => setActiveView("room")}
                  type="button"
                >⌁ <span>{t("chat")}</span></button>
                <select
                  aria-label={t("selectRoom")}
                  className="header-room-select"
                  onChange={(event) => {
                    setSelectedRoomId(event.target.value);
                    setActiveView("room");
                  }}
                  value={selectedRoomId ?? ""}
                >
                  {rooms.map((room) => (
                    <option key={room.roomId} value={room.roomId}># {room.name}</option>
                  ))}
                </select>
                <form className="header-room-create" onSubmit={createRoom}>
                  <input
                    aria-label={t("newRoomName")}
                    onChange={(event) => setRoomName(event.target.value)}
                    placeholder={t("addRoom")}
                    required
                    value={roomName}
                  />
                  <button aria-label={t("createRoom")} disabled={busy} title={t("createRoom")}>+</button>
                </form>
              </>
            )}
            <button
              aria-label={t("language")}
              className="header-locale"
              onClick={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")}
              title={t("language")}
              type="button"
            >{locale === "zh-CN" ? "EN" : "中"}</button>
            <button
              aria-label={t("theme")}
              className="header-theme"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              title={theme === "dark" ? t("switchToLight") : t("switchToDark")}
              type="button"
            >{theme === "dark" ? "☀" : "☾"}</button>
            <button className="header-sign-out" disabled={busy} onClick={() => void signOut()} type="button">
              {t("signOut")}
            </button>
            {selectedTeam && (
              <div className="agent-summary">
                <span className={`presence-dot ${readyAgents === 0 ? "offline" : ""}`} />
                {locale === "zh-CN"
                  ? `${readyAgents} 个就绪 · 共 ${agents.length} 个`
                  : `${readyAgents} ready · ${agents.length} total`}
              </div>
            )}
          </div>
        </header>
        {!selectedTeam ? (
          <section className="empty-stage onboarding-stage">
            <div className="orb"><span>✦</span></div>
            <p className="eyebrow">{locale === "zh-CN" ? "第 1 步，共 3 步" : "STEP 1 OF 3"}</p>
            <h3>{t("createFirstTeam")}</h3>
            <p>{t("teamIntro")}</p>
            <form className="onboarding-form" onSubmit={createTeam}>
              <label htmlFor="onboarding-team-name">{t("teamName")}</label>
              <div>
                <input
                  autoComplete="off"
                  id="onboarding-team-name"
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder={locale === "zh-CN" ? "研发 Team" : "Platform Team"}
                  required
                  value={teamName}
                />
                <button disabled={busy}>{busy ? t("creating") : t("createTeam")}</button>
              </div>
              <small>{t("nextRoomAgent")}</small>
            </form>
          </section>
        ) : activeView === "members" ? (
          <section className="management-workspace member-workspace" aria-label={t("teamMembers")}>
            <div className="management-intro">
              <div>
                <p className="eyebrow">{t("teamAccess")}</p>
                <h3>{t("manageTeamMembers")}</h3>
                <p>{t("membersDescription")}</p>
              </div>
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
                      {member.userId === session?.userId && <span className="current-user-badge">{t("currentAccount")}</span>}
                    </article>
                  ))}
                </div>
              </section>

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
                    <form className="approval-form" onSubmit={createMemberInvitation}>
                      <label htmlFor="member-invite-name">{t("memberDisplayName")}</label>
                      <div>
                        <input id="member-invite-name" onChange={(event) => setMemberInviteName(event.target.value)} placeholder={locale === "zh-CN" ? "例如：小李" : "For example: Bob"} required value={memberInviteName} />
                        <button disabled={busy}>{busy ? t("creating") : t("createInvitation")}</button>
                      </div>
                    </form>
                    {memberInvitation && (
                      <div className="member-invitation-result" aria-live="polite">
                        <strong>{t("invitationCreated")}</strong>
                        <p>{t("invitationSharePrivately")}</p>
                        <div className="invitation-link">
                          <input aria-label={t("invitationLink")} readOnly value={memberInvitation.claimUrl} />
                          <button onClick={() => void copyMemberInvitation()} type="button">
                            {invitationCopied ? t("copied") : t("copyLink")}
                          </button>
                        </div>
                        <small>{t("invitationExpires")} {new Date(memberInvitation.expiresAt).toLocaleString(locale)}</small>
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          </section>
        ) : activeView === "agents" ? (
          <section className="management-workspace" aria-label={t("agentManagement")}>
            <div className="management-intro">
              <div>
                <p className="eyebrow">{t("teamControlPlane")}</p>
                <h3>{t("manageRuntimes")}</h3>
                <p>{t("manageDescription")}</p>
              </div>
              <button
                className="primary-action"
                onClick={() => setConnectionMode("managed")}
                type="button"
              >{t("connectAgent")}</button>
            </div>

            <div className="metric-grid" aria-label={t("agentStatusSummary")}>
              <article className="metric-card"><strong>{agents.length}</strong><span>{t("totalAgents")}</span></article>
              <article className="metric-card"><strong>{readyAgents}</strong><span>{t("readyNow")}</span></article>
              <article className="metric-card"><strong>{managedAgents}</strong><span>{t("managedBridgeCount")}</span></article>
              <article className="metric-card"><strong>{activeDevices}</strong><span>{t("activeDevices")}</span></article>
            </div>

            <div className="management-grid">
              <section className="control-panel agent-library" aria-labelledby="agent-library-title">
                <div className="panel-header">
                  <div><p className="eyebrow">{t("agentLibrary")}</p><h3 id="agent-library-title">{t("teamAgents")}</h3></div>
                  <span>{locale === "zh-CN" ? `已注册 ${agents.length} 个` : `${agents.length} ${t("registered")}`}</span>
                </div>
                {agents.length === 0 ? (
                  <div className="panel-empty">
                    <span>✦</span>
                    <strong>{t("noAgents")}</strong>
                    <p>{t("noAgentsHelp")}</p>
                  </div>
                ) : (
                  <div className="agent-card-grid">
                    {agents.map((agent) => (
                      <article className="agent-card" key={agent.agentId}>
                        <div className="agent-card-top">
                          <span className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
                          <span className={`status-badge ${agent.presence}`}>
                            <span className={`presence-dot ${agent.presence}`} />{presenceLabel(agent.presence, locale)}
                          </span>
                        </div>
                        <div className="agent-card-copy">
                          <h4>{agent.name}</h4>
                          <p>{roleLabel(agent.role, locale)}</p>
                        </div>
                        <span className={`integration-badge ${agent.integrationMode}`}>
                          {integrationLabel(agent.integrationMode, locale)}
                        </span>
                        <small>{presenceHelp(agent, locale)}</small>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="control-panel connection-center" aria-labelledby="connection-center-title">
                <div className="panel-header">
                  <div><p className="eyebrow">{t("connectionCenter")}</p><h3 id="connection-center-title">{t("addAgent")}</h3></div>
                </div>
                <div className="connection-tabs" role="tablist" aria-label={t("connectionMethods")}>
                  <button aria-selected={connectionMode === "managed"} onClick={() => setConnectionMode("managed")} role="tab" type="button">{t("managedCodex")}</button>
                  <button aria-selected={connectionMode === "mcp"} onClick={() => setConnectionMode("mcp")} role="tab" type="button">{t("mcpClient")}</button>
                  <button aria-selected={connectionMode === "demo"} onClick={() => setConnectionMode("demo")} role="tab" type="button">{t("demoAgent")}</button>
                </div>

                {connectionMode === "managed" && (
                  <div className="connection-content" role="tabpanel">
                    <div className="method-heading"><span className="method-icon">⌘</span><div><strong>{t("managedLocalCodex")}</strong><p>{t("managedCodexHelp")}</p></div></div>
                    <ol className="setup-steps">
                      <li><span>1</span><div><strong>{t("startBridge")}</strong><p>{t("startBridgeHelp")}</p></div></li>
                    </ol>
                    <div className="command-box"><code>agentroom-bridge join --server {bridgeServerURL()}</code><button onClick={() => void navigator.clipboard.writeText(`agentroom-bridge join --server ${bridgeServerURL()}`)} type="button">{t("copy")}</button></div>
                    <ol className="setup-steps" start={2}>
                      <li><span>2</span><div><strong>{t("approveCodeTitle")}</strong><p>{t("approveCodeHelp")}</p></div></li>
                    </ol>
                    <form className="approval-form" onSubmit={approveBridgeJoin}>
                      <label htmlFor="bridge-approval-code">{t("bridgeApprovalCode")}</label>
                      <div>
                        <input
                          aria-label={t("bridgeApprovalCode")}
                          autoCapitalize="characters"
                          autoComplete="off"
                          id="bridge-approval-code"
                          onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                          placeholder="ABCD-1234"
                          required
                          value={joinCode}
                        />
                        <button disabled={busy}>{busy ? t("approving") : t("approveBridge")}</button>
                      </div>
                    </form>
                    <details className="legacy-pairing">
                      <summary>{t("legacyPairing")}</summary>
                      <form className="approval-form compact" onSubmit={createBridgeInvite}>
                        <label htmlFor="legacy-device-name">{t("deviceName")}</label>
                        <div>
                          <input id="legacy-device-name" aria-label={t("bridgeDeviceName")} onChange={(event) => setDeviceName(event.target.value)} placeholder={locale === "zh-CN" ? "小陈的 Mac" : "Bob's Mac"} required value={deviceName} />
                          <button disabled={busy}>{t("createCode")}</button>
                        </div>
                      </form>
                    </details>
                  </div>
                )}

                {connectionMode === "mcp" && (
                  <div className="connection-content" role="tabpanel">
                    <div className="method-heading"><span className="method-icon">M</span><div><strong>{t("mcpParticipant")}</strong><p>{t("mcpHelp")}</p></div></div>
                    <form className="approval-form" onSubmit={createManualAgent}>
                      <label htmlFor="manual-agent-name">{t("agentDisplayName")}</label>
                      <div>
                        <input id="manual-agent-name" aria-label={t("manualAgentName")} onChange={(event) => setManualAgentName(event.target.value)} placeholder="Codex via MCP" required value={manualAgentName} />
                        <button disabled={busy}>{t("createMcpToken")}</button>
                      </div>
                    </form>
                  </div>
                )}

                {connectionMode === "demo" && (
                  <div className="connection-content" role="tabpanel">
                    <div className="demo-warning"><strong>{t("simulationOnly")}</strong><p>{t("demoAgentHelp")}</p></div>
                    <form className="approval-form" onSubmit={createFakeAgent}>
                      <label htmlFor="demo-agent-name">{t("demoAgentName")}</label>
                      <div>
                        <input id="demo-agent-name" aria-label={t("demoAgentName")} onChange={(event) => setAgentName(event.target.value)} placeholder={locale === "zh-CN" ? "评审助手" : "Review Bot"} required value={agentName} />
                        <button disabled={busy}>{t("addDemoAgent")}</button>
                      </div>
                    </form>
                  </div>
                )}

                {setupOutput && (
                  <div className="setup-output management-output" aria-live="polite">
                    <div><strong>{t("setupResult")}</strong><button type="button" onClick={() => void navigator.clipboard.writeText(setupOutput)}>{t("copy")}</button></div>
                    <pre>{setupOutput}</pre>
                  </div>
                )}
              </section>
            </div>

            <section className="control-panel device-panel" aria-labelledby="device-panel-title">
              <div className="panel-header">
                <div><p className="eyebrow">{t("trustedDevices")}</p><h3 id="device-panel-title">{t("bridgeDevices")}</h3></div>
                <span>{locale === "zh-CN" ? `${activeDevices} 台活跃` : `${activeDevices} active`}</span>
              </div>
              {devices.length === 0 ? (
                <p className="device-empty">{t("noDevices")}</p>
              ) : (
                <div className="device-grid">
                  {devices.map((device) => (
                    <article className="device-card" key={device.deviceId}>
                      <span className="device-icon">▣</span>
                      <div><strong>{device.name}</strong><small>{device.deviceId}</small></div>
                      <span className={`status-badge ${device.status}`}>{presenceLabel(device.status, locale)}</span>
                      <button disabled={device.status !== "active"} onClick={() => void revokeDevice(device)} type="button">{device.status === "active" ? t("revoke") : t("revoked")}</button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : !selectedRoom ? (
          <section className="empty-stage onboarding-stage">
            <div className="step-badge">2</div>
            <p className="eyebrow">{locale === "zh-CN" ? `第 2 步，共 3 步 · ${selectedTeam.name}` : `STEP 2 OF 3 · ${selectedTeam.name}`}</p>
            <h3>{t("createConversationRoom")}</h3>
            <p>{t("roomHelp")}</p>
            <form className="onboarding-form" onSubmit={createRoom}>
              <label htmlFor="onboarding-room-name">{locale === "zh-CN" ? "房间名称" : "Room name"}</label>
              <div>
                <input
                  autoComplete="off"
                  id="onboarding-room-name"
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="general"
                  required
                  value={roomName}
                />
                <button disabled={busy}>{busy ? t("creating") : t("createRoom")}</button>
              </div>
              <small>{t("addMoreRooms")}</small>
            </form>
          </section>
        ) : messages.length === 0 ? (
          <section className="empty-stage">
            <div className="orb"><span>✦</span></div>
            <p className="eyebrow">{agents.length === 0 ? (locale === "zh-CN" ? "第 3 步，共 3 步" : "STEP 3 OF 3") : t("centralTeamReady")}</p>
            <h3>
              {agents.length === 0
                ? t("addAgentOrStart")
                : `${t("startConversation")} #${selectedRoom.name}`}
            </h3>
            <p>{t("timelineHelp")}</p>
            {agents.length === 0 && (
              <div className="onboarding-actions">
                <form className="action-card" onSubmit={createFakeAgent}>
                  <span className="action-kicker">{t("tryNow")}</span>
                  <strong>{t("addDemoAgent")}</strong>
                  <p>{locale === "zh-CN" ? "使用进程内运行时体验提及与回复流程。" : "Use the in-process runtime to explore mentions and replies."}</p>
                  <input
                    aria-label={t("demoAgentName")}
                    onChange={(event) => setAgentName(event.target.value)}
                    placeholder={locale === "zh-CN" ? "评审助手" : "Review Bot"}
                    required
                    value={agentName}
                  />
                  <button disabled={busy}>{busy ? t("creating") : t("addDemoAgent")}</button>
                </form>
                <div className="action-card">
                  <span className="action-kicker">{t("useRuntime")}</span>
                  <strong>{t("connectRealAgent")}</strong>
                  <p>{t("connectRealAgentHelp")}</p>
                  <button onClick={revealConnectionSetup} type="button">{t("openConnectionSetup")}</button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="timeline" aria-label={t("roomMessages")}>
            {messages.map((message) => {
              const senderName = message.senderType === "agent"
                ? agentsById.get(message.senderId)?.name ?? t("agent")
                : message.senderType === "member"
                  ? membersById.get(message.senderId)?.displayName ?? session?.displayName ?? ""
                  : "Agent Room";
              const avatarLabel = senderName.trim().slice(0, 1).toLocaleUpperCase(locale) || "A";

              return (
                <article className="message" key={message.messageId}>
                  <span className={`avatar ${message.senderType}`}>{avatarLabel}</span>
                  <div>
                    <header>
                      <strong>{senderName}</strong>
                      <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    </header>
                    <p>{message.content}</p>
                    {(message.mentions.length > 0 || runs.some((run) => run.triggerMessageId === message.messageId)) && (
                      <div className="message-routing">
                        {message.mentions.map((mention) => (
                          <span className="mention-pill" key={mention.targetAgentId}>
                            @{mention.displayLabel}
                          </span>
                        ))}
                        {runs.filter((run) => run.triggerMessageId === message.messageId).map((run) => (
                          <span
                            className={`run-card ${runDiagnostics[run.runId] ? "has-diagnostic" : ""}`}
                            key={run.runId}
                            title={run.runId}
                          >
                            <strong>{agentsById.get(run.targetAgentId)?.name ?? t("agent")}</strong>
                            <span className={`run-state ${run.state}`}>
                              {runStateLabel(run.state, locale)}
                            </span>
                            {["queued", "delivered", "working", "input_required"].includes(run.state) && (
                              <button type="button" onClick={() => void cancelRun(run.runId)}>{t("cancel")}</button>
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
                                </strong>
                                <small>
                                  {diagnosticGuidance(
                                    runDiagnostics[run.runId]?.category ?? null,
                                    locale
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
          </section>
        )}
        {selectedRoom && activeView === "room" && (
          <div className="room-dock">
            {visibleDiscussion && (
              <section className="discussion-status" aria-label={locale === "zh-CN" ? "当前智能体讨论" : "Active Agent Discussion"}>
                <div className="discussion-status-copy">
                  <span className={`discussion-state ${visibleDiscussion.discussion.state}`}>
                    {discussionStateLabel(visibleDiscussion.discussion.state, locale)}
                    {visibleDiscussion.discussion.state === "active" && activeDiscussionWaveNumber > 0 &&
                      ` · ${locale === "zh-CN" ? "第" : "wave "}${activeDiscussionWaveNumber}${locale === "zh-CN" ? "轮" : ""}`}
                  </span>
                  {discussionGoalEditId === visibleDiscussion.discussion.discussionId ? (
                    <textarea
                      aria-label={locale === "zh-CN" ? "讨论目标" : "Discussion goal"}
                      className="discussion-goal-editor"
                      onChange={(event) => setDiscussionGoalDraft(event.currentTarget.value)}
                      rows={2}
                      value={discussionGoalDraft}
                    />
                  ) : (
                    <strong>{visibleDiscussion.discussion.goal}</strong>
                  )}
                  <small>
                    {visibleDiscussion.discussion.progress.openQuestions.length > 0
                      ? (locale === "zh-CN"
                          ? `还有 ${visibleDiscussion.discussion.progress.openQuestions.length} 个未决问题`
                          : `${visibleDiscussion.discussion.progress.openQuestions.length} open questions`)
                      : ["completed", "canceled", "terminated"].includes(visibleDiscussion.discussion.state)
                        ? (locale === "zh-CN" ? "本次讨论已经结束" : "This Discussion has ended")
                        : (locale === "zh-CN" ? "正在根据进展和边际收益决定下一步" : "The Orchestrator is evaluating progress and marginal gain")}
                  </small>
                  {activeWave && (
                    <div className={`discussion-wave ${activeWave.phase} ${activeWave.state}`}>
                      <div className="discussion-wave-summary">
                        <span>{wavePhaseLabel(activeWave.phase, locale)}</span>
                        <span className="discussion-wave-result">
                          <span className={`discussion-wave-state ${activeWave.state}`}>
                            {waveStateLabel(activeWave.state, locale)}
                          </span>
                          <strong>{locale === "zh-CN"
                            ? `${activeWaveEndedMembers}/${activeWaveExpectedMembers} 已结束`
                            : `${activeWaveEndedMembers}/${activeWaveExpectedMembers} finished`}</strong>
                        </span>
                      </div>
                      {activeWave.phase === "finalization" && activeWave.state === "open" && (
                        <div className="discussion-wave-finalizing" role="status">
                          <span aria-hidden="true" className="discussion-wave-pulse" />
                          <span>{locale === "zh-CN" ? "正在汇总各智能体结果" : "Consolidating Agent results"}</span>
                        </div>
                      )}
                      <ul
                        aria-label={activeWave.phase === "finalization"
                          ? (locale === "zh-CN" ? "结论生成进度" : "Conclusion generation progress")
                          : locale === "zh-CN"
                            ? `第${activeDiscussionWaveNumber}轮并行进度`
                            : `Wave ${activeDiscussionWaveNumber} parallel progress`}
                        className="discussion-wave-members"
                      >
                        {activeWaveMembers.map(({ agent, state, turn }) => (
                          <li className={`discussion-wave-member ${state}`} key={turn.turnId}>
                            <span aria-hidden="true" className="discussion-wave-member-dot" />
                            <span className="discussion-wave-member-copy">
                              <strong>{agent?.name ?? (locale === "zh-CN" ? "智能体" : "Agent")}</strong>
                              {turn.terminalReason && (
                                <small>{locale === "zh-CN" ? "原因：" : "Reason: "}{terminalReasonLabel(turn.terminalReason, locale)}</small>
                              )}
                            </span>
                            <span>{waveMemberStateLabel(state, locale)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="discussion-controls">
                  {activeDiscussion && (discussionGoalEditId === activeDiscussion.discussion.discussionId ? (
                    <>
                      <button className="discussion-primary" disabled={busy || !discussionGoalDraft.trim()} onClick={() => void saveDiscussionGoal()} type="button">
                        {locale === "zh-CN" ? "保存目标" : "Save goal"}
                      </button>
                      <button disabled={busy} onClick={cancelDiscussionGoalEdit} type="button">
                        {locale === "zh-CN" ? "取消" : "Cancel"}
                      </button>
                    </>
                  ) : (
                    <>
                      {["awaiting_extension", "waiting_human", "paused"].includes(activeDiscussion.discussion.state) ? (
                        <button className="discussion-primary" disabled={busy} onClick={() => void controlDiscussion(activeDiscussion.discussion.discussionId, "continue")} type="button">
                          {locale === "zh-CN" ? "继续解决" : "Continue solving"}
                        </button>
                      ) : activeDiscussion.discussion.state !== "finalizing" && activeDiscussion.discussion.state !== "stop_requested" ? (
                        <button className="discussion-primary" disabled={busy} onClick={() => void controlDiscussion(activeDiscussion.discussion.discussionId, "finish")} type="button">
                          {locale === "zh-CN" ? "结束并生成结论" : "Finish and generate conclusion"}
                        </button>
                      ) : null}
                      {activeDiscussion.discussion.state === "active" && (
                        <>
                          <button disabled={busy} onClick={() => void controlDiscussion(activeDiscussion.discussion.discussionId, "stop_after_turn")} type="button">
                            {locale === "zh-CN" ? "本轮后停止" : "Stop after turn"}
                          </button>
                          <button disabled={busy} onClick={() => void controlDiscussion(activeDiscussion.discussion.discussionId, "pause")} type="button">
                            {locale === "zh-CN" ? "暂停" : "Pause"}
                          </button>
                        </>
                      )}
                      {["awaiting_extension", "waiting_human", "paused"].includes(activeDiscussion.discussion.state) && (
                        <button disabled={busy} onClick={() => editDiscussionGoal(activeDiscussion)} type="button">
                          {locale === "zh-CN" ? "调整目标" : "Adjust goal"}
                        </button>
                      )}
                      {activeDiscussion.discussion.state !== "finalizing" && (
                        <button className="discussion-danger" disabled={busy} onClick={() => void controlDiscussion(activeDiscussion.discussion.discussionId, "cancel")} type="button">
                          {locale === "zh-CN" ? "立即停止" : "Stop now"}
                        </button>
                      )}
                    </>
                  ))}
                </div>
              </section>
            )}
            <form className="composer" onSubmit={(event) => void submitComposer(event)}>
              <div className="composer-input">
                {mentionSearch && (
                  <div className="mention-suggestions" aria-label={t("mentionAgent")} role="listbox">
                    <div className="mention-suggestions-heading">{t("mentionHint")}</div>
                    {mentionOptions.length === 0 ? (
                      <p>{t("noMentionMatches")}</p>
                    ) : mentionOptions.map((agent, index) => (
                      <button
                        aria-selected={index === mentionOptionIndex}
                        className={index === mentionOptionIndex ? "mention-option active" : "mention-option"}
                        key={agent.agentId}
                        onClick={() => selectMention(agent)}
                        role="option"
                        type="button"
                      >
                        <span className="participant-avatar agent">{agent.name.slice(0, 1).toUpperCase()}</span>
                        <span><strong>@{agent.name}</strong><small>{roleLabel(agent.role, locale)}</small></span>
                        <span className={`presence-dot ${agent.presence}`} />
                      </button>
                    ))}
                  </div>
                )}
                {selectedMentionAgents.length > 0 && (
                  <div className="selected-mentions" aria-label={locale === "zh-CN" ? "已提及智能体" : "Mentioned Agents"}>
                    {selectedMentionAgents.map((agent) => (
                      <button
                        aria-label={locale === "zh-CN"
                          ? `移除提及 ${agent.name}（${roleLabel(agent.role, locale)}）`
                          : `Remove mention ${agent.name} (${roleLabel(agent.role, locale)})`}
                        className="selected-mention"
                        key={agent.agentId}
                        onClick={() => removeMention(agent)}
                        type="button"
                      >
                        @{agent.name} · {roleLabel(agent.role, locale)} ×
                      </button>
                    ))}
                    <span className="composer-routing-hint">
                      {selectedMentionAgents.length === 1
                        ? (locale === "zh-CN" ? "发送后由该智能体执行" : "Send to run this Agent")
                        : (locale === "zh-CN"
                            ? `发送后将发起 ${selectedMentionAgents.length} 个智能体的协作讨论`
                            : `Send to start a ${selectedMentionAgents.length}-Agent Discussion`)}
                    </span>
                  </div>
                )}
                <textarea
                  aria-label={t("message")}
                  onChange={handleMessageChange}
                  onKeyDown={handleMessageKeyDown}
                  placeholder={locale === "zh-CN"
                    ? `发送消息到 #${selectedRoom.name}；@ 一个智能体执行，@ 多个智能体协作`
                    : `Message #${selectedRoom.name}; @ one Agent to run or multiple Agents to collaborate`}
                  required
                  rows={2}
                  value={messageContent}
                />
              </div>
              <button className="composer-send" disabled={busy}>
                {busy ? t("sending") : t("send")}
              </button>
            </form>
          </div>
        )}
        {error && <div className="error-banner" role="alert">{errorLabel(error, locale)}</div>}
      </main>
    </div>
  );
}
