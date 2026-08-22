CREATE TABLE web_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id GLOB 'session_*'),
  user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX web_sessions_user_idx ON web_sessions(user_id, expires_at);

CREATE TABLE device_credentials (
  credential_id TEXT PRIMARY KEY CHECK (credential_id GLOB 'credential_*'),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE UNIQUE INDEX device_credentials_one_active_idx
  ON device_credentials(device_id)
  WHERE revoked_at IS NULL;
