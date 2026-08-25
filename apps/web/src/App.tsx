import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { BridgeJoinApproval } from "@agent-room/contracts/bridge-messages";

import {
  activeRunStates,
  bridgeServerURL,
  invitationTokenFromFragment,
  jsonRequest,
  loadRunOutputEvents,
  localBootstrap
} from "./api-client.js";
import { type Locale, type TranslationKey, translate } from "./i18n.js";
import { AccessGate } from "./features/auth/AccessGate.js";
import {
  AgentWorkspace,
  presenceLabel,
  roleLabel
} from "./features/agent/AgentWorkspace.js";
import { DiscussionStatus } from "./features/discussion/DiscussionStatus.js";
import { useDiscussionController } from "./features/discussion/useDiscussionController.js";
import { RoomTimeline } from "./features/room/RoomTimeline.js";
import { RoomSettingsDialog } from "./features/room/RoomSettingsDialog.js";
import { useRoomComposer } from "./features/room/useRoomComposer.js";
import { TeamMembersWorkspace } from "./features/team/TeamMembersWorkspace.js";
import {
  ResourceLifecycleDialog,
  RoomArchiveDialog,
  TeamCreateDialog
} from "./features/team/TeamDialogs.js";
import { TaskClarifications } from "./features/task/TaskClarifications.js";
import { TaskCreateDialog, TaskSelector } from "./features/task/TaskControls.js";
import {
  type Agent,
  type AgentTask,
  type AuthenticatedUser,
  type AuthGateState,
  type AuthMode,
  type AuthStatus,
  type ConnectionMode,
  type Device,
  type DiscussionView,
  type LocalSession,
  type Member,
  type MemberInvitation,
  type Message,
  type Room,
  type RoomCollaborationPolicy,
  type RoomMessagePage,
  type RoomParticipants,
  type RoomSettings,
  type Run,
  type TaskClarification,
  type Team,
  type TeamChangeCursor,
  type Theme,
  type WorkspaceView,
  defaultRoomCollaborationPolicy
} from "./models.js";
import { errorLabel } from "./presentation.js";
import {
  createSingleFlight,
  mergeRoomMessages,
  reduceRunActivities,
  reduceRunOutput,
  teamChangeRefreshScope,
  type RunActivityProjection,
  type RunEventRecord,
  type RunOutputProjection
} from "./room-sync.js";
import {
  loadRunDiagnostic,
  type RunDiagnostic
} from "./run-diagnostics.js";

function collaborationPolicyFor(room: Room | null): RoomCollaborationPolicy {
  return room?.collaborationPolicy ?? defaultRoomCollaborationPolicy;
}
const localeKey = "agent-room.locale";
const themeKey = "agent-room.theme";

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
  const [runActivities, setRunActivities] = useState<
    Record<string, RunActivityProjection>
  >({});
  const [runDiagnostics, setRunDiagnostics] = useState<
    Record<string, RunDiagnostic | null>
  >({});
  const [discussions, setDiscussions] = useState<DiscussionView[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [clarifications, setClarifications] = useState<TaskClarification[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("room");
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("managed");
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
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
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [clarificationAnswers, setClarificationAnswers] = useState<
    Record<string, string>
  >({});
  const [roomName, setRoomName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [manualAgentName, setManualAgentName] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [setupOutput, setSetupOutput] = useState<string | null>(null);
  const [memberInviteName, setMemberInviteName] = useState("");
  const [memberInvitation, setMemberInvitation] = useState<MemberInvitation | null>(null);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [clarificationBusyId, setClarificationBusyId] = useState<string | null>(null);
  const [participantBusy, setParticipantBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageSyncRef = useRef<{
    roomId: string;
    cursor: string | null;
    sequence: number;
  } | null>(null);
  const diagnosticRequestsRef = useRef(new Set<string>());
  const runOutputSyncRef = useRef(new Map<string, RunOutputProjection>());
  const runActivitySyncRef = useRef(new Map<string, RunActivityProjection>());

  const commitRunOutputEvents = (
    roomRuns: Run[],
    batches: Map<string, RunEventRecord[]>
  ): void => {
    const next = new Map(runOutputSyncRef.current);
    const nextActivities = new Map(runActivitySyncRef.current);
    const visibleRunIds = new Set(roomRuns.map(({ runId }) => runId));
    for (const runId of next.keys()) {
      if (!visibleRunIds.has(runId)) next.delete(runId);
    }
    for (const runId of nextActivities.keys()) {
      if (!visibleRunIds.has(runId)) nextActivities.delete(runId);
    }
    for (const [runId, records] of batches) {
      next.set(runId, reduceRunOutput(next.get(runId), records));
      nextActivities.set(
        runId,
        reduceRunActivities(nextActivities.get(runId), records)
      );
    }
    for (const run of roomRuns) {
      const projection = next.get(run.runId);
      if (projection?.sealed && !activeRunStates.has(run.state)) {
        next.delete(run.runId);
      }
    }
    runOutputSyncRef.current = next;
    runActivitySyncRef.current = nextActivities;
    setRunOutputs(Object.fromEntries(
      [...next].filter(([, projection]) =>
        !projection.sealed && projection.content.length > 0
      )
    ));
    setRunActivities(Object.fromEntries(
      [...nextActivities].filter(([, projection]) => projection.items.length > 0)
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
  const selectedTask = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  );
  const waitingClarifications = clarifications.filter(
    ({ state }) => state === "waiting"
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
  const readyAgents = agents.filter((agent) => agent.presence === "ready").length;
  const managedAgents = agents.filter((agent) => agent.integrationMode === "managed").length;
  const activeDevices = devices.filter((device) => device.status === "active").length;
  const currentMember = members.find((member) => member.userId === session?.userId) ?? null;
  const lifecycleTeam = lifecycleTeams.find(({ teamId }) =>
    teamId === lifecycleTeamId
  ) ?? null;
  const t = (key: TranslationKey) => translate(locale, key);
  const roomHasActiveRuns = runs.some(({ state }) => activeRunStates.has(state));
  const roomHasActiveDiscussion = discussions.some(({ discussion }) =>
    !["completed", "canceled", "terminated"].includes(discussion.state)
  );
  const roomHasActiveWork = roomHasActiveRuns || roomHasActiveDiscussion;
  const {
    activeDiscussion,
    cancelGoalEdit: cancelDiscussionGoalEdit,
    control: controlDiscussion,
    editGoal: editDiscussionGoal,
    expandedId: expandedDiscussionId,
    goalDraft: discussionGoalDraft,
    goalEditId: discussionGoalEditId,
    saveGoal: saveDiscussionGoal,
    setExpandedId: setExpandedDiscussionId,
    setGoalDraft: setDiscussionGoalDraft,
    visibleDiscussion,
    visibleDiscussionExpanded
  } = useDiscussionController({
    discussions,
    onBusy: setBusy,
    onError: setError,
    onRoomStateChanged: refreshRoomState,
    selectedTaskId,
    session
  });
  const {
    busy: composerBusy,
    deliver: deliverPendingMessage,
    directlyParsedAgents,
    exactMentionCommands,
    handleChange: handleMessageChange,
    handleKeyDown: handleMessageKeyDown,
    mentionOptionIndex,
    mentionOptions,
    mentionSearch,
    messageContent,
    pendingMessages: pendingRoomMessages,
    removeMention,
    retainMentionAgentIds,
    selectMention,
    selectedMentionAgents,
    submit: submitComposer,
    unresolvedExactAmbiguousNames
  } = useRoomComposer({
    activeDiscussion,
    agentRoleLabel: (agent) => roleLabel(agent.role, locale),
    agents,
    locale,
    onDelivered: async (message, nextRuns) => {
      setMessages((current) => mergeRoomMessages(current, [message]));
      setRuns((current) => {
        const byId = new Map(current.map((run) => [run.runId, run]));
        for (const run of nextRuns) byId.set(run.runId, run);
        return [...byId.values()];
      });
      await refreshRoomState();
    },
    onError: setError,
    onRoomStateChanged: refreshRoomState,
    roomAgents,
    roomPolicy: selectedRoomPolicy,
    selectedRoomId,
    selectedTaskId,
    session
  });

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

  useLayoutEffect(() => {
    if (!pendingInvitationToken) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`
    );
  }, []);

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
        retainMentionAgentIds(agents
          .filter(({ agentId }) => agentId !== agent.agentId)
          .map(({ agentId }) => agentId));
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
      setRunOutputs({});
      setRunActivities({});
      runOutputSyncRef.current.clear();
      runActivitySyncRef.current.clear();
      setRoomParticipants({ memberIds: [], agentIds: [] });
      setRunDiagnostics({});
      diagnosticRequestsRef.current.clear();
      setDiscussions([]);
      setTasks([]);
      setClarifications([]);
      setClarificationAnswers({});
      setSelectedTaskId(null);
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
    setRunActivities({});
    runOutputSyncRef.current.clear();
    runActivitySyncRef.current.clear();
    setRoomParticipants({ memberIds: [], agentIds: [] });
    setRunDiagnostics({});
    diagnosticRequestsRef.current.clear();
    setTasks([]);
    setClarifications([]);
    setClarificationAnswers({});
    setSelectedTaskId(null);
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
      ),
      jsonRequest<AgentTask[]>(
        `/api/rooms/${selectedRoomId}/tasks`,
        {},
        session.token
      )
    ]).then(async ([page, nextRuns, nextDiscussions, nextSettings, nextTasks]) => {
      const outputBatches = await loadRunOutputEvents(
        nextRuns, runOutputSyncRef.current, runActivitySyncRef.current,
        session.token
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
      setTasks(nextTasks);
      setSelectedTaskId((current) =>
        nextTasks.some(({ taskId }) => taskId === current)
          ? current
          : nextTasks.find(({ state }) =>
              state !== "completed" && state !== "canceled"
            )?.taskId ?? nextTasks[0]?.taskId ?? null
      );
      setRoomParticipants(nextSettings.participants);
      setRooms((current) => current.map((room) =>
        room.roomId === nextSettings.room.roomId ? nextSettings.room : room
      ));
      retainMentionAgentIds(nextSettings.participants.agentIds);
    })
      .catch((reason: unknown) => {
        if (!stopped) setError(String(reason));
      });
    return () => {
      stopped = true;
    };
  }, [selectedRoomId, session]);

  useEffect(() => {
    if (!session || !selectedTaskId) {
      setClarifications([]);
      return;
    }
    let stopped = false;
    void jsonRequest<TaskClarification[]>(
      `/api/tasks/${selectedTaskId}/clarifications`,
      {},
      session.token
    ).then((nextClarifications) => {
      if (!stopped) setClarifications(nextClarifications);
    }).catch((reason: unknown) => {
      if (!stopped) setError(String(reason));
    });
    return () => {
      stopped = true;
    };
  }, [runs, selectedTaskId, session]);

  useEffect(() => {
    if (!session || !selectedTeamId || !selectedRoomId) return;
    let stopped = false;
    let activeController: AbortController | null = null;
    let retryTimer: number | null = null;
    const refresh = async (scope: "events" | "room" | "full") => {
      try {
        if (scope === "events") {
          const nextRuns = await jsonRequest<Run[]>(
            `/api/rooms/${selectedRoomId}/runs`, {}, session.token
          );
          const outputBatches = await loadRunOutputEvents(
            nextRuns, runOutputSyncRef.current, runActivitySyncRef.current,
            session.token
          );
          if (!stopped) {
            setRuns(nextRuns);
            commitRunOutputEvents(nextRuns, outputBatches);
          }
          return;
        }
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
        const [roomState, teamState] = await Promise.all([
          Promise.all([
            jsonRequest<Run[]>(
              `/api/rooms/${selectedRoomId}/runs`, {}, session.token
            ),
            jsonRequest<DiscussionView[]>(
              `/api/rooms/${selectedRoomId}/discussions`, {}, session.token
            ),
            jsonRequest<AgentTask[]>(
              `/api/rooms/${selectedRoomId}/tasks`, {}, session.token
            )
          ]),
          scope === "full"
            ? Promise.all([
                jsonRequest<Agent[]>(
                  `/api/teams/${selectedTeamId}/agents`, {}, session.token
                ),
                jsonRequest<Member[]>(
                  `/api/teams/${selectedTeamId}/members`, {}, session.token
                ),
                jsonRequest<Device[]>(
                  `/api/teams/${selectedTeamId}/devices`, {}, session.token
                ),
                jsonRequest<RoomSettings>(
                  `/api/rooms/${selectedRoomId}/settings`, {}, session.token
                )
              ])
            : Promise.resolve(null)
        ]);
        const [nextRuns, nextDiscussions, nextTasks] = roomState;
        const outputBatches = await loadRunOutputEvents(
          nextRuns, runOutputSyncRef.current, runActivitySyncRef.current,
          session.token
        );
        if (!stopped) {
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
          setTasks(nextTasks);
          setSelectedTaskId((current) =>
            nextTasks.some(({ taskId }) => taskId === current)
              ? current
              : nextTasks.find(({ state }) =>
                  state !== "completed" && state !== "canceled"
                )?.taskId ?? nextTasks[0]?.taskId ?? null
          );
          if (teamState) {
            const [nextAgents, nextMembers, nextDevices, nextSettings] = teamState;
            setAgents(nextAgents);
            setMembers(nextMembers);
            setDevices(nextDevices);
            setRoomParticipants(nextSettings.participants);
            setRooms((current) => current.map((room) =>
              room.roomId === nextSettings.room.roomId ? nextSettings.room : room
            ));
            retainMentionAgentIds(nextSettings.participants.agentIds);
          }
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
    };
    const refreshRoomSingleFlight = createSingleFlight(() => refresh("room"));
    const refreshFullSingleFlight = createSingleFlight(() => refresh("full"));
    const refreshEventsSingleFlight = createSingleFlight(() => refresh("events"));
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
            const refreshScope = teamChangeRefreshScope(change, selectedRoomId);
            if (refreshScope === "full") {
              await refreshFullSingleFlight();
            } else if (refreshScope === "room") {
              await refreshRoomSingleFlight();
            } else if (refreshScope === "events") {
              await refreshEventsSingleFlight();
            }
          } else {
            await delay(250);
          }
        } catch (reason) {
          if (stopped || activeController?.signal.aborted) return;
          await refreshFullSingleFlight();
          await delay(2_000);
        }
      }
    };
    const reconcileVisible = () => {
      if (document.visibilityState === "hidden") {
        activeController?.abort();
      } else {
        void refreshFullSingleFlight();
      }
    };
    document.addEventListener("visibilitychange", reconcileVisible);
    const fallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshFullSingleFlight();
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

  async function createAgentTask(event: FormEvent) {
    event.preventDefault();
    if (
      !session || !selectedRoomId || !taskTitle.trim() || !taskGoal.trim()
    ) return;
    setTaskBusy(true);
    setError(null);
    try {
      const task = await jsonRequest<AgentTask>(
        `/api/rooms/${selectedRoomId}/tasks`,
        {
          method: "POST",
          body: JSON.stringify({ title: taskTitle, goal: taskGoal })
        },
        session.token
      );
      setTasks((current) => [...current, task]);
      setSelectedTaskId(task.taskId);
      setTaskTitle("");
      setTaskGoal("");
      setTaskDialogOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setTaskBusy(false);
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
      retainMentionAgentIds(updated.participants.agentIds);
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
    const [page, nextRuns, nextDiscussions, nextTasks] = await Promise.all([
      jsonRequest<RoomMessagePage>(
        `/api/rooms/${selectedRoomId}/messages?limit=100&tail=true`, {}, session.token
      ),
      jsonRequest<Run[]>(
        `/api/rooms/${selectedRoomId}/runs`, {}, session.token
      ),
      jsonRequest<DiscussionView[]>(
        `/api/rooms/${selectedRoomId}/discussions`, {}, session.token
      ),
      jsonRequest<AgentTask[]>(
        `/api/rooms/${selectedRoomId}/tasks`, {}, session.token
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
    setTasks(nextTasks);
    setSelectedTaskId((current) =>
      nextTasks.some(({ taskId }) => taskId === current)
        ? current
        : nextTasks.find(({ state }) =>
            state !== "completed" && state !== "canceled"
          )?.taskId ?? nextTasks[0]?.taskId ?? null
    );
  }

  async function answerTaskClarification(
    event: FormEvent,
    clarification: TaskClarification
  ) {
    event.preventDefault();
    if (!session || clarificationBusyId) return;
    const answer = clarificationAnswers[clarification.clarificationId]?.trim();
    if (!answer) return;
    setClarificationBusyId(clarification.clarificationId);
    setError(null);
    try {
      const resumed = await jsonRequest<{
        clarification: TaskClarification;
        message: Message;
        run: Run;
      }>(
        `/api/clarifications/${clarification.clarificationId}/answer`,
        { method: "POST", body: JSON.stringify({ answer }) },
        session.token
      );
      setClarifications((current) => current.map((item) =>
        item.clarificationId === resumed.clarification.clarificationId
          ? resumed.clarification
          : item
      ));
      setClarificationAnswers((current) => {
        const next = { ...current };
        delete next[clarification.clarificationId];
        return next;
      });
      await refreshRoomState();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setClarificationBusyId(null);
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
          <TeamMembersWorkspace
            authMode={authMode}
            currentMember={currentMember}
            invitationCopied={invitationCopied}
            locale={locale}
            memberInvitation={memberInvitation}
            memberInviteName={memberInviteName}
            members={members}
            onCopyInvitation={copyMemberInvitation}
            onCreateInvitation={createMemberInvitation}
            onMemberInviteNameChange={setMemberInviteName}
            selectedTeam={selectedTeam}
            sessionUserId={session?.userId ?? null}
            teamBusy={teamBusy}
          />
        ) : activeView === "agents" ? (
          <AgentWorkspace
            activeDevices={activeDevices}
            agentName={agentName}
            agents={agents}
            busy={busy}
            connectionMode={connectionMode}
            currentMemberIsOwner={currentMember?.role === "owner"}
            devices={devices}
            deviceName={deviceName}
            joinCode={joinCode}
            lifecycleBusy={lifecycleBusy}
            locale={locale}
            managedAgents={managedAgents}
            manualAgentName={manualAgentName}
            onAgentNameChange={setAgentName}
            onApproveBridgeJoin={approveBridgeJoin}
            onConnectionModeChange={setConnectionMode}
            onCreateBridgeInvite={createBridgeInvite}
            onCreateFakeAgent={createFakeAgent}
            onCreateManualAgent={createManualAgent}
            onDeviceNameChange={setDeviceName}
            onJoinCodeChange={setJoinCode}
            onManualAgentNameChange={setManualAgentName}
            onRevokeDevice={revokeDevice}
            onSetAgentEnabled={setAgentEnabled}
            readyAgents={readyAgents}
            setupOutput={setupOutput}
          />
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
          <RoomTimeline
            agentsById={agentsById}
            composerBusy={composerBusy}
            locale={locale}
            membersById={membersById}
            messages={messages}
            onCancelRun={cancelRun}
            onRetryPendingMessage={deliverPendingMessage}
            pendingMessages={pendingRoomMessages}
            runActivities={runActivities}
            runDiagnostics={runDiagnostics}
            runOutputs={runOutputs}
            runs={runs}
            runsById={runsById}
            session={session}
          />
        )}
        {selectedRoom && activeView === "room" && (
          <div className="room-dock">
            {visibleDiscussion && (
              <DiscussionStatus
                activeDiscussion={activeDiscussion}
                agentsById={agentsById}
                busy={busy}
                expanded={visibleDiscussionExpanded}
                goalDraft={discussionGoalDraft}
                goalEditId={discussionGoalEditId}
                locale={locale}
                onCancelGoalEdit={cancelDiscussionGoalEdit}
                onControl={controlDiscussion}
                onEditGoal={editDiscussionGoal}
                onGoalDraftChange={setDiscussionGoalDraft}
                onSaveGoal={saveDiscussionGoal}
                onToggle={() => setExpandedDiscussionId(visibleDiscussionExpanded
                  ? null
                  : visibleDiscussion.discussion.discussionId)}
                runsById={runsById}
                visibleDiscussion={visibleDiscussion}
              />
            )}
            <TaskClarifications
              agentsById={agentsById}
              answers={clarificationAnswers}
              busyId={clarificationBusyId}
              clarifications={waitingClarifications}
              locale={locale}
              onAnswer={answerTaskClarification}
              onAnswerChange={(clarificationId, value) => setClarificationAnswers((current) => ({
                ...current,
                [clarificationId]: value
              }))}
            />
            <form className="composer" onSubmit={(event) => void submitComposer(event)}>
              <div className="composer-input">
                <TaskSelector
                  locale={locale}
                  onCreate={() => setTaskDialogOpen(true)}
                  onSelect={setSelectedTaskId}
                  selectedTask={selectedTask}
                  selectedTaskId={selectedTaskId}
                  tasks={tasks}
                />
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
              <button
                className="composer-send"
                disabled={composerBusy || !selectedTask ||
                  selectedTask.state === "completed" ||
                  selectedTask.state === "canceled"}
              >
                {composerBusy ? t("sending") : t("send")}
              </button>
            </form>
          </div>
        )}
      </main>
      {taskDialogOpen && selectedRoom && (
        <TaskCreateDialog
          busy={taskBusy}
          goal={taskGoal}
          locale={locale}
          onClose={() => setTaskDialogOpen(false)}
          onGoalChange={setTaskGoal}
          onSubmit={createAgentTask}
          onTitleChange={setTaskTitle}
          roomName={selectedRoom.name}
          title={taskTitle}
        />
      )}
      {teamDialogOpen && (
        <TeamCreateDialog
          busy={teamBusy}
          locale={locale}
          name={teamName}
          onClose={() => setTeamDialogOpen(false)}
          onNameChange={setTeamName}
          onSubmit={createTeam}
        />
      )}
      {archiveRoomConfirmOpen && selectedRoom && (
        <RoomArchiveDialog
          busy={lifecycleBusy}
          hasActiveWork={roomHasActiveWork}
          locale={locale}
          onArchive={archiveSelectedRoom}
          onClose={() => setArchiveRoomConfirmOpen(false)}
          room={selectedRoom}
        />
      )}
      {lifecycleDialogOpen && (
        <ResourceLifecycleDialog
          busy={lifecycleBusy}
          locale={locale}
          names={lifecycleNames}
          onClose={() => setLifecycleDialogOpen(false)}
          onNameChange={(resourceId, value) => setLifecycleNames((current) => ({
            ...current,
            [resourceId]: value
          }))}
          onSelectTeam={selectLifecycleTeam}
          onUpdateRoom={updateLifecycleRoom}
          onUpdateTeam={updateLifecycleTeam}
          rooms={lifecycleRooms}
          selectedTeam={lifecycleTeam}
          selectedTeamId={lifecycleTeamId}
          teams={lifecycleTeams}
        />
      )}
      {participantDialogOpen && selectedRoom && (
        <RoomSettingsDialog
          agents={agents}
          busy={participantBusy}
          locale={locale}
          members={members}
          onClose={() => setParticipantDialogOpen(false)}
          onPolicyChange={setRoomPolicyDraft}
          onSubmit={saveRoomParticipants}
          onToggleAgent={(agentId) => setParticipantAgentIds((current) =>
            current.includes(agentId)
              ? current.filter((currentAgentId) => currentAgentId !== agentId)
              : [...current, agentId]
          )}
          onToggleMember={(memberId) => setParticipantMemberIds((current) =>
            current.includes(memberId)
              ? current.filter((currentMemberId) => currentMemberId !== memberId)
              : [...current, memberId]
          )}
          participantAgentIds={participantAgentIds}
          participantMemberIds={participantMemberIds}
          policy={roomPolicyDraft}
          room={selectedRoom}
        />
      )}
    </div>
  );
}
