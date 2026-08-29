CREATE TABLE run_cancellation_intents (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE CHECK (message_id GLOB 'msg_*'),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  requested_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved')),
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  ack_deadline_at TEXT NOT NULL,
  resolved_at TEXT,
  terminal_status TEXT CHECK (terminal_status IS NULL OR terminal_status IN (
    'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
  )),
  CHECK (
    (state = 'pending' AND resolved_at IS NULL AND terminal_status IS NULL) OR
    (state = 'resolved' AND resolved_at IS NOT NULL AND terminal_status IS NOT NULL)
  ),
  CHECK (
    (send_count = 0 AND last_sent_at IS NULL) OR
    (send_count > 0 AND last_sent_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX run_cancellation_intents_pending_device_idx
  ON run_cancellation_intents(device_id, last_sent_at, created_at, run_id)
  WHERE state = 'pending';

CREATE INDEX run_cancellation_intents_pending_deadline_idx
  ON run_cancellation_intents(ack_deadline_at, created_at, run_id)
  WHERE state = 'pending';

CREATE TRIGGER run_cancellation_intents_preserve_identity
BEFORE UPDATE OF
  run_id, message_id, agent_id, device_id, requested_by_member_id,
  reason, created_at, ack_deadline_at
ON run_cancellation_intents
WHEN
  NEW.run_id IS NOT OLD.run_id OR
  NEW.message_id IS NOT OLD.message_id OR
  NEW.agent_id IS NOT OLD.agent_id OR
  NEW.device_id IS NOT OLD.device_id OR
  NEW.requested_by_member_id IS NOT OLD.requested_by_member_id OR
  NEW.reason IS NOT OLD.reason OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.ack_deadline_at IS NOT OLD.ack_deadline_at
BEGIN
  SELECT RAISE(ABORT, 'Run cancellation intent identity is immutable');
END;

CREATE TRIGGER run_cancellation_intents_preserve_resolution
BEFORE UPDATE OF state, resolved_at, terminal_status
ON run_cancellation_intents
WHEN OLD.state = 'resolved' AND (
  NEW.state IS NOT OLD.state OR
  NEW.resolved_at IS NOT OLD.resolved_at OR
  NEW.terminal_status IS NOT OLD.terminal_status
)
BEGIN
  SELECT RAISE(ABORT, 'Run cancellation intent resolution is immutable');
END;
