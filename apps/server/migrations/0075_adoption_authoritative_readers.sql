CREATE VIEW execution_adopted_node_materializations AS
SELECT materialization.plan_id, materialization.plan_revision,
  materialization.node_key, materialization.gate,
  materialization.dispatch_generation, materialization.source_run_id,
  materialization.source_result_id, materialization.source_result_version,
  materialization.gate_operation_id, materialization.materialization_digest,
  NULL AS candidate_commit, NULL AS candidate_tree, NULL AS checkpoint_id,
  materialization.artifact_pins_json,
  adoption.adoption_id, adoption.adoption_digest,
  adoption.source_evidence_id, adoption.source_digest
FROM execution_node_materializations materialization
JOIN execution_evidence_adoptions adoption
  ON adoption.plan_id = materialization.plan_id
  AND adoption.plan_revision = materialization.plan_revision
  AND adoption.node_key = materialization.node_key
  AND adoption.gate = materialization.gate
  AND adoption.legacy_materialization_digest =
    materialization.materialization_digest
JOIN execution_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
  AND source.kind = 'task_result'
  AND source.source_run_id = materialization.source_run_id
  AND source.source_result_id = materialization.source_result_id
UNION ALL
SELECT materialization.plan_id, materialization.plan_revision,
  materialization.node_key, materialization.gate,
  materialization.dispatch_generation, materialization.source_run_id,
  materialization.source_result_id, materialization.source_result_version,
  materialization.gate_operation_id, materialization.materialization_digest,
  materialization.candidate_commit, materialization.candidate_tree,
  materialization.checkpoint_id, materialization.artifact_pins_json,
  adoption.adoption_id, adoption.adoption_digest,
  adoption.source_evidence_id, adoption.source_digest
FROM execution_verified_node_materializations materialization
JOIN execution_evidence_adoptions adoption
  ON adoption.plan_id = materialization.plan_id
  AND adoption.plan_revision = materialization.plan_revision
  AND adoption.node_key = materialization.node_key
  AND adoption.gate = materialization.gate
  AND adoption.legacy_materialization_digest =
    materialization.materialization_digest
JOIN execution_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
  AND source.kind = 'repository_commit'
  AND source.source_run_id = materialization.source_run_id
  AND source.checkpoint_id = materialization.checkpoint_id
  AND source.candidate_commit = materialization.candidate_commit
  AND source.candidate_tree = materialization.candidate_tree
JOIN execution_source_evidence companion
  ON companion.source_evidence_id = source.companion_source_evidence_id
  AND companion.kind = 'task_result'
  AND companion.source_run_id = materialization.source_run_id
  AND companion.source_result_id = materialization.source_result_id
UNION ALL
SELECT materialization.plan_id, materialization.plan_revision,
  materialization.node_key, materialization.gate,
  materialization.dispatch_generation, materialization.source_run_id,
  materialization.source_result_id, materialization.source_result_version,
  materialization.gate_operation_id, materialization.materialization_digest,
  materialization.candidate_commit, materialization.candidate_tree,
  materialization.checkpoint_id, materialization.artifact_pins_json,
  adoption.adoption_id, adoption.adoption_digest,
  adoption.source_evidence_id, adoption.source_digest
FROM execution_integrated_node_materializations materialization
JOIN execution_evidence_adoptions adoption
  ON adoption.plan_id = materialization.plan_id
  AND adoption.plan_revision = materialization.plan_revision
  AND adoption.node_key = materialization.node_key
  AND adoption.gate = materialization.gate
  AND adoption.legacy_materialization_digest =
    materialization.materialization_digest
JOIN execution_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
  AND source.kind = 'repository_commit'
  AND source.source_run_id = materialization.source_run_id
  AND source.repository_id = materialization.repository_id
  AND source.checkpoint_id = materialization.checkpoint_id
  AND source.candidate_commit = materialization.candidate_commit
  AND source.candidate_tree = materialization.candidate_tree
JOIN execution_source_evidence companion
  ON companion.source_evidence_id = source.companion_source_evidence_id
  AND companion.kind = 'task_result'
  AND companion.source_run_id = materialization.source_run_id
  AND companion.source_result_id = materialization.source_result_id;

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
    JOIN execution_adopted_node_materializations materialization
      ON materialization.plan_id = source_node.plan_id
      AND materialization.plan_revision = source_node.revision
      AND materialization.node_key = source_node.node_key
      AND materialization.gate = edge.gate
      AND materialization.source_result_id = NEW.source_result_id
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
    WHERE json_extract(NEW.binding_json, '$.gate') = edge.gate
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
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution input source or destination scope is invalid');
END;
