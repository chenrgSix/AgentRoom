export interface DiscussionEvidenceScope {
  roomId: string;
  taskId: string | null;
}

export interface DiscussionEvidenceReferenceLookups {
  message: (reference: string) => DiscussionEvidenceScope | undefined;
  run: (reference: string) => DiscussionEvidenceScope | undefined;
  artifact: (reference: string) => DiscussionEvidenceScope | undefined;
  result: (reference: string) => DiscussionEvidenceScope | undefined;
  memory: (reference: string) => DiscussionEvidenceScope | undefined;
  discussion: (reference: string) => DiscussionEvidenceScope | undefined;
}

function resolveReference(
  reference: string,
  lookups: DiscussionEvidenceReferenceLookups
): DiscussionEvidenceScope | undefined {
  if (reference.startsWith("msg_")) return lookups.message(reference);
  if (reference.startsWith("run_")) return lookups.run(reference);
  if (reference.startsWith("artifact_")) return lookups.artifact(reference);
  if (reference.startsWith("result_")) return lookups.result(reference);
  if (reference.startsWith("memory_")) return lookups.memory(reference);
  if (reference.startsWith("discussion_")) return lookups.discussion(reference);
  return undefined;
}

export function verifyDiscussionEvidenceReferences(
  scope: { roomId: string; taskId: string },
  references: readonly string[],
  lookups: DiscussionEvidenceReferenceLookups
): string[] {
  return [...new Set(references)].filter((reference) => {
    const resolved = resolveReference(reference, lookups);
    return resolved?.roomId === scope.roomId && resolved.taskId === scope.taskId;
  }).sort((left, right) => left.localeCompare(right, "en-US"));
}
