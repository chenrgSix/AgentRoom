CREATE TABLE web_member_recoveries (
  recovery_id TEXT PRIMARY KEY CHECK (recovery_id GLOB 'memberrecovery_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX web_member_recoveries_one_pending_idx
  ON web_member_recoveries(user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX web_member_recoveries_team_idx
  ON web_member_recoveries(team_id, member_id, expires_at);
