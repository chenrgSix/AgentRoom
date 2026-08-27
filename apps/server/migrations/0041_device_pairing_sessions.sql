CREATE TABLE device_pairing_sessions (
  pairing_session_id TEXT PRIMARY KEY CHECK (pairing_session_id GLOB 'pairing_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE CASCADE,
  create_operation_id TEXT NOT NULL CHECK (create_operation_id GLOB 'op_*'),
  claim_secret_hash TEXT NOT NULL CHECK (length(claim_secret_hash) = 64),
  short_code_hash TEXT NOT NULL UNIQUE CHECK (length(short_code_hash) = 64),
  state TEXT NOT NULL CHECK (
    state IN (
      'issued', 'claimed', 'approved', 'consumed', 'rejected', 'canceled',
      'expired'
    )
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  pairing_attempt_id TEXT UNIQUE CHECK (
    pairing_attempt_id IS NULL OR pairing_attempt_id GLOB 'pairattempt_*'
  ),
  claim_operation_id TEXT CHECK (
    claim_operation_id IS NULL OR claim_operation_id GLOB 'op_*'
  ),
  poll_secret_hash TEXT UNIQUE CHECK (
    poll_secret_hash IS NULL OR length(poll_secret_hash) = 64
  ),
  device_display_name TEXT CHECK (
    device_display_name IS NULL OR
    length(trim(device_display_name)) BETWEEN 1 AND 80
  ),
  device_platform TEXT CHECK (
    device_platform IS NULL OR device_platform IN (
      'darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64',
      'windows-amd64', 'windows-arm64'
    )
  ),
  bridge_version TEXT CHECK (
    bridge_version IS NULL OR length(bridge_version) BETWEEN 1 AND 40
  ),
  verification_phrase TEXT CHECK (
    verification_phrase IS NULL OR length(verification_phrase) BETWEEN 8 AND 48
  ),
  claimed_at TEXT,
  decision_operation_id TEXT CHECK (
    decision_operation_id IS NULL OR decision_operation_id GLOB 'op_*'
  ),
  decision_action TEXT CHECK (
    decision_action IS NULL OR decision_action IN ('approve', 'reject', 'cancel')
  ),
  decision_expected_state TEXT CHECK (
    decision_expected_state IS NULL OR
    decision_expected_state IN ('issued', 'claimed')
  ),
  decided_by_member_id TEXT
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  decision_reason TEXT CHECK (
    decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 280
  ),
  decided_at TEXT,
  consumed_at TEXT,
  device_id TEXT UNIQUE REFERENCES devices(device_id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE
    REFERENCES device_credentials(credential_id) ON DELETE CASCADE,
  UNIQUE (owner_member_id, create_operation_id),
  CHECK (
    (pairing_attempt_id IS NULL AND claim_operation_id IS NULL AND
      poll_secret_hash IS NULL AND device_display_name IS NULL AND
      device_platform IS NULL AND bridge_version IS NULL AND
      verification_phrase IS NULL AND claimed_at IS NULL) OR
    (pairing_attempt_id IS NOT NULL AND claim_operation_id IS NOT NULL AND
      poll_secret_hash IS NOT NULL AND device_display_name IS NOT NULL AND
      device_platform IS NOT NULL AND bridge_version IS NOT NULL AND
      verification_phrase IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CHECK (
    (decision_operation_id IS NULL AND decision_action IS NULL AND
      decision_expected_state IS NULL AND
      decided_by_member_id IS NULL AND decision_reason IS NULL AND
      decided_at IS NULL) OR
    (decision_operation_id IS NOT NULL AND decision_action IS NOT NULL AND
      decision_expected_state IS NOT NULL AND decided_by_member_id IS NOT NULL AND
      decided_at IS NOT NULL)
  ),
  CHECK (
    (state = 'issued' AND pairing_attempt_id IS NULL AND
      decision_action IS NULL AND device_id IS NULL AND credential_id IS NULL AND
      consumed_at IS NULL) OR
    (state = 'claimed' AND pairing_attempt_id IS NOT NULL AND
      decision_action IS NULL AND device_id IS NULL AND credential_id IS NULL AND
      consumed_at IS NULL) OR
    (state = 'approved' AND pairing_attempt_id IS NOT NULL AND
      decision_action = 'approve' AND device_id IS NOT NULL AND
      credential_id IS NOT NULL AND consumed_at IS NULL) OR
    (state = 'consumed' AND pairing_attempt_id IS NOT NULL AND
      decision_action = 'approve' AND device_id IS NOT NULL AND
      credential_id IS NOT NULL AND consumed_at IS NOT NULL) OR
    (state = 'rejected' AND pairing_attempt_id IS NOT NULL AND
      decision_action = 'reject' AND device_id IS NULL AND credential_id IS NULL AND
      consumed_at IS NULL) OR
    (state = 'canceled' AND decision_action = 'cancel' AND
      device_id IS NULL AND credential_id IS NULL AND consumed_at IS NULL) OR
    (state = 'expired' AND decision_action IS NULL AND
      device_id IS NULL AND credential_id IS NULL AND consumed_at IS NULL)
  )
) STRICT;

CREATE INDEX device_pairing_sessions_owner_idx
  ON device_pairing_sessions(team_id, owner_member_id, state, created_at);

CREATE INDEX device_pairing_sessions_expiry_idx
  ON device_pairing_sessions(state, expires_at);
