ALTER TABLE device_pairing_sessions ADD COLUMN member_binding_json TEXT;
ALTER TABLE device_pairing_sessions ADD COLUMN client_access_secret_hash TEXT
  CHECK (client_access_secret_hash IS NULL OR length(client_access_secret_hash) = 64);
ALTER TABLE device_pairing_sessions ADD COLUMN device_owner_member_id TEXT
  REFERENCES team_members(member_id);

CREATE TABLE client_device_bindings (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  initial_room_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE client_access_grants (
  grant_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES device_credentials(credential_id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES web_users(user_id) ON DELETE CASCADE,
  issued_by_member_id TEXT NOT NULL REFERENCES team_members(member_id),
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE client_entry_tickets (
  ticket_hash TEXT PRIMARY KEY CHECK (length(ticket_hash) = 64),
  grant_id TEXT NOT NULL REFERENCES client_access_grants(grant_id) ON DELETE CASCADE,
  room_id TEXT REFERENCES rooms(room_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX client_entry_tickets_grant_idx ON client_entry_tickets(grant_id, expires_at);

CREATE TABLE web_session_client_access (
  session_id TEXT PRIMARY KEY REFERENCES web_sessions(session_id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES client_access_grants(grant_id) ON DELETE CASCADE
) STRICT;

ALTER TABLE web_sessions ADD COLUMN client_access_required INTEGER NOT NULL DEFAULT 0
  CHECK (client_access_required IN (0, 1));
