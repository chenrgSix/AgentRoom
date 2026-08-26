import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import {
  type Agent,
  type DiscussionView,
  type LocalSession,
  type MentionSearch,
  type Message,
  type RoomCollaborationPolicy,
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

interface RoomComposerInput {
  activeDiscussion: DiscussionView | null;
  agentRoleLabel: (agent: Agent) => string;
  agents: Agent[];
  locale: Locale;
  onDelivered: (message: Message, runs: Run[]) => Promise<void>;
  onError: (error: string | null) => void;
  onRoomStateChanged: () => Promise<void>;
  roomAgents: Agent[];
  roomPolicy: RoomCollaborationPolicy;
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
    roomPolicy,
    selectedRoomId,
    selectedTaskId,
    session
  } = input;
  const [messageContent, setMessageContent] = useState("");
  const [pendingMessages, setPendingMessages] = useState<PendingRoomMessage[]>([]);
  const [mentionAgentIds, setMentionAgentIds] = useState<string[]>([]);
  const [mentionSearch, setMentionSearch] = useState<MentionSearch | null>(null);
  const [mentionOptionIndex, setMentionOptionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [keepMentions, setKeepMentions] = useState(readKeepMentionsPreference);
  const keepMentionsRef = useRef(keepMentions);
  const retainedAgentsRef = useRef<Agent[]>([]);
  const draftRevisionRef = useRef(0);
  const scopeKey = JSON.stringify([session?.userId, selectedRoomId, selectedTaskId]);
  const scopeRef = useRef({ key: scopeKey, revision: 0 });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, revision: scopeRef.current.revision + 1 };
  }
  const roomAgentsRef = useRef(roomAgents);
  roomAgentsRef.current = roomAgents;
  const selectedRoomIdRef = useRef<string | null>(selectedRoomId);
  selectedRoomIdRef.current = selectedRoomId;

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
    setPendingMessages([]);
  }, [selectedRoomId, session?.userId]);

  useEffect(() => {
    resetDraft();
  }, [scopeKey]);

  useEffect(() => {
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
  }, [roomAgents]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !session || !selectedRoomId || !selectedTaskId || !hasMessageText) {
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
              outputMode: "final_answer"
            })
          },
          session.token
        );
        if (scopeRef.current.revision === submittedScopeRevision &&
          draftRevisionRef.current === submittedDraftRevision) {
          resetDraft(resolvedMentionAgentIds);
        }
        await onRoomStateChanged();
      } catch (reason) {
        onError(String(reason));
      } finally {
        setBusy(false);
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
    await deliver(pending);
  }

  async function deliver(pending: PendingRoomMessage) {
    if (!session) return;
    setBusy(true);
    setPendingMessages((current) =>
      updatePendingMessage(current, pending.clientMessageId, "pending")
    );
    onError(null);
    try {
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
      setPendingMessages((current) => current.filter(({ clientMessageId }) =>
        clientMessageId !== pending.clientMessageId
      ));
      if (selectedRoomIdRef.current === pending.roomId) {
        await onDelivered(result.message, result.runs);
      }
    } catch (reason) {
      setPendingMessages((current) =>
        updatePendingMessage(current, pending.clientMessageId, "failed")
      );
      onError(String(reason));
    } finally {
      setBusy(false);
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

  function discardRetainedMentions(removed: Agent[]) {
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
    setMentionSearch(null);
    setMentionOptionIndex(0);
  }

  return {
    busy,
    changeKeepMentions,
    deliver,
    directlyParsedAgents,
    exactMentionCommands,
    handleChange,
    handleKeyDown,
    hasMessageText,
    keepMentions,
    mentionOptionIndex,
    mentionOptions,
    mentionSearch,
    messageContent,
    pendingMessages: pendingMessages.filter(({ roomId }) => roomId === selectedRoomId),
    removeMention,
    retainMentionAgentIds,
    selectMention,
    selectedMentionAgents,
    submit,
    unresolvedExactAmbiguousNames
  };
}
