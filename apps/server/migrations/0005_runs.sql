CREATE TABLE runs (
  run_id TEXT PRIMARY KEY CHECK (run_id GLOB 'run_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  trigger_message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  requester_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  target_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  parent_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 20000),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'delivered', 'working', 'input_required', 'completed', 'failed',
    'canceled', 'outcome_unknown'
  )),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (trigger_message_id, target_agent_id)
) STRICT;

CREATE INDEX runs_room_idx ON runs(room_id, created_at, run_id);
CREATE INDEX runs_agent_state_idx ON runs(target_agent_id, state, created_at);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('status', 'reply')),
  status TEXT,
  content TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;
