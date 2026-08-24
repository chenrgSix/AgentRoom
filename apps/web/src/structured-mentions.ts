interface MentionIdentity {
  name: string;
}

interface ExactMentionAgent extends MentionIdentity {
  agentId: string;
}

export interface ExactMentionCommandResolution {
  agentIds: string[];
  ambiguousNames: string[];
  usesAll: boolean;
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

export function resolveExactMentionCommands(
  content: string,
  agents: readonly ExactMentionAgent[]
): ExactMentionCommandResolution {
  if (findMentionToken(content, "all") >= 0) {
    return {
      agentIds: [...new Set(agents.map(({ agentId }) => agentId))],
      ambiguousNames: [],
      usesAll: true
    };
  }

  const agentsByName = new Map<string, ExactMentionAgent[]>();
  for (const agent of agents) {
    const sameName = agentsByName.get(agent.name) ?? [];
    sameName.push(agent);
    agentsByName.set(agent.name, sameName);
  }

  const matches: Array<{ agentId: string; index: number }> = [];
  const ambiguous: Array<{ index: number; name: string }> = [];
  for (const [name, sameNameAgents] of agentsByName) {
    const index = findMentionToken(content, name);
    if (index < 0) continue;
    if (sameNameAgents.length > 1) {
      ambiguous.push({ index, name });
      continue;
    }
    matches.push({ agentId: sameNameAgents[0]!.agentId, index });
  }

  matches.sort((left, right) => left.index - right.index);
  ambiguous.sort((left, right) => left.index - right.index);
  return {
    agentIds: matches.map(({ agentId }) => agentId),
    ambiguousNames: ambiguous.map(({ name }) => name),
    usesAll: false
  };
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
