CREATE TABLE execution_run_admissions (
  run_id TEXT PRIMARY KEY CHECK (run_id GLOB 'run_*'),
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
  trigger_message_id TEXT NOT NULL,
  requester_member_id TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  grant_json TEXT NOT NULL CHECK (
    json_valid(grant_json) AND json_type(grant_json) = 'object'
  ),
  manifest_digest TEXT CHECK (
    manifest_digest IS NULL OR (
      length(manifest_digest) = 64 AND
      manifest_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  admitted_at TEXT NOT NULL,
  UNIQUE (plan_id, plan_revision, node_key, dispatch_generation),
  UNIQUE (trigger_message_id, agent_id),
  FOREIGN KEY (plan_id, plan_revision, node_key)
    REFERENCES execution_plan_nodes(plan_id, revision, node_key) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE RESTRICT,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(message_id) ON DELETE RESTRICT,
  FOREIGN KEY (requester_member_id)
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

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
    AND message.sender_type = 'member'
    AND message.sender_id = NEW.requester_member_id
    AND agent.device_id = NEW.device_id
    AND agent.team_id = room.team_id
    AND agent.owner_member_id = device.owner_member_id
    AND device.team_id = room.team_id
    AND (
      requester_member.role = 'owner' OR
      requester_member.member_id = task.owner_member_id
    )
    AND approval.operation_id = NEW.approval_operation_id
    AND approval.decision = 'approved'
    AND approval.digest = NEW.plan_digest
    AND NEW.plan_digest = json_extract(approval.response_json, '$.plan.current.digest')
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

DROP TRIGGER execution_runs_require_governed_admission_insert;
CREATE TRIGGER execution_runs_require_governed_admission_insert
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM execution_active_task_governance
  WHERE task_id = NEW.task_id
) AND NOT EXISTS (
  SELECT 1 FROM execution_run_admissions admission
  WHERE admission.run_id = NEW.run_id
    AND admission.task_id = NEW.task_id
    AND admission.room_id = NEW.room_id
    AND admission.agent_id = NEW.target_agent_id
    AND admission.trigger_message_id = NEW.trigger_message_id
    AND admission.requester_member_id = NEW.requester_member_id
    AND admission.deadline_at = NEW.deadline_at
    AND admission.admitted_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'Governed Task requires exact execution admission');
END;

CREATE TRIGGER execution_run_admissions_seal_manifest_update
BEFORE UPDATE ON execution_run_admissions
WHEN OLD.manifest_digest IS NOT NULL OR NEW.manifest_digest IS NULL OR
  length(NEW.manifest_digest) <> 64 OR
  NEW.manifest_digest GLOB '*[^0-9a-f]*' OR
  NEW.run_id IS NOT OLD.run_id OR NEW.plan_id IS NOT OLD.plan_id OR
  NEW.plan_revision IS NOT OLD.plan_revision OR
  NEW.plan_digest IS NOT OLD.plan_digest OR
  NEW.plan_control_revision IS NOT OLD.plan_control_revision OR
  NEW.approval_operation_id IS NOT OLD.approval_operation_id OR
  NEW.node_key IS NOT OLD.node_key OR
  NEW.dispatch_generation IS NOT OLD.dispatch_generation OR
  NEW.task_id IS NOT OLD.task_id OR NEW.room_id IS NOT OLD.room_id OR
  NEW.agent_id IS NOT OLD.agent_id OR NEW.device_id IS NOT OLD.device_id OR
  NEW.trigger_message_id IS NOT OLD.trigger_message_id OR
  NEW.requester_member_id IS NOT OLD.requester_member_id OR
  NEW.deadline_at IS NOT OLD.deadline_at OR
  NEW.grant_json IS NOT OLD.grant_json OR
  NEW.request_digest IS NOT OLD.request_digest OR
  NEW.admitted_at IS NOT OLD.admitted_at
BEGIN
  SELECT RAISE(ABORT, 'Execution Run admission can seal one manifest only');
END;

CREATE TRIGGER execution_run_admissions_immutable_delete
BEFORE DELETE ON execution_run_admissions
BEGIN
  SELECT RAISE(ABORT, 'Execution Run admission is immutable');
END;

CREATE TRIGGER execution_runs_require_admitted_manifest_update
BEFORE UPDATE OF context_manifest_json ON runs
WHEN EXISTS (
  SELECT 1 FROM execution_run_admissions admission
  WHERE admission.run_id = OLD.run_id
) AND NOT EXISTS (
  SELECT 1 FROM execution_run_admissions admission
  WHERE admission.run_id = OLD.run_id
    AND admission.manifest_digest IS NOT NULL
    AND json_valid(NEW.context_manifest_json)
    AND json_extract(NEW.context_manifest_json, '$.runId') = NEW.run_id
    AND json_extract(NEW.context_manifest_json, '$.taskId') = NEW.task_id
    AND json_extract(NEW.context_manifest_json, '$.target.agentId') =
      NEW.target_agent_id
    AND json_extract(
      NEW.context_manifest_json,
      '$.execution.manifestDigest'
    ) = admission.manifest_digest
    AND json_extract(NEW.context_manifest_json, '$.execution.scope.runId') =
      admission.run_id
    AND json_extract(NEW.context_manifest_json, '$.execution.scope.planId') =
      admission.plan_id
    AND json_extract(
      NEW.context_manifest_json,
      '$.execution.scope.planRevision'
    ) = admission.plan_revision
    AND json_extract(NEW.context_manifest_json, '$.execution.scope.nodeKey') =
      admission.node_key
    AND json_extract(
      NEW.context_manifest_json,
      '$.execution.scope.dispatchGeneration'
    ) = admission.dispatch_generation
    AND json_extract(NEW.context_manifest_json, '$.execution.scope.taskId') =
      admission.task_id
    AND json_extract(NEW.context_manifest_json, '$.execution.scope.agentId') =
      admission.agent_id
    AND json_extract(NEW.context_manifest_json, '$.execution.scope.deviceId') =
      admission.device_id
    AND json_extract(
      NEW.context_manifest_json,
      '$.execution.grant.digest'
    ) = json_extract(admission.grant_json, '$.grant.digest')
)
BEGIN
  SELECT RAISE(ABORT, 'Run Context Manifest does not match execution admission');
END;

CREATE TRIGGER execution_run_deliveries_require_sealed_admission_insert
BEFORE INSERT ON run_deliveries
WHEN EXISTS (
  SELECT 1 FROM execution_run_admissions WHERE run_id = NEW.run_id
) AND NOT EXISTS (
  SELECT 1
  FROM execution_run_admissions admission
  JOIN runs run ON run.run_id = admission.run_id
  WHERE admission.run_id = NEW.run_id
    AND admission.manifest_digest IS NOT NULL
    AND json_extract(
      run.context_manifest_json,
      '$.execution.manifestDigest'
    ) = admission.manifest_digest
    AND json_extract(run.context_manifest_json, '$.execution.scope.deviceId') =
      NEW.device_id
)
BEGIN
  SELECT RAISE(ABORT, 'Governed delivery requires a sealed execution admission');
END;
