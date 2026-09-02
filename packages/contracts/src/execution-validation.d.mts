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
export function evidenceReuseInputDigest(value: unknown): string;
export function evidenceNodeReuseContractDigest(value: unknown): string;
export function evidenceReuseContractDigest(value: unknown): string;
export function remoteProviderBindingDigest(value: unknown): string;
export function remoteProviderBindingRevocationDigest(value: unknown): string;
export function providerObservationDigest(value: unknown): string;
export function remoteCommitObservationDigest(value: unknown): string;
export function remoteCIObservationReceiptDigest(value: unknown): string;
export function assertExecutionCommand(
  kind: "planDefinition" | "proposalCommand" | "discussionPlanProposalDraft" |
    "revisionCommand" |
    "approvalCommand" | "controlCommand" | "nodeRetryCommand" |
    "nodeRetryAuthorization" | "decisionContent" |
    "executionManifest" | "executionInputBinding" | "executionCapability" |
    "runtimeAuthorityRequest" | "runtimeAuthorityView" |
    "repositoryBinding" | "executionGrant" | "repositoryOperation" |
    "repositoryReceipt" | "executionCheckpoint" | "verificationReceipt" |
    "sourceEvidence" | "gateProofRef" | "evidenceAdoption" |
    "evidenceReuseContract" | "remoteProviderBinding" |
    "remoteProviderBindingRevocation" | "providerCommitObservation" |
    "remoteCommitObservation" | "providerCIObservation" |
    "remoteCIObservationReceipt",
  value: unknown
): void;
export function validateExecutionDecision(value: unknown): ExecutionDecisionContent;
export function validateExecutionPlanDefinition(value: unknown): {
  definition: ExecutionPlanDefinition;
  topologicalOrder: string[];
  digest: string;
  approvalBlockers: string[];
};
