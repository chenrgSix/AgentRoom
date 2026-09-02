-- convenewire:migration foreign_keys=off
-- Rebuild the three retained gate-proof tables without rewriting historical
-- evidence. A retry generation may produce proof only when it is the latest
-- DispatchIntent retained for the exact current Plan Node.

DROP TRIGGER execution_input_require_scope_insert;
DROP VIEW execution_dependency_materializations;

CREATE TEMP TABLE generation_aware_accepted_materializations_copy AS
  SELECT * FROM execution_node_materializations;
CREATE TEMP TABLE generation_aware_verified_materializations_copy AS
  SELECT * FROM execution_verified_node_materializations;
CREATE TEMP TABLE generation_aware_integrated_materializations_copy AS
  SELECT * FROM execution_integrated_node_materializations;

DROP TABLE execution_integrated_node_materializations;
DROP TABLE execution_verified_node_materializations;
DROP TABLE execution_node_materializations;

CREATE TABLE execution_node_materializations (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'accepted_result'),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation > 0),
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

INSERT INTO execution_node_materializations
  SELECT * FROM generation_aware_accepted_materializations_copy;
DROP TABLE generation_aware_accepted_materializations_copy;

CREATE INDEX execution_node_materializations_source_idx
  ON execution_node_materializations(
    plan_id, plan_revision, source_run_id, source_result_id
  );

CREATE TABLE execution_verified_node_materializations (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'verified_output'),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation > 0),
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  source_result_id TEXT NOT NULL REFERENCES task_results(result_id)
    ON DELETE RESTRICT,
  source_result_version INTEGER NOT NULL CHECK (source_result_version > 0),
  gate_operation_id TEXT NOT NULL UNIQUE CHECK (
    gate_operation_id GLOB 'op_verified_materialization_*'
  ),
  checkpoint_id TEXT NOT NULL
    REFERENCES repository_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  candidate_commit TEXT NOT NULL CHECK (length(candidate_commit) IN (40, 64)),
  candidate_tree TEXT NOT NULL CHECK (
    length(candidate_tree) = length(candidate_commit)
  ),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verification_receipts_json TEXT NOT NULL CHECK (
    json_valid(verification_receipts_json) AND
    json_type(verification_receipts_json) = 'array' AND
    json_array_length(verification_receipts_json) BETWEEN 1 AND 32
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

INSERT INTO execution_verified_node_materializations
  SELECT * FROM generation_aware_verified_materializations_copy;
DROP TABLE generation_aware_verified_materializations_copy;

CREATE TABLE execution_integrated_node_materializations (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'integrated_commit'),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation > 0),
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

INSERT INTO execution_integrated_node_materializations
  SELECT * FROM generation_aware_integrated_materializations_copy;
DROP TABLE generation_aware_integrated_materializations_copy;

-- Human acceptance is admitted only for the latest completed managed attempt.
DROP TRIGGER execution_results_require_materializable_review_insert;
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
      AND NOT EXISTS (
        SELECT 1 FROM execution_dispatch_intents later
        WHERE later.plan_id = intent.plan_id
          AND later.plan_revision = intent.plan_revision
          AND later.node_key = intent.node_key
          AND later.dispatch_generation > intent.dispatch_generation
      )
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
    AND NOT EXISTS (
      SELECT 1 FROM execution_dispatch_intents later
      WHERE later.plan_id = intent.plan_id
        AND later.plan_revision = intent.plan_revision
        AND later.node_key = intent.node_key
        AND later.dispatch_generation > intent.dispatch_generation
    )
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

CREATE TRIGGER execution_verified_materializations_require_scope_insert
BEFORE INSERT ON execution_verified_node_materializations
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
    AND result.state IN ('proposed', 'accepted')
  JOIN repository_checkpoints checkpoint
    ON checkpoint.checkpoint_id = NEW.checkpoint_id
  JOIN repository_capture_operations capture
    ON capture.operation_id = checkpoint.operation_id
  JOIN isolated_workspace_leases lease
    ON lease.lease_id = capture.isolated_lease_id
    AND lease.run_id = run.run_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND plan.state IN ('approved', 'running', 'paused', 'review')
    AND NEW.gate = 'verified_output'
    AND NOT EXISTS (
      SELECT 1 FROM execution_dispatch_intents later
      WHERE later.plan_id = intent.plan_id
        AND later.plan_revision = intent.plan_revision
        AND later.node_key = intent.node_key
        AND later.dispatch_generation > intent.dispatch_generation
    )
    AND json_extract(checkpoint.checkpoint_json, '$.candidateCommit') =
      NEW.candidate_commit
    AND json_extract(checkpoint.checkpoint_json, '$.candidateTree') =
      NEW.candidate_tree
    AND json_extract(checkpoint.checkpoint_json, '$.inputDigest') =
      NEW.input_digest
    AND EXISTS (
      SELECT 1 FROM result_evidence_refs run_evidence
      JOIN run_events event ON event.run_id = run_evidence.run_id
        AND event.sequence = run_evidence.run_sequence
        AND event.event_type = 'status' AND event.status = 'completed'
      WHERE run_evidence.result_id = result.result_id
        AND run_evidence.evidence_kind = 'run_event'
        AND run_evidence.run_id = run.run_id
    )
    AND EXISTS (
      SELECT 1 FROM execution_plan_edges edge
      WHERE edge.plan_id = node.plan_id AND edge.revision = node.revision
        AND edge.from_node_key = node.node_key
        AND edge.gate IN ('verified_output', 'integrated_commit')
    )
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.verification_receipts_json) left_receipt
  JOIN json_each(NEW.verification_receipts_json) right_receipt
    ON left_receipt.key < right_receipt.key
  WHERE json_extract(left_receipt.value, '$.verificationId') =
      json_extract(right_receipt.value, '$.verificationId')
    OR json_extract(left_receipt.value, '$.operationId') =
      json_extract(right_receipt.value, '$.operationId')
    OR json_extract(left_receipt.value, '$.profileId') =
      json_extract(right_receipt.value, '$.profileId')
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.verification_receipts_json) pin
  WHERE NOT EXISTS (
    SELECT 1 FROM verification_receipts receipt
    JOIN repository_verification_operations verification
      ON verification.operation_id = receipt.operation_id
      AND verification.checkpoint_id = NEW.checkpoint_id
    JOIN execution_plan_nodes node ON node.plan_id = NEW.plan_id
      AND node.revision = NEW.plan_revision AND node.node_key = NEW.node_key
    JOIN json_each(node.node_json, '$.verificationProfiles') required_profile
      ON json_extract(required_profile.value, '$.required') = 1
      AND json_extract(required_profile.value, '$.profileId') =
        json_extract(pin.value, '$.profileId')
      AND json_extract(required_profile.value, '$.revision') =
        json_extract(pin.value, '$.profileRevision')
      AND json_extract(required_profile.value, '$.digest') =
        json_extract(pin.value, '$.profileDigest')
    WHERE receipt.verification_id =
        json_extract(pin.value, '$.verificationId')
      AND receipt.operation_id = json_extract(pin.value, '$.operationId')
      AND receipt.receipt_digest = json_extract(pin.value, '$.receiptDigest')
      AND receipt.outcome = 'passed'
      AND verification.profile_id = json_extract(pin.value, '$.profileId')
      AND verification.profile_revision =
        json_extract(pin.value, '$.profileRevision')
      AND verification.profile_digest =
        json_extract(pin.value, '$.profileDigest')
      AND json_extract(receipt.receipt_json, '$.execution.planId') = NEW.plan_id
      AND json_extract(receipt.receipt_json, '$.execution.planRevision') =
        NEW.plan_revision
      AND json_extract(receipt.receipt_json, '$.execution.nodeKey') = NEW.node_key
      AND json_extract(receipt.receipt_json, '$.execution.runId') =
        NEW.source_run_id
      AND json_extract(receipt.receipt_json, '$.candidateCommit') =
        NEW.candidate_commit
      AND json_extract(receipt.receipt_json, '$.candidateTree') =
        NEW.candidate_tree
      AND json_extract(receipt.receipt_json, '$.inputDigest') = NEW.input_digest
      AND receipt.recorded_at <= NEW.created_at
  )
) OR EXISTS (
  SELECT 1 FROM execution_plan_nodes node
  JOIN json_each(node.node_json, '$.verificationProfiles') required_profile
  WHERE node.plan_id = NEW.plan_id AND node.revision = NEW.plan_revision
    AND node.node_key = NEW.node_key
    AND json_extract(required_profile.value, '$.required') = 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.verification_receipts_json) pin
      WHERE json_extract(pin.value, '$.profileId') =
          json_extract(required_profile.value, '$.profileId')
        AND json_extract(pin.value, '$.profileRevision') =
          json_extract(required_profile.value, '$.revision')
        AND json_extract(pin.value, '$.profileDigest') =
          json_extract(required_profile.value, '$.digest')
    )
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.artifact_pins_json) left_pin
  JOIN json_each(NEW.artifact_pins_json) right_pin ON left_pin.key < right_pin.key
  WHERE json_extract(left_pin.value, '$.outputSlot') =
      json_extract(right_pin.value, '$.outputSlot')
    OR json_extract(left_pin.value, '$.artifactId') =
      json_extract(right_pin.value, '$.artifactId')
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.artifact_pins_json) pin
  WHERE NOT EXISTS (
    SELECT 1 FROM repository_checkpoint_outputs output
    JOIN result_evidence_refs evidence ON evidence.result_id = NEW.source_result_id
      AND evidence.evidence_kind = 'artifact'
      AND evidence.artifact_id = output.artifact_id
    JOIN task_artifact_refs artifact ON artifact.artifact_id = output.artifact_id
      AND artifact.artifact_revision = output.artifact_revision
      AND artifact.source_run_id = NEW.source_run_id
      AND artifact.content_mode = 'snapshot_blob'
    WHERE output.checkpoint_id = NEW.checkpoint_id
      AND output.slot_key = json_extract(pin.value, '$.outputSlot')
      AND output.artifact_id = json_extract(pin.value, '$.artifactId')
      AND output.artifact_revision =
        json_extract(pin.value, '$.artifactRevision')
      AND artifact.artifact_type = json_extract(pin.value, '$.kind')
      AND artifact.content_sha256 = json_extract(pin.value, '$.contentDigest')
      AND artifact.content_size_bytes = json_extract(pin.value, '$.byteLength')
  )
) OR EXISTS (
  SELECT 1 FROM execution_plan_edges edge
  JOIN json_each(edge.edge_json, '$.bindings') binding
  WHERE edge.plan_id = NEW.plan_id AND edge.revision = NEW.plan_revision
    AND edge.from_node_key = NEW.node_key
    AND edge.gate IN ('verified_output', 'integrated_commit')
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.artifact_pins_json) pin
      WHERE json_extract(pin.value, '$.outputSlot') =
        json_extract(binding.value, '$.outputSlot')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Verified NodeMaterialization scope is invalid');
END;

CREATE TRIGGER execution_verified_materializations_immutable_update
BEFORE UPDATE ON execution_verified_node_materializations
BEGIN SELECT RAISE(ABORT, 'Verified NodeMaterialization is immutable'); END;

CREATE TRIGGER execution_verified_materializations_immutable_delete
BEFORE DELETE ON execution_verified_node_materializations
BEGIN SELECT RAISE(ABORT, 'Verified NodeMaterialization is retained evidence'); END;

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
  JOIN execution_dispatch_intents intent
    ON intent.plan_id = verified.plan_id
    AND intent.plan_revision = verified.plan_revision
    AND intent.node_key = verified.node_key
    AND intent.dispatch_generation = verified.dispatch_generation
    AND intent.run_id = verified.source_run_id
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
    AND NOT EXISTS (
      SELECT 1 FROM execution_dispatch_intents later
      WHERE later.plan_id = intent.plan_id
        AND later.plan_revision = intent.plan_revision
        AND later.node_key = intent.node_key
        AND later.dispatch_generation > intent.dispatch_generation
    )
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
