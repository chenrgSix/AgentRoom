CREATE TABLE web_users (
  user_id TEXT PRIMARY KEY CHECK (user_id GLOB 'user_*'),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE teams (
  team_id TEXT PRIMARY KEY CHECK (team_id GLOB 'team_*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE team_members (
  member_id TEXT PRIMARY KEY CHECK (member_id GLOB 'member_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  user_id TEXT REFERENCES web_users(user_id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, user_id)
) STRICT;

CREATE INDEX team_members_team_idx ON team_members(team_id, member_id);

CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY CHECK (room_id GLOB 'room_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  next_message_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (next_message_sequence >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, name)
) STRICT;

CREATE INDEX rooms_team_idx ON rooms(team_id, room_id);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY CHECK (device_id GLOB 'device_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX devices_owner_idx ON devices(team_id, owner_member_id);

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY CHECK (agent_id GLOB 'agent_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (length(trim(role)) BETWEEN 1 AND 80),
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('managed', 'manual', 'fake')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  presence TEXT NOT NULL CHECK (presence IN ('ready', 'busy', 'degraded', 'manual', 'offline')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX agents_team_idx ON agents(team_id, enabled, agent_id);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY CHECK (message_id GLOB 'msg_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('member', 'agent', 'system')),
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  parent_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, sequence),
  UNIQUE (message_id, room_id),
  FOREIGN KEY (parent_message_id, room_id)
    REFERENCES messages(message_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX messages_room_sequence_idx ON messages(room_id, sequence);

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_type TEXT NOT NULL CHECK (target_type = 'agent'),
  target_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  display_label TEXT NOT NULL CHECK (length(trim(display_label)) BETWEEN 1 AND 160),
  PRIMARY KEY (message_id, ordinal),
  UNIQUE (message_id, target_agent_id)
) STRICT;

CREATE INDEX message_mentions_agent_idx
  ON message_mentions(target_agent_id, message_id);
