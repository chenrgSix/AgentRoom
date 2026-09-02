import type {
  ExecutionDecisionContent,
  ExecutionPlanDefinition
} from "../generated/typescript/execution-plan.js";

export class ExecutionContractError extends Error {
  readonly code: string;
  constructor(code: string);
}

export function canonicalExecutionJSON(value: unknown): string;
export function executionOperationDigest(value: unknown): string;
export function sourceEvidenceDigest(value: unknown): string;
export function evidenceProofSetDigest(proofs: unknown): string;
export function evidenceAdoptionOperationDigest(value: unknown): string;
export function evidenceAdoptionDigest(value: unknown): string;
export function assertExecutionCommand(
  kind: "planDefinition" | "proposalCommand" | "discussionPlanProposalDraft" |
    "revisionCommand" |
    "approvalCommand" | "controlCommand" | "nodeRetryCommand" |
    "nodeRetryAuthorization" | "decisionContent" |
    "executionManifest" | "executionInputBinding" | "executionCapability" |
    "runtimeAuthorityRequest" | "runtimeAuthorityView" |
    "repositoryBinding" | "executionGrant" | "repositoryOperation" |
    "repositoryReceipt" | "executionCheckpoint" | "verificationReceipt" |
    "sourceEvidence" | "gateProofRef" | "evidenceAdoption",
  value: unknown
): void;
export function validateExecutionDecision(value: unknown): ExecutionDecisionContent;
export function validateExecutionPlanDefinition(value: unknown): {
  definition: ExecutionPlanDefinition;
  topologicalOrder: string[];
  digest: string;
  approvalBlockers: string[];
};
