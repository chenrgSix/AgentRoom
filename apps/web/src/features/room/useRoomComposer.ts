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

import { captureWebSessionScope, isStaleWebSessionError, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import {
  type Agent,
  type DiscussionView,
  type LocalSession,
  type MentionSearch,
  type Message,
  type RoomCollaborationPolicy,
  type RoomSettings,
  type Run
} from "../../models.js";
import {
  createClientMessageId,
  type PendingRoomMessage,
  queuePendingMessage,
  updatePendingMessage
} from "../../message-outbox.js";
import {
  removeVisibleMentionToken,
  resolveExactMentionCommands,
  retainVisibleMentionIds
} from "../../structured-mentions.js";
import {
  readKeepMentionsPreference,
  removeRetainedMentionTokens,
  writeKeepMentionsPreference
} from "./mention-retention.js";
import {
  composerClearedEvent,
  defaultDiscussionComposerOptions,
  composerStorageLimits,
  composerUserGeneration,
  emptyComposerState,
  loadComposerState,
  saveComposerState,
  validPendingMessage,
  type ComposerScope,
  type ComposerStoredState,
  type ComposerStorageWarning
} from "./composer-storage.js";

export interface ComposerPersistenceStatus {
  state: "saved" | "not_saved" | "empty";
  warning: string | null;
}

function storageWarning(code: ComposerStorageWarning | null, locale: Locale): string | null {
  if (!code) return null;
  const zh = locale === "zh-CN";
  if (code === "expired") return zh ? "超过 24 小时的草稿和失败消息已过期。" : "Drafts and failed messages older than 24 hours have expired.";
  if (code === "invalid") return zh ? "无效的已存草稿已忽略；当前仍可编辑。" : "Invalid saved drafts were ignored; editing remains available.";
  if (code === "limit") return zh ? "已达到本标签页的草稿存储上限，当前修改尚未保存。" : "This tab's draft storage limit was reached; current changes are not saved.";
  return zh ? "本标签页存储不可用，当前修改尚未保存；请勿依赖刷新恢复。" : "This tab's storage is unavailable; current changes are not saved and may be lost on reload.";
}

type StateUpdate<T> = T | ((current: T) => T);
const updatedValue = <T,>(current: T, update: StateUpdate<T>): T =>
  typeof update === "function" ? (update as (current: T) => T)(current) : update;

interface RoomComposerInput {
  activeDiscussion: DiscussionView | null;
  agentRoleLabel: (agent: Agent) => string;
  agents: Agent[];
  locale: Locale;
  onDelivered: (message: Message, runs: Run[]) => Promise<void>;
  onError: (error: string | null) => void;
  onRoomStateChanged: () => Promise<void>;
  roomAgents: Agent[];
  roomAgentsReady?: boolean;
  roomPolicy: RoomCollaborationPolicy;
  selectedTeamId?: string | null;
  selectedRoomId: string | null;
  selectedTaskId: string | null;
  session: LocalSession | null;
}

export function useRoomComposer(input: RoomComposerInput) {
  const {
    activeDiscussion,
    agentRoleLabel,
    agents,
    locale,
    onDelivered,
    onError,
    onRoomStateChanged,
    roomAgents,
    roomAgentsReady = true,
    roomPolicy,
    selectedTeamId,
    selectedRoomId,
    selectedTaskId,
    session
  } = input;
  const isCurrentSession = captureWebSessionScope();
  const scopeKey = JSON.stringify([session?.userId, selectedTeamId, selectedRoomId, selectedTaskId, session?.token]);
  const storageScope: ComposerScope | null = session && selectedTeamId && selectedRoomId && selectedTaskId
    ? { userId: session.userId, teamId: selectedTeamId, roomId: selectedRoomId, taskId: selectedTaskId }
    : null;
  const [composer, setComposer] = useState({ key: scopeKey, value: emptyComposerState() });
  const composerRef = useRef(composer);
  const value = composer.key === scopeKey ? composer.value : emptyComposerState();
  const { content: messageContent, discussionOptions, pendingMessages, mentionAgentIds } = value;
  const [persistence, setPersistence] = useState<{
    state: ComposerPersistenceStatus["state"]; warning: ComposerStorageWarning | null;
  }>({ state: "empty", warning: null });
  const [mentionSearch, setMentionSearch] = useState<MentionSearch | null>(null);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const [keepMentions, setKeepMentions] = useState(readKeepMentionsPreference);
  const keepMentionsRef = useRef(keepMentions);
  const retainedAgentsRef = useRef<Array<Pick<Agent, "agentId" | "name">>>([]);
  const draftRevisionRef = useRef(0);
  const scopeRef = useRef({ key: scopeKey, revision: 0 });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, revision: scopeRef.current.revision + 1 };
  }
  const roomAgentsRef = useRef(roomAgents);
  roomAgentsRef.current = roomAgents;
  const selectedRoomIdRef = useRef<string | null>(selectedRoomId);
  selectedRoomIdRef.current = selectedRoomId;

  function updateComposer(update: (current: ComposerStoredState) => ComposerStoredState) {
    if (!mountedRef.current || !isCurrentSession() || scopeRef.current.key !== scopeKey || composerRef.current.key !== scopeKey) return;
    const next = update(composerRef.current.value);
    if (next === composerRef.current.value) return;
    next.retainedMentions = retainedAgentsRef.current
      .filter(({ agentId }) => next.mentionAgentIds.includes(agentId))
      .map(({ agentId, name }) => ({ agentId, name }));
    const updated = { key: scopeKey, value: next };
    composerRef.current = updated;
    setComposer(updated);
    if (storageScope) {
      const result = saveComposerState(storageScope, next);
      setPersistence({
        state: result.saved ? (next.content || next.pendingMessages.length ? "saved" : "empty") : "not_saved",
        warning: result.warning ?? null
      });
    }
  }

  const setMessageContent = (update: StateUpdate<string>) => updateComposer((current) => {
    const content = updatedValue(current.content, update);
    return content === current.content ? current : { ...current, content };
  });
  const setMentionAgentIds = (update: StateUpdate<string[]>) => updateComposer((current) => {
    const mentionAgentIds = updatedValue(current.mentionAgentIds, update);
    return mentionAgentIds === current.mentionAgentIds ? current : { ...current, mentionAgentIds };
  });
  const setDiscussionOptions = (
    update: StateUpdate<ComposerStoredState["discussionOptions"]>
  ) => updateComposer((current) => {
    const discussionOptions = updatedValue(current.discussionOptions, update);
    return discussionOptions === current.discussionOptions
      ? current
      : { ...current, discussionOptions };
  });
  const setPendingMessages = (update: StateUpdate<PendingRoomMessage[]>) => updateComposer((current) => ({
    ...current, pendingMessages: updatedValue(current.pendingMessages, update)
  }));

  useLayoutEffect(() => {
    const restored = storageScope ? loadComposerState(storageScope) : { state: emptyComposerState() };
    const next = { key: scopeKey, value: restored.state };
    composerRef.current = next;
    retainedAgentsRef.current = restored.state.retainedMentions;
    draftRevisionRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setMentionSearch(null);
    setMentionOptionIndex(0);
    setComposer(next);
    setPersistence({
      state: restored.warning === "unavailable" ? "not_saved"
        : restored.state.content || restored.state.pendingMessages.length ? "saved" : "empty",
      warning: restored.warning ?? null
    });
  }, [scopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    const clear = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; cleared: boolean }>).detail;
      if (detail?.userId !== session?.userId) return;
      scopeRef.current.revision += 1;
      draftRevisionRef.current += 1;
      retainedAgentsRef.current = [];
      const next = { key: scopeKey, value: emptyComposerState() };
      composerRef.current = next;
      busyRef.current = false;
      setBusy(false);
      setComposer(next);
      setMentionSearch(null);
      setPersistence({ state: detail.cleared ? "empty" : "not_saved", warning: detail.cleared ? null : "unavailable" });
    };
    window.addEventListener(composerClearedEvent, clear);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(composerClearedEvent, clear);
    };
  }, [scopeKey]);

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents]
  );
  const mentionOptions = useMemo(() => {
    if (!mentionSearch) return [];
    const query = mentionSearch.query.toLocaleLowerCase(locale);
    return roomAgents.filter((agent) =>
      !mentionAgentIds.includes(agent.agentId) && (
        agent.name.toLocaleLowerCase(locale).includes(query) ||
        agentRoleLabel(agent).toLocaleLowerCase(locale).includes(query)
      )
    ).slice(0, 8);
  }, [agentRoleLabel, locale, mentionAgentIds, mentionSearch, roomAgents]);
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
  const hasMessageText = removeRetainedMentionTokens(
    messageContent, retainedAgentsRef.current, agents
  ).trim().length > 0;

  useEffect(() => {
    if (!roomAgentsReady) return;
    const eligible = new Map(roomAgents
      .filter((agent) => agent.enabled !== false)
      .map((agent) => [agent.agentId, agent]));
    discardRetainedMentions(retainedAgentsRef.current.filter((agent) =>
      eligible.get(agent.agentId)?.name !== agent.name
    ));
    setMentionAgentIds((current) => {
      const retained = current.filter((agentId) => eligible.has(agentId));
      return retained.length === current.length ? current : retained;
    });
  }, [roomAgents, roomAgentsReady]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !isCurrentSession() || !session || !selectedRoomId || !selectedTaskId || !hasMessageText) {
      return;
    }
    if (messageContent.length > composerStorageLimits.text) {
      onError(locale === "zh-CN" ? "消息最多 20,000 字符，请缩短后发送。" : "Messages are limited to 20,000 characters. Shorten this message before sending.");
      return;
    }
    const submittedScopeRevision = scopeRef.current.revision;
    const submittedDraftRevision = draftRevisionRef.current;
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
      onError(locale === "zh-CN"
        ? `精确指令 @${unresolvedAmbiguousNames.join("、@")} 匹配到多个同名智能体，请从候选列表选择具体身份。`
        : `Exact command @${unresolvedAmbiguousNames.join(", @")} matches multiple same-name Agents. Select a specific identity from the suggestions.`);
      return;
    }
    const resolvedMentionAgentIds = exactCommands.usesAll
      ? exactCommands.agentIds
      : [...new Set([...mentionAgentIds, ...exactCommands.agentIds])];
    if (exactCommands.usesAll && !roomPolicy.allowAll) {
      onError(locale === "zh-CN"
        ? "当前房间设置不允许使用 @all。"
        : "This Room does not allow the @all command.");
      return;
    }
    if (exactCommands.usesAll && resolvedMentionAgentIds.length === 0) {
      onError(locale === "zh-CN"
        ? "当前房间没有可供 @all 路由的智能体。"
        : "This Room has no Agents for @all to route to.");
      return;
    }
    if (resolvedMentionAgentIds.length > 5) {
      onError(locale === "zh-CN"
        ? `精确指令匹配到 ${resolvedMentionAgentIds.length} 个智能体，超过一次协作最多 5 个的限制。`
        : `The exact commands matched ${resolvedMentionAgentIds.length} Agents, exceeding the 5-Agent collaboration limit.`);
      return;
    }
    if (
      roomPolicy.allowDiscussion &&
      resolvedMentionAgentIds.length >= 2 &&
      activeDiscussion
    ) {
      onError(locale === "zh-CN"
        ? "当前房间已有协作讨论，请先结束或停止后再发起新的协作。"
        : "This Room already has an active Discussion. Finish or stop it before starting another.");
      return;
    }
    onError(null);
    if (roomPolicy.allowDiscussion && resolvedMentionAgentIds.length >= 2) {
      const participantAgents = resolvedMentionAgentIds.flatMap((agentId) => {
        const agent = agentsById.get(agentId);
        return agent ? [agent] : [];
      });
      if (participantAgents.length !== resolvedMentionAgentIds.length) {
        onError(locale === "zh-CN"
          ? "讨论参与者身份不完整，请重新选择 Agent。"
          : "Discussion participant identities are incomplete. Select the Agents again.");
        return;
      }
      if (discussionOptions.waveCompletionMode === "read_only_quorum") {
        if (discussionOptions.quorumMinimumCompleted > participantAgents.length) {
          onError(locale === "zh-CN"
            ? "Quorum 最少完成数不能大于参与 Agent 数。"
            : "Quorum minimum completion cannot exceed the participant count.");
          return;
        }
        const ineligible = participantAgents.filter((agent) =>
          agent.integrationMode !== "managed" || !agent.deviceId ||
          agent.runtimePolicy?.filesystemAccess !== "read-only" ||
          agent.capabilities?.supportsDiscussionSupplementalEvidence !== true
        );
        if (ineligible.length > 0) {
          onError(locale === "zh-CN"
            ? `Read-only quorum 只允许具备迟到证据能力的 managed 只读 Agent：${ineligible.map(({ name }) => name).join("、")}`
            : `Read-only quorum requires managed read-only Agents with late-evidence support: ${ineligible.map(({ name }) => name).join(", ")}`);
          return;
        }
      }
      const generation = composerUserGeneration(session.userId);
      const currentAction = () => mountedRef.current && isCurrentSession() && scopeRef.current.revision === submittedScopeRevision &&
        composerUserGeneration(session.userId) === generation;
      busyRef.current = true;
      setBusy(true);
      try {
        await jsonRequest<DiscussionView>(
          `/api/rooms/${selectedRoomId}/discussions`,
          {
            method: "POST",
            body: JSON.stringify({
              taskId: selectedTaskId,
              goal: messageContent,
              participantAgentIds: resolvedMentionAgentIds,
              mode: "round_robin",
              outputMode: "final_answer",
              ...(JSON.stringify(discussionOptions) ===
                JSON.stringify(defaultDiscussionComposerOptions)
                ? {}
                : { policy: discussionOptions })
            })
          },
          session.token
        );
        if (!currentAction()) return;
        if (scopeRef.current.revision === submittedScopeRevision &&
          draftRevisionRef.current === submittedDraftRevision) {
          resetDraft(resolvedMentionAgentIds);
        }
        await onRoomStateChanged();
      } catch (reason) {
        if (currentAction() && !isStaleWebSessionError(reason)) onError(String(reason));
      } finally {
        if (currentAction()) { busyRef.current = false; setBusy(false); }
      }
      return;
    }

    const pending: PendingRoomMessage = {
      clientMessageId: createClientMessageId(),
      roomId: selectedRoomId,
      taskId: selectedTaskId,
      content: messageContent,
      ...(resolvedMentionAgentIds.length > 0
        ? { mentionAgentIds: resolvedMentionAgentIds }
        : {}),
      status: "pending"
    };
    setPendingMessages((current) => queuePendingMessage(current, pending));
    resetDraft(resolvedMentionAgentIds);
    await sendPending(pending, false);
  }

  async function deliver(pending: PendingRoomMessage) {
    if (!session || !selectedRoomId || !selectedTaskId || busyRef.current || !isCurrentSession()) return;
    if (!roomAgentsReady) {
      onError(locale === "zh-CN" ? "请等待当前房间权限加载完成后重试。" : "Wait for the current Room's access settings to load before retrying.");
      return;
    }
    const known = composerRef.current.key === scopeKey
      ? composerRef.current.value.pendingMessages.find((item) => item.clientMessageId === pending.clientMessageId)
      : undefined;
    if (!known || known.status !== "failed" || !validPendingMessage(pending, { roomId: selectedRoomId, taskId: selectedTaskId }) ||
      JSON.stringify({ ...known, status: "failed" }) !== JSON.stringify({ ...pending, status: "failed" })) {
      onError(locale === "zh-CN" ? "请回到原房间和任务重试原消息；不能改变它的发送身份或载荷。" : "Return to the original Room and Task to retry; the message identity and payload cannot be changed.");
      return;
    }
    await sendPending(known, true);
  }

  async function sendPending(pending: PendingRoomMessage, retry: boolean) {
    if (!session || busyRef.current) return;
    const revision = scopeRef.current.revision;
    const generation = composerUserGeneration(session.userId);
    const currentAction = () => mountedRef.current && isCurrentSession() && scopeRef.current.revision === revision &&
      scopeRef.current.key === scopeKey && composerUserGeneration(session.userId) === generation;
    busyRef.current = true;
    setBusy(true);
    setPendingMessages((current) =>
      updatePendingMessage(current, pending.clientMessageId, "pending")
    );
    onError(null);
    try {
      if (retry) {
        const settings = await jsonRequest<RoomSettings>(`/api/rooms/${pending.roomId}/settings`, {}, session.token);
        if (!currentAction()) return;
        if (settings.room.roomId !== selectedRoomId || (selectedTeamId && settings.room.teamId !== selectedTeamId)) {
          throw new Error(locale === "zh-CN" ? "原消息不属于当前 Team 和房间。" : "The original message does not belong to the current Team and Room.");
        }
        const currentAgents = await jsonRequest<Agent[]>(`/api/teams/${settings.room.teamId}/agents`, {}, session.token);
        if (!currentAction()) return;
        const allowed = new Set(currentAgents.filter((agent) => agent.enabled !== false &&
          settings.participants.agentIds.includes(agent.agentId)).map(({ agentId }) => agentId));
        if ((pending.mentionAgentIds ?? []).some((agentId) => !allowed.has(agentId))) {
          throw new Error(locale === "zh-CN" ? "原消息的部分 Agent 已不可用或失去房间授权；请检查原消息，不能自动更换接收者。" : "An original Agent is unavailable or no longer authorized in this Room; recipients cannot be replaced automatically.");
        }
      }
      if (!currentAction()) return;
      const result = await jsonRequest<{ message: Message; runs: Run[] }>(
        `/api/rooms/${pending.roomId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(pending.taskId ? { taskId: pending.taskId } : {}),
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
      if (!currentAction()) return;
      setPendingMessages((current) => current.filter(({ clientMessageId }) =>
        clientMessageId !== pending.clientMessageId
      ));
      if (selectedRoomIdRef.current === pending.roomId) {
        await onDelivered(result.message, result.runs);
      }
    } catch (reason) {
      if (!currentAction() || isStaleWebSessionError(reason)) return;
      setPendingMessages((current) =>
        updatePendingMessage(current, pending.clientMessageId, "failed")
      );
      onError(String(reason));
    } finally {
      if (currentAction()) { busyRef.current = false; setBusy(false); }
    }
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const nextContent = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart ?? nextContent.length;
    const beforeCursor = nextContent.slice(0, cursor);
    const match = /(?:^|\s)@([^@\s]*)$/u.exec(beforeCursor);

    draftRevisionRef.current += 1;
    const retainedIds = new Set(retainVisibleMentionIds(
      nextContent,
      retainedAgentsRef.current.map(({ agentId }) => agentId),
      new Map(retainedAgentsRef.current.map((agent) => [agent.agentId, agent]))
    ));
    retainedAgentsRef.current = retainedAgentsRef.current.filter(({ agentId }) =>
      retainedIds.has(agentId)
    );
    setMessageContent(nextContent);
    onError(null);
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
      onError(locale === "zh-CN"
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
    draftRevisionRef.current += 1;
    setMessageContent(nextContent);
    setMentionAgentIds((current) => current.includes(agent.agentId)
      ? current
      : [...current, agent.agentId]
    );
    onError(null);
    setMentionSearch(null);
    setMentionOptionIndex(0);
  }

  function removeMention(agent: Agent) {
    draftRevisionRef.current += 1;
    retainedAgentsRef.current = retainedAgentsRef.current.filter(({ agentId }) =>
      agentId !== agent.agentId
    );
    setMessageContent((current) => removeVisibleMentionToken(
      current,
      agent.name,
      roomAgents.map(({ name }) => name)
    ));
    setMentionAgentIds((current) => current.filter((agentId) =>
      agentId !== agent.agentId
    ));
    setMentionSearch(null);
  }

  function retainMentionAgentIds(agentIds: string[]) {
    const retainedIds = new Set(agentIds);
    discardRetainedMentions(retainedAgentsRef.current.filter(({ agentId }) =>
      !retainedIds.has(agentId)
    ));
    setMentionAgentIds((current) => current.filter((agentId) =>
      retainedIds.has(agentId)
    ));
  }

  function discardRetainedMentions(removed: Array<Pick<Agent, "agentId" | "name">>) {
    if (removed.length === 0) return;
    draftRevisionRef.current += 1;
    const removedIds = new Set(removed.map(({ agentId }) => agentId));
    const knownAgents = [...agents, ...retainedAgentsRef.current];
    retainedAgentsRef.current = retainedAgentsRef.current.filter(({ agentId }) =>
      !removedIds.has(agentId)
    );
    setMessageContent((current) => removeRetainedMentionTokens(
      current, removed, knownAgents
    ));
    setMentionAgentIds((current) => current.filter((agentId) =>
      !removedIds.has(agentId)
    ));
    setMentionSearch(null);
  }

  function changeKeepMentions(enabled: boolean) {
    keepMentionsRef.current = enabled;
    setKeepMentions(enabled);
    writeKeepMentionsPreference(enabled);
    if (!enabled) discardRetainedMentions(retainedAgentsRef.current);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
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

  function resetDraft(agentIds: string[] = []) {
    const eligible = new Map(roomAgentsRef.current
      .filter((agent) => agent.enabled !== false)
      .map((agent) => [agent.agentId, agent]));
    let retained = keepMentionsRef.current
      ? agentIds.flatMap((agentId) => {
          const agent = eligible.get(agentId);
          return agent ? [agent] : [];
        })
      : [];
    const content = retained.map(({ name }) => `@${name} `).join("");
    const parsed = resolveExactMentionCommands(content, roomAgentsRef.current);
    if (parsed.usesAll || parsed.agentIds.some((id) => !agentIds.includes(id))) {
      // Reserved or embedded command syntax in a name must not widen a preset.
      retained = [];
    }
    draftRevisionRef.current += 1;
    retainedAgentsRef.current = retained;
    setMessageContent(retained.map(({ name }) => `@${name} `).join(""));
    setMentionAgentIds(retained.map(({ agentId }) => agentId));
    setDiscussionOptions({ ...defaultDiscussionComposerOptions });
    setMentionSearch(null);
    setMentionOptionIndex(0);
  }

  return {
    busy,
    clearDraft: () => resetDraft(),
    changeKeepMentions,
    deliver,
    directlyParsedAgents,
    discussionOptions,
    exactMentionCommands,
    handleChange,
    handleKeyDown,
    hasMessageText,
    keepMentions,
    mentionOptionIndex,
    mentionOptions,
    mentionSearch,
    messageContent,
    persistenceStatus: { state: persistence.state, warning: storageWarning(persistence.warning, locale) } satisfies ComposerPersistenceStatus,
    pendingMessages: pendingMessages.filter(({ roomId, taskId }) => roomId === selectedRoomId && taskId === selectedTaskId),
    removeMention,
    retainMentionAgentIds,
    selectMention,
    selectedMentionAgents,
    setDiscussionOptions,
    submit,
    unresolvedExactAmbiguousNames
  };
}
