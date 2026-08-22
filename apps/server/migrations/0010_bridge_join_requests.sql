CREATE TABLE bridge_join_requests (
  join_request_id TEXT PRIMARY KEY CHECK (join_request_id GLOB 'joinreq_*'),
  user_code_hash TEXT NOT NULL UNIQUE CHECK (length(user_code_hash) = 64),
  poll_token_hash TEXT NOT NULL UNIQUE CHECK (length(poll_token_hash) = 64),
  device_name TEXT NOT NULL CHECK (length(trim(device_name)) BETWEEN 1 AND 80),
  agent_name TEXT NOT NULL CHECK (length(trim(agent_name)) BETWEEN 1 AND 80),
  agent_role TEXT NOT NULL CHECK (length(trim(agent_role)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  approved_team_id TEXT REFERENCES teams(team_id) ON DELETE CASCADE,
  approved_member_id TEXT REFERENCES team_members(member_id) ON DELETE CASCADE,
  claimed_at TEXT,
  device_id TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
  credential_id TEXT REFERENCES device_credentials(credential_id) ON DELETE SET NULL,
  CHECK (
    (approved_at IS NULL AND approved_team_id IS NULL AND approved_member_id IS NULL) OR
    (approved_at IS NOT NULL AND approved_team_id IS NOT NULL AND approved_member_id IS NOT NULL)
  ),
  CHECK (
    (claimed_at IS NULL AND device_id IS NULL AND credential_id IS NULL) OR
    (claimed_at IS NOT NULL AND device_id IS NOT NULL AND credential_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX bridge_join_requests_expiry_idx
  ON bridge_join_requests(expires_at, approved_at, claimed_at);
