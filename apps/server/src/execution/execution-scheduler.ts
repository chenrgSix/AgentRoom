import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { RunRecord } from "../run/run-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionNodeStateRepository } from
  "./execution-node-state-repository.js";
import type { ExecutionNodeProjector } from "./execution-node-projector.js";
import type { ExecutionSettlementService } from
  "./execution-settlement-service.js";
import type { GovernedRunAdmissionService } from
  "./governed-run-admission-service.js";

export class ExecutionScheduler {
  private sweeping = false;

  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly nodes: ExecutionNodeStateRepository,
    private readonly projector: ExecutionNodeProjector,
    private readonly settlement: ExecutionSettlementService,
    private readonly admission: GovernedRunAdmissionService,
    private readonly clock: () => string
  ) {}

  public sweep(): RunRecord[] {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const now = this.clock();
      this.settlement.reconcile(now);
      const admitted: RunRecord[] = [];
      for (const identity of this.nodes.listCandidates()) {
        const readiness = this.admission.readiness(identity, now);
        this.transactions.immediate(() => {
          this.projector.projectReadiness(identity, readiness, now);
        });
        if (!readiness.ready) continue;
        try {
          const result = this.admission.admitScheduled(identity, now);
          admitted.push(...result.runs);
          this.settlement.reconcileOne(identity, now);
        } catch (error) {
          if (!(error instanceof ExecutionError)) throw error;
          this.transactions.immediate(() => {
            this.projector.projectReadiness(identity, {
              ready: false,
              blocker: error.code
            }, now);
          });
        }
      }
      return [...new Map(admitted.map((run) => [run.runId, run])).values()];
    } finally {
      this.sweeping = false;
    }
  }
}
