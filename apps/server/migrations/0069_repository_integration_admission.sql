CREATE TABLE execution_integration_approvals (
  approval_operation_id TEXT PRIMARY KEY CHECK (approval_operation_id GLOB 'op_*'),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL REFERENCES repository_checkpoints(checkpoint_id)
    ON DELETE RESTRICT,
  materialization_digest TEXT NOT NULL CHECK (
    length(materialization_digest) = 64 AND
    materialization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  repository_id TEXT NOT NULL CHECK (repository_id GLOB 'repo_*'),
  binding_id TEXT NOT NULL CHECK (binding_id GLOB 'repobind_*'),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  target_ref TEXT NOT NULL CHECK (target_ref GLOB 'refs/heads/*'),
  expected_target_commit TEXT NOT NULL CHECK (
    length(expected_target_commit) IN (40, 64) AND
    expected_target_commit NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_commit TEXT NOT NULL CHECK (
    length(candidate_commit) IN (40, 64) AND
    candidate_commit NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_tree TEXT NOT NULL CHECK (
    length(candidate_tree) IN (40, 64) AND
    candidate_tree NOT GLOB '*[^0-9a-f]*'
  ),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verification_receipts_json TEXT NOT NULL CHECK (
    json_valid(verification_receipts_json) AND
    json_type(verification_receipts_json) = 'array' AND
    json_array_length(verification_receipts_json) > 0
  ),
  approved_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  approval_digest TEXT NOT NULL UNIQUE CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9a-f]*'
  ),
  approval_json TEXT NOT NULL CHECK (json_valid(approval_json)),
  approved_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  UNIQUE (plan_id, plan_revision, node_key, target_ref),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT,
  CHECK (json_extract(approval_json, '$.operationId') IS approval_operation_id),
  CHECK (json_extract(approval_json, '$.planId') IS plan_id),
  CHECK (json_extract(approval_json, '$.planRevision') IS plan_revision),
  CHECK (json_extract(approval_json, '$.nodeKey') IS node_key),
  CHECK (json_extract(approval_json, '$.materializationDigest') IS materialization_digest),
  CHECK (json_extract(approval_json, '$.target.repositoryId') IS repository_id),
  CHECK (json_extract(approval_json, '$.target.targetRef') IS target_ref),
  CHECK (json_extract(approval_json, '$.target.expectedCommit') IS expected_target_commit),
  CHECK (json_extract(approval_json, '$.candidateCommit') IS candidate_commit),
  CHECK (json_extract(approval_json, '$.candidateTree') IS candidate_tree),
  CHECK (json_extract(approval_json, '$.inputDigest') IS input_digest),
  CHECK (json_extract(approval_json, '$.deadline') IS deadline)
) STRICT;

CREATE TABLE repository_integration_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  approval_operation_id TEXT NOT NULL UNIQUE
    REFERENCES execution_integration_approvals(approval_operation_id)
    ON DELETE RESTRICT,
  request_digest TEXT NOT NULL UNIQUE CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  repository_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  expected_target_commit TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  candidate_tree TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL CHECK (binding_id GLOB 'repobind_*'),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  admitted_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  CHECK (json_extract(request_json, '$.operationId') IS operation_id),
  CHECK (json_extract(request_json, '$.requestDigest') IS request_digest),
  CHECK (json_extract(request_json, '$.action.kind') = 'integrate'),
  CHECK (json_extract(request_json, '$.action.integrate.integrationApprovalOperationId')
    IS approval_operation_id),
  CHECK (json_extract(request_json, '$.repositoryId') IS repository_id),
  CHECK (json_extract(request_json, '$.action.integrate.target.targetRef') IS target_ref),
  CHECK (json_extract(request_json, '$.action.integrate.target.expectedCommit')
    IS expected_target_commit),
  CHECK (json_extract(request_json, '$.action.integrate.candidateCommit') IS candidate_commit),
  CHECK (json_extract(request_json, '$.action.integrate.candidateTree') IS candidate_tree),
  CHECK (json_extract(request_json, '$.execution.runId') IS source_run_id),
  CHECK (json_extract(request_json, '$.bindingId') IS binding_id),
  CHECK (json_extract(request_json, '$.deviceId') IS device_id),
  CHECK (json_extract(request_json, '$.deadline') IS deadline)
) STRICT;

CREATE TABLE repository_integration_locks (
  repository_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE
    REFERENCES repository_integration_operations(operation_id) ON DELETE RESTRICT,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, target_ref)
) STRICT;

CREATE TABLE integration_receipts (
  operation_id TEXT PRIMARY KEY
    REFERENCES repository_integration_operations(operation_id) ON DELETE RESTRICT,
  receipt_digest TEXT NOT NULL UNIQUE CHECK (
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  state TEXT NOT NULL CHECK (
    state IN ('succeeded', 'failed', 'canceled', 'outcome_unknown')
  ),
  error_code TEXT,
  recorded_at TEXT NOT NULL,
  CHECK (json_extract(receipt_json, '$.operationId') IS operation_id),
  CHECK (json_extract(receipt_json, '$.kind') = 'integrate'),
  CHECK (json_extract(receipt_json, '$.state') IS state),
  CHECK (json_extract(receipt_json, '$.errorCode') IS error_code)
) STRICT;

CREATE TRIGGER execution_integration_approvals_operation_unique_insert
BEFORE INSERT ON execution_integration_approvals
WHEN EXISTS (SELECT 1 FROM execution_plan_operations WHERE operation_id = NEW.approval_operation_id)
  OR EXISTS (SELECT 1 FROM execution_plan_approvals WHERE operation_id = NEW.approval_operation_id)
  OR EXISTS (SELECT 1 FROM repository_capture_operations WHERE operation_id = NEW.approval_operation_id)
  OR EXISTS (SELECT 1 FROM repository_verification_operations WHERE operation_id = NEW.approval_operation_id)
  OR EXISTS (SELECT 1 FROM repository_integration_operations WHERE operation_id = NEW.approval_operation_id)
BEGIN SELECT RAISE(ABORT, 'Integration approval operation identity is already bound'); END;

CREATE TRIGGER repository_integration_operations_operation_unique_insert
BEFORE INSERT ON repository_integration_operations
WHEN EXISTS (SELECT 1 FROM execution_plan_operations WHERE operation_id = NEW.operation_id)
  OR EXISTS (SELECT 1 FROM execution_plan_approvals WHERE operation_id = NEW.operation_id)
  OR EXISTS (SELECT 1 FROM repository_capture_operations WHERE operation_id = NEW.operation_id)
  OR EXISTS (SELECT 1 FROM repository_verification_operations WHERE operation_id = NEW.operation_id)
  OR EXISTS (SELECT 1 FROM execution_integration_approvals WHERE approval_operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'Integration operation identity is already bound'); END;

CREATE TRIGGER repository_integration_locks_exact_scope_insert
BEFORE INSERT ON repository_integration_locks
WHEN NOT EXISTS (
  SELECT 1 FROM repository_integration_operations operation
  WHERE operation.operation_id = NEW.operation_id
    AND operation.repository_id = NEW.repository_id
    AND operation.target_ref = NEW.target_ref
)
BEGIN SELECT RAISE(ABORT, 'Integration lock scope is invalid'); END;

CREATE TRIGGER repository_integration_locks_receipt_release_delete
BEFORE DELETE ON repository_integration_locks
WHEN NOT EXISTS (
  SELECT 1 FROM integration_receipts receipt
  WHERE receipt.operation_id = OLD.operation_id
)
BEGIN SELECT RAISE(ABORT, 'Integration lock requires a retained receipt'); END;

CREATE TRIGGER execution_integration_approvals_immutable_update
BEFORE UPDATE ON execution_integration_approvals
BEGIN SELECT RAISE(ABORT, 'Integration approvals are immutable'); END;
CREATE TRIGGER execution_integration_approvals_immutable_delete
BEFORE DELETE ON execution_integration_approvals
BEGIN SELECT RAISE(ABORT, 'Integration approvals are retained evidence'); END;
CREATE TRIGGER repository_integration_operations_immutable_update
BEFORE UPDATE ON repository_integration_operations
BEGIN SELECT RAISE(ABORT, 'Repository integration operations are immutable'); END;
CREATE TRIGGER repository_integration_operations_immutable_delete
BEFORE DELETE ON repository_integration_operations
BEGIN SELECT RAISE(ABORT, 'Repository integration operations are retained'); END;
CREATE TRIGGER repository_integration_locks_immutable_update
BEFORE UPDATE ON repository_integration_locks
BEGIN SELECT RAISE(ABORT, 'Repository integration locks cannot be retargeted'); END;
CREATE TRIGGER integration_receipts_immutable_update
BEFORE UPDATE ON integration_receipts
BEGIN SELECT RAISE(ABORT, 'Integration receipts are immutable'); END;
CREATE TRIGGER integration_receipts_immutable_delete
BEFORE DELETE ON integration_receipts
BEGIN SELECT RAISE(ABORT, 'Integration receipts are retained evidence'); END;

-- Integration admission consumes the same complete verified proof even when no
-- downstream edge stops at verified_output. Preserve every 0068 invariant while
-- allowing an integrated_commit edge to require the intermediate proof.
DROP TRIGGER execution_verified_materializations_require_scope_insert;
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
