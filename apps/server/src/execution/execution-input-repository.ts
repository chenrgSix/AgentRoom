import type Database from "better-sqlite3";
import type { ExecutionInputBinding } from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand, canonicalExecutionJSON, executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { ExecutionError } from "./execution-error.js";

export interface StoredExecutionInput {
  binding: ExecutionInputBinding;
  nodeKey: string;
  contentId: string | null;
  planDigest: string;
  approvalOperationId: string;
  controlRevision: number;
  requestDigest: string;
}

interface Row {
  binding_json: string; binding_digest: string; node_key: string; content_id: string | null;
  plan_digest: string; approval_operation_id: string; control_revision: number; request_digest: string;
}

export class ExecutionInputRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(bindingId: string): StoredExecutionInput | undefined {
    const row = this.database.prepare("SELECT * FROM execution_input_bindings WHERE binding_id = ?")
      .get(bindingId) as Row | undefined;
    if (!row) return undefined;
    const binding = JSON.parse(row.binding_json) as ExecutionInputBinding;
    assertExecutionCommand("executionInputBinding", binding);
    if (executionOperationDigest(binding) !== row.binding_digest) throw new ExecutionError("EXECUTION_INPUT_CORRUPT");
    return { binding, nodeKey: row.node_key, contentId: row.content_id, planDigest: row.plan_digest,
      approvalOperationId: row.approval_operation_id, controlRevision: row.control_revision, requestDigest: row.request_digest };
  }

  public insert(input: StoredExecutionInput): ExecutionInputBinding {
    if (!this.database.inTransaction) throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    const { binding } = input;
    assertExecutionCommand("executionInputBinding", binding);
    const previous = this.get(binding.bindingId);
    if (previous) {
      if (previous.requestDigest !== input.requestDigest) throw new ExecutionError("EXECUTION_INPUT_CONFLICT", 409);
      return previous.binding;
    }
    this.database.prepare(`INSERT INTO execution_input_bindings (
      binding_id, plan_id, revision, node_key, destination_task_id, destination_run_id,
      destination_agent_id, destination_device_id, input_slot, source_task_id, source_result_id,
      source_artifact_id, gate_operation_id, content_id, plan_digest, approval_operation_id,
      control_revision, request_digest, binding_digest, binding_json, issued_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(binding.bindingId, binding.planId, binding.planRevision, input.nodeKey, binding.destinationTaskId,
        binding.destinationRunId, binding.destinationAgentId, binding.destinationDeviceId, binding.inputSlot,
        binding.sourceTaskId, binding.sourceResultId, binding.artifact.artifactId, binding.gateOperationId,
        input.contentId, input.planDigest, input.approvalOperationId, input.controlRevision,
        input.requestDigest, executionOperationDigest(binding), canonicalExecutionJSON(binding),
        binding.issuedAt, binding.expiresAt);
    return this.get(binding.bindingId)!.binding;
  }

  public recordArtifactInputs(artifactId: string, bindings: ExecutionInputBinding[], now: string): void {
    if (!this.database.inTransaction) throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    for (const binding of bindings) {
      this.database.prepare(`INSERT INTO execution_artifact_input_sources (artifact_id, binding_id, recorded_at)
        VALUES (?, ?, ?)`).run(artifactId, binding.bindingId, now);
    }
  }

  public artifactInputs(artifactId: string): ExecutionInputBinding[] {
    const rows = this.database.prepare(`SELECT binding_id FROM execution_artifact_input_sources
      WHERE artifact_id = ? ORDER BY binding_id LIMIT 33`).all(artifactId) as Array<{ binding_id: string }>;
    if (rows.length > 32) throw new ExecutionError("EXECUTION_INPUT_CORRUPT");
    return rows.map((row) => this.get(row.binding_id)!.binding);
  }
}
