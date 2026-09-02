import type {
  EvidenceAdoption,
  GateProofRef,
  SourceEvidence
} from "@convene-wire/contracts/execution-plan";

import type { EvidenceAdoptionBundle } from
  "./execution-evidence-adoption-repository.js";
import type { ExecutionNodeMaterialization } from
  "./execution-node-materialization-repository.js";

export type LocalExecutionMaterializationProjection =
  ExecutionNodeMaterialization & { projectionVersion: 1 };

export interface GeneralizedExecutionMaterializationProjection {
  adoption: {
    adoptionDigest: string;
    adoptionId: string;
    operationDigest: string;
    operationId: string;
  };
  artifactPins: SourceEvidence["artifactPins"];
  companionResult?: {
    resultId: string;
    resultVersion: number;
    sourceDigest: string;
    sourceEvidenceId: string;
  };
  gate: EvidenceAdoption["gate"];
  legacyMaterializationDigest: string;
  nodeKey: string;
  planId: string;
  planRevision: number;
  projectionVersion: 2;
  proofs: EvidenceAdoption["proofs"];
  sourceEvidence: {
    kind: SourceEvidence["kind"];
    sourceDigest: string;
    sourceEvidenceId: string;
  } & ({
    kind: "task_result";
  } | {
    commit: string;
    inputDigest: string;
    kind: "repository_commit";
    objectFormat: "sha1" | "sha256";
    repositoryId: string;
    tree: string;
  });
  sourceExecution: EvidenceAdoption["sourceExecution"];
}

export type ExecutionMaterializationProjection =
  | LocalExecutionMaterializationProjection
  | GeneralizedExecutionMaterializationProjection;

function resultIdentity(source: SourceEvidence):
  GeneralizedExecutionMaterializationProjection["companionResult"] {
  if (
    source.kind !== "task_result" ||
    !source.resultId ||
    source.resultVersion === undefined
  ) return undefined;
  return {
    sourceEvidenceId: source.sourceEvidenceId,
    sourceDigest: source.sourceDigest,
    resultId: source.resultId,
    resultVersion: source.resultVersion
  };
}

/**
 * Version 2 is source-evidence native. A companion Result is omitted rather
 * than represented by a nullable or fabricated Result identity.
 */
export function projectGeneralizedExecutionMaterialization(
  bundle: EvidenceAdoptionBundle,
  companion?: SourceEvidence
): GeneralizedExecutionMaterializationProjection {
  const { adoption, source } = bundle;
  const sourceEvidence = source.kind === "repository_commit"
    ? {
      kind: source.kind,
      sourceEvidenceId: source.sourceEvidenceId,
      sourceDigest: source.sourceDigest,
      repositoryId: source.repositoryId!,
      objectFormat: source.objectFormat!,
      commit: source.commit!,
      tree: source.tree!,
      inputDigest: source.inputDigest!
    }
    : {
      kind: source.kind,
      sourceEvidenceId: source.sourceEvidenceId,
      sourceDigest: source.sourceDigest
    };
  const companionResult = resultIdentity(
    source.kind === "task_result" ? source : companion ?? source
  );
  return {
    projectionVersion: 2,
    planId: adoption.planId,
    planRevision: adoption.planRevision,
    nodeKey: adoption.nodeKey,
    gate: adoption.gate,
    sourceEvidence,
    sourceExecution: adoption.sourceExecution,
    proofs: adoption.proofs.map((proof) => ({ ...proof })) as [
      GateProofRef,
      ...GateProofRef[]
    ],
    artifactPins: source.artifactPins.map((pin) => ({ ...pin })) as
      SourceEvidence["artifactPins"],
    adoption: {
      adoptionId: adoption.adoptionId,
      adoptionDigest: adoption.adoptionDigest,
      operationId: adoption.operationId,
      operationDigest: adoption.operationDigest
    },
    legacyMaterializationDigest: bundle.legacyMaterializationDigest,
    ...(companionResult ? { companionResult } : {})
  };
}

export function projectLocalExecutionMaterialization(
  materialization: ExecutionNodeMaterialization
): LocalExecutionMaterializationProjection {
  return { projectionVersion: 1, ...structuredClone(materialization) };
}
