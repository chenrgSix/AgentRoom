CREATE TABLE bridge_pairing_invites (
  invite_id TEXT PRIMARY KEY CHECK (invite_id GLOB 'invite_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 80),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE INDEX bridge_pairing_invites_member_idx
  ON bridge_pairing_invites(member_id, expires_at);
