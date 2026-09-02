CREATE TABLE execution_source_evidence (
  source_evidence_id TEXT PRIMARY KEY CHECK (source_evidence_id GLOB 'source_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind IN ('task_result', 'repository_commit')),
  source_digest TEXT NOT NULL UNIQUE CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_json TEXT NOT NULL CHECK (
    json_valid(source_json) AND json_type(source_json) = 'object'
  ),
  source_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  source_result_id TEXT REFERENCES task_results(result_id) ON DELETE RESTRICT,
  repository_id TEXT,
  checkpoint_id TEXT REFERENCES repository_checkpoints(checkpoint_id)
    ON DELETE RESTRICT,
  candidate_commit TEXT,
  candidate_tree TEXT,
  companion_source_evidence_id TEXT REFERENCES execution_source_evidence(
    source_evidence_id
  ) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (json_extract(source_json, '$.version') = schema_version),
  CHECK (json_extract(source_json, '$.sourceEvidenceId') = source_evidence_id),
  CHECK (json_extract(source_json, '$.kind') = kind),
  CHECK (json_extract(source_json, '$.sourceDigest') = source_digest),
  CHECK (json_extract(source_json, '$.createdAt') = created_at),
  CHECK (
    (kind = 'task_result' AND source_run_id IS NOT NULL AND
      source_result_id IS NOT NULL AND repository_id IS NULL AND
      checkpoint_id IS NULL AND candidate_commit IS NULL AND
      candidate_tree IS NULL AND companion_source_evidence_id IS NULL AND
      json_extract(source_json, '$.sourceRunId') = source_run_id AND
      json_extract(source_json, '$.resultId') = source_result_id) OR
    (kind = 'repository_commit' AND source_run_id IS NOT NULL AND
      source_result_id IS NULL AND repository_id IS NOT NULL AND
      checkpoint_id IS NOT NULL AND candidate_commit IS NOT NULL AND
      candidate_tree IS NOT NULL AND companion_source_evidence_id IS NOT NULL AND
      json_extract(source_json, '$.repositoryId') = repository_id AND
      json_extract(source_json, '$.commit') = candidate_commit AND
      json_extract(source_json, '$.tree') = candidate_tree AND
      json_extract(source_json, '$.origin.kind') = 'local_checkpoint' AND
      json_extract(source_json, '$.origin.checkpointId') = checkpoint_id AND
      json_extract(source_json, '$.origin.sourceRunId') = source_run_id AND
      json_extract(source_json, '$.origin.companionSourceEvidenceId') =
        companion_source_evidence_id)
  )
) STRICT;

CREATE UNIQUE INDEX execution_source_evidence_result_idx
  ON execution_source_evidence(source_result_id)
  WHERE source_result_id IS NOT NULL;

CREATE UNIQUE INDEX execution_source_evidence_local_commit_idx
  ON execution_source_evidence(repository_id, candidate_commit, checkpoint_id)
  WHERE kind = 'repository_commit';

CREATE TRIGGER execution_source_evidence_require_scope_insert
BEFORE INSERT ON execution_source_evidence
WHEN (
  NEW.kind = 'task_result' AND NOT EXISTS (
    SELECT 1
    FROM task_results result
    JOIN execution_dispatch_intents intent
      ON intent.run_id = result.proposed_by_run_id
    JOIN execution_plan_nodes node
      ON node.plan_id = intent.plan_id
      AND node.revision = intent.plan_revision
      AND node.node_key = intent.node_key
      AND node.task_id = result.task_id
      AND node.agent_id = result.proposed_by_agent_id
    WHERE result.result_id = NEW.source_result_id
      AND result.proposed_by_kind = 'managed_agent'
      AND intent.run_id = NEW.source_run_id
      AND json_extract(NEW.source_json, '$.roomId') = result.room_id
      AND json_extract(NEW.source_json, '$.taskId') = result.task_id
      AND json_extract(NEW.source_json, '$.definitionRevision') =
        result.definition_revision
      AND json_extract(NEW.source_json, '$.criteriaRevision') =
        result.criteria_revision
      AND json_extract(NEW.source_json, '$.dispatchGeneration') =
        intent.dispatch_generation
      AND json_extract(NEW.source_json, '$.agentId') = intent.agent_id
      AND json_extract(NEW.source_json, '$.deviceId') = intent.device_id
      AND json_extract(NEW.source_json, '$.resultVersion') =
        result.result_version
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.source_json, '$.artifactPins') pin
        WHERE NOT EXISTS (
          SELECT 1
          FROM result_evidence_refs evidence
          JOIN repository_checkpoint_outputs output
            ON output.artifact_id = evidence.artifact_id
          JOIN task_artifact_refs artifact
            ON artifact.artifact_id = output.artifact_id
            AND artifact.artifact_revision = output.artifact_revision
          WHERE evidence.result_id = result.result_id
            AND evidence.evidence_kind = 'artifact'
            AND output.slot_key = json_extract(pin.value, '$.outputSlot')
            AND artifact.artifact_id = json_extract(pin.value, '$.artifactId')
            AND artifact.artifact_revision =
              json_extract(pin.value, '$.artifactRevision')
            AND artifact.artifact_type = json_extract(pin.value, '$.kind')
            AND artifact.content_sha256 =
              json_extract(pin.value, '$.contentDigest')
            AND artifact.content_size_bytes =
              json_extract(pin.value, '$.byteLength')
            AND artifact.content_mode = 'snapshot_blob'
        )
      )
  )
) OR (
  NEW.kind = 'repository_commit' AND NOT EXISTS (
    SELECT 1
    FROM repository_checkpoints checkpoint
    JOIN repository_capture_operations capture
      ON capture.operation_id = checkpoint.operation_id
    JOIN execution_dispatch_intents intent
      ON intent.run_id = NEW.source_run_id
    JOIN execution_source_evidence companion
      ON companion.source_evidence_id = NEW.companion_source_evidence_id
      AND companion.kind = 'task_result'
      AND companion.source_run_id = intent.run_id
    WHERE checkpoint.checkpoint_id = NEW.checkpoint_id
      AND checkpoint.digest =
        json_extract(NEW.source_json, '$.origin.checkpointDigest')
      AND capture.operation_id =
        json_extract(NEW.source_json, '$.origin.captureOperationId')
      AND intent.dispatch_generation =
        json_extract(NEW.source_json, '$.origin.dispatchGeneration')
      AND intent.device_id = json_extract(NEW.source_json, '$.origin.deviceId')
      AND json_extract(checkpoint.checkpoint_json, '$.bindingId') =
        json_extract(NEW.source_json, '$.origin.bindingId')
      AND companion.source_digest =
        json_extract(NEW.source_json, '$.origin.companionSourceDigest')
      AND json_extract(checkpoint.checkpoint_json, '$.repositoryId') =
        NEW.repository_id
      AND json_extract(checkpoint.checkpoint_json, '$.candidateCommit') =
        NEW.candidate_commit
      AND json_extract(checkpoint.checkpoint_json, '$.candidateTree') =
        NEW.candidate_tree
      AND json_extract(checkpoint.checkpoint_json, '$.inputDigest') =
        json_extract(NEW.source_json, '$.inputDigest')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.source_json, '$.artifactPins') pin
        WHERE NOT EXISTS (
          SELECT 1
          FROM repository_checkpoint_outputs output
          JOIN task_artifact_refs artifact
            ON artifact.artifact_id = output.artifact_id
            AND artifact.artifact_revision = output.artifact_revision
          JOIN result_evidence_refs evidence
            ON evidence.result_id = companion.source_result_id
            AND evidence.evidence_kind = 'artifact'
            AND evidence.artifact_id = artifact.artifact_id
          WHERE output.checkpoint_id = checkpoint.checkpoint_id
            AND output.slot_key = json_extract(pin.value, '$.outputSlot')
            AND artifact.artifact_id = json_extract(pin.value, '$.artifactId')
            AND artifact.artifact_revision =
              json_extract(pin.value, '$.artifactRevision')
            AND artifact.artifact_type = json_extract(pin.value, '$.kind')
            AND artifact.content_sha256 =
              json_extract(pin.value, '$.contentDigest')
            AND artifact.content_size_bytes =
              json_extract(pin.value, '$.byteLength')
            AND artifact.content_mode = 'snapshot_blob'
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'SourceEvidence scope is invalid');
END;

CREATE TRIGGER execution_source_evidence_immutable_update
BEFORE UPDATE ON execution_source_evidence
BEGIN SELECT RAISE(ABORT, 'SourceEvidence is immutable'); END;

CREATE TRIGGER execution_source_evidence_immutable_delete
BEFORE DELETE ON execution_source_evidence
BEGIN SELECT RAISE(ABORT, 'SourceEvidence is retained evidence'); END;

CREATE TABLE execution_gate_proof_refs (
  proof_ref_id TEXT PRIMARY KEY CHECK (proof_ref_id GLOB 'proof_*'),
  kind TEXT NOT NULL CHECK (kind IN (
    'result_review', 'verification_receipt', 'ci_observation_receipt',
    'integration_receipt'
  )),
  operation_id TEXT NOT NULL CHECK (operation_id GLOB 'op_*'),
  proof_digest TEXT NOT NULL CHECK (
    length(proof_digest) = 64 AND proof_digest NOT GLOB '*[^0-9a-f]*'
  ),
  proof_json TEXT NOT NULL CHECK (
    json_valid(proof_json) AND json_type(proof_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (kind, operation_id),
  CHECK (json_extract(proof_json, '$.kind') = kind),
  CHECK (json_extract(proof_json, '$.operationId') = operation_id),
  CHECK (json_extract(proof_json, '$.proofDigest') = proof_digest)
) STRICT;

CREATE TRIGGER execution_gate_proof_refs_require_scope_insert
BEFORE INSERT ON execution_gate_proof_refs
WHEN (
  NEW.kind = 'result_review' AND NOT EXISTS (
    SELECT 1 FROM result_reviews review
    JOIN task_results result ON result.result_id = review.result_id
    WHERE review.operation_id = NEW.operation_id
      AND review.decision = 'accepted'
      AND review.completed_task = 0
      AND json_extract(NEW.proof_json, '$.resultId') = result.result_id
      AND json_extract(NEW.proof_json, '$.resultVersion') =
        result.result_version
  )
) OR (
  NEW.kind = 'verification_receipt' AND NOT EXISTS (
    SELECT 1 FROM verification_receipts receipt
    JOIN repository_verification_operations operation
      ON operation.operation_id = receipt.operation_id
    WHERE receipt.operation_id = NEW.operation_id
      AND receipt.outcome = 'passed'
      AND receipt.receipt_digest = NEW.proof_digest
      AND json_extract(NEW.proof_json, '$.verificationId') =
        receipt.verification_id
      AND json_extract(NEW.proof_json, '$.profileId') = operation.profile_id
      AND json_extract(NEW.proof_json, '$.profileRevision') =
        operation.profile_revision
      AND json_extract(NEW.proof_json, '$.profileDigest') =
        operation.profile_digest
  )
) OR NEW.kind = 'ci_observation_receipt' OR (
  NEW.kind = 'integration_receipt' AND NOT EXISTS (
    SELECT 1 FROM integration_receipts receipt
    JOIN repository_integration_operations operation
      ON operation.operation_id = receipt.operation_id
    WHERE receipt.operation_id = NEW.operation_id
      AND receipt.state = 'succeeded'
      AND receipt.error_code IS NULL
      AND receipt.receipt_digest = NEW.proof_digest
      AND json_extract(NEW.proof_json, '$.repositoryId') =
        operation.repository_id
      AND json_extract(NEW.proof_json, '$.resultingCommit') =
        operation.candidate_commit
  )
)
BEGIN
  SELECT RAISE(ABORT, 'GateProofRef scope is invalid');
END;

CREATE TRIGGER execution_gate_proof_refs_immutable_update
BEFORE UPDATE ON execution_gate_proof_refs
BEGIN SELECT RAISE(ABORT, 'GateProofRef is immutable'); END;

CREATE TRIGGER execution_gate_proof_refs_immutable_delete
BEFORE DELETE ON execution_gate_proof_refs
BEGIN SELECT RAISE(ABORT, 'GateProofRef is retained evidence'); END;

CREATE VIEW execution_legacy_node_materializations AS
SELECT plan_id, plan_revision, node_key, gate, dispatch_generation,
  source_run_id, source_result_id, source_result_version, gate_operation_id,
  materialization_digest, artifact_pins_json, created_at
FROM execution_node_materializations
UNION ALL
SELECT plan_id, plan_revision, node_key, gate, dispatch_generation,
  source_run_id, source_result_id, source_result_version, gate_operation_id,
  materialization_digest, artifact_pins_json, created_at
FROM execution_verified_node_materializations
UNION ALL
SELECT plan_id, plan_revision, node_key, gate, dispatch_generation,
  source_run_id, source_result_id, source_result_version, gate_operation_id,
  materialization_digest, artifact_pins_json, created_at
FROM execution_integrated_node_materializations;

CREATE TABLE execution_evidence_adoptions (
  adoption_id TEXT PRIMARY KEY CHECK (adoption_id GLOB 'adoption_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (
    gate IN ('accepted_result', 'verified_output', 'integrated_commit')
  ),
  source_evidence_id TEXT NOT NULL REFERENCES execution_source_evidence(
    source_evidence_id
  ) ON DELETE RESTRICT,
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  dispatch_generation INTEGER CHECK (
    dispatch_generation IS NULL OR dispatch_generation > 0
  ),
  proof_set_digest TEXT NOT NULL CHECK (
    length(proof_set_digest) = 64 AND proof_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  node_contract_digest TEXT NOT NULL CHECK (
    length(node_contract_digest) = 64 AND
    node_contract_digest NOT GLOB '*[^0-9a-f]*'
  ),
  resolved_input_set_digest TEXT NOT NULL CHECK (
    length(resolved_input_set_digest) = 64 AND
    resolved_input_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  adoption_digest TEXT NOT NULL UNIQUE CHECK (
    length(adoption_digest) = 64 AND adoption_digest NOT GLOB '*[^0-9a-f]*'
  ),
  adoption_json TEXT NOT NULL CHECK (
    json_valid(adoption_json) AND json_type(adoption_json) = 'object'
  ),
  legacy_materialization_digest TEXT NOT NULL UNIQUE CHECK (
    length(legacy_materialization_digest) = 64 AND
    legacy_materialization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, plan_revision, node_key, gate),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT,
  CHECK (json_extract(adoption_json, '$.version') = schema_version),
  CHECK (json_extract(adoption_json, '$.adoptionId') = adoption_id),
  CHECK (json_extract(adoption_json, '$.operationId') = operation_id),
  CHECK (json_extract(adoption_json, '$.operationDigest') = operation_digest),
  CHECK (json_extract(adoption_json, '$.planId') = plan_id),
  CHECK (json_extract(adoption_json, '$.planRevision') = plan_revision),
  CHECK (json_extract(adoption_json, '$.nodeKey') = node_key),
  CHECK (json_extract(adoption_json, '$.gate') = gate),
  CHECK (json_extract(adoption_json, '$.sourceEvidenceId') = source_evidence_id),
  CHECK (json_extract(adoption_json, '$.sourceDigest') = source_digest),
  CHECK (
    (source_run_id IS NULL AND dispatch_generation IS NULL AND
      json_type(adoption_json, '$.sourceExecution') = 'null') OR
    (source_run_id IS NOT NULL AND dispatch_generation IS NOT NULL AND
      json_extract(adoption_json, '$.sourceExecution.runId') = source_run_id AND
      json_extract(adoption_json, '$.sourceExecution.dispatchGeneration') =
        dispatch_generation)
  ),
  CHECK (json_extract(adoption_json, '$.proofSetDigest') = proof_set_digest),
  CHECK (json_extract(adoption_json, '$.nodeContractDigest') =
    node_contract_digest),
  CHECK (json_extract(adoption_json, '$.resolvedInputSetDigest') =
    resolved_input_set_digest),
  CHECK (json_extract(adoption_json, '$.adoptionDigest') = adoption_digest),
  CHECK (json_extract(adoption_json, '$.createdAt') = created_at)
) STRICT;

CREATE TRIGGER execution_evidence_adoptions_require_scope_insert
BEFORE INSERT ON execution_evidence_adoptions
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plan_nodes node
  JOIN execution_source_evidence source
    ON source.source_evidence_id = NEW.source_evidence_id
    AND source.source_digest = NEW.source_digest
  JOIN execution_dispatch_intents intent
    ON intent.plan_id = node.plan_id
    AND intent.plan_revision = node.revision
    AND intent.node_key = node.node_key
    AND intent.run_id = NEW.source_run_id
    AND intent.dispatch_generation = NEW.dispatch_generation
  JOIN execution_run_admissions admission ON admission.run_id = intent.run_id
  JOIN execution_legacy_node_materializations legacy
    ON legacy.plan_id = node.plan_id
    AND legacy.plan_revision = node.revision
    AND legacy.node_key = node.node_key
    AND legacy.gate = NEW.gate
    AND legacy.source_run_id = NEW.source_run_id
    AND legacy.dispatch_generation = NEW.dispatch_generation
    AND legacy.materialization_digest = NEW.legacy_materialization_digest
  WHERE node.plan_id = NEW.plan_id
    AND node.revision = NEW.plan_revision
    AND node.node_key = NEW.node_key
    AND json_extract(NEW.adoption_json, '$.authority.taskId') = node.task_id
    AND json_extract(NEW.adoption_json, '$.authority.definitionRevision') =
      node.definition_revision
    AND json_extract(NEW.adoption_json, '$.authority.criteriaRevision') =
      node.criteria_revision
    AND json_extract(NEW.adoption_json, '$.authority.agentId') = node.agent_id
    AND json_extract(NEW.adoption_json, '$.authority.service') =
      'execution_materialization'
    AND json_extract(NEW.adoption_json, '$.authority.approvalOperationId') =
      intent.approval_operation_id
    AND json_extract(NEW.adoption_json, '$.authority.planDigest') =
      intent.plan_digest
    AND json_extract(NEW.adoption_json, '$.authority.roomId') = intent.room_id
    AND json_extract(NEW.adoption_json, '$.authority.deviceId') = intent.device_id
    AND json_extract(NEW.adoption_json, '$.authority.grantId') =
      json_extract(admission.grant_json, '$.grant.grantId')
    AND json_extract(NEW.adoption_json, '$.authority.grantRevision') =
      json_extract(admission.grant_json, '$.grant.revision')
    AND json_extract(NEW.adoption_json, '$.authority.grantDigest') =
      json_extract(admission.grant_json, '$.grant.digest')
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.adoption_json, '$.proofs') proof
      WHERE NOT EXISTS (
        SELECT 1 FROM execution_gate_proof_refs retained
        WHERE retained.kind = json_extract(proof.value, '$.kind')
          AND retained.operation_id =
            json_extract(proof.value, '$.operationId')
          AND retained.proof_digest =
            json_extract(proof.value, '$.proofDigest')
          AND json(retained.proof_json) = json(proof.value)
      )
    )
    AND (
      (NEW.gate = 'accepted_result' AND
        source.kind = 'task_result' AND
        json_array_length(json_extract(NEW.adoption_json, '$.proofs')) = 1 AND
        json_extract(NEW.adoption_json, '$.proofs[0].kind') = 'result_review' AND
        json_extract(NEW.adoption_json, '$.proofs[0].resultId') =
          source.source_result_id) OR
      (NEW.gate = 'verified_output' AND
        source.kind = 'repository_commit' AND
        json_array_length(json_extract(NEW.adoption_json, '$.proofs')) > 0 AND
        NOT EXISTS (
          SELECT 1 FROM json_each(NEW.adoption_json, '$.proofs') proof
          WHERE json_extract(proof.value, '$.kind') NOT IN (
              'verification_receipt', 'ci_observation_receipt'
            )
        ) AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.adoption_json, '$.proofs') proof
          WHERE json_extract(proof.value, '$.kind') =
              'verification_receipt'
            AND NOT EXISTS (
              SELECT 1
              FROM verification_receipts receipt
              JOIN repository_verification_operations operation
                ON operation.operation_id = receipt.operation_id
              WHERE operation.operation_id =
                  json_extract(proof.value, '$.operationId')
                AND operation.checkpoint_id = source.checkpoint_id
                AND json_extract(operation.request_json,
                  '$.action.verify.candidateCommit') = source.candidate_commit
                AND json_extract(operation.request_json,
                  '$.action.verify.candidateTree') = source.candidate_tree
                AND json_extract(operation.request_json,
                  '$.execution.runId') = NEW.source_run_id
            )
        )) OR
      (NEW.gate = 'integrated_commit' AND
        source.kind = 'repository_commit' AND
        json_array_length(json_extract(NEW.adoption_json, '$.proofs')) = 1 AND
        json_extract(NEW.adoption_json, '$.proofs[0].kind') =
          'integration_receipt' AND EXISTS (
            SELECT 1 FROM repository_integration_operations operation
            WHERE operation.operation_id =
                json_extract(NEW.adoption_json, '$.proofs[0].operationId')
              AND operation.repository_id = source.repository_id
              AND operation.candidate_commit = source.candidate_commit
              AND operation.candidate_tree = source.candidate_tree
              AND operation.source_run_id = NEW.source_run_id
          ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'EvidenceAdoption scope is invalid');
END;

CREATE TRIGGER execution_evidence_adoptions_immutable_update
BEFORE UPDATE ON execution_evidence_adoptions
BEGIN SELECT RAISE(ABORT, 'EvidenceAdoption is immutable'); END;

CREATE TRIGGER execution_evidence_adoptions_immutable_delete
BEFORE DELETE ON execution_evidence_adoptions
BEGIN SELECT RAISE(ABORT, 'EvidenceAdoption is retained authority'); END;
