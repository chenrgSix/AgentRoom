CREATE TABLE execution_input_bindings (
  binding_id TEXT PRIMARY KEY CHECK (binding_id GLOB 'input_*'),
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  node_key TEXT NOT NULL,
  destination_task_id TEXT NOT NULL,
  destination_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  destination_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  destination_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  input_slot TEXT NOT NULL CHECK (length(input_slot) BETWEEN 1 AND 64),
  source_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  source_result_id TEXT REFERENCES task_results(result_id) ON DELETE RESTRICT,
  source_artifact_id TEXT NOT NULL REFERENCES task_artifact_refs(artifact_id) ON DELETE RESTRICT,
  gate_operation_id TEXT NOT NULL CHECK (gate_operation_id GLOB 'op_*'),
  content_id TEXT REFERENCES artifact_contents(content_id) ON DELETE RESTRICT,
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  approval_operation_id TEXT NOT NULL REFERENCES execution_plan_approvals(operation_id) ON DELETE RESTRICT,
  control_revision INTEGER NOT NULL CHECK (control_revision > 0),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json) AND json_type(binding_json) = 'object'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (destination_run_id, input_slot),
  FOREIGN KEY (plan_id, revision, node_key, destination_task_id)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key, task_id) ON DELETE RESTRICT,
  CHECK (source_task_id <> destination_task_id),
  CHECK (json_extract(binding_json, '$.gate') IN ('accepted_result', 'verified_output', 'integrated_commit')),
  CHECK (json_extract(binding_json, '$.bindingId') IS binding_id),
  CHECK (json_extract(binding_json, '$.planId') IS plan_id),
  CHECK (json_extract(binding_json, '$.planRevision') IS revision),
  CHECK (json_extract(binding_json, '$.destinationRunId') IS destination_run_id),
  CHECK (json_extract(binding_json, '$.destinationTaskId') IS destination_task_id),
  CHECK (json_extract(binding_json, '$.destinationAgentId') IS destination_agent_id),
  CHECK (json_extract(binding_json, '$.destinationDeviceId') IS destination_device_id),
  CHECK (json_extract(binding_json, '$.inputSlot') IS input_slot),
  CHECK (json_extract(binding_json, '$.sourceTaskId') IS source_task_id),
  CHECK (json_extract(binding_json, '$.sourceResultId') IS source_result_id),
  CHECK (json_extract(binding_json, '$.artifact.artifactId') IS source_artifact_id),
  CHECK (json_extract(binding_json, '$.gateOperationId') IS gate_operation_id),
  CHECK (json_extract(binding_json, '$.issuedAt') IS issued_at),
  CHECK (json_extract(binding_json, '$.expiresAt') IS expires_at)
) STRICT;

CREATE INDEX execution_inputs_plan_idx ON execution_input_bindings(plan_id, revision, binding_id);

CREATE TRIGGER execution_input_require_scope_insert BEFORE INSERT ON execution_input_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM runs run
  JOIN execution_plan_approvals approval ON approval.operation_id = NEW.approval_operation_id
  JOIN task_results result ON result.result_id = NEW.source_result_id
  JOIN result_reviews review ON review.result_id = result.result_id
  JOIN result_evidence_refs evidence ON evidence.result_id = result.result_id
    AND evidence.evidence_kind = 'artifact' AND evidence.artifact_id = NEW.source_artifact_id
  JOIN task_artifact_refs artifact ON artifact.artifact_id = evidence.artifact_id
  WHERE json_extract(NEW.binding_json, '$.gate') = 'accepted_result'
    AND run.run_id = NEW.destination_run_id AND run.task_id = NEW.destination_task_id
    AND run.target_agent_id = NEW.destination_agent_id
    AND approval.plan_id = NEW.plan_id AND approval.revision = NEW.revision
    AND approval.digest = NEW.plan_digest AND approval.decision = 'approved'
    AND result.task_id = NEW.source_task_id AND result.room_id = run.room_id
    AND result.state = 'accepted' AND review.decision = 'accepted'
    AND review.operation_id = NEW.gate_operation_id
    AND artifact.task_id = result.task_id AND artifact.room_id = run.room_id
    AND artifact.content_mode = 'snapshot_blob' AND artifact.content_id = NEW.content_id
)
BEGIN SELECT RAISE(ABORT, 'Execution input source or destination scope is invalid'); END;

CREATE TRIGGER execution_input_immutable_update BEFORE UPDATE ON execution_input_bindings
BEGIN SELECT RAISE(ABORT, 'Execution input bindings are immutable'); END;

-- Independent verifier/integration proof writers remain unavailable until their
-- owning milestones replace the source admission trigger above. Nullable Result
-- and content pins reserve their distinct semantics; they do not admit a claim.
CREATE TABLE execution_artifact_input_sources (
  artifact_id TEXT NOT NULL REFERENCES task_artifact_refs(artifact_id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL REFERENCES execution_input_bindings(binding_id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, binding_id)
) STRICT;

CREATE TRIGGER execution_artifact_input_scope_insert BEFORE INSERT ON execution_artifact_input_sources
WHEN NOT EXISTS (
  SELECT 1 FROM task_artifact_refs artifact
  JOIN artifact_publications publication ON publication.publication_id = artifact.content_publication_id
    AND publication.state = 'sealed' AND publication.artifact_id IS NULL
  JOIN execution_input_bindings input ON input.binding_id = NEW.binding_id
    AND input.destination_task_id = artifact.task_id AND input.destination_run_id = artifact.source_run_id
    AND input.destination_agent_id = artifact.created_by_agent_id
    AND input.destination_device_id = publication.device_id
  WHERE artifact.artifact_id = NEW.artifact_id AND artifact.content_mode = 'snapshot_blob'
)
BEGIN SELECT RAISE(ABORT, 'Execution input provenance requires a new canonical destination Artifact'); END;
CREATE TRIGGER execution_artifact_input_immutable_update BEFORE UPDATE ON execution_artifact_input_sources
BEGIN SELECT RAISE(ABORT, 'Execution Artifact input provenance is immutable'); END;
CREATE TRIGGER execution_artifact_input_immutable_delete BEFORE DELETE ON execution_artifact_input_sources
BEGIN SELECT RAISE(ABORT, 'Execution Artifact input provenance is immutable'); END;
CREATE TRIGGER execution_input_immutable_delete BEFORE DELETE ON execution_input_bindings
BEGIN SELECT RAISE(ABORT, 'Execution input bindings are immutable'); END;
