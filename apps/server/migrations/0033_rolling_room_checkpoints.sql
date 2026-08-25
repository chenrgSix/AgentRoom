CREATE TABLE rolling_room_checkpoints (
  checkpoint_id TEXT PRIMARY KEY CHECK (checkpoint_id GLOB 'checkpoint_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  parent_checkpoint_id TEXT,
  input_from_sequence_exclusive INTEGER NOT NULL
    CHECK (input_from_sequence_exclusive >= 0),
  through_sequence INTEGER NOT NULL CHECK (
    through_sequence > input_from_sequence_exclusive
  ),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 12000),
  provenance_json TEXT NOT NULL CHECK (
    json_valid(provenance_json) AND json_type(provenance_json) = 'array'
  ),
  source_message_count INTEGER NOT NULL CHECK (source_message_count > 0),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  prompt_version INTEGER NOT NULL CHECK (prompt_version > 0),
  model_fingerprint TEXT NOT NULL CHECK (
    length(trim(model_fingerprint)) BETWEEN 1 AND 256
  ),
  build_kind TEXT NOT NULL CHECK (build_kind IN ('incremental', 'rebase')),
  created_at TEXT NOT NULL,
  UNIQUE (checkpoint_id, room_id),
  UNIQUE (
    room_id, parent_checkpoint_id, through_sequence, source_digest,
    prompt_version, model_fingerprint, build_kind
  ),
  FOREIGN KEY (parent_checkpoint_id, room_id)
    REFERENCES rolling_room_checkpoints(checkpoint_id, room_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX rolling_room_checkpoints_room_through_idx
  ON rolling_room_checkpoints(room_id, through_sequence DESC, checkpoint_id);

CREATE TRIGGER rolling_room_checkpoints_require_contiguous_insert
BEFORE INSERT ON rolling_room_checkpoints
WHEN (
  NEW.build_kind = 'rebase' AND NEW.input_from_sequence_exclusive <> 0
) OR (
  NEW.build_kind = 'incremental' AND NEW.parent_checkpoint_id IS NULL AND
  NEW.input_from_sequence_exclusive <> 0
) OR (
  NEW.build_kind = 'incremental' AND NEW.parent_checkpoint_id IS NOT NULL AND
  NOT EXISTS (
    SELECT 1 FROM rolling_room_checkpoints parent
    WHERE parent.checkpoint_id = NEW.parent_checkpoint_id
      AND parent.room_id = NEW.room_id
      AND parent.through_sequence = NEW.input_from_sequence_exclusive
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Rolling Room checkpoint input is not contiguous');
END;

CREATE TRIGGER rolling_room_checkpoints_immutable_update
BEFORE UPDATE ON rolling_room_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'Rolling Room checkpoints are immutable');
END;

CREATE TRIGGER rolling_room_checkpoints_immutable_delete
BEFORE DELETE ON rolling_room_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'Rolling Room checkpoints are immutable');
END;

CREATE TABLE rolling_room_state (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (
    mode IN ('disabled', 'backfilling', 'ready', 'degraded')
  ),
  latest_checkpoint_id TEXT,
  latest_through_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (latest_through_sequence >= 0),
  desired_through_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (desired_through_sequence >= latest_through_sequence),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_token TEXT CHECK (
    lease_token IS NULL OR length(trim(lease_token)) BETWEEN 16 AND 160
  ),
  lease_expires_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
  updated_at TEXT NOT NULL,
  CHECK (
    (latest_through_sequence = 0 AND latest_checkpoint_id IS NULL) OR
    (latest_through_sequence > 0 AND latest_checkpoint_id IS NOT NULL)
  ),
  CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL) OR
    (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  UNIQUE (latest_checkpoint_id, room_id),
  FOREIGN KEY (latest_checkpoint_id, room_id)
    REFERENCES rolling_room_checkpoints(checkpoint_id, room_id)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO rolling_room_state (
  room_id, mode, latest_checkpoint_id, latest_through_sequence,
  desired_through_sequence, generation, lease_token, lease_expires_at,
  last_error, updated_at
)
SELECT
  room_id, 'disabled', NULL, 0, next_message_sequence, 0, NULL, NULL, NULL,
  created_at
FROM rooms;

CREATE TRIGGER rooms_create_rolling_room_state
AFTER INSERT ON rooms
BEGIN
  INSERT INTO rolling_room_state (
    room_id, mode, latest_checkpoint_id, latest_through_sequence,
    desired_through_sequence, generation, lease_token, lease_expires_at,
    last_error, updated_at
  ) VALUES (
    NEW.room_id, 'disabled', NULL, 0, NEW.next_message_sequence, 0,
    NULL, NULL, NULL, NEW.created_at
  );
END;

CREATE TRIGGER messages_advance_rolling_room_desired
AFTER INSERT ON messages
BEGIN
  UPDATE rolling_room_state
  SET desired_through_sequence = max(desired_through_sequence, NEW.sequence),
      updated_at = max(updated_at, NEW.created_at)
  WHERE room_id = NEW.room_id;
END;

CREATE TRIGGER rolling_room_state_monotonic_update
BEFORE UPDATE OF latest_through_sequence, desired_through_sequence
ON rolling_room_state
WHEN NEW.latest_through_sequence < OLD.latest_through_sequence OR
  NEW.desired_through_sequence < OLD.desired_through_sequence OR
  NEW.desired_through_sequence < NEW.latest_through_sequence
BEGIN
  SELECT RAISE(ABORT, 'Rolling Room state cursors cannot regress');
END;

CREATE TRIGGER rolling_room_state_require_checkpoint_update
BEFORE UPDATE OF latest_checkpoint_id, latest_through_sequence
ON rolling_room_state
WHEN NEW.latest_through_sequence > 0 AND NOT EXISTS (
  SELECT 1 FROM rolling_room_checkpoints checkpoint
  WHERE checkpoint.checkpoint_id = NEW.latest_checkpoint_id
    AND checkpoint.room_id = NEW.room_id
    AND checkpoint.through_sequence = NEW.latest_through_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'Rolling Room state checkpoint does not match its cursor');
END;

CREATE UNIQUE INDEX runs_id_room_context_fence_idx ON runs(run_id, room_id);

CREATE TABLE run_context_fences (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence > 0),
  room_long_term_memory_revision INTEGER NOT NULL CHECK (
    room_long_term_memory_revision >= 0
  ),
  task_long_term_memory_revision INTEGER NOT NULL CHECK (
    task_long_term_memory_revision >= 0
  ),
  task_artifact_revision INTEGER NOT NULL CHECK (task_artifact_revision >= 0),
  task_summary_revision INTEGER NOT NULL CHECK (task_summary_revision >= 0),
  task_state TEXT NOT NULL CHECK (
    task_state IN ('open', 'working', 'blocked', 'review', 'completed', 'canceled')
  ),
  task_title TEXT NOT NULL CHECK (length(trim(task_title)) BETWEEN 1 AND 160),
  task_goal TEXT NOT NULL CHECK (length(trim(task_goal)) BETWEEN 1 AND 20000),
  fence_kind TEXT NOT NULL CHECK (fence_kind IN ('legacy', 'captured')),
  captured_at TEXT NOT NULL,
  UNIQUE (run_id, room_id),
  FOREIGN KEY (run_id, room_id) REFERENCES runs(run_id, room_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO run_context_fences (
  run_id, room_id, task_id, trigger_sequence,
  room_long_term_memory_revision, task_long_term_memory_revision,
  task_artifact_revision, task_summary_revision, task_state, task_title,
  task_goal, fence_kind, captured_at
)
SELECT
  run.run_id,
  run.room_id,
  run.task_id,
  message.sequence,
  room.memory_revision,
  task.long_term_memory_revision,
  task.artifact_revision,
  task.summary_revision,
  task.state,
  task.title,
  task.goal,
  'legacy',
  run.created_at
FROM runs run
JOIN messages message ON message.message_id = run.trigger_message_id
JOIN rooms room ON room.room_id = run.room_id
JOIN agent_tasks task ON task.task_id = run.task_id AND task.room_id = run.room_id;

CREATE TRIGGER runs_capture_context_fence
AFTER INSERT ON runs
BEGIN
  INSERT INTO run_context_fences (
    run_id, room_id, task_id, trigger_sequence,
    room_long_term_memory_revision, task_long_term_memory_revision,
    task_artifact_revision, task_summary_revision, task_state, task_title,
    task_goal, fence_kind, captured_at
  )
  SELECT
    NEW.run_id,
    NEW.room_id,
    NEW.task_id,
    message.sequence,
    room.memory_revision,
    task.long_term_memory_revision,
    task.artifact_revision,
    task.summary_revision,
    task.state,
    task.title,
    task.goal,
    'captured',
    NEW.created_at
  FROM messages message
  JOIN rooms room ON room.room_id = NEW.room_id
  JOIN agent_tasks task
    ON task.task_id = NEW.task_id AND task.room_id = NEW.room_id
  WHERE message.message_id = NEW.trigger_message_id
    AND message.room_id = NEW.room_id;
END;

CREATE TRIGGER run_context_fences_immutable_update
BEFORE UPDATE ON run_context_fences
BEGIN
  SELECT RAISE(ABORT, 'Run context fences are immutable');
END;

CREATE TABLE memory_entry_lifecycle_events (
  memory_id TEXT NOT NULL REFERENCES memory_entries(memory_id) ON DELETE RESTRICT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('room', 'task')),
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'retracted')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision),
  UNIQUE (scope_kind, scope_id, revision)
) STRICT;

INSERT INTO memory_entry_lifecycle_events (
  memory_id, scope_kind, scope_id, revision, state, recorded_at
)
SELECT memory_id, scope_kind, scope_id, revision, state, updated_at
FROM memory_entries;

CREATE TRIGGER memory_entries_record_lifecycle_insert
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_entry_lifecycle_events (
    memory_id, scope_kind, scope_id, revision, state, recorded_at
  ) VALUES (
    NEW.memory_id, NEW.scope_kind, NEW.scope_id, NEW.revision, NEW.state,
    NEW.updated_at
  );
END;

CREATE TRIGGER memory_entries_record_lifecycle_update
AFTER UPDATE OF state, revision ON memory_entries
WHEN NEW.state <> OLD.state OR NEW.revision <> OLD.revision
BEGIN
  INSERT INTO memory_entry_lifecycle_events (
    memory_id, scope_kind, scope_id, revision, state, recorded_at
  ) VALUES (
    NEW.memory_id, NEW.scope_kind, NEW.scope_id, NEW.revision, NEW.state,
    NEW.updated_at
  );
END;

CREATE TRIGGER memory_entry_lifecycle_events_immutable_update
BEFORE UPDATE ON memory_entry_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'Memory lifecycle events are immutable');
END;

CREATE TRIGGER memory_entry_lifecycle_events_immutable_delete
BEFORE DELETE ON memory_entry_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'Memory lifecycle events are immutable');
END;
