CREATE TABLE execution_dispatch_intents (
  intent_id TEXT PRIMARY KEY CHECK (intent_id GLOB 'dispatch_*'),
  source TEXT NOT NULL CHECK (source IN ('member_message', 'scheduler')),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_control_revision INTEGER NOT NULL CHECK (plan_control_revision > 0),
  approval_operation_id TEXT NOT NULL CHECK (approval_operation_id GLOB 'op_*'),
  node_key TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation > 0),
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  trace_message_id TEXT NOT NULL UNIQUE,
  requester_member_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL CHECK (
    length(operation_digest) = 64 AND
    operation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, plan_revision, node_key, dispatch_generation),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (trace_message_id)
    REFERENCES messages(message_id) ON DELETE RESTRICT,
  FOREIGN KEY (requester_member_id)
    REFERENCES team_members(member_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE execution_node_states (
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  node_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'blocked', 'ready', 'dispatched', 'working', 'awaiting_result',
    'failed', 'canceled', 'outcome_unknown'
  )),
  blocker_code TEXT,
  dispatch_generation INTEGER CHECK (
    dispatch_generation IS NULL OR dispatch_generation > 0
  ),
  run_id TEXT,
  last_run_state TEXT CHECK (
    last_run_state IS NULL OR last_run_state IN (
      'queued', 'delivered', 'working', 'input_required', 'completed',
      'failed', 'canceled', 'expired', 'outcome_unknown'
    )
  ),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, plan_revision, node_key),
  CHECK (
    (run_id IS NULL AND dispatch_generation IS NULL AND last_run_state IS NULL) OR
    (run_id IS NOT NULL AND dispatch_generation IS NOT NULL AND last_run_state IS NOT NULL)
  ),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX execution_node_states_state_idx
  ON execution_node_states(state, plan_id, plan_revision, node_key);

-- Existing RUN-018 admissions are immutable member-dispatched generation facts.
-- Backfill them before installing the new insertion fences.
INSERT INTO execution_dispatch_intents (
  intent_id, source, plan_id, plan_revision, plan_digest,
  plan_control_revision, approval_operation_id, node_key,
  dispatch_generation, task_id, room_id, agent_id, device_id, run_id,
  trace_message_id, requester_member_id, operation_digest, created_at
)
SELECT
  'dispatch_migrated_' || substr(admission.run_id, 5),
  'member_message', admission.plan_id, admission.plan_revision,
  admission.plan_digest, admission.plan_control_revision,
  admission.approval_operation_id, admission.node_key,
  admission.dispatch_generation, admission.task_id, admission.room_id,
  admission.agent_id, admission.device_id, admission.run_id,
  admission.trigger_message_id, admission.requester_member_id,
  admission.request_digest, admission.admitted_at
FROM execution_run_admissions admission;

INSERT INTO execution_node_states (
  plan_id, plan_revision, node_key, state, blocker_code,
  dispatch_generation, run_id, last_run_state, projection_revision, updated_at
)
SELECT
  node.plan_id, node.revision, node.node_key,
  CASE
    WHEN run.state IN ('queued', 'delivered') THEN 'dispatched'
    WHEN run.state IN ('working', 'input_required') THEN 'working'
    WHEN run.state = 'completed' THEN 'awaiting_result'
    WHEN run.state IN ('failed', 'expired') THEN 'failed'
    WHEN run.state = 'canceled' THEN 'canceled'
    WHEN run.state = 'outcome_unknown' THEN 'outcome_unknown'
    ELSE 'blocked'
  END,
  CASE WHEN run.run_id IS NULL THEN 'EXECUTION_RECOVERY_PENDING' ELSE NULL END,
  intent.dispatch_generation, intent.run_id, run.state, 1,
  coalesce(run.updated_at, plan.updated_at)
FROM execution_plan_nodes node
JOIN execution_plans plan ON plan.plan_id = node.plan_id
  AND plan.current_revision = node.revision
LEFT JOIN execution_dispatch_intents intent
  ON intent.plan_id = node.plan_id AND intent.plan_revision = node.revision
    AND intent.node_key = node.node_key
LEFT JOIN runs run ON run.run_id = intent.run_id
WHERE plan.state IN ('approved', 'running', 'paused', 'review');

CREATE TRIGGER execution_dispatch_intents_require_exact_scope_insert
BEFORE INSERT ON execution_dispatch_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_nodes node
    ON node.plan_id = plan.plan_id AND node.revision = plan.current_revision
  JOIN execution_plan_approvals approval
    ON approval.plan_id = node.plan_id AND approval.revision = node.revision
  JOIN execution_plan_task_claims claim
    ON claim.task_id = node.task_id AND claim.plan_id = node.plan_id
      AND claim.revision = node.revision AND claim.node_key = node.node_key
  JOIN agent_tasks task ON task.task_id = node.task_id
  JOIN rooms room ON room.room_id = task.room_id AND room.archived_at IS NULL
  JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
  JOIN agents agent ON agent.agent_id = node.agent_id
    AND agent.enabled = 1 AND agent.integration_mode = 'managed'
  JOIN devices device ON device.device_id = agent.device_id
    AND device.status = 'active'
  JOIN messages message ON message.message_id = NEW.trace_message_id
  JOIN room_human_participants requester
    ON requester.room_id = room.room_id
      AND requester.member_id = NEW.requester_member_id
  JOIN team_members requester_member
    ON requester_member.member_id = requester.member_id
      AND requester_member.team_id = room.team_id
  JOIN room_agent_participants participant
    ON participant.room_id = room.room_id
      AND participant.agent_id = agent.agent_id
  JOIN task_agent_assignments assignment
    ON assignment.task_id = task.task_id AND assignment.agent_id = agent.agent_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND plan.control_revision = NEW.plan_control_revision
    AND plan.state IN ('approved', 'running')
    AND node.node_key = NEW.node_key
    AND node.task_id = NEW.task_id
    AND node.agent_id = NEW.agent_id
    AND task.room_id = NEW.room_id
    AND task.definition_revision = node.definition_revision
    AND task.criteria_revision = node.criteria_revision
    AND task.lifecycle_state IN ('ready', 'active', 'review')
    AND task.scheduling_state = 'enabled'
    AND agent.device_id = NEW.device_id
    AND agent.team_id = room.team_id
    AND agent.owner_member_id = device.owner_member_id
    AND device.team_id = room.team_id
    AND approval.operation_id = NEW.approval_operation_id
    AND approval.decision = 'approved'
    AND approval.digest = NEW.plan_digest
    AND NEW.plan_digest = json_extract(approval.response_json, '$.plan.current.digest')
    AND message.room_id = NEW.room_id
    AND message.task_id = NEW.task_id
    AND (
      (
        NEW.source = 'member_message' AND
        message.sender_type = 'member' AND
        message.sender_id = NEW.requester_member_id AND
        (SELECT count(*) FROM message_mentions mention
          WHERE mention.message_id = message.message_id) = 1 AND
        EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
            AND mention.target_agent_id = NEW.agent_id
        ) AND
        (
          requester_member.role = 'owner' OR
          requester_member.member_id = task.owner_member_id
        )
      ) OR (
        NEW.source = 'scheduler' AND
        NEW.dispatch_generation = 1 AND
        NEW.requester_member_id = approval.reviewed_by_member_id AND
        (
          requester_member.role = 'owner' OR
          requester_member.member_id = task.owner_member_id
        ) AND
        message.sender_type = 'system' AND
        message.sender_id = 'execution-scheduler' AND
        NOT EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution DispatchIntent scope is not current');
END;

CREATE TRIGGER execution_dispatch_intents_immutable_update
BEFORE UPDATE ON execution_dispatch_intents
BEGIN
  SELECT RAISE(ABORT, 'Execution DispatchIntent is immutable');
END;

CREATE TRIGGER execution_dispatch_intents_immutable_delete
BEFORE DELETE ON execution_dispatch_intents
BEGIN
  SELECT RAISE(ABORT, 'Execution DispatchIntent is immutable');
END;

DROP TRIGGER execution_run_admissions_require_exact_scope_insert;
CREATE TRIGGER execution_run_admissions_require_exact_scope_insert
BEFORE INSERT ON execution_run_admissions
WHEN NEW.manifest_digest IS NOT NULL OR NOT EXISTS (
  SELECT 1
  FROM execution_plans plan
  JOIN execution_plan_nodes node
    ON node.plan_id = plan.plan_id AND node.revision = plan.current_revision
  JOIN execution_plan_approvals approval
    ON approval.plan_id = node.plan_id AND approval.revision = node.revision
  JOIN execution_plan_task_claims claim
    ON claim.task_id = node.task_id AND claim.plan_id = node.plan_id
      AND claim.revision = node.revision AND claim.node_key = node.node_key
  JOIN agent_tasks task ON task.task_id = node.task_id
  JOIN rooms room ON room.room_id = task.room_id AND room.archived_at IS NULL
  JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
  JOIN agents agent ON agent.agent_id = node.agent_id
    AND agent.enabled = 1 AND agent.integration_mode = 'managed'
  JOIN devices device ON device.device_id = agent.device_id
    AND device.status = 'active'
  JOIN messages message ON message.message_id = NEW.trigger_message_id
  JOIN execution_dispatch_intents intent ON intent.run_id = NEW.run_id
  JOIN room_human_participants requester
    ON requester.room_id = room.room_id
      AND requester.member_id = NEW.requester_member_id
  JOIN team_members requester_member
    ON requester_member.member_id = requester.member_id
      AND requester_member.team_id = room.team_id
  JOIN room_agent_participants participant
    ON participant.room_id = room.room_id
      AND participant.agent_id = agent.agent_id
  JOIN task_agent_assignments assignment
    ON assignment.task_id = task.task_id AND assignment.agent_id = agent.agent_id
  WHERE plan.plan_id = NEW.plan_id
    AND plan.current_revision = NEW.plan_revision
    AND plan.current_revision = node.revision
    AND plan.current_revision = approval.revision
    AND plan.current_revision = claim.revision
    AND plan.current_revision > 0
    AND plan.current_revision = NEW.plan_revision
    AND plan.current_revision = json_extract(approval.response_json, '$.plan.current.revision')
    AND plan.control_revision = NEW.plan_control_revision
    AND plan.state IN ('approved', 'running')
    AND node.node_key = NEW.node_key
    AND node.task_id = NEW.task_id
    AND node.agent_id = NEW.agent_id
    AND task.room_id = NEW.room_id
    AND task.definition_revision = node.definition_revision
    AND task.criteria_revision = node.criteria_revision
    AND json_extract(node.node_json, '$.kind') = 'implementation'
    AND task.lifecycle_state IN ('ready', 'active', 'review')
    AND task.scheduling_state = 'enabled'
    AND message.room_id = NEW.room_id
    AND message.task_id = NEW.task_id
    AND agent.device_id = NEW.device_id
    AND agent.team_id = room.team_id
    AND agent.owner_member_id = device.owner_member_id
    AND device.team_id = room.team_id
    AND approval.operation_id = NEW.approval_operation_id
    AND approval.decision = 'approved'
    AND approval.digest = NEW.plan_digest
    AND NEW.plan_digest = json_extract(approval.response_json, '$.plan.current.digest')
    AND intent.plan_id = NEW.plan_id
    AND intent.plan_revision = NEW.plan_revision
    AND intent.plan_digest = NEW.plan_digest
    AND intent.plan_control_revision = NEW.plan_control_revision
    AND intent.approval_operation_id = NEW.approval_operation_id
    AND intent.node_key = NEW.node_key
    AND intent.dispatch_generation = NEW.dispatch_generation
    AND intent.task_id = NEW.task_id
    AND intent.room_id = NEW.room_id
    AND intent.agent_id = NEW.agent_id
    AND intent.device_id = NEW.device_id
    AND intent.trace_message_id = NEW.trigger_message_id
    AND intent.requester_member_id = NEW.requester_member_id
    AND intent.operation_digest = NEW.request_digest
    AND intent.created_at = NEW.admitted_at
    AND (
      (
        intent.source = 'member_message' AND
        message.sender_type = 'member' AND
        message.sender_id = NEW.requester_member_id AND
        (SELECT count(*) FROM message_mentions mention
          WHERE mention.message_id = message.message_id) = 1 AND
        EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
            AND mention.target_agent_id = NEW.agent_id
        ) AND
        (
          requester_member.role = 'owner' OR
          requester_member.member_id = task.owner_member_id
        )
      ) OR (
        intent.source = 'scheduler' AND
        NEW.dispatch_generation = 1 AND
        NEW.requester_member_id = approval.reviewed_by_member_id AND
        (
          requester_member.role = 'owner' OR
          requester_member.member_id = task.owner_member_id
        ) AND
        message.sender_type = 'system' AND
        message.sender_id = 'execution-scheduler' AND
        NOT EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
        )
      )
    )
    AND NEW.deadline_at > NEW.admitted_at
    AND json_extract(NEW.grant_json, '$.planId') = NEW.plan_id
    AND json_extract(NEW.grant_json, '$.nodeKey') = NEW.node_key
    AND json_extract(NEW.grant_json, '$.agentId') = NEW.agent_id
    AND json_extract(NEW.grant_json, '$.deviceId') = NEW.device_id
    AND json_extract(NEW.grant_json, '$.repositoryId') =
      json_extract(node.node_json, '$.repository.repositoryId')
    AND json_extract(NEW.grant_json, '$.bindingId') =
      json_extract(node.node_json, '$.repository.bindingId')
    AND json_extract(NEW.grant_json, '$.grant.grantId') =
      json_extract(node.node_json, '$.repository.grantId')
    AND json_extract(NEW.grant_json, '$.grant.revision') =
      json_extract(node.node_json, '$.repository.grantRevision')
    AND json_extract(NEW.grant_json, '$.runtimeProfile.profileId') =
      json_extract(node.node_json, '$.repository.runtimeProfileId')
    AND json_extract(NEW.grant_json, '$.runtimeProfile.revision') = 1
    AND json_extract(NEW.grant_json, '$.runtimeProfile.digest') =
      json_extract(node.node_json, '$.repository.runtimeProfileDigest')
    AND json_extract(NEW.grant_json, '$.revokedAt') IS NULL
    AND julianday(json_extract(NEW.grant_json, '$.issuedAt')) <=
      julianday(NEW.admitted_at)
    AND julianday(NEW.admitted_at) <
      julianday(json_extract(NEW.grant_json, '$.grant.expiresAt'))
    AND julianday(NEW.deadline_at) <=
      julianday(json_extract(NEW.grant_json, '$.grant.expiresAt'))
    AND json_array_length(NEW.grant_json, '$.operations') = 2
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.grant_json, '$.operations')
      WHERE value = 'prepare'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.grant_json, '$.operations')
      WHERE value = 'capture'
    )
    AND json_array_length(NEW.grant_json, '$.integrationTargets') = 0
    AND json_extract(NEW.grant_json, '$.scopePolicy.access') =
      json_extract(node.node_json, '$.scope.access')
    AND json_extract(
      NEW.grant_json,
      '$.scopePolicy.requirePreventivePathEnforcement'
    ) = json_extract(
      node.node_json,
      '$.scope.requirePreventivePathEnforcement'
    )
    AND json_array_length(NEW.grant_json, '$.scopePolicy.allowedPaths') =
      json_array_length(node.node_json, '$.scope.allowedPaths')
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.grant_json, '$.scopePolicy.allowedPaths') grant_path
      WHERE grant_path.value IS NOT json_extract(
        node.node_json,
        '$.scope.allowedPaths[' || grant_path.key || ']'
      )
    )
    AND json_array_length(NEW.grant_json, '$.scopePolicy.forbiddenPaths') =
      json_array_length(node.node_json, '$.scope.forbiddenPaths')
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.grant_json, '$.scopePolicy.forbiddenPaths') grant_path
      WHERE grant_path.value IS NOT json_extract(
        node.node_json,
        '$.scope.forbiddenPaths[' || grant_path.key || ']'
      )
    )
    AND json_array_length(NEW.grant_json, '$.verificationProfiles') =
      json_array_length(node.node_json, '$.verificationProfiles')
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.grant_json, '$.verificationProfiles') grant_profile
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(node.node_json, '$.verificationProfiles') node_profile
        WHERE json_extract(node_profile.value, '$.profileId') =
            json_extract(grant_profile.value, '$.profileId')
          AND json_extract(node_profile.value, '$.revision') =
            json_extract(grant_profile.value, '$.revision')
          AND json_extract(node_profile.value, '$.digest') =
            json_extract(grant_profile.value, '$.digest')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Execution Run admission scope is not current');
END;
