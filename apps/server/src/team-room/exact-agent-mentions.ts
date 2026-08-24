interface MentionableAgent {
  agentId: string;
  name: string;
}

export interface ExactAgentMentionResolution {
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

function findMentionTokens(content: string, name: string): number[] {
  const token = `@${name}`;
  const indexes: number[] = [];
  let index = content.indexOf(token);
  while (index >= 0) {
    const before = index === 0 ? undefined : content[index - 1];
    const after = content[index + token.length];
    if (isMentionBoundary(before) && isMentionBoundary(after)) indexes.push(index);
    index = content.indexOf(token, index + token.length);
  }
  return indexes;
}

function findMentionToken(content: string, name: string): number {
  return findMentionTokens(content, name)[0] ?? -1;
}

function longestMentionIndexes(
  content: string,
  names: Iterable<string>
): Map<string, number> {
  const candidates: Array<{ index: number; name: string }> = [];
  for (const name of names) {
    for (const index of findMentionTokens(content, name)) {
      candidates.push({ index, name });
    }
  }
  const longestLengthByIndex = new Map<number, number>();
  for (const candidate of candidates) {
    longestLengthByIndex.set(
      candidate.index,
      Math.max(longestLengthByIndex.get(candidate.index) ?? 0, candidate.name.length)
    );
  }
  const firstIndexByName = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.name.length !== longestLengthByIndex.get(candidate.index)) continue;
    firstIndexByName.set(
      candidate.name,
      Math.min(firstIndexByName.get(candidate.name) ?? candidate.index, candidate.index)
    );
  }
  return firstIndexByName;
}

export function resolveExactAgentMentions(
  content: string,
  agents: readonly MentionableAgent[],
  knownAgents: readonly MentionableAgent[] = agents
): ExactAgentMentionResolution {
  if (findMentionToken(content, "all") >= 0) {
    return {
      agentIds: [...new Set(agents.map(({ agentId }) => agentId))],
      ambiguousNames: [],
      usesAll: true
    };
  }

  const eligibleAgentIds = new Set(agents.map(({ agentId }) => agentId));
  const agentsByName = new Map<string, MentionableAgent[]>();
  for (const agent of knownAgents) {
    const sameName = agentsByName.get(agent.name) ?? [];
    sameName.push(agent);
    agentsByName.set(agent.name, sameName);
  }
  const mentionIndexes = longestMentionIndexes(content, agentsByName.keys());
  const matches: Array<{ agentId: string; index: number }> = [];
  const ambiguous: Array<{ name: string; index: number }> = [];
  for (const [name, sameNameAgents] of agentsByName) {
    const index = mentionIndexes.get(name);
    if (index === undefined) continue;
    if (sameNameAgents.length !== 1) {
      if (sameNameAgents.some(({ agentId }) => eligibleAgentIds.has(agentId))) {
        ambiguous.push({ name, index });
      }
      continue;
    }
    const agentId = sameNameAgents[0]!.agentId;
    if (eligibleAgentIds.has(agentId)) matches.push({ agentId, index });
  }
  matches.sort((left, right) => left.index - right.index);
  ambiguous.sort((left, right) => left.index - right.index);
  return {
    agentIds: matches.map(({ agentId }) => agentId),
    ambiguousNames: ambiguous.map(({ name }) => name),
    usesAll: false
  };
}

export function containsExactAllMention(content: string): boolean {
  return findMentionToken(content, "all") >= 0;
}
