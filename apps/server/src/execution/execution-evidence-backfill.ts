import type Database from "better-sqlite3";

import { ExecutionEvidenceAdoptionRepository } from
  "./execution-evidence-adoption-repository.js";
import { ExecutionNodeMaterializationRepository } from
  "./execution-node-materialization-repository.js";

/** Idempotent data migration paired with additive schema migration 0074. */
export function backfillLegacyEvidenceAdoptions(
  database: Database.Database
): number {
  const evidence = new ExecutionEvidenceAdoptionRepository(database);
  if (!evidence.available()) return 0;
  const materializations = new ExecutionNodeMaterializationRepository(database);
  const backfill = (): number => evidence.reconcileLegacy(
    (identity, gate) => materializations.getLegacy(identity, gate)
  );
  if (database.inTransaction) return backfill();
  return database.transaction(backfill).immediate();
}
