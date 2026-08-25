import { useEffect, useState } from "react";

import { jsonRequest } from "../../api-client.js";
import type { DiscussionView, LocalSession } from "../../models.js";

interface DiscussionControllerInput {
  discussions: DiscussionView[];
  onBusy: (busy: boolean) => void;
  onError: (error: string | null) => void;
  onRoomStateChanged: () => Promise<void>;
  selectedTaskId: string | null;
  session: LocalSession | null;
}

type DiscussionAction =
  "finish" |
  "stop_after_turn" |
  "pause" |
  "cancel" |
  "continue";

export function useDiscussionController(input: DiscussionControllerInput) {
  const {
    discussions,
    onBusy,
    onError,
    onRoomStateChanged,
    selectedTaskId,
    session
  } = input;
  const [goalEditId, setGoalEditId] = useState<string | null>(null);
  const [goalDraft, setGoalDraft] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const taskDiscussions = discussions.filter(({ discussion }) =>
    discussion.taskId === selectedTaskId
  );
  const activeDiscussion = [...taskDiscussions].reverse().find(({ discussion }) =>
    !["completed", "canceled", "terminated"].includes(discussion.state)
  ) ?? null;
  const visibleDiscussion = activeDiscussion ?? taskDiscussions.at(-1) ?? null;
  const visibleDiscussionExpanded =
    visibleDiscussion?.discussion.discussionId === expandedId;

  useEffect(() => {
    setExpandedId((current) =>
      current && current !== visibleDiscussion?.discussion.discussionId
        ? null
        : current
    );
  }, [visibleDiscussion?.discussion.discussionId]);

  async function control(discussionId: string, action: DiscussionAction) {
    if (!session) return;
    onBusy(true);
    onError(null);
    try {
      await jsonRequest<DiscussionView>(
        `/api/discussions/${discussionId}/actions`,
        { method: "POST", body: JSON.stringify({ action }) },
        session.token
      );
      await onRoomStateChanged();
    } catch (reason) {
      onError(String(reason));
    } finally {
      onBusy(false);
    }
  }

  function editGoal(view: DiscussionView) {
    setGoalEditId(view.discussion.discussionId);
    setGoalDraft(view.discussion.goal);
  }

  function cancelGoalEdit() {
    setGoalEditId(null);
    setGoalDraft("");
  }

  async function saveGoal() {
    if (!session || !goalEditId || !goalDraft.trim()) return;
    onBusy(true);
    onError(null);
    try {
      await jsonRequest<DiscussionView>(
        `/api/discussions/${goalEditId}/actions`,
        {
          method: "POST",
          body: JSON.stringify({ action: "adjust_goal", goal: goalDraft })
        },
        session.token
      );
      cancelGoalEdit();
      await onRoomStateChanged();
    } catch (reason) {
      onError(String(reason));
    } finally {
      onBusy(false);
    }
  }

  return {
    activeDiscussion,
    cancelGoalEdit,
    control,
    editGoal,
    expandedId,
    goalDraft,
    goalEditId,
    saveGoal,
    setExpandedId,
    setGoalDraft,
    visibleDiscussion,
    visibleDiscussionExpanded
  };
}
