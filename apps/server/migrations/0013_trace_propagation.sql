ALTER TABLE messages
  ADD COLUMN trace_id TEXT CHECK (trace_id IS NULL OR trace_id GLOB 'trace_*');

UPDATE messages
SET trace_id = 'trace_' || lower(hex(randomblob(16)))
WHERE trace_id IS NULL;

CREATE INDEX messages_trace_idx ON messages(trace_id, created_at, message_id);

ALTER TABLE runs
  ADD COLUMN trace_id TEXT CHECK (trace_id IS NULL OR trace_id GLOB 'trace_*');

UPDATE runs
SET trace_id = (
  SELECT messages.trace_id
  FROM messages
  WHERE messages.message_id = runs.trigger_message_id
)
WHERE trace_id IS NULL;

CREATE INDEX runs_trace_idx ON runs(trace_id, created_at, run_id);

ALTER TABLE run_deliveries
  ADD COLUMN trace_id TEXT CHECK (trace_id IS NULL OR trace_id GLOB 'trace_*');

UPDATE run_deliveries
SET trace_id = (
  SELECT runs.trace_id
  FROM runs
  WHERE runs.run_id = run_deliveries.run_id
)
WHERE trace_id IS NULL;

CREATE INDEX run_deliveries_trace_idx
  ON run_deliveries(trace_id, created_at, delivery_attempt_id);

ALTER TABLE run_events
  ADD COLUMN trace_id TEXT CHECK (trace_id IS NULL OR trace_id GLOB 'trace_*');

UPDATE run_events
SET trace_id = (
  SELECT runs.trace_id
  FROM runs
  WHERE runs.run_id = run_events.run_id
)
WHERE trace_id IS NULL;

CREATE INDEX run_events_trace_idx
  ON run_events(trace_id, created_at, run_id, sequence);
