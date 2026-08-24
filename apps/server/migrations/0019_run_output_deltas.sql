CREATE TABLE run_events_v3 (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('status', 'output', 'reply')),
  status TEXT,
  content TEXT,
  output_reset INTEGER NOT NULL DEFAULT 0 CHECK (output_reset IN (0, 1)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  assessment_json TEXT CHECK (
    assessment_json IS NULL OR json_valid(assessment_json)
  ),
  created_at TEXT NOT NULL,
  trace_id TEXT CHECK (trace_id IS NULL OR trace_id GLOB 'trace_*'),
  PRIMARY KEY (run_id, sequence)
) STRICT;

INSERT INTO run_events_v3 (
  run_id, sequence, event_type, status, content, output_reset, error_json,
  assessment_json, created_at, trace_id
)
SELECT
  run_id, sequence, event_type, status, content, 0, error_json,
  assessment_json, created_at, trace_id
FROM run_events;

DROP TABLE run_events;
ALTER TABLE run_events_v3 RENAME TO run_events;

CREATE INDEX run_events_trace_idx
  ON run_events(trace_id, created_at, run_id, sequence);
