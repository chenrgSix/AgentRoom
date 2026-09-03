import type {
  ExecutionAgentSupersessionActivationCommand,
  ExecutionAgentSupersessionCandidateCommand,
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanProposalCommand,
  ExecutionPlanRevisionCommand,
  ExecutionPlanSupersessionActivationReceipt,
  ExecutionPlanSupersessionCandidate
} from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand } from
  "@convene-wire/contracts/execution-validation";

import type { CoreRepository } from "../data/core-repository.js";
import { ExecutionError } from "../execution/execution-error.js";
import type { ExecutionPlanDraftWriter } from
  "../execution/execution-plan-draft-writer.js";
import type { ExecutionPlanRepository } from
  "../execution/execution-plan-repository.js";
import type { ExecutionPlanSupersessionService } from
  "../execution/execution-plan-supersession-service.js";
import type { RunContextManifest, RunRecord, RunRepository } from
  "../run/run-repository.js";
import type { McpPrincipal } from "../security/auth-service.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";

const terminalRunStates = new Set([
  "completed", "failed", "canceled", "expired", "outcome_unknown"
]);

interface TechLeadDelegation {
  manifest: RunContextManifest;
  root: AgentTaskRecord;
  run: RunRecord;
}

// A Tech Lead is the exact primary Task assignment plus this own Run/context,
// never an Agent role label. This service retains drafts only.
export class ManualExecutionPlanService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly runs: RunRepository,
    private readonly plans: ExecutionPlanRepository,
    private readonly drafts: ExecutionPlanDraftWriter,
    private readonly supersessions: ExecutionPlanSupersessionService
  ) {}

  public propose(
    principal: McpPrincipal,
    runId: string,
    value: unknown,
    now: string
  ): ExecutionPlanProjection {
    assertExecutionCommand("proposalCommand", value);
    const command = value as ExecutionPlanProposalCommand;
    return this.drafts.write({
      rootTaskId: command.definition.rootTaskId,
      command,
      author: { kind: "agent", agentId: principal.agentId, runId },
      authorize: (root, plan) => {
        if (plan) throw new ExecutionError("EXECUTION_AGENT_PLAN_SCOPE_MISMATCH");
        const delegation = this.requireDelegation(principal, runId, "mutate", root);
        this.requireCommandContext(command, delegation);
      },
      now
    });
  }

  public get(
    principal: McpPrincipal,
    runId: string,
    planId: string
  ): ExecutionPlanProjection {
    const delegation = this.requireDelegation(principal, runId, "read");
    const plan = this.plans.get(planId);
    if (!plan || plan.rootTaskId !== delegation.root.taskId ||
      plan.roomId !== delegation.run.roomId) {
      throw new ExecutionError("EXECUTION_AGENT_PLAN_ACCESS_DENIED", 404);
    }
    return plan;
  }

  public revise(
    principal: McpPrincipal,
    runId: string,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionPlanProjection {
    assertExecutionCommand("revisionCommand", value);
    const command = value as ExecutionPlanRevisionCommand;
    const selected = this.get(principal, runId, planId);
    return this.drafts.write({
      rootTaskId: selected.rootTaskId,
      planId,
      command,
      author: { kind: "agent", agentId: principal.agentId, runId },
      authorize: (root, plan) => {
        const delegation = this.requireDelegation(principal, runId, "mutate", root);
        if (!plan || plan.planId !== planId || plan.rootTaskId !== root.taskId ||
          plan.roomId !== delegation.run.roomId) {
          throw new ExecutionError("EXECUTION_AGENT_PLAN_SCOPE_MISMATCH");
        }
        this.requireCommandContext(command, delegation);
      },
      now
    });
  }

  public proposeSupersession(
    principal: McpPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionPlanSupersessionCandidate {
    assertExecutionCommand("agentSupersessionCandidateCommand", value);
    const input = value as ExecutionAgentSupersessionCandidateCommand;
    const delegation = this.requireDelegation(
      principal,
      input.runId,
      "mutate"
    );
    const plan = this.get(principal, input.runId, planId);
    if (plan.rootTaskId !== delegation.root.taskId) {
      throw new ExecutionError("EXECUTION_AGENT_PLAN_SCOPE_MISMATCH");
    }
    this.requireCommandContext(input.command, delegation);
    return this.supersessions.proposeForAgent(
      planId,
      input.command,
      { kind: "agent", agentId: principal.agentId, runId: input.runId },
      now
    );
  }

  public activateSupersession(
    principal: McpPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionPlanSupersessionActivationReceipt {
    assertExecutionCommand("agentSupersessionActivationCommand", value);
    const input = value as ExecutionAgentSupersessionActivationCommand;
    const author = {
      kind: "agent" as const,
      agentId: principal.agentId,
      runId: input.runId
    };
    const replay = this.supersessions.replayForAgent(
      planId,
      input.command,
      author,
      input.delegationId
    );
    if (replay) return replay;
    const delegation = this.requireDelegation(
      principal,
      input.runId,
      "mutate"
    );
    const plan = this.get(principal, input.runId, planId);
    if (plan.rootTaskId !== delegation.root.taskId) {
      throw new ExecutionError("EXECUTION_AGENT_PLAN_SCOPE_MISMATCH");
    }
    return this.supersessions.activateForAgent(
      planId,
      input.command,
      author,
      input.delegationId,
      now
    );
  }

  private requireDelegation(
    principal: McpPrincipal,
    runId: string,
    access: "read" | "mutate",
    expectedRoot?: AgentTaskRecord
  ): TechLeadDelegation {
    const agent = this.core.getAgent(principal.agentId);
    const run = this.runs.getRun(runId);
    const root = run ? this.tasks.get(run.taskId) : undefined;
    const manifest = run ? this.runs.getContextManifest(run.runId) : undefined;
    const room = run ? this.core.getRoom(run.roomId) : undefined;
    const memberHasRoom = run
      ? this.core.listRoomsForMember(principal.teamId, principal.memberId)
        .some(({ roomId }) => roomId === run.roomId)
      : false;
    const currentPrimary = root?.assignments.some(({ agentId, role }) =>
      agentId === principal.agentId && role === "primary") ?? false;
    const stateAllowed = access === "mutate"
      ? run?.state === "working"
      : Boolean(run && !terminalRunStates.has(run.state));
    if (!agent || !agent.enabled || agent.integrationMode !== "manual" ||
      agent.agentId !== principal.agentId || agent.teamId !== principal.teamId ||
      agent.ownerMemberId !== principal.memberId || !run || !root || !manifest ||
      !room || room.archivedAt || room.teamId !== principal.teamId ||
      run.targetAgentId !== principal.agentId || run.roomId !== root.roomId ||
      run.taskId !== root.taskId || !memberHasRoom ||
      !this.core.isRoomAgent(run.roomId, principal.agentId) ||
      root.teamId !== principal.teamId || root.isDefault ||
      root.parentTaskId !== null || !currentPrimary || !stateAllowed ||
      manifest.runId !== run.runId || manifest.taskId !== root.taskId ||
      manifest.target.agentId !== principal.agentId ||
      manifest.taskRevision !== root.taskRevision ||
      manifest.definitionRevision !== root.definitionRevision ||
      manifest.criteriaRevision !== root.criteriaRevision ||
      (expectedRoot && expectedRoot.taskId !== root.taskId)) {
      throw new ExecutionError("EXECUTION_TECH_LEAD_DELEGATION_REQUIRED");
    }
    return { manifest, root, run };
  }

  private requireCommandContext(
    command: ExecutionPlanProposalCommand | ExecutionPlanRevisionCommand |
      ExecutionAgentSupersessionCandidateCommand["command"],
    delegation: TechLeadDelegation
  ): void {
    if (command.definition.rootTaskId !== delegation.root.taskId ||
      command.expectedRootTaskRevision !== delegation.manifest.taskRevision ||
      !this.hasOwnContextSource(command.definition, delegation.run)) {
      throw new ExecutionError("EXECUTION_TECH_LEAD_CONTEXT_MISMATCH");
    }
  }

  private hasOwnContextSource(
    definition: ExecutionPlanDefinition,
    run: RunRecord
  ): boolean {
    const revisions = new Map(definition.decision.sourceRevisions.map((pin) =>
      [pin.evidenceRefId, pin.revision]));
    const trigger = this.core.getMessage(run.triggerMessageId);
    return definition.decision.sources.some((source) => {
      const revision = revisions.get(source.evidenceRefId);
      if (source.kind === "message") {
        return source.messageId === run.triggerMessageId &&
          trigger?.sequence === revision;
      }
      if (source.kind !== "run_event" || source.runId !== run.runId ||
        source.sequence !== revision) return false;
      return this.runs.listEvents(run.runId).some(({ event }) =>
        event.sequence === source.sequence);
    });
  }
}
