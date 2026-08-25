ALTER TABLE task_artifact_refs
  ADD COLUMN content_mode TEXT NOT NULL DEFAULT 'reference_only'
    CHECK (content_mode IN ('reference_only', 'snapshot_blob'));

ALTER TABLE task_artifact_refs
  ADD COLUMN content_id TEXT REFERENCES artifact_contents(content_id)
    ON DELETE RESTRICT;

ALTER TABLE task_artifact_refs
  ADD COLUMN content_publication_id TEXT
    REFERENCES artifact_publications(publication_id) ON DELETE RESTRICT;

ALTER TABLE task_artifact_refs
  ADD COLUMN content_size_bytes INTEGER CHECK (
    content_size_bytes IS NULL OR content_size_bytes BETWEEN 1 AND 4194304
  );

ALTER TABLE task_artifact_refs
  ADD COLUMN content_media_type TEXT CHECK (
    content_media_type IS NULL OR content_media_type IN (
      'text/x-diff', 'text/markdown', 'application/json'
    )
  );

ALTER TABLE task_artifact_refs
  ADD COLUMN content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR (
      length(content_sha256) = 64 AND
      content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE TRIGGER task_artifact_refs_require_content_binding_insert
BEFORE INSERT ON task_artifact_refs
WHEN NOT (
  (
    NEW.content_mode = 'reference_only' AND
    NEW.content_id IS NULL AND
    NEW.content_publication_id IS NULL AND
    NEW.content_size_bytes IS NULL AND
    NEW.content_media_type IS NULL AND
    NEW.content_sha256 IS NULL
  ) OR
  (
    NEW.content_mode = 'snapshot_blob' AND
    NEW.content_id IS NOT NULL AND
    NEW.content_publication_id IS NOT NULL AND
    NEW.content_size_bytes IS NOT NULL AND
    NEW.content_media_type IS NOT NULL AND
    NEW.content_sha256 IS NOT NULL AND
    (
      (NEW.artifact_type = 'patch' AND
        NEW.content_media_type = 'text/x-diff') OR
      (NEW.artifact_type = 'document' AND
        NEW.content_media_type = 'text/markdown') OR
      (NEW.artifact_type = 'test_result' AND
        NEW.content_media_type = 'application/json')
    ) AND
    EXISTS (
      SELECT 1
      FROM artifact_contents content
      JOIN rooms room ON room.room_id = NEW.room_id
      WHERE content.content_id = NEW.content_id
        AND content.team_id = room.team_id
        AND content.size_bytes = NEW.content_size_bytes
        AND content.sha256 = NEW.content_sha256
    ) AND
    EXISTS (
      SELECT 1 FROM artifact_publications publication
      WHERE publication.publication_id = NEW.content_publication_id
        AND publication.state = 'sealed'
        AND publication.artifact_id IS NULL
        AND publication.content_id = NEW.content_id
        AND publication.task_id = NEW.task_id
        AND publication.room_id = NEW.room_id
        AND publication.run_id = NEW.source_run_id
        AND publication.agent_id = NEW.created_by_agent_id
        AND publication.workspace_ref = NEW.workspace_ref
        AND publication.artifact_type = NEW.artifact_type
        AND publication.file_name = NEW.path_ref
        AND publication.media_type = NEW.content_media_type
        AND publication.declared_size = NEW.content_size_bytes
        AND publication.declared_sha256 = NEW.content_sha256
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Artifact content binding is invalid');
END;

CREATE UNIQUE INDEX task_artifact_refs_content_publication_idx
  ON task_artifact_refs(content_publication_id)
  WHERE content_publication_id IS NOT NULL;

CREATE UNIQUE INDEX artifact_publications_bound_artifact_idx
  ON artifact_publications(artifact_id)
  WHERE artifact_id IS NOT NULL;

CREATE TRIGGER artifact_publications_restrict_identity_update
BEFORE UPDATE ON artifact_publications
WHEN
  NEW.publication_id <> OLD.publication_id OR
  NEW.request_fingerprint <> OLD.request_fingerprint OR
  NEW.idempotency_key <> OLD.idempotency_key OR
  NEW.team_id <> OLD.team_id OR
  NEW.device_id <> OLD.device_id OR
  NEW.lease_id <> OLD.lease_id OR
  NEW.room_id <> OLD.room_id OR
  NEW.task_id <> OLD.task_id OR
  NEW.run_id <> OLD.run_id OR
  NEW.agent_id <> OLD.agent_id OR
  NEW.workspace_ref <> OLD.workspace_ref OR
  NEW.workspace_generation <> OLD.workspace_generation OR
  NEW.artifact_type <> OLD.artifact_type OR
  NEW.file_name <> OLD.file_name OR
  NEW.media_type <> OLD.media_type OR
  NEW.title <> OLD.title OR
  NEW.summary <> OLD.summary OR
  NEW.declared_size <> OLD.declared_size OR
  NEW.declared_sha256 <> OLD.declared_sha256 OR
  NEW.temp_storage_key <> OLD.temp_storage_key OR
  NEW.expires_at <> OLD.expires_at OR
  NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'Artifact publication identity is immutable');
END;

CREATE TRIGGER artifact_publications_require_state_transition
BEFORE UPDATE ON artifact_publications
WHEN NOT (
  (
    OLD.state IN ('prepared', 'receiving') AND
    NEW.state = 'receiving' AND
    NEW.received_size > OLD.received_size AND
    NEW.content_id IS NULL AND NEW.artifact_id IS NULL AND
    NEW.failure_code IS NULL
  ) OR
  (
    OLD.state IN ('prepared', 'receiving') AND
    NEW.state = 'failed' AND
    NEW.received_size = OLD.received_size AND
    NEW.content_id IS NULL AND NEW.artifact_id IS NULL AND
    NEW.failure_code IS NOT NULL
  ) OR
  (
    OLD.state IN ('prepared', 'receiving') AND
    NEW.state = 'expired' AND
    NEW.received_size = OLD.received_size AND
    NEW.content_id IS NULL AND NEW.artifact_id IS NULL AND
    NEW.failure_code IS NULL
  ) OR
  (
    OLD.state IN ('prepared', 'receiving') AND
    NEW.state = 'sealed' AND
    NEW.received_size = NEW.declared_size AND
    NEW.content_id IS NOT NULL AND NEW.artifact_id IS NULL AND
    NEW.failure_code IS NULL
  ) OR
  (
    OLD.state = 'sealed' AND NEW.state = 'bound' AND
    NEW.received_size = OLD.received_size AND
    NEW.content_id IS OLD.content_id AND NEW.artifact_id IS NOT NULL AND
    NEW.failure_code IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Artifact publication state transition is invalid');
END;

CREATE TRIGGER artifact_publications_require_bound_scope_update
BEFORE UPDATE ON artifact_publications
WHEN NEW.state = 'bound' AND NOT EXISTS (
  SELECT 1 FROM task_artifact_refs artifact
  WHERE artifact.artifact_id = NEW.artifact_id
    AND artifact.task_id = NEW.task_id
    AND artifact.room_id = NEW.room_id
    AND artifact.artifact_type = NEW.artifact_type
    AND artifact.workspace_ref = NEW.workspace_ref
    AND artifact.path_ref = NEW.file_name
    AND artifact.source_run_id = NEW.run_id
    AND artifact.created_by_agent_id = NEW.agent_id
    AND artifact.content_mode = 'snapshot_blob'
    AND artifact.content_id = NEW.content_id
    AND artifact.content_publication_id = NEW.publication_id
    AND artifact.content_size_bytes = NEW.declared_size
    AND artifact.content_media_type = NEW.media_type
    AND artifact.content_sha256 = NEW.declared_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'Bound Artifact does not match its publication');
END;
