ALTER TABLE rooms ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 0
  CHECK (memory_revision >= 0);

ALTER TABLE agent_tasks ADD COLUMN long_term_memory_revision INTEGER NOT NULL DEFAULT 0
  CHECK (long_term_memory_revision >= 0);

CREATE TABLE memory_entries (
  memory_id TEXT PRIMARY KEY CHECK (memory_id GLOB 'memory_*'),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('room', 'task')),
  scope_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE RESTRICT,
  task_id TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'decision', 'constraint', 'fact', 'open_question', 'convention',
    'goal', 'acceptance_criterion', 'plan', 'progress', 'blocker', 'result'
  )),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 2000),
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'retracted')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  supersedes_memory_id TEXT UNIQUE REFERENCES memory_entries(memory_id)
    ON DELETE RESTRICT,
  source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json)),
  source_artifact_ids_json TEXT NOT NULL CHECK (json_valid(source_artifact_ids_json)),
  source_run_ids_json TEXT NOT NULL CHECK (json_valid(source_run_ids_json)),
  source_discussion_ids_json TEXT NOT NULL
    CHECK (json_valid(source_discussion_ids_json)),
  created_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope_kind = 'room' AND scope_id = room_id AND task_id IS NULL) OR
    (scope_kind = 'task' AND scope_id = task_id AND task_id IS NOT NULL)
  ),
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT,
  UNIQUE (scope_kind, scope_id, revision)
) STRICT;

CREATE INDEX memory_entries_scope_state_revision_idx
  ON memory_entries(scope_kind, scope_id, state, revision DESC);

CREATE TRIGGER memory_entries_require_scope_type_insert
BEFORE INSERT ON memory_entries
WHEN (
  NEW.scope_kind = 'room' AND NEW.entry_type NOT IN (
    'decision', 'constraint', 'fact', 'open_question', 'convention'
  )
) OR (
  NEW.scope_kind = 'task' AND NEW.entry_type NOT IN (
    'goal', 'acceptance_criterion', 'plan', 'progress', 'blocker',
    'decision', 'result'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Memory entry type does not belong to its scope');
END;

CREATE TRIGGER memory_entries_require_supersession_scope_insert
BEFORE INSERT ON memory_entries
WHEN NEW.supersedes_memory_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM memory_entries
  WHERE memory_id = NEW.supersedes_memory_id
    AND scope_kind = NEW.scope_kind
    AND scope_id = NEW.scope_id
    AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'Memory supersession must replace one active entry in scope');
END;

CREATE TRIGGER memory_entries_immutable_evidence_update
BEFORE UPDATE OF
  memory_id, scope_kind, scope_id, room_id, task_id, entry_type, content,
  supersedes_memory_id, source_message_ids_json, source_artifact_ids_json,
  source_run_ids_json, source_discussion_ids_json, created_by_member_id,
  created_at
ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'Memory entry evidence is immutable');
END;

CREATE TRIGGER memory_entries_require_lifecycle_update
BEFORE UPDATE OF state, revision, updated_at ON memory_entries
WHEN OLD.state <> 'active' OR NEW.state NOT IN ('superseded', 'retracted') OR
  NEW.revision <= OLD.revision OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'Memory entry lifecycle must close one active revision');
END;

CREATE TRIGGER memory_entries_immutable_delete
BEFORE DELETE ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'Memory entries are immutable evidence');
END;
