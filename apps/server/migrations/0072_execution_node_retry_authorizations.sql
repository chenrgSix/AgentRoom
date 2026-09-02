CREATE TABLE execution_node_retry_authorizations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_control_revision INTEGER NOT NULL CHECK (plan_control_revision > 0),
  node_key TEXT NOT NULL,
  previous_node_projection_revision INTEGER NOT NULL CHECK (
    previous_node_projection_revision > 0
  ),
  previous_generation INTEGER NOT NULL CHECK (previous_generation > 0),
  previous_run_id TEXT NOT NULL UNIQUE,
  previous_run_state TEXT NOT NULL CHECK (
    previous_run_state IN ('failed', 'canceled', 'expired', 'outcome_unknown')
  ),
  ambiguity_acknowledgement_operation_id TEXT,
  new_generation INTEGER NOT NULL CHECK (
    new_generation = previous_generation + 1
  ),
  new_run_id TEXT NOT NULL UNIQUE,
  new_dispatch_intent_id TEXT NOT NULL UNIQUE CHECK (
    new_dispatch_intent_id GLOB 'dispatch_*'
  ),
  requested_by_member_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_digest TEXT NOT NULL UNIQUE CHECK (
    length(authorization_digest) = 64 AND
    authorization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_json TEXT NOT NULL CHECK (
    json_valid(authorization_json) AND
    json_type(authorization_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, plan_revision, node_key, new_generation),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (previous_run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (new_run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (new_dispatch_intent_id)
    REFERENCES execution_dispatch_intents(intent_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (requested_by_member_id)
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  FOREIGN KEY (ambiguity_acknowledgement_operation_id)
    REFERENCES run_ambiguity_acknowledgements(operation_id) ON DELETE RESTRICT
) STRICT;

ALTER TABLE execution_dispatch_intents
ADD COLUMN retry_operation_id TEXT
  REFERENCES execution_node_retry_authorizations(operation_id)
  ON DELETE RESTRICT;

CREATE TRIGGER execution_node_retry_authorizations_require_scope_insert
BEFORE INSERT ON execution_node_retry_authorizations
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_proposals proposal ON proposal.plan_id = plan.plan_id
    AND proposal.revision = plan.current_revision
  JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
    AND node.revision = plan.current_revision
    AND node.node_key = NEW.node_key
  JOIN execution_plan_task_claims claim ON claim.plan_id = node.plan_id
    AND claim.revision = node.revision AND claim.node_key = node.node_key
    AND claim.task_id = node.task_id
  JOIN agent_tasks task ON task.task_id = node.task_id
  JOIN rooms room ON room.room_id = task.room_id AND room.archived_at IS NULL
  JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
  JOIN room_human_participants participant
    ON participant.room_id = room.room_id
      AND participant.member_id = NEW.requested_by_member_id
  JOIN team_members member ON member.member_id = participant.member_id
    AND member.team_id = room.team_id
  JOIN execution_node_states state ON state.plan_id = node.plan_id
    AND state.plan_revision = node.revision AND state.node_key = node.node_key
  JOIN execution_dispatch_intents previous_intent
    ON previous_intent.plan_id = node.plan_id
      AND previous_intent.plan_revision = node.revision
      AND previous_intent.node_key = node.node_key
      AND previous_intent.dispatch_generation = NEW.previous_generation
      AND previous_intent.run_id = NEW.previous_run_id
  JOIN runs previous_run ON previous_run.run_id = previous_intent.run_id
    AND previous_run.state = NEW.previous_run_state
    AND previous_run.task_id = task.task_id
    AND previous_run.room_id = task.room_id
    AND previous_run.target_agent_id = node.agent_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND proposal.digest = NEW.plan_digest
    AND plan.control_revision = NEW.plan_control_revision
    AND plan.state IN ('approved', 'running')
    AND json_extract(node.node_json, '$.kind') = 'implementation'
    AND task.lifecycle_state IN ('ready', 'active', 'review')
    AND task.scheduling_state = 'enabled'
    AND task.definition_revision = node.definition_revision
    AND task.criteria_revision = node.criteria_revision
    AND (member.role = 'owner' OR member.member_id = task.owner_member_id)
    AND state.projection_revision = NEW.previous_node_projection_revision
    AND state.dispatch_generation = NEW.previous_generation
    AND state.run_id = NEW.previous_run_id
    AND state.last_run_state = NEW.previous_run_state
    AND NOT EXISTS (
      SELECT 1 FROM execution_dispatch_intents later
      WHERE later.plan_id = node.plan_id
        AND later.plan_revision = node.revision
        AND later.node_key = node.node_key
        AND later.dispatch_generation > NEW.previous_generation
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_node_materializations materialization
      WHERE materialization.plan_id = node.plan_id
        AND materialization.plan_revision = node.revision
        AND materialization.node_key = node.node_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_verified_node_materializations materialization
      WHERE materialization.plan_id = node.plan_id
        AND materialization.plan_revision = node.revision
        AND materialization.node_key = node.node_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM execution_integrated_node_materializations materialization
      WHERE materialization.plan_id = node.plan_id
        AND materialization.plan_revision = node.revision
        AND materialization.node_key = node.node_key
    )
    AND (
      (
        NEW.previous_run_state <> 'outcome_unknown' AND
        NEW.ambiguity_acknowledgement_operation_id IS NULL
      ) OR (
        NEW.previous_run_state = 'outcome_unknown' AND
        EXISTS (
          SELECT 1 FROM run_ambiguity_acknowledgements acknowledgement
          WHERE acknowledgement.run_id = NEW.previous_run_id
            AND acknowledgement.operation_id =
              NEW.ambiguity_acknowledgement_operation_id
            AND acknowledgement.task_id = task.task_id
        )
      )
    )
    AND json_extract(NEW.authorization_json, '$.operationId') =
      NEW.operation_id
    AND json_extract(NEW.authorization_json, '$.planId') = NEW.plan_id
    AND json_extract(NEW.authorization_json, '$.planRevision') =
      NEW.plan_revision
    AND json_extract(NEW.authorization_json, '$.planDigest') = NEW.plan_digest
    AND json_extract(NEW.authorization_json, '$.planControlRevision') =
      NEW.plan_control_revision
    AND json_extract(NEW.authorization_json, '$.nodeKey') = NEW.node_key
    AND json_extract(
      NEW.authorization_json,
      '$.previousNodeProjectionRevision'
    ) = NEW.previous_node_projection_revision
    AND json_extract(NEW.authorization_json, '$.previousGeneration') =
      NEW.previous_generation
    AND json_extract(NEW.authorization_json, '$.previousRunId') =
      NEW.previous_run_id
    AND json_extract(NEW.authorization_json, '$.previousRunState') =
      NEW.previous_run_state
    AND json_extract(
      NEW.authorization_json,
      '$.ambiguityAcknowledgementOperationId'
    ) IS NEW.ambiguity_acknowledgement_operation_id
    AND json_extract(NEW.authorization_json, '$.newGeneration') =
      NEW.new_generation
    AND json_extract(NEW.authorization_json, '$.newRunId') = NEW.new_run_id
    AND json_extract(NEW.authorization_json, '$.newDispatchIntentId') =
      NEW.new_dispatch_intent_id
    AND json_extract(NEW.authorization_json, '$.requestedByMemberId') =
      NEW.requested_by_member_id
    AND json_extract(NEW.authorization_json, '$.reason') = NEW.reason
    AND json_extract(NEW.authorization_json, '$.requestDigest') =
      NEW.request_digest
    AND json_extract(NEW.authorization_json, '$.authorizationDigest') =
      NEW.authorization_digest
    AND json_extract(NEW.authorization_json, '$.createdAt') = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'Execution node retry authorization scope is invalid');
END;

CREATE TRIGGER execution_dispatch_intents_require_retry_authorization_insert
BEFORE INSERT ON execution_dispatch_intents
WHEN (
  NEW.dispatch_generation = 1 AND NEW.retry_operation_id IS NOT NULL
) OR (
  NEW.dispatch_generation > 1 AND NOT EXISTS (
    SELECT 1
    FROM execution_node_retry_authorizations authorization
    JOIN execution_dispatch_intents previous_intent
      ON previous_intent.plan_id = authorization.plan_id
        AND previous_intent.plan_revision = authorization.plan_revision
        AND previous_intent.node_key = authorization.node_key
        AND previous_intent.dispatch_generation =
          authorization.previous_generation
        AND previous_intent.run_id = authorization.previous_run_id
    WHERE authorization.operation_id = NEW.retry_operation_id
      AND authorization.plan_id = NEW.plan_id
      AND authorization.plan_revision = NEW.plan_revision
      AND authorization.plan_digest = NEW.plan_digest
      AND authorization.plan_control_revision = NEW.plan_control_revision
      AND authorization.node_key = NEW.node_key
      AND authorization.new_generation = NEW.dispatch_generation
      AND authorization.new_run_id = NEW.run_id
      AND authorization.new_dispatch_intent_id = NEW.intent_id
      AND authorization.requested_by_member_id = NEW.requester_member_id
      AND authorization.created_at = NEW.created_at
      AND NEW.source = 'member_message'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution DispatchIntent retry authority is invalid');
END;

CREATE TRIGGER execution_node_retry_authorizations_immutable_update
BEFORE UPDATE ON execution_node_retry_authorizations
BEGIN
  SELECT RAISE(ABORT, 'Execution node retry authorization is immutable');
END;

CREATE TRIGGER execution_node_retry_authorizations_immutable_delete
BEFORE DELETE ON execution_node_retry_authorizations
BEGIN
  SELECT RAISE(ABORT, 'Execution node retry authorization is retained evidence');
END;
