ALTER TABLE execution_input_bindings ADD COLUMN source_evidence_id TEXT;
ALTER TABLE execution_input_bindings ADD COLUMN source_digest TEXT CHECK (
  source_digest IS NULL OR length(source_digest) = 64
);
ALTER TABLE execution_input_bindings ADD COLUMN adoption_id TEXT;
ALTER TABLE execution_input_bindings ADD COLUMN adoption_digest TEXT CHECK (
  adoption_digest IS NULL OR length(adoption_digest) = 64
);

CREATE TRIGGER execution_input_source_authority_insert
BEFORE INSERT ON execution_input_bindings
WHEN NOT (
  (NEW.source_result_id IS NOT NULL AND
    json_extract(NEW.binding_json, '$.sourceResultId') = NEW.source_result_id AND
    json_extract(NEW.binding_json, '$.sourceResultVersion') IS NOT NULL AND
    (
      (NEW.source_evidence_id IS NULL AND NEW.source_digest IS NULL AND
        NEW.adoption_id IS NULL AND NEW.adoption_digest IS NULL AND
        json_type(NEW.binding_json, '$.sourceAuthority') = 'null') OR
      (NEW.source_evidence_id IS NOT NULL AND NEW.source_digest IS NOT NULL AND
        NEW.adoption_id IS NOT NULL AND NEW.adoption_digest IS NOT NULL AND
        json_extract(NEW.binding_json, '$.sourceAuthority.sourceEvidenceId') =
          NEW.source_evidence_id AND
        json_extract(NEW.binding_json, '$.sourceAuthority.sourceDigest') =
          NEW.source_digest AND
        json_extract(NEW.binding_json, '$.sourceAuthority.adoptionId') =
          NEW.adoption_id AND
        json_extract(NEW.binding_json, '$.sourceAuthority.adoptionDigest') =
          NEW.adoption_digest)
    )) OR
  (NEW.source_result_id IS NULL AND
    json_type(NEW.binding_json, '$.sourceResultId') = 'null' AND
    json_type(NEW.binding_json, '$.sourceResultVersion') = 'null' AND
    NEW.source_evidence_id IS NOT NULL AND NEW.source_digest IS NOT NULL AND
    NEW.adoption_id IS NOT NULL AND NEW.adoption_digest IS NOT NULL AND
    json_extract(NEW.binding_json, '$.sourceAuthority.sourceEvidenceId') =
      NEW.source_evidence_id AND
    json_extract(NEW.binding_json, '$.sourceAuthority.sourceDigest') =
      NEW.source_digest AND
    json_extract(NEW.binding_json, '$.sourceAuthority.adoptionId') =
      NEW.adoption_id AND
    json_extract(NEW.binding_json, '$.sourceAuthority.adoptionDigest') =
      NEW.adoption_digest)
)
BEGIN SELECT RAISE(ABORT, 'Execution input source authority is invalid'); END;

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
    WHERE json_extract(NEW.binding_json, '$.edgeKey') IS NULL
      AND json_extract(NEW.binding_json, '$.gate') = 'accepted_result'
      AND NEW.source_evidence_id IS NULL AND NEW.adoption_id IS NULL
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
    JOIN execution_plan_nodes source_node ON source_node.plan_id = edge.plan_id
      AND source_node.revision = edge.revision
      AND source_node.node_key = edge.from_node_key
      AND source_node.task_id = NEW.source_task_id
    JOIN execution_all_adopted_node_materializations materialization
      ON materialization.plan_id = source_node.plan_id
      AND materialization.plan_revision = source_node.revision
      AND materialization.node_key = source_node.node_key
      AND materialization.gate = edge.gate
      AND materialization.source_result_id = NEW.source_result_id
      AND materialization.source_evidence_id = NEW.source_evidence_id
      AND materialization.source_digest = NEW.source_digest
      AND materialization.adoption_id = NEW.adoption_id
      AND materialization.adoption_digest = NEW.adoption_digest
      AND materialization.gate_operation_id = NEW.gate_operation_id
      AND materialization.candidate_commit IS
        json_extract(NEW.binding_json, '$.sourceCommit')
      AND materialization.candidate_tree IS
        json_extract(NEW.binding_json, '$.sourceTree')
    JOIN task_results result ON result.result_id = materialization.source_result_id
      AND result.task_id = source_node.task_id
    LEFT JOIN result_reviews review
      ON edge.gate = 'accepted_result'
      AND review.result_id = result.result_id
      AND review.operation_id = materialization.gate_operation_id
      AND review.decision = 'accepted'
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
    WHERE NEW.source_result_id IS NOT NULL
      AND json_extract(NEW.binding_json, '$.gate') = edge.gate
      AND (
        (edge.gate = 'accepted_result' AND review.operation_id IS NOT NULL) OR
        (edge.gate IN ('verified_output', 'integrated_commit') AND
          materialization.materialization_digest =
            json_extract(NEW.binding_json, '$.gateDigest'))
      )
      AND run.run_id = NEW.destination_run_id
      AND run.task_id = NEW.destination_task_id
      AND run.target_agent_id = NEW.destination_agent_id
      AND approval.plan_id = NEW.plan_id AND approval.revision = NEW.revision
      AND approval.digest = NEW.plan_digest AND approval.decision = 'approved'
      AND result.room_id = run.room_id
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
      AND edge.gate = 'verified_output'
    JOIN execution_plan_nodes source_node ON source_node.plan_id = edge.plan_id
      AND source_node.revision = edge.revision
      AND source_node.node_key = edge.from_node_key
      AND source_node.task_id = NEW.source_task_id
    JOIN execution_all_adopted_node_materializations materialization
      ON materialization.plan_id = source_node.plan_id
      AND materialization.plan_revision = source_node.revision
      AND materialization.node_key = source_node.node_key
      AND materialization.gate = edge.gate
      AND materialization.source_result_id IS NULL
      AND materialization.source_evidence_id = NEW.source_evidence_id
      AND materialization.source_digest = NEW.source_digest
      AND materialization.adoption_id = NEW.adoption_id
      AND materialization.adoption_digest = NEW.adoption_digest
      AND materialization.gate_operation_id = NEW.gate_operation_id
      AND materialization.materialization_digest = NEW.adoption_digest
      AND materialization.candidate_commit =
        json_extract(NEW.binding_json, '$.sourceCommit')
      AND materialization.candidate_tree =
        json_extract(NEW.binding_json, '$.sourceTree')
    JOIN task_artifact_refs artifact ON artifact.artifact_id = NEW.source_artifact_id
      AND artifact.task_id = source_node.task_id
      AND artifact.room_id = run.room_id
      AND artifact.content_mode = 'snapshot_blob'
      AND artifact.content_id = NEW.content_id
    JOIN remote_artifact_imports remote_import
      ON remote_import.artifact_id = artifact.artifact_id
      AND remote_import.kind = 'patch'
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
    WHERE NEW.source_result_id IS NULL
      AND json_extract(NEW.binding_json, '$.gate') = edge.gate
      AND run.run_id = NEW.destination_run_id
      AND run.task_id = NEW.destination_task_id
      AND run.target_agent_id = NEW.destination_agent_id
      AND approval.plan_id = NEW.plan_id AND approval.revision = NEW.revision
      AND approval.digest = NEW.plan_digest AND approval.decision = 'approved'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution input source or destination scope is invalid');
END;
