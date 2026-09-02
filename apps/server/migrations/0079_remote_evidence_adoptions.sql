CREATE TABLE execution_remote_evidence_adoptions (
  adoption_id TEXT PRIMARY KEY CHECK (adoption_id GLOB 'adoption_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'verified_output'),
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  source_evidence_id TEXT NOT NULL REFERENCES execution_remote_source_evidence(
    source_evidence_id
  ) ON DELETE RESTRICT,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  proof_set_digest TEXT NOT NULL CHECK (length(proof_set_digest) = 64),
  node_contract_digest TEXT NOT NULL CHECK (length(node_contract_digest) = 64),
  resolved_input_set_digest TEXT NOT NULL CHECK (
    length(resolved_input_set_digest) = 64
  ),
  adoption_digest TEXT NOT NULL UNIQUE CHECK (length(adoption_digest) = 64),
  adoption_json TEXT NOT NULL CHECK (
    json_valid(adoption_json) AND json_type(adoption_json) = 'object'
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
  CHECK (json_type(adoption_json, '$.sourceExecution') = 'null'),
  CHECK (json_extract(adoption_json, '$.proofSetDigest') = proof_set_digest),
  CHECK (json_extract(adoption_json, '$.nodeContractDigest') =
    node_contract_digest),
  CHECK (json_extract(adoption_json, '$.resolvedInputSetDigest') =
    resolved_input_set_digest),
  CHECK (json_extract(adoption_json, '$.adoptionDigest') = adoption_digest),
  CHECK (json_extract(adoption_json, '$.createdAt') = created_at)
) STRICT;

CREATE TRIGGER execution_remote_adoptions_require_scope_insert
BEFORE INSERT ON execution_remote_evidence_adoptions
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_approvals approval
    ON approval.plan_id = plan.plan_id
    AND approval.revision = NEW.plan_revision
    AND approval.decision = 'approved'
  JOIN execution_plan_nodes node
    ON node.plan_id = plan.plan_id
    AND node.revision = NEW.plan_revision
    AND node.node_key = NEW.node_key
  JOIN execution_remote_source_evidence source
    ON source.source_evidence_id = NEW.source_evidence_id
    AND source.source_digest = NEW.source_digest
  JOIN remote_commit_observations observation
    ON observation.observation_id = source.observation_id
  JOIN remote_evidence_operations source_operation
    ON source_operation.operation_id = observation.operation_id
    AND source_operation.plan_id = plan.plan_id
    AND source_operation.plan_revision = node.revision
    AND source_operation.node_key = node.node_key
    AND source_operation.state = 'succeeded'
  JOIN remote_provider_bindings binding
    ON binding.provider_binding_id = NEW.provider_binding_id
    AND binding.provider_binding_id = observation.provider_binding_id
    AND binding.repository_id = source.repository_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND plan.control_revision = source_operation.expected_control_revision
    AND plan.state IN ('approved', 'running')
    AND approval.digest = json_extract(NEW.adoption_json,
      '$.authority.planDigest')
    AND approval.operation_id = json_extract(NEW.adoption_json,
      '$.authority.approvalOperationId')
    AND json_extract(NEW.adoption_json, '$.authority.service') =
      'remote_evidence_adoption'
    AND json_extract(NEW.adoption_json, '$.authority.roomId') = plan.room_id
    AND json_extract(NEW.adoption_json, '$.authority.taskId') = node.task_id
    AND json_extract(NEW.adoption_json, '$.authority.definitionRevision') =
      node.definition_revision
    AND json_extract(NEW.adoption_json, '$.authority.criteriaRevision') =
      node.criteria_revision
    AND json_extract(NEW.adoption_json, '$.authority.actorMemberId') =
      source_operation.actor_member_id
    AND json_extract(NEW.adoption_json, '$.authority.providerBindingId') =
      binding.provider_binding_id
    AND json_extract(NEW.adoption_json, '$.authority.bindingDigest') =
      binding.binding_digest
    AND source.repository_id = json_extract(node.node_json,
      '$.repository.repositoryId')
    AND observation.base_commit = json_extract(node.node_json,
      '$.repository.baseCommit')
    AND json_array_length(json_extract(node.node_json, '$.inputs')) = 0
    AND NOT EXISTS (
      SELECT 1 FROM execution_plan_edges edge
      WHERE edge.plan_id = node.plan_id AND edge.revision = node.revision
        AND edge.to_node_key = node.node_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_dispatch_intents intent
      WHERE intent.plan_id = node.plan_id AND intent.plan_revision = node.revision
        AND intent.node_key = node.node_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_evidence_adoptions local
      WHERE local.plan_id = node.plan_id AND local.plan_revision = node.revision
        AND local.node_key = node.node_key AND local.gate = NEW.gate
    )
    AND NOT EXISTS (
      SELECT 1 FROM remote_provider_binding_revocations revocation
      WHERE revocation.provider_binding_id = binding.provider_binding_id
    )
    AND json_array_length(json_extract(NEW.adoption_json, '$.proofs')) > 0
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.adoption_json, '$.proofs') proof
      WHERE NOT EXISTS (
        SELECT 1
        FROM execution_remote_gate_proof_refs retained
        JOIN remote_ci_observation_receipts receipt
          ON receipt.operation_id = retained.operation_id
        WHERE retained.operation_id = json_extract(proof.value, '$.operationId')
          AND retained.proof_digest = json_extract(proof.value, '$.proofDigest')
          AND json(retained.proof_json) = json(proof.value)
          AND receipt.source_evidence_id = source.source_evidence_id
          AND receipt.provider_binding_id = binding.provider_binding_id
          AND receipt.candidate_commit = source.candidate_commit
          AND receipt.candidate_tree = source.candidate_tree
          AND receipt.outcome = 'passed'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(node.node_json, '$.verificationProfiles') profile
      WHERE json_extract(profile.value, '$.required') = 1
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.adoption_json, '$.proofs') proof
          JOIN remote_ci_observation_receipts receipt
            ON receipt.operation_id = json_extract(proof.value, '$.operationId')
          WHERE receipt.source_evidence_id = source.source_evidence_id
            AND receipt.profile_id = json_extract(profile.value, '$.profileId')
            AND receipt.profile_revision = json_extract(profile.value, '$.revision')
            AND receipt.profile_digest = json_extract(profile.value, '$.digest')
            AND receipt.outcome = 'passed'
        )
    )
)
BEGIN SELECT RAISE(ABORT, 'Remote EvidenceAdoption scope is invalid'); END;

CREATE TRIGGER execution_remote_adoptions_immutable_update
BEFORE UPDATE ON execution_remote_evidence_adoptions
BEGIN SELECT RAISE(ABORT, 'Remote EvidenceAdoption is immutable'); END;

CREATE TRIGGER execution_remote_adoptions_immutable_delete
BEFORE DELETE ON execution_remote_evidence_adoptions
BEGIN SELECT RAISE(ABORT, 'Remote EvidenceAdoption is retained authority'); END;

CREATE VIEW execution_all_adopted_node_materializations AS
SELECT materialization.plan_id, materialization.plan_revision,
  materialization.node_key, materialization.gate,
  materialization.dispatch_generation, materialization.source_run_id,
  materialization.source_result_id, materialization.source_result_version,
  materialization.gate_operation_id, materialization.materialization_digest,
  materialization.candidate_commit, materialization.candidate_tree,
  materialization.checkpoint_id, materialization.artifact_pins_json,
  materialization.adoption_id, materialization.adoption_digest,
  materialization.source_evidence_id, materialization.source_digest,
  node.task_id AS source_task_id, node.definition_revision,
  node.criteria_revision
FROM execution_adopted_node_materializations materialization
JOIN execution_plan_nodes node ON node.plan_id = materialization.plan_id
  AND node.revision = materialization.plan_revision
  AND node.node_key = materialization.node_key
UNION ALL
SELECT adoption.plan_id, adoption.plan_revision, adoption.node_key,
  adoption.gate, NULL, NULL, NULL, NULL,
  adoption.operation_id, adoption.adoption_digest,
  source.candidate_commit, source.candidate_tree, NULL,
  source.artifact_pins_json, adoption.adoption_id,
  adoption.adoption_digest, adoption.source_evidence_id,
  adoption.source_digest, node.task_id, node.definition_revision,
  node.criteria_revision
FROM execution_remote_evidence_adoptions adoption
JOIN execution_remote_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
  AND node.revision = adoption.plan_revision
  AND node.node_key = adoption.node_key;
