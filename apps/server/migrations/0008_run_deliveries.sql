CREATE TABLE run_deliveries (
  delivery_attempt_id TEXT PRIMARY KEY CHECK (delivery_attempt_id GLOB 'delivery_*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
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

CREATE INDEX run_deliveries_device_state_idx
  ON run_deliveries(device_id, state, created_at);
