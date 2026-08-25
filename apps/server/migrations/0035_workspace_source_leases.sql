ALTER TABLE agents ADD COLUMN workspace_ref TEXT CHECK (
  workspace_ref IS NULL OR (
    length(workspace_ref) = 74 AND
    workspace_ref GLOB 'workspace_*' AND
    substr(workspace_ref, 11) NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE agents ADD COLUMN workspace_generation TEXT CHECK (
  workspace_generation IS NULL OR (
    length(workspace_generation) = 64 AND
    workspace_generation NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE workspace_leases (
  lease_id TEXT PRIMARY KEY CHECK (lease_id GLOB 'lease_*'),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 160
  ),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  workspace_ref TEXT NOT NULL CHECK (
    length(workspace_ref) = 74 AND
    workspace_ref GLOB 'workspace_*' AND
    substr(workspace_ref, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_generation TEXT NOT NULL CHECK (
    length(workspace_generation) = 64 AND
    workspace_generation NOT GLOB '*[^0-9a-f]*'
  ),
  mode TEXT NOT NULL CHECK (mode = 'read_source'),
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (
    (state = 'active' AND released_at IS NULL) OR
    (state = 'released' AND released_at IS NOT NULL)
  ),
  UNIQUE (device_id, idempotency_key)
) STRICT;

CREATE INDEX workspace_leases_run_state_idx
  ON workspace_leases(run_id, state, expires_at);

CREATE TRIGGER workspace_leases_require_scope_insert
BEFORE INSERT ON workspace_leases
WHEN NOT EXISTS (
  SELECT 1
  FROM runs r
  JOIN agent_tasks t ON t.task_id = r.task_id AND t.room_id = r.room_id
  JOIN agents a ON a.agent_id = r.target_agent_id
  JOIN devices d ON d.device_id = a.device_id
  JOIN rooms room ON room.room_id = r.room_id
  WHERE r.run_id = NEW.run_id
    AND r.room_id = NEW.room_id
    AND r.task_id = NEW.task_id
    AND r.target_agent_id = NEW.agent_id
    AND a.device_id = NEW.device_id
    AND a.team_id = NEW.team_id
    AND d.team_id = NEW.team_id
    AND room.team_id = NEW.team_id
    AND a.workspace_ref = NEW.workspace_ref
    AND a.workspace_generation = NEW.workspace_generation
)
BEGIN
  SELECT RAISE(ABORT, 'Workspace lease scope is invalid');
END;

CREATE TRIGGER workspace_leases_restrict_update
BEFORE UPDATE ON workspace_leases
WHEN
  NEW.lease_id <> OLD.lease_id OR
  NEW.idempotency_key <> OLD.idempotency_key OR
  NEW.team_id <> OLD.team_id OR
  NEW.room_id <> OLD.room_id OR
  NEW.task_id <> OLD.task_id OR
  NEW.run_id <> OLD.run_id OR
  NEW.agent_id <> OLD.agent_id OR
  NEW.device_id <> OLD.device_id OR
  NEW.workspace_ref <> OLD.workspace_ref OR
  NEW.workspace_generation <> OLD.workspace_generation OR
  NEW.mode <> OLD.mode OR
  NEW.issued_at <> OLD.issued_at OR
  NEW.expires_at <> OLD.expires_at OR
  OLD.state <> 'active' OR
  NEW.state <> 'released' OR
  NEW.released_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Workspace lease update is invalid');
END;

CREATE TRIGGER workspace_leases_immutable_delete
BEFORE DELETE ON workspace_leases
BEGIN
  SELECT RAISE(ABORT, 'Workspace leases are retained evidence');
END;
