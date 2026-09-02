CREATE TABLE execution_evidence_reuse_contracts (
  reuse_contract_id TEXT PRIMARY KEY CHECK (reuse_contract_id GLOB 'reuse_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  adoption_id TEXT NOT NULL UNIQUE REFERENCES execution_evidence_adoptions(
    adoption_id
  ) ON DELETE RESTRICT,
  adoption_digest TEXT NOT NULL CHECK (
    length(adoption_digest) = 64 AND adoption_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (
    gate IN ('accepted_result', 'verified_output', 'integrated_commit')
  ),
  runtime_input_binding_digest TEXT NOT NULL CHECK (
    length(runtime_input_binding_digest) = 64 AND
    runtime_input_binding_digest NOT GLOB '*[^0-9a-f]*'
  ),
  reuse_input_evidence_digest TEXT NOT NULL CHECK (
    length(reuse_input_evidence_digest) = 64 AND
    reuse_input_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  node_execution_digest TEXT NOT NULL CHECK (
    length(node_execution_digest) = 64 AND
    node_execution_digest NOT GLOB '*[^0-9a-f]*'
  ),
  node_reuse_contract_digest TEXT NOT NULL CHECK (
    length(node_reuse_contract_digest) = 64 AND
    node_reuse_contract_digest NOT GLOB '*[^0-9a-f]*'
  ),
  contract_digest TEXT NOT NULL UNIQUE CHECK (
    length(contract_digest) = 64 AND contract_digest NOT GLOB '*[^0-9a-f]*'
  ),
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

CREATE INDEX execution_evidence_reuse_contracts_reuse_idx
  ON execution_evidence_reuse_contracts(
    node_reuse_contract_digest, reuse_input_evidence_digest
  );

CREATE TRIGGER execution_evidence_reuse_contracts_require_scope_insert
BEFORE INSERT ON execution_evidence_reuse_contracts
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_evidence_adoptions adoption
  JOIN execution_plan_nodes node
    ON node.plan_id = adoption.plan_id
    AND node.revision = adoption.plan_revision
    AND node.node_key = adoption.node_key
  JOIN execution_plan_proposals proposal
    ON proposal.plan_id = adoption.plan_id
    AND proposal.revision = adoption.plan_revision
  WHERE adoption.adoption_id = NEW.adoption_id
    AND adoption.adoption_digest = NEW.adoption_digest
    AND adoption.plan_id = NEW.plan_id
    AND adoption.plan_revision = NEW.plan_revision
    AND adoption.node_key = NEW.node_key
    AND adoption.gate = NEW.gate
    AND adoption.resolved_input_set_digest = NEW.runtime_input_binding_digest
    AND adoption.node_contract_digest = NEW.node_execution_digest
    AND json(json_extract(NEW.contract_json, '$.node')) =
      json(json_remove(node.node_json, '$.task'))
    AND json(json_extract(NEW.contract_json, '$.task')) =
      json(json_remove(node.task_snapshot_json, '$.taskRevision'))
    AND json_extract(NEW.contract_json, '$.integrationPolicy.integration') =
      json_extract(proposal.definition_json, '$.policy.integration')
    AND json_extract(
      NEW.contract_json,
      '$.integrationPolicy.requireHumanIntegrationApproval'
    ) = json_extract(
      proposal.definition_json,
      '$.policy.requireHumanIntegrationApproval'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        NEW.contract_json,
        '$.integrationPolicy.integrationTargets'
      ) retained
      WHERE NOT EXISTS (
        SELECT 1
        FROM json_each(
          proposal.definition_json,
          '$.policy.integrationTargets'
        ) approved
        WHERE json(approved.value) = json(retained.value)
          AND json_extract(approved.value, '$.repositoryId') =
            json_extract(node.node_json, '$.repository.repositoryId')
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(
        proposal.definition_json,
        '$.policy.integrationTargets'
      ) approved
      WHERE json_extract(approved.value, '$.repositoryId') =
          json_extract(node.node_json, '$.repository.repositoryId')
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            NEW.contract_json,
            '$.integrationPolicy.integrationTargets'
          ) retained
          WHERE json(retained.value) = json(approved.value)
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'EvidenceReuseContract scope is invalid');
END;

CREATE TRIGGER execution_evidence_reuse_contracts_immutable_update
BEFORE UPDATE ON execution_evidence_reuse_contracts
BEGIN SELECT RAISE(ABORT, 'EvidenceReuseContract is immutable'); END;

CREATE TRIGGER execution_evidence_reuse_contracts_immutable_delete
BEFORE DELETE ON execution_evidence_reuse_contracts
BEGIN SELECT RAISE(ABORT, 'EvidenceReuseContract is retained evidence'); END;
