CREATE TABLE run_events_v4 (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('status', 'activity', 'output', 'reply')
  ),
  status TEXT,
  content TEXT,
  output_reset INTEGER NOT NULL DEFAULT 0 CHECK (output_reset IN (0, 1)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  assessment_json TEXT CHECK (
    assessment_json IS NULL OR json_valid(assessment_json)
  ),
  activity_json TEXT CHECK (
    activity_json IS NULL OR json_valid(activity_json)
  ),
  created_at TEXT NOT NULL,
  trace_id TEXT CHECK (trace_id IS NULL OR trace_id GLOB 'trace_*'),
  PRIMARY KEY (run_id, sequence)
) STRICT;

INSERT INTO run_events_v4 (
  run_id, sequence, event_type, status, content, output_reset, error_json,
  assessment_json, activity_json, created_at, trace_id
)
SELECT
  run_id, sequence, event_type, status, content, output_reset, error_json,
  assessment_json, NULL, created_at, trace_id
FROM run_events;

CREATE TABLE run_reply_routing_intents_v2 (
  parent_run_id TEXT NOT NULL,
  reply_sequence INTEGER NOT NULL CHECK (reply_sequence > 0),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (parent_run_id, reply_sequence),
  FOREIGN KEY (parent_run_id, reply_sequence)
    REFERENCES run_events_v4(run_id, sequence) ON DELETE CASCADE
) STRICT;

INSERT INTO run_reply_routing_intents_v2 (
  parent_run_id, reply_sequence, content, state, created_at, completed_at
)
SELECT
  parent_run_id, reply_sequence, content, state, created_at, completed_at
FROM run_reply_routing_intents;

DROP TABLE run_reply_routing_intents;
DROP TABLE run_events;
ALTER TABLE run_events_v4 RENAME TO run_events;
ALTER TABLE run_reply_routing_intents_v2 RENAME TO run_reply_routing_intents;

CREATE INDEX run_events_trace_idx
  ON run_events(trace_id, created_at, run_id, sequence);

CREATE INDEX run_reply_routing_pending_idx
  ON run_reply_routing_intents(state, created_at, parent_run_id, reply_sequence);
