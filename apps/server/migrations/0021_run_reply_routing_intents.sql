CREATE TABLE run_reply_routing_intents (
  parent_run_id TEXT NOT NULL,
  reply_sequence INTEGER NOT NULL CHECK (reply_sequence > 0),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (parent_run_id, reply_sequence),
  FOREIGN KEY (parent_run_id, reply_sequence)
    REFERENCES run_events(run_id, sequence) ON DELETE CASCADE
) STRICT;

CREATE INDEX run_reply_routing_pending_idx
  ON run_reply_routing_intents(state, created_at, parent_run_id, reply_sequence);
