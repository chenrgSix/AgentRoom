import type {
  EvidenceAdoption,
  EvidenceReuseContract,
  ExecutionInputBinding,
  ExecutionPlanDefinition
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  evidenceNodeReuseContractDigest,
  evidenceReuseContractDigest,
  evidenceReuseInputDigest,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

type PlanNode = ExecutionPlanDefinition["nodes"][number];
type PlanPolicy = ExecutionPlanDefinition["policy"];
type ReuseInput = EvidenceReuseContract["reuseInputs"][number];
type ReuseTask = EvidenceReuseContract["task"] & { taskRevision: number };

const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function runtimeInputBindingDigest(
  bindings: ExecutionInputBinding[]
): string {
  const ordered = bindings.map((binding) => structuredClone(binding)).sort(
    (left, right) => binary(left.inputSlot, right.inputSlot) ||
      binary(left.bindingId, right.bindingId)
  );
  return executionOperationDigest(ordered);
}

export function createEvidenceReuseContract(input: {
  adoption: EvidenceAdoption;
  bindings: ExecutionInputBinding[];
  integrationPolicy: PlanPolicy;
  node: PlanNode;
  reuseInputs: ReuseInput[];
  task: ReuseTask;
}): EvidenceReuseContract {
  const runtimeDigest = runtimeInputBindingDigest(input.bindings);
  if (runtimeDigest !== input.adoption.resolvedInputSetDigest) {
    throw new Error("Evidence reuse runtime input digest conflicts with adoption");
  }
  if (
    input.node.nodeKey !== input.adoption.nodeKey ||
    input.task.taskId !== input.adoption.authority.taskId ||
    input.task.roomId !== input.adoption.authority.roomId ||
    input.task.definitionRevision !==
      input.adoption.authority.definitionRevision ||
    input.task.criteriaRevision !== input.adoption.authority.criteriaRevision ||
    input.bindings.some((binding) =>
      binding.planId !== input.adoption.planId ||
      binding.planRevision !== input.adoption.planRevision) ||
    input.bindings.length !== input.reuseInputs.length ||
    input.bindings.some((binding) => !input.reuseInputs.some((reuse) =>
      reuse.inputSlot === binding.inputSlot))
  ) {
    throw new Error("Evidence reuse context conflicts with adoption");
  }
  return sealEvidenceReuseContract({
    adoption: input.adoption,
    integrationPolicy: input.integrationPolicy,
    node: input.node,
    reuseInputs: input.reuseInputs,
    runtimeDigest,
    task: input.task
  });
}

/** Remote adoption has no Runtime destination bindings; its logical inputs are
 * sealed by RemoteInputAttestation and retained separately from dispatch state. */
export function createRemoteEvidenceReuseContract(input: {
  adoption: EvidenceAdoption;
  integrationPolicy: PlanPolicy;
  node: PlanNode;
  reuseInputs: ReuseInput[];
  task: ReuseTask;
}): EvidenceReuseContract {
  const runtimeDigest = runtimeInputBindingDigest([]);
  if (input.adoption.authority.service !== "remote_evidence_adoption" ||
    input.adoption.resolvedInputSetDigest !== runtimeDigest ||
    input.node.nodeKey !== input.adoption.nodeKey ||
    input.task.taskId !== input.adoption.authority.taskId ||
    input.task.roomId !== input.adoption.authority.roomId ||
    input.task.definitionRevision !==
      input.adoption.authority.definitionRevision ||
    input.task.criteriaRevision !== input.adoption.authority.criteriaRevision) {
    throw new Error("Remote evidence reuse context conflicts with adoption");
  }
  return sealEvidenceReuseContract({
    adoption: input.adoption,
    integrationPolicy: input.integrationPolicy,
    node: input.node,
    reuseInputs: input.reuseInputs,
    runtimeDigest,
    task: input.task
  });
}

function sealEvidenceReuseContract(input: {
  adoption: EvidenceAdoption;
  integrationPolicy: PlanPolicy;
  node: PlanNode;
  reuseInputs: ReuseInput[];
  runtimeDigest: string;
  task: ReuseTask;
}): EvidenceReuseContract {
  const { task: _planTask, ...node } = structuredClone(input.node);
  const { taskRevision: _taskRevision, ...task } = structuredClone(input.task);
  const repositoryId = node.repository.repositoryId;
  const integrationTargets = input.integrationPolicy.integrationTargets
    .filter((target) => target.repositoryId === repositoryId)
    .map((target) => structuredClone(target))
    .sort((left, right) =>
      binary(left.repositoryId, right.repositoryId) ||
      binary(left.targetRef, right.targetRef) ||
      binary(left.expectedCommit, right.expectedCommit)
    );
  const reuseInputs = input.reuseInputs.map((entry) =>
    structuredClone(entry)).sort((left, right) =>
    binary(left.inputSlot, right.inputSlot)
  );
  const pending: EvidenceReuseContract = {
    version: 1,
    reuseContractId: "reuse_pending0001",
    adoptionId: input.adoption.adoptionId,
    adoptionDigest: input.adoption.adoptionDigest,
    planId: input.adoption.planId,
    planRevision: input.adoption.planRevision,
    nodeKey: input.adoption.nodeKey,
    gate: input.adoption.gate,
    runtimeInputBindingDigest: input.runtimeDigest,
    reuseInputs,
    reuseInputEvidenceDigest: evidenceReuseInputDigest(reuseInputs),
    nodeExecutionDigest: input.adoption.nodeContractDigest,
    node,
    task,
    integrationPolicy: {
      integration: input.integrationPolicy.integration,
      requireHumanIntegrationApproval:
        input.integrationPolicy.requireHumanIntegrationApproval,
      integrationTargets
    },
    nodeReuseContractDigest: "0".repeat(64),
    contractDigest: "0".repeat(64),
    createdAt: input.adoption.createdAt
  };
  pending.nodeReuseContractDigest = evidenceNodeReuseContractDigest(pending);
  pending.contractDigest = evidenceReuseContractDigest(pending);
  pending.reuseContractId = `reuse_${executionOperationDigest({
    adoptionId: pending.adoptionId,
    contractDigest: pending.contractDigest
  })}`;
  assertExecutionCommand("evidenceReuseContract", pending);
  return pending;
}
