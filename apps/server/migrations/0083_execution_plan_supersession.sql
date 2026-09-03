CREATE TABLE execution_plan_supersession_candidates (
  candidate_id TEXT PRIMARY KEY CHECK (candidate_id GLOB 'supersession_*'),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK (base_revision > 0),
  base_digest TEXT NOT NULL CHECK (length(base_digest) = 64),
  base_control_revision INTEGER NOT NULL CHECK (base_control_revision > 0),
  root_task_revision INTEGER NOT NULL CHECK (root_task_revision > 0),
  candidate_revision INTEGER NOT NULL CHECK (
    candidate_revision = base_revision + 1
  ),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES
    execution_plan_revisions(proposal_id) ON DELETE RESTRICT,
  author_json TEXT NOT NULL CHECK (
    json_valid(author_json) AND json_type(author_json) = 'object'
  ),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  response_json TEXT NOT NULL CHECK (
    json_valid(response_json) AND json_type(response_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, candidate_revision),
  FOREIGN KEY (plan_id, base_revision)
    REFERENCES execution_plan_revisions(plan_id, revision) ON DELETE RESTRICT,
  CHECK (json_extract(response_json, '$.candidateId') = candidate_id),
  CHECK (json_extract(response_json, '$.operationId') = operation_id),
  CHECK (json_extract(response_json, '$.planId') = plan_id),
  CHECK (json_extract(response_json, '$.baseRevision') = base_revision),
  CHECK (json_extract(response_json, '$.baseDigest') = base_digest),
  CHECK (json_extract(response_json, '$.baseControlRevision') =
    base_control_revision),
  CHECK (json_extract(response_json, '$.rootTaskRevision') =
    root_task_revision),
  CHECK (json_extract(response_json, '$.candidateRevision') =
    candidate_revision),
  CHECK (json_extract(response_json, '$.candidateDigest') = candidate_digest),
  CHECK (json_extract(response_json, '$.reason') = reason),
  CHECK (json_extract(response_json, '$.requestDigest') = request_digest),
  CHECK (json_extract(response_json, '$.createdAt') = created_at)
) STRICT;

CREATE TRIGGER execution_supersession_candidates_require_scope_insert
BEFORE INSERT ON execution_plan_supersession_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans plan
  JOIN execution_plan_proposals current_proposal
    ON current_proposal.plan_id = plan.plan_id
    AND current_proposal.revision = plan.current_revision
  JOIN execution_plan_proposals candidate_proposal
    ON candidate_proposal.plan_id = NEW.plan_id
    AND candidate_proposal.revision = NEW.candidate_revision
    AND candidate_proposal.proposal_id = NEW.proposal_id
  JOIN agent_tasks root ON root.task_id = plan.root_task_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.base_revision
    AND plan.control_revision = NEW.base_control_revision
    AND plan.state IN ('approved', 'running', 'paused', 'review')
    AND current_proposal.digest = NEW.base_digest
    AND candidate_proposal.digest = NEW.candidate_digest
    AND candidate_proposal.root_task_revision = NEW.root_task_revision
    AND root.task_revision = NEW.root_task_revision
    AND json(candidate_proposal.author_json) = json(NEW.author_json)
    AND json(candidate_proposal.definition_json) =
      json_extract(NEW.response_json, '$.definition')
    AND NOT EXISTS (
      SELECT 1 FROM execution_plan_approvals approval
      WHERE approval.plan_id = NEW.plan_id
        AND approval.revision = NEW.candidate_revision
    )
)
BEGIN SELECT RAISE(ABORT, 'Execution supersession candidate scope is invalid'); END;

CREATE TABLE execution_replan_delegations (
  delegation_id TEXT PRIMARY KEY CHECK (delegation_id GLOB 'replan_*'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  plan_control_revision INTEGER NOT NULL CHECK (plan_control_revision > 0),
  root_task_revision INTEGER NOT NULL CHECK (root_task_revision > 0),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  issued_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  task_ids_json TEXT NOT NULL CHECK (
    json_valid(task_ids_json) AND json_type(task_ids_json) = 'array'
  ),
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  delegation_digest TEXT NOT NULL UNIQUE CHECK (length(delegation_digest) = 64),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  issued_at TEXT NOT NULL,
  UNIQUE (plan_id, agent_id, revision),
  FOREIGN KEY (plan_id, plan_revision)
    REFERENCES execution_plan_revisions(plan_id, revision) ON DELETE RESTRICT,
  CHECK (json_extract(record_json, '$.delegationId') = delegation_id),
  CHECK (json_extract(record_json, '$.revision') = revision),
  CHECK (json_extract(record_json, '$.operationId') = operation_id),
  CHECK (json_extract(record_json, '$.planId') = plan_id),
  CHECK (json_extract(record_json, '$.planRevision') = plan_revision),
  CHECK (json_extract(record_json, '$.planDigest') = plan_digest),
  CHECK (json_extract(record_json, '$.planControlRevision') =
    plan_control_revision),
  CHECK (json_extract(record_json, '$.rootTaskRevision') =
    root_task_revision),
  CHECK (json_extract(record_json, '$.agentId') = agent_id),
  CHECK (json_extract(record_json, '$.issuedByMemberId') =
    issued_by_member_id),
  CHECK (json_extract(record_json, '$.taskIds') = json(task_ids_json)),
  CHECK (json_extract(record_json, '$.expiresAt') = expires_at),
  CHECK (json_extract(record_json, '$.reason') = reason),
  CHECK (json_extract(record_json, '$.delegationDigest') = delegation_digest),
  CHECK (json_extract(record_json, '$.issuedAt') = issued_at)
) STRICT;

CREATE TABLE execution_replan_delegation_revocations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  delegation_id TEXT NOT NULL UNIQUE REFERENCES execution_replan_delegations(
    delegation_id
  ) ON DELETE RESTRICT,
  delegation_revision INTEGER NOT NULL CHECK (delegation_revision > 0),
  delegation_digest TEXT NOT NULL CHECK (length(delegation_digest) = 64),
  revoked_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  revocation_digest TEXT NOT NULL UNIQUE CHECK (length(revocation_digest) = 64),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  revoked_at TEXT NOT NULL,
  CHECK (json_extract(record_json, '$.operationId') = operation_id),
  CHECK (json_extract(record_json, '$.delegationId') = delegation_id),
  CHECK (json_extract(record_json, '$.delegationRevision') =
    delegation_revision),
  CHECK (json_extract(record_json, '$.delegationDigest') = delegation_digest),
  CHECK (json_extract(record_json, '$.revokedByMemberId') =
    revoked_by_member_id),
  CHECK (json_extract(record_json, '$.reason') = reason),
  CHECK (json_extract(record_json, '$.revocationDigest') = revocation_digest),
  CHECK (json_extract(record_json, '$.revokedAt') = revoked_at)
) STRICT;

CREATE TABLE execution_plan_supersession_activations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK (base_revision > 0),
  base_digest TEXT NOT NULL CHECK (length(base_digest) = 64),
  base_control_revision INTEGER NOT NULL CHECK (base_control_revision > 0),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES
    execution_plan_supersession_candidates(candidate_id) ON DELETE RESTRICT,
  candidate_revision INTEGER NOT NULL CHECK (
    candidate_revision = base_revision + 1
  ),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  root_task_revision_before INTEGER NOT NULL CHECK (
    root_task_revision_before > 0
  ),
  activated_by_json TEXT NOT NULL CHECK (
    json_valid(activated_by_json) AND json_type(activated_by_json) = 'object'
  ),
  authority_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  delegation_id TEXT REFERENCES execution_replan_delegations(delegation_id)
    ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  activated_at TEXT NOT NULL,
  UNIQUE (plan_id, candidate_revision),
  FOREIGN KEY (plan_id, base_revision)
    REFERENCES execution_plan_revisions(plan_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, candidate_revision)
    REFERENCES execution_plan_revisions(plan_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_replan_delegation_consumptions (
  delegation_id TEXT PRIMARY KEY REFERENCES execution_replan_delegations(
    delegation_id
  ) ON DELETE RESTRICT,
  activation_operation_id TEXT NOT NULL UNIQUE REFERENCES
    execution_plan_supersession_activations(operation_id) ON DELETE RESTRICT,
  consumed_at TEXT NOT NULL
) STRICT;

CREATE TABLE execution_plan_supersession_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES
    execution_plan_supersession_activations(operation_id) ON DELETE RESTRICT,
  operation_digest TEXT NOT NULL UNIQUE CHECK (length(operation_digest) = 64),
  response_json TEXT NOT NULL CHECK (
    json_valid(response_json) AND json_type(response_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  CHECK (json_extract(response_json, '$.operationId') = operation_id),
  CHECK (json_extract(response_json, '$.operationDigest') = operation_digest),
  CHECK (json_extract(response_json, '$.activatedAt') = created_at)
) STRICT;

CREATE TABLE execution_carried_evidence_adoptions (
  adoption_id TEXT PRIMARY KEY CHECK (adoption_id GLOB 'adoption_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  operation_digest TEXT NOT NULL CHECK (length(operation_digest) = 64),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 1),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (
    gate IN ('accepted_result', 'verified_output', 'integrated_commit')
  ),
  source_adoption_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL REFERENCES execution_source_evidence(
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
  CHECK (json_extract(adoption_json, '$.sourceEvidenceId') =
    source_evidence_id),
  CHECK (json_extract(adoption_json, '$.sourceDigest') = source_digest),
  CHECK (json_extract(adoption_json, '$.proofSetDigest') = proof_set_digest),
  CHECK (json_extract(adoption_json, '$.nodeContractDigest') =
    node_contract_digest),
  CHECK (json_extract(adoption_json, '$.resolvedInputSetDigest') =
    resolved_input_set_digest),
  CHECK (json_extract(adoption_json, '$.adoptionDigest') = adoption_digest),
  CHECK (json_extract(adoption_json, '$.createdAt') = created_at)
) STRICT;

CREATE TABLE execution_carried_evidence_reuse_contracts (
  reuse_contract_id TEXT PRIMARY KEY CHECK (reuse_contract_id GLOB 'reuse_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  adoption_id TEXT NOT NULL UNIQUE REFERENCES execution_carried_evidence_adoptions(
    adoption_id
  ) ON DELETE RESTRICT,
  adoption_digest TEXT NOT NULL CHECK (length(adoption_digest) = 64),
  source_reuse_contract_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 1),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (
    gate IN ('accepted_result', 'verified_output', 'integrated_commit')
  ),
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
    ON DELETE RESTRICT
) STRICT;

DROP TRIGGER execution_approval_require_exact_compilation_insert;
CREATE TRIGGER execution_approval_require_exact_compilation_insert
BEFORE INSERT ON execution_plan_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans plan
  JOIN execution_plan_proposals proposal
    ON proposal.plan_id = plan.plan_id AND proposal.revision = NEW.revision
  JOIN agent_tasks root ON root.task_id = plan.root_task_id
  WHERE plan.plan_id = NEW.plan_id
    AND proposal.digest = NEW.digest
    AND root.task_revision = NEW.root_task_revision_after
    AND (
      (plan.current_revision = NEW.revision AND plan.state = 'draft') OR
      (plan.current_revision = NEW.revision - 1
        AND plan.state IN ('approved', 'running', 'paused', 'review')
        AND EXISTS (
          SELECT 1 FROM execution_plan_supersession_activations activation
          WHERE activation.operation_id = NEW.operation_id
            AND activation.plan_id = NEW.plan_id
            AND activation.base_revision = plan.current_revision
            AND activation.candidate_revision = NEW.revision
            AND activation.candidate_digest = NEW.digest
            AND activation.root_task_revision_before =
              NEW.root_task_revision_before
            AND activation.authority_member_id = NEW.reviewed_by_member_id
        ))
    )
    AND ((NEW.decision = 'rejected'
      AND json_array_length(NEW.compiled_tasks_json) = 0
      AND NOT EXISTS (
        SELECT 1 FROM execution_plan_nodes
        WHERE plan_id = NEW.plan_id AND revision = NEW.revision
      )) OR (NEW.decision = 'approved'
      AND json_array_length(NEW.compiled_tasks_json) =
        json_array_length(proposal.definition_json, '$.nodes')
      AND (SELECT count(*) FROM execution_plan_nodes
        WHERE plan_id = NEW.plan_id AND revision = NEW.revision) =
        json_array_length(proposal.definition_json, '$.nodes')
      AND (SELECT count(*) FROM execution_plan_edges
        WHERE plan_id = NEW.plan_id AND revision = NEW.revision) =
        json_array_length(proposal.definition_json, '$.edges')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(proposal.definition_json, '$.nodes') expected
        WHERE NOT EXISTS (
          SELECT 1 FROM execution_plan_nodes node
          JOIN execution_plan_task_claims claim ON claim.task_id = node.task_id
            AND claim.plan_id = node.plan_id
            AND claim.revision = node.revision
            AND claim.node_key = node.node_key
          JOIN json_each(NEW.compiled_tasks_json) pin
            ON json_extract(pin.value, '$.nodeKey') = node.node_key
          WHERE node.plan_id = NEW.plan_id AND node.revision = NEW.revision
            AND node.node_json = expected.value
            AND node.task_id = json_extract(pin.value, '$.taskId')
            AND node.task_revision = json_extract(pin.value, '$.taskRevision')
            AND node.definition_revision =
              json_extract(pin.value, '$.definitionRevision')
            AND node.criteria_revision =
              json_extract(pin.value, '$.criteriaRevision')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(proposal.definition_json, '$.edges') expected
        WHERE NOT EXISTS (
          SELECT 1 FROM execution_plan_edges edge
          WHERE edge.plan_id = NEW.plan_id AND edge.revision = NEW.revision
            AND edge.edge_json = expected.value
        )
      )))
)
BEGIN SELECT RAISE(ABORT, 'Execution approval requires its exact atomic compilation'); END;

DROP TRIGGER execution_claim_immutable_update;
CREATE TRIGGER execution_claim_supersession_update
BEFORE UPDATE ON execution_plan_task_claims
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plan_supersession_activations activation
  JOIN execution_plan_nodes old_node
    ON old_node.plan_id = activation.plan_id
    AND old_node.revision = activation.base_revision
    AND old_node.task_id = OLD.task_id
  JOIN execution_plan_nodes new_node
    ON new_node.plan_id = activation.plan_id
    AND new_node.revision = activation.candidate_revision
    AND new_node.task_id = OLD.task_id
  WHERE OLD.plan_id = activation.plan_id
    AND OLD.revision = activation.base_revision
    AND OLD.node_key = old_node.node_key
    AND NEW.task_id = OLD.task_id
    AND NEW.plan_id = OLD.plan_id
    AND NEW.revision = activation.candidate_revision
    AND NEW.node_key = new_node.node_key
)
BEGIN SELECT RAISE(ABORT, 'Execution Task claims require exact supersession'); END;

CREATE TRIGGER execution_plan_supersession_current_update
BEFORE UPDATE OF current_revision ON execution_plans
WHEN OLD.state IN ('approved', 'running', 'paused', 'review')
  AND NEW.current_revision IS NOT OLD.current_revision
  AND NOT EXISTS (
  SELECT 1 FROM execution_plan_supersession_activations activation
  JOIN execution_plan_approvals approval
    ON approval.operation_id = activation.operation_id
    AND approval.plan_id = activation.plan_id
    AND approval.revision = activation.candidate_revision
    AND approval.decision = 'approved'
  WHERE activation.plan_id = OLD.plan_id
    AND activation.base_revision = OLD.current_revision
    AND activation.base_control_revision = OLD.control_revision
    AND activation.candidate_revision = NEW.current_revision
    AND NEW.control_revision = OLD.control_revision + 1
)
BEGIN SELECT RAISE(ABORT, 'Execution plan revision requires exact supersession'); END;

CREATE TRIGGER execution_carried_adoptions_require_scope_insert
BEFORE INSERT ON execution_carried_evidence_adoptions
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans plan
  JOIN execution_plan_supersession_activations activation
    ON activation.plan_id = plan.plan_id
    AND activation.candidate_revision = plan.current_revision
    AND activation.operation_id = json_extract(
      NEW.adoption_json, '$.authority.approvalOperationId'
    )
  JOIN execution_plan_approvals approval
    ON approval.operation_id = activation.operation_id
    AND approval.revision = NEW.plan_revision
    AND approval.digest = json_extract(NEW.adoption_json,
      '$.authority.planDigest')
  JOIN execution_plan_nodes node
    ON node.plan_id = NEW.plan_id AND node.revision = NEW.plan_revision
    AND node.node_key = NEW.node_key
  JOIN (
    SELECT adoption_id, adoption_digest, source_evidence_id, source_digest,
      gate, proof_set_digest
    FROM execution_evidence_adoptions
    UNION ALL
    SELECT adoption_id, adoption_digest, source_evidence_id, source_digest,
      gate, proof_set_digest
    FROM execution_carried_evidence_adoptions
  ) source ON source.adoption_id = NEW.source_adoption_id
    AND source.adoption_id = json_extract(NEW.adoption_json,
      '$.authority.sourceAdoptionId')
    AND source.adoption_digest = json_extract(NEW.adoption_json,
      '$.authority.sourceAdoptionDigest')
    AND source.source_evidence_id = NEW.source_evidence_id
    AND source.source_digest = NEW.source_digest
    AND source.gate = NEW.gate
    AND source.proof_set_digest = NEW.proof_set_digest
  JOIN (
    SELECT adoption_id, reuse_contract_id
    FROM execution_evidence_reuse_contracts
    UNION ALL
    SELECT adoption_id, reuse_contract_id
    FROM execution_carried_evidence_reuse_contracts
  ) source_reuse ON source_reuse.adoption_id = source.adoption_id
    AND source_reuse.reuse_contract_id = json_extract(NEW.adoption_json,
      '$.authority.sourceReuseContractId')
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND json_extract(NEW.adoption_json, '$.authority.service') =
      'execution_supersession'
    AND json_extract(NEW.adoption_json, '$.authority.roomId') = plan.room_id
    AND json_extract(NEW.adoption_json, '$.authority.taskId') = node.task_id
    AND json_extract(NEW.adoption_json, '$.authority.definitionRevision') =
      node.definition_revision
    AND json_extract(NEW.adoption_json, '$.authority.criteriaRevision') =
      node.criteria_revision
    AND NOT EXISTS (
      SELECT 1 FROM execution_evidence_adoptions local
      WHERE local.plan_id = NEW.plan_id AND local.plan_revision = NEW.plan_revision
        AND local.node_key = NEW.node_key AND local.gate = NEW.gate
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_remote_evidence_adoptions remote
      WHERE remote.plan_id = NEW.plan_id
        AND remote.plan_revision = NEW.plan_revision
        AND remote.node_key = NEW.node_key AND remote.gate = NEW.gate
    )
)
BEGIN SELECT RAISE(ABORT, 'Carried EvidenceAdoption scope is invalid'); END;

CREATE TRIGGER execution_carried_reuse_require_scope_insert
BEFORE INSERT ON execution_carried_evidence_reuse_contracts
WHEN NOT EXISTS (
  SELECT 1 FROM execution_carried_evidence_adoptions adoption
  JOIN (
    SELECT reuse_contract_id, reuse_input_evidence_digest,
      node_reuse_contract_digest
    FROM execution_evidence_reuse_contracts
    UNION ALL
    SELECT reuse_contract_id, reuse_input_evidence_digest,
      node_reuse_contract_digest
    FROM execution_carried_evidence_reuse_contracts
  ) source ON source.reuse_contract_id = NEW.source_reuse_contract_id
  WHERE adoption.adoption_id = NEW.adoption_id
    AND adoption.adoption_digest = NEW.adoption_digest
    AND adoption.plan_id = NEW.plan_id
    AND adoption.plan_revision = NEW.plan_revision
    AND adoption.node_key = NEW.node_key
    AND adoption.gate = NEW.gate
    AND source.reuse_input_evidence_digest = NEW.reuse_input_evidence_digest
    AND source.node_reuse_contract_digest = NEW.node_reuse_contract_digest
    AND json_extract(NEW.contract_json, '$.reuseContractId') =
      NEW.reuse_contract_id
    AND json_extract(NEW.contract_json, '$.adoptionId') = NEW.adoption_id
    AND json_extract(NEW.contract_json, '$.contractDigest') =
      NEW.contract_digest
)
BEGIN SELECT RAISE(ABORT, 'Carried EvidenceReuseContract scope is invalid'); END;

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
)
UNION ALL
SELECT adoption.plan_id, adoption.plan_revision, adoption.node_key,
  adoption.gate,
  json_extract(adoption.adoption_json, '$.sourceExecution.dispatchGeneration'),
  json_extract(adoption.adoption_json, '$.sourceExecution.runId'),
  CASE WHEN json_extract(source.source_json, '$.kind') = 'task_result'
    THEN json_extract(source.source_json, '$.resultId')
    ELSE json_extract(companion.source_json, '$.resultId') END,
  CASE WHEN json_extract(source.source_json, '$.kind') = 'task_result'
    THEN json_extract(source.source_json, '$.resultVersion')
    ELSE json_extract(companion.source_json, '$.resultVersion') END,
  adoption.operation_id, adoption.adoption_digest,
  json_extract(source.source_json, '$.commit'),
  json_extract(source.source_json, '$.tree'),
  json_extract(source.source_json, '$.origin.checkpointId'),
  json_extract(source.source_json, '$.artifactPins'),
  adoption.adoption_id, adoption.adoption_digest,
  adoption.source_evidence_id, adoption.source_digest,
  node.task_id, node.definition_revision, node.criteria_revision
FROM execution_carried_evidence_adoptions adoption
JOIN execution_carried_evidence_reuse_contracts reuse
  ON reuse.adoption_id = adoption.adoption_id
  AND reuse.adoption_digest = adoption.adoption_digest
JOIN execution_source_evidence source
  ON source.source_evidence_id = adoption.source_evidence_id
  AND source.source_digest = adoption.source_digest
LEFT JOIN execution_source_evidence companion
  ON companion.source_evidence_id = json_extract(
    source.source_json, '$.origin.companionSourceEvidenceId'
  )
  AND companion.source_digest = json_extract(
    source.source_json, '$.origin.companionSourceDigest'
  )
JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
  AND node.revision = adoption.plan_revision
  AND node.node_key = adoption.node_key;

CREATE TRIGGER execution_supersession_candidates_immutable_update
BEFORE UPDATE ON execution_plan_supersession_candidates
BEGIN SELECT RAISE(ABORT, 'Execution supersession candidate is immutable'); END;
CREATE TRIGGER execution_supersession_candidates_immutable_delete
BEFORE DELETE ON execution_plan_supersession_candidates
BEGIN SELECT RAISE(ABORT, 'Execution supersession candidate is retained'); END;
CREATE TRIGGER execution_replan_delegations_immutable_update
BEFORE UPDATE ON execution_replan_delegations
BEGIN SELECT RAISE(ABORT, 'Execution replan delegation is immutable'); END;
CREATE TRIGGER execution_replan_delegations_immutable_delete
BEFORE DELETE ON execution_replan_delegations
BEGIN SELECT RAISE(ABORT, 'Execution replan delegation is retained'); END;
CREATE TRIGGER execution_replan_revocations_immutable_update
BEFORE UPDATE ON execution_replan_delegation_revocations
BEGIN SELECT RAISE(ABORT, 'Execution replan revocation is immutable'); END;
CREATE TRIGGER execution_replan_revocations_immutable_delete
BEFORE DELETE ON execution_replan_delegation_revocations
BEGIN SELECT RAISE(ABORT, 'Execution replan revocation is retained'); END;
CREATE TRIGGER execution_supersession_activations_immutable_update
BEFORE UPDATE ON execution_plan_supersession_activations
BEGIN SELECT RAISE(ABORT, 'Execution supersession activation is immutable'); END;
CREATE TRIGGER execution_supersession_activations_immutable_delete
BEFORE DELETE ON execution_plan_supersession_activations
BEGIN SELECT RAISE(ABORT, 'Execution supersession activation is retained'); END;
CREATE TRIGGER execution_replan_consumptions_immutable_update
BEFORE UPDATE ON execution_replan_delegation_consumptions
BEGIN SELECT RAISE(ABORT, 'Execution replan consumption is immutable'); END;
CREATE TRIGGER execution_replan_consumptions_immutable_delete
BEFORE DELETE ON execution_replan_delegation_consumptions
BEGIN SELECT RAISE(ABORT, 'Execution replan consumption is retained'); END;
CREATE TRIGGER execution_supersession_receipts_immutable_update
BEFORE UPDATE ON execution_plan_supersession_receipts
BEGIN SELECT RAISE(ABORT, 'Execution supersession receipt is immutable'); END;
CREATE TRIGGER execution_supersession_receipts_immutable_delete
BEFORE DELETE ON execution_plan_supersession_receipts
BEGIN SELECT RAISE(ABORT, 'Execution supersession receipt is retained'); END;
CREATE TRIGGER execution_carried_adoptions_immutable_update
BEFORE UPDATE ON execution_carried_evidence_adoptions
BEGIN SELECT RAISE(ABORT, 'Carried EvidenceAdoption is immutable'); END;
CREATE TRIGGER execution_carried_adoptions_immutable_delete
BEFORE DELETE ON execution_carried_evidence_adoptions
BEGIN SELECT RAISE(ABORT, 'Carried EvidenceAdoption is retained authority'); END;
CREATE TRIGGER execution_carried_reuse_immutable_update
BEFORE UPDATE ON execution_carried_evidence_reuse_contracts
BEGIN SELECT RAISE(ABORT, 'Carried EvidenceReuseContract is immutable'); END;
CREATE TRIGGER execution_carried_reuse_immutable_delete
BEFORE DELETE ON execution_carried_evidence_reuse_contracts
BEGIN SELECT RAISE(ABORT, 'Carried EvidenceReuseContract is retained evidence'); END;
