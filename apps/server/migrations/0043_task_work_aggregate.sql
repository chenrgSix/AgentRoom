ALTER TABLE agent_tasks ADD COLUMN team_id TEXT REFERENCES teams(team_id);
ALTER TABLE agent_tasks ADD COLUMN task_display_number INTEGER;
ALTER TABLE agent_tasks ADD COLUMN owner_member_id TEXT
  REFERENCES team_members(member_id) ON DELETE RESTRICT;
ALTER TABLE agent_tasks ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (lifecycle_state IN (
    'draft', 'ready', 'active', 'review', 'completed', 'canceled'
  ));
ALTER TABLE agent_tasks ADD COLUMN scheduling_state TEXT NOT NULL DEFAULT 'enabled'
  CHECK (scheduling_state IN ('enabled', 'paused'));
ALTER TABLE agent_tasks ADD COLUMN completion_policy TEXT NOT NULL
  DEFAULT 'owner_confirmed'
  CHECK (completion_policy IN ('owner_confirmed', 'accepted_result_required'));
ALTER TABLE agent_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE agent_tasks ADD COLUMN due_at TEXT;
ALTER TABLE agent_tasks ADD COLUMN task_revision INTEGER NOT NULL DEFAULT 1
  CHECK (task_revision > 0);
ALTER TABLE agent_tasks ADD COLUMN definition_revision INTEGER NOT NULL DEFAULT 1
  CHECK (definition_revision > 0);
ALTER TABLE agent_tasks ADD COLUMN criteria_revision INTEGER NOT NULL DEFAULT 1
  CHECK (criteria_revision > 0);
ALTER TABLE agent_tasks ADD COLUMN max_run_attempts INTEGER NOT NULL DEFAULT 1000
  CHECK (max_run_attempts BETWEEN 1 AND 1000);
ALTER TABLE agent_tasks ADD COLUMN max_execution_duration_seconds INTEGER NOT NULL
  DEFAULT 2592000 CHECK (max_execution_duration_seconds BETWEEN 1 AND 2592000);
ALTER TABLE agent_tasks ADD COLUMN budget_run_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (budget_run_attempts >= 0);
ALTER TABLE agent_tasks ADD COLUMN budget_execution_duration_seconds INTEGER NOT NULL
  DEFAULT 0 CHECK (budget_execution_duration_seconds >= 0);
ALTER TABLE agent_tasks ADD COLUMN budget_usage_revision INTEGER NOT NULL DEFAULT 0
  CHECK (budget_usage_revision >= 0);
ALTER TABLE agent_tasks ADD COLUMN completion_result_id TEXT;

UPDATE agent_tasks
SET team_id = (
      SELECT rooms.team_id FROM rooms WHERE rooms.room_id = agent_tasks.room_id
    ),
    owner_member_id = created_by_member_id,
    lifecycle_state = CASE state
      WHEN 'working' THEN 'active'
      WHEN 'blocked' THEN 'active'
      WHEN 'review' THEN 'review'
      WHEN 'completed' THEN 'completed'
      WHEN 'canceled' THEN 'canceled'
      ELSE CASE
        WHEN is_default = 1 OR EXISTS (
          SELECT 1 FROM runs WHERE runs.task_id = agent_tasks.task_id
        ) OR EXISTS (
          SELECT 1 FROM discussions WHERE discussions.task_id = agent_tasks.task_id
        ) THEN 'active'
        ELSE 'ready'
      END
    END;

UPDATE agent_tasks AS task
SET task_display_number = (
  SELECT COUNT(*)
  FROM agent_tasks AS earlier
  WHERE earlier.team_id = task.team_id
    AND (
      earlier.created_at < task.created_at OR
      (earlier.created_at = task.created_at AND earlier.task_id <= task.task_id)
    )
);

UPDATE agent_tasks
SET is_default = 0
WHERE is_default = 1 AND lifecycle_state IN ('completed', 'canceled');

DROP TRIGGER rooms_create_default_agent_task;

INSERT INTO agent_tasks (
  task_id, room_id, parent_task_id, title, goal, state, primary_agent_id,
  workspace_ref, summary, last_room_sequence, created_by_member_id,
  is_default, created_at, updated_at, team_id, task_display_number,
  owner_member_id, lifecycle_state, scheduling_state, completion_policy,
  priority, due_at, task_revision, definition_revision, criteria_revision,
  max_run_attempts, max_execution_duration_seconds, budget_run_attempts,
  budget_execution_duration_seconds, budget_usage_revision,
  completion_result_id
)
SELECT
  'task_default_active_' || substr(room.room_id, 6),
  room.room_id,
  NULL,
  'Room work',
  'Continue work in this Room.',
  'working',
  NULL,
  NULL,
  '',
  0,
  owner.member_id,
  1,
  room.created_at,
  room.created_at,
  room.team_id,
  COALESCE((
    SELECT MAX(existing.task_display_number) + 1
    FROM agent_tasks existing WHERE existing.team_id = room.team_id
  ), 1),
  owner.member_id,
  'active',
  'enabled',
  'owner_confirmed',
  'normal',
  NULL,
  1,
  1,
  1,
  1000,
  2592000,
  0,
  0,
  0,
  NULL
FROM rooms room
JOIN team_members owner ON owner.member_id = (
  SELECT member.member_id
  FROM team_members member
  WHERE member.team_id = room.team_id
  ORDER BY CASE member.role WHEN 'owner' THEN 0 ELSE 1 END,
           member.created_at,
           member.member_id
  LIMIT 1
)
WHERE NOT EXISTS (
  SELECT 1 FROM agent_tasks active_default
  WHERE active_default.room_id = room.room_id AND active_default.is_default = 1
);

CREATE UNIQUE INDEX agent_tasks_team_display_number_idx
  ON agent_tasks(team_id, task_display_number);
CREATE INDEX agent_tasks_owner_lifecycle_idx
  ON agent_tasks(team_id, owner_member_id, lifecycle_state, updated_at, task_id);

CREATE TABLE task_definition_revisions (
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  goal TEXT NOT NULL CHECK (length(trim(goal)) BETWEEN 1 AND 20000),
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, definition_revision)
) STRICT;

CREATE TABLE task_criteria_revisions (
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  criteria_revision INTEGER NOT NULL CHECK (criteria_revision > 0),
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, criteria_revision)
) STRICT;

CREATE TABLE task_criteria_entries (
  task_id TEXT NOT NULL,
  criteria_revision INTEGER NOT NULL,
  criterion_key TEXT NOT NULL CHECK (criterion_key GLOB 'criterion_*'),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  PRIMARY KEY (task_id, criteria_revision, criterion_key),
  UNIQUE (task_id, criteria_revision, ordinal),
  FOREIGN KEY (task_id, criteria_revision)
    REFERENCES task_criteria_revisions(task_id, criteria_revision)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE task_agent_assignments (
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('primary', 'contributor', 'reviewer')),
  assigned_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, agent_id)
) STRICT;

CREATE UNIQUE INDEX task_assignments_one_primary_idx
  ON task_agent_assignments(task_id) WHERE role = 'primary';

CREATE TABLE task_blocks (
  block_id TEXT PRIMARY KEY CHECK (block_id GLOB 'block_*'),
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  resolved_by_member_id TEXT
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  resolved_at TEXT
) STRICT;

CREATE INDEX task_blocks_open_idx
  ON task_blocks(task_id, state, created_at, block_id);

CREATE TABLE task_budget_ledger (
  budget_event_id TEXT PRIMARY KEY CHECK (budget_event_id GLOB 'budget_*'),
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  run_attempt_delta INTEGER NOT NULL CHECK (run_attempt_delta IN (0, 1)),
  execution_duration_seconds_delta INTEGER NOT NULL
    CHECK (execution_duration_seconds_delta >= 0),
  recorded_at TEXT NOT NULL,
  UNIQUE (task_id, run_id)
) STRICT;

INSERT INTO task_budget_ledger (
  budget_event_id, task_id, run_id, run_attempt_delta,
  execution_duration_seconds_delta, recorded_at
)
SELECT
  'budget_run_' || substr(run_id, 5), task_id, run_id, 1,
  CASE
    WHEN state IN ('completed', 'failed', 'canceled', 'expired', 'outcome_unknown')
    THEN max(0, unixepoch(updated_at) - unixepoch(created_at))
    ELSE 0
  END,
  updated_at
FROM runs;

UPDATE agent_tasks AS task
SET budget_run_attempts = (
      SELECT COUNT(*) FROM runs WHERE runs.task_id = task.task_id
    ),
    budget_execution_duration_seconds = COALESCE((
      SELECT SUM(execution_duration_seconds_delta)
      FROM task_budget_ledger ledger WHERE ledger.task_id = task.task_id
    ), 0),
    budget_usage_revision = (
      SELECT COUNT(*) FROM runs WHERE runs.task_id = task.task_id
    );

CREATE TABLE task_mutation_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  resulting_task_revision INTEGER NOT NULL CHECK (resulting_task_revision > 0),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO task_definition_revisions (
  task_id, definition_revision, title, goal, created_by_member_id, created_at
)
SELECT task_id, 1, title, goal, created_by_member_id, created_at
FROM agent_tasks;

INSERT INTO task_criteria_revisions (
  task_id, criteria_revision, created_by_member_id, created_at
)
SELECT task_id, 1, created_by_member_id, created_at
FROM agent_tasks;

INSERT INTO task_agent_assignments (
  task_id, agent_id, role, assigned_by_member_id, assigned_at
)
SELECT task_id, primary_agent_id, 'primary', created_by_member_id, created_at
FROM agent_tasks
WHERE is_default = 0 AND primary_agent_id IS NOT NULL;

INSERT INTO task_blocks (
  block_id, task_id, reason, state, created_by_member_id, created_at,
  resolved_by_member_id, resolved_at
)
SELECT
  'block_migrated_' || substr(task_id, 6), task_id,
  'Migrated from legacy blocked Task state.', 'open',
  created_by_member_id, updated_at, NULL, NULL
FROM agent_tasks
WHERE state = 'blocked';

CREATE TRIGGER agent_tasks_require_work_identity_insert
BEFORE INSERT ON agent_tasks
WHEN NEW.team_id IS NULL OR NEW.task_display_number IS NULL OR
     NEW.task_display_number < 1 OR NEW.owner_member_id IS NULL OR
     NOT EXISTS (
       SELECT 1 FROM rooms room
       WHERE room.room_id = NEW.room_id AND room.team_id = NEW.team_id
     ) OR NOT EXISTS (
       SELECT 1 FROM team_members member
       WHERE member.member_id = NEW.owner_member_id
         AND member.team_id = NEW.team_id
     )
BEGIN
  SELECT RAISE(ABORT, 'Task work identity is invalid');
END;

CREATE TRIGGER agent_tasks_require_work_identity_update
BEFORE UPDATE OF room_id, team_id, task_display_number, owner_member_id
ON agent_tasks
WHEN NEW.team_id IS NULL OR NEW.task_display_number IS NULL OR
     NEW.task_display_number < 1 OR NEW.owner_member_id IS NULL OR
     NOT EXISTS (
       SELECT 1 FROM rooms room
       WHERE room.room_id = NEW.room_id AND room.team_id = NEW.team_id
     ) OR NOT EXISTS (
       SELECT 1 FROM team_members member
       WHERE member.member_id = NEW.owner_member_id
         AND member.team_id = NEW.team_id
     )
BEGIN
  SELECT RAISE(ABORT, 'Task work identity is invalid');
END;

CREATE TRIGGER agent_tasks_protect_permanent_default_update
BEFORE UPDATE OF is_default, lifecycle_state, scheduling_state ON agent_tasks
WHEN OLD.is_default = 1 AND (
  NEW.is_default <> 1 OR NEW.lifecycle_state <> 'active' OR
  NEW.scheduling_state <> 'enabled'
)
BEGIN
  SELECT RAISE(ABORT, 'Default Task is permanently active');
END;

CREATE TRIGGER agent_tasks_protect_permanent_default_delete
BEFORE DELETE ON agent_tasks
WHEN OLD.is_default = 1
BEGIN
  SELECT RAISE(ABORT, 'Default Task cannot be deleted');
END;

CREATE TRIGGER task_budget_count_run_insert
AFTER INSERT ON runs
BEGIN
  INSERT INTO task_budget_ledger (
    budget_event_id, task_id, run_id, run_attempt_delta,
    execution_duration_seconds_delta, recorded_at
  ) VALUES (
    'budget_run_' || substr(NEW.run_id, 5), NEW.task_id, NEW.run_id, 1, 0,
    NEW.created_at
  );

  UPDATE agent_tasks
  SET budget_run_attempts = budget_run_attempts + 1,
      budget_usage_revision = budget_usage_revision + 1
  WHERE task_id = NEW.task_id;
END;

CREATE TRIGGER task_budget_count_terminal_duration
AFTER UPDATE OF state ON runs
WHEN OLD.state NOT IN (
  'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
) AND NEW.state IN (
  'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
)
BEGIN
  UPDATE task_budget_ledger
  SET execution_duration_seconds_delta =
        max(0, unixepoch(NEW.updated_at) - unixepoch(NEW.created_at)),
      recorded_at = NEW.updated_at
  WHERE task_id = NEW.task_id AND run_id = NEW.run_id;

  UPDATE agent_tasks
  SET budget_execution_duration_seconds =
        budget_execution_duration_seconds +
        max(0, unixepoch(NEW.updated_at) - unixepoch(NEW.created_at)),
      budget_usage_revision = budget_usage_revision + 1
  WHERE task_id = NEW.task_id;
END;

CREATE TRIGGER task_budget_rollback_run_delete
AFTER DELETE ON runs
BEGIN
  UPDATE agent_tasks
  SET budget_run_attempts = max(0, budget_run_attempts - 1),
      budget_execution_duration_seconds = max(
        0,
        budget_execution_duration_seconds - CASE
          WHEN OLD.state IN (
            'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
          ) THEN max(0, unixepoch(OLD.updated_at) - unixepoch(OLD.created_at))
          ELSE 0
        END
      ),
      budget_usage_revision = budget_usage_revision + 1
  WHERE task_id = OLD.task_id;
END;

CREATE TRIGGER rooms_create_default_agent_task
AFTER INSERT ON rooms
BEGIN
  INSERT INTO agent_tasks (
    task_id, room_id, parent_task_id, title, goal, state, primary_agent_id,
    workspace_ref, summary, last_room_sequence, created_by_member_id,
    is_default, created_at, updated_at, team_id, task_display_number,
    owner_member_id, lifecycle_state, scheduling_state, completion_policy,
    priority, due_at, task_revision, definition_revision, criteria_revision,
    max_run_attempts, max_execution_duration_seconds, budget_run_attempts,
    budget_execution_duration_seconds, budget_usage_revision,
    completion_result_id
  )
  SELECT
    'task_default_' || substr(NEW.room_id, 6),
    NEW.room_id,
    NULL,
    'Room work',
    'Continue work in this Room.',
    'working',
    NULL,
    NULL,
    '',
    0,
    member.member_id,
    1,
    NEW.created_at,
    NEW.created_at,
    NEW.team_id,
    COALESCE((
      SELECT MAX(task_display_number) + 1
      FROM agent_tasks WHERE team_id = NEW.team_id
    ), 1),
    member.member_id,
    'active',
    'enabled',
    'owner_confirmed',
    'normal',
    NULL,
    1,
    1,
    1,
    1000,
    2592000,
    0,
    0,
    0,
    NULL
  FROM team_members member
  WHERE member.team_id = NEW.team_id
  ORDER BY CASE member.role WHEN 'owner' THEN 0 ELSE 1 END,
           member.created_at,
           member.member_id
  LIMIT 1;

  INSERT INTO task_definition_revisions (
    task_id, definition_revision, title, goal, created_by_member_id, created_at
  )
  SELECT task_id, 1, title, goal, created_by_member_id, created_at
  FROM agent_tasks WHERE room_id = NEW.room_id AND is_default = 1;

  INSERT INTO task_criteria_revisions (
    task_id, criteria_revision, created_by_member_id, created_at
  )
  SELECT task_id, 1, created_by_member_id, created_at
  FROM agent_tasks WHERE room_id = NEW.room_id AND is_default = 1;
END;
