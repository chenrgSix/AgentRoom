ALTER TABLE task_clarifications ADD COLUMN resolution_reason TEXT
  CHECK (
    resolution_reason IS NULL OR resolution_reason IN (
      'run_canceled', 'run_expired', 'run_terminal', 'task_terminal',
      'agent_unavailable', 'orphaned'
    )
  );

ALTER TABLE task_clarifications ADD COLUMN canceled_at TEXT;

UPDATE task_clarifications
SET state = 'canceled',
    resolution_reason = CASE (
      SELECT state FROM runs WHERE run_id = requesting_run_id
    )
      WHEN 'canceled' THEN 'run_canceled'
      WHEN 'expired' THEN 'run_expired'
      ELSE 'run_terminal'
    END,
    canceled_at = COALESCE(
      (SELECT terminal_at FROM runs WHERE run_id = requesting_run_id),
      (SELECT updated_at FROM runs WHERE run_id = requesting_run_id),
      created_at
    )
WHERE state = 'waiting'
  AND NOT EXISTS (
    SELECT 1 FROM runs
    WHERE run_id = requesting_run_id AND state = 'input_required'
  );

CREATE TRIGGER task_clarifications_require_canceled_resolution_update
BEFORE UPDATE OF state, resolution_reason, canceled_at ON task_clarifications
WHEN NEW.state = 'canceled' AND (
  NEW.resolution_reason IS NULL OR NEW.canceled_at IS NULL OR
  NEW.answer_message_id IS NOT NULL OR NEW.answered_by_member_id IS NOT NULL OR
  NEW.continuation_run_id IS NOT NULL OR NEW.answered_at IS NOT NULL OR
  NEW.resumed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Canceled clarification requires one clean terminal reason');
END;

CREATE TRIGGER task_clarifications_close_terminal_run
AFTER UPDATE OF state ON runs
WHEN OLD.state <> NEW.state AND NEW.state IN (
  'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
)
BEGIN
  UPDATE task_clarifications
  SET state = 'canceled',
      resolution_reason = CASE NEW.state
        WHEN 'canceled' THEN 'run_canceled'
        WHEN 'expired' THEN 'run_expired'
        ELSE 'run_terminal'
      END,
      canceled_at = NEW.updated_at
  WHERE requesting_run_id = NEW.run_id AND state = 'waiting';
END;
