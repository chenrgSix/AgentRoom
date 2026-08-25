ALTER TABLE agents ADD COLUMN runtime_scope_id TEXT
  CHECK (
    runtime_scope_id IS NULL OR (
      length(runtime_scope_id) = 64 AND
      runtime_scope_id NOT GLOB '*[^0-9a-f]*'
    )
  );

DROP TRIGGER task_artifact_refs_immutable_update;
DROP TRIGGER task_artifact_refs_immutable_delete;

ALTER TABLE task_artifact_refs ADD COLUMN artifact_revision INTEGER;

UPDATE task_artifact_refs AS artifact
SET artifact_revision = (
  SELECT count(*)
  FROM task_artifact_refs AS prior
  WHERE prior.task_id = artifact.task_id
    AND (
      prior.created_at < artifact.created_at OR
      (prior.created_at = artifact.created_at AND
        prior.artifact_id <= artifact.artifact_id)
    )
);

CREATE UNIQUE INDEX task_artifact_refs_task_revision_idx
  ON task_artifact_refs(task_id, artifact_revision);

CREATE TRIGGER task_artifact_refs_require_revision_insert
BEFORE INSERT ON task_artifact_refs
WHEN NEW.artifact_revision IS NULL OR NEW.artifact_revision <= 0
BEGIN
  SELECT RAISE(ABORT, 'Artifact revision must be a positive Task ordinal');
END;

CREATE TRIGGER task_artifact_refs_immutable_update
BEFORE UPDATE ON task_artifact_refs
BEGIN
  SELECT RAISE(ABORT, 'Artifact references are immutable');
END;

CREATE TRIGGER task_artifact_refs_immutable_delete
BEFORE DELETE ON task_artifact_refs
BEGIN
  SELECT RAISE(ABORT, 'Artifact references are immutable');
END;

CREATE TABLE task_result_evidence_consumption (
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  runtime_scope_id TEXT NOT NULL CHECK (
    length(runtime_scope_id) = 64 AND
    runtime_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  through_revision INTEGER NOT NULL CHECK (through_revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, agent_id, runtime_scope_id)
) STRICT;
