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

function findMentionToken(content: string, name: string): number {
  const token = `@${name}`;
  let index = content.indexOf(token);
  while (index >= 0) {
    const before = index === 0 ? undefined : content[index - 1];
    const after = content[index + token.length];
    if (isMentionBoundary(before) && isMentionBoundary(after)) return index;
    index = content.indexOf(token, index + token.length);
  }
  return -1;
}

export function resolveExactAgentMentions(
  content: string,
  agents: readonly MentionableAgent[]
): ExactAgentMentionResolution {
  if (findMentionToken(content, "all") >= 0) {
    return {
      agentIds: [...new Set(agents.map(({ agentId }) => agentId))],
      ambiguousNames: [],
      usesAll: true
    };
  }

  const agentsByName = new Map<string, MentionableAgent[]>();
  for (const agent of agents) {
    const sameName = agentsByName.get(agent.name) ?? [];
    sameName.push(agent);
    agentsByName.set(agent.name, sameName);
  }
  const matches: Array<{ agentId: string; index: number }> = [];
  const ambiguous: Array<{ name: string; index: number }> = [];
  for (const [name, sameNameAgents] of agentsByName) {
    const index = findMentionToken(content, name);
    if (index < 0) continue;
    if (sameNameAgents.length !== 1) {
      ambiguous.push({ name, index });
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

export function containsExactAllMention(content: string): boolean {
  return findMentionToken(content, "all") >= 0;
}
