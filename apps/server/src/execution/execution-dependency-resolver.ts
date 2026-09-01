import type { ExecutionPlanDefinition } from
  "@convene-wire/contracts/execution-plan";
import { validateExecutionPlanDefinition } from
  "@convene-wire/contracts/execution-validation";

import type { ExecutionInputSelection } from
  "./execution-input-service.js";
import type { ExecutionNodeMaterializationRepository } from
  "./execution-node-materialization-repository.js";
import type { ExecutionNodeIdentity } from
  "./execution-node-state-repository.js";
import type { ExecutionPlanRepository } from
  "./execution-plan-repository.js";
import type { ExecutionReadinessBlocker } from
  "./execution-readiness-evaluator.js";

export type ExecutionDependencyResolution =
  | { ready: true; selections: ExecutionInputSelection[] }
  | { ready: false; blocker: ExecutionReadinessBlocker };

const blocked = (
  blocker: ExecutionReadinessBlocker
): ExecutionDependencyResolution => ({ ready: false, blocker });
const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Read-only graph-to-selection adapter; final authority remains freezeForRun. */
export class ExecutionDependencyResolver {
  public constructor(
    private readonly plans: ExecutionPlanRepository,
    private readonly materializations: ExecutionNodeMaterializationRepository
  ) {}

  public resolve(identity: ExecutionNodeIdentity): ExecutionDependencyResolution {
    const plan = this.plans.get(identity.planId);
    if (!plan || plan.current.revision !== identity.planRevision ||
      !["approved", "running"].includes(plan.state)) {
      return blocked("EXECUTION_PLAN_STALE");
    }
    const validated = validateExecutionPlanDefinition(plan.current.definition);
    if (validated.digest !== plan.current.digest) {
      return blocked("EXECUTION_PLAN_STALE");
    }
    const node = validated.definition.nodes.find(
      (candidate) => candidate.nodeKey === identity.nodeKey
    );
    if (!node) return blocked("EXECUTION_PLAN_STALE");
    const incoming = validated.definition.edges
      .filter((edge) => edge.toNodeKey === node.nodeKey)
      .sort((left, right) => this.edgeOrder(
        validated.topologicalOrder,
        left,
        right
      ));
    const selections: ExecutionInputSelection[] = [];
    const occupied = new Set<string>();
    for (const edge of incoming) {
      const source = validated.definition.nodes.find(
        (candidate) => candidate.nodeKey === edge.fromNodeKey
      );
      const materialization = this.materializations.get({
        ...identity,
        nodeKey: edge.fromNodeKey
      }, edge.gate);
      if (!source || !materialization || materialization.gate !== edge.gate) {
        return blocked("EXECUTION_DEPENDENCY_NOT_MATERIALIZED");
      }
      for (const binding of [...edge.bindings].sort((left, right) =>
        binary(left.inputSlot, right.inputSlot)
      )) {
        const input = node.inputs.find(
          (candidate) => candidate.slotKey === binding.inputSlot
        );
        const output = source.outputs.find(
          (candidate) => candidate.slotKey === binding.outputSlot
        );
        const artifact = materialization.artifactPins.find(
          (candidate) => candidate.outputSlot === binding.outputSlot
        );
        if (!input || !output || !artifact || occupied.has(input.slotKey) ||
          input.kind !== output.kind || artifact.kind !== input.kind) {
          return blocked("EXECUTION_DEPENDENCY_SELECTION_INVALID");
        }
        occupied.add(input.slotKey);
        selections.push({
          inputSlot: input.slotKey,
          sourceResultId: materialization.sourceResultId,
          artifactId: artifact.artifactId
        });
      }
    }
    if (node.inputs.some((input) => input.required && !occupied.has(input.slotKey))) {
      return blocked(incoming.length === 0
        ? "EXECUTION_REQUIRED_INPUT_UNSUPPORTED"
        : "EXECUTION_DEPENDENCY_SELECTION_INVALID");
    }
    return { ready: true, selections };
  }

  private edgeOrder(
    topologicalOrder: string[],
    left: ExecutionPlanDefinition["edges"][number],
    right: ExecutionPlanDefinition["edges"][number]
  ): number {
    return topologicalOrder.indexOf(left.fromNodeKey) -
      topologicalOrder.indexOf(right.fromNodeKey) ||
      binary(left.edgeKey, right.edgeKey);
  }
}
