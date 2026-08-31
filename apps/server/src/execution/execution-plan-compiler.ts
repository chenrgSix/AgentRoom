import type { ExecutionPlanProjection } from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import type { MemberPrincipal } from "../security/auth-service.js";
import { AuthorizationError } from "../security/auth-service.js";
import type { AgentTaskService } from "../task/agent-task-service.js";
import type { AgentTaskRecord, AgentTaskRepository } from "../task/task-repository.js";
import type { ResultRepository } from "../task/result-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { CompiledExecutionNode, ExecutionApprovalRepository } from "./execution-approval-repository.js";

export class ExecutionPlanCompiler {
  public constructor(
    private readonly tasks: AgentTaskService,
    private readonly taskRepository: AgentTaskRepository,
    private readonly results: ResultRepository,
    private readonly approvals: ExecutionApprovalRepository
  ) {}

  public compile(
    member: MemberPrincipal, plan: ExecutionPlanProjection, operationId: string, now: string
  ): CompiledExecutionNode[] {
    this.approvals.requireRootAvailable(plan);
    return plan.current.definition.nodes.map((node) => {
      let task: AgentTaskRecord;
      if (node.task.mode === "existing") {
        task = this.tasks.get(member, node.task.taskId!);
        if (member.role !== "owner" && task.ownerMemberId !== member.memberId) {
          throw new AuthorizationError("FORBIDDEN", "Linked Task Owner or Team Owner required");
        }
        this.approvals.requireTaskAvailable(task.taskId);
        if (this.taskRepository.hasActiveWork(task.taskId) ||
          this.taskRepository.hasUnacknowledgedAmbiguity(task.taskId)) {
          throw new ExecutionError("EXECUTION_NODE_HAS_ACTIVE_OR_UNKNOWN_WORK", 409);
        }
        if (!task.criteria.some((criterion) => criterion.required)) {
          throw new ExecutionError("EXECUTION_NODE_CRITERIA_REQUIRED");
        }
      } else {
        const blueprint = node.task;
        const create = (goal: string, parentTaskId: string) => this.tasks.create(member, {
          roomId: plan.roomId, parentTaskId, title: blueprint.title!, goal,
          ownerMemberId: blueprint.ownerMemberId!, completionPolicy: "accepted_result_required",
          lifecycleState: "draft", criteria: blueprint.criteria!,
          assignments: [{ agentId: node.agentId, role: "primary" }], budgetPolicy: node.budget
        }, now);
        if (blueprint.sourceAction) {
          const source = this.results.get(blueprint.sourceAction.resultId);
          const action = source?.proposal.nextActions.find((entry) => entry.nextActionKey === blueprint.sourceAction!.nextActionKey);
          if (!source || source.state !== "accepted" || source.taskId !== plan.rootTaskId || !action || action.description !== blueprint.goal) {
            throw new ExecutionError("EXECUTION_SOURCE_ACTION_UNAVAILABLE", 409);
          }
          let created = false;
          const childId = this.results.createChildSource({
            resultId: blueprint.sourceAction.resultId, nextActionKey: blueprint.sourceAction.nextActionKey,
            operationId: `op_${executionOperationDigest({ purpose: "execution_source_action", operationId, nodeKey: node.nodeKey })}`,
            memberId: member.memberId, now,
            createChild: (description, parentTaskId) => {
              if (parentTaskId !== plan.rootTaskId || description !== blueprint.goal) {
                throw new ExecutionError("EXECUTION_SOURCE_ACTION_MISMATCH");
              }
              created = true;
              return create(description, parentTaskId).taskId;
            }
          });
          if (!created) throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
          task = this.tasks.get(member, childId);
        } else {
          task = create(blueprint.goal!, plan.rootTaskId);
        }
        // The canonical Task service trims text. Do not silently compile different
        // criteria/goals under a digest that the human reviewed verbatim.
        if (task.title !== blueprint.title || task.goal !== blueprint.goal ||
          executionOperationDigest(task.criteria) !== executionOperationDigest(blueprint.criteria)) {
          throw new ExecutionError("EXECUTION_TASK_TEXT_NOT_CANONICAL");
        }
      }
      return { node, task };
    });
  }
}
