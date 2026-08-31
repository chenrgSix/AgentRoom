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
export function assertExecutionCommand(
  kind: "planDefinition" | "proposalCommand" | "revisionCommand" |
    "approvalCommand" | "controlCommand" | "decisionContent" |
    "executionManifest" | "executionInputBinding" | "executionCapability" |
    "runtimeAuthorityRequest" | "runtimeAuthorityView" |
    "repositoryBinding" | "executionGrant" | "repositoryOperation" |
    "repositoryReceipt" | "executionCheckpoint" | "verificationReceipt",
  value: unknown
): void;
export function validateExecutionDecision(value: unknown): ExecutionDecisionContent;
export function validateExecutionPlanDefinition(value: unknown): {
  definition: ExecutionPlanDefinition;
  topologicalOrder: string[];
  digest: string;
  approvalBlockers: string[];
};
