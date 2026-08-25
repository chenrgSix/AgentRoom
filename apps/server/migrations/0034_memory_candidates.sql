CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY CHECK (candidate_id GLOB 'candidate_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('room', 'task')),
  scope_id TEXT NOT NULL,
  task_id TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'decision', 'constraint', 'fact', 'open_question', 'convention',
    'goal', 'acceptance_criterion', 'plan', 'progress', 'blocker', 'result'
  )),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 2000),
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json) AND
    json_type(source_message_ids_json) = 'array'
  ),
  checkpoint_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  source_fingerprint TEXT NOT NULL UNIQUE CHECK (length(source_fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected')),
  accepted_memory_id TEXT UNIQUE REFERENCES memory_entries(memory_id)
    ON DELETE RESTRICT,
  reviewed_by_member_id TEXT REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 500
  ),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK (
    (scope_kind = 'room' AND scope_id = room_id AND task_id IS NULL) OR
    (scope_kind = 'task' AND scope_id = task_id AND task_id IS NOT NULL)
  ),
  CHECK (
    (state = 'pending' AND accepted_memory_id IS NULL AND
      reviewed_by_member_id IS NULL AND rejection_reason IS NULL AND
      reviewed_at IS NULL) OR
    (state = 'accepted' AND accepted_memory_id IS NOT NULL AND
      reviewed_by_member_id IS NOT NULL AND rejection_reason IS NULL AND
      reviewed_at IS NOT NULL) OR
    (state = 'rejected' AND accepted_memory_id IS NULL AND
      reviewed_by_member_id IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE CASCADE,
  FOREIGN KEY (checkpoint_id, room_id)
    REFERENCES rolling_room_checkpoints(checkpoint_id, room_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX memory_candidates_room_state_created_idx
  ON memory_candidates(room_id, state, created_at DESC, candidate_id);

CREATE TRIGGER memory_candidates_require_scope_type_insert
BEFORE INSERT ON memory_candidates
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
  SELECT RAISE(ABORT, 'Memory candidate type does not belong to its scope');
END;

CREATE TRIGGER memory_candidates_immutable_evidence_update
BEFORE UPDATE OF
  candidate_id, room_id, scope_kind, scope_id, task_id, entry_type, content,
  source_message_ids_json, checkpoint_id, source_digest, source_fingerprint,
  created_at
ON memory_candidates
BEGIN
  SELECT RAISE(ABORT, 'Memory candidate evidence is immutable');
END;

CREATE TRIGGER memory_candidates_require_review_update
BEFORE UPDATE OF
  state, accepted_memory_id, reviewed_by_member_id, rejection_reason, reviewed_at
ON memory_candidates
WHEN OLD.state <> 'pending' OR NEW.state NOT IN ('accepted', 'rejected')
BEGIN
  SELECT RAISE(ABORT, 'Memory candidate review is a single pending transition');
END;

CREATE TRIGGER memory_candidates_immutable_delete
BEFORE DELETE ON memory_candidates
BEGIN
  SELECT RAISE(ABORT, 'Memory candidates are immutable review evidence');
END;
