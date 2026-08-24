import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { BridgeJoinApproval } from "@agent-room/contracts/bridge-messages";

import { type Locale, type TranslationKey, translate } from "./i18n.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import {
  createSingleFlight,
  mergeRoomMessages,
  reduceRunOutput,
  type RunEventRecord,
  type RunOutputProjection
} from "./room-sync.js";
import {
  loadRunDiagnostic,
  type RunDiagnostic,
  type RuntimeFailureCategory
} from "./run-diagnostics.js";
import {
  createClientMessageId,
  type PendingRoomMessage,
  queuePendingMessage,
  updatePendingMessage
} from "./message-outbox.js";
import {
  removeVisibleMentionToken,
  resolveExactMentionCommands,
  retainVisibleMentionIds
} from "./structured-mentions.js";

interface Team {
  teamId: string;
  name: string;
  createdAt: string;
  archivedAt?: string | null;
}

interface Member {
  memberId: string;
  teamId: string;
  userId: string | null;
  displayName: string;
  role: "owner" | "member";
  createdAt: string;
}

interface RoomCollaborationPolicy {
  allowDiscussion: boolean;
  allowAll: boolean;
  allowAgentMentions: boolean;
  maxAgentMentionDepth: number;
}

const defaultRoomCollaborationPolicy: RoomCollaborationPolicy = {
  allowDiscussion: true,
  allowAll: true,
  allowAgentMentions: true,
  maxAgentMentionDepth: 4
};

interface Room {
  roomId: string;
  teamId: string;
  name: string;
  collaborationPolicy?: RoomCollaborationPolicy;
  settingsRevision: number;
  createdAt: string;
  archivedAt?: string | null;
}

interface Agent {
  agentId: string;
  enabled?: boolean;
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

interface RoomParticipants {
  memberIds: string[];
  agentIds: string[];
}

interface RoomSettings {
  room: Room;
  participants: RoomParticipants;
}

function collaborationPolicyFor(room: Room | null): RoomCollaborationPolicy {
  return room?.collaborationPolicy ?? defaultRoomCollaborationPolicy;
}

interface TeamChangeCursor {
  changed: boolean;
  cursor: number;
  reset: boolean;
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

const activeRunStates = new Set([
  "queued",
  "delivered",
  "working",
  "input_required"
]);

async function loadRunOutputEvents(
  roomRuns: Run[],
  current: Map<string, RunOutputProjection>,
  token?: string
): Promise<Map<string, RunEventRecord[]>> {
  const candidates = roomRuns.filter((run) =>
    activeRunStates.has(run.state) || current.has(run.runId)
  );
  const batches = await Promise.all(candidates.map(async (run) => {
    const after = current.get(run.runId)?.sequence ?? 0;
    const records = await jsonRequest<RunEventRecord[]>(
      `/api/runs/${run.runId}/events?after=${after}`,
      {},
      token
    );
    return [run.runId, records] as const;
  }));
  return new Map(batches);
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
  const [roomParticipants, setRoomParticipants] = useState<RoomParticipants>({
    memberIds: [],
    agentIds: []
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runOutputs, setRunOutputs] = useState<
    Record<string, RunOutputProjection>
  >({});
  const [runDiagnostics, setRunDiagnostics] = useState<
    Record<string, RunDiagnostic | null>
  >({});
  const [discussions, setDiscussions] = useState<DiscussionView[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("room");
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("managed");
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [lifecycleDialogOpen, setLifecycleDialogOpen] = useState(false);
  const [lifecycleTeams, setLifecycleTeams] = useState<Team[]>([]);
  const [lifecycleRooms, setLifecycleRooms] = useState<Room[]>([]);
  const [lifecycleTeamId, setLifecycleTeamId] = useState<string | null>(null);
  const [lifecycleNames, setLifecycleNames] = useState<Record<string, string>>({});
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [roomActionsOpen, setRoomActionsOpen] = useState(false);
  const [archiveRoomConfirmOpen, setArchiveRoomConfirmOpen] = useState(false);
  const [participantDialogOpen, setParticipantDialogOpen] = useState(false);
  const [participantMemberIds, setParticipantMemberIds] = useState<string[]>([]);
  const [participantAgentIds, setParticipantAgentIds] = useState<string[]>([]);
  const [roomPolicyDraft, setRoomPolicyDraft] = useState<RoomCollaborationPolicy>(
    defaultRoomCollaborationPolicy
  );
  const [roomSettingsDraftRevision, setRoomSettingsDraftRevision] = useState<
    number | null
  >(null);
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
  const [pendingMessages, setPendingMessages] = useState<PendingRoomMessage[]>([]);
  const [discussionGoalEditId, setDiscussionGoalEditId] = useState<string | null>(null);
  const [discussionGoalDraft, setDiscussionGoalDraft] = useState("");
  const [expandedDiscussionId, setExpandedDiscussionId] = useState<string | null>(null);
  const [mentionAgentIds, setMentionAgentIds] = useState<string[]>([]);
  const [mentionSearch, setMentionSearch] = useState<MentionSearch | null>(null);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [participantBusy, setParticipantBusy] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageSyncRef = useRef<{
    roomId: string;
    cursor: string | null;
    sequence: number;
  } | null>(null);
  const diagnosticRequestsRef = useRef(new Set<string>());
  const runOutputSyncRef = useRef(new Map<string, RunOutputProjection>());
  const selectedRoomIdRef = useRef<string | null>(selectedRoomId);

  const commitRunOutputEvents = (
    roomRuns: Run[],
    batches: Map<string, RunEventRecord[]>
  ): void => {
    const next = new Map(runOutputSyncRef.current);
    const visibleRunIds = new Set(roomRuns.map(({ runId }) => runId));
    for (const runId of next.keys()) {
      if (!visibleRunIds.has(runId)) next.delete(runId);
    }
    for (const [runId, records] of batches) {
      next.set(runId, reduceRunOutput(next.get(runId), records));
    }
    for (const run of roomRuns) {
      const projection = next.get(run.runId);
      if (projection?.sealed && !activeRunStates.has(run.state)) {
        next.delete(run.runId);
      }
    }
    runOutputSyncRef.current = next;
    setRunOutputs(Object.fromEntries(
      [...next].filter(([, projection]) =>
        !projection.sealed && projection.content.length > 0
      )
    ));
  };

  const selectedTeam = useMemo(
    () => teams.find((team) => team.teamId === selectedTeamId) ?? null,
    [selectedTeamId, teams]
  );
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.roomId === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );
  const selectedRoomPolicy = collaborationPolicyFor(selectedRoom);
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
  const roomMembers = useMemo(() => {
    const visible = new Set(roomParticipants.memberIds);
    return members.filter(({ memberId }) => visible.has(memberId));
  }, [members, roomParticipants.memberIds]);
  const roomAgents = useMemo(() => {
    const visible = new Set(roomParticipants.agentIds);
    return agents.filter(({ agentId }) => visible.has(agentId));
  }, [agents, roomParticipants.agentIds]);
  const mentionOptions = useMemo(() => {
    if (!mentionSearch) return [];
    const query = mentionSearch.query.toLocaleLowerCase(locale);
    return roomAgents.filter((agent) =>
      !mentionAgentIds.includes(agent.agentId) && (
        agent.name.toLocaleLowerCase(locale).includes(query) ||
        roleLabel(agent.role, locale).toLocaleLowerCase(locale).includes(query)
      )
    ).slice(0, 8);
  }, [locale, mentionAgentIds, mentionSearch, roomAgents]);
  const exactMentionCommands = useMemo(
    () => resolveExactMentionCommands(messageContent, roomAgents, agents),
    [agents, messageContent, roomAgents]
  );
  const selectedMentionAgents = mentionAgentIds.flatMap((agentId) => {
    const agent = agentsById.get(agentId);
    return agent ? [agent] : [];
  });
  const unresolvedExactAmbiguousNames = exactMentionCommands.ambiguousNames.filter(
    (name) => !selectedMentionAgents.some((agent) => agent.name === name)
  );
  const directlyParsedAgents = exactMentionCommands.agentIds.flatMap((agentId) => {
    if (mentionAgentIds.includes(agentId)) return [];
    const agent = agentsById.get(agentId);
    return agent ? [agent] : [];
  });
  const readyAgents = agents.filter((agent) => agent.presence === "ready").length;
  const managedAgents = agents.filter((agent) => agent.integrationMode === "managed").length;
  const activeDevices = devices.filter((device) => device.status === "active").length;
  const currentMember = members.find((member) => member.userId === session?.userId) ?? null;
  const pendingRoomMessages = pendingMessages.filter(({ roomId }) =>
    roomId === selectedRoomId
  );
  const lifecycleTeam = lifecycleTeams.find(({ teamId }) =>
    teamId === lifecycleTeamId
  ) ?? null;
  const t = (key: TranslationKey) => translate(locale, key);
  const activeDiscussion = [...discussions].reverse().find(({ discussion }) =>
    !["completed", "canceled", "terminated"].includes(discussion.state)
  ) ?? null;
  const roomHasActiveRuns = runs.some(({ state }) => activeRunStates.has(state));
  const roomHasActiveWork = roomHasActiveRuns || activeDiscussion !== null;
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
  const visibleDiscussionExpanded = visibleDiscussion?.discussion.discussionId === expandedDiscussionId;

  useEffect(() => {
    if (!visibleDiscussion || ["completed", "canceled", "terminated"].includes(visibleDiscussion.discussion.state)) {
      setExpandedDiscussionId(null);
    }
  }, [visibleDiscussion?.discussion.discussionId, visibleDiscussion?.discussion.state]);

  useEffect(() => {
    setRoomActionsOpen(false);
    setArchiveRoomConfirmOpen(false);
  }, [activeView, selectedRoomId, selectedTeamId]);

  useEffect(() => {
    if (!roomActionsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".header-room-actions")) setRoomActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRoomActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [roomActionsOpen]);

  useEffect(() => {
    localStorage.setItem(localeKey, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    localStorage.setItem(themeKey, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    selectedRoomIdRef.current = selectedRoomId;
  }, [selectedRoomId]);

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
    setSelectedTeamId((current) =>
      next.some(({ teamId }) => teamId === current) ? current : next[0]?.teamId ?? null
    );
  }

  async function loadLifecycleResources(
    activeSession: LocalSession,
    preferredTeamId?: string | null
  ) {
    const nextTeams = await jsonRequest<Team[]>(
      "/api/teams?includeArchived=true",
      {},
      activeSession.token
    );
    const nextTeamId = preferredTeamId && nextTeams.some(({ teamId }) =>
      teamId === preferredTeamId
    ) ? preferredTeamId : nextTeams[0]?.teamId ?? null;
    const nextRooms = nextTeamId
      ? await jsonRequest<Room[]>(
        `/api/teams/${nextTeamId}/rooms?includeArchived=true`,
        {},
        activeSession.token
      )
      : [];
    setLifecycleTeams(nextTeams);
    setLifecycleTeamId(nextTeamId);
    setLifecycleRooms(nextRooms);
    setLifecycleNames(Object.fromEntries([
      ...nextTeams.map((team) => [team.teamId, team.name]),
      ...nextRooms.map((room) => [room.roomId, room.name])
    ]));
  }

  async function openLifecycleDialog() {
    if (!session || currentMember?.role !== "owner") return;
    setLifecycleDialogOpen(true);
    setLifecycleBusy(true);
    setError(null);
    try {
      await loadLifecycleResources(session, selectedTeamId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function selectLifecycleTeam(teamId: string) {
    if (!session) return;
    setLifecycleBusy(true);
    setError(null);
    try {
      await loadLifecycleResources(session, teamId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function updateLifecycleTeam(
    team: Team,
    update: { name?: string; archived?: boolean }
  ) {
    if (!session) return;
    setLifecycleBusy(true);
    setError(null);
    try {
      await jsonRequest<Team>(`/api/teams/${team.teamId}`, {
        method: "PATCH",
        body: JSON.stringify(update)
      }, session.token);
      await loadTeams(session);
      await loadLifecycleResources(session, team.teamId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function updateLifecycleRoom(
    room: Room,
    update: { name?: string; archived?: boolean }
  ): Promise<boolean> {
    if (!session) return false;
    setLifecycleBusy(true);
    setError(null);
    try {
      await jsonRequest<Room>(`/api/rooms/${room.roomId}`, {
        method: "PATCH",
        body: JSON.stringify(update)
      }, session.token);
      if (room.teamId === selectedTeamId) {
        const nextRooms = await jsonRequest<Room[]>(
          `/api/teams/${room.teamId}/rooms`, {}, session.token
        );
        setRooms(nextRooms);
        setSelectedRoomId((current) =>
          nextRooms.some(({ roomId }) => roomId === current)
            ? current
            : nextRooms[0]?.roomId ?? null
        );
      }
      await loadLifecycleResources(session, room.teamId);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function archiveSelectedRoom() {
    if (!selectedRoom || roomHasActiveWork) return;
    const archived = await updateLifecycleRoom(selectedRoom, { archived: true });
    if (archived) {
      setArchiveRoomConfirmOpen(false);
      setRoomActionsOpen(false);
    }
  }

  async function setAgentEnabled(agent: Agent, enabled: boolean) {
    if (!session || currentMember?.role !== "owner") return;
    setLifecycleBusy(true);
    setError(null);
    try {
      const updated = await jsonRequest<Agent>(`/api/agents/${agent.agentId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      }, session.token);
      setAgents((current) => current.map((item) =>
        item.agentId === updated.agentId ? updated : item
      ));
      if (!enabled) {
        setMentionAgentIds((current) => current.filter((id) => id !== agent.agentId));
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLifecycleBusy(false);
    }
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
      setPendingMessages([]);
      setRuns([]);
      setRunOutputs({});
      runOutputSyncRef.current.clear();
      setRoomParticipants({ memberIds: [], agentIds: [] });
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
    setRuns([]);
    setRunOutputs({});
    runOutputSyncRef.current.clear();
    setRoomParticipants({ memberIds: [], agentIds: [] });
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
      ),
      jsonRequest<RoomSettings>(
        `/api/rooms/${selectedRoomId}/settings`,
        {},
        session.token
      )
    ]).then(async ([page, nextRuns, nextDiscussions, nextSettings]) => {
      const outputBatches = await loadRunOutputEvents(
        nextRuns, runOutputSyncRef.current, session.token
      );
      if (stopped) return;
      setMessages(page.items);
      messageSyncRef.current = {
        roomId: selectedRoomId,
        cursor: page.syncCursor ?? null,
        sequence: page.items.at(-1)?.sequence ?? 0
      };
      setRuns(nextRuns);
      commitRunOutputEvents(nextRuns, outputBatches);
      setDiscussions(nextDiscussions);
      setRoomParticipants(nextSettings.participants);
      setRooms((current) => current.map((room) =>
        room.roomId === nextSettings.room.roomId ? nextSettings.room : room
      ));
      setMentionAgentIds((current) => current.filter((agentId) =>
        nextSettings.participants.agentIds.includes(agentId)
      ));
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
    let activeController: AbortController | null = null;
    let retryTimer: number | null = null;
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
          nextDiscussions,
          nextSettings
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
          ),
          jsonRequest<RoomSettings>(
            `/api/rooms/${selectedRoomId}/settings`, {}, session.token
          )
        ]);
        const outputBatches = await loadRunOutputEvents(
          nextRuns, runOutputSyncRef.current, session.token
        );
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
          commitRunOutputEvents(nextRuns, outputBatches);
          setDiscussions(nextDiscussions);
          setRoomParticipants(nextSettings.participants);
          setRooms((current) => current.map((room) =>
            room.roomId === nextSettings.room.roomId ? nextSettings.room : room
          ));
          setMentionAgentIds((current) => current.filter((agentId) =>
            nextSettings.participants.agentIds.includes(agentId)
          ));
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
    };
    const refreshSingleFlight = createSingleFlight(refresh);
    const delay = (milliseconds: number) => new Promise<void>((resolve) => {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        resolve();
      }, milliseconds);
    });
    const listen = async () => {
      let cursor = 0;
      while (!stopped) {
        if (document.visibilityState === "hidden") {
          await delay(1_000);
          continue;
        }
        activeController = new AbortController();
        try {
          const change = await jsonRequest<TeamChangeCursor>(
            `/api/teams/${selectedTeamId}/changes?after=${cursor}`,
            { signal: activeController.signal },
            session.token
          );
          cursor = change.cursor;
          if (change.changed || change.reset) {
            await refreshSingleFlight();
          } else {
            await delay(250);
          }
        } catch (reason) {
          if (stopped || activeController?.signal.aborted) return;
          await refreshSingleFlight();
          await delay(2_000);
        }
      }
    };
    const reconcileVisible = () => {
      if (document.visibilityState === "hidden") {
        activeController?.abort();
      } else {
        void refreshSingleFlight();
      }
    };
    document.addEventListener("visibilitychange", reconcileVisible);
    const fallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshSingleFlight();
    }, 30_000);
    void listen();
    return () => {
      stopped = true;
      activeController?.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.clearInterval(fallbackTimer);
      document.removeEventListener("visibilitychange", reconcileVisible);
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
    setTeamBusy(true);
    setError(null);
    try {
      const created = await jsonRequest<{ team: Team }>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: teamName })
      }, session.token);
      setTeamName("");
      await loadTeams(session);
      setSelectedTeamId(created.team.teamId);
      setTeamDialogOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setTeamBusy(false);
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !roomName.trim()) return;
    setTeamBusy(true);
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
      setTeamBusy(false);
    }
  }

  async function openParticipantDialog() {
    if (!session || !selectedRoomId || participantBusy) return;
    setParticipantBusy(true);
    setError(null);
    try {
      const settings = await jsonRequest<RoomSettings>(
        `/api/rooms/${selectedRoomId}/settings`,
        {},
        session.token
      );
      setRoomParticipants(settings.participants);
      setRooms((current) => current.map((room) =>
        room.roomId === settings.room.roomId ? settings.room : room
      ));
      setParticipantMemberIds(settings.participants.memberIds);
      setParticipantAgentIds(settings.participants.agentIds);
      setRoomPolicyDraft({ ...collaborationPolicyFor(settings.room) });
      setRoomSettingsDraftRevision(settings.room.settingsRevision);
      setParticipantDialogOpen(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setParticipantBusy(false);
    }
  }

  async function saveRoomParticipants(event: FormEvent) {
    event.preventDefault();
    if (
      !session ||
      !selectedRoomId ||
      currentMember?.role !== "owner" ||
      roomSettingsDraftRevision === null
    ) return;
    setParticipantBusy(true);
    setError(null);
    try {
      const updated = await jsonRequest<RoomSettings>(
        `/api/rooms/${selectedRoomId}/settings`,
        {
          method: "PUT",
          body: JSON.stringify({
            memberIds: participantMemberIds,
            agentIds: participantAgentIds,
            collaborationPolicy: roomPolicyDraft,
            expectedRevision: roomSettingsDraftRevision
          })
        },
        session.token
      );
      setRoomParticipants(updated.participants);
      setRooms((current) => current.map((room) =>
        room.roomId === updated.room.roomId ? updated.room : room
      ));
      setRoomSettingsDraftRevision(updated.room.settingsRevision);
      setMentionAgentIds((current) => current.filter((agentId) =>
        updated.participants.agentIds.includes(agentId)
      ));
      setParticipantDialogOpen(false);
    } catch (reason) {
      if (String(reason).includes("Room settings changed; reload and retry")) {
        const latest = await jsonRequest<RoomSettings>(
          `/api/rooms/${selectedRoomId}/settings`,
          {},
          session.token
        );
        setRoomParticipants(latest.participants);
        setRooms((current) => current.map((room) =>
          room.roomId === latest.room.roomId ? latest.room : room
        ));
        setParticipantMemberIds(latest.participants.memberIds);
        setParticipantAgentIds(latest.participants.agentIds);
        setRoomPolicyDraft({ ...collaborationPolicyFor(latest.room) });
        setRoomSettingsDraftRevision(latest.room.settingsRevision);
        setError(locale === "zh-CN"
          ? "房间设置已被其他客户端更新，已载入最新内容，请确认后再保存。"
          : "Room settings changed in another client. Latest settings were loaded; review and save again.");
      } else {
        setError(String(reason));
      }
    } finally {
      setParticipantBusy(false);
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
    setTeamBusy(true);
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
      setTeamBusy(false);
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
    const exactCommands = resolveExactMentionCommands(
      messageContent,
      roomAgents,
      agents
    );
    const selectedNames = new Set(selectedMentionAgents.map(({ name }) => name));
    const unresolvedAmbiguousNames = exactCommands.ambiguousNames.filter(
      (name) => !selectedNames.has(name)
    );
    if (unresolvedAmbiguousNames.length > 0) {
      setError(locale === "zh-CN"
        ? `精确指令 @${unresolvedAmbiguousNames.join("、@")} 匹配到多个同名智能体，请从候选列表选择具体身份。`
        : `Exact command @${unresolvedAmbiguousNames.join(", @")} matches multiple same-name Agents. Select a specific identity from the suggestions.`);
      return;
    }
    const resolvedMentionAgentIds = exactCommands.usesAll
      ? exactCommands.agentIds
      : [...new Set([...mentionAgentIds, ...exactCommands.agentIds])];
    if (exactCommands.usesAll && !selectedRoomPolicy.allowAll) {
      setError(locale === "zh-CN"
        ? "当前房间设置不允许使用 @all。"
        : "This Room does not allow the @all command.");
      return;
    }
    if (exactCommands.usesAll && resolvedMentionAgentIds.length === 0) {
      setError(locale === "zh-CN"
        ? "当前房间没有可供 @all 路由的智能体。"
        : "This Room has no Agents for @all to route to.");
      return;
    }
    if (resolvedMentionAgentIds.length > 5) {
      setError(locale === "zh-CN"
        ? `精确指令匹配到 ${resolvedMentionAgentIds.length} 个智能体，超过一次协作最多 5 个的限制。`
        : `The exact commands matched ${resolvedMentionAgentIds.length} Agents, exceeding the 5-Agent collaboration limit.`);
      return;
    }
    if (
      selectedRoomPolicy.allowDiscussion &&
      resolvedMentionAgentIds.length >= 2 &&
      activeDiscussion
    ) {
      setError(locale === "zh-CN"
        ? "当前房间已有协作讨论，请先结束或停止后再发起新的协作。"
        : "This Room already has an active Discussion. Finish or stop it before starting another.");
      return;
    }
    setError(null);
    if (
      selectedRoomPolicy.allowDiscussion &&
      resolvedMentionAgentIds.length >= 2
    ) {
      setComposerBusy(true);
      try {
        await jsonRequest<DiscussionView>(
          `/api/rooms/${selectedRoomId}/discussions`,
          {
            method: "POST",
            body: JSON.stringify({
              goal: messageContent,
              participantAgentIds: resolvedMentionAgentIds,
              mode: "round_robin",
              outputMode: "final_answer"
            })
          },
          session.token
        );
        setMessageContent("");
        setMentionAgentIds([]);
        setMentionSearch(null);
        await refreshRoomState();
      } catch (reason) {
        setError(String(reason));
      } finally {
        setComposerBusy(false);
      }
      return;
    }

    const pending: PendingRoomMessage = {
      clientMessageId: createClientMessageId(),
      roomId: selectedRoomId,
      content: messageContent,
      ...(resolvedMentionAgentIds.length > 0
        ? { mentionAgentIds: resolvedMentionAgentIds }
        : {}),
      status: "pending"
    };
    setPendingMessages((current) => queuePendingMessage(current, pending));
    setMessageContent("");
    setMentionAgentIds([]);
    setMentionSearch(null);
    await deliverPendingMessage(pending);
  }

  async function deliverPendingMessage(pending: PendingRoomMessage) {
    if (!session) return;
    setComposerBusy(true);
    setPendingMessages((current) =>
      updatePendingMessage(current, pending.clientMessageId, "pending")
    );
    setError(null);
    try {
      const result = await jsonRequest<{ message: Message; runs: Run[] }>(
        `/api/rooms/${pending.roomId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content: pending.content,
            clientMessageId: pending.clientMessageId,
            ...(pending.mentionAgentIds?.length === 1
              ? { mentionAgentId: pending.mentionAgentIds[0] }
              : pending.mentionAgentIds && pending.mentionAgentIds.length > 1
                ? { mentionAgentIds: pending.mentionAgentIds }
                : {})
          })
        },
        session.token
      );
      setPendingMessages((current) => current.filter(({ clientMessageId }) =>
        clientMessageId !== pending.clientMessageId
      ));
      if (selectedRoomIdRef.current === pending.roomId) {
        setMessages((current) => mergeRoomMessages(current, [result.message]));
        setRuns((current) => {
          const byId = new Map(current.map((run) => [run.runId, run]));
          for (const run of result.runs) byId.set(run.runId, run);
          return [...byId.values()];
        });
        await refreshRoomState();
      }
    } catch (reason) {
      setPendingMessages((current) =>
        updatePendingMessage(current, pending.clientMessageId, "failed")
      );
      setError(String(reason));
    } finally {
      setComposerBusy(false);
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
    setError(null);
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
    setMessageContent((current) => removeVisibleMentionToken(
      current,
      agent.name,
      roomAgents.map(({ name }) => name)
    ));
    setMentionAgentIds((current) => current.filter((agentId) => agentId !== agent.agentId));
    setMentionSearch(null);
  }

  function handleMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
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
          <button
            aria-label={t("newTeam")}
            className="team-add"
            onClick={() => setTeamDialogOpen(true)}
            title={t("newTeam")}
            type="button"
          >+</button>
        </div>
        {selectedTeam && (
          <div className="rail-actions">
            {currentMember?.role === "owner" && (
              <button
                aria-label={locale === "zh-CN" ? "资源生命周期" : "Resource lifecycle"}
                className="rail-manage"
                onClick={() => void openLifecycleDialog()}
                title={locale === "zh-CN" ? "重命名、归档或恢复资源" : "Rename, archive, or restore resources"}
                type="button"
              >⚙</button>
            )}
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
              <div className="participant-heading-actions">
                <span>{roomMembers.length + roomAgents.length}</span>
                {currentMember?.role === "owner" && (
                  <button
                    aria-label={t("roomSettings")}
                    onClick={openParticipantDialog}
                    title={t("roomSettings")}
                    type="button"
                  >⚙</button>
                )}
              </div>
            </div>
            <div className="participant-list">
              {roomMembers.length === 0 && roomAgents.length === 0 ? (
                <p>{t("noParticipants")}</p>
              ) : (
                <>
                  {roomMembers.map((member) => (
                    <article className="participant-row" key={member.memberId}>
                      <span className="participant-avatar human">{member.displayName.slice(0, 1).toUpperCase()}</span>
                      <div><strong>{member.displayName}</strong><small>{member.role === "owner" ? t("teamOwner") : t("teamMember")}</small></div>
                      <span className="participant-kind">{locale === "zh-CN" ? "成员" : "Human"}</span>
                    </article>
                  ))}
                  {roomAgents.map((agent) => (
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
            <button aria-label={t("newTeamMobile")} onClick={() => setTeamDialogOpen(true)} type="button">＋</button>
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
          <div className="workspace-heading">
            <div className="workspace-heading-copy">
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
            {activeView === "room" && selectedRoom && currentMember?.role === "owner" && (
              <div className="header-room-actions">
                <button
                  aria-expanded={roomActionsOpen}
                  aria-haspopup="menu"
                  aria-label={locale === "zh-CN" ? "房间操作" : "Room actions"}
                  className="header-room-more"
                  onClick={() => setRoomActionsOpen((current) => !current)}
                  title={locale === "zh-CN" ? "房间操作" : "Room actions"}
                  type="button"
                >•••</button>
                {roomActionsOpen && (
                  <div aria-label={locale === "zh-CN" ? "房间操作" : "Room actions"} className="header-room-menu" role="menu">
                    <button
                      onClick={() => {
                        setRoomActionsOpen(false);
                        openParticipantDialog();
                      }}
                      role="menuitem"
                      type="button"
                    >{locale === "zh-CN" ? "管理房间成员" : "Manage Room participants"}</button>
                    <button
                      className="archive-room-action"
                      disabled={roomHasActiveWork}
                      onClick={() => {
                        setRoomActionsOpen(false);
                        setArchiveRoomConfirmOpen(true);
                      }}
                      role="menuitem"
                      title={roomHasActiveWork
                        ? (locale === "zh-CN" ? "请先结束当前运行或讨论" : "Finish active Runs or Discussions first")
                        : undefined}
                      type="button"
                    >{locale === "zh-CN" ? "归档房间" : "Archive Room"}</button>
                    <small className={roomHasActiveWork ? "blocked" : ""}>
                      {roomHasActiveWork
                        ? (locale === "zh-CN" ? "存在活动运行或讨论，暂时无法归档。" : "Active Runs or Discussions currently block archival.")
                        : (locale === "zh-CN" ? "归档后可从资源生命周期恢复。" : "Restore later from Resource lifecycle.")}
                    </small>
                  </div>
                )}
              </div>
            )}
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
                  <button aria-label={t("createRoom")} disabled={teamBusy} title={t("createRoom")}>+</button>
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
        {error && <div className="error-banner" role="alert">{errorLabel(error, locale)}</div>}
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
                <button disabled={teamBusy}>{teamBusy ? t("creating") : t("createTeam")}</button>
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
                        <button disabled={teamBusy}>{teamBusy ? t("creating") : t("createInvitation")}</button>
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
                      <article className={`agent-card ${agent.enabled === false ? "disabled" : ""}`} key={agent.agentId}>
                        <div className="agent-card-top">
                          <span className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
                          <span className={`status-badge ${agent.enabled === false ? "offline" : agent.presence}`}>
                            <span className={`presence-dot ${agent.enabled === false ? "offline" : agent.presence}`} />
                            {agent.enabled === false
                              ? (locale === "zh-CN" ? "已停用" : "Disabled")
                              : presenceLabel(agent.presence, locale)}
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
                        {currentMember?.role === "owner" && (
                          <button
                            className="agent-enable-action"
                            disabled={lifecycleBusy}
                            onClick={() => void setAgentEnabled(agent, agent.enabled === false)}
                            type="button"
                          >
                            {agent.enabled === false
                              ? (locale === "zh-CN" ? "重新启用" : "Enable")
                              : (locale === "zh-CN" ? "停用" : "Disable")}
                          </button>
                        )}
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
                <button disabled={teamBusy}>{teamBusy ? t("creating") : t("createRoom")}</button>
              </div>
              <small>{t("addMoreRooms")}</small>
            </form>
          </section>
        ) : messages.length === 0 && pendingRoomMessages.length === 0 ? (
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
              const messageRuns = runs.filter(
                (run) => run.triggerMessageId === message.messageId
              );

              return (
                <article className={`message ${message.senderType}-message`} key={message.messageId}>
                  <span className={`avatar ${message.senderType}`}>{avatarLabel}</span>
                  <div className="message-card">
                    <header>
                      <strong>{senderName}</strong>
                      <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    </header>
                    <MarkdownMessage content={message.content} />
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
            {Object.entries(runOutputs).map(([runId, output]) => {
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
                    <div className="streaming-content">
                      <MarkdownMessage content={output.content} streaming />
                      <span aria-hidden="true" className="streaming-cursor" />
                    </div>
                  </div>
                </article>
              );
            })}
            {pendingRoomMessages.map((pending) => (
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
                      onClick={() => void deliverPendingMessage(pending)}
                      type="button"
                    >{locale === "zh-CN" ? "使用同一消息 ID 重试" : "Retry with the same Message ID"}</button>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}
        {selectedRoom && activeView === "room" && (
          <div className="room-dock">
            {visibleDiscussion && (
              <section className={`discussion-status${visibleDiscussionExpanded ? " expanded" : ""}`} aria-label={locale === "zh-CN" ? "当前智能体讨论" : "Active Agent Discussion"}>
                <button
                  aria-controls={`discussion-details-${visibleDiscussion.discussion.discussionId}`}
                  aria-expanded={visibleDiscussionExpanded}
                  aria-label={locale === "zh-CN"
                    ? `${visibleDiscussionExpanded ? "收起" : "展开"}讨论详情`
                    : `${visibleDiscussionExpanded ? "Collapse" : "Expand"} Discussion details`}
                  className="discussion-status-toggle"
                  onClick={() => setExpandedDiscussionId(visibleDiscussionExpanded
                    ? null
                    : visibleDiscussion.discussion.discussionId)}
                  type="button"
                >
                  <span className={`discussion-state ${visibleDiscussion.discussion.state}`}>
                    {discussionStateLabel(visibleDiscussion.discussion.state, locale)}
                    {visibleDiscussion.discussion.state === "active" && activeDiscussionWaveNumber > 0 &&
                      ` · ${locale === "zh-CN" ? "第" : "wave "}${activeDiscussionWaveNumber}${locale === "zh-CN" ? "轮" : ""}`}
                  </span>
                  <strong className="discussion-status-title">{visibleDiscussion.discussion.goal}</strong>
                  {activeWave && (
                    <span
                      aria-label={locale === "zh-CN"
                        ? `智能体进度 ${activeWaveEndedMembers}/${activeWaveExpectedMembers}`
                        : `Agent progress ${activeWaveEndedMembers}/${activeWaveExpectedMembers}`}
                      className="discussion-status-progress"
                    >{activeWaveEndedMembers}/{activeWaveExpectedMembers}</span>
                  )}
                  <span className="discussion-status-toggle-label">
                    {locale === "zh-CN"
                      ? (visibleDiscussionExpanded ? "收起" : "详情")
                      : (visibleDiscussionExpanded ? "Hide" : "Details")}
                  </span>
                  <span aria-hidden="true" className="discussion-status-chevron">⌄</span>
                </button>
                {visibleDiscussionExpanded && (
                  <div className="discussion-status-details" id={`discussion-details-${visibleDiscussion.discussion.discussionId}`}>
                    <div className="discussion-status-copy">
                      {discussionGoalEditId === visibleDiscussion.discussion.discussionId && (
                        <textarea
                          aria-label={locale === "zh-CN" ? "讨论目标" : "Discussion goal"}
                          className="discussion-goal-editor"
                          onChange={(event) => setDiscussionGoalDraft(event.currentTarget.value)}
                          rows={2}
                          value={discussionGoalDraft}
                        />
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
                  </div>
                )}
              </section>
            )}
            <form className="composer" onSubmit={(event) => void submitComposer(event)}>
              <div className="composer-input">
                <div className="room-policy-summary" aria-label={locale === "zh-CN" ? "当前房间协作策略" : "Current Room collaboration policy"}>
                  <span className={`policy-mode ${selectedRoomPolicy.allowDiscussion ? "discussion" : "single"}`}>
                    {selectedRoomPolicy.allowDiscussion
                      ? (locale === "zh-CN" ? "讨论模式" : "Discussion mode")
                      : (locale === "zh-CN" ? "单次并行回复" : "One-shot replies")}
                  </span>
                  <span>{selectedRoomPolicy.allowAll ? "@all" : (locale === "zh-CN" ? "禁用 @all" : "@all off")}</span>
                  <span>{selectedRoomPolicy.allowAgentMentions
                    ? (locale === "zh-CN"
                        ? `Agent 接力 ${selectedRoomPolicy.maxAgentMentionDepth} 层`
                        : `${selectedRoomPolicy.maxAgentMentionDepth}-level Agent handoff`)
                    : (locale === "zh-CN" ? "Agent 接力关闭" : "Agent handoff off")}</span>
                  {currentMember?.role === "owner" && (
                    <button onClick={openParticipantDialog} type="button">
                      {locale === "zh-CN" ? "房间设置" : "Room settings"}
                    </button>
                  )}
                </div>
                {mentionSearch && (
                  <div className="mention-suggestions" aria-label={t("mentionAgent")} role="listbox">
                    <div className="mention-suggestions-heading">{t("mentionHint")}</div>
                    {mentionOptions.length === 0 ? (
                      <p>{mentionSearch.query === "all"
                        ? !selectedRoomPolicy.allowAll
                          ? (locale === "zh-CN"
                              ? "当前房间设置已禁用 @all"
                              : "@all is disabled by this Room's settings")
                          : (locale === "zh-CN"
                              ? `@all 将在发送时精确匹配当前房间的 ${roomAgents.length} 个智能体`
                              : `@all will exactly target ${roomAgents.length} Agents in this Room on send`)
                        : t("noMentionMatches")}</p>
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
                        : selectedRoomPolicy.allowDiscussion
                          ? (locale === "zh-CN"
                              ? `发送后将发起 ${selectedMentionAgents.length} 个智能体的协作讨论`
                              : `Send to start a ${selectedMentionAgents.length}-Agent Discussion`)
                          : (locale === "zh-CN"
                              ? `发送后将并行触发 ${selectedMentionAgents.length} 个智能体，各回复一次`
                              : `Send to run ${selectedMentionAgents.length} Agents once in parallel`)}
                    </span>
                  </div>
                )}
                {(exactMentionCommands.usesAll || directlyParsedAgents.length > 0 || unresolvedExactAmbiguousNames.length > 0) && (
                  <div className={`exact-mention-preview ${unresolvedExactAmbiguousNames.length > 0 ? "ambiguous" : ""} ${exactMentionCommands.usesAll && !selectedRoomPolicy.allowAll ? "policy-disabled" : ""}`} role="status">
                    {exactMentionCommands.usesAll
                      ? !selectedRoomPolicy.allowAll
                        ? (locale === "zh-CN"
                            ? "精确指令 @all · 当前房间已禁用"
                            : "Exact command @all · disabled in this Room")
                        : (locale === "zh-CN"
                            ? `精确指令 @all · 将路由当前房间 ${exactMentionCommands.agentIds.length} 个智能体`
                            : `Exact command @all · routes to ${exactMentionCommands.agentIds.length} Room Agents`)
                      : unresolvedExactAmbiguousNames.length > 0
                        ? (locale === "zh-CN"
                            ? `同名智能体需要从候选列表明确选择：${unresolvedExactAmbiguousNames.join("、")}`
                            : `Select a specific same-name Agent: ${unresolvedExactAmbiguousNames.join(", ")}`)
                        : (locale === "zh-CN"
                            ? `精确匹配：${directlyParsedAgents.map(({ name }) => `@${name}`).join("、")}`
                            : `Exact match: ${directlyParsedAgents.map(({ name }) => `@${name}`).join(", ")}`)}
                  </div>
                )}
                <textarea
                  aria-label={t("message")}
                  onChange={handleMessageChange}
                  onKeyDown={handleMessageKeyDown}
                  placeholder={locale === "zh-CN"
                    ? `发送消息到 #${selectedRoom.name}；支持 @Agent完整名称${selectedRoomPolicy.allowAll ? " 和 @all" : ""}`
                    : `Message #${selectedRoom.name}; use an exact @Agent name${selectedRoomPolicy.allowAll ? " or @all" : ""}`}
                  required
                  rows={2}
                  value={messageContent}
                />
              </div>
              <button className="composer-send" disabled={composerBusy}>
                {composerBusy ? t("sending") : t("send")}
              </button>
            </form>
          </div>
        )}
      </main>
      {teamDialogOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setTeamDialogOpen(false);
        }}>
          <section
            aria-labelledby="new-team-dialog-title"
            aria-modal="true"
            className="modal-card"
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">{t("teamSpace")}</p>
                <h3 id="new-team-dialog-title">{t("newTeam")}</h3>
              </div>
              <button aria-label={t("cancel")} onClick={() => setTeamDialogOpen(false)} type="button">×</button>
            </div>
            <p>{t("newTeamHelp")}</p>
            <form className="modal-form" onSubmit={createTeam}>
              <label htmlFor="new-team-name">{t("newTeamName")}</label>
              <input
                autoComplete="off"
                autoFocus
                id="new-team-name"
                onChange={(event) => setTeamName(event.target.value)}
                required
                value={teamName}
              />
              <div className="modal-actions">
                <button className="secondary-action" onClick={() => setTeamDialogOpen(false)} type="button">{t("cancel")}</button>
                <button className="primary-action" disabled={teamBusy}>{teamBusy ? t("creating") : t("createTeam")}</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {archiveRoomConfirmOpen && selectedRoom && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !lifecycleBusy) {
            setArchiveRoomConfirmOpen(false);
          }
        }}>
          <section
            aria-labelledby="archive-room-dialog-title"
            aria-modal="true"
            className="modal-card archive-room-modal"
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">{locale === "zh-CN" ? "可恢复操作" : "RECOVERABLE ACTION"}</p>
                <h3 id="archive-room-dialog-title">
                  {locale === "zh-CN" ? `归档 #${selectedRoom.name}` : `Archive #${selectedRoom.name}`}
                </h3>
              </div>
              <button
                aria-label={t("cancel")}
                disabled={lifecycleBusy}
                onClick={() => setArchiveRoomConfirmOpen(false)}
                type="button"
              >×</button>
            </div>
            <p>
              {locale === "zh-CN"
                ? "房间会从普通列表隐藏，但消息、运行、讨论和稳定 ID 都会保留。之后可在资源生命周期中恢复。"
                : "The Room will leave normal navigation while Messages, Runs, Discussions, and stable IDs remain recoverable from Resource lifecycle."}
            </p>
            {roomHasActiveWork && (
              <p className="archive-room-blocked" role="status">
                {locale === "zh-CN"
                  ? "当前仍有运行或讨论，请结束后再归档。"
                  : "Finish the active Runs or Discussion before archiving."}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="secondary-action"
                disabled={lifecycleBusy}
                onClick={() => setArchiveRoomConfirmOpen(false)}
                type="button"
              >{t("cancel")}</button>
              <button
                className="danger-action"
                disabled={lifecycleBusy || roomHasActiveWork}
                onClick={() => void archiveSelectedRoom()}
                type="button"
              >{lifecycleBusy
                  ? (locale === "zh-CN" ? "归档中…" : "Archiving…")
                  : (locale === "zh-CN" ? "确认归档房间" : "Confirm archive")}</button>
            </div>
          </section>
        </div>
      )}
      {lifecycleDialogOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setLifecycleDialogOpen(false);
        }}>
          <section
            aria-labelledby="resource-lifecycle-dialog-title"
            aria-modal="true"
            className="modal-card lifecycle-modal"
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">{locale === "zh-CN" ? "可恢复资源" : "RECOVERABLE RESOURCES"}</p>
                <h3 id="resource-lifecycle-dialog-title">
                  {locale === "zh-CN" ? "管理 Team 与房间" : "Manage Teams and Rooms"}
                </h3>
              </div>
              <button aria-label={t("cancel")} onClick={() => setLifecycleDialogOpen(false)} type="button">×</button>
            </div>
            <p>
              {locale === "zh-CN"
                ? "归档会从普通导航隐藏资源，但会保留消息、运行、讨论和稳定 ID；存在活动任务时会被安全拦截。"
                : "Archiving hides resources from normal navigation while retaining history and stable IDs. Active work blocks the action."}
            </p>
            {lifecycleBusy && lifecycleTeams.length === 0 ? (
              <p>{locale === "zh-CN" ? "正在载入资源…" : "Loading resources…"}</p>
            ) : (
              <div className="lifecycle-layout">
                <nav aria-label={locale === "zh-CN" ? "选择 Team" : "Select Team"} className="lifecycle-team-list">
                  {lifecycleTeams.map((team) => (
                    <button
                      className={team.teamId === lifecycleTeamId ? "active" : ""}
                      key={team.teamId}
                      onClick={() => void selectLifecycleTeam(team.teamId)}
                      type="button"
                    >
                      <strong>{team.name}</strong>
                      <small>{team.archivedAt
                        ? (locale === "zh-CN" ? "已归档" : "Archived")
                        : (locale === "zh-CN" ? "使用中" : "Active")}</small>
                    </button>
                  ))}
                </nav>
                {lifecycleTeam && (
                  <div className="lifecycle-resource-list">
                    <section className="lifecycle-resource-row team-resource">
                      <div>
                        <strong>Team</strong>
                        <small>{lifecycleTeam.teamId}</small>
                      </div>
                      <input
                        aria-label={locale === "zh-CN" ? "Team 名称" : "Team name"}
                        onChange={(event) => setLifecycleNames((current) => ({
                          ...current,
                          [lifecycleTeam.teamId]: event.target.value
                        }))}
                        value={lifecycleNames[lifecycleTeam.teamId] ?? lifecycleTeam.name}
                      />
                      <div className="lifecycle-actions">
                        <button
                          disabled={lifecycleBusy || !lifecycleNames[lifecycleTeam.teamId]?.trim() || lifecycleNames[lifecycleTeam.teamId] === lifecycleTeam.name}
                          onClick={() => void updateLifecycleTeam(lifecycleTeam, {
                            name: lifecycleNames[lifecycleTeam.teamId]!
                          })}
                          type="button"
                        >{locale === "zh-CN" ? "保存名称" : "Save name"}</button>
                        <button
                          className={lifecycleTeam.archivedAt ? "restore-action" : "archive-action"}
                          disabled={lifecycleBusy}
                          onClick={() => void updateLifecycleTeam(lifecycleTeam, {
                            archived: !lifecycleTeam.archivedAt
                          })}
                          type="button"
                        >{lifecycleTeam.archivedAt
                            ? (locale === "zh-CN" ? "恢复 Team" : "Restore Team")
                            : (locale === "zh-CN" ? "归档 Team" : "Archive Team")}</button>
                      </div>
                    </section>
                    <h4>{locale === "zh-CN" ? "房间" : "Rooms"}</h4>
                    {lifecycleRooms.length === 0 ? (
                      <p>{locale === "zh-CN" ? "这个 Team 还没有房间。" : "This Team has no Rooms yet."}</p>
                    ) : lifecycleRooms.map((room) => (
                      <section className="lifecycle-resource-row" key={room.roomId}>
                        <div>
                          <strong># {room.name}</strong>
                          <small>{room.archivedAt
                            ? (locale === "zh-CN" ? "已归档" : "Archived")
                            : (locale === "zh-CN" ? "使用中" : "Active")}</small>
                        </div>
                        <input
                          aria-label={locale === "zh-CN" ? `${room.name} 房间名称` : `${room.name} Room name`}
                          onChange={(event) => setLifecycleNames((current) => ({
                            ...current,
                            [room.roomId]: event.target.value
                          }))}
                          value={lifecycleNames[room.roomId] ?? room.name}
                        />
                        <div className="lifecycle-actions">
                          <button
                            disabled={lifecycleBusy || !lifecycleNames[room.roomId]?.trim() || lifecycleNames[room.roomId] === room.name}
                            onClick={() => void updateLifecycleRoom(room, {
                              name: lifecycleNames[room.roomId]!
                            })}
                            type="button"
                          >{locale === "zh-CN" ? "保存名称" : "Save name"}</button>
                          <button
                            className={room.archivedAt ? "restore-action" : "archive-action"}
                            disabled={lifecycleBusy || Boolean(lifecycleTeam.archivedAt && room.archivedAt)}
                            onClick={() => void updateLifecycleRoom(room, {
                              archived: !room.archivedAt
                            })}
                            type="button"
                          >{room.archivedAt
                              ? (locale === "zh-CN" ? "恢复房间" : "Restore Room")
                              : (locale === "zh-CN" ? "归档房间" : "Archive Room")}</button>
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      {participantDialogOpen && selectedRoom && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setParticipantDialogOpen(false);
        }}>
          <section
            aria-labelledby="room-settings-dialog-title"
            aria-modal="true"
            className="modal-card participant-modal"
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">#{selectedRoom.name}</p>
                <h3 id="room-settings-dialog-title">{t("roomSettings")}</h3>
              </div>
              <button aria-label={t("cancel")} onClick={() => setParticipantDialogOpen(false)} type="button">×</button>
            </div>
            <p>{t("roomSettingsHelp")}</p>
            <form className="modal-form" onSubmit={(event) => void saveRoomParticipants(event)}>
              <fieldset className="room-policy-editor">
                <legend>{locale === "zh-CN" ? "Agent 协作" : "Agent collaboration"}</legend>
                <div className="room-policy-options">
                  <label className="room-policy-switch">
                    <input
                      checked={roomPolicyDraft.allowDiscussion}
                      onChange={(event) => setRoomPolicyDraft((current) => ({
                        ...current,
                        allowDiscussion: event.target.checked
                      }))}
                      type="checkbox"
                    />
                    <span>
                      <strong>{locale === "zh-CN" ? "允许多 Agent 讨论" : "Allow multi-Agent Discussions"}</strong>
                      <small>{locale === "zh-CN"
                        ? "开启后，多 Agent 提及进入有轮次和结论的讨论；关闭后只并行回复一次。"
                        : "When on, multi-Agent mentions start a governed Discussion; when off, each Agent replies once."}</small>
                    </span>
                  </label>
                  <label className="room-policy-switch">
                    <input
                      checked={roomPolicyDraft.allowAll}
                      onChange={(event) => setRoomPolicyDraft((current) => ({
                        ...current,
                        allowAll: event.target.checked
                      }))}
                      type="checkbox"
                    />
                    <span>
                      <strong>{locale === "zh-CN" ? "允许 @all" : "Allow @all"}</strong>
                      <small>{locale === "zh-CN"
                        ? "允许成员用精确 @all 指令选择当前房间全部已启用 Agent。"
                        : "Let members use the exact @all command for every enabled Agent in this Room."}</small>
                    </span>
                  </label>
                  <label className="room-policy-switch">
                    <input
                      checked={roomPolicyDraft.allowAgentMentions}
                      onChange={(event) => setRoomPolicyDraft((current) => ({
                        ...current,
                        allowAgentMentions: event.target.checked
                      }))}
                      type="checkbox"
                    />
                    <span>
                      <strong>{locale === "zh-CN" ? "允许 Agent 互相点名" : "Allow Agent-to-Agent mentions"}</strong>
                      <small>{locale === "zh-CN"
                        ? "Agent 回复中的完整名称 @指令可触发受限接力；模糊名称不会路由。"
                        : "Exact full-name @ commands in Agent replies can trigger bounded handoffs; fuzzy names never route."}</small>
                    </span>
                  </label>
                </div>
                <label className="room-policy-depth">
                  <span>
                    <strong>{locale === "zh-CN" ? "最大接力深度" : "Maximum handoff depth"}</strong>
                    <small>{locale === "zh-CN" ? "限制 Agent 连续互相点名的层数" : "Limits chained Agent-to-Agent mentions"}</small>
                  </span>
                  <select
                    aria-label={locale === "zh-CN" ? "最大接力深度" : "Maximum handoff depth"}
                    disabled={!roomPolicyDraft.allowAgentMentions}
                    onChange={(event) => setRoomPolicyDraft((current) => ({
                      ...current,
                      maxAgentMentionDepth: Number(event.target.value)
                    }))}
                    value={roomPolicyDraft.maxAgentMentionDepth}
                  >
                    {[1, 2, 3, 4].map((depth) => (
                      <option key={depth} value={depth}>{depth}</option>
                    ))}
                  </select>
                </label>
              </fieldset>
              <fieldset className="participant-editor-group">
                <legend>{t("teamMembers")}</legend>
                <div className="participant-editor-list">
                  {members.map((member) => (
                    <label key={member.memberId}>
                      <input
                        checked={participantMemberIds.includes(member.memberId)}
                        disabled={member.role === "owner"}
                        onChange={() => setParticipantMemberIds((current) =>
                          current.includes(member.memberId)
                            ? current.filter((memberId) => memberId !== member.memberId)
                            : [...current, member.memberId]
                        )}
                        type="checkbox"
                      />
                      <span><strong>{member.displayName}</strong><small>{member.role === "owner" ? t("teamOwner") : t("teamMember")}</small></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="participant-editor-group">
                <legend>{t("teamAgents")} · {locale === "zh-CN" ? "单独启用" : "Per-Agent access"}</legend>
                <div className="participant-editor-list">
                  {agents.map((agent) => (
                    <label key={agent.agentId}>
                      <input
                        checked={participantAgentIds.includes(agent.agentId)}
                        disabled={agent.enabled === false}
                        onChange={() => setParticipantAgentIds((current) =>
                          current.includes(agent.agentId)
                            ? current.filter((agentId) => agentId !== agent.agentId)
                            : [...current, agent.agentId]
                        )}
                        type="checkbox"
                      />
                      <span><strong>{agent.name}</strong><small>{roleLabel(agent.role, locale)}</small></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="modal-actions">
                <button className="secondary-action" onClick={() => setParticipantDialogOpen(false)} type="button">{t("cancel")}</button>
                <button className="primary-action" disabled={participantBusy}>{participantBusy ? t("saving") : t("save")}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
