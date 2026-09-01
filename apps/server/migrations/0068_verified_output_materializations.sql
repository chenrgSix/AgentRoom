-- A Run that carries required verifier profiles must advertise the exact local
-- verify authority as well as prepare/capture. The remainder of this trigger
-- preserves the full current-plan admission scope from migration 0065.
DROP TRIGGER execution_run_admissions_require_exact_scope_insert;
CREATE TRIGGER execution_run_admissions_require_exact_scope_insert
BEFORE INSERT ON execution_run_admissions
WHEN NEW.manifest_digest IS NOT NULL OR NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_nodes node
    ON node.plan_id = plan.plan_id AND node.revision = plan.current_revision
  JOIN execution_plan_approvals approval
    ON approval.plan_id = node.plan_id AND approval.revision = node.revision
  JOIN execution_plan_task_claims claim
    ON claim.task_id = node.task_id AND claim.plan_id = node.plan_id
      AND claim.revision = node.revision AND claim.node_key = node.node_key
  JOIN agent_tasks task ON task.task_id = node.task_id
  JOIN rooms room ON room.room_id = task.room_id AND room.archived_at IS NULL
  JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
  JOIN agents agent ON agent.agent_id = node.agent_id
    AND agent.enabled = 1 AND agent.integration_mode = 'managed'
  JOIN devices device ON device.device_id = agent.device_id
    AND device.status = 'active'
  JOIN messages message ON message.message_id = NEW.trigger_message_id
  JOIN execution_dispatch_intents intent ON intent.run_id = NEW.run_id
  JOIN room_human_participants requester
    ON requester.room_id = room.room_id
      AND requester.member_id = NEW.requester_member_id
  JOIN team_members requester_member
    ON requester_member.member_id = requester.member_id
      AND requester_member.team_id = room.team_id
  JOIN room_agent_participants participant
    ON participant.room_id = room.room_id
      AND participant.agent_id = agent.agent_id
  JOIN task_agent_assignments assignment
    ON assignment.task_id = task.task_id AND assignment.agent_id = agent.agent_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND plan.current_revision = node.revision
    AND plan.current_revision = approval.revision
    AND plan.current_revision = claim.revision
    AND plan.current_revision > 0
    AND plan.current_revision = NEW.plan_revision
    AND plan.current_revision = json_extract(approval.response_json, '$.plan.current.revision')
    AND plan.control_revision = NEW.plan_control_revision
    AND plan.state IN ('approved', 'running')
    AND node.node_key = NEW.node_key
    AND node.task_id = NEW.task_id
    AND node.agent_id = NEW.agent_id
    AND task.room_id = NEW.room_id
    AND task.definition_revision = node.definition_revision
    AND task.criteria_revision = node.criteria_revision
    AND json_extract(node.node_json, '$.kind') = 'implementation'
    AND task.lifecycle_state IN ('ready', 'active', 'review')
    AND task.scheduling_state = 'enabled'
    AND message.room_id = NEW.room_id
    AND message.task_id = NEW.task_id
    AND agent.device_id = NEW.device_id
    AND agent.team_id = room.team_id
    AND agent.owner_member_id = device.owner_member_id
    AND device.team_id = room.team_id
    AND approval.operation_id = NEW.approval_operation_id
    AND approval.decision = 'approved'
    AND approval.digest = NEW.plan_digest
    AND NEW.plan_digest = json_extract(approval.response_json, '$.plan.current.digest')
    AND intent.plan_id = NEW.plan_id
    AND intent.plan_revision = NEW.plan_revision
    AND intent.plan_digest = NEW.plan_digest
    AND intent.plan_control_revision = NEW.plan_control_revision
    AND intent.approval_operation_id = NEW.approval_operation_id
    AND intent.node_key = NEW.node_key
    AND intent.dispatch_generation = NEW.dispatch_generation
    AND intent.task_id = NEW.task_id
    AND intent.room_id = NEW.room_id
    AND intent.agent_id = NEW.agent_id
    AND intent.device_id = NEW.device_id
    AND intent.trace_message_id = NEW.trigger_message_id
    AND intent.requester_member_id = NEW.requester_member_id
    AND intent.operation_digest = NEW.request_digest
    AND intent.created_at = NEW.admitted_at
    AND (
      (
        intent.source = 'member_message' AND
        message.sender_type = 'member' AND
        message.sender_id = NEW.requester_member_id AND
        (SELECT count(*) FROM message_mentions mention
          WHERE mention.message_id = message.message_id) = 1 AND
        EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
            AND mention.target_agent_id = NEW.agent_id
        ) AND
        (
          requester_member.role = 'owner' OR
          requester_member.member_id = task.owner_member_id
        )
      ) OR (
        intent.source = 'scheduler' AND
        NEW.dispatch_generation = 1 AND
        NEW.requester_member_id = approval.reviewed_by_member_id AND
        (
          requester_member.role = 'owner' OR
          requester_member.member_id = task.owner_member_id
        ) AND
        message.sender_type = 'system' AND
        message.sender_id = 'execution-scheduler' AND
        NOT EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
        )
      )
    )
    AND NEW.deadline_at > NEW.admitted_at
    AND json_extract(NEW.grant_json, '$.planId') = NEW.plan_id
    AND json_extract(NEW.grant_json, '$.nodeKey') = NEW.node_key
    AND json_extract(NEW.grant_json, '$.agentId') = NEW.agent_id
    AND json_extract(NEW.grant_json, '$.deviceId') = NEW.device_id
    AND json_extract(NEW.grant_json, '$.repositoryId') =
      json_extract(node.node_json, '$.repository.repositoryId')
    AND json_extract(NEW.grant_json, '$.bindingId') =
      json_extract(node.node_json, '$.repository.bindingId')
    AND json_extract(NEW.grant_json, '$.grant.grantId') =
      json_extract(node.node_json, '$.repository.grantId')
    AND json_extract(NEW.grant_json, '$.grant.revision') =
      json_extract(node.node_json, '$.repository.grantRevision')
    AND json_extract(NEW.grant_json, '$.runtimeProfile.profileId') =
      json_extract(node.node_json, '$.repository.runtimeProfileId')
    AND json_extract(NEW.grant_json, '$.runtimeProfile.revision') = 1
    AND json_extract(NEW.grant_json, '$.runtimeProfile.digest') =
      json_extract(node.node_json, '$.repository.runtimeProfileDigest')
    AND json_extract(NEW.grant_json, '$.revokedAt') IS NULL
    AND julianday(json_extract(NEW.grant_json, '$.issuedAt')) <=
      julianday(NEW.admitted_at)
    AND julianday(NEW.admitted_at) <
      julianday(json_extract(NEW.grant_json, '$.grant.expiresAt'))
    AND julianday(NEW.deadline_at) <=
      julianday(json_extract(NEW.grant_json, '$.grant.expiresAt'))
    AND json_array_length(NEW.grant_json, '$.operations') = CASE
      WHEN EXISTS (
        SELECT 1 FROM json_each(node.node_json, '$.verificationProfiles')
        WHERE json_extract(value, '$.required') = 1
      ) THEN 3 ELSE 2 END
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.grant_json, '$.operations')
      WHERE value = 'prepare'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.grant_json, '$.operations')
      WHERE value = 'capture'
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM json_each(node.node_json, '$.verificationProfiles')
        WHERE json_extract(value, '$.required') = 1
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.grant_json, '$.operations')
        WHERE value = 'verify'
      )
    )
    AND json_array_length(NEW.grant_json, '$.integrationTargets') = 0
    AND json_extract(NEW.grant_json, '$.scopePolicy.access') =
      json_extract(node.node_json, '$.scope.access')
    AND json_extract(
      NEW.grant_json,
      '$.scopePolicy.requirePreventivePathEnforcement'
    ) = json_extract(
      node.node_json,
      '$.scope.requirePreventivePathEnforcement'
    )
    AND json_array_length(NEW.grant_json, '$.scopePolicy.allowedPaths') =
      json_array_length(node.node_json, '$.scope.allowedPaths')
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.grant_json, '$.scopePolicy.allowedPaths') grant_path
      WHERE grant_path.value IS NOT json_extract(
        node.node_json,
        '$.scope.allowedPaths[' || grant_path.key || ']'
      )
    )
    AND json_array_length(NEW.grant_json, '$.scopePolicy.forbiddenPaths') =
      json_array_length(node.node_json, '$.scope.forbiddenPaths')
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.grant_json, '$.scopePolicy.forbiddenPaths') grant_path
      WHERE grant_path.value IS NOT json_extract(
        node.node_json,
        '$.scope.forbiddenPaths[' || grant_path.key || ']'
      )
    )
    AND json_array_length(NEW.grant_json, '$.verificationProfiles') =
      json_array_length(node.node_json, '$.verificationProfiles')
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.grant_json, '$.verificationProfiles') grant_profile
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(node.node_json, '$.verificationProfiles') node_profile
        WHERE json_extract(node_profile.value, '$.profileId') =
            json_extract(grant_profile.value, '$.profileId')
          AND json_extract(node_profile.value, '$.revision') =
            json_extract(grant_profile.value, '$.revision')
          AND json_extract(node_profile.value, '$.digest') =
            json_extract(grant_profile.value, '$.digest')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution Run admission scope is not current');
END;


CREATE TABLE execution_verified_node_materializations (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'verified_output'),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation = 1),
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
      AND edge.gate = 'verified_output'
    JOIN execution_plan_nodes source_node ON source_node.plan_id = edge.plan_id
      AND source_node.revision = edge.revision
      AND source_node.node_key = edge.from_node_key
      AND source_node.task_id = NEW.source_task_id
    JOIN execution_verified_node_materializations materialization
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
    WHERE json_extract(NEW.binding_json, '$.gate') = 'verified_output'
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
        AND edge.gate = 'verified_output'
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
    AND edge.from_node_key = NEW.node_key AND edge.gate = 'verified_output'
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
