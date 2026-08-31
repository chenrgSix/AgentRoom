import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { BridgeJoinApproval } from "@convene-wire/contracts/bridge-messages";
import type { LifecycleState } from "@convene-wire/contracts/task-result";

import {
  activeRunStates,
  bridgeServerURL,
  captureWebSessionScope,
  HttpRequestError,
  invitationTokenFromFragment,
  isStaleWebSessionError,
  jsonRequest,
  loadRunOutputEvents,
  localBootstrap,
} from "./api-client.js";
import { type Locale, type TranslationKey, translate } from "./i18n.js";
import { AccessGate } from "./features/auth/AccessGate.js";
import { AccountWorkspace } from "./features/auth/AccountWorkspace.js";
import { DeviceWorkspace } from "./features/device/DeviceWorkspace.js";
import { WorkspaceSidebar } from "./features/navigation/WorkspaceSidebar.js";
import { PanelDialog } from "./features/navigation/PanelDialog.js";
import { isManagementView, type WorkspaceNavigation } from "./features/navigation/workspace-navigation.js";
import { useWebSession } from "./features/auth/useWebSession.js";
import { useRoomSynchronization } from "./features/room/useRoomSynchronization.js";
import { AgentSetupChoices, type AgentSetupTarget } from "./features/agent/AgentSetupChoices.js";
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
import { clearComposerUserState } from "./features/room/composer-storage.js";
import { useWorkspaceNavigation } from "./features/navigation/useWorkspaceNavigation.js";
import { TeamMembersWorkspace } from "./features/team/TeamMembersWorkspace.js";
import {
  ResourceLifecycleDialog,
  RoomArchiveDialog,
  TeamCreateDialog
} from "./features/team/TeamDialogs.js";
import { TaskClarifications } from "./features/task/TaskClarifications.js";
import { MemoryCandidateReview } from "./features/task/MemoryCandidateReview.js";
import { ArtifactPreviewPanel } from "./features/task/ArtifactPreviewPanel.js";
import { TaskCreateDialog, TaskSelector } from "./features/task/TaskControls.js";
import { parseTaskCriteria } from "./features/task/task-criteria.js";
import { TaskWorkDetail, type TaskWorkDetailTab } from "./features/work/TaskWorkDetail.js";
import { WorkWorkspace, workActionTarget } from "./features/work/WorkWorkspace.js";
import { useWorkbench } from "./features/work/useWorkbench.js";
import {
  type Agent,
  type AgentTask,
  type ArtifactPreview,
  type AuthenticatedUser,
  type AuthMode,
  type AuthStatus,
  type ConnectionMode,
  type Device,
  type DiscussionView,
  type LocalSession,
  type Member,
  type MemberInvitation,
  type MemoryCandidate,
  type Message,
  type Room,
  type RoomCollaborationPolicy,
  type RoomParticipants,
  type RoomSettings,
  type Run,
  type TaskClarification,
  type TaskArtifact,
  type TaskArtifactPage,
  type Team,
  type Theme,
  type WorkspaceView,
  defaultRoomCollaborationPolicy
} from "./models.js";
import { errorLabel } from "./presentation.js";
import {
  mergeRoomMessages,
  reduceRunActivities,
  reduceRunOutput,
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

// Browser storage keys are installation state, not visible branding.
const localeKey = "agent-room.locale";
const themeKey = "agent-room.theme";

export function App() {
  const isCurrentSession = captureWebSessionScope();
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(themeKey) === "light" ? "light" : "dark"
  );
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem(localeKey) === "en" ? "en" : "zh-CN"
  );
  const { session, authMode, authState, setAuthMode, setAuthState,
    activate: activateWebSession, clear: clearAuthenticatedSession
  } = useWebSession(resetAuthenticatedWorkspace);
  const [pendingInvitationToken, setPendingInvitationToken] = useState<string | null>(() =>
    invitationTokenFromFragment(window.location.hash)
  );
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomSettingsContext, setRoomSettingsContext] = useState<string | null>(null);
  const [roomParticipants, setRoomParticipants] = useState<RoomParticipants>({
    memberIds: [],
    agentIds: []
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderMessageCursor, setOlderMessageCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
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
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null);
  const [artifactPreviewBusyId, setArtifactPreviewBusyId] = useState<string | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [memoryCandidates, setMemoryCandidates] = useState<MemoryCandidate[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkTaskId, setSelectedWorkTaskId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceView>("work");
  const [workScope, setWorkScope] = useState<"mine" | "team">("mine");
  const [workLifecycleState, setWorkLifecycleState] = useState<LifecycleState | "">("");
  const [workOwnerMemberId, setWorkOwnerMemberId] = useState("");
  const [workSearch, setWorkSearch] = useState("");
  const [selectedWorkTab, setSelectedWorkTab] = useState<TaskWorkDetailTab>("overview");
  const [selectedWorkRunId, setSelectedWorkRunId] = useState<string | null>(null);
  const {
    items: workbenchItems,
    loading: workbenchLoading,
    loadingMore: workbenchLoadingMore,
    error: workbenchError,
    hasMore: workbenchHasMore,
    refresh: refreshWorkbenchState,
    loadMore: loadMoreWork
  } = useWorkbench({
    teamId: selectedTeamId, session, scope: workScope,
    lifecycleState: workLifecycleState, ownerMemberId: workOwnerMemberId, search: workSearch
  });
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("managed");
  const [agentSetupTarget, setAgentSetupTarget] = useState<AgentSetupTarget | null>(null);
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
  const [taskCriteria, setTaskCriteria] = useState("");
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
  const [memoryCandidateBusyId, setMemoryCandidateBusyId] = useState<string | null>(null);
  const [participantBusy, setParticipantBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reportError = (reason: unknown) => {
    if (!isStaleWebSessionError(reason)) setError(String(reason));
  };
  const diagnosticRequestsRef = useRef(new Set<string>());
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const roomContextRef = useRef("");
  roomContextRef.current = JSON.stringify([selectedTeamId, selectedRoomId, session?.userId, session?.token]);
  const runOutputSyncRef = useRef(new Map<string, RunOutputProjection>());
  const runActivitySyncRef = useRef(new Map<string, RunActivityProjection>());
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  const pendingRoomTaskIdRef = useRef<string | null>(null);
  const preferredRoomRef = useRef<{ teamId: string; roomId: string } | null>(null);
  selectedTaskIdRef.current = selectedTaskId;

  const [roomCreateOpen, setRoomCreateOpen] = useState(false);
  const setupContext = useRef({});
  function clearSetupPresentation() {
    setupContext.current = {};
    setSetupOutput(null);
    setJoinCode("");
    setMemberInvitation(null);
    setInvitationCopied(false);
  }
  useLayoutEffect(clearSetupPresentation, [activeView, selectedTeamId, session]);
  const managing = isManagementView(activeView);
  const navigationSnapshot: WorkspaceNavigation = {
    teamId: selectedTeamId ?? undefined, roomId: selectedRoomId ?? undefined,
    view: activeView, taskId: activeView === "room" ? selectedTaskId ?? undefined : undefined,
    workTaskId: activeView === "work" ? selectedWorkTaskId ?? undefined : undefined,
    tab: activeView === "work" && selectedWorkTaskId ? selectedWorkTab : undefined,
    runId: activeView === "work" && selectedWorkTaskId ? selectedWorkRunId ?? undefined : undefined,
    scope: workScope, lifecycleState: workLifecycleState || undefined,
    ownerMemberId: workOwnerMemberId || undefined, search: workSearch || undefined
  };
  const collaborationLocation = useRef<{ session: LocalSession; location: WorkspaceNavigation } | null>(null);
  if (session && !managing) collaborationLocation.current = { session, location: navigationSnapshot };

  const { navigate, copyLink, copyStatus, restoring: restoringNavigation } = useWorkspaceNavigation({
    session, teams, ready: teamsLoaded, locale,
    snapshot: navigationSnapshot,
    onRestore: (navigation) => {
      const teamId = navigation.teamId ?? selectedTeamId;
      const roomId = navigation.roomId ?? null;
      if (teamId && roomId) preferredRoomRef.current = { teamId, roomId };
      else preferredRoomRef.current = null;
      const taskId = navigation.taskId ?? null;
      if (taskId && roomId !== selectedRoomId) pendingRoomTaskIdRef.current = taskId;
      else { pendingRoomTaskIdRef.current = null; if (taskId) setSelectedTaskId(taskId); }
      setSelectedTeamId(teamId);
      if (roomId) setSelectedRoomId(roomId);
      setActiveView(navigation.view ?? (navigation.workTaskId ? "work" : navigation.taskId ? "room" : "work"));
      setSelectedWorkTaskId(navigation.workTaskId ?? null);
      setSelectedWorkTab(navigation.tab ?? "overview");
      setSelectedWorkRunId(navigation.runId ?? null);
      setWorkScope(navigation.scope ?? "mine");
      setWorkLifecycleState(navigation.lifecycleState ?? "");
      setWorkOwnerMemberId(navigation.ownerMemberId ?? "");
      setWorkSearch(navigation.search ?? "");
    },
    onError: setError
  });

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

  const { refresh: refreshRoomState, loadOlder: loadOlderMessages } = useRoomSynchronization({
    teamId: selectedTeamId, roomId: selectedRoomId, session,
    onReset: () => {
      setMessages([]); setRuns([]); setDiscussions([]); setTasks([]);
      setRunOutputs({}); setRunActivities({});
      runOutputSyncRef.current.clear(); runActivitySyncRef.current.clear();
      setRoomParticipants({ memberIds: [], agentIds: [] });
      setRoomSettingsContext(null);
      setRunDiagnostics({}); diagnosticRequestsRef.current.clear();
      setClarifications([]); setMemoryCandidates([]); setClarificationAnswers({});
      setSelectedTaskId(null);
      setOlderMessageCursor(null); setHistoryLoading(false); setHistoryError(null);
    },
    onMessages: (items) => setMessages((current) => mergeRoomMessages(current, items, Infinity)),
    onHistory: ({ olderCursor, loading, error }) => {
      setOlderMessageCursor(olderCursor); setHistoryLoading(loading); setHistoryError(error);
    },
    onSnapshot: (snapshot) => {
      setRuns(snapshot.runs); setDiscussions(snapshot.discussions);
      setTasks(snapshot.tasks); setMemoryCandidates(snapshot.memoryCandidates);
      if (snapshot.outputs) commitRunOutputEvents(snapshot.runs, snapshot.outputs);
      const pendingTaskId = pendingRoomTaskIdRef.current;
      setSelectedTaskId((current) =>
        pendingTaskId && snapshot.tasks.some(({ taskId }) => taskId === pendingTaskId)
          ? pendingTaskId : snapshot.tasks.some(({ taskId }) => taskId === current)
          ? current : snapshot.tasks.find(({ state }) => state !== "completed" && state !== "canceled")?.taskId
            ?? snapshot.tasks[0]?.taskId ?? null);
      pendingRoomTaskIdRef.current = null;
      if (snapshot.registry) {
        setAgents(snapshot.registry.agents); setMembers(snapshot.registry.members); setDevices(snapshot.registry.devices);
      }
      if (snapshot.settings) {
        const settings = snapshot.settings;
        setRoomSettingsContext(roomContextRef.current);
        setRoomParticipants(settings.participants);
        setRooms((current) => current.map((room) => room.roomId === settings.room.roomId ? settings.room : room));
        retainMentionAgentIds(settings.participants.agentIds);
      }
    },
    loadOutputs: (roomRuns) => loadRunOutputEvents(roomRuns, runOutputSyncRef.current, runActivitySyncRef.current, session?.token),
    onEvents: (roomRuns, outputs) => { setRuns(roomRuns); commitRunOutputEvents(roomRuns, outputs); },
    refreshWorkbench: refreshWorkbenchState,
    onError: reportError
  });

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
  const roomNames = useMemo(
    () => new Map(rooms.map((room) => [room.roomId, room.name])),
    [rooms]
  );
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.memberId, member.displayName])),
    [members]
  );
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent.name])),
    [agents]
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
  const readyAgents = agents.filter((agent) => agent.enabled !== false && agent.presence === "ready").length;
  const readyRoomAgents = roomAgents.filter((agent) => agent.enabled !== false && agent.presence === "ready");
  const hasRealRoomReply = messages.some((message) => message.senderType === "agent" &&
    agents.some((agent) => agent.agentId === message.senderId && agent.integrationMode !== "fake"));
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
    onBusy: (next) => { if (isCurrentSession()) setBusy(next); },
    onError: (next) => { if (isCurrentSession()) setError(next); },
    onRoomStateChanged: refreshRoomState,
    selectedTaskId,
    session
  });
  const {
    busy: composerBusy,
    changeKeepMentions,
    deliver: deliverPendingMessage,
    directlyParsedAgents,
    exactMentionCommands,
    handleChange: handleMessageChange,
    handleKeyDown: handleMessageKeyDown,
    hasMessageText,
    keepMentions,
    mentionOptionIndex,
    mentionOptions,
    mentionSearch,
    messageContent,
    pendingMessages: pendingRoomMessages,
    persistenceStatus,
    clearDraft,
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
      if (!isCurrentSession()) return;
      setMessages((current) => mergeRoomMessages(current, [message], Infinity));
      setRuns((current) => {
        const byId = new Map(current.map((run) => [run.runId, run]));
        for (const run of nextRuns) byId.set(run.runId, run);
        return [...byId.values()];
      });
      await refreshRoomState();
    },
    onError: (next) => { if (isCurrentSession()) setError(next); },
    onRoomStateChanged: refreshRoomState,
    roomAgents,
    roomAgentsReady: roomSettingsContext === roomContextRef.current,
    roomPolicy: selectedRoomPolicy,
    selectedTeamId,
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
    setTeamsLoaded(true);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setLifecycleBusy(false);
    }
  }

  async function selectLifecycleTeam(teamId: string) {
    if (!session) return;
    setLifecycleBusy(true);
    setError(null);
    try {
      await loadLifecycleResources(session, teamId);
    } catch (reason) {
      reportError(reason);
    } finally {
      if (isCurrentSession()) setLifecycleBusy(false);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setLifecycleBusy(false);
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
      reportError(reason);
      return false;
    } finally {
      if (isCurrentSession()) setLifecycleBusy(false);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setLifecycleBusy(false);
    }
  }

  async function activateSession(
    user: AuthenticatedUser,
    mode: AuthMode,
    token?: string
  ) {
    const next = activateWebSession(user, mode, token);
    setBusy(false);
    await loadTeams(next);
  }

  async function enterLocalSession() {
    setBusy(true);
    setError(null);
    try {
      const next = await localBootstrap();
      await activateSession(next, "local", next.token);
    } catch (reason) {
      if (isStaleWebSessionError(reason)) return;
      setAuthState("local_bootstrap");
      reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function recoverMember(token: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await jsonRequest<{ user: AuthenticatedUser }>("/api/auth/recover-member", {
        method: "POST",
        body: JSON.stringify({ token })
      });
      await activateSession(result.user, "trusted-team");
    } catch (reason) {
      reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
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
        if (!stopped) reportError(reason);
      });
    return () => {
      stopped = true;
    };
  }, []);

  useLayoutEffect(() => {
    setRooms([]);
    setMembers([]);
    setAgents([]);
    setDevices([]);
    setSelectedRoomId(null);
    if (!session || !selectedTeamId) return;
    let stopped = false;
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
      if (stopped) return;
      setRooms(nextRooms);
      setAgents(nextAgents);
      setMembers(nextMembers);
      setDevices(nextDevices);
      setSelectedRoomId((current) =>
        preferredRoomRef.current?.teamId === selectedTeamId && nextRooms.some((room) => room.roomId === preferredRoomRef.current?.roomId)
          ? preferredRoomRef.current.roomId
          : nextRooms.some((room) => room.roomId === current)
          ? current
          : nextRooms[0]?.roomId ?? null
      );
    }).catch((reason: unknown) => { if (!stopped) reportError(reason); });
    return () => { stopped = true; };
  }, [selectedTeamId, session]);

  useEffect(() => {
    setAgentSetupTarget(null);
    setSetupOutput(null);
    setJoinCode("");
    setAgentName("");
    setManualAgentName("");
    setDeviceName("");
    setMemberInviteName("");
    setRoomName("");
    setMemberInvitation(null);
    setInvitationCopied(false);
    setRoomCreateOpen(false);
  }, [selectedTeamId]);

  useEffect(() => {
    if (!session || !selectedTaskId) {
      setClarifications([]);
      setArtifacts([]);
      setArtifactPreview(null);
      setArtifactPreviewError(null);
      return;
    }
    let stopped = false;
    setArtifactPreview((current) =>
      current?.taskId === selectedTaskId ? current : null
    );
    setArtifacts((current) => current.every(({ taskId }) =>
      taskId === selectedTaskId
    ) ? current : []);
    setArtifactPreviewError(null);
    void jsonRequest<TaskClarification[]>(
      `/api/tasks/${selectedTaskId}/clarifications`,
      {},
      session.token
    ).then((nextClarifications) => {
      if (!stopped) setClarifications(nextClarifications);
    }).catch((reason: unknown) => {
      if (!stopped) reportError(reason);
    });
    void jsonRequest<TaskArtifactPage>(
      `/api/tasks/${selectedTaskId}/artifacts`,
      {},
      session.token
    ).then((artifactPage) => {
      if (!stopped) setArtifacts(artifactPage.artifacts);
    }).catch((reason: unknown) => {
      if (!stopped && !isStaleWebSessionError(reason)) setArtifactPreviewError(String(reason));
    });
    return () => {
      stopped = true;
    };
  }, [runs, selectedTaskId, session]);

  useEffect(() => {
    if (!session || !selectedRoomId) return;
    const context = roomContextRef.current;
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
        if (roomContextRef.current === context && isCurrentSession()) {
          setRunDiagnostics((current) => ({
            ...current,
            [run.runId]: diagnostic
          }));
        }
      }).catch((reason: unknown) => {
        diagnosticRequestsRef.current.delete(run.runId);
        if (roomContextRef.current === context && isCurrentSession()) {
          reportError(reason);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setTeamBusy(false);
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !roomName.trim()) return;
    const context = setupContext.current;
    setTeamBusy(true);
    setError(null);
    try {
      const room = await jsonRequest<Room>(
        `/api/teams/${selectedTeamId}/rooms`,
        { method: "POST", body: JSON.stringify({ name: roomName }) },
        session.token
      );
      if (context !== setupContext.current) return;
      setRoomName("");
      setRooms((current) => [...current, room]);
      setRoomCreateOpen(false);
      navigate({ roomId: room.roomId, view: "room", taskId: undefined, workTaskId: undefined, tab: undefined, runId: undefined });
    } catch (reason) {
      reportError(reason);
    } finally {
      if (isCurrentSession()) setTeamBusy(false);
    }
  }

  async function createAgentTask(event: FormEvent) {
    event.preventDefault();
    if (
      !session || !selectedRoomId || !taskTitle.trim() || !taskGoal.trim()
    ) return;
    setTaskBusy(true);
    setError(null);
    const context = roomContextRef.current;
    const originView = activeView;
    try {
      const task = await jsonRequest<AgentTask>(
        `/api/rooms/${selectedRoomId}/tasks`,
        {
          method: "POST",
          body: JSON.stringify({ title: taskTitle, goal: taskGoal, criteria: parseTaskCriteria(taskCriteria, locale) })
        },
        session.token
      );
      if (!isCurrentSession() || roomContextRef.current !== context) return;
      // Reconcile the successful creation before exposing its selection. This
      // also fences an older initial snapshot still waiting on Run output.
      try { await refreshRoomState(); } catch (reason) { reportError(reason); }
      if (!isCurrentSession() || roomContextRef.current !== context) return;
      setTasks((current) => [...current.filter(({ taskId }) => taskId !== task.taskId), task]);
      setSelectedTaskId(task.taskId);
      setTaskTitle("");
      setTaskGoal("");
      setTaskCriteria("");
      setTaskDialogOpen(false);
      if (originView === "work") openWorkbenchTask(task.taskId, selectedRoomId);
      else navigate({ taskId: task.taskId, workTaskId: undefined, view: "room" });
      void refreshWorkbenchState();
    } catch (reason) {
      reportError(reason);
    } finally {
      if (isCurrentSession()) setTaskBusy(false);
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setParticipantBusy(false);
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
      if (isStaleWebSessionError(reason)) return;
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
        reportError(reason);
      }
    } finally {
      if (isCurrentSession()) setParticipantBusy(false);
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
    const context = setupContext.current;
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
      if (context !== setupContext.current) return;
      setMemberInviteName("");
      setMemberInvitation(invitation);
      setInvitationCopied(false);
    } catch (reason) {
      if (context === setupContext.current) reportError(reason);
    } finally {
      if (isCurrentSession()) setTeamBusy(false);
    }
  }

  async function copyMemberInvitation() {
    if (!memberInvitation) return;
    const context = setupContext.current;
    try {
      await navigator.clipboard.writeText(memberInvitation.claimUrl);
      if (!isCurrentSession() || context !== setupContext.current) return;
      setInvitationCopied(true);
    } catch (reason) {
      if (isCurrentSession() && context === setupContext.current) reportError(reason);
    }
  }

  function resetAuthenticatedWorkspace(previous: LocalSession) {
    collaborationLocation.current = null;
    setupContext.current = {};
    clearComposerUserState(previous.userId);
    setError(null);
    setTeamsLoaded(false);
    preferredRoomRef.current = null;
    pendingRoomTaskIdRef.current = null;
    setBusy(false);
    setTeamBusy(false);
    setTaskBusy(false);
    setLifecycleBusy(false);
    setParticipantBusy(false);
    setClarificationBusyId(null);
    setMemoryCandidateBusyId(null);
    setArtifactPreviewBusyId(null);
    setArtifactPreviewError(null);
    setTeams([]);
    setRooms([]);
    setMembers([]);
    setAgents([]);
    setDevices([]);
    setMessages([]);
    setRuns([]);
    setDiscussions([]);
    setTasks([]);
    setArtifacts([]);
    setArtifactPreview(null);
    setSelectedTeamId(null);
    setSelectedRoomId(null);
    setSelectedWorkTaskId(null);
    setSelectedWorkRunId(null);
    setSelectedWorkTab("overview");
    setWorkSearch("");
    setWorkScope("mine");
    setWorkLifecycleState("");
    setWorkOwnerMemberId("");
    setMemberInvitation(null);
    setSetupOutput(null);
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
      clearAuthenticatedSession();
    } catch (reason) {
      if (reason instanceof HttpRequestError && reason.status === 401) clearAuthenticatedSession();
      else reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function createFakeAgent(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !agentName.trim()) return;
    const context = setupContext.current;
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
      if (context !== setupContext.current) return;
      setAgentName("");
      setAgents((current) => [...current, agent]);
    } catch (reason) {
      if (context === setupContext.current) reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function createManualAgent(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !manualAgentName.trim()) return;
    const context = setupContext.current;
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
      if (context !== setupContext.current) return;
      setAgents((current) => [...current, result.agent]);
      setManualAgentName("");
      setSetupOutput([
        `export CONVENE_WIRE_MCP_TOKEN='${result.credential.token}'`,
        `codex mcp add convene-wire --url ${window.location.origin}/mcp --bearer-token-env-var CONVENE_WIRE_MCP_TOKEN`
      ].join("\n"));
    } catch (reason) {
      if (context === setupContext.current) reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function createBridgeInvite(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !deviceName.trim()) return;
    const context = setupContext.current;
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
      if (context !== setupContext.current) return;
      setDeviceName("");
      setSetupOutput([
        locale === "zh-CN"
          ? `# 配对码将在 ${invite.expiresAt} 过期`
          : `# Pairing code expires at ${invite.expiresAt}`,
        `convenewire-bridge pair --config bridge.json --code '${invite.code}'`
      ].join("\n"));
    } catch (reason) {
      if (context === setupContext.current) reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function approveBridgeJoin(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !joinCode.trim()) return;
    const context = setupContext.current;
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
      if (context !== setupContext.current) return;
      setJoinCode("");
      setSetupOutput(
        locale === "zh-CN"
          ? `已批准 ${approved.deviceName} 上的 ${approved.agentName}。客户端将自动完成注册并上线。`
          : `Approved ${approved.agentName} on ${approved.deviceName}. ` +
            "The client will finish registration and come online automatically."
      );
    } catch (reason) {
      if (context === setupContext.current) reportError(reason);
    } finally {
      if (isCurrentSession()) setBusy(false);
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
      reportError(reason);
    }
  }

  function openWorkbenchTask(taskId: string, roomId: string) {
    navigate({ roomId, workTaskId: taskId, taskId: undefined, view: "work", tab: "overview", runId: undefined });
  }

  function revealWork() {
    navigate({ workTaskId: undefined, taskId: undefined, tab: undefined, runId: undefined, view: "work" });
  }

  function openTaskInRoom(roomId: string, taskId: string) {
    navigate({ roomId, taskId, workTaskId: undefined, tab: undefined, runId: undefined, view: "room" });
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
      reportError(reason);
    } finally {
      if (isCurrentSession()) setClarificationBusyId(null);
    }
  }

  async function reviewMemoryCandidate(
    candidate: MemoryCandidate,
    action: "accept" | "reject"
  ) {
    if (!session || memoryCandidateBusyId) return;
    setMemoryCandidateBusyId(candidate.candidateId);
    setError(null);
    try {
      const reviewed = await jsonRequest<MemoryCandidate>(
        `/api/memory-candidates/${candidate.candidateId}/${action}`,
        { method: "POST", body: JSON.stringify({}) },
        session.token
      );
      setMemoryCandidates((current) => current.filter(({ candidateId }) =>
        candidateId !== reviewed.candidateId
      ));
    } catch (reason) {
      if (isStaleWebSessionError(reason)) return;
      reportError(reason);
      if (selectedRoomId) {
        try {
          setMemoryCandidates(await jsonRequest<MemoryCandidate[]>(
            `/api/rooms/${selectedRoomId}/memory-candidates`, {}, session.token
          ));
        } catch {
          // Preserve the original review error while converging when possible.
        }
      }
    } finally {
      if (isCurrentSession()) setMemoryCandidateBusyId(null);
    }
  }

  async function previewArtifact(artifact: TaskArtifact) {
    if (!session || artifactPreviewBusyId) return;
    setArtifactPreviewBusyId(artifact.artifactId);
    setArtifactPreviewError(null);
    try {
      const preview = await jsonRequest<ArtifactPreview>(
        `/api/tasks/${artifact.taskId}/artifacts/${artifact.artifactId}/preview`,
        {},
        session.token
      );
      if (selectedTaskIdRef.current === preview.taskId) {
        setArtifactPreview(preview);
      }
    } catch (reason) {
      if (isStaleWebSessionError(reason)) return;
      setArtifactPreview(null);
      setArtifactPreviewError(String(reason));
    } finally {
      if (isCurrentSession()) setArtifactPreviewBusyId(null);
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
      reportError(reason);
    }
  }

  function revealConnectionSetup() {
    setAgentSetupTarget(null);
    setSetupOutput(null);
    navigate({ view: "agents", taskId: undefined, workTaskId: undefined, tab: undefined, runId: undefined });
  }

  function returnToCollaboration() {
    if (!managing) return;
    const remembered = collaborationLocation.current;
    if (remembered?.session === session && remembered.location.teamId === selectedTeamId) {
      navigate(remembered.location);
    } else revealWork();
  }

  function selectWorkspaceView(view: WorkspaceView) {
    if (view === "work") { revealWork(); return; }
    if (view === "agents") { revealConnectionSetup(); return; }
    if (view === "members") { revealTeamMembers(); return; }
    setAgentSetupTarget(null);
    setSetupOutput(null);
    navigate({ view, taskId: view === "room" ? selectedTaskId ?? undefined : undefined,
      workTaskId: undefined, tab: undefined, runId: undefined });
  }

  function chooseAgentSetup(target: AgentSetupTarget) {
    setAgentSetupTarget(target);
    if (target === "demo") {
      setConnectionMode("demo");
      if (!agentName.trim()) setAgentName(locale === "zh-CN" ? "体验助手" : "Demo Agent");
    } else if (target === "local") setConnectionMode("managed");
    navigate({ view: "agents", taskId: undefined, workTaskId: undefined, tab: undefined, runId: undefined });
  }

  async function openHostedRoom(roomId: string) {
    if (!session || !rooms.some((room) => room.roomId === roomId)) return;
    const context = roomContextRef.current;
    try {
      const settings = await jsonRequest<RoomSettings>(`/api/rooms/${roomId}/settings`, {}, session.token);
      if (roomContextRef.current !== context) return;
      if (selectedRoomId === roomId) setRoomParticipants(settings.participants);
      navigate({ roomId, view: "room", taskId: undefined, workTaskId: undefined, tab: undefined, runId: undefined });
    } catch (reason) {
      reportError(reason);
    }
  }

  function revealTeamMembers() {
    setMemberInvitation(null);
    setInvitationCopied(false);
    navigate({ view: "members", taskId: undefined, workTaskId: undefined, tab: undefined, runId: undefined });
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
        onRecoverMember={recoverMember}
        onSetupOwner={setupOwner}
        onToggleLocale={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")}
        onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
        state={authState}
        theme={theme}
      />
    );
  }

  return (
    <div className={`app-shell product-shell ${managing ? "management-area" : "collaboration-area"}`}>
      <WorkspaceSidebar activeView={activeView} locale={locale} teams={teams} teamId={selectedTeamId} rooms={rooms} roomId={selectedRoomId}
        onTeam={(teamId) => navigate({ teamId, roomId: undefined, taskId: undefined, workTaskId: undefined,
          tab: undefined, runId: undefined, lifecycleState: undefined, ownerMemberId: undefined, search: undefined, view: managing ? activeView : "work" })}
        onNewTeam={() => setTeamDialogOpen(true)} onNewRoom={() => setRoomCreateOpen(true)}
        onRoom={(roomId) => navigate({ roomId, view: "room", taskId: undefined, workTaskId: undefined, tab: undefined, runId: undefined })}
        onView={selectWorkspaceView} onCollaboration={returnToCollaboration}>
        {selectedTeam && selectedRoom && (
          <details className="product-participants">
            <summary>{t("roomParticipants")} <span>{roomMembers.length + roomAgents.length}</span></summary>
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
          </details>
        )}
      </WorkspaceSidebar>

      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-heading">
            <div className="workspace-heading-copy">
              <p className="eyebrow">
                {managing ? (locale === "zh-CN" ? "管理" : "MANAGEMENT") : (locale === "zh-CN" ? "协作" : "COLLABORATION")}
              </p>
              <h2>
                {activeView === "work" && selectedTeam
                  ? (locale === "zh-CN" ? "团队工作台" : "Team Workbench")
                  : activeView === "agents" && selectedTeam
                  ? t("agents")
                  : activeView === "devices" && selectedTeam
                    ? (locale === "zh-CN" ? "设备" : "Devices")
                  : activeView === "security"
                    ? (locale === "zh-CN" ? "账户与安全" : "Account & security")
                  : activeView === "members" && selectedTeam
                    ? (locale === "zh-CN" ? "团队与成员" : "Team & members")
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
            <button className="header-account" onClick={() => selectWorkspaceView("security")} type="button" aria-label={locale === "zh-CN" ? "打开账户与安全" : "Open account & security"}>
              {session?.displayName.slice(0, 1).toUpperCase()}
            </button>
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
            {selectedTeam && !managing && (
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
        {restoringNavigation && <p className="navigation-status" role="status">{locale === "zh-CN" ? "正在验证并恢复工作位置…" : "Checking access and restoring your work…"}</p>}
        {copyStatus && <p className="navigation-status" role="status">{copyStatus}</p>}
        {activeView === "security" && session ? (
          <AccountWorkspace session={session} authMode={authMode} locale={locale} theme={theme}
            onLocale={() => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN")}
            onTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} />
        ) : !selectedTeam ? (
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
        ) : activeView === "work" && selectedRoom && selectedWorkTaskId ? (
          <TaskWorkDetail
            agentNames={agentNames}
            currentMember={currentMember}
            locale={locale}
            memberNames={memberNames}
            onBack={revealWork}
            initialTab={selectedWorkTab}
            initialRunId={selectedWorkRunId}
            onTabChange={(tab) => navigate({ tab })}
            onRunChange={(runId) => navigate({ runId })}
            onCopyLink={copyLink}
            onChanged={() => void refreshWorkbenchState()}
            onOpenRoom={openTaskInRoom}
            onOpenTask={openWorkbenchTask}
            refreshKey={workbenchItems.find(({ taskId }) => taskId === selectedWorkTaskId)?.updatedAt ?? ""}
            roomNames={roomNames}
            taskId={selectedWorkTaskId}
            token={session?.token}
          />
        ) : activeView === "work" && selectedRoom ? (
          <div className="work-home">
          {agents.length === 0 && (
            <section className="work-onboarding">
              <p className="eyebrow">{locale === "zh-CN" ? "从第一个 Agent 开始" : "Start with your first Agent"}</p>
              <h3>{locale === "zh-CN" ? "选择适合你的开始方式" : "Choose how you want to begin"}</h3>
              <AgentSetupChoices currentMemberIsOwner={currentMember?.role === "owner"} locale={locale} onSelect={chooseAgentSetup} />
            </section>
          )}
          <WorkWorkspace
            agentNames={agentNames}
            error={workbenchError}
            items={workbenchItems}
            loading={workbenchLoading}
            loadingMore={workbenchLoadingMore}
            hasMore={workbenchHasMore}
            lifecycleState={workLifecycleState}
            ownerMemberId={workOwnerMemberId}
            locale={locale}
            memberNames={memberNames}
            onOpenTask={openWorkbenchTask}
            onLoadMore={() => void loadMoreWork()}
            onCreateTask={() => setTaskDialogOpen(true)}
            createTaskDisabled={!selectedRoom || taskBusy}
            onCopyLink={copyLink}
            onOpenAction={(item) => {
              const target = workActionTarget(item);
              if (!target) return;
              if (target.view === "room") openTaskInRoom(target.roomId, target.taskId);
              else navigate({ roomId: target.roomId, workTaskId: target.taskId, taskId: undefined,
                view: "work", tab: target.tab, runId: target.runId ?? undefined });
            }}
            search={workSearch}
            onSearchChange={(search) => navigate({ search: search || undefined }, true)}
            onLifecycleStateChange={(lifecycleState) => {
              if (!lifecycleState || ["draft", "ready", "active", "review", "completed", "canceled"].includes(lifecycleState)) {
                navigate({ lifecycleState: (lifecycleState || undefined) as LifecycleState | undefined });
              }
            }}
            onOwnerMemberIdChange={(ownerMemberId) => navigate({ ownerMemberId: ownerMemberId || undefined })}
            onRefresh={() => void refreshWorkbenchState()}
            onScopeChange={(scope) => navigate({ scope })}
            roomNames={roomNames}
            scope={workScope}
          />
          </div>
        ) : activeView === "members" ? (
          <>
          {currentMember?.role === "owner" && <div className="management-page-actions"><button onClick={() => void openLifecycleDialog()} type="button">{locale === "zh-CN" ? "资源生命周期" : "Resource lifecycle"}</button></div>}
          <TeamMembersWorkspace
            key={selectedTeam.teamId}
            onDismissInvitation={clearSetupPresentation}
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
          </>
        ) : activeView === "devices" ? (
          <DeviceWorkspace key={`${selectedTeam.teamId}:${session?.userId}`} agents={agents} devices={devices}
            locale={locale} currentMemberIsOwner={currentMember?.role === "owner"} currentMemberId={currentMember?.memberId ?? null}
            sessionToken={session?.token} teamId={selectedTeam.teamId} onRevokeDevice={revokeDevice} />
        ) : activeView === "agents" ? (
          <AgentWorkspace
            key={`${selectedTeam.teamId}:${session?.userId}`}
            agentName={agentName}
            agents={agents}
            busy={busy}
            connectionMode={connectionMode}
            currentMemberIsOwner={currentMember?.role === "owner"}
            currentMemberId={currentMember?.memberId ?? null}
            devices={devices}
            deviceName={deviceName}
            joinCode={joinCode}
            lifecycleBusy={lifecycleBusy}
            locale={locale}
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
            onSetupClosed={() => { setAgentSetupTarget(null); clearSetupPresentation(); }}
            onDevices={() => selectWorkspaceView("devices")}
            onOpenHostedRoom={(roomId) => void openHostedRoom(roomId)}
            onAgentChanged={(updated) => setAgents((current) => {
              const exists = current.some(({ agentId }) => agentId === updated.agentId);
              return exists
                ? current.map((agent) => agent.agentId === updated.agentId ? updated : agent)
                : [...current, updated];
            })}
            onSetAgentEnabled={setAgentEnabled}
            readyAgents={readyAgents}
            rooms={rooms}
            setupOutput={setupOutput}
            setupTarget={agentSetupTarget}
            sessionToken={session?.token}
            teamId={selectedTeam.teamId}
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
          <section className="empty-stage room-onboarding">
            <div className="orb"><span>✦</span></div>
            <p className="eyebrow">{locale === "zh-CN" ? "第 3 步 · 收到第一条真实回复" : "STEP 3 · Get your first real reply"}</p>
            <h3>
              {readyRoomAgents.length === 0
                ? t("addAgentOrStart")
                : `${t("startConversation")} #${selectedRoom.name}`}
            </h3>
            <p>{t("timelineHelp")}</p>
            {readyRoomAgents.length === 0 && (
              <>
                <p>{locale === "zh-CN" ? "当前房间还没有就绪的 Agent。已注册不等于可以在这里回复，请检查状态和房间授权。" : "No Agent is ready in this Room yet. Check availability and Room access, not just registration."}</p>
                <AgentSetupChoices currentMemberIsOwner={currentMember?.role === "owner"} locale={locale} onSelect={chooseAgentSetup} />
              </>
            )}
          </section>
        ) : (
          <RoomTimeline
            key={selectedRoom.roomId}
            agentsById={agentsById}
            composerBusy={composerBusy}
            locale={locale}
            hasOlderMessages={olderMessageCursor !== null}
            historyLoading={historyLoading}
            historyError={historyError}
            onLoadOlderMessages={loadOlderMessages}
            membersById={membersById}
            messages={messages}
            onCancelRun={cancelRun}
            onOpenWorkTask={openWorkbenchTask}
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
            {!hasRealRoomReply && (
              <div className="first-reply-guide" role="status">
                <span>{readyRoomAgents.some((agent) => agent.integrationMode !== "fake")
                  ? (locale === "zh-CN" ? "下一步：选择一个 Agent，写下你的问题并发送，收到第一条真实回复。" : "Next: choose an Agent, write your question and send it to get a real reply.")
                  : readyRoomAgents.length > 0
                    ? (locale === "zh-CN" ? "当前为演示体验，不会调用真实模型。准备好后可创建中央 Agent 或连接本机 Agent。" : "This is a demo, without real model calls. Add a Central or local Agent when you are ready.")
                    : (locale === "zh-CN" ? "聊天已经可以使用；让 Agent 回复需要先配置并授权到当前房间。" : "Chat is ready. To receive an Agent reply, configure one and grant it access to this Room.")}</span>
                <button type="button" onClick={() => {
                  const target = readyRoomAgents.find((agent) => agent.integrationMode !== "fake") ?? readyRoomAgents[0];
                  if (target) {
                    selectMention(target);
                    composerInputRef.current?.focus();
                  } else revealConnectionSetup();
                }}>{readyRoomAgents.length > 0
                  ? (locale === "zh-CN" ? "选择 Agent 提问" : "Ask an Agent")
                  : (locale === "zh-CN" ? "配置 Agent" : "Set up an Agent")}</button>
              </div>
            )}
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
            <MemoryCandidateReview
              busyId={memoryCandidateBusyId}
              candidates={memoryCandidates}
              locale={locale}
              onAccept={(candidate) => reviewMemoryCandidate(candidate, "accept")}
              onReject={(candidate) => reviewMemoryCandidate(candidate, "reject")}
              tasks={tasks}
            />
            <ArtifactPreviewPanel
              artifacts={artifacts}
              busyId={artifactPreviewBusyId}
              error={artifactPreviewError}
              locale={locale}
              onClose={() => setArtifactPreview(null)}
              onPreview={previewArtifact}
              preview={artifactPreview}
            />
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
                  onSelect={(taskId) => navigate({ taskId: taskId ?? undefined })}
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
                  ref={composerInputRef}
                  onChange={handleMessageChange}
                  onKeyDown={handleMessageKeyDown}
                  placeholder={locale === "zh-CN"
                    ? `发送消息到 #${selectedRoom.name}；支持 @Agent完整名称${selectedRoomPolicy.allowAll ? " 和 @all" : ""}`
                    : `Message #${selectedRoom.name}; use an exact @Agent name${selectedRoomPolicy.allowAll ? " or @all" : ""}`}
                  required
                  rows={2}
                  value={messageContent}
                />
                <div className="composer-preferences">
                  <label className="composer-retain-mentions">
                    <input
                      checked={keepMentions}
                      onChange={(event) => changeKeepMentions(event.target.checked)}
                      role="switch"
                      type="checkbox"
                    />
                    <span>{locale === "zh-CN" ? "保留上次 @" : "Keep last @ mentions"}</span>
                  </label>
                  <span className="composer-preference-hint">
                    {locale === "zh-CN"
                      ? "仅本浏览器 · 不跨任务沿用；已有草稿独立恢复"
                      : "This browser only · separate per Task; saved drafts restore independently"}
                  </span>
                </div>
                <div className="composer-persistence">
                  <small role="status">{persistenceStatus.warning ?? (persistenceStatus.state === "saved"
                    ? (locale === "zh-CN" ? "已保存在本标签页 · 24 小时内可恢复 · 不会自动重发" : "Saved in this tab · recoverable for 24 hours · never auto-sent")
                    : "")}</small>
                  {hasMessageText && <button onClick={clearDraft} type="button">{locale === "zh-CN" ? "清除草稿" : "Clear draft"}</button>}
                </div>
              </div>
              <button
                className="composer-send"
                disabled={composerBusy || !hasMessageText || !selectedTask ||
                  selectedTask.state === "completed" ||
                  selectedTask.state === "canceled"}
              >
                {composerBusy ? t("sending") : t("send")}
              </button>
            </form>
          </div>
        )}
      </main>
      {roomCreateOpen && selectedTeam && <PanelDialog title={t("createRoom")} locale={locale} onClose={() => { setRoomCreateOpen(false); clearSetupPresentation(); }}>
        <form className="product-room-form" onSubmit={createRoom}>
          <label htmlFor="new-room-name">{t("newRoomName")}</label>
          <input autoComplete="off" id="new-room-name" onChange={(event) => setRoomName(event.target.value)} required value={roomName} />
          <button disabled={teamBusy} type="submit">{teamBusy ? t("creating") : t("createRoom")}</button>
        </form>
      </PanelDialog>}
      {taskDialogOpen && selectedRoom && (
        <TaskCreateDialog
          busy={taskBusy}
          criteria={taskCriteria}
          goal={taskGoal}
          locale={locale}
          onClose={() => setTaskDialogOpen(false)}
          onCriteriaChange={setTaskCriteria}
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
