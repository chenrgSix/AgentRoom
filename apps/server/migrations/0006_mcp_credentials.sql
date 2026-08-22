CREATE TABLE mcp_credentials (
  credential_id TEXT PRIMARY KEY CHECK (credential_id GLOB 'mcpcred_*'),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE INDEX mcp_credentials_agent_idx
  ON mcp_credentials(agent_id, expires_at);
