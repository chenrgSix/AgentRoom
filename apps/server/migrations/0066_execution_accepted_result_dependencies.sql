CREATE TABLE execution_node_materializations (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'accepted_result'),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation = 1),
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  source_result_id TEXT NOT NULL UNIQUE
    REFERENCES task_results(result_id) ON DELETE RESTRICT,
  source_result_version INTEGER NOT NULL CHECK (source_result_version > 0),
  gate_operation_id TEXT NOT NULL UNIQUE
    REFERENCES result_reviews(operation_id) ON DELETE RESTRICT,
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
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX execution_node_materializations_source_idx
  ON execution_node_materializations(
    plan_id, plan_revision, source_run_id, source_result_id
  );

DROP TRIGGER execution_results_require_verified_review_insert;

-- Human acceptance remains distinct from Task completion and independent
-- verification. It is admitted only for the exact generation-1 managed Run
-- whose canonical checkpoint outputs can produce retained dependency evidence.
CREATE TRIGGER execution_results_require_materializable_review_insert
BEFORE INSERT ON result_reviews
WHEN NEW.decision = 'accepted' AND EXISTS (
  SELECT 1
  FROM task_results governed_result
  JOIN execution_active_task_governance governance
    ON governance.task_id = governed_result.task_id
  WHERE governed_result.result_id = NEW.result_id
) AND (
  NEW.completed_task <> 0 OR
  EXISTS (
    SELECT 1
    FROM task_results accepted
    JOIN task_results candidate ON candidate.task_id = accepted.task_id
    WHERE candidate.result_id = NEW.result_id
      AND accepted.result_id <> candidate.result_id
      AND accepted.state = 'accepted'
  ) OR
  NOT EXISTS (
    SELECT 1
    FROM task_results result
    JOIN execution_plan_task_claims claim ON claim.task_id = result.task_id
    JOIN execution_plans plan ON plan.plan_id = claim.plan_id
      AND plan.current_revision = claim.revision
      AND plan.state IN ('approved', 'running', 'paused', 'review')
    JOIN execution_plan_nodes node ON node.plan_id = claim.plan_id
      AND node.revision = claim.revision
      AND node.node_key = claim.node_key
      AND node.task_id = result.task_id
    JOIN agent_tasks task ON task.task_id = node.task_id
    JOIN execution_dispatch_intents intent ON intent.plan_id = node.plan_id
      AND intent.plan_revision = node.revision
      AND intent.node_key = node.node_key
      AND intent.dispatch_generation = 1
    JOIN runs run ON run.run_id = intent.run_id
      AND run.state = 'completed'
      AND run.task_id = task.task_id
      AND run.room_id = task.room_id
      AND run.target_agent_id = node.agent_id
    JOIN rooms room ON room.room_id = task.room_id
      AND room.archived_at IS NULL
    JOIN teams team ON team.team_id = room.team_id
      AND team.archived_at IS NULL
    JOIN team_members reviewer ON reviewer.member_id = NEW.reviewed_by_member_id
      AND reviewer.team_id = room.team_id
    JOIN room_human_participants participant
      ON participant.room_id = room.room_id
      AND participant.member_id = reviewer.member_id
    WHERE result.result_id = NEW.result_id
      AND result.state = 'proposed'
      AND result.room_id = task.room_id
      AND result.definition_revision = node.definition_revision
      AND result.criteria_revision = node.criteria_revision
      AND task.definition_revision = node.definition_revision
      AND task.criteria_revision = node.criteria_revision
      AND result.proposed_by_kind = 'managed_agent'
      AND result.proposed_by_agent_id = node.agent_id
      AND result.proposed_by_run_id = run.run_id
      AND (reviewer.role = 'owner' OR reviewer.member_id = task.owner_member_id)
      AND EXISTS (
        SELECT 1
        FROM result_evidence_refs run_evidence
        JOIN run_events event ON event.run_id = run_evidence.run_id
          AND event.sequence = run_evidence.run_sequence
          AND event.event_type = 'status'
          AND event.status = 'completed'
        WHERE run_evidence.result_id = result.result_id
          AND run_evidence.evidence_kind = 'run_event'
          AND run_evidence.run_id = run.run_id
      )
      AND EXISTS (
        SELECT 1
        FROM result_evidence_refs evidence
        JOIN repository_checkpoint_outputs output
          ON output.artifact_id = evidence.artifact_id
        JOIN repository_checkpoints checkpoint
          ON checkpoint.checkpoint_id = output.checkpoint_id
        JOIN repository_capture_operations capture
          ON capture.operation_id = checkpoint.operation_id
        JOIN isolated_workspace_leases lease
          ON lease.lease_id = capture.isolated_lease_id
          AND lease.run_id = run.run_id
        JOIN task_artifact_refs artifact
          ON artifact.artifact_id = output.artifact_id
          AND artifact.artifact_revision = output.artifact_revision
          AND artifact.source_run_id = run.run_id
          AND artifact.task_id = task.task_id
          AND artifact.room_id = task.room_id
          AND artifact.created_by_agent_id = node.agent_id
          AND artifact.content_mode = 'snapshot_blob'
          AND artifact.content_id IS NOT NULL
          AND artifact.content_sha256 IS NOT NULL
          AND artifact.content_size_bytes IS NOT NULL
        WHERE evidence.result_id = result.result_id
          AND evidence.evidence_kind = 'artifact'
      )
      AND EXISTS (
        SELECT 1
        FROM execution_plan_edges edge
        WHERE edge.plan_id = node.plan_id
          AND edge.revision = node.revision
          AND edge.from_node_key = node.node_key
          AND edge.gate = 'accepted_result'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM execution_plan_edges edge
        JOIN json_each(edge.edge_json, '$.bindings') binding
        WHERE edge.plan_id = node.plan_id
          AND edge.revision = node.revision
          AND edge.from_node_key = node.node_key
          AND edge.gate = 'accepted_result'
          AND NOT EXISTS (
            SELECT 1
            FROM result_evidence_refs evidence
            JOIN repository_checkpoint_outputs output
              ON output.artifact_id = evidence.artifact_id
              AND output.slot_key = json_extract(
                binding.value,
                '$.outputSlot'
              )
            JOIN repository_checkpoints checkpoint
              ON checkpoint.checkpoint_id = output.checkpoint_id
            JOIN repository_capture_operations capture
              ON capture.operation_id = checkpoint.operation_id
            JOIN isolated_workspace_leases lease
              ON lease.lease_id = capture.isolated_lease_id
              AND lease.run_id = run.run_id
            WHERE evidence.result_id = result.result_id
              AND evidence.evidence_kind = 'artifact'
          )
      )
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Governed Result acceptance requires exact canonical Run output evidence'
  );
END;

CREATE TRIGGER execution_node_materializations_require_exact_scope_insert
BEFORE INSERT ON execution_node_materializations
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
    AND node.revision = plan.current_revision
    AND node.node_key = NEW.node_key
  JOIN execution_dispatch_intents intent ON intent.plan_id = node.plan_id
    AND intent.plan_revision = node.revision
    AND intent.node_key = node.node_key
    AND intent.dispatch_generation = NEW.dispatch_generation
    AND intent.run_id = NEW.source_run_id
  JOIN runs run ON run.run_id = intent.run_id AND run.state = 'completed'
  JOIN task_results result ON result.result_id = NEW.source_result_id
    AND result.task_id = node.task_id
    AND result.room_id = intent.room_id
    AND result.result_version = NEW.source_result_version
    AND result.definition_revision = node.definition_revision
    AND result.criteria_revision = node.criteria_revision
    AND result.proposed_by_kind = 'managed_agent'
    AND result.proposed_by_agent_id = node.agent_id
    AND result.proposed_by_run_id = run.run_id
    AND result.state = 'accepted'
  JOIN result_reviews review ON review.result_id = result.result_id
    AND review.operation_id = NEW.gate_operation_id
    AND review.decision = 'accepted'
    AND review.completed_task = 0
    AND review.reviewed_at = NEW.created_at
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND plan.state IN ('approved', 'running', 'paused', 'review')
    AND NEW.gate = 'accepted_result'
) OR EXISTS (
  SELECT 1
  FROM json_each(NEW.artifact_pins_json) left_pin
  JOIN json_each(NEW.artifact_pins_json) right_pin
    ON left_pin.key < right_pin.key
  WHERE json_extract(left_pin.value, '$.outputSlot') =
      json_extract(right_pin.value, '$.outputSlot')
    OR json_extract(left_pin.value, '$.artifactId') =
      json_extract(right_pin.value, '$.artifactId')
) OR EXISTS (
  SELECT 1
  FROM json_each(NEW.artifact_pins_json) pin
  WHERE NOT EXISTS (
    SELECT 1
    FROM result_evidence_refs evidence
    JOIN repository_checkpoint_outputs output
      ON output.artifact_id = evidence.artifact_id
      AND output.slot_key = json_extract(pin.value, '$.outputSlot')
      AND output.artifact_revision =
        json_extract(pin.value, '$.artifactRevision')
    JOIN repository_checkpoints checkpoint
      ON checkpoint.checkpoint_id = output.checkpoint_id
    JOIN repository_capture_operations capture
      ON capture.operation_id = checkpoint.operation_id
    JOIN isolated_workspace_leases lease
      ON lease.lease_id = capture.isolated_lease_id
      AND lease.run_id = NEW.source_run_id
    JOIN task_artifact_refs artifact
      ON artifact.artifact_id = output.artifact_id
      AND artifact.source_run_id = NEW.source_run_id
      AND artifact.artifact_type = json_extract(pin.value, '$.kind')
      AND artifact.content_sha256 =
        json_extract(pin.value, '$.contentDigest')
      AND artifact.content_size_bytes =
        json_extract(pin.value, '$.byteLength')
      AND artifact.content_mode = 'snapshot_blob'
    JOIN execution_plan_nodes node ON node.plan_id = NEW.plan_id
      AND node.revision = NEW.plan_revision
      AND node.node_key = NEW.node_key
    JOIN json_each(node.node_json, '$.outputs') expected_output
      ON json_extract(expected_output.value, '$.slotKey') = output.slot_key
      AND json_extract(expected_output.value, '$.kind') = artifact.artifact_type
    WHERE evidence.result_id = NEW.source_result_id
      AND evidence.evidence_kind = 'artifact'
      AND evidence.artifact_id = json_extract(pin.value, '$.artifactId')
  )
) OR EXISTS (
  SELECT 1
  FROM result_evidence_refs evidence
  JOIN repository_checkpoint_outputs output
    ON output.artifact_id = evidence.artifact_id
  JOIN repository_checkpoints checkpoint
    ON checkpoint.checkpoint_id = output.checkpoint_id
  JOIN repository_capture_operations capture
    ON capture.operation_id = checkpoint.operation_id
  JOIN isolated_workspace_leases lease
    ON lease.lease_id = capture.isolated_lease_id
    AND lease.run_id = NEW.source_run_id
  WHERE evidence.result_id = NEW.source_result_id
    AND evidence.evidence_kind = 'artifact'
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.artifact_pins_json) pin
      WHERE json_extract(pin.value, '$.outputSlot') = output.slot_key
        AND json_extract(pin.value, '$.artifactId') = output.artifact_id
        AND json_extract(pin.value, '$.artifactRevision') =
          output.artifact_revision
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution NodeMaterialization scope is invalid');
END;

CREATE TRIGGER execution_node_materializations_immutable_update
BEFORE UPDATE ON execution_node_materializations
BEGIN
  SELECT RAISE(ABORT, 'Execution NodeMaterialization is immutable');
END;

CREATE TRIGGER execution_node_materializations_immutable_delete
BEFORE DELETE ON execution_node_materializations
BEGIN
  SELECT RAISE(ABORT, 'Execution NodeMaterialization is retained evidence');
END;
