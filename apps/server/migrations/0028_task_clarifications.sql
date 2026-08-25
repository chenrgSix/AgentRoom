ALTER TABLE run_events ADD COLUMN clarification_json TEXT;

CREATE TABLE task_clarifications (
  clarification_id TEXT PRIMARY KEY CHECK (clarification_id GLOB 'clarification_*'),
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  requesting_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  target_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  question TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 2000),
  choices_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'resumed', 'canceled')),
  question_message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id) ON DELETE RESTRICT,
  answer_message_id TEXT UNIQUE REFERENCES messages(message_id) ON DELETE RESTRICT,
  answered_by_member_id TEXT REFERENCES team_members(member_id) ON DELETE RESTRICT,
  continuation_run_id TEXT UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  resumed_at TEXT,
  CHECK (
    (state = 'waiting' AND answer_message_id IS NULL AND
      answered_by_member_id IS NULL AND continuation_run_id IS NULL AND
      answered_at IS NULL AND resumed_at IS NULL) OR
    (state = 'resumed' AND answer_message_id IS NOT NULL AND
      answered_by_member_id IS NOT NULL AND continuation_run_id IS NOT NULL AND
      answered_at IS NOT NULL AND resumed_at IS NOT NULL) OR
    state = 'canceled'
  ),
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX task_clarifications_task_created_idx
  ON task_clarifications(task_id, created_at DESC, clarification_id DESC);

CREATE TRIGGER task_clarifications_require_run_scope_insert
BEFORE INSERT ON task_clarifications
WHEN NOT EXISTS (
  SELECT 1 FROM runs
  WHERE run_id = NEW.requesting_run_id
    AND task_id = NEW.task_id
    AND room_id = NEW.room_id
    AND target_agent_id = NEW.target_agent_id
) OR NOT EXISTS (
  SELECT 1 FROM messages
  WHERE message_id = NEW.question_message_id
    AND task_id = NEW.task_id
    AND room_id = NEW.room_id
    AND sender_type = 'agent'
    AND sender_id = NEW.target_agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'Clarification Run and question must keep Task and Agent scope');
END;

CREATE TRIGGER task_clarifications_require_continuation_scope_update
BEFORE UPDATE OF continuation_run_id ON task_clarifications
WHEN NEW.continuation_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs
  WHERE run_id = NEW.continuation_run_id
    AND task_id = NEW.task_id
    AND room_id = NEW.room_id
    AND target_agent_id = NEW.target_agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'Clarification continuation must keep Task and Agent scope');
END;

CREATE TRIGGER task_clarifications_require_answer_scope_update
BEFORE UPDATE OF state, answer_message_id, answered_by_member_id
  ON task_clarifications
WHEN NEW.state = 'resumed' AND NOT EXISTS (
  SELECT 1 FROM messages
  WHERE message_id = NEW.answer_message_id
    AND task_id = NEW.task_id
    AND room_id = NEW.room_id
    AND sender_type = 'member'
    AND sender_id = NEW.answered_by_member_id
    AND parent_message_id = NEW.question_message_id
)
BEGIN
  SELECT RAISE(ABORT, 'Clarification answer must be an authorized Task reply');
END;
