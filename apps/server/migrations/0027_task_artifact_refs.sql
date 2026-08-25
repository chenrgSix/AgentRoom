ALTER TABLE agent_tasks
  ADD COLUMN artifact_revision INTEGER NOT NULL DEFAULT 0
    CHECK (artifact_revision >= 0);

CREATE TABLE task_artifact_refs (
  artifact_id TEXT PRIMARY KEY CHECK (artifact_id GLOB 'artifact_*'),
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'commit', 'branch', 'file', 'patch', 'test_result', 'document'
  )),
  workspace_ref TEXT CHECK (
    workspace_ref IS NULL OR length(workspace_ref) BETWEEN 1 AND 512
  ),
  repository_ref TEXT CHECK (
    repository_ref IS NULL OR length(repository_ref) BETWEEN 1 AND 512
  ),
  path_ref TEXT CHECK (
    path_ref IS NULL OR length(path_ref) BETWEEN 1 AND 1024
  ),
  commit_sha TEXT CHECK (
    commit_sha IS NULL OR (
      length(commit_sha) BETWEEN 7 AND 64 AND
      commit_sha NOT GLOB '*[^0-9a-f]*'
    )
  ),
  branch_ref TEXT CHECK (
    branch_ref IS NULL OR length(branch_ref) BETWEEN 1 AND 255
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  source_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  created_by_member_id TEXT REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_by_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (
    (created_by_member_id IS NOT NULL) != (created_by_agent_id IS NOT NULL)
  ),
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX task_artifact_refs_task_created_idx
  ON task_artifact_refs(task_id, created_at DESC, artifact_id DESC);

CREATE TRIGGER task_artifact_refs_require_source_run_task_insert
BEFORE INSERT ON task_artifact_refs
WHEN NEW.source_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs
  WHERE run_id = NEW.source_run_id
    AND task_id = NEW.task_id
    AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Artifact source Run must belong to its Task');
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
