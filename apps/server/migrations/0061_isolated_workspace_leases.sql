CREATE TABLE isolated_workspace_leases (
  lease_id TEXT PRIMARY KEY CHECK (lease_id GLOB 'lease_*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation > 0),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  owner_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  workspace_ref TEXT NOT NULL UNIQUE CHECK (length(workspace_ref) = 74),
  initial_generation TEXT NOT NULL CHECK (length(initial_generation) = 64),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  lease_digest TEXT NOT NULL CHECK (length(lease_digest) = 64),
  lease_json TEXT NOT NULL CHECK (json_valid(lease_json)),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_revision, node_key, task_id)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key, task_id) ON DELETE RESTRICT,
  UNIQUE (plan_id, plan_revision, node_key, dispatch_generation),
  CHECK (json_extract(lease_json, '$.leaseId') IS lease_id),
  CHECK (json_extract(lease_json, '$.workspaceRef') IS workspace_ref),
  CHECK (json_extract(lease_json, '$.workspaceGeneration') IS initial_generation),
  CHECK (json_extract(lease_json, '$.mode') IS 'isolated_worktree'),
  CHECK (json_extract(lease_json, '$.issuedAt') IS issued_at),
  CHECK (json_extract(lease_json, '$.expiresAt') IS expires_at)
) STRICT;

CREATE TRIGGER isolated_workspace_scope_insert BEFORE INSERT ON isolated_workspace_leases
WHEN NOT EXISTS (
  SELECT 1 FROM runs run JOIN agents agent ON agent.agent_id = run.target_agent_id
  JOIN devices device ON device.device_id = agent.device_id
  JOIN rooms room ON room.room_id = run.room_id
  WHERE run.run_id = NEW.run_id AND run.task_id = NEW.task_id AND run.room_id = NEW.room_id
    AND run.target_agent_id = NEW.agent_id AND agent.integration_mode = 'managed'
    AND agent.device_id = NEW.device_id AND device.owner_member_id = NEW.owner_member_id
    AND room.team_id = NEW.team_id AND agent.team_id = NEW.team_id AND device.team_id = NEW.team_id
)
BEGIN SELECT RAISE(ABORT, 'Isolated workspace lease scope is invalid'); END;
CREATE TRIGGER isolated_workspace_immutable_update BEFORE UPDATE ON isolated_workspace_leases
BEGIN SELECT RAISE(ABORT, 'Isolated workspace identities are immutable'); END;
CREATE TRIGGER isolated_workspace_immutable_delete BEFORE DELETE ON isolated_workspace_leases
BEGIN SELECT RAISE(ABORT, 'Isolated workspace identities are retained'); END;

CREATE TABLE isolated_workspace_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  lease_id TEXT NOT NULL REFERENCES isolated_workspace_leases(lease_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 2 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('advance', 'revoke', 'release')),
  expected_generation TEXT NOT NULL CHECK (length(expected_generation) = 64),
  generation TEXT NOT NULL CHECK (length(generation) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  recorded_at TEXT NOT NULL,
  UNIQUE (lease_id, revision),
  CHECK ((kind = 'advance' AND generation <> expected_generation)
    OR (kind <> 'advance' AND generation = expected_generation))
) STRICT;

CREATE UNIQUE INDEX isolated_workspace_generation_once
ON isolated_workspace_operations(lease_id, generation) WHERE kind = 'advance';

CREATE TRIGGER isolated_workspace_operation_cas BEFORE INSERT ON isolated_workspace_operations
WHEN NOT EXISTS (
  SELECT 1 FROM isolated_workspace_leases lease WHERE lease.lease_id = NEW.lease_id
    AND NEW.revision = COALESCE((SELECT MAX(revision) FROM isolated_workspace_operations
      WHERE lease_id = NEW.lease_id), 1) + 1
    AND NEW.expected_generation = COALESCE((SELECT generation FROM isolated_workspace_operations
      WHERE lease_id = NEW.lease_id ORDER BY revision DESC LIMIT 1), lease.initial_generation)
    AND NOT EXISTS (SELECT 1 FROM isolated_workspace_operations
      WHERE lease_id = NEW.lease_id AND kind IN ('revoke', 'release'))
    AND (NEW.kind <> 'advance' OR NEW.generation <> lease.initial_generation)
)
BEGIN SELECT RAISE(ABORT, 'Isolated workspace generation or lifecycle conflicts'); END;
CREATE TRIGGER isolated_workspace_operations_immutable_update BEFORE UPDATE ON isolated_workspace_operations
BEGIN SELECT RAISE(ABORT, 'Isolated workspace operations are immutable'); END;
CREATE TRIGGER isolated_workspace_operations_immutable_delete BEFORE DELETE ON isolated_workspace_operations
BEGIN SELECT RAISE(ABORT, 'Isolated workspace operations are retained'); END;
