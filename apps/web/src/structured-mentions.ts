interface MentionIdentity {
  name: string;
}

const mentionBoundaryPunctuation = new Set(
  [..."()[]{}<>,.!?;:'\"，。！？；：（）【】《》"]
);

function isMentionBoundary(character: string | undefined): boolean {
  return character === undefined ||
    /\s/u.test(character) ||
    mentionBoundaryPunctuation.has(character);
}

function findMentionToken(
  content: string,
  agentName: string,
  fromIndex = 0
): number {
  const token = `@${agentName}`;
  let index = content.indexOf(token, fromIndex);
  while (index >= 0) {
    const before = index === 0 ? undefined : content[index - 1];
    const after = content[index + token.length];
    if (isMentionBoundary(before) && isMentionBoundary(after)) return index;
    index = content.indexOf(token, index + token.length);
  }
  return -1;
}

function countMentionTokens(content: string, agentName: string): number {
  const tokenLength = agentName.length + 1;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex <= content.length) {
    const index = findMentionToken(content, agentName, fromIndex);
    if (index < 0) return count;
    count += 1;
    fromIndex = index + tokenLength;
  }
  return count;
}

export function retainVisibleMentionIds(
  content: string,
  agentIds: readonly string[],
  agentsById: ReadonlyMap<string, MentionIdentity>
): string[] {
  const remainingByName = new Map<string, number>();
  return agentIds.filter((agentId) => {
    const agent = agentsById.get(agentId);
    if (!agent) return false;
    const remaining = remainingByName.get(agent.name) ??
      countMentionTokens(content, agent.name);
    if (remaining === 0) return false;
    remainingByName.set(agent.name, remaining - 1);
    return true;
  });
}

export function removeVisibleMentionToken(
  content: string,
  agentName: string
): string {
  const token = `@${agentName}`;
  const start = findMentionToken(content, agentName);
  if (start < 0) return content;
  const tokenEnd = start + token.length;
  const end = content[tokenEnd] === " " ? tokenEnd + 1 : tokenEnd;
  return `${content.slice(0, start)}${content.slice(end)}`;
}
