export type ArtifactRelationType = "derives_from" | "reviews" | "verifies";

export interface ArtifactRelationInput {
  type: ArtifactRelationType;
  targetArtifactId: string;
}

export interface TaskArtifactRelationRecord extends ArtifactRelationInput {
  relationId: string;
  sourceArtifactId: string;
  taskId: string;
  roomId: string;
  createdByMemberId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
}

const relationTypes = new Set<ArtifactRelationType>([
  "derives_from", "reviews", "verifies"
]);
const artifactIdPattern = /^artifact_[A-Za-z0-9_-]{8,128}$/u;

export function normalizeArtifactRelations(
  relations: readonly ArtifactRelationInput[] | undefined
): ArtifactRelationInput[] {
  if (relations === undefined) return [];
  if (!Array.isArray(relations) || relations.length > 20) {
    throw new Error("Artifact relations must contain at most 20 entries");
  }
  const normalized = relations.map((relation) => {
    if (
      !relation || typeof relation !== "object" ||
      !relationTypes.has(relation.type) ||
      !artifactIdPattern.test(relation.targetArtifactId)
    ) {
      throw new Error("Artifact relation is invalid");
    }
    return {
      type: relation.type,
      targetArtifactId: relation.targetArtifactId
    };
  }).sort((left, right) =>
    left.targetArtifactId.localeCompare(right.targetArtifactId) ||
    left.type.localeCompare(right.type)
  );
  const identities = new Set<string>();
  for (const relation of normalized) {
    const identity = `${relation.targetArtifactId}\u0000${relation.type}`;
    if (identities.has(identity)) {
      throw new Error("Artifact relations must be unique");
    }
    identities.add(identity);
  }
  return normalized;
}
