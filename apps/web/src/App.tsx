import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useState
} from "react";

import type { BridgeJoinApproval } from "@agent-room/contracts/bridge-messages";

import { type Locale, type TranslationKey, translate } from "./i18n.js";

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

interface LocalSession {
  userId: string;
  displayName: string;
  token: string;
}

interface MentionSearch {
  end: number;
  query: string;
  start: number;
}

const userKey = "agent-room.local-user";
const localeKey = "agent-room.locale";
const themeKey = "agent-room.theme";

type WorkspaceView = "room" | "agents";
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

async function bootstrap(): Promise<LocalSession> {
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

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(themeKey) === "light" ? "light" : "dark"
  );
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem(localeKey) === "en" ? "en" : "zh-CN"
  );
  const [session, setSession] = useState<LocalSession | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
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
  const [messageContent, setMessageContent] = useState("");
  const [mentionAgentId, setMentionAgentId] = useState("");
  const [mentionSearch, setMentionSearch] = useState<MentionSearch | null>(null);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const mentionOptions = useMemo(() => {
    if (!mentionSearch) return [];
    const query = mentionSearch.query.toLocaleLowerCase(locale);
    return agents.filter((agent) =>
      agent.name.toLocaleLowerCase(locale).includes(query) ||
      roleLabel(agent.role, locale).toLocaleLowerCase(locale).includes(query)
    ).slice(0, 8);
  }, [agents, locale, mentionSearch]);
  const selectedMentionAgent = mentionAgentId
    ? agentsById.get(mentionAgentId) ?? null
    : null;
  const readyAgents = agents.filter((agent) => agent.presence === "ready").length;
  const managedAgents = agents.filter((agent) => agent.integrationMode === "managed").length;
  const activeDevices = devices.filter((device) => device.status === "active").length;
  const t = (key: TranslationKey) => translate(locale, key);

  useEffect(() => {
    localStorage.setItem(localeKey, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    localStorage.setItem(themeKey, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  async function loadTeams(activeSession: LocalSession) {
    const next = await jsonRequest<Team[]>("/api/teams", {}, activeSession.token);
    setTeams(next);
    setSelectedTeamId((current) => current ?? next[0]?.teamId ?? null);
  }

  useEffect(() => {
    void bootstrap()
      .then(async (next) => {
        setSession(next);
        await loadTeams(next);
      })
      .catch((reason: unknown) => setError(String(reason)));
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
      setMentionAgentId((current) =>
        nextAgents.some((agent) => agent.agentId === current) ? current : ""
      );
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
      return;
    }
    void Promise.all([
      jsonRequest<{ items: Message[] }>(
        `/api/rooms/${selectedRoomId}/messages?limit=100`,
        {},
        session.token
      ),
      jsonRequest<Run[]>(
        `/api/rooms/${selectedRoomId}/runs`,
        {},
        session.token
      )
    ]).then(([page, nextRuns]) => {
      setMessages(page.items);
      setRuns(nextRuns);
    })
      .catch((reason: unknown) => setError(String(reason)));
  }, [selectedRoomId, session]);

  useEffect(() => {
    if (!session || !selectedTeamId || !selectedRoomId) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const [nextAgents, nextMembers, nextDevices, page, nextRuns] = await Promise.all([
          jsonRequest<Agent[]>(
            `/api/teams/${selectedTeamId}/agents`, {}, session.token
          ),
          jsonRequest<Member[]>(
            `/api/teams/${selectedTeamId}/members`, {}, session.token
          ),
          jsonRequest<Device[]>(
            `/api/teams/${selectedTeamId}/devices`, {}, session.token
          ),
          jsonRequest<{ items: Message[] }>(
            `/api/rooms/${selectedRoomId}/messages?limit=100`, {}, session.token
          ),
          jsonRequest<Run[]>(
            `/api/rooms/${selectedRoomId}/runs`, {}, session.token
          )
        ]);
        if (!stopped) {
          setAgents(nextAgents);
          setMembers(nextMembers);
          setDevices(nextDevices);
          setMessages(page.items);
          setRuns(nextRuns);
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [selectedRoomId, selectedTeamId, session]);

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

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedRoomId || !messageContent.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jsonRequest<{ message: Message; runs: Run[] }>(
        `/api/rooms/${selectedRoomId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content: messageContent,
            ...(mentionAgentId ? { mentionAgentId } : {})
          })
        },
        session.token
      );
      setMessageContent("");
      setMentionAgentId("");
      setMentionSearch(null);
      const [page, nextRuns] = await Promise.all([
        jsonRequest<{ items: Message[] }>(
          `/api/rooms/${selectedRoomId}/messages?limit=100`,
          {},
          session.token
        ),
        jsonRequest<Run[]>(
          `/api/rooms/${selectedRoomId}/runs`,
          {},
          session.token
        )
      ]);
      setMessages(page.items);
      setRuns(nextRuns);
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
    if (selectedMentionAgent && !nextContent.includes(`@${selectedMentionAgent.name}`)) {
      setMentionAgentId("");
    }
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
    const nextContent = [
      messageContent.slice(0, mentionSearch.start),
      `@${agent.name} `,
      messageContent.slice(mentionSearch.end)
    ].join("");
    setMessageContent(nextContent);
    setMentionAgentId(agent.agentId);
    setMentionSearch(null);
    setMentionOptionIndex(0);
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
          <button
            aria-label={t("agentManagement")}
            className={activeView === "agents" ? "rail-manage active" : "rail-manage"}
            onClick={revealConnectionSetup}
            title={t("agentManagement")}
            type="button"
          >✦</button>
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
          </div>
        </nav>
        <header className="workspace-header">
          <div>
            <p className="eyebrow">{activeView === "agents" && selectedTeam ? t("controlPlane") : t("room")}</p>
            <h2>
              {activeView === "agents" && selectedTeam
                ? t("agentsDevices")
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
            {messages.map((message) => (
              <article className="message" key={message.messageId}>
                <span className={`avatar ${message.senderType}`}>{message.senderType === "agent" ? "A" : "U"}</span>
                <div>
                  <header>
                    <strong>{message.senderType === "agent" ? t("agent") : session?.displayName}</strong>
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
                        <span className="run-card" key={run.runId} title={run.runId}>
                          <strong>{agentsById.get(run.targetAgentId)?.name ?? t("agent")}</strong>
                          <span className={`run-state ${run.state}`}>
                            {runStateLabel(run.state, locale)}
                          </span>
                          {["queued", "delivered", "working", "input_required"].includes(run.state) && (
                            <button type="button" onClick={() => void cancelRun(run.runId)}>{t("cancel")}</button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}
        {selectedRoom && activeView === "room" && (
          <form className="composer" onSubmit={sendMessage}>
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
              {selectedMentionAgent && (
                <span className="selected-mention">
                  {t("mentionSelected")} @{selectedMentionAgent.name}
                </span>
              )}
              <textarea
                aria-label={t("message")}
                onChange={handleMessageChange}
                onKeyDown={handleMessageKeyDown}
                placeholder={locale === "zh-CN" ? `发送消息到 #${selectedRoom.name}，输入 @ 提及智能体` : `Message #${selectedRoom.name}; type @ to mention an Agent`}
                required
                rows={2}
                value={messageContent}
              />
            </div>
            <button className="composer-send" disabled={busy}>{busy ? t("sending") : t("send")}</button>
          </form>
        )}
        {error && <div className="error-banner" role="alert">{errorLabel(error, locale)}</div>}
      </main>
    </div>
  );
}
