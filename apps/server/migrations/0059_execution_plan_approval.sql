CREATE UNIQUE INDEX execution_one_active_plan_per_root
ON execution_plans(root_task_id)
WHERE state IN ('approved', 'running', 'paused', 'review');

CREATE TABLE execution_plan_approvals (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  reviewed_by_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  root_task_revision_before INTEGER NOT NULL CHECK (root_task_revision_before > 0),
  root_task_revision_after INTEGER NOT NULL CHECK (
    (decision = 'approved' AND root_task_revision_after = root_task_revision_before + 1) OR
    (decision = 'rejected' AND root_task_revision_after = root_task_revision_before)
  ),
  compiled_tasks_json TEXT NOT NULL CHECK (json_valid(compiled_tasks_json)),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  reviewed_at TEXT NOT NULL,
  UNIQUE (plan_id, revision),
  FOREIGN KEY (plan_id, revision) REFERENCES execution_plan_revisions(plan_id, revision)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_plan_nodes (
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  criteria_revision INTEGER NOT NULL CHECK (criteria_revision > 0),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  owner_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE RESTRICT,
  node_json TEXT NOT NULL CHECK (json_valid(node_json)),
  task_snapshot_json TEXT NOT NULL CHECK (json_valid(task_snapshot_json)),
  PRIMARY KEY (plan_id, revision, node_key),
  UNIQUE (plan_id, revision, task_id),
  UNIQUE (plan_id, revision, node_key, task_id),
  FOREIGN KEY (plan_id, revision) REFERENCES execution_plan_approvals(plan_id, revision)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (task_id, definition_revision)
    REFERENCES task_definition_revisions(task_id, definition_revision) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, criteria_revision)
    REFERENCES task_criteria_revisions(task_id, criteria_revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_plan_edges (
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  edge_key TEXT NOT NULL,
  from_node_key TEXT NOT NULL,
  to_node_key TEXT NOT NULL CHECK (to_node_key <> from_node_key),
  gate TEXT NOT NULL CHECK (gate IN ('accepted_result', 'verified_output', 'integrated_commit')),
  edge_json TEXT NOT NULL CHECK (json_valid(edge_json)),
  PRIMARY KEY (plan_id, revision, edge_key),
  UNIQUE (plan_id, revision, from_node_key, to_node_key),
  FOREIGN KEY (plan_id, revision, from_node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, revision, to_node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key) ON DELETE RESTRICT
) STRICT;

-- Current ownership is separate from immutable compilation history. It may be
-- released only after the owning plan reaches a real terminal state.
CREATE TABLE execution_plan_task_claims (
  task_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  UNIQUE (plan_id, revision, node_key),
  FOREIGN KEY (plan_id, revision, node_key, task_id)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key, task_id) ON DELETE RESTRICT
) STRICT;

CREATE VIEW execution_active_task_governance AS
SELECT claim.* FROM execution_plan_task_claims claim
JOIN execution_plans plan ON plan.plan_id = claim.plan_id
WHERE plan.state IN ('approved', 'running', 'paused', 'review');

CREATE TABLE execution_plan_drift_events (
  plan_id TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE RESTRICT,
  control_revision INTEGER NOT NULL CHECK (control_revision > 0),
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('task_definition_changed', 'task_control_changed', 'task_assignment_changed')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, control_revision)
) STRICT;

CREATE TRIGGER execution_approval_operation_unique_insert
BEFORE INSERT ON execution_plan_approvals
WHEN EXISTS (SELECT 1 FROM execution_plan_operations WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'Execution operation identity is already bound'); END;
CREATE TRIGGER execution_draft_operation_unique_insert
BEFORE INSERT ON execution_plan_operations
WHEN EXISTS (SELECT 1 FROM execution_plan_approvals WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'Execution operation identity is already bound'); END;

CREATE TRIGGER execution_claim_require_task_scope_insert
BEFORE INSERT ON execution_plan_task_claims
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks task JOIN execution_plans plan ON plan.plan_id = NEW.plan_id
  WHERE task.task_id = NEW.task_id AND task.room_id = plan.room_id
    AND task.task_id <> plan.root_task_id AND task.is_default = 0
    AND task.completion_policy = 'accepted_result_required'
)
BEGIN SELECT RAISE(ABORT, 'Execution compiled Task scope is invalid'); END;

CREATE TRIGGER execution_approval_require_exact_compilation_insert BEFORE INSERT ON execution_plan_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans plan
  JOIN execution_plan_proposals proposal ON proposal.plan_id = plan.plan_id AND proposal.revision = NEW.revision
  JOIN agent_tasks root ON root.task_id = plan.root_task_id
  WHERE plan.plan_id = NEW.plan_id AND plan.current_revision = NEW.revision AND plan.state = 'draft'
    AND proposal.digest = NEW.digest AND root.task_revision = NEW.root_task_revision_after
    AND ((NEW.decision = 'rejected' AND json_array_length(NEW.compiled_tasks_json) = 0
      AND NOT EXISTS (SELECT 1 FROM execution_plan_nodes WHERE plan_id = NEW.plan_id AND revision = NEW.revision))
    OR (NEW.decision = 'approved'
      AND json_array_length(NEW.compiled_tasks_json) = json_array_length(proposal.definition_json, '$.nodes')
      AND (SELECT count(*) FROM execution_plan_nodes WHERE plan_id = NEW.plan_id AND revision = NEW.revision)
        = json_array_length(proposal.definition_json, '$.nodes')
      AND (SELECT count(*) FROM execution_plan_edges WHERE plan_id = NEW.plan_id AND revision = NEW.revision)
        = json_array_length(proposal.definition_json, '$.edges')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(proposal.definition_json, '$.nodes') expected
        WHERE NOT EXISTS (
          SELECT 1 FROM execution_plan_nodes node
          JOIN execution_plan_task_claims claim ON claim.task_id = node.task_id
            AND claim.plan_id = node.plan_id AND claim.revision = node.revision AND claim.node_key = node.node_key
          JOIN json_each(NEW.compiled_tasks_json) pin ON json_extract(pin.value, '$.nodeKey') = node.node_key
          WHERE node.plan_id = NEW.plan_id AND node.revision = NEW.revision AND node.node_json = expected.value
            AND node.task_id = json_extract(pin.value, '$.taskId')
            AND node.task_revision = json_extract(pin.value, '$.taskRevision')
            AND node.definition_revision = json_extract(pin.value, '$.definitionRevision')
            AND node.criteria_revision = json_extract(pin.value, '$.criteriaRevision')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(proposal.definition_json, '$.edges') expected
        WHERE NOT EXISTS (SELECT 1 FROM execution_plan_edges edge
          WHERE edge.plan_id = NEW.plan_id AND edge.revision = NEW.revision AND edge.edge_json = expected.value)
      )))
)
BEGIN SELECT RAISE(ABORT, 'Execution approval requires its exact atomic compilation'); END;

CREATE TRIGGER execution_plan_require_approval_update BEFORE UPDATE OF state ON execution_plans
WHEN NEW.state IN ('approved', 'running', 'paused', 'review', 'completed') AND NOT EXISTS (
  SELECT 1 FROM execution_plan_approvals WHERE plan_id = NEW.plan_id AND revision = NEW.current_revision AND decision = 'approved'
)
BEGIN SELECT RAISE(ABORT, 'Execution plan requires an exact approval'); END;

CREATE TRIGGER execution_nodes_sealed_insert BEFORE INSERT ON execution_plan_nodes
WHEN EXISTS (SELECT 1 FROM execution_plan_approvals WHERE plan_id = NEW.plan_id AND revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'Execution compiled nodes are sealed'); END;
CREATE TRIGGER execution_edges_sealed_insert BEFORE INSERT ON execution_plan_edges
WHEN EXISTS (SELECT 1 FROM execution_plan_approvals WHERE plan_id = NEW.plan_id AND revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'Execution compiled edges are sealed'); END;

CREATE TRIGGER execution_claim_immutable_update BEFORE UPDATE ON execution_plan_task_claims
BEGIN SELECT RAISE(ABORT, 'Execution Task claims cannot be retargeted'); END;
CREATE TRIGGER execution_claim_terminal_release_delete BEFORE DELETE ON execution_plan_task_claims
WHEN EXISTS (SELECT 1 FROM execution_plans WHERE plan_id = OLD.plan_id AND state NOT IN ('completed', 'canceled'))
BEGIN SELECT RAISE(ABORT, 'Execution Task claim requires terminal plan release'); END;

-- Fail closed until RUN-018/EXEC-004 supply frozen, capability-checked dispatch
-- intents. Approval itself must never enable a legacy Run or completion path.
CREATE TRIGGER execution_runs_require_governed_admission_insert BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM execution_active_task_governance WHERE task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'Governed Task requires execution admission'); END;

CREATE TRIGGER execution_tasks_preserve_completion_policy_update
BEFORE UPDATE OF completion_policy, is_default, room_id ON agent_tasks
WHEN EXISTS (SELECT 1 FROM execution_active_task_governance WHERE task_id = OLD.task_id)
  AND (NEW.completion_policy <> 'accepted_result_required' OR NEW.is_default <> 0 OR NEW.room_id <> OLD.room_id)
BEGIN SELECT RAISE(ABORT, 'Governed Task completion policy cannot be weakened'); END;

CREATE TRIGGER execution_tasks_require_verified_completion_update
BEFORE UPDATE OF lifecycle_state, state, completion_result_id ON agent_tasks
WHEN (NEW.lifecycle_state = 'completed' OR NEW.state = 'completed')
  AND EXISTS (SELECT 1 FROM execution_active_task_governance WHERE task_id = OLD.task_id)
BEGIN SELECT RAISE(ABORT, 'Governed Task requires verified execution completion'); END;

CREATE TRIGGER execution_results_require_verified_review_insert BEFORE INSERT ON result_reviews
WHEN NEW.decision = 'accepted' AND EXISTS (
  SELECT 1 FROM task_results result JOIN execution_active_task_governance claim ON claim.task_id = result.task_id
  WHERE result.result_id = NEW.result_id
)
BEGIN SELECT RAISE(ABORT, 'Governed Result requires verified execution review'); END;

CREATE TRIGGER execution_definition_drift_update
AFTER UPDATE OF title, goal, owner_member_id, completion_policy, definition_revision,
  criteria_revision, max_run_attempts, max_execution_duration_seconds, primary_agent_id, workspace_ref
ON agent_tasks
WHEN EXISTS (
  SELECT 1 FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ))
)
BEGIN
  INSERT INTO execution_plan_drift_events
  SELECT plan.plan_id, plan.control_revision + 1, NEW.task_id, 'task_definition_changed', NEW.updated_at
  FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ));
  UPDATE execution_plans SET state = 'paused', control_revision = control_revision + 1, updated_at = NEW.updated_at
  WHERE state IN ('approved', 'running', 'review') AND (root_task_id = NEW.task_id OR plan_id IN (
    SELECT plan_id FROM execution_plan_task_claims WHERE task_id = NEW.task_id
  ));
END;

CREATE TRIGGER execution_control_drift_update
AFTER UPDATE OF scheduling_state, lifecycle_state ON agent_tasks
WHEN (NEW.scheduling_state = 'paused' OR NEW.lifecycle_state = 'canceled') AND EXISTS (
  SELECT 1 FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ))
)
BEGIN
  INSERT INTO execution_plan_drift_events
  SELECT plan.plan_id, plan.control_revision + 1, NEW.task_id, 'task_control_changed', NEW.updated_at
  FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ));
  UPDATE execution_plans SET state = 'paused', control_revision = control_revision + 1, updated_at = NEW.updated_at
  WHERE state IN ('approved', 'running', 'review') AND (root_task_id = NEW.task_id OR plan_id IN (
    SELECT plan_id FROM execution_plan_task_claims WHERE task_id = NEW.task_id
  ));
END;

CREATE TRIGGER execution_assignment_drift_insert
AFTER INSERT ON task_agent_assignments
WHEN EXISTS (
  SELECT 1 FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ))
)
BEGIN
  INSERT INTO execution_plan_drift_events
  SELECT plan.plan_id, plan.control_revision + 1, NEW.task_id, 'task_assignment_changed',
    (SELECT updated_at FROM agent_tasks WHERE task_id = NEW.task_id)
  FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ));
  UPDATE execution_plans SET state = 'paused', control_revision = control_revision + 1,
    updated_at = (SELECT updated_at FROM agent_tasks WHERE task_id = NEW.task_id)
  WHERE state IN ('approved', 'running', 'review') AND (root_task_id = NEW.task_id OR plan_id IN (
    SELECT plan_id FROM execution_plan_task_claims WHERE task_id = NEW.task_id
  ));
END;

CREATE TRIGGER execution_assignment_drift_delete
AFTER DELETE ON task_agent_assignments
WHEN EXISTS (
  SELECT 1 FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = OLD.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = OLD.task_id
    ))
)
BEGIN
  INSERT INTO execution_plan_drift_events
  SELECT plan.plan_id, plan.control_revision + 1, OLD.task_id, 'task_assignment_changed',
    (SELECT updated_at FROM agent_tasks WHERE task_id = OLD.task_id)
  FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = OLD.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = OLD.task_id
    ));
  UPDATE execution_plans SET state = 'paused', control_revision = control_revision + 1,
    updated_at = (SELECT updated_at FROM agent_tasks WHERE task_id = OLD.task_id)
  WHERE state IN ('approved', 'running', 'review') AND (root_task_id = OLD.task_id OR plan_id IN (
    SELECT plan_id FROM execution_plan_task_claims WHERE task_id = OLD.task_id
  ));
END;

CREATE TRIGGER execution_assignment_drift_update
AFTER UPDATE ON task_agent_assignments
WHEN EXISTS (
  SELECT 1 FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ))
)
BEGIN
  INSERT INTO execution_plan_drift_events
  SELECT plan.plan_id, plan.control_revision + 1, NEW.task_id, 'task_assignment_changed',
    (SELECT updated_at FROM agent_tasks WHERE task_id = NEW.task_id)
  FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'review')
    AND (plan.root_task_id = NEW.task_id OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id AND claim.task_id = NEW.task_id
    ));
  UPDATE execution_plans SET state = 'paused', control_revision = control_revision + 1,
    updated_at = (SELECT updated_at FROM agent_tasks WHERE task_id = NEW.task_id)
  WHERE state IN ('approved', 'running', 'review') AND (root_task_id = NEW.task_id OR plan_id IN (
    SELECT plan_id FROM execution_plan_task_claims WHERE task_id = NEW.task_id
  ));
END;

CREATE TRIGGER execution_assignment_identity_update BEFORE UPDATE OF task_id ON task_agent_assignments
WHEN NEW.task_id <> OLD.task_id AND EXISTS (
  SELECT 1 FROM execution_plans plan WHERE plan.state IN ('approved', 'running', 'paused', 'review')
    AND (plan.root_task_id IN (OLD.task_id, NEW.task_id) OR EXISTS (
      SELECT 1 FROM execution_plan_task_claims claim WHERE claim.plan_id = plan.plan_id
        AND claim.task_id IN (OLD.task_id, NEW.task_id)
    ))
)
BEGIN SELECT RAISE(ABORT, 'Task assignment identity cannot be retargeted'); END;

CREATE TRIGGER execution_approvals_immutable_update BEFORE UPDATE ON execution_plan_approvals
BEGIN SELECT RAISE(ABORT, 'Execution approvals are immutable'); END;
CREATE TRIGGER execution_approvals_immutable_delete BEFORE DELETE ON execution_plan_approvals
BEGIN SELECT RAISE(ABORT, 'Execution approvals are immutable'); END;
CREATE TRIGGER execution_nodes_immutable_update BEFORE UPDATE ON execution_plan_nodes
BEGIN SELECT RAISE(ABORT, 'Execution compiled nodes are immutable'); END;
CREATE TRIGGER execution_nodes_immutable_delete BEFORE DELETE ON execution_plan_nodes
BEGIN SELECT RAISE(ABORT, 'Execution compiled nodes are immutable'); END;
CREATE TRIGGER execution_edges_immutable_update BEFORE UPDATE ON execution_plan_edges
BEGIN SELECT RAISE(ABORT, 'Execution compiled edges are immutable'); END;
CREATE TRIGGER execution_edges_immutable_delete BEFORE DELETE ON execution_plan_edges
BEGIN SELECT RAISE(ABORT, 'Execution compiled edges are immutable'); END;
CREATE TRIGGER execution_drift_immutable_update BEFORE UPDATE ON execution_plan_drift_events
BEGIN SELECT RAISE(ABORT, 'Execution drift events are immutable'); END;
CREATE TRIGGER execution_drift_immutable_delete BEFORE DELETE ON execution_plan_drift_events
BEGIN SELECT RAISE(ABORT, 'Execution drift events are immutable'); END;
