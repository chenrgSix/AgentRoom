CREATE TABLE room_human_participants (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (room_id, member_id)
) STRICT;

CREATE INDEX room_human_participants_member_idx
  ON room_human_participants(member_id, room_id);

CREATE TABLE room_agent_participants (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
) STRICT;

CREATE INDEX room_agent_participants_agent_idx
  ON room_agent_participants(agent_id, room_id);

INSERT INTO room_human_participants (room_id, member_id, added_at)
SELECT r.room_id, tm.member_id, r.created_at
FROM rooms r
JOIN team_members tm ON tm.team_id = r.team_id;

INSERT INTO room_agent_participants (room_id, agent_id, added_at)
SELECT r.room_id, a.agent_id, r.created_at
FROM rooms r
JOIN agents a ON a.team_id = r.team_id
WHERE a.enabled = 1;
