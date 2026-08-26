import type { Agent } from "../../models.js";
import { removeVisibleMentionToken } from "../../structured-mentions.js";

export const keepMentionsPreferenceKey = "agent-room.keep-last-mentions";

export function readKeepMentionsPreference(): boolean {
  try {
    return localStorage.getItem(keepMentionsPreferenceKey) === "true";
  } catch {
    return false;
  }
}

export function writeKeepMentionsPreference(enabled: boolean): void {
  try {
    localStorage.setItem(keepMentionsPreferenceKey, String(enabled));
  } catch {
    // A blocked/full browser store must not prevent composing a message.
  }
}

export function removeRetainedMentionTokens(
  content: string,
  removed: readonly Pick<Agent, "name">[],
  knownAgents: readonly Pick<Agent, "name">[]
): string {
  const names = [...knownAgents, ...removed].map(({ name }) => name);
  return removed.reduce(
    (remaining, agent) => removeVisibleMentionToken(remaining, agent.name, names),
    content
  );
}
