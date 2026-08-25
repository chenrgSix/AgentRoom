import type {
  ArtifactRelationInput,
  ArtifactRelationType
} from "../task/artifact-lineage.js";
import { requiredString } from "./http-helpers.js";

export function artifactRelationInput(
  value: unknown
): ArtifactRelationInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("relations must be an array with at most 20 entries");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("relation must be a JSON object");
    }
    const relation = item as Record<string, unknown>;
    return {
      type: requiredString(relation.type, "relation type") as ArtifactRelationType,
      targetArtifactId: requiredString(
        relation.targetArtifactId,
        "relation targetArtifactId",
        140
      )
    };
  });
}
