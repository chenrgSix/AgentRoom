CREATE TABLE agent_tasks (
  task_id TEXT PRIMARY KEY CHECK (task_id GLOB 'task_*'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  parent_task_id TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  goal TEXT NOT NULL CHECK (length(trim(goal)) BETWEEN 1 AND 20000),
  state TEXT NOT NULL CHECK (state IN (
    'open', 'working', 'blocked', 'review', 'completed', 'canceled'
  )),
  primary_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  workspace_ref TEXT CHECK (
    workspace_ref IS NULL OR length(trim(workspace_ref)) BETWEEN 1 AND 512
  ),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 20000),
  last_room_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (last_room_sequence >= 0),
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, room_id),
  FOREIGN KEY (parent_task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX agent_tasks_room_state_idx
  ON agent_tasks(room_id, state, updated_at, task_id);
CREATE UNIQUE INDEX agent_tasks_one_default_per_room_idx
  ON agent_tasks(room_id) WHERE is_default = 1;

INSERT INTO agent_tasks (
  task_id, room_id, parent_task_id, title, goal, state, primary_agent_id,
  workspace_ref, summary, last_room_sequence, created_by_member_id,
  is_default, created_at, updated_at
)
SELECT
  'task_default_' || substr(r.room_id, 6),
  r.room_id,
  NULL,
  'Room work',
  'Continue the existing Room work.',
  'open',
  NULL,
  NULL,
  '',
  0,
  (
    SELECT tm.member_id
    FROM team_members tm
    WHERE tm.team_id = r.team_id
    ORDER BY CASE tm.role WHEN 'owner' THEN 0 ELSE 1 END,
             tm.created_at,
             tm.member_id
    LIMIT 1
  ),
  1,
  r.created_at,
  r.created_at
FROM rooms r;

CREATE TRIGGER rooms_create_default_agent_task
AFTER INSERT ON rooms
BEGIN
  INSERT INTO agent_tasks (
    task_id, room_id, parent_task_id, title, goal, state, primary_agent_id,
    workspace_ref, summary, last_room_sequence, created_by_member_id,
    is_default, created_at, updated_at
  )
  SELECT
    'task_default_' || substr(NEW.room_id, 6),
    NEW.room_id,
    NULL,
    'Room work',
    'Continue work in this Room.',
    'open',
    NULL,
    NULL,
    '',
    0,
    tm.member_id,
    1,
    NEW.created_at,
    NEW.created_at
  FROM team_members tm
  WHERE tm.team_id = NEW.team_id
  ORDER BY CASE tm.role WHEN 'owner' THEN 0 ELSE 1 END,
           tm.created_at,
           tm.member_id
  LIMIT 1;
END;

ALTER TABLE messages
  ADD COLUMN task_id TEXT REFERENCES agent_tasks(task_id) ON DELETE RESTRICT;

UPDATE messages
SET task_id = (
  SELECT task_id FROM agent_tasks
  WHERE agent_tasks.room_id = messages.room_id AND is_default = 1
);

CREATE INDEX messages_task_sequence_idx
  ON messages(task_id, sequence);

CREATE TRIGGER messages_require_room_task_insert
BEFORE INSERT ON messages
WHEN NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE task_id = NEW.task_id AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Message Task must belong to its Room');
END;

CREATE TRIGGER messages_require_room_task_update
BEFORE UPDATE OF task_id, room_id ON messages
WHEN NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE task_id = NEW.task_id AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Message Task must belong to its Room');
END;

ALTER TABLE runs
  ADD COLUMN task_id TEXT REFERENCES agent_tasks(task_id) ON DELETE RESTRICT;

UPDATE runs
SET task_id = (
  SELECT task_id FROM agent_tasks
  WHERE agent_tasks.room_id = runs.room_id AND is_default = 1
);

CREATE INDEX runs_task_state_idx
  ON runs(task_id, state, created_at, run_id);

CREATE TRIGGER runs_require_room_task_insert
BEFORE INSERT ON runs
WHEN NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE task_id = NEW.task_id AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Run Task must belong to its Room');
END;

CREATE TRIGGER runs_require_room_task_update
BEFORE UPDATE OF task_id, room_id ON runs
WHEN NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE task_id = NEW.task_id AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Run Task must belong to its Room');
END;

ALTER TABLE discussions
  ADD COLUMN task_id TEXT REFERENCES agent_tasks(task_id) ON DELETE RESTRICT;

UPDATE discussions
SET task_id = (
  SELECT task_id FROM agent_tasks
  WHERE agent_tasks.room_id = discussions.room_id AND is_default = 1
);

CREATE INDEX discussions_task_state_idx
  ON discussions(task_id, state, updated_at, discussion_id);
CREATE UNIQUE INDEX discussions_one_active_per_task_idx
  ON discussions(task_id)
  WHERE state NOT IN ('completed', 'canceled', 'terminated');

CREATE TRIGGER discussions_require_room_task_insert
BEFORE INSERT ON discussions
WHEN NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE task_id = NEW.task_id AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Discussion Task must belong to its Room');
END;

CREATE TRIGGER discussions_require_room_task_update
BEFORE UPDATE OF task_id, room_id ON discussions
WHEN NEW.task_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_tasks
  WHERE task_id = NEW.task_id AND room_id = NEW.room_id
)
BEGIN
  SELECT RAISE(ABORT, 'Discussion Task must belong to its Room');
END;
