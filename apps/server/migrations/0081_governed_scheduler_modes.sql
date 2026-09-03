CREATE TABLE execution_scheduler_controls (
  plan_id TEXT PRIMARY KEY REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'supervised', 'automatic')),
  mode_revision INTEGER NOT NULL CHECK (mode_revision > 0),
  last_operation_id TEXT,
  updated_by_member_id TEXT REFERENCES team_members(member_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  updated_at TEXT NOT NULL,
  CHECK (
    (mode_revision = 1 AND last_operation_id IS NULL AND
      updated_by_member_id IS NULL) OR
    (mode_revision > 1 AND last_operation_id IS NOT NULL AND
      updated_by_member_id IS NOT NULL)
  )
) STRICT;

INSERT INTO execution_scheduler_controls (
  plan_id, mode, mode_revision, last_operation_id,
  updated_by_member_id, reason, updated_at
)
SELECT plan_id, 'automatic', 1, NULL, NULL,
  'Initial automatic scheduler mode.', created_at
FROM execution_plans;

CREATE TRIGGER execution_plan_create_scheduler_control
AFTER INSERT ON execution_plans
BEGIN
  INSERT INTO execution_scheduler_controls (
    plan_id, mode, mode_revision, last_operation_id,
    updated_by_member_id, reason, updated_at
  ) VALUES (
    NEW.plan_id, 'automatic', 1, NULL, NULL,
    'Initial automatic scheduler mode.', NEW.created_at
  );
END;

CREATE TABLE execution_scheduler_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  action TEXT NOT NULL CHECK (action IN (
    'mode_transition', 'manual_dispatch', 'supervised_advance'
  )),
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_control_revision INTEGER NOT NULL CHECK (plan_control_revision > 0),
  expected_mode TEXT NOT NULL CHECK (
    expected_mode IN ('manual', 'supervised', 'automatic')
  ),
  expected_mode_revision INTEGER NOT NULL CHECK (expected_mode_revision > 0),
  target_mode TEXT CHECK (
    target_mode IS NULL OR target_mode IN ('manual', 'supervised', 'automatic')
  ),
  node_key TEXT,
  expected_node_projection_revision INTEGER CHECK (
    expected_node_projection_revision IS NULL OR
    expected_node_projection_revision > 0
  ),
  requested_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  created_at TEXT NOT NULL,
  CHECK (
    (action = 'mode_transition' AND target_mode IS NOT NULL AND
      target_mode <> expected_mode AND node_key IS NULL AND
      expected_node_projection_revision IS NULL) OR
    (action = 'manual_dispatch' AND target_mode IS NULL AND
      expected_mode = 'manual' AND node_key IS NOT NULL AND
      expected_node_projection_revision IS NOT NULL) OR
    (action = 'supervised_advance' AND target_mode IS NULL AND
      expected_mode = 'supervised' AND node_key IS NULL AND
      expected_node_projection_revision IS NULL)
  )
) STRICT;

CREATE TABLE execution_scheduler_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES execution_scheduler_operations(operation_id)
    ON DELETE RESTRICT,
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  completed_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER execution_scheduler_operations_require_scope_insert
BEFORE INSERT ON execution_scheduler_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_proposals proposal
    ON proposal.plan_id = plan.plan_id
      AND proposal.revision = plan.current_revision
  JOIN agent_tasks root ON root.task_id = plan.root_task_id
  JOIN rooms room ON room.room_id = root.room_id AND room.archived_at IS NULL
  JOIN team_members actor
    ON actor.member_id = NEW.requested_by_member_id
      AND actor.team_id = room.team_id
  JOIN room_human_participants participant
    ON participant.room_id = room.room_id
      AND participant.member_id = actor.member_id
  JOIN execution_scheduler_controls control ON control.plan_id = plan.plan_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND proposal.digest = NEW.plan_digest
    AND plan.control_revision = NEW.plan_control_revision
    AND control.mode = NEW.expected_mode
    AND control.mode_revision = NEW.expected_mode_revision
    AND plan.state NOT IN ('completed', 'canceled')
    AND (actor.role = 'owner' OR actor.member_id = root.owner_member_id)
    AND json_extract(NEW.request_json, '$.operationId') = NEW.operation_id
    AND json_extract(NEW.request_json, '$.expectedPlanRevision') =
      NEW.plan_revision
    AND json_extract(NEW.request_json, '$.expectedPlanDigest') = NEW.plan_digest
    AND json_extract(NEW.request_json, '$.expectedPlanControlRevision') =
      NEW.plan_control_revision
    AND json_extract(NEW.request_json, '$.expectedModeRevision') =
      NEW.expected_mode_revision
    AND json_extract(NEW.request_json, '$.reason') = NEW.reason
    AND (
      (NEW.action = 'mode_transition' AND
        json_extract(NEW.request_json, '$.mode') = NEW.target_mode) OR
      (NEW.action = 'manual_dispatch' AND
        plan.state IN ('approved', 'running') AND
        json_extract(NEW.request_json, '$.nodeKey') = NEW.node_key AND
        json_extract(NEW.request_json, '$.expectedNodeProjectionRevision') =
          NEW.expected_node_projection_revision AND
        EXISTS (
          SELECT 1 FROM execution_node_states state
          WHERE state.plan_id = NEW.plan_id
            AND state.plan_revision = NEW.plan_revision
            AND state.node_key = NEW.node_key
            AND state.projection_revision =
              NEW.expected_node_projection_revision
            AND state.run_id IS NULL
        )) OR
      (NEW.action = 'supervised_advance' AND
        plan.state IN ('approved', 'running'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler operation scope is not current');
END;

CREATE TRIGGER execution_scheduler_operations_immutable_update
BEFORE UPDATE ON execution_scheduler_operations
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler operation is immutable');
END;

CREATE TRIGGER execution_scheduler_operations_immutable_delete
BEFORE DELETE ON execution_scheduler_operations
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler operation is immutable');
END;

ALTER TABLE execution_dispatch_intents
  ADD COLUMN scheduler_operation_id TEXT
    REFERENCES execution_scheduler_operations(operation_id) ON DELETE RESTRICT;

CREATE TRIGGER execution_scheduler_receipts_require_operation_insert
BEFORE INSERT ON execution_scheduler_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM execution_scheduler_operations operation
  WHERE operation.operation_id = NEW.operation_id
    AND json_extract(NEW.response_json, '$.operationId') = NEW.operation_id
    AND json_extract(NEW.response_json, '$.operationDigest') =
      NEW.operation_digest
    AND CASE operation.action
      WHEN 'mode_transition' THEN
        json_extract(NEW.response_json, '$.updatedAt') = NEW.completed_at
      ELSE json_extract(NEW.response_json, '$.createdAt') = NEW.completed_at
    END
    AND json_extract(NEW.response_json, '$.planId') = operation.plan_id
    AND json_extract(NEW.response_json, '$.planRevision') =
      operation.plan_revision
    AND json_extract(NEW.response_json, '$.planDigest') = operation.plan_digest
    AND json_extract(NEW.response_json, '$.planControlRevision') =
      operation.plan_control_revision
    AND json_extract(NEW.response_json, '$.requestDigest') =
      operation.request_digest
    AND json_extract(NEW.response_json, '$.reason') = operation.reason
    AND (
      (operation.action = 'mode_transition' AND EXISTS (
        SELECT 1 FROM execution_scheduler_controls control
        WHERE control.plan_id = operation.plan_id
          AND control.last_operation_id = operation.operation_id
          AND control.mode = operation.target_mode
          AND control.mode_revision = operation.expected_mode_revision + 1
          AND control.updated_by_member_id = operation.requested_by_member_id
          AND json_extract(NEW.response_json, '$.previousMode') =
            operation.expected_mode
          AND json_extract(NEW.response_json, '$.previousModeRevision') =
            operation.expected_mode_revision
          AND json_extract(NEW.response_json, '$.mode') = operation.target_mode
          AND json_extract(NEW.response_json, '$.modeRevision') =
            control.mode_revision
          AND json_extract(NEW.response_json, '$.updatedByMemberId') =
            operation.requested_by_member_id
      )) OR
      (operation.action IN ('manual_dispatch', 'supervised_advance') AND
        json_extract(NEW.response_json, '$.action') = operation.action AND
        json_extract(NEW.response_json, '$.mode') = operation.expected_mode AND
        json_extract(NEW.response_json, '$.modeRevision') =
          operation.expected_mode_revision AND
        json_extract(NEW.response_json, '$.requestedByMemberId') =
          operation.requested_by_member_id AND
        (
          (operation.action = 'supervised_advance' AND
            json_type(NEW.response_json, '$.selection') = 'null' AND
            NOT EXISTS (
              SELECT 1 FROM execution_dispatch_intents selected
              WHERE selected.scheduler_operation_id = operation.operation_id
            )) OR
          EXISTS (
            SELECT 1 FROM execution_dispatch_intents intent
            WHERE intent.scheduler_operation_id = operation.operation_id
              AND intent.plan_id = operation.plan_id
              AND intent.plan_revision = operation.plan_revision
              AND (operation.node_key IS NULL OR
                intent.node_key = operation.node_key)
              AND intent.node_key = json_extract(
                NEW.response_json,
                '$.selection.nodeKey'
              )
              AND intent.intent_id = json_extract(
                NEW.response_json,
                '$.selection.dispatchIntentId'
              )
              AND intent.run_id = json_extract(
                NEW.response_json,
                '$.selection.runId'
              )
          )
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler receipt is detached');
END;

CREATE TRIGGER execution_scheduler_receipts_immutable_update
BEFORE UPDATE ON execution_scheduler_receipts
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler receipt is immutable');
END;

CREATE TRIGGER execution_scheduler_receipts_immutable_delete
BEFORE DELETE ON execution_scheduler_receipts
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler receipt is immutable');
END;

CREATE TRIGGER execution_scheduler_controls_transition_guard
BEFORE UPDATE ON execution_scheduler_controls
WHEN NOT (
  NEW.plan_id = OLD.plan_id AND
  NEW.mode_revision = OLD.mode_revision + 1 AND
  NEW.mode <> OLD.mode AND
  NEW.last_operation_id IS NOT NULL AND
  NEW.updated_by_member_id IS NOT NULL AND
  EXISTS (
    SELECT 1 FROM execution_scheduler_operations operation
    WHERE operation.operation_id = NEW.last_operation_id
      AND operation.action = 'mode_transition'
      AND operation.plan_id = OLD.plan_id
      AND operation.expected_mode = OLD.mode
      AND operation.expected_mode_revision = OLD.mode_revision
      AND operation.target_mode = NEW.mode
      AND operation.requested_by_member_id = NEW.updated_by_member_id
      AND operation.reason = NEW.reason
      AND operation.created_at = NEW.updated_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler control transition is invalid');
END;

CREATE TRIGGER execution_scheduler_controls_immutable_delete
BEFORE DELETE ON execution_scheduler_controls
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler control cannot be deleted');
END;

CREATE TRIGGER execution_dispatch_intents_require_scheduler_mode_insert
BEFORE INSERT ON execution_dispatch_intents
WHEN (
  NEW.source <> 'scheduler' AND NEW.scheduler_operation_id IS NOT NULL
) OR (
  NEW.source = 'scheduler' AND NOT EXISTS (
    SELECT 1
    FROM execution_scheduler_controls control
    LEFT JOIN execution_scheduler_operations operation
      ON operation.operation_id = NEW.scheduler_operation_id
    WHERE control.plan_id = NEW.plan_id
      AND (
        (NEW.scheduler_operation_id IS NULL AND
          control.mode = 'automatic') OR
        (NEW.scheduler_operation_id IS NOT NULL AND
          operation.plan_id = NEW.plan_id AND
          operation.plan_revision = NEW.plan_revision AND
          operation.plan_digest = NEW.plan_digest AND
          operation.plan_control_revision = NEW.plan_control_revision AND
          operation.expected_mode_revision = control.mode_revision AND
          operation.expected_mode = control.mode AND
          (
            (operation.action = 'manual_dispatch' AND
              control.mode = 'manual' AND operation.node_key = NEW.node_key) OR
            (operation.action = 'supervised_advance' AND
              control.mode = 'supervised')
          )
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler mode does not authorize intent');
END;

CREATE TABLE execution_scheduler_fairness_history (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  cursor_revision INTEGER NOT NULL CHECK (cursor_revision > 0),
  previous_plan_id TEXT,
  previous_plan_revision INTEGER,
  previous_node_key TEXT,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'member_message', 'node_retry', 'manual', 'supervised', 'automatic'
  )),
  scheduler_operation_id TEXT
    REFERENCES execution_scheduler_operations(operation_id) ON DELETE RESTRICT,
  dispatch_intent_id TEXT NOT NULL
    REFERENCES execution_dispatch_intents(intent_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, cursor_revision),
  UNIQUE (dispatch_intent_id),
  UNIQUE (run_id),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
      ON DELETE RESTRICT,
  CHECK (
    (cursor_revision = 1 AND previous_plan_id IS NULL AND
      previous_plan_revision IS NULL AND previous_node_key IS NULL) OR
    (cursor_revision > 1 AND previous_plan_id IS NOT NULL AND
      previous_plan_revision IS NOT NULL AND previous_node_key IS NOT NULL)
  )
) STRICT;

WITH ranked AS (
  SELECT intent.*,
    row_number() OVER (
      PARTITION BY intent.agent_id
      ORDER BY intent.created_at, intent.intent_id
    ) AS cursor_revision,
    lag(intent.plan_id) OVER (
      PARTITION BY intent.agent_id
      ORDER BY intent.created_at, intent.intent_id
    ) AS previous_plan_id,
    lag(intent.plan_revision) OVER (
      PARTITION BY intent.agent_id
      ORDER BY intent.created_at, intent.intent_id
    ) AS previous_plan_revision,
    lag(intent.node_key) OVER (
      PARTITION BY intent.agent_id
      ORDER BY intent.created_at, intent.intent_id
    ) AS previous_node_key
  FROM execution_dispatch_intents intent
)
INSERT INTO execution_scheduler_fairness_history (
  agent_id, cursor_revision,
  previous_plan_id, previous_plan_revision, previous_node_key,
  plan_id, plan_revision, node_key, source, scheduler_operation_id,
  dispatch_intent_id, run_id, admitted_at
)
SELECT agent_id, cursor_revision,
  previous_plan_id, previous_plan_revision, previous_node_key,
  plan_id, plan_revision, node_key,
  CASE
    WHEN retry_operation_id IS NOT NULL THEN 'node_retry'
    WHEN source = 'member_message' THEN 'member_message'
    ELSE 'automatic'
  END,
  NULL, intent_id, run_id, created_at
FROM ranked;

CREATE TABLE execution_scheduler_fairness_cursors (
  agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE RESTRICT,
  cursor_revision INTEGER NOT NULL CHECK (cursor_revision > 0),
  last_plan_id TEXT NOT NULL,
  last_plan_revision INTEGER NOT NULL CHECK (last_plan_revision > 0),
  last_node_key TEXT NOT NULL,
  last_dispatch_intent_id TEXT NOT NULL UNIQUE
    REFERENCES execution_dispatch_intents(intent_id) ON DELETE RESTRICT,
  last_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, cursor_revision)
    REFERENCES execution_scheduler_fairness_history(agent_id, cursor_revision)
      ON DELETE RESTRICT,
  FOREIGN KEY (last_plan_id, last_plan_revision, last_node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
      ON DELETE RESTRICT
) STRICT;

INSERT INTO execution_scheduler_fairness_cursors (
  agent_id, cursor_revision, last_plan_id, last_plan_revision, last_node_key,
  last_dispatch_intent_id, last_run_id, updated_at
)
SELECT history.agent_id, history.cursor_revision,
  history.plan_id, history.plan_revision, history.node_key,
  history.dispatch_intent_id, history.run_id, history.admitted_at
FROM execution_scheduler_fairness_history history
JOIN (
  SELECT agent_id, max(cursor_revision) AS cursor_revision
  FROM execution_scheduler_fairness_history GROUP BY agent_id
) latest ON latest.agent_id = history.agent_id
  AND latest.cursor_revision = history.cursor_revision;

CREATE TRIGGER execution_scheduler_fairness_history_require_admission_insert
BEFORE INSERT ON execution_scheduler_fairness_history
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_dispatch_intents intent
  LEFT JOIN execution_scheduler_operations operation
    ON operation.operation_id = intent.scheduler_operation_id
  WHERE intent.intent_id = NEW.dispatch_intent_id
    AND intent.run_id = NEW.run_id
    AND intent.agent_id = NEW.agent_id
    AND intent.plan_id = NEW.plan_id
    AND intent.plan_revision = NEW.plan_revision
    AND intent.node_key = NEW.node_key
    AND intent.created_at = NEW.admitted_at
    AND intent.scheduler_operation_id IS NEW.scheduler_operation_id
    AND (
      (NEW.source = 'node_retry' AND intent.retry_operation_id IS NOT NULL) OR
      (NEW.source = 'member_message' AND intent.retry_operation_id IS NULL AND
        intent.source = 'member_message') OR
      (NEW.source = 'automatic' AND intent.source = 'scheduler' AND
        intent.scheduler_operation_id IS NULL) OR
      (NEW.source = 'manual' AND intent.source = 'scheduler' AND
        operation.action = 'manual_dispatch') OR
      (NEW.source = 'supervised' AND intent.source = 'scheduler' AND
        operation.action = 'supervised_advance')
    )
    AND (
      (NEW.cursor_revision = 1 AND NEW.previous_plan_id IS NULL AND
        NEW.previous_plan_revision IS NULL AND NEW.previous_node_key IS NULL AND
        NOT EXISTS (
          SELECT 1 FROM execution_scheduler_fairness_history previous
          WHERE previous.agent_id = NEW.agent_id
        )) OR
      (NEW.cursor_revision > 1 AND EXISTS (
        SELECT 1 FROM execution_scheduler_fairness_history previous
        WHERE previous.agent_id = NEW.agent_id
          AND previous.cursor_revision = NEW.cursor_revision - 1
          AND previous.plan_id = NEW.previous_plan_id
          AND previous.plan_revision = NEW.previous_plan_revision
          AND previous.node_key = NEW.previous_node_key
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler fairness history is detached');
END;

CREATE TRIGGER execution_scheduler_fairness_history_immutable_update
BEFORE UPDATE ON execution_scheduler_fairness_history
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler fairness history is immutable');
END;

CREATE TRIGGER execution_scheduler_fairness_history_immutable_delete
BEFORE DELETE ON execution_scheduler_fairness_history
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler fairness history is immutable');
END;

CREATE TRIGGER execution_scheduler_fairness_cursor_insert_guard
BEFORE INSERT ON execution_scheduler_fairness_cursors
WHEN NEW.cursor_revision <> 1 OR NOT EXISTS (
  SELECT 1 FROM execution_scheduler_fairness_history history
  WHERE history.agent_id = NEW.agent_id
    AND history.cursor_revision = NEW.cursor_revision
    AND history.plan_id = NEW.last_plan_id
    AND history.plan_revision = NEW.last_plan_revision
    AND history.node_key = NEW.last_node_key
    AND history.dispatch_intent_id = NEW.last_dispatch_intent_id
    AND history.run_id = NEW.last_run_id
    AND history.admitted_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler fairness cursor insert is invalid');
END;

CREATE TRIGGER execution_scheduler_fairness_cursor_update_guard
BEFORE UPDATE ON execution_scheduler_fairness_cursors
WHEN NOT (
  NEW.agent_id = OLD.agent_id AND
  NEW.cursor_revision = OLD.cursor_revision + 1 AND
  EXISTS (
    SELECT 1 FROM execution_scheduler_fairness_history history
    WHERE history.agent_id = NEW.agent_id
      AND history.cursor_revision = NEW.cursor_revision
      AND history.previous_plan_id = OLD.last_plan_id
      AND history.previous_plan_revision = OLD.last_plan_revision
      AND history.previous_node_key = OLD.last_node_key
      AND history.plan_id = NEW.last_plan_id
      AND history.plan_revision = NEW.last_plan_revision
      AND history.node_key = NEW.last_node_key
      AND history.dispatch_intent_id = NEW.last_dispatch_intent_id
      AND history.run_id = NEW.last_run_id
      AND history.admitted_at = NEW.updated_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler fairness cursor update is invalid');
END;

CREATE TRIGGER execution_scheduler_fairness_cursor_immutable_delete
BEFORE DELETE ON execution_scheduler_fairness_cursors
BEGIN
  SELECT RAISE(ABORT, 'Execution scheduler fairness cursor cannot be deleted');
END;
