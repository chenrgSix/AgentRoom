ALTER TABLE agent_tasks
  ADD COLUMN summary_revision INTEGER NOT NULL DEFAULT 0
    CHECK (summary_revision >= 0);

ALTER TABLE agent_tasks
  ADD COLUMN summary_source_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (summary_source_sequence >= 0);

ALTER TABLE agent_tasks
  ADD COLUMN summary_provenance_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(summary_provenance_json) AND
      json_type(summary_provenance_json) = 'array'
    );

ALTER TABLE agent_tasks
  ADD COLUMN summary_fingerprint TEXT NOT NULL DEFAULT ''
    CHECK (summary_fingerprint = '' OR length(summary_fingerprint) = 64);

CREATE TABLE room_memory_projections (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  summary TEXT NOT NULL CHECK (length(summary) <= 8000),
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  provenance_json TEXT NOT NULL CHECK (
    json_valid(provenance_json) AND json_type(provenance_json) = 'array'
  ),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
