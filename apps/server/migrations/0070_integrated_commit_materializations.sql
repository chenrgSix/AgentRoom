CREATE TABLE execution_integrated_node_materializations (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'integrated_commit'),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation = 1),
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  source_result_id TEXT NOT NULL REFERENCES task_results(result_id)
    ON DELETE RESTRICT,
  source_result_version INTEGER NOT NULL CHECK (source_result_version > 0),
  gate_operation_id TEXT NOT NULL UNIQUE
    REFERENCES repository_integration_operations(operation_id)
    ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL
    REFERENCES repository_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL CHECK (repository_id GLOB 'repo_*'),
  binding_id TEXT NOT NULL CHECK (binding_id GLOB 'repobind_*'),
  candidate_commit TEXT NOT NULL CHECK (
    length(candidate_commit) IN (40, 64) AND
    candidate_commit NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_tree TEXT NOT NULL CHECK (
    length(candidate_tree) = length(candidate_commit) AND
    candidate_tree NOT GLOB '*[^0-9a-f]*'
  ),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  target_json TEXT NOT NULL CHECK (
    json_valid(target_json) AND json_type(target_json) = 'object'
  ),
  verified_materialization_digest TEXT NOT NULL CHECK (
    length(verified_materialization_digest) = 64 AND
    verified_materialization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verification_receipts_json TEXT NOT NULL CHECK (
    json_valid(verification_receipts_json) AND
    json_type(verification_receipts_json) = 'array' AND
    json_array_length(verification_receipts_json) BETWEEN 1 AND 32
  ),
  integration_approval_digest TEXT NOT NULL CHECK (
    length(integration_approval_digest) = 64 AND
    integration_approval_digest NOT GLOB '*[^0-9a-f]*'
  ),
  integration_receipt_digest TEXT NOT NULL UNIQUE CHECK (
    length(integration_receipt_digest) = 64 AND
    integration_receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_pins_json TEXT NOT NULL CHECK (
    json_valid(artifact_pins_json) AND
    json_type(artifact_pins_json) = 'array' AND
    json_array_length(artifact_pins_json) BETWEEN 1 AND 32
  ),
  materialization_digest TEXT NOT NULL UNIQUE CHECK (
    length(materialization_digest) = 64 AND
    materialization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, plan_revision, node_key, gate),
  UNIQUE (plan_id, plan_revision, source_result_id, checkpoint_id),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER execution_integrated_materializations_require_scope_insert
BEFORE INSERT ON execution_integrated_node_materializations
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_verified_node_materializations verified
  JOIN execution_integration_approvals approval
    ON approval.plan_id = verified.plan_id
    AND approval.plan_revision = verified.plan_revision
    AND approval.node_key = verified.node_key
    AND approval.source_run_id = verified.source_run_id
    AND approval.checkpoint_id = verified.checkpoint_id
    AND approval.materialization_digest = verified.materialization_digest
    AND approval.repository_id = NEW.repository_id
    AND approval.binding_id = NEW.binding_id
    AND approval.candidate_commit = verified.candidate_commit
    AND approval.candidate_tree = verified.candidate_tree
    AND approval.input_digest = verified.input_digest
    AND approval.approval_digest = NEW.integration_approval_digest
  JOIN repository_integration_operations operation
    ON operation.approval_operation_id = approval.approval_operation_id
    AND operation.operation_id = NEW.gate_operation_id
    AND operation.repository_id = NEW.repository_id
    AND operation.binding_id = NEW.binding_id
    AND operation.source_run_id = NEW.source_run_id
    AND operation.candidate_commit = NEW.candidate_commit
    AND operation.candidate_tree = NEW.candidate_tree
  JOIN integration_receipts receipt
    ON receipt.operation_id = operation.operation_id
    AND receipt.receipt_digest = NEW.integration_receipt_digest
    AND receipt.state = 'succeeded' AND receipt.error_code IS NULL
    AND receipt.recorded_at = NEW.created_at
  WHERE verified.plan_id = NEW.plan_id
    AND verified.plan_revision = NEW.plan_revision
    AND verified.node_key = NEW.node_key
    AND verified.gate = 'verified_output'
    AND NEW.gate = 'integrated_commit'
    AND verified.dispatch_generation = NEW.dispatch_generation
    AND verified.source_run_id = NEW.source_run_id
    AND verified.source_result_id = NEW.source_result_id
    AND verified.source_result_version = NEW.source_result_version
    AND verified.checkpoint_id = NEW.checkpoint_id
    AND verified.candidate_commit = NEW.candidate_commit
    AND verified.candidate_tree = NEW.candidate_tree
    AND verified.input_digest = NEW.input_digest
    AND verified.materialization_digest = NEW.verified_materialization_digest
    AND verified.verification_receipts_json = NEW.verification_receipts_json
    AND verified.artifact_pins_json = NEW.artifact_pins_json
    AND json_extract(approval.approval_json, '$.target') = json(NEW.target_json)
    AND json_extract(operation.request_json, '$.action.integrate.target') =
      json(NEW.target_json)
    AND json_extract(receipt.receipt_json, '$.checkpointId') = NEW.checkpoint_id
    AND json_extract(receipt.receipt_json, '$.candidateCommit') =
      NEW.candidate_commit
    AND json_extract(receipt.receipt_json, '$.candidateTree') =
      NEW.candidate_tree
    AND json_extract(receipt.receipt_json, '$.target') = json(NEW.target_json)
    AND EXISTS (
      SELECT 1 FROM execution_plan_edges edge
      WHERE edge.plan_id = NEW.plan_id AND edge.revision = NEW.plan_revision
        AND edge.from_node_key = NEW.node_key
        AND edge.gate = 'integrated_commit'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Integrated NodeMaterialization scope is invalid');
END;

CREATE TRIGGER execution_integrated_materializations_immutable_update
BEFORE UPDATE ON execution_integrated_node_materializations
BEGIN SELECT RAISE(ABORT, 'Integrated NodeMaterialization is immutable'); END;

CREATE TRIGGER execution_integrated_materializations_immutable_delete
BEFORE DELETE ON execution_integrated_node_materializations
BEGIN SELECT RAISE(ABORT, 'Integrated NodeMaterialization is retained evidence'); END;

CREATE VIEW execution_dependency_materializations AS
SELECT plan_id, plan_revision, node_key, gate, source_result_id,
  source_result_version,
  gate_operation_id, materialization_digest, candidate_commit,
  candidate_tree, checkpoint_id, artifact_pins_json
FROM execution_verified_node_materializations
UNION ALL
SELECT plan_id, plan_revision, node_key, gate, source_result_id,
  source_result_version,
  gate_operation_id, materialization_digest, candidate_commit,
  candidate_tree, checkpoint_id, artifact_pins_json
FROM execution_integrated_node_materializations;

DROP TRIGGER execution_input_require_scope_insert;
CREATE TRIGGER execution_input_require_scope_insert
BEFORE INSERT ON execution_input_bindings
WHEN NOT (
  EXISTS (
    SELECT 1 FROM runs run
    JOIN execution_plan_approvals approval
      ON approval.operation_id = NEW.approval_operation_id
    JOIN task_results result ON result.result_id = NEW.source_result_id
    JOIN result_reviews review ON review.result_id = result.result_id
    JOIN result_evidence_refs evidence ON evidence.result_id = result.result_id
      AND evidence.evidence_kind = 'artifact'
      AND evidence.artifact_id = NEW.source_artifact_id
    JOIN task_artifact_refs artifact ON artifact.artifact_id = evidence.artifact_id
    WHERE json_extract(NEW.binding_json, '$.gate') = 'accepted_result'
      AND run.run_id = NEW.destination_run_id
      AND run.task_id = NEW.destination_task_id
      AND run.target_agent_id = NEW.destination_agent_id
      AND approval.plan_id = NEW.plan_id AND approval.revision = NEW.revision
      AND approval.digest = NEW.plan_digest AND approval.decision = 'approved'
      AND result.task_id = NEW.source_task_id AND result.room_id = run.room_id
      AND result.state = 'accepted' AND review.decision = 'accepted'
      AND review.operation_id = NEW.gate_operation_id
      AND artifact.task_id = result.task_id AND artifact.room_id = run.room_id
      AND artifact.content_mode = 'snapshot_blob'
      AND artifact.content_id = NEW.content_id
  ) OR EXISTS (
    SELECT 1 FROM runs run
    JOIN execution_plan_approvals approval
      ON approval.operation_id = NEW.approval_operation_id
    JOIN execution_plan_edges edge ON edge.plan_id = NEW.plan_id
      AND edge.revision = NEW.revision
      AND edge.edge_key = json_extract(NEW.binding_json, '$.edgeKey')
      AND edge.to_node_key = NEW.node_key
      AND edge.gate IN ('verified_output', 'integrated_commit')
    JOIN execution_plan_nodes source_node ON source_node.plan_id = edge.plan_id
      AND source_node.revision = edge.revision
      AND source_node.node_key = edge.from_node_key
      AND source_node.task_id = NEW.source_task_id
    JOIN execution_dependency_materializations materialization
      ON materialization.plan_id = source_node.plan_id
      AND materialization.plan_revision = source_node.revision
      AND materialization.node_key = source_node.node_key
      AND materialization.gate = edge.gate
      AND materialization.source_result_id = NEW.source_result_id
      AND materialization.gate_operation_id = NEW.gate_operation_id
      AND materialization.materialization_digest =
        json_extract(NEW.binding_json, '$.gateDigest')
      AND materialization.candidate_commit =
        json_extract(NEW.binding_json, '$.sourceCommit')
      AND materialization.candidate_tree =
        json_extract(NEW.binding_json, '$.sourceTree')
    JOIN task_results result ON result.result_id = materialization.source_result_id
      AND result.task_id = source_node.task_id
    JOIN result_evidence_refs evidence ON evidence.result_id = result.result_id
      AND evidence.evidence_kind = 'artifact'
      AND evidence.artifact_id = NEW.source_artifact_id
    JOIN task_artifact_refs artifact ON artifact.artifact_id = evidence.artifact_id
    JOIN json_each(materialization.artifact_pins_json) pin
      ON json_extract(pin.value, '$.artifactId') = artifact.artifact_id
      AND json_extract(pin.value, '$.outputSlot') =
        json_extract(NEW.binding_json, '$.sourceOutputSlot')
      AND json_extract(pin.value, '$.artifactRevision') =
        json_extract(NEW.binding_json, '$.artifact.artifactRevision')
      AND json_extract(pin.value, '$.kind') =
        json_extract(NEW.binding_json, '$.artifact.kind')
      AND json_extract(pin.value, '$.contentDigest') =
        json_extract(NEW.binding_json, '$.artifact.contentDigest')
      AND json_extract(pin.value, '$.byteLength') =
        json_extract(NEW.binding_json, '$.artifact.byteLength')
    JOIN json_each(edge.edge_json, '$.bindings') edge_binding
      ON json_extract(edge_binding.value, '$.inputSlot') = NEW.input_slot
      AND json_extract(edge_binding.value, '$.outputSlot') =
        json_extract(pin.value, '$.outputSlot')
    WHERE json_extract(NEW.binding_json, '$.gate') = edge.gate
      AND run.run_id = NEW.destination_run_id
      AND run.task_id = NEW.destination_task_id
      AND run.target_agent_id = NEW.destination_agent_id
      AND approval.plan_id = NEW.plan_id AND approval.revision = NEW.revision
      AND approval.digest = NEW.plan_digest AND approval.decision = 'approved'
      AND result.room_id = run.room_id
      AND artifact.task_id = result.task_id AND artifact.room_id = run.room_id
      AND artifact.content_mode = 'snapshot_blob'
      AND artifact.content_id = NEW.content_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution input source or destination scope is invalid');
END;
