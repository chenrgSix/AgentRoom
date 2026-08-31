-- Draft coordination only. No Tasks, Runs, grants or execution are created here.
CREATE TABLE execution_plans (
  plan_id TEXT PRIMARY KEY CHECK (plan_id GLOB 'plan_*'),
  root_task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  owner_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  control_revision INTEGER NOT NULL DEFAULT 1 CHECK (control_revision > 0),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (
    state IN ('draft', 'approved', 'running', 'paused', 'review', 'completed', 'canceled')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, root_task_id, room_id),
  FOREIGN KEY (root_task_id, room_id) REFERENCES agent_tasks(task_id, room_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, current_revision)
    REFERENCES execution_plan_revisions(plan_id, revision)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX execution_plans_room_idx ON execution_plans(room_id, plan_id);
CREATE INDEX execution_plans_root_idx ON execution_plans(root_task_id, plan_id);

CREATE TABLE execution_decisions (
  decision_id TEXT PRIMARY KEY CHECK (decision_id GLOB 'decision_*'),
  root_task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  author_json TEXT NOT NULL CHECK (json_valid(author_json)),
  supersedes_decision_id TEXT REFERENCES execution_decisions(decision_id)
    ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (decision_id, root_task_id, room_id),
  FOREIGN KEY (root_task_id, room_id) REFERENCES agent_tasks(task_id, room_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_decision_id, root_task_id, room_id)
    REFERENCES execution_decisions(decision_id, root_task_id, room_id)
) STRICT;

CREATE TABLE execution_decision_sources (
  decision_id TEXT NOT NULL REFERENCES execution_decisions(decision_id) ON DELETE RESTRICT,
  evidence_ref_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  PRIMARY KEY (decision_id, evidence_ref_id)
) STRICT;

CREATE TABLE execution_plan_proposals (
  proposal_id TEXT PRIMARY KEY CHECK (proposal_id GLOB 'proposal_*'),
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  root_task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  root_task_revision INTEGER NOT NULL CHECK (root_task_revision > 0),
  decision_id TEXT NOT NULL UNIQUE,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  author_json TEXT NOT NULL CHECK (json_valid(author_json)),
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, revision),
  UNIQUE (plan_id, revision, proposal_id),
  FOREIGN KEY (plan_id, root_task_id, room_id)
    REFERENCES execution_plans(plan_id, root_task_id, room_id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_id, root_task_id, room_id)
    REFERENCES execution_decisions(decision_id, root_task_id, room_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_plan_revisions (
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  proposal_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (plan_id, revision),
  FOREIGN KEY (plan_id, revision, proposal_id)
    REFERENCES execution_plan_proposals(plan_id, revision, proposal_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_plan_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  action TEXT NOT NULL CHECK (action IN ('create', 'revise')),
  actor_key TEXT NOT NULL,
  root_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER execution_plan_root_scope_insert
BEFORE INSERT ON execution_plans
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks task
  JOIN room_human_participants member ON member.room_id = task.room_id
    AND member.member_id = NEW.owner_member_id
  WHERE task.task_id = NEW.root_task_id AND task.room_id = NEW.room_id
    AND task.is_default = 0 AND task.parent_task_id IS NULL
    AND task.owner_member_id = NEW.owner_member_id
)
BEGIN
  SELECT RAISE(ABORT, 'Execution plan root scope is invalid');
END;

CREATE TRIGGER execution_plan_identity_immutable
BEFORE UPDATE OF plan_id, root_task_id, room_id, owner_member_id, created_at ON execution_plans
BEGIN
  SELECT RAISE(ABORT, 'Execution plan identity is immutable');
END;

CREATE TRIGGER execution_plan_revision_monotonic
BEFORE UPDATE OF current_revision ON execution_plans
WHEN NEW.current_revision <> OLD.current_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'Execution plan revision must advance exactly once');
END;

CREATE TRIGGER execution_decision_sources_sealed_insert
BEFORE INSERT ON execution_decision_sources
WHEN EXISTS (
  SELECT 1 FROM execution_plan_proposals WHERE decision_id = NEW.decision_id
)
BEGIN SELECT RAISE(ABORT, 'Execution source snapshots are sealed'); END;

CREATE TRIGGER execution_proposal_require_exact_decision_insert
BEFORE INSERT ON execution_plan_proposals
WHEN NOT EXISTS (
  SELECT 1 FROM execution_decisions decision
  WHERE decision.decision_id = NEW.decision_id
    AND decision.author_json = NEW.author_json
    AND decision.content_json = json_extract(NEW.definition_json, '$.decision')
    AND decision.root_task_id = json_extract(NEW.definition_json, '$.rootTaskId')
    AND (SELECT count(*) FROM execution_decision_sources source
      WHERE source.decision_id = NEW.decision_id)
      = json_array_length(decision.content_json, '$.sources')
    AND NOT EXISTS (
      SELECT 1 FROM json_each(decision.content_json, '$.sources') expected
      WHERE NOT EXISTS (
        SELECT 1 FROM execution_decision_sources source
        JOIN json_each(decision.content_json, '$.sourceRevisions') pin
          ON json_extract(pin.value, '$.evidenceRefId') = source.evidence_ref_id
        WHERE source.decision_id = NEW.decision_id
          AND source.source_json = expected.value
          AND source.source_revision = json_extract(pin.value, '$.revision')
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'Execution proposal must freeze its exact decision sources'); END;

CREATE TRIGGER execution_revision_order_insert
BEFORE INSERT ON execution_plan_revisions
WHEN NEW.revision <> (SELECT coalesce(max(revision), 0) + 1
  FROM execution_plan_revisions WHERE plan_id = NEW.plan_id)
BEGIN SELECT RAISE(ABORT, 'Execution revisions must be contiguous'); END;

CREATE TRIGGER execution_decisions_immutable_update BEFORE UPDATE ON execution_decisions
BEGIN SELECT RAISE(ABORT, 'Execution decisions are immutable'); END;
CREATE TRIGGER execution_decisions_immutable_delete BEFORE DELETE ON execution_decisions
BEGIN SELECT RAISE(ABORT, 'Execution decisions are immutable'); END;
CREATE TRIGGER execution_decision_sources_immutable_update BEFORE UPDATE ON execution_decision_sources
BEGIN SELECT RAISE(ABORT, 'Execution source snapshots are immutable'); END;
CREATE TRIGGER execution_decision_sources_immutable_delete BEFORE DELETE ON execution_decision_sources
BEGIN SELECT RAISE(ABORT, 'Execution source snapshots are immutable'); END;
CREATE TRIGGER execution_plan_proposals_immutable_update BEFORE UPDATE ON execution_plan_proposals
BEGIN SELECT RAISE(ABORT, 'Execution proposals are immutable'); END;
CREATE TRIGGER execution_plan_proposals_immutable_delete BEFORE DELETE ON execution_plan_proposals
BEGIN SELECT RAISE(ABORT, 'Execution proposals are immutable'); END;
CREATE TRIGGER execution_plan_revisions_immutable_update BEFORE UPDATE ON execution_plan_revisions
BEGIN SELECT RAISE(ABORT, 'Execution revisions are immutable'); END;
CREATE TRIGGER execution_plan_revisions_immutable_delete BEFORE DELETE ON execution_plan_revisions
BEGIN SELECT RAISE(ABORT, 'Execution revisions are immutable'); END;
CREATE TRIGGER execution_plan_operations_immutable_update BEFORE UPDATE ON execution_plan_operations
BEGIN SELECT RAISE(ABORT, 'Execution operation receipts are immutable'); END;
CREATE TRIGGER execution_plan_operations_immutable_delete BEFORE DELETE ON execution_plan_operations
BEGIN SELECT RAISE(ABORT, 'Execution operation receipts are immutable'); END;
