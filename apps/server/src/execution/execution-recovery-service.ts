import type Database from "better-sqlite3";
import type { RunRecord, RunRepository } from
  "../run/run-repository.js";
import type { ExecutionSettlementService } from
  "./execution-settlement-service.js";

export class ExecutionRecoveryService {
  public constructor(
    private readonly database: Database.Database,
    private readonly settlement: ExecutionSettlementService,
    private readonly runs: RunRepository
  ) {}

  public recover(now: string): RunRecord[] {
    this.settlement.reconcile(now);
    const rows = this.database.prepare(`
      SELECT run.run_id
      FROM execution_dispatch_intents intent
      JOIN runs run ON run.run_id = intent.run_id
      LEFT JOIN run_deliveries delivery ON delivery.run_id = run.run_id
      WHERE run.state IN ('queued', 'delivered')
        AND (delivery.run_id IS NULL OR delivery.state = 'pending')
      ORDER BY intent.plan_id, intent.plan_revision,
        intent.node_key, intent.dispatch_generation
    `).all() as Array<{ run_id: string }>;
    return rows.map(({ run_id }) => this.runs.getRun(run_id)!).filter(Boolean);
  }
}
