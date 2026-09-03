CREATE TABLE remote_input_attestation_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL REFERENCES execution_remote_source_evidence(
    source_evidence_id
  ) ON DELETE RESTRICT,
  expected_plan_digest TEXT NOT NULL CHECK (
    length(expected_plan_digest) = 64 AND
    expected_plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expected_control_revision INTEGER NOT NULL CHECK (expected_control_revision > 0),
  actor_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  request_digest TEXT NOT NULL UNIQUE CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (
    json_valid(request_json) AND json_type(request_json) = 'object'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'outcome_unknown', 'succeeded', 'failed')
  ),
  attestation_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT,
  CHECK (json_extract(request_json, '$.operationId') = operation_id),
  CHECK (json_extract(request_json, '$.providerBindingId') = provider_binding_id),
  CHECK (json_extract(request_json, '$.planId') = plan_id),
  CHECK (json_extract(request_json, '$.planRevision') = plan_revision),
  CHECK (json_extract(request_json, '$.nodeKey') = node_key),
  CHECK (json_extract(request_json, '$.sourceEvidenceId') = source_evidence_id),
  CHECK (json_extract(request_json, '$.expectedPlanDigest') = expected_plan_digest),
  CHECK (json_extract(request_json, '$.expectedControlRevision') =
    expected_control_revision),
  CHECK (
    (state = 'planned' AND attestation_id IS NULL AND error_code IS NULL) OR
    (state = 'outcome_unknown' AND error_code IS NOT NULL) OR
    (state = 'succeeded' AND attestation_id IS NOT NULL AND error_code IS NULL) OR
    (state = 'failed' AND error_code IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER remote_input_attestation_operations_require_scope_insert
BEFORE INSERT ON remote_input_attestation_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM remote_provider_bindings binding
  JOIN team_members actor ON actor.member_id = NEW.actor_member_id
  JOIN rooms room ON room.team_id = binding.team_id
  JOIN execution_plans plan ON plan.plan_id = NEW.plan_id
    AND plan.room_id = room.room_id
  JOIN execution_plan_approvals approval ON approval.plan_id = plan.plan_id
    AND approval.revision = NEW.plan_revision AND approval.decision = 'approved'
  JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
    AND node.revision = NEW.plan_revision AND node.node_key = NEW.node_key
  JOIN execution_remote_source_evidence source
    ON source.source_evidence_id = NEW.source_evidence_id
  JOIN remote_commit_observations observation
    ON observation.observation_id = source.observation_id
    AND observation.provider_binding_id = binding.provider_binding_id
  WHERE binding.provider_binding_id = NEW.provider_binding_id
    AND actor.team_id = binding.team_id AND actor.role = 'owner'
    AND plan.state IN ('approved', 'running')
    AND plan.current_revision = NEW.plan_revision
    AND plan.control_revision = NEW.expected_control_revision
    AND approval.digest = NEW.expected_plan_digest
    AND source.repository_id = binding.repository_id
    AND source.repository_id = json_extract(node.node_json,
      '$.repository.repositoryId')
    AND json_array_length(json_extract(node.node_json, '$.inputs')) > 0
    AND NOT EXISTS (
      SELECT 1 FROM remote_provider_binding_revocations revocation
      WHERE revocation.provider_binding_id = binding.provider_binding_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_dispatch_intents intent
      WHERE intent.plan_id = plan.plan_id
        AND intent.plan_revision = node.revision
        AND intent.node_key = node.node_key
    )
)
BEGIN SELECT RAISE(ABORT, 'Remote input attestation operation scope is invalid'); END;

CREATE TRIGGER remote_input_attestation_operations_preserve_identity
BEFORE UPDATE ON remote_input_attestation_operations
WHEN NEW.operation_id <> OLD.operation_id OR
  NEW.provider_binding_id <> OLD.provider_binding_id OR
  NEW.plan_id <> OLD.plan_id OR NEW.plan_revision <> OLD.plan_revision OR
  NEW.node_key <> OLD.node_key OR
  NEW.source_evidence_id <> OLD.source_evidence_id OR
  NEW.expected_plan_digest <> OLD.expected_plan_digest OR
  NEW.expected_control_revision <> OLD.expected_control_revision OR
  NEW.actor_member_id <> OLD.actor_member_id OR
  NEW.request_digest <> OLD.request_digest OR
  json(NEW.request_json) <> json(OLD.request_json) OR
  NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'Remote input attestation operation identity is immutable'); END;

CREATE TRIGGER remote_input_attestation_operations_state_transition
BEFORE UPDATE ON remote_input_attestation_operations
WHEN NOT (
  (OLD.state = 'planned' AND NEW.state IN (
    'planned', 'outcome_unknown', 'succeeded', 'failed'
  )) OR
  (OLD.state = 'outcome_unknown' AND NEW.state IN (
    'outcome_unknown', 'succeeded', 'failed'
  )) OR
  (OLD.state = NEW.state AND OLD.attestation_id IS NEW.attestation_id AND
    OLD.error_code IS NEW.error_code)
)
BEGIN SELECT RAISE(ABORT, 'Remote input attestation operation transition is invalid'); END;

CREATE TRIGGER remote_input_attestation_operations_immutable_delete
BEFORE DELETE ON remote_input_attestation_operations
BEGIN SELECT RAISE(ABORT, 'Remote input attestation operation is retained'); END;

CREATE TABLE remote_input_attestations (
  attestation_id TEXT PRIMARY KEY CHECK (attestation_id GLOB 'attestation_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operation_id TEXT NOT NULL UNIQUE REFERENCES remote_input_attestation_operations(
    operation_id
  ) ON DELETE RESTRICT,
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL REFERENCES execution_remote_source_evidence(
    source_evidence_id
  ) ON DELETE RESTRICT,
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_observation_id TEXT NOT NULL REFERENCES remote_commit_observations(
    observation_id
  ) ON DELETE RESTRICT,
  source_observation_digest TEXT NOT NULL CHECK (
    length(source_observation_digest) = 64 AND
    source_observation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  remote_input_evidence_digest TEXT NOT NULL CHECK (
    length(remote_input_evidence_digest) = 64 AND
    remote_input_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  provider_attestation_digest TEXT NOT NULL CHECK (
    length(provider_attestation_digest) = 64 AND
    provider_attestation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  attestation_digest TEXT NOT NULL UNIQUE CHECK (
    length(attestation_digest) = 64 AND
    attestation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  attestation_json TEXT NOT NULL CHECK (
    json_valid(attestation_json) AND json_type(attestation_json) = 'object'
  ),
  attested_at TEXT NOT NULL,
  UNIQUE (plan_id, plan_revision, node_key, source_evidence_id),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT,
  CHECK (json_extract(attestation_json, '$.version') = schema_version),
  CHECK (json_extract(attestation_json, '$.attestationId') = attestation_id),
  CHECK (json_extract(attestation_json, '$.operationId') = operation_id),
  CHECK (json_extract(attestation_json, '$.providerBindingId') = provider_binding_id),
  CHECK (json_extract(attestation_json, '$.repositoryId') = repository_id),
  CHECK (json_extract(attestation_json, '$.providerRepositoryId') =
    provider_repository_id),
  CHECK (json_extract(attestation_json, '$.planId') = plan_id),
  CHECK (json_extract(attestation_json, '$.planRevision') = plan_revision),
  CHECK (json_extract(attestation_json, '$.nodeKey') = node_key),
  CHECK (json_extract(attestation_json, '$.sourceEvidenceId') = source_evidence_id),
  CHECK (json_extract(attestation_json, '$.sourceDigest') = source_digest),
  CHECK (json_extract(attestation_json, '$.sourceObservationId') =
    source_observation_id),
  CHECK (json_extract(attestation_json, '$.sourceObservationDigest') =
    source_observation_digest),
  CHECK (json_extract(attestation_json, '$.remoteInputEvidenceDigest') =
    remote_input_evidence_digest),
  CHECK (json_extract(attestation_json, '$.providerAttestationDigest') =
    provider_attestation_digest),
  CHECK (json_extract(attestation_json, '$.attestationDigest') =
    attestation_digest),
  CHECK (json_extract(attestation_json, '$.attestedAt') = attested_at)
) STRICT;

CREATE TRIGGER remote_input_attestations_require_scope_insert
BEFORE INSERT ON remote_input_attestations
WHEN NOT EXISTS (
  SELECT 1
  FROM remote_input_attestation_operations operation
  JOIN remote_provider_bindings binding
    ON binding.provider_binding_id = operation.provider_binding_id
  JOIN execution_remote_source_evidence source
    ON source.source_evidence_id = operation.source_evidence_id
  JOIN remote_commit_observations observation
    ON observation.observation_id = source.observation_id
  JOIN execution_plan_nodes node ON node.plan_id = operation.plan_id
    AND node.revision = operation.plan_revision
    AND node.node_key = operation.node_key
  WHERE operation.operation_id = NEW.operation_id
    AND operation.state IN ('planned', 'outcome_unknown')
    AND operation.provider_binding_id = NEW.provider_binding_id
    AND operation.plan_id = NEW.plan_id
    AND operation.plan_revision = NEW.plan_revision
    AND operation.node_key = NEW.node_key
    AND operation.source_evidence_id = NEW.source_evidence_id
    AND binding.repository_id = NEW.repository_id
    AND binding.provider_repository_id = NEW.provider_repository_id
    AND source.source_digest = NEW.source_digest
    AND source.observation_id = NEW.source_observation_id
    AND observation.observation_digest = NEW.source_observation_digest
    AND observation.candidate_commit = json_extract(NEW.attestation_json, '$.commit')
    AND observation.candidate_tree = json_extract(NEW.attestation_json, '$.tree')
    AND json_array_length(NEW.attestation_json, '$.inputs') =
      json_array_length(node.node_json, '$.inputs')
    AND json_array_length(NEW.attestation_json, '$.inputs') > 0
    AND NOT EXISTS (
      SELECT 1 FROM json_each(node.node_json, '$.inputs') input
      WHERE json_extract(input.value, '$.required') <> 1 OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.attestation_json, '$.inputs') retained
        WHERE json_extract(retained.value, '$.reuseInput.inputSlot') =
          json_extract(input.value, '$.slotKey')
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_plan_proposals proposal,
        json_each(proposal.definition_json, '$.externalInputs') external
      WHERE proposal.plan_id = node.plan_id AND proposal.revision = node.revision
        AND json_extract(external.value, '$.nodeKey') = node.node_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.attestation_json, '$.inputs') retained
      WHERE (
        SELECT count(*) FROM execution_plan_edges edge,
          json_each(edge.edge_json, '$.bindings') edge_binding
        JOIN execution_all_adopted_node_materializations materialization
          ON materialization.plan_id = edge.plan_id
          AND materialization.plan_revision = edge.revision
          AND materialization.node_key = edge.from_node_key
          AND materialization.gate = edge.gate
        JOIN json_each(materialization.artifact_pins_json) pin
          ON json_extract(pin.value, '$.outputSlot') =
            json_extract(edge_binding.value, '$.outputSlot')
        WHERE edge.plan_id = node.plan_id AND edge.revision = node.revision
          AND edge.to_node_key = node.node_key
          AND json_extract(edge_binding.value, '$.inputSlot') =
            json_extract(retained.value, '$.reuseInput.inputSlot')
          AND materialization.adoption_id =
            json_extract(retained.value, '$.adoptionId')
          AND materialization.adoption_digest =
            json_extract(retained.value, '$.adoptionDigest')
          AND materialization.source_evidence_id =
            json_extract(retained.value, '$.reuseInput.producer.sourceEvidenceId')
          AND materialization.source_digest =
            json_extract(retained.value, '$.reuseInput.producer.sourceDigest')
          AND json_extract(retained.value, '$.reuseInput.producer.kind') =
            'adopted_evidence'
          AND json_extract(retained.value, '$.reuseInput.producer.edge.edgeKey') =
            edge.edge_key
          AND json(json_extract(
            retained.value, '$.reuseInput.producer.edge'
          )) =
            json(edge.edge_json)
          AND json_extract(pin.value, '$.kind') =
            json_extract(retained.value, '$.reuseInput.artifact.kind')
          AND json_extract(pin.value, '$.contentDigest') =
            json_extract(retained.value, '$.reuseInput.artifact.contentDigest')
          AND COALESCE((SELECT proof_set_digest
            FROM execution_evidence_adoptions local
            WHERE local.adoption_id = materialization.adoption_id),
            (SELECT proof_set_digest
            FROM execution_remote_evidence_adoptions remote
            WHERE remote.adoption_id = materialization.adoption_id)) =
            json_extract(retained.value, '$.reuseInput.producer.proofSetDigest')
      ) <> 1
    )
)
BEGIN SELECT RAISE(ABORT, 'RemoteInputAttestation scope is invalid'); END;

CREATE TRIGGER remote_input_attestations_immutable_update
BEFORE UPDATE ON remote_input_attestations
BEGIN SELECT RAISE(ABORT, 'RemoteInputAttestation is immutable'); END;

CREATE TRIGGER remote_input_attestations_immutable_delete
BEFORE DELETE ON remote_input_attestations
BEGIN SELECT RAISE(ABORT, 'RemoteInputAttestation is retained evidence'); END;

CREATE TABLE execution_remote_evidence_reuse_contracts (
  reuse_contract_id TEXT PRIMARY KEY CHECK (reuse_contract_id GLOB 'reuse_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  adoption_id TEXT NOT NULL UNIQUE REFERENCES execution_remote_evidence_adoptions(
    adoption_id
  ) ON DELETE RESTRICT,
  adoption_digest TEXT NOT NULL CHECK (length(adoption_digest) = 64),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (gate = 'verified_output'),
  runtime_input_binding_digest TEXT NOT NULL CHECK (
    length(runtime_input_binding_digest) = 64
  ),
  reuse_input_evidence_digest TEXT NOT NULL CHECK (
    length(reuse_input_evidence_digest) = 64
  ),
  node_execution_digest TEXT NOT NULL CHECK (length(node_execution_digest) = 64),
  node_reuse_contract_digest TEXT NOT NULL CHECK (
    length(node_reuse_contract_digest) = 64
  ),
  contract_digest TEXT NOT NULL UNIQUE CHECK (length(contract_digest) = 64),
  contract_json TEXT NOT NULL CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT,
  CHECK (json_extract(contract_json, '$.version') = schema_version),
  CHECK (json_extract(contract_json, '$.reuseContractId') = reuse_contract_id),
  CHECK (json_extract(contract_json, '$.adoptionId') = adoption_id),
  CHECK (json_extract(contract_json, '$.adoptionDigest') = adoption_digest),
  CHECK (json_extract(contract_json, '$.planId') = plan_id),
  CHECK (json_extract(contract_json, '$.planRevision') = plan_revision),
  CHECK (json_extract(contract_json, '$.nodeKey') = node_key),
  CHECK (json_extract(contract_json, '$.gate') = gate),
  CHECK (json_extract(contract_json, '$.runtimeInputBindingDigest') =
    runtime_input_binding_digest),
  CHECK (json_extract(contract_json, '$.reuseInputEvidenceDigest') =
    reuse_input_evidence_digest),
  CHECK (json_extract(contract_json, '$.nodeExecutionDigest') =
    node_execution_digest),
  CHECK (json_extract(contract_json, '$.nodeReuseContractDigest') =
    node_reuse_contract_digest),
  CHECK (json_extract(contract_json, '$.contractDigest') = contract_digest),
  CHECK (json_extract(contract_json, '$.createdAt') = created_at)
) STRICT;

CREATE TRIGGER execution_remote_reuse_contracts_require_scope_insert
BEFORE INSERT ON execution_remote_evidence_reuse_contracts
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_remote_evidence_adoptions adoption
  JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
    AND node.revision = adoption.plan_revision
    AND node.node_key = adoption.node_key
  JOIN execution_plan_proposals proposal ON proposal.plan_id = adoption.plan_id
    AND proposal.revision = adoption.plan_revision
  WHERE adoption.adoption_id = NEW.adoption_id
    AND adoption.adoption_digest = NEW.adoption_digest
    AND adoption.plan_id = NEW.plan_id
    AND adoption.plan_revision = NEW.plan_revision
    AND adoption.node_key = NEW.node_key AND adoption.gate = NEW.gate
    AND adoption.resolved_input_set_digest = NEW.runtime_input_binding_digest
    AND adoption.node_contract_digest = NEW.node_execution_digest
    AND json(json_extract(NEW.contract_json, '$.node')) =
      json(json_remove(node.node_json, '$.task'))
    AND json(json_extract(NEW.contract_json, '$.task')) =
      json(json_remove(node.task_snapshot_json, '$.taskRevision'))
    AND json_extract(NEW.contract_json, '$.integrationPolicy.integration') =
      json_extract(proposal.definition_json, '$.policy.integration')
    AND json_extract(NEW.contract_json,
      '$.integrationPolicy.requireHumanIntegrationApproval') =
      json_extract(proposal.definition_json,
        '$.policy.requireHumanIntegrationApproval')
    AND NOT EXISTS (
      SELECT 1 FROM json_each(
        NEW.contract_json, '$.integrationPolicy.integrationTargets'
      ) retained
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(
          proposal.definition_json, '$.policy.integrationTargets'
        ) approved
        WHERE json(approved.value) = json(retained.value)
          AND json_extract(approved.value, '$.repositoryId') =
            json_extract(node.node_json, '$.repository.repositoryId')
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(
        proposal.definition_json, '$.policy.integrationTargets'
      ) approved
      WHERE json_extract(approved.value, '$.repositoryId') =
          json_extract(node.node_json, '$.repository.repositoryId')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(
            NEW.contract_json, '$.integrationPolicy.integrationTargets'
          ) retained
          WHERE json(retained.value) = json(approved.value)
        )
    )
    AND (
      (json_array_length(node.node_json, '$.inputs') = 0 AND
        json_array_length(NEW.contract_json, '$.reuseInputs') = 0) OR
      EXISTS (
        SELECT 1 FROM remote_input_attestations attestation
        WHERE attestation.plan_id = adoption.plan_id
          AND attestation.plan_revision = adoption.plan_revision
          AND attestation.node_key = adoption.node_key
          AND attestation.source_evidence_id = adoption.source_evidence_id
          AND attestation.remote_input_evidence_digest =
            NEW.reuse_input_evidence_digest
          AND json_array_length(attestation.attestation_json, '$.inputs') =
            json_array_length(NEW.contract_json, '$.reuseInputs')
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(attestation.attestation_json, '$.inputs') retained
            WHERE NOT EXISTS (
              SELECT 1 FROM json_each(
                NEW.contract_json, '$.reuseInputs'
              ) reuse
              WHERE json(reuse.value) = json(json_extract(
                retained.value, '$.reuseInput'
              ))
            )
          )
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'Remote EvidenceReuseContract scope is invalid'); END;

CREATE TRIGGER execution_remote_reuse_contracts_immutable_update
BEFORE UPDATE ON execution_remote_evidence_reuse_contracts
BEGIN SELECT RAISE(ABORT, 'Remote EvidenceReuseContract is immutable'); END;

CREATE TRIGGER execution_remote_reuse_contracts_immutable_delete
BEFORE DELETE ON execution_remote_evidence_reuse_contracts
BEGIN SELECT RAISE(ABORT, 'Remote EvidenceReuseContract is retained evidence'); END;

DROP TRIGGER execution_remote_adoptions_require_scope_insert;
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
    AND (
      (json_array_length(json_extract(node.node_json, '$.inputs')) = 0 AND
        NOT EXISTS (
          SELECT 1 FROM execution_plan_edges edge
          WHERE edge.plan_id = node.plan_id AND edge.revision = node.revision
            AND edge.to_node_key = node.node_key
        )) OR
      EXISTS (
        SELECT 1 FROM remote_input_attestations attestation
        WHERE attestation.provider_binding_id = binding.provider_binding_id
          AND attestation.plan_id = node.plan_id
          AND attestation.plan_revision = node.revision
          AND attestation.node_key = node.node_key
          AND attestation.source_evidence_id = source.source_evidence_id
          AND attestation.source_digest = source.source_digest
          AND attestation.source_observation_id = observation.observation_id
          AND attestation.source_observation_digest =
            observation.observation_digest
      )
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

DROP VIEW execution_all_adopted_node_materializations;
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
JOIN execution_remote_evidence_reuse_contracts reuse
  ON reuse.adoption_id = adoption.adoption_id
  AND reuse.adoption_digest = adoption.adoption_digest
JOIN execution_remote_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
  AND node.revision = adoption.plan_revision
  AND node.node_key = adoption.node_key
WHERE (
  json_array_length(node.node_json, '$.inputs') = 0 OR EXISTS (
    SELECT 1 FROM remote_input_attestations attestation
    WHERE attestation.plan_id = adoption.plan_id
      AND attestation.plan_revision = adoption.plan_revision
      AND attestation.node_key = adoption.node_key
      AND attestation.source_evidence_id = adoption.source_evidence_id
      AND attestation.remote_input_evidence_digest =
        reuse.reuse_input_evidence_digest
  )
);
