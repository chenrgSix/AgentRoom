CREATE TABLE remote_evidence_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  kind TEXT NOT NULL CHECK (kind IN ('commit_observation', 'ci_observation')),
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
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
  observation_id TEXT,
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
  CHECK (json_extract(request_json, '$.expectedPlanDigest') = expected_plan_digest),
  CHECK (json_extract(request_json, '$.expectedControlRevision') = expected_control_revision),
  CHECK (
    (state = 'planned' AND observation_id IS NULL AND error_code IS NULL) OR
    (state = 'outcome_unknown' AND error_code IS NOT NULL) OR
    (state = 'succeeded' AND observation_id IS NOT NULL AND error_code IS NULL) OR
    (state = 'failed' AND error_code IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER remote_evidence_operations_require_scope_insert
BEFORE INSERT ON remote_evidence_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM remote_provider_bindings binding
  JOIN team_members actor ON actor.member_id = NEW.actor_member_id
  JOIN rooms room ON room.team_id = binding.team_id
  JOIN execution_plans plan ON plan.plan_id = NEW.plan_id
    AND plan.room_id = room.room_id
  JOIN execution_plan_approvals approval ON approval.plan_id = plan.plan_id
    AND approval.revision = NEW.plan_revision
    AND approval.decision = 'approved'
  JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
    AND node.revision = NEW.plan_revision
    AND node.node_key = NEW.node_key
  WHERE binding.provider_binding_id = NEW.provider_binding_id
    AND actor.team_id = binding.team_id AND actor.role = 'owner'
    AND plan.state IN ('approved', 'running')
    AND plan.current_revision = NEW.plan_revision
    AND plan.current_digest = NEW.expected_plan_digest
    AND plan.control_revision = NEW.expected_control_revision
    AND approval.digest = NEW.expected_plan_digest
    AND json_extract(node.node_json, '$.repository.repositoryId') =
      binding.repository_id
    AND NOT EXISTS (
      SELECT 1 FROM remote_provider_binding_revocations revocation
      WHERE revocation.provider_binding_id = binding.provider_binding_id
    )
)
BEGIN SELECT RAISE(ABORT, 'Remote evidence operation scope is invalid'); END;

CREATE TRIGGER remote_evidence_operations_preserve_identity
BEFORE UPDATE ON remote_evidence_operations
WHEN NEW.operation_id <> OLD.operation_id OR NEW.kind <> OLD.kind OR
  NEW.provider_binding_id <> OLD.provider_binding_id OR
  NEW.plan_id <> OLD.plan_id OR NEW.plan_revision <> OLD.plan_revision OR
  NEW.node_key <> OLD.node_key OR
  NEW.expected_plan_digest <> OLD.expected_plan_digest OR
  NEW.expected_control_revision <> OLD.expected_control_revision OR
  NEW.actor_member_id <> OLD.actor_member_id OR
  NEW.request_digest <> OLD.request_digest OR
  json(NEW.request_json) <> json(OLD.request_json) OR
  NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'Remote evidence operation identity is immutable'); END;

CREATE TRIGGER remote_evidence_operations_state_transition
BEFORE UPDATE ON remote_evidence_operations
WHEN NOT (
  (OLD.state = 'planned' AND NEW.state IN (
    'planned', 'outcome_unknown', 'succeeded', 'failed'
  )) OR
  (OLD.state = 'outcome_unknown' AND NEW.state IN (
    'outcome_unknown', 'succeeded', 'failed'
  )) OR
  (OLD.state = NEW.state AND OLD.observation_id IS NEW.observation_id AND
    OLD.error_code IS NEW.error_code)
)
BEGIN SELECT RAISE(ABORT, 'Remote evidence operation transition is invalid'); END;

CREATE TRIGGER remote_evidence_operations_immutable_delete
BEFORE DELETE ON remote_evidence_operations
BEGIN SELECT RAISE(ABORT, 'Remote evidence operation is retained'); END;

CREATE TABLE remote_artifact_imports (
  import_id TEXT PRIMARY KEY CHECK (import_id GLOB 'import_*'),
  operation_id TEXT NOT NULL REFERENCES remote_evidence_operations(operation_id)
    ON DELETE RESTRICT,
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL UNIQUE CHECK (artifact_id GLOB 'artifact_*'),
  content_id TEXT NOT NULL REFERENCES artifact_contents(content_id)
    ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('commit_bundle', 'patch')),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 4194304),
  media_type TEXT NOT NULL CHECK (
    (kind = 'commit_bundle' AND media_type = 'application/x-git-bundle') OR
    (kind = 'patch' AND media_type = 'text/x-diff')
  ),
  imported_at TEXT NOT NULL,
  UNIQUE (operation_id, kind)
) STRICT;

CREATE TRIGGER remote_artifact_imports_require_scope_insert
BEFORE INSERT ON remote_artifact_imports
WHEN NOT EXISTS (
  SELECT 1 FROM remote_evidence_operations operation
  JOIN artifact_contents content ON content.content_id = NEW.content_id
  JOIN remote_provider_bindings binding
    ON binding.provider_binding_id = operation.provider_binding_id
  JOIN rooms room ON room.team_id = binding.team_id
  JOIN execution_plans plan ON plan.plan_id = operation.plan_id
    AND plan.room_id = room.room_id
  WHERE operation.operation_id = NEW.operation_id
    AND operation.kind = 'commit_observation'
    AND operation.state IN ('planned', 'outcome_unknown')
    AND operation.provider_binding_id = NEW.provider_binding_id
    AND content.team_id = binding.team_id
    AND content.sha256 = NEW.content_digest
    AND content.size_bytes = NEW.byte_length
    AND NOT EXISTS (
      SELECT 1 FROM remote_provider_binding_revocations revocation
      WHERE revocation.provider_binding_id = binding.provider_binding_id
    )
)
BEGIN SELECT RAISE(ABORT, 'Remote Artifact import scope is invalid'); END;

CREATE TRIGGER remote_artifact_imports_immutable_update
BEFORE UPDATE ON remote_artifact_imports
BEGIN SELECT RAISE(ABORT, 'Remote Artifact import is immutable'); END;

CREATE TRIGGER remote_artifact_imports_immutable_delete
BEFORE DELETE ON remote_artifact_imports
BEGIN SELECT RAISE(ABORT, 'Remote Artifact import is retained'); END;

DROP TRIGGER task_artifact_refs_require_content_binding_insert;
CREATE TRIGGER task_artifact_refs_require_content_binding_insert
BEFORE INSERT ON task_artifact_refs
WHEN NOT (
  (
    NEW.content_mode = 'reference_only' AND
    NEW.content_id IS NULL AND NEW.content_publication_id IS NULL AND
    NEW.content_size_bytes IS NULL AND NEW.content_media_type IS NULL AND
    NEW.content_sha256 IS NULL
  ) OR (
    NEW.content_mode = 'snapshot_blob' AND
    NEW.content_id IS NOT NULL AND NEW.content_publication_id IS NOT NULL AND
    NEW.content_size_bytes IS NOT NULL AND NEW.content_media_type IS NOT NULL AND
    NEW.content_sha256 IS NOT NULL AND
    (
      (NEW.artifact_type = 'patch' AND NEW.content_media_type = 'text/x-diff') OR
      (NEW.artifact_type = 'document' AND NEW.content_media_type = 'text/markdown') OR
      (NEW.artifact_type = 'test_result' AND NEW.content_media_type = 'application/json') OR
      (NEW.artifact_type = 'commit' AND
        NEW.content_media_type = 'application/x-git-bundle')
    ) AND EXISTS (
      SELECT 1 FROM artifact_contents content
      JOIN rooms room ON room.room_id = NEW.room_id
      WHERE content.content_id = NEW.content_id
        AND content.team_id = room.team_id
        AND content.size_bytes = NEW.content_size_bytes
        AND content.sha256 = NEW.content_sha256
    ) AND EXISTS (
      SELECT 1 FROM artifact_publications publication
      WHERE publication.publication_id = NEW.content_publication_id
        AND publication.state = 'sealed' AND publication.artifact_id IS NULL
        AND publication.content_id = NEW.content_id
        AND publication.task_id = NEW.task_id AND publication.room_id = NEW.room_id
        AND publication.run_id = NEW.source_run_id
        AND publication.agent_id = NEW.created_by_agent_id
        AND publication.workspace_ref = NEW.workspace_ref
        AND publication.artifact_type = NEW.artifact_type
        AND publication.file_name = NEW.path_ref
        AND publication.media_type = NEW.content_media_type
        AND publication.declared_size = NEW.content_size_bytes
        AND publication.declared_sha256 = NEW.content_sha256
    )
  ) OR (
    NEW.content_mode = 'snapshot_blob' AND NEW.content_id IS NOT NULL AND
    NEW.content_publication_id IS NULL AND NEW.content_size_bytes IS NOT NULL AND
    NEW.content_media_type IS NOT NULL AND NEW.content_sha256 IS NOT NULL AND
    NEW.source_run_id IS NULL AND NEW.created_by_member_id IS NOT NULL AND
    NEW.created_by_agent_id IS NULL AND NEW.workspace_ref IS NULL AND
    EXISTS (
      SELECT 1 FROM remote_artifact_imports import
      JOIN remote_evidence_operations operation
        ON operation.operation_id = import.operation_id
      JOIN execution_plan_nodes node ON node.plan_id = operation.plan_id
        AND node.revision = operation.plan_revision
        AND node.node_key = operation.node_key
      WHERE import.artifact_id = NEW.artifact_id
        AND import.content_id = NEW.content_id
        AND import.content_digest = NEW.content_sha256
        AND import.byte_length = NEW.content_size_bytes
        AND import.media_type = NEW.content_media_type
        AND NEW.task_id = node.task_id
        AND NEW.room_id = json_extract(operation.request_json, '$.roomId')
        AND NEW.repository_ref = json_extract(node.node_json,
          '$.repository.repositoryId')
        AND NEW.created_by_member_id = operation.actor_member_id
        AND ((import.kind = 'commit_bundle' AND NEW.artifact_type = 'commit') OR
          (import.kind = 'patch' AND NEW.artifact_type = 'patch'))
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'Artifact content binding is invalid'); END;

CREATE TABLE remote_commit_observations (
  operation_id TEXT PRIMARY KEY REFERENCES remote_evidence_operations(operation_id)
    ON DELETE RESTRICT,
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL UNIQUE CHECK (observation_id GLOB 'observation_*'),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  base_commit TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  candidate_tree TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  bundle_artifact_id TEXT NOT NULL UNIQUE REFERENCES task_artifact_refs(artifact_id)
    ON DELETE RESTRICT,
  patch_artifact_id TEXT NOT NULL UNIQUE REFERENCES task_artifact_refs(artifact_id)
    ON DELETE RESTRICT,
  provider_observation_digest TEXT NOT NULL UNIQUE CHECK (
    length(provider_observation_digest) = 64
  ),
  observation_digest TEXT NOT NULL UNIQUE CHECK (length(observation_digest) = 64),
  observation_json TEXT NOT NULL CHECK (
    json_valid(observation_json) AND json_type(observation_json) = 'object'
  ),
  observed_at TEXT NOT NULL,
  CHECK (json_extract(observation_json, '$.operationId') = operation_id),
  CHECK (json_extract(observation_json, '$.providerBindingId') = provider_binding_id),
  CHECK (json_extract(observation_json, '$.repositoryId') = repository_id),
  CHECK (json_extract(observation_json, '$.providerRepositoryId') =
    provider_repository_id),
  CHECK (json_extract(observation_json, '$.taskId') = task_id),
  CHECK (json_extract(observation_json, '$.observationId') = observation_id),
  CHECK (json_extract(observation_json, '$.objectFormat') = object_format),
  CHECK (json_extract(observation_json, '$.baseCommit') = base_commit),
  CHECK (json_extract(observation_json, '$.commit') = candidate_commit),
  CHECK (json_extract(observation_json, '$.tree') = candidate_tree),
  CHECK (json_extract(observation_json, '$.inputDigest') = input_digest),
  CHECK (json_extract(observation_json, '$.bundleArtifactId') = bundle_artifact_id),
  CHECK (json_extract(observation_json, '$.patchArtifactId') = patch_artifact_id),
  CHECK (json_extract(observation_json, '$.providerObservationDigest') =
    provider_observation_digest),
  CHECK (json_extract(observation_json, '$.observationDigest') =
    observation_digest),
  CHECK (json_extract(observation_json, '$.observedAt') = observed_at)
) STRICT;

CREATE TRIGGER remote_commit_observations_require_scope_insert
BEFORE INSERT ON remote_commit_observations
WHEN NOT EXISTS (
  SELECT 1 FROM remote_evidence_operations operation
  JOIN remote_provider_bindings binding
    ON binding.provider_binding_id = operation.provider_binding_id
  JOIN execution_plan_nodes node ON node.plan_id = operation.plan_id
    AND node.revision = operation.plan_revision AND node.node_key = operation.node_key
  JOIN task_artifact_refs bundle ON bundle.artifact_id = NEW.bundle_artifact_id
  JOIN task_artifact_refs patch ON patch.artifact_id = NEW.patch_artifact_id
  JOIN remote_artifact_imports bundle_import
    ON bundle_import.artifact_id = bundle.artifact_id
    AND bundle_import.kind = 'commit_bundle'
  JOIN remote_artifact_imports patch_import
    ON patch_import.artifact_id = patch.artifact_id
    AND patch_import.kind = 'patch'
  WHERE operation.operation_id = NEW.operation_id
    AND operation.kind = 'commit_observation'
    AND operation.state IN ('planned', 'outcome_unknown')
    AND operation.provider_binding_id = NEW.provider_binding_id
    AND binding.repository_id = NEW.repository_id
    AND binding.provider_repository_id = NEW.provider_repository_id
    AND node.task_id = NEW.task_id
    AND json_extract(node.node_json, '$.repository.baseCommit') = NEW.base_commit
    AND bundle.task_id = node.task_id AND patch.task_id = node.task_id
    AND bundle.commit_sha = NEW.candidate_commit
    AND patch.commit_sha = NEW.candidate_commit
    AND bundle_import.operation_id = operation.operation_id
    AND patch_import.operation_id = operation.operation_id
)
BEGIN SELECT RAISE(ABORT, 'Remote commit observation scope is invalid'); END;

CREATE TRIGGER remote_commit_observations_immutable_update
BEFORE UPDATE ON remote_commit_observations
BEGIN SELECT RAISE(ABORT, 'Remote commit observation is immutable'); END;

CREATE TRIGGER remote_commit_observations_immutable_delete
BEFORE DELETE ON remote_commit_observations
BEGIN SELECT RAISE(ABORT, 'Remote commit observation is retained evidence'); END;

CREATE TABLE execution_remote_source_evidence (
  source_evidence_id TEXT PRIMARY KEY CHECK (source_evidence_id GLOB 'source_*'),
  source_digest TEXT NOT NULL UNIQUE CHECK (length(source_digest) = 64),
  repository_id TEXT NOT NULL,
  observation_id TEXT NOT NULL UNIQUE REFERENCES remote_commit_observations(
    observation_id
  ) ON DELETE RESTRICT,
  candidate_commit TEXT NOT NULL,
  candidate_tree TEXT NOT NULL,
  artifact_pins_json TEXT NOT NULL CHECK (
    json_valid(artifact_pins_json) AND json_type(artifact_pins_json) = 'array'
  ),
  source_json TEXT NOT NULL CHECK (
    json_valid(source_json) AND json_type(source_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  CHECK (json_extract(source_json, '$.version') = 1),
  CHECK (json_extract(source_json, '$.sourceEvidenceId') = source_evidence_id),
  CHECK (json_extract(source_json, '$.kind') = 'repository_commit'),
  CHECK (json_extract(source_json, '$.sourceDigest') = source_digest),
  CHECK (json_extract(source_json, '$.repositoryId') = repository_id),
  CHECK (json_extract(source_json, '$.origin.kind') = 'remote_observation'),
  CHECK (json_extract(source_json, '$.origin.observationId') = observation_id),
  CHECK (json_extract(source_json, '$.commit') = candidate_commit),
  CHECK (json_extract(source_json, '$.tree') = candidate_tree),
  CHECK (
    json(json_extract(source_json, '$.artifactPins')) = json(artifact_pins_json)
  ),
  CHECK (json_extract(source_json, '$.createdAt') = created_at)
) STRICT;

CREATE TRIGGER execution_remote_source_evidence_require_scope_insert
BEFORE INSERT ON execution_remote_source_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM remote_commit_observations observation
  JOIN remote_provider_bindings binding
    ON binding.provider_binding_id = observation.provider_binding_id
  JOIN task_artifact_refs patch
    ON patch.artifact_id = observation.patch_artifact_id
  WHERE observation.observation_id = NEW.observation_id
    AND observation.repository_id = NEW.repository_id
    AND observation.candidate_commit = NEW.candidate_commit
    AND observation.candidate_tree = NEW.candidate_tree
    AND json_extract(NEW.source_json, '$.origin.providerBindingId') =
      binding.provider_binding_id
    AND json_extract(NEW.source_json, '$.origin.providerRepositoryId') =
      binding.provider_repository_id
    AND json_extract(NEW.source_json, '$.origin.observationDigest') =
      observation.observation_digest
    AND json_extract(NEW.source_json, '$.origin.commitBundleArtifactId') =
      observation.bundle_artifact_id
    AND json_array_length(NEW.artifact_pins_json) = 1
    AND json_extract(NEW.artifact_pins_json, '$[0].artifactId') = patch.artifact_id
    AND json_extract(NEW.artifact_pins_json, '$[0].artifactRevision') =
      patch.artifact_revision
    AND json_extract(NEW.artifact_pins_json, '$[0].contentDigest') =
      patch.content_sha256
    AND json_extract(NEW.artifact_pins_json, '$[0].byteLength') =
      patch.content_size_bytes
    AND json_extract(NEW.artifact_pins_json, '$[0].kind') = 'patch'
)
BEGIN SELECT RAISE(ABORT, 'Remote SourceEvidence scope is invalid'); END;

CREATE TRIGGER execution_remote_source_evidence_immutable_update
BEFORE UPDATE ON execution_remote_source_evidence
BEGIN SELECT RAISE(ABORT, 'Remote SourceEvidence is immutable'); END;

CREATE TRIGGER execution_remote_source_evidence_immutable_delete
BEFORE DELETE ON execution_remote_source_evidence
BEGIN SELECT RAISE(ABORT, 'Remote SourceEvidence is retained evidence'); END;

CREATE TABLE remote_ci_observation_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES remote_evidence_operations(operation_id)
    ON DELETE RESTRICT,
  provider_binding_id TEXT NOT NULL REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL REFERENCES execution_remote_source_evidence(
    source_evidence_id
  ) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL UNIQUE CHECK (observation_id GLOB 'observation_*'),
  check_key TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('passed', 'failed', 'timeout', 'canceled', 'outcome_unknown')
  ),
  candidate_commit TEXT NOT NULL,
  candidate_tree TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  profile_digest TEXT NOT NULL CHECK (length(profile_digest) = 64),
  provider_observation_digest TEXT NOT NULL UNIQUE CHECK (
    length(provider_observation_digest) = 64
  ),
  receipt_digest TEXT NOT NULL UNIQUE CHECK (length(receipt_digest) = 64),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json) AND json_type(receipt_json) = 'object'
  ),
  observed_at TEXT NOT NULL,
  CHECK (json_extract(receipt_json, '$.operationId') = operation_id),
  CHECK (json_extract(receipt_json, '$.providerBindingId') = provider_binding_id),
  CHECK (json_extract(receipt_json, '$.repositoryId') = repository_id),
  CHECK (json_extract(receipt_json, '$.sourceEvidenceId') = source_evidence_id),
  CHECK (json_extract(receipt_json, '$.observationId') = observation_id),
  CHECK (json_extract(receipt_json, '$.checkKey') = check_key),
  CHECK (json_extract(receipt_json, '$.attempt') = attempt),
  CHECK (json_extract(receipt_json, '$.outcome') = outcome),
  CHECK (json_extract(receipt_json, '$.commit') = candidate_commit),
  CHECK (json_extract(receipt_json, '$.tree') = candidate_tree),
  CHECK (json_extract(receipt_json, '$.profileId') = profile_id),
  CHECK (json_extract(receipt_json, '$.profileRevision') = profile_revision),
  CHECK (json_extract(receipt_json, '$.profileDigest') = profile_digest),
  CHECK (json_extract(receipt_json, '$.providerObservationDigest') =
    provider_observation_digest),
  CHECK (json_extract(receipt_json, '$.receiptDigest') = receipt_digest),
  CHECK (json_extract(receipt_json, '$.observedAt') = observed_at)
) STRICT;

CREATE TRIGGER remote_ci_receipts_require_scope_insert
BEFORE INSERT ON remote_ci_observation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM remote_evidence_operations operation
  JOIN remote_provider_bindings binding
    ON binding.provider_binding_id = operation.provider_binding_id
  JOIN execution_remote_source_evidence source
    ON source.source_evidence_id = NEW.source_evidence_id
  JOIN json_each(binding.ci_checks_json) check_mapping
    ON json_extract(check_mapping.value, '$.checkKey') = NEW.check_key
    AND json_extract(check_mapping.value, '$.profileId') = NEW.profile_id
    AND json_extract(check_mapping.value, '$.profileRevision') = NEW.profile_revision
    AND json_extract(check_mapping.value, '$.profileDigest') = NEW.profile_digest
  WHERE operation.operation_id = NEW.operation_id
    AND operation.kind = 'ci_observation'
    AND operation.state IN ('planned', 'outcome_unknown')
    AND operation.provider_binding_id = NEW.provider_binding_id
    AND binding.repository_id = NEW.repository_id
    AND source.repository_id = NEW.repository_id
    AND source.candidate_commit = NEW.candidate_commit
    AND source.candidate_tree = NEW.candidate_tree
    AND NOT EXISTS (
      SELECT 1 FROM remote_provider_binding_revocations revocation
      WHERE revocation.provider_binding_id = binding.provider_binding_id
    )
)
BEGIN SELECT RAISE(ABORT, 'Remote CI receipt scope is invalid'); END;

CREATE TRIGGER remote_ci_receipts_immutable_update
BEFORE UPDATE ON remote_ci_observation_receipts
BEGIN SELECT RAISE(ABORT, 'Remote CI receipt is immutable'); END;

CREATE TRIGGER remote_ci_receipts_immutable_delete
BEFORE DELETE ON remote_ci_observation_receipts
BEGIN SELECT RAISE(ABORT, 'Remote CI receipt is retained evidence'); END;

CREATE TABLE execution_remote_gate_proof_refs (
  proof_ref_id TEXT PRIMARY KEY CHECK (proof_ref_id GLOB 'proof_*'),
  operation_id TEXT NOT NULL UNIQUE REFERENCES remote_ci_observation_receipts(
    operation_id
  ) ON DELETE RESTRICT,
  proof_digest TEXT NOT NULL UNIQUE CHECK (length(proof_digest) = 64),
  proof_json TEXT NOT NULL CHECK (
    json_valid(proof_json) AND json_type(proof_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  CHECK (json_extract(proof_json, '$.kind') = 'ci_observation_receipt'),
  CHECK (json_extract(proof_json, '$.operationId') = operation_id),
  CHECK (json_extract(proof_json, '$.proofDigest') = proof_digest)
) STRICT;

CREATE TRIGGER execution_remote_gate_proof_require_scope_insert
BEFORE INSERT ON execution_remote_gate_proof_refs
WHEN NOT EXISTS (
  SELECT 1 FROM remote_ci_observation_receipts receipt
  WHERE receipt.operation_id = NEW.operation_id
    AND receipt.outcome = 'passed'
    AND receipt.receipt_digest = NEW.proof_digest
    AND json_extract(NEW.proof_json, '$.providerBindingId') =
      receipt.provider_binding_id
    AND json_extract(NEW.proof_json, '$.observationId') = receipt.observation_id
    AND json_extract(NEW.proof_json, '$.checkKey') = receipt.check_key
    AND json_extract(NEW.proof_json, '$.attempt') = receipt.attempt
)
BEGIN SELECT RAISE(ABORT, 'Remote GateProofRef scope is invalid'); END;

CREATE TRIGGER execution_remote_gate_proof_immutable_update
BEFORE UPDATE ON execution_remote_gate_proof_refs
BEGIN SELECT RAISE(ABORT, 'Remote GateProofRef is immutable'); END;

CREATE TRIGGER execution_remote_gate_proof_immutable_delete
BEFORE DELETE ON execution_remote_gate_proof_refs
BEGIN SELECT RAISE(ABORT, 'Remote GateProofRef is retained evidence'); END;
