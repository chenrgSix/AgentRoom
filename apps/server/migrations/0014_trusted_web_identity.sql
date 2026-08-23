CREATE TABLE web_member_invitations (
  invitation_id TEXT PRIMARY KEY CHECK (invitation_id GLOB 'memberinvite_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
    CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_user_id TEXT REFERENCES web_users(user_id) ON DELETE RESTRICT,
  revoked_at TEXT,
  CHECK (
    (claimed_at IS NULL AND claimed_user_id IS NULL) OR
    (claimed_at IS NOT NULL AND claimed_user_id IS NOT NULL)
  ),
  CHECK (claimed_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE INDEX web_member_invitations_team_idx
  ON web_member_invitations(team_id, expires_at);

