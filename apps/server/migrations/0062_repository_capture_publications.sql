-- convenewire:migration foreign_keys=off

CREATE TABLE repository_capture_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  isolated_lease_id TEXT NOT NULL REFERENCES isolated_workspace_leases(lease_id) ON DELETE RESTRICT,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  expected_generation TEXT NOT NULL CHECK (length(expected_generation) = 64),
  issued_at TEXT NOT NULL,
  UNIQUE (isolated_lease_id, expected_generation),
  CHECK (json_extract(request_json, '$.operationId') IS operation_id),
  CHECK (json_extract(request_json, '$.requestDigest') IS request_digest),
  CHECK (json_extract(request_json, '$.expectedGeneration') IS expected_generation),
  CHECK (json_extract(request_json, '$.action.kind') IS 'capture'),
  CHECK (json_extract(request_json, '$.action.capture.manifestDigest') IS manifest_digest)
) STRICT;

CREATE TRIGGER repository_capture_scope_insert BEFORE INSERT ON repository_capture_operations
WHEN NOT EXISTS (
  SELECT 1 FROM isolated_workspace_leases lease
  WHERE lease.lease_id = NEW.isolated_lease_id AND lease.manifest_digest = NEW.manifest_digest
    AND lease.run_id = json_extract(NEW.request_json, '$.execution.runId')
    AND lease.device_id = json_extract(NEW.request_json, '$.deviceId')
    AND lease.plan_id = json_extract(NEW.request_json, '$.plan.planId')
    AND lease.plan_revision = json_extract(NEW.request_json, '$.plan.revision')
    AND NEW.expected_generation = COALESCE((SELECT generation FROM isolated_workspace_operations
      WHERE lease_id = lease.lease_id ORDER BY revision DESC LIMIT 1), lease.initial_generation)
    AND NOT EXISTS (SELECT 1 FROM isolated_workspace_operations
      WHERE lease_id = lease.lease_id AND kind IN ('revoke', 'release'))
)
BEGIN SELECT RAISE(ABORT, 'Repository capture scope is invalid'); END;
CREATE TRIGGER repository_capture_immutable_update BEFORE UPDATE ON repository_capture_operations
BEGIN SELECT RAISE(ABORT, 'Repository capture operations are immutable'); END;
CREATE TRIGGER repository_capture_immutable_delete BEFORE DELETE ON repository_capture_operations
BEGIN SELECT RAISE(ABORT, 'Repository capture operations are retained'); END;

CREATE TABLE workspace_leases_v2 (
  lease_id TEXT PRIMARY KEY CHECK (lease_id GLOB 'lease_*'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  workspace_ref TEXT NOT NULL CHECK (length(workspace_ref) = 74 AND workspace_ref GLOB 'workspace_*'
    AND substr(workspace_ref, 11) NOT GLOB '*[^0-9a-f]*'),
  workspace_generation TEXT NOT NULL CHECK (length(workspace_generation) = 64
    AND workspace_generation NOT GLOB '*[^0-9a-f]*'),
  mode TEXT NOT NULL CHECK (mode IN ('read_source', 'read_capture')),
  capture_operation_id TEXT UNIQUE REFERENCES repository_capture_operations(operation_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  CHECK ((state = 'active' AND released_at IS NULL) OR (state = 'released' AND released_at IS NOT NULL)),
  CHECK ((mode = 'read_source' AND capture_operation_id IS NULL)
    OR (mode = 'read_capture' AND capture_operation_id IS NOT NULL)),
  UNIQUE (device_id, idempotency_key)
) STRICT;

INSERT INTO workspace_leases_v2 SELECT lease_id, idempotency_key, team_id, room_id, task_id,
  run_id, agent_id, device_id, workspace_ref, workspace_generation, mode, NULL,
  state, issued_at, expires_at, released_at FROM workspace_leases;

DROP TRIGGER artifact_publications_require_lease_scope_insert;
DROP TABLE workspace_leases;
ALTER TABLE workspace_leases_v2 RENAME TO workspace_leases;
CREATE INDEX workspace_leases_run_state_idx ON workspace_leases(run_id, state, expires_at);

CREATE TRIGGER workspace_leases_require_scope_insert BEFORE INSERT ON workspace_leases
WHEN NOT (
  (NEW.mode = 'read_source' AND EXISTS (
    SELECT 1 FROM runs r JOIN agent_tasks t ON t.task_id = r.task_id AND t.room_id = r.room_id
    JOIN agents a ON a.agent_id = r.target_agent_id JOIN devices d ON d.device_id = a.device_id
    JOIN rooms room ON room.room_id = r.room_id
    WHERE r.run_id = NEW.run_id AND r.room_id = NEW.room_id AND r.task_id = NEW.task_id
      AND r.target_agent_id = NEW.agent_id AND a.device_id = NEW.device_id
      AND a.team_id = NEW.team_id AND d.team_id = NEW.team_id AND room.team_id = NEW.team_id
      AND a.workspace_ref = NEW.workspace_ref AND a.workspace_generation = NEW.workspace_generation
      AND json_type(r.context_manifest_json, '$.execution') IS NULL
  )) OR (NEW.mode = 'read_capture' AND EXISTS (
    SELECT 1 FROM repository_capture_operations op
    JOIN isolated_workspace_leases lease ON lease.lease_id = op.isolated_lease_id
    WHERE op.operation_id = NEW.capture_operation_id
      AND lease.team_id = NEW.team_id AND lease.room_id = NEW.room_id AND lease.task_id = NEW.task_id
      AND lease.run_id = NEW.run_id AND lease.agent_id = NEW.agent_id AND lease.device_id = NEW.device_id
      AND lease.workspace_ref = NEW.workspace_ref AND op.expected_generation = NEW.workspace_generation
      AND NEW.issued_at = op.issued_at AND NEW.expires_at = json_extract(op.request_json, '$.deadline')
  ))
)
BEGIN SELECT RAISE(ABORT, 'Workspace lease scope is invalid'); END;

CREATE TRIGGER workspace_leases_restrict_update BEFORE UPDATE ON workspace_leases
WHEN NEW.lease_id <> OLD.lease_id OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.team_id <> OLD.team_id OR NEW.room_id <> OLD.room_id OR NEW.task_id <> OLD.task_id
  OR NEW.run_id <> OLD.run_id OR NEW.agent_id <> OLD.agent_id OR NEW.device_id <> OLD.device_id
  OR NEW.workspace_ref <> OLD.workspace_ref OR NEW.workspace_generation <> OLD.workspace_generation
  OR NEW.mode <> OLD.mode OR NEW.capture_operation_id IS NOT OLD.capture_operation_id
  OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
  OR OLD.state <> 'active' OR NEW.state <> 'released' OR NEW.released_at IS NULL
BEGIN SELECT RAISE(ABORT, 'Workspace lease update is invalid'); END;
CREATE TRIGGER workspace_leases_immutable_delete BEFORE DELETE ON workspace_leases
BEGIN SELECT RAISE(ABORT, 'Workspace leases are retained evidence'); END;

CREATE TRIGGER artifact_publications_require_lease_scope_insert BEFORE INSERT ON artifact_publications
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_leases lease WHERE lease.lease_id = NEW.lease_id
    AND lease.team_id = NEW.team_id AND lease.room_id = NEW.room_id AND lease.task_id = NEW.task_id
    AND lease.run_id = NEW.run_id AND lease.agent_id = NEW.agent_id AND lease.device_id = NEW.device_id
    AND lease.workspace_ref = NEW.workspace_ref AND lease.workspace_generation = NEW.workspace_generation
    AND lease.mode IN ('read_source', 'read_capture')
)
BEGIN SELECT RAISE(ABORT, 'Artifact publication lease scope is invalid'); END;

CREATE TABLE repository_checkpoints (
  checkpoint_id TEXT PRIMARY KEY CHECK (checkpoint_id GLOB 'checkpoint_*'),
  operation_id TEXT NOT NULL UNIQUE REFERENCES repository_capture_operations(operation_id) ON DELETE RESTRICT,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  recorded_at TEXT NOT NULL,
  CHECK (json_extract(checkpoint_json, '$.checkpointId') IS checkpoint_id),
  CHECK (json_extract(checkpoint_json, '$.operationId') IS operation_id),
  CHECK (json_extract(checkpoint_json, '$.digest') IS digest)
) STRICT;
CREATE TRIGGER repository_checkpoint_scope_insert BEFORE INSERT ON repository_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM repository_capture_operations op JOIN isolated_workspace_leases lease
    ON lease.lease_id = op.isolated_lease_id
  WHERE op.operation_id = NEW.operation_id
    AND json(json_extract(op.request_json, '$.execution')) = json(json_extract(NEW.checkpoint_json, '$.scope'))
    AND json_extract(NEW.checkpoint_json, '$.workspaceRef') IS lease.workspace_ref
    AND json_extract(NEW.checkpoint_json, '$.workspaceGeneration') IS op.expected_generation
    AND json_extract(NEW.checkpoint_json, '$.repositoryId') IS json_extract(op.request_json, '$.repositoryId')
    AND json_extract(NEW.checkpoint_json, '$.bindingId') IS json_extract(op.request_json, '$.bindingId')
)
BEGIN SELECT RAISE(ABORT, 'Repository checkpoint scope is invalid'); END;
CREATE TRIGGER repository_checkpoint_canonical_insert BEFORE INSERT ON repository_checkpoints
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.checkpoint_json, '$.outputs') output WHERE NOT EXISTS (
    SELECT 1 FROM workspace_leases lease
    JOIN artifact_publications publication ON publication.lease_id = lease.lease_id AND publication.state = 'bound'
    JOIN task_artifact_refs artifact ON artifact.artifact_id = publication.artifact_id
    WHERE lease.capture_operation_id = NEW.operation_id
      AND artifact.artifact_id = json_extract(output.value, '$.artifact.artifactId')
      AND artifact.artifact_revision = json_extract(output.value, '$.artifact.artifactRevision')
      AND publication.declared_sha256 = json_extract(output.value, '$.artifact.contentDigest')
      AND publication.declared_size = json_extract(output.value, '$.artifact.byteLength')
      AND publication.artifact_type = json_extract(output.value, '$.artifact.kind')
  )
)
BEGIN SELECT RAISE(ABORT, 'Repository checkpoint output is not canonical'); END;
CREATE TRIGGER repository_checkpoints_immutable_update BEFORE UPDATE ON repository_checkpoints
BEGIN SELECT RAISE(ABORT, 'Repository checkpoints are immutable'); END;
CREATE TRIGGER repository_checkpoints_immutable_delete BEFORE DELETE ON repository_checkpoints
BEGIN SELECT RAISE(ABORT, 'Repository checkpoints are retained'); END;

CREATE TABLE repository_checkpoint_outputs (
  checkpoint_id TEXT NOT NULL REFERENCES repository_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  slot_key TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES task_artifact_refs(artifact_id) ON DELETE RESTRICT,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 0),
  PRIMARY KEY (checkpoint_id, slot_key),
  UNIQUE (checkpoint_id, artifact_id)
) STRICT;
CREATE TRIGGER repository_checkpoint_output_scope_insert BEFORE INSERT ON repository_checkpoint_outputs
WHEN NOT EXISTS (
  SELECT 1 FROM repository_checkpoints checkpoint
  JOIN workspace_leases lease ON lease.capture_operation_id = checkpoint.operation_id
  JOIN artifact_publications publication ON publication.lease_id = lease.lease_id AND publication.state = 'bound'
  JOIN task_artifact_refs artifact ON artifact.artifact_id = publication.artifact_id
  JOIN json_each(checkpoint.checkpoint_json, '$.outputs') output
  WHERE checkpoint.checkpoint_id = NEW.checkpoint_id AND artifact.artifact_id = NEW.artifact_id
    AND artifact.artifact_revision = NEW.artifact_revision
    AND json_extract(output.value, '$.slotKey') IS NEW.slot_key
    AND json_extract(output.value, '$.artifact.artifactId') IS NEW.artifact_id
    AND json_extract(output.value, '$.artifact.artifactRevision') IS NEW.artifact_revision
    AND json_extract(output.value, '$.artifact.contentDigest') IS publication.declared_sha256
    AND json_extract(output.value, '$.artifact.byteLength') IS publication.declared_size
    AND json_extract(output.value, '$.artifact.kind') IS publication.artifact_type
)
BEGIN SELECT RAISE(ABORT, 'Repository checkpoint output is not canonical'); END;
CREATE TRIGGER repository_checkpoint_outputs_immutable_update BEFORE UPDATE ON repository_checkpoint_outputs
BEGIN SELECT RAISE(ABORT, 'Repository checkpoint outputs are immutable'); END;
CREATE TRIGGER repository_checkpoint_outputs_immutable_delete BEFORE DELETE ON repository_checkpoint_outputs
BEGIN SELECT RAISE(ABORT, 'Repository checkpoint outputs are retained'); END;
