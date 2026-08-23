CREATE TABLE discussions (
  discussion_id TEXT PRIMARY KEY CHECK (discussion_id GLOB 'discussion_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  root_message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  requester_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 20000),
  mode TEXT NOT NULL CHECK (mode IN ('round_robin', 'review')),
  state TEXT NOT NULL CHECK (state IN (
    'active', 'stop_requested', 'waiting_human', 'awaiting_extension',
    'paused', 'finalizing', 'completed', 'canceled', 'terminated'
  )),
  state_reason TEXT CHECK (state_reason IS NULL OR state_reason IN (
    'goal_satisfied', 'user_requested_finish', 'discussion_plateau',
    'soft_budget_exhausted', 'hard_budget_exhausted', 'policy_violation',
    'runtime_failure', 'user_paused', 'user_canceled', 'input_required'
  )),
  output_mode TEXT NOT NULL CHECK (output_mode IN (
    'none', 'summary', 'final_answer', 'artifact', 'decision_record',
    'unresolved_issues'
  )),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  progress_json TEXT NOT NULL CHECK (json_valid(progress_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  current_turn INTEGER NOT NULL DEFAULT 0 CHECK (current_turn >= 0),
  next_speaker_index INTEGER NOT NULL DEFAULT 0 CHECK (next_speaker_index >= 0),
  requested_action TEXT CHECK (requested_action IS NULL OR requested_action IN (
    'finish', 'stop_after_turn', 'pause'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (room_id, root_message_id)
) STRICT;

CREATE TABLE discussion_participants (
  discussion_id TEXT NOT NULL REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('participant', 'reviewer')),
  PRIMARY KEY (discussion_id, ordinal),
  UNIQUE (discussion_id, agent_id)
) STRICT;

CREATE TABLE discussion_turns (
  turn_id TEXT PRIMARY KEY CHECK (turn_id GLOB 'turn_*'),
  discussion_id TEXT NOT NULL REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN ('discussion', 'finalization')),
  speaker_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  input_message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  run_id TEXT UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  output_message_id TEXT REFERENCES messages(message_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'queued', 'working', 'completed', 'failed', 'canceled'
  )),
  assessment_json TEXT CHECK (
    assessment_json IS NULL OR json_valid(assessment_json)
  ),
  reply_hash TEXT CHECK (reply_hash IS NULL OR length(reply_hash) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (discussion_id, ordinal)
) STRICT;

CREATE TABLE discussion_decisions (
  decision_id TEXT PRIMARY KEY CHECK (decision_id GLOB 'decision_*'),
  discussion_id TEXT NOT NULL REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  progress_version INTEGER NOT NULL CHECK (progress_version >= 0),
  action TEXT NOT NULL CHECK (action IN (
    'continue', 'wait_human', 'pause', 'finalize', 'cancel', 'terminate'
  )),
  reason TEXT NOT NULL,
  next_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  output_mode TEXT NOT NULL CHECK (output_mode IN (
    'none', 'summary', 'final_answer', 'artifact', 'decision_record',
    'unresolved_issues'
  )),
  created_at TEXT NOT NULL,
  UNIQUE (discussion_id, aggregate_version)
) STRICT;

CREATE TABLE discussion_budget_events (
  budget_event_id TEXT PRIMARY KEY CHECK (budget_event_id GLOB 'budget_*'),
  discussion_id TEXT NOT NULL REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'lease_granted', 'turn_recorded', 'extension_granted',
    'finalization_reserved'
  )),
  turns INTEGER NOT NULL CHECK (turns >= 0),
  tokens INTEGER CHECK (tokens IS NULL OR tokens >= 0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  estimated_cost_micros INTEGER CHECK (
    estimated_cost_micros IS NULL OR estimated_cost_micros >= 0
  ),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (discussion_id, ordinal)
) STRICT;

CREATE INDEX discussions_room_state_idx
  ON discussions(room_id, state, updated_at, discussion_id);
CREATE INDEX discussion_turns_run_idx ON discussion_turns(run_id);
CREATE INDEX discussion_turns_discussion_idx
  ON discussion_turns(discussion_id, ordinal);
CREATE INDEX discussion_budget_events_discussion_idx
  ON discussion_budget_events(discussion_id, ordinal);
