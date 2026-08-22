CREATE TABLE runs_v2 (
  run_id TEXT PRIMARY KEY CHECK (run_id GLOB 'run_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  trigger_message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  requester_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  target_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  parent_run_id TEXT REFERENCES runs_v2(run_id) ON DELETE RESTRICT,
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 20000),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'delivered', 'working', 'input_required', 'completed', 'failed',
    'canceled', 'expired', 'outcome_unknown'
  )),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (trigger_message_id, target_agent_id)
) STRICT;

CREATE TABLE run_events_v2 (
  run_id TEXT NOT NULL REFERENCES runs_v2(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('status', 'reply')),
  status TEXT,
  content TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;

CREATE TABLE run_deliveries_v2 (
  delivery_attempt_id TEXT PRIMARY KEY CHECK (delivery_attempt_id GLOB 'delivery_*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs_v2(run_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  accepted_at TEXT
) STRICT;

INSERT INTO runs_v2 SELECT * FROM runs;
INSERT INTO run_events_v2 SELECT * FROM run_events;
INSERT INTO run_deliveries_v2 SELECT * FROM run_deliveries;

DROP TABLE run_deliveries;
DROP TABLE run_events;
DROP TABLE runs;

ALTER TABLE runs_v2 RENAME TO runs;
ALTER TABLE run_events_v2 RENAME TO run_events;
ALTER TABLE run_deliveries_v2 RENAME TO run_deliveries;

CREATE INDEX runs_room_idx ON runs(room_id, created_at, run_id);
CREATE INDEX runs_agent_state_idx ON runs(target_agent_id, state, created_at);
CREATE INDEX run_deliveries_device_state_idx
  ON run_deliveries(device_id, state, created_at);
