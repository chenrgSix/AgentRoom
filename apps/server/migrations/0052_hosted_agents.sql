-- convenewire:migration foreign_keys=off

CREATE TABLE agents_v2 (
  agent_id TEXT PRIMARY KEY CHECK (agent_id GLOB 'agent_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (length(trim(role)) BETWEEN 1 AND 80),
  integration_mode TEXT NOT NULL CHECK (
    integration_mode IN ('managed', 'manual', 'fake', 'hosted')
  ),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  presence TEXT NOT NULL CHECK (
    presence IN ('ready', 'busy', 'degraded', 'manual', 'offline')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  runtime_scope_id TEXT CHECK (
    runtime_scope_id IS NULL OR (
      length(runtime_scope_id) = 64 AND
      runtime_scope_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  workspace_ref TEXT CHECK (
    workspace_ref IS NULL OR (
      length(workspace_ref) = 74 AND
      workspace_ref GLOB 'workspace_*' AND
      substr(workspace_ref, 11) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  workspace_generation TEXT CHECK (
    workspace_generation IS NULL OR (
      length(workspace_generation) = 64 AND
      workspace_generation NOT GLOB '*[^0-9a-f]*'
    )
  ),
  runtime_policy_json TEXT CHECK (
    runtime_policy_json IS NULL OR (
      json_valid(runtime_policy_json) AND
      json_type(runtime_policy_json) = 'object' AND
      json_type(runtime_policy_json, '$.filesystemAccess') = 'text' AND
      json_extract(runtime_policy_json, '$.filesystemAccess') IN (
        'read-only', 'workspace-write', 'local-policy'
      )
    )
  ),
  workspace_alias TEXT CHECK (
    workspace_alias IS NULL OR (
      length(workspace_alias) BETWEEN 1 AND 80 AND
      workspace_alias = trim(workspace_alias) AND
      workspace_alias NOT IN ('.', '..') AND
      instr(workspace_alias, '/') = 0 AND
      instr(workspace_alias, char(92)) = 0
    )
  )
) STRICT;

INSERT INTO agents_v2 (
  agent_id, team_id, owner_member_id, device_id, name, role,
  integration_mode, capabilities_json, enabled, presence, created_at,
  updated_at, runtime_scope_id, workspace_ref, workspace_generation,
  runtime_policy_json, workspace_alias
)
SELECT
  agent_id, team_id, owner_member_id, device_id, name, role,
  integration_mode, capabilities_json, enabled, presence, created_at,
  updated_at, runtime_scope_id, workspace_ref, workspace_generation,
  runtime_policy_json, workspace_alias
FROM agents;

DROP TRIGGER workspace_leases_require_scope_insert;
DROP TRIGGER task_results_require_proposer_scope_insert;

DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;

CREATE INDEX agents_team_idx ON agents(team_id, enabled, agent_id);

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

CREATE TRIGGER task_results_require_proposer_scope_insert
BEFORE INSERT ON task_results
WHEN (
  NEW.proposed_by_kind = 'member' AND NOT EXISTS (
    SELECT 1 FROM agent_tasks task
    JOIN team_members member ON member.member_id = NEW.proposed_by_member_id
    WHERE task.task_id = NEW.task_id AND member.team_id = task.team_id
  )
) OR (
  NEW.proposed_by_kind IN ('manual_agent', 'managed_agent') AND NOT EXISTS (
    SELECT 1 FROM runs run
    JOIN agents agent ON agent.agent_id = NEW.proposed_by_agent_id
    WHERE run.run_id = NEW.proposed_by_run_id
      AND run.task_id = NEW.task_id
      AND run.room_id = NEW.room_id
      AND run.target_agent_id = NEW.proposed_by_agent_id
      AND (
        (NEW.proposed_by_kind = 'manual_agent' AND
          agent.integration_mode = 'manual') OR
        (NEW.proposed_by_kind = 'managed_agent' AND
          agent.integration_mode = 'managed')
      )
  )
) OR (
  NEW.proposed_by_kind = 'orchestrator' AND NOT EXISTS (
    SELECT 1 FROM discussions discussion
    WHERE discussion.discussion_id = NEW.proposed_by_discussion_id
      AND discussion.task_id = NEW.task_id
      AND discussion.room_id = NEW.room_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Result proposer is outside the Task authority scope');
END;

CREATE TABLE hosted_credential_keyrings (
  key_version INTEGER PRIMARY KEY CHECK (key_version > 0),
  active_slot INTEGER NOT NULL DEFAULT 1 CHECK (active_slot = 1),
  root_mode TEXT NOT NULL CHECK (
    root_mode IN ('trusted_recovery', 'local_database')
  ),
  key_derivation TEXT NOT NULL CHECK (key_derivation = 'hkdf-sha256'),
  wrapping_cipher TEXT NOT NULL CHECK (wrapping_cipher = 'aes-256-gcm'),
  kdf_salt BLOB NOT NULL CHECK (
    typeof(kdf_salt) = 'blob' AND length(kdf_salt) = 32
  ),
  local_root_key BLOB CHECK (
    local_root_key IS NULL OR (
      typeof(local_root_key) = 'blob' AND length(local_root_key) = 32
    )
  ),
  wrapped_data_key_ciphertext BLOB NOT NULL CHECK (
    typeof(wrapped_data_key_ciphertext) = 'blob' AND
    length(wrapped_data_key_ciphertext) = 32
  ),
  wrapped_data_key_nonce BLOB NOT NULL CHECK (
    typeof(wrapped_data_key_nonce) = 'blob' AND
    length(wrapped_data_key_nonce) = 12
  ),
  wrapped_data_key_auth_tag BLOB NOT NULL CHECK (
    typeof(wrapped_data_key_auth_tag) = 'blob' AND
    length(wrapped_data_key_auth_tag) = 16
  ),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    (root_mode = 'trusted_recovery' AND local_root_key IS NULL) OR
    (root_mode = 'local_database' AND local_root_key IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX hosted_credential_keyrings_one_active_idx
  ON hosted_credential_keyrings(active_slot)
  WHERE retired_at IS NULL;

CREATE TABLE hosted_provider_credentials (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  credential_id TEXT NOT NULL UNIQUE CHECK (
    credential_id GLOB 'hostedcred_*'
  ),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'openai_responses'),
  key_version INTEGER NOT NULL REFERENCES hosted_credential_keyrings(key_version)
    ON DELETE RESTRICT,
  encryption_cipher TEXT NOT NULL CHECK (
    encryption_cipher = 'aes-256-gcm'
  ),
  ciphertext BLOB NOT NULL CHECK (
    typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 16 AND 512
  ),
  nonce BLOB NOT NULL CHECK (
    typeof(nonce) = 'blob' AND length(nonce) = 12
  ),
  auth_tag BLOB NOT NULL CHECK (
    typeof(auth_tag) = 'blob' AND length(auth_tag) = 16
  ),
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_version INTEGER CHECK (
    replaced_by_version IS NULL OR replaced_by_version > credential_version
  ),
  PRIMARY KEY (agent_id, credential_version),
  UNIQUE (agent_id, credential_version, team_id, provider),
  FOREIGN KEY (agent_id, replaced_by_version)
    REFERENCES hosted_provider_credentials(agent_id, credential_version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (replaced_by_version IS NULL OR revoked_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX hosted_provider_credentials_one_active_idx
  ON hosted_provider_credentials(agent_id)
  WHERE revoked_at IS NULL;

CREATE INDEX hosted_provider_credentials_team_idx
  ON hosted_provider_credentials(team_id, agent_id, credential_version);

CREATE TABLE hosted_runtime_profiles (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'openai_responses'),
  model TEXT NOT NULL CHECK (
    length(model) BETWEEN 1 AND 160 AND model = trim(model) AND
    instr(model, char(0)) = 0 AND instr(model, char(10)) = 0 AND
    instr(model, char(13)) = 0
  ),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  execution_limits_json TEXT NOT NULL CHECK (
    length(execution_limits_json) BETWEEN 2 AND 4096 AND
    json_valid(execution_limits_json) AND
    json_type(execution_limits_json) = 'object'
  ),
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  PRIMARY KEY (agent_id, profile_revision),
  UNIQUE (
    agent_id, profile_revision, team_id, provider, model, credential_version
  ),
  FOREIGN KEY (agent_id, credential_version, team_id, provider)
    REFERENCES hosted_provider_credentials(
      agent_id, credential_version, team_id, provider
    ) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX hosted_runtime_profiles_one_current_idx
  ON hosted_runtime_profiles(agent_id)
  WHERE superseded_at IS NULL;

CREATE INDEX hosted_runtime_profiles_team_idx
  ON hosted_runtime_profiles(team_id, agent_id, profile_revision);

CREATE TABLE hosted_provider_test_observations (
  observation_id TEXT PRIMARY KEY CHECK (observation_id GLOB 'hostedtest_*'),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  profile_revision INTEGER,
  provider TEXT NOT NULL CHECK (provider = 'openai_responses'),
  model TEXT NOT NULL CHECK (
    length(model) BETWEEN 1 AND 160 AND model = trim(model) AND
    instr(model, char(0)) = 0 AND instr(model, char(10)) = 0 AND
    instr(model, char(13)) = 0
  ),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure_code TEXT CHECK (
    failure_code IS NULL OR (
      length(failure_code) BETWEEN 1 AND 80 AND
      failure_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  observed_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, profile_revision)
    REFERENCES hosted_runtime_profiles(agent_id, profile_revision)
    ON DELETE RESTRICT,
  CHECK (
    (agent_id IS NULL AND profile_revision IS NULL) OR
    (agent_id IS NOT NULL AND profile_revision IS NOT NULL)
  ),
  CHECK (
    (status = 'succeeded' AND failure_code IS NULL) OR
    (status = 'failed' AND failure_code IS NOT NULL)
  )
) STRICT;

CREATE INDEX hosted_provider_test_observations_team_idx
  ON hosted_provider_test_observations(team_id, observed_at, observation_id);

CREATE TABLE hosted_invocation_intents (
  invocation_id TEXT PRIMARY KEY CHECK (invocation_id GLOB 'hostedinv_*'),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  provider TEXT NOT NULL CHECK (provider = 'openai_responses'),
  model TEXT NOT NULL CHECK (
    length(model) BETWEEN 1 AND 160 AND model = trim(model) AND
    instr(model, char(0)) = 0 AND instr(model, char(10)) = 0 AND
    instr(model, char(13)) = 0
  ),
  deadline_at TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL CHECK (
    length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 16 AND 160
  ),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'dispatching', 'streaming', 'completed', 'failed',
    'canceled', 'outcome_unknown'
  )),
  failure_code TEXT CHECK (
    failure_code IS NULL OR (
      length(failure_code) BETWEEN 1 AND 80 AND
      failure_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  prepared_at TEXT NOT NULL,
  dispatched_at TEXT,
  streaming_at TEXT,
  cancellation_requested_at TEXT,
  cancellation_requested_by_member_id TEXT
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR
    length(trim(cancellation_reason)) BETWEEN 1 AND 512
  ),
  terminal_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (
    agent_id, profile_revision, team_id, provider, model, credential_version
  ) REFERENCES hosted_runtime_profiles(
    agent_id, profile_revision, team_id, provider, model, credential_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, credential_version, team_id, provider)
    REFERENCES hosted_provider_credentials(
      agent_id, credential_version, team_id, provider
  ) ON DELETE RESTRICT,
  CHECK (streaming_at IS NULL OR dispatched_at IS NOT NULL),
  CHECK (
    (cancellation_requested_at IS NULL AND
      cancellation_requested_by_member_id IS NULL AND
      cancellation_reason IS NULL) OR
    (cancellation_requested_at IS NOT NULL AND
      cancellation_requested_by_member_id IS NOT NULL AND
      cancellation_reason IS NOT NULL)
  ),
  CHECK (
    (state = 'prepared' AND dispatched_at IS NULL AND streaming_at IS NULL AND
      terminal_at IS NULL AND failure_code IS NULL) OR
    (state = 'dispatching' AND dispatched_at IS NOT NULL AND
      streaming_at IS NULL AND terminal_at IS NULL AND failure_code IS NULL) OR
    (state = 'streaming' AND dispatched_at IS NOT NULL AND
      streaming_at IS NOT NULL AND terminal_at IS NULL AND failure_code IS NULL) OR
    (state = 'completed' AND dispatched_at IS NOT NULL AND
      terminal_at IS NOT NULL AND failure_code IS NULL) OR
    (state = 'failed' AND terminal_at IS NOT NULL AND
      failure_code IS NOT NULL) OR
    (state = 'canceled' AND terminal_at IS NOT NULL AND
      failure_code IS NOT NULL AND cancellation_requested_at IS NOT NULL) OR
    (state = 'outcome_unknown' AND dispatched_at IS NOT NULL AND
      terminal_at IS NOT NULL AND failure_code IS NOT NULL)
  )
) STRICT;

CREATE INDEX hosted_invocation_intents_state_idx
  ON hosted_invocation_intents(state, prepared_at, invocation_id);

CREATE TRIGGER hosted_credential_keyrings_retire_once
BEFORE UPDATE ON hosted_credential_keyrings
WHEN
  NEW.key_version IS NOT OLD.key_version OR
  NEW.active_slot IS NOT OLD.active_slot OR
  NEW.root_mode IS NOT OLD.root_mode OR
  NEW.key_derivation IS NOT OLD.key_derivation OR
  NEW.wrapping_cipher IS NOT OLD.wrapping_cipher OR
  NEW.kdf_salt IS NOT OLD.kdf_salt OR
  NEW.local_root_key IS NOT OLD.local_root_key OR
  NEW.wrapped_data_key_ciphertext IS NOT OLD.wrapped_data_key_ciphertext OR
  NEW.wrapped_data_key_nonce IS NOT OLD.wrapped_data_key_nonce OR
  NEW.wrapped_data_key_auth_tag IS NOT OLD.wrapped_data_key_auth_tag OR
  NEW.created_at IS NOT OLD.created_at OR
  OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential keyring update is invalid');
END;

CREATE TRIGGER hosted_credential_keyrings_require_next_version_insert
BEFORE INSERT ON hosted_credential_keyrings
WHEN NEW.key_version <> COALESCE((
  SELECT max(key_version) + 1 FROM hosted_credential_keyrings
), 1)
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential key version is not monotonic');
END;

CREATE TRIGGER hosted_credential_keyrings_immutable_delete
BEFORE DELETE ON hosted_credential_keyrings
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential keyrings are retained evidence');
END;

CREATE TRIGGER hosted_provider_credentials_require_scope_insert
BEFORE INSERT ON hosted_provider_credentials
WHEN NOT EXISTS (
  SELECT 1
  FROM agents agent
  JOIN team_members owner
    ON owner.member_id = NEW.created_by_member_id
   AND owner.team_id = NEW.team_id
   AND owner.role = 'owner'
  WHERE agent.agent_id = NEW.agent_id
    AND agent.team_id = NEW.team_id
    AND agent.integration_mode = 'hosted'
    AND agent.device_id IS NULL
    AND agent.runtime_scope_id IS NULL
    AND agent.workspace_ref IS NULL
    AND agent.workspace_generation IS NULL
    AND agent.runtime_policy_json IS NULL
    AND agent.workspace_alias IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential scope is invalid');
END;

CREATE TRIGGER hosted_provider_credentials_require_next_version_insert
BEFORE INSERT ON hosted_provider_credentials
WHEN NEW.credential_version <> COALESCE((
  SELECT max(credential_version) + 1
  FROM hosted_provider_credentials
  WHERE agent_id = NEW.agent_id
), 1)
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential version is not monotonic');
END;

CREATE TRIGGER hosted_provider_credentials_revoke_once
BEFORE UPDATE ON hosted_provider_credentials
WHEN
  NEW.agent_id IS NOT OLD.agent_id OR
  NEW.credential_version IS NOT OLD.credential_version OR
  NEW.credential_id IS NOT OLD.credential_id OR
  NEW.team_id IS NOT OLD.team_id OR
  NEW.provider IS NOT OLD.provider OR
  NEW.key_version IS NOT OLD.key_version OR
  NEW.encryption_cipher IS NOT OLD.encryption_cipher OR
  NEW.ciphertext IS NOT OLD.ciphertext OR
  NEW.nonce IS NOT OLD.nonce OR
  NEW.auth_tag IS NOT OLD.auth_tag OR
  NEW.created_by_member_id IS NOT OLD.created_by_member_id OR
  NEW.created_at IS NOT OLD.created_at OR
  OLD.revoked_at IS NOT NULL OR
  NEW.revoked_at IS NULL OR
  OLD.replaced_by_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential update is invalid');
END;

CREATE TRIGGER hosted_provider_credentials_immutable_delete
BEFORE DELETE ON hosted_provider_credentials
BEGIN
  SELECT RAISE(ABORT, 'Hosted credentials are retained evidence');
END;

CREATE TRIGGER hosted_runtime_profiles_require_scope_insert
BEFORE INSERT ON hosted_runtime_profiles
WHEN NOT EXISTS (
  SELECT 1
  FROM agents agent
  JOIN team_members owner
    ON owner.member_id = NEW.created_by_member_id
   AND owner.team_id = NEW.team_id
   AND owner.role = 'owner'
  JOIN hosted_provider_credentials credential
    ON credential.agent_id = NEW.agent_id
   AND credential.credential_version = NEW.credential_version
   AND credential.team_id = NEW.team_id
   AND credential.provider = NEW.provider
   AND credential.revoked_at IS NULL
  WHERE agent.agent_id = NEW.agent_id
    AND agent.team_id = NEW.team_id
    AND agent.integration_mode = 'hosted'
    AND agent.device_id IS NULL
    AND agent.runtime_scope_id IS NULL
    AND agent.workspace_ref IS NULL
    AND agent.workspace_generation IS NULL
    AND agent.runtime_policy_json IS NULL
    AND agent.workspace_alias IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Hosted Runtime Profile scope is invalid');
END;

CREATE TRIGGER hosted_runtime_profiles_require_next_revision_insert
BEFORE INSERT ON hosted_runtime_profiles
WHEN NEW.profile_revision <> COALESCE((
  SELECT max(profile_revision) + 1
  FROM hosted_runtime_profiles
  WHERE agent_id = NEW.agent_id
), 1)
BEGIN
  SELECT RAISE(ABORT, 'Hosted Runtime Profile revision is not monotonic');
END;

CREATE TRIGGER hosted_runtime_profiles_supersede_once
BEFORE UPDATE ON hosted_runtime_profiles
WHEN
  NEW.agent_id IS NOT OLD.agent_id OR
  NEW.profile_revision IS NOT OLD.profile_revision OR
  NEW.team_id IS NOT OLD.team_id OR
  NEW.provider IS NOT OLD.provider OR
  NEW.model IS NOT OLD.model OR
  NEW.credential_version IS NOT OLD.credential_version OR
  NEW.execution_limits_json IS NOT OLD.execution_limits_json OR
  NEW.created_by_member_id IS NOT OLD.created_by_member_id OR
  NEW.created_at IS NOT OLD.created_at OR
  OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Hosted Runtime Profile update is invalid');
END;

CREATE TRIGGER hosted_runtime_profiles_immutable_delete
BEFORE DELETE ON hosted_runtime_profiles
BEGIN
  SELECT RAISE(ABORT, 'Hosted Runtime Profiles are retained evidence');
END;

CREATE TRIGGER hosted_provider_test_observations_require_scope_insert
BEFORE INSERT ON hosted_provider_test_observations
WHEN
  NOT EXISTS (
    SELECT 1 FROM team_members owner
    WHERE owner.member_id = NEW.observed_by_member_id
      AND owner.team_id = NEW.team_id
      AND owner.role = 'owner'
  ) OR (
    NEW.agent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM hosted_runtime_profiles profile
      WHERE profile.agent_id = NEW.agent_id
        AND profile.profile_revision = NEW.profile_revision
        AND profile.team_id = NEW.team_id
        AND profile.provider = NEW.provider
        AND profile.model = NEW.model
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Hosted provider test observation scope is invalid');
END;

CREATE TRIGGER hosted_provider_test_observations_immutable_update
BEFORE UPDATE ON hosted_provider_test_observations
BEGIN
  SELECT RAISE(ABORT, 'Hosted provider test observations are immutable');
END;

CREATE TRIGGER hosted_provider_test_observations_immutable_delete
BEFORE DELETE ON hosted_provider_test_observations
BEGIN
  SELECT RAISE(ABORT, 'Hosted provider test observations are retained evidence');
END;

CREATE TRIGGER hosted_invocation_intents_require_scope_insert
BEFORE INSERT ON hosted_invocation_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM runs run
  JOIN rooms room ON room.room_id = run.room_id
  JOIN agents agent ON agent.agent_id = run.target_agent_id
  JOIN room_agent_participants participant
    ON participant.room_id = run.room_id
   AND participant.agent_id = NEW.agent_id
  JOIN hosted_runtime_profiles profile
    ON profile.agent_id = NEW.agent_id
   AND profile.profile_revision = NEW.profile_revision
   AND profile.team_id = NEW.team_id
   AND profile.provider = NEW.provider
   AND profile.model = NEW.model
   AND profile.credential_version = NEW.credential_version
  JOIN hosted_provider_credentials credential
    ON credential.agent_id = NEW.agent_id
   AND credential.credential_version = NEW.credential_version
   AND credential.team_id = NEW.team_id
   AND credential.provider = NEW.provider
  WHERE run.run_id = NEW.run_id
    AND run.target_agent_id = NEW.agent_id
    AND room.team_id = NEW.team_id
    AND agent.team_id = NEW.team_id
    AND agent.integration_mode = 'hosted'
    AND agent.enabled = 1
    AND agent.device_id IS NULL
    AND agent.runtime_scope_id IS NULL
    AND agent.workspace_ref IS NULL
    AND agent.workspace_generation IS NULL
    AND agent.runtime_policy_json IS NULL
    AND agent.workspace_alias IS NULL
    AND profile.superseded_at IS NULL
    AND credential.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation intent scope is invalid');
END;

CREATE TRIGGER hosted_invocation_intents_require_prepared_insert
BEFORE INSERT ON hosted_invocation_intents
WHEN NEW.state <> 'prepared' OR NEW.updated_at IS NOT NEW.prepared_at
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation intent must begin prepared');
END;

CREATE TRIGGER hosted_invocation_intents_preserve_identity
BEFORE UPDATE ON hosted_invocation_intents
WHEN
  NEW.invocation_id IS NOT OLD.invocation_id OR
  NEW.run_id IS NOT OLD.run_id OR
  NEW.team_id IS NOT OLD.team_id OR
  NEW.agent_id IS NOT OLD.agent_id OR
  NEW.profile_revision IS NOT OLD.profile_revision OR
  NEW.credential_version IS NOT OLD.credential_version OR
  NEW.provider IS NOT OLD.provider OR
  NEW.model IS NOT OLD.model OR
  NEW.deadline_at IS NOT OLD.deadline_at OR
  NEW.prompt_sha256 IS NOT OLD.prompt_sha256 OR
  NEW.idempotency_key IS NOT OLD.idempotency_key OR
  NEW.prepared_at IS NOT OLD.prepared_at
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation intent identity is immutable');
END;

CREATE TRIGGER hosted_invocation_intents_require_monotonic_state
BEFORE UPDATE OF state ON hosted_invocation_intents
WHEN NEW.updated_at < OLD.updated_at OR NOT (
  (OLD.state = 'prepared' AND NEW.state IN (
    'dispatching', 'failed', 'canceled'
  )) OR
  (OLD.state = 'dispatching' AND NEW.state IN (
    'streaming', 'completed', 'failed', 'outcome_unknown'
  )) OR
  (OLD.state = 'streaming' AND NEW.state IN (
    'completed', 'failed', 'outcome_unknown'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation intent state transition is invalid');
END;

CREATE TRIGGER hosted_invocation_intents_require_state_transition
BEFORE UPDATE OF dispatched_at, streaming_at, terminal_at, failure_code
ON hosted_invocation_intents
WHEN NEW.state = OLD.state
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation lifecycle fields require a state transition');
END;

CREATE TRIGGER hosted_invocation_intents_request_cancel_once
BEFORE UPDATE OF
  cancellation_requested_at, cancellation_requested_by_member_id,
  cancellation_reason
ON hosted_invocation_intents
WHEN
  OLD.cancellation_requested_at IS NOT NULL OR
  NEW.cancellation_requested_at IS NULL OR
  NEW.cancellation_requested_by_member_id IS NULL OR
  NEW.cancellation_reason IS NULL OR
  OLD.state IN ('completed', 'failed', 'canceled', 'outcome_unknown') OR
  NOT EXISTS (
    SELECT 1 FROM team_members member
    WHERE member.member_id = NEW.cancellation_requested_by_member_id
      AND member.team_id = OLD.team_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation cancellation request is invalid');
END;

CREATE TRIGGER hosted_invocation_intents_immutable_delete
BEFORE DELETE ON hosted_invocation_intents
BEGIN
  SELECT RAISE(ABORT, 'Hosted invocation intents are retained evidence');
END;
