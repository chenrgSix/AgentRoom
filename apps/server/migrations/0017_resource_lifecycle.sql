ALTER TABLE teams ADD COLUMN archived_at TEXT;

ALTER TABLE rooms ADD COLUMN archived_at TEXT;

CREATE INDEX teams_active_idx ON teams(archived_at, created_at, team_id);

CREATE INDEX rooms_team_active_idx
  ON rooms(team_id, archived_at, created_at, room_id);
