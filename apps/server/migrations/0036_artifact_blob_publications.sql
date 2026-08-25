CREATE TABLE artifact_contents (
  content_id TEXT PRIMARY KEY CHECK (content_id GLOB 'content_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
  storage_key TEXT NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 512 AND
    storage_key NOT GLOB '/*' AND storage_key NOT GLOB '*..*'
  ),
  sealed_at TEXT NOT NULL,
  UNIQUE (team_id, sha256, size_bytes),
  UNIQUE (team_id, storage_key)
) STRICT;

CREATE TABLE artifact_publications (
  publication_id TEXT PRIMARY KEY CHECK (publication_id GLOB 'publication_*'),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND
    request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 13 AND 133
  ),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  lease_id TEXT NOT NULL REFERENCES workspace_leases(lease_id) ON DELETE RESTRICT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  workspace_ref TEXT NOT NULL CHECK (
    length(workspace_ref) = 74 AND
    workspace_ref GLOB 'workspace_*' AND
    substr(workspace_ref, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_generation TEXT NOT NULL CHECK (
    length(workspace_generation) = 64 AND
    workspace_generation NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN ('patch', 'test_result', 'document')
  ),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL CHECK (
    media_type IN ('text/x-diff', 'text/markdown', 'application/json')
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 4194304),
  declared_sha256 TEXT NOT NULL CHECK (
    length(declared_sha256) = 64 AND
    declared_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  received_size INTEGER NOT NULL DEFAULT 0 CHECK (
    received_size BETWEEN 0 AND declared_size
  ),
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'receiving', 'sealed', 'bound', 'failed', 'expired')
  ),
  temp_storage_key TEXT NOT NULL CHECK (
    length(temp_storage_key) BETWEEN 1 AND 512 AND
    temp_storage_key NOT GLOB '/*' AND temp_storage_key NOT GLOB '*..*'
  ),
  content_id TEXT REFERENCES artifact_contents(content_id) ON DELETE RESTRICT,
  artifact_id TEXT REFERENCES task_artifact_refs(artifact_id) ON DELETE RESTRICT,
  failure_code TEXT CHECK (
    failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80
  ),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state IN ('prepared', 'receiving', 'failed', 'expired') AND
      content_id IS NULL AND artifact_id IS NULL) OR
    (state = 'sealed' AND content_id IS NOT NULL AND artifact_id IS NULL) OR
    (state = 'bound' AND content_id IS NOT NULL AND artifact_id IS NOT NULL)
  ),
  UNIQUE (device_id, idempotency_key)
) STRICT;

CREATE INDEX artifact_publications_team_state_idx
  ON artifact_publications(team_id, state, expires_at);

CREATE TRIGGER artifact_publications_require_lease_scope_insert
BEFORE INSERT ON artifact_publications
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_leases lease
  WHERE lease.lease_id = NEW.lease_id
    AND lease.team_id = NEW.team_id
    AND lease.room_id = NEW.room_id
    AND lease.task_id = NEW.task_id
    AND lease.run_id = NEW.run_id
    AND lease.agent_id = NEW.agent_id
    AND lease.device_id = NEW.device_id
    AND lease.workspace_ref = NEW.workspace_ref
    AND lease.workspace_generation = NEW.workspace_generation
    AND lease.mode = 'read_source'
)
BEGIN
  SELECT RAISE(ABORT, 'Artifact publication lease scope is invalid');
END;

CREATE TRIGGER artifact_contents_immutable_update
BEFORE UPDATE ON artifact_contents
BEGIN
  SELECT RAISE(ABORT, 'Artifact contents are immutable');
END;

CREATE TRIGGER artifact_contents_immutable_delete
BEFORE DELETE ON artifact_contents
BEGIN
  SELECT RAISE(ABORT, 'Artifact contents require retention collection');
END;

CREATE TRIGGER artifact_publications_immutable_delete
BEFORE DELETE ON artifact_publications
BEGIN
  SELECT RAISE(ABORT, 'Artifact publications are retained evidence');
END;
