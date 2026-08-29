CREATE TABLE run_reply_message_projections (
  run_id TEXT NOT NULL,
  reply_sequence INTEGER NOT NULL CHECK (reply_sequence > 0),
  message_id TEXT NOT NULL UNIQUE
    REFERENCES messages(message_id) ON DELETE RESTRICT,
  projected_at TEXT NOT NULL,
  PRIMARY KEY (run_id, reply_sequence),
  FOREIGN KEY (run_id, reply_sequence)
    REFERENCES run_events(run_id, sequence) ON DELETE CASCADE
) STRICT;

CREATE TABLE run_reply_projection_failures (
  run_id TEXT NOT NULL,
  reply_sequence INTEGER NOT NULL CHECK (reply_sequence > 0),
  error_code TEXT NOT NULL CHECK (error_code IN (
    'INVALID_REPLY_EVENT',
    'MULTIPLE_EXACT_MESSAGES',
    'MESSAGE_ALREADY_PROJECTED',
    'TIMESTAMP_MISMATCH'
  )),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, reply_sequence),
  FOREIGN KEY (run_id, reply_sequence)
    REFERENCES run_events(run_id, sequence) ON DELETE CASCADE
) STRICT;

CREATE INDEX run_reply_projection_failures_recorded_idx
  ON run_reply_projection_failures(recorded_at, run_id, reply_sequence);

CREATE INDEX run_events_reply_projection_scan_idx
  ON run_events(created_at, run_id, sequence)
  WHERE event_type = 'reply';

CREATE INDEX messages_member_run_projection_scan_idx
  ON messages(created_at, room_id, sequence, message_id)
  WHERE sender_type = 'member';

CREATE TRIGGER run_reply_message_projections_validate_insert
BEFORE INSERT ON run_reply_message_projections
WHEN NOT EXISTS (
  SELECT 1
  FROM run_events event
  JOIN runs run ON run.run_id = event.run_id
  JOIN messages message ON message.message_id = NEW.message_id
  WHERE event.run_id = NEW.run_id
    AND event.sequence = NEW.reply_sequence
    AND event.event_type = 'reply'
    AND event.content IS NOT NULL
    AND length(event.content) BETWEEN 1 AND 20000
    AND event.trace_id = run.trace_id
    AND message.trace_id = run.trace_id
    AND message.room_id = run.room_id
    AND message.task_id IS run.task_id
    AND message.sender_type = 'agent'
    AND message.sender_id = run.target_agent_id
    AND message.parent_message_id = run.trigger_message_id
    AND message.content = event.content
    AND message.created_at = event.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'Run reply projection does not exactly match its event');
END;

CREATE TRIGGER run_reply_message_projections_exclude_failure_insert
BEFORE INSERT ON run_reply_message_projections
WHEN EXISTS (
  SELECT 1 FROM run_reply_projection_failures
  WHERE run_id = NEW.run_id AND reply_sequence = NEW.reply_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'Run reply projection is already marked unreconciled');
END;

CREATE TRIGGER run_reply_projection_failures_validate_insert
BEFORE INSERT ON run_reply_projection_failures
WHEN NOT EXISTS (
  SELECT 1 FROM run_events
  WHERE run_id = NEW.run_id
    AND sequence = NEW.reply_sequence
    AND event_type = 'reply'
) OR EXISTS (
  SELECT 1 FROM run_reply_message_projections
  WHERE run_id = NEW.run_id AND reply_sequence = NEW.reply_sequence
)
BEGIN
  SELECT RAISE(ABORT, 'Run reply failure must identify an unprojected reply event');
END;

CREATE TRIGGER run_reply_message_projections_immutable_update
BEFORE UPDATE ON run_reply_message_projections
BEGIN
  SELECT RAISE(ABORT, 'Run reply Message projections are immutable');
END;

CREATE TRIGGER run_reply_projection_failures_immutable_update
BEFORE UPDATE ON run_reply_projection_failures
BEGIN
  SELECT RAISE(ABORT, 'Run reply projection failures are immutable');
END;

CREATE TRIGGER projected_run_reply_messages_preserve_identity
BEFORE UPDATE OF
  trace_id, room_id, task_id, sender_type, sender_id, content,
  parent_message_id, created_at
ON messages
WHEN EXISTS (
  SELECT 1 FROM run_reply_message_projections
  WHERE message_id = OLD.message_id
) AND (
  NEW.trace_id IS NOT OLD.trace_id OR
  NEW.room_id IS NOT OLD.room_id OR
  NEW.task_id IS NOT OLD.task_id OR
  NEW.sender_type IS NOT OLD.sender_type OR
  NEW.sender_id IS NOT OLD.sender_id OR
  NEW.content IS NOT OLD.content OR
  NEW.parent_message_id IS NOT OLD.parent_message_id OR
  NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'Projected Run reply Message identity is immutable');
END;

CREATE TRIGGER projected_run_reply_events_preserve_identity
BEFORE UPDATE OF trace_id, event_type, content, created_at ON run_events
WHEN (
  EXISTS (
    SELECT 1 FROM run_reply_message_projections
    WHERE run_id = OLD.run_id AND reply_sequence = OLD.sequence
  ) OR EXISTS (
    SELECT 1 FROM run_reply_projection_failures
    WHERE run_id = OLD.run_id AND reply_sequence = OLD.sequence
  )
) AND (
  NEW.trace_id IS NOT OLD.trace_id OR
  NEW.event_type IS NOT OLD.event_type OR
  NEW.content IS NOT OLD.content OR
  NEW.created_at IS NOT OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'Reconciled Run reply event identity is immutable');
END;

CREATE TRIGGER projected_run_replies_preserve_run_identity
BEFORE UPDATE OF
  trace_id, room_id, task_id, trigger_message_id, target_agent_id
ON runs
WHEN (
  EXISTS (
    SELECT 1 FROM run_reply_message_projections
    WHERE run_id = OLD.run_id
  ) OR EXISTS (
    SELECT 1 FROM run_reply_projection_failures
    WHERE run_id = OLD.run_id
  )
) AND (
  NEW.trace_id IS NOT OLD.trace_id OR
  NEW.room_id IS NOT OLD.room_id OR
  NEW.task_id IS NOT OLD.task_id OR
  NEW.trigger_message_id IS NOT OLD.trigger_message_id OR
  NEW.target_agent_id IS NOT OLD.target_agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'Reconciled Run reply scope is immutable');
END;
