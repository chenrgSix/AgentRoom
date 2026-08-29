import { exceedsUnicodeCodePointLimit } from "../domain/unicode-length.js";

export const maximumAgentMentionDisplayLabelCodePoints = 160;

export function agentMentionDisplayLabel(name: string, role: string): string {
  const label = `${name} / ${role}`;
  return exceedsUnicodeCodePointLimit(
    label,
    maximumAgentMentionDisplayLabelCodePoints
  )
    ? [...label].slice(0, maximumAgentMentionDisplayLabelCodePoints).join("")
    : label;
}
