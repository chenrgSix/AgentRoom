import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { RunRecord } from "../run/run-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionNodeStateRepository } from
  "./execution-node-state-repository.js";
import type { ExecutionSchedulerCandidate } from
  "./execution-node-state-repository.js";
import type { ExecutionNodeProjector } from "./execution-node-projector.js";
import type { ExecutionSettlementService } from
  "./execution-settlement-service.js";
import type { GovernedRunAdmissionService } from
  "./governed-run-admission-service.js";
import type { ExecutionSchedulerMode } from
  "./execution-scheduler-control-repository.js";
import type { ExecutionSchedulerFairnessRepository } from
  "./execution-scheduler-fairness-repository.js";

export interface ExecutionSchedulerSweepOptions {
  maxAdmissions?: number;
  mode?: Extract<ExecutionSchedulerMode, "automatic" | "supervised">;
  operationId?: string | null;
  planId?: string;
}

export class ExecutionScheduler {
  private sweeping = false;

  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly nodes: ExecutionNodeStateRepository,
    private readonly projector: ExecutionNodeProjector,
    private readonly settlement: ExecutionSettlementService,
    private readonly admission: GovernedRunAdmissionService,
    private readonly fairness: ExecutionSchedulerFairnessRepository,
    private readonly clock: () => string,
    private readonly maxCandidateEvaluations = 256
  ) {}

  public sweep(options: ExecutionSchedulerSweepOptions = {}): RunRecord[] {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const now = this.clock();
      const mode = options.mode ?? "automatic";
      const operationId = options.operationId ?? null;
      if ((mode === "automatic") !== (operationId === null)) {
        throw new ExecutionError("EXECUTION_SCHEDULER_AUTHORITY_INVALID");
      }
      const maxAdmissions = options.maxAdmissions ??
        this.maxCandidateEvaluations;
      const admitted: RunRecord[] = [];
      this.transactions.immediate(() => this.nodes.ensureCurrent(now));
      const queues = this.planQueues(this.nodes.listCandidates({
        mode,
        ...(options.planId ? { planId: options.planId } : {})
      }));
      let evaluated = 0;
      while (evaluated < this.maxCandidateEvaluations &&
        admitted.length < maxAdmissions) {
        this.settlement.reconcile(now);
        let progressed = false;
        for (const queue of this.orderQueues(queues)) {
          const candidatesThisRound = queue.length;
          for (
            let index = 0;
            index < candidatesThisRound &&
              evaluated < this.maxCandidateEvaluations &&
              admitted.length < maxAdmissions;
            index += 1
          ) {
            const identity = queue.shift()!;
            evaluated += 1;
            const readiness = this.admission.readiness(identity, now);
            this.transactions.immediate(() => {
              this.projector.projectReadiness(identity, readiness, now);
            });
            if (!readiness.ready) {
              queue.push(identity);
              continue;
            }
            try {
              const result = this.admission.admitScheduled(identity, now, {
                expectedFairnessCursorRevision:
                  this.fairness.revision(identity.agentId),
                mode,
                modeRevision: identity.schedulerModeRevision,
                operationId
              });
              if (!result.created) continue;
              admitted.push(...result.runs);
              this.settlement.reconcileOne(identity, now);
              progressed = true;
              break;
            } catch (error) {
              if (!(error instanceof ExecutionError)) throw error;
              this.transactions.immediate(() => {
                this.projector.projectReadiness(identity, {
                  ready: false,
                  blocker: error.code
                }, now);
              });
              queue.push(identity);
            }
          }
        }
        if (!progressed || queues.every((queue) => queue.length === 0)) break;
      }
      return [...new Map(admitted.map((run) => [run.runId, run])).values()];
    } finally {
      this.sweeping = false;
    }
  }

  private planQueues(
    candidates: ExecutionSchedulerCandidate[]
  ): ExecutionSchedulerCandidate[][] {
    const queues = new Map<string, ExecutionSchedulerCandidate[]>();
    for (const candidate of candidates) {
      const key = `${candidate.planApprovedAt}\0${candidate.planId}`;
      const queue = queues.get(key);
      if (queue) {
        queue.push(candidate);
      } else {
        queues.set(key, [candidate]);
      }
    }
    return [...queues.values()];
  }

  private orderQueues(
    queues: ExecutionSchedulerCandidate[][]
  ): ExecutionSchedulerCandidate[][] {
    const remaining = queues.filter((queue) => queue.length > 0);
    const ordered: ExecutionSchedulerCandidate[][] = [];
    while (remaining.length > 0) {
      const base = remaining[0]!;
      const agentId = base[0]!.agentId;
      const matching = remaining
        .map((queue, index) => ({ index, queue }))
        .filter(({ queue }) => queue[0]!.agentId === agentId);
      const cursor = this.fairness.get(agentId);
      const previous = cursor
        ? matching.findIndex(({ queue }) =>
            queue[0]!.planId === cursor.lastPlanId &&
            queue[0]!.planRevision === cursor.lastPlanRevision)
        : -1;
      const selected = matching[(previous + 1) % matching.length]!;
      ordered.push(selected.queue);
      remaining.splice(selected.index, 1);
    }
    return ordered;
  }
}
