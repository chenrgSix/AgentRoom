UPDATE discussions
SET policy_json = json_set(
  policy_json,
  '$.waveCompletionMode', 'all_settled',
  '$.quorumMinimumCompleted', 2,
  '$.quorumSoftDeadlineSeconds', 60
)
WHERE json_type(policy_json, '$.waveCompletionMode') IS NULL
   OR json_type(policy_json, '$.quorumMinimumCompleted') IS NULL
   OR json_type(policy_json, '$.quorumSoftDeadlineSeconds') IS NULL;

CREATE TABLE discussion_wave_seals (
  seal_id TEXT PRIMARY KEY CHECK (seal_id GLOB 'seal_*'),
  discussion_id TEXT NOT NULL
    REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  wave_id TEXT NOT NULL UNIQUE
    REFERENCES discussion_waves(wave_id) ON DELETE CASCADE,
  soft_deadline_at TEXT NOT NULL,
  minimum_completed INTEGER NOT NULL CHECK (minimum_completed BETWEEN 2 AND 5),
  required_roles_json TEXT NOT NULL CHECK (
    json_valid(required_roles_json) AND
    json_type(required_roles_json) = 'array'
  ),
  accepted_members_json TEXT NOT NULL CHECK (
    json_valid(accepted_members_json) AND
    json_type(accepted_members_json) = 'array' AND
    json_array_length(accepted_members_json) BETWEEN 2 AND 5
  ),
  seal_digest TEXT NOT NULL CHECK (
    length(seal_digest) = 64 AND seal_digest NOT GLOB '*[^0-9a-f]*'
  ),
  sealed_at TEXT NOT NULL
) STRICT;

CREATE INDEX discussion_wave_seals_discussion_idx
  ON discussion_wave_seals(discussion_id, sealed_at, seal_id);

CREATE TRIGGER discussion_wave_seals_immutable_update
BEFORE UPDATE ON discussion_wave_seals
BEGIN SELECT RAISE(ABORT, 'Discussion Wave seal is immutable'); END;

CREATE TRIGGER discussion_wave_seals_immutable_delete
BEFORE DELETE ON discussion_wave_seals
BEGIN SELECT RAISE(ABORT, 'Discussion Wave seal is immutable'); END;

CREATE TABLE discussion_supplemental_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (evidence_id GLOB 'supplement_*'),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  seal_id TEXT NOT NULL
    REFERENCES discussion_wave_seals(seal_id) ON DELETE RESTRICT,
  discussion_id TEXT NOT NULL
    REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  wave_id TEXT NOT NULL
    REFERENCES discussion_waves(wave_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL
    REFERENCES discussion_turns(turn_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL
    REFERENCES runs(run_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL
    REFERENCES agents(agent_id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL
    REFERENCES devices(device_id) ON DELETE RESTRICT,
  source_reply_sequence INTEGER NOT NULL CHECK (source_reply_sequence > 0),
  source_message_id TEXT NOT NULL
    REFERENCES messages(message_id) ON DELETE RESTRICT,
  source_message_sequence INTEGER NOT NULL CHECK (source_message_sequence > 0),
  reply_hash TEXT NOT NULL CHECK (
    length(reply_hash) = 64 AND reply_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  submitted_at TEXT NOT NULL,
  UNIQUE (seal_id, turn_id)
) STRICT;

CREATE INDEX discussion_supplemental_evidence_discussion_idx
  ON discussion_supplemental_evidence(
    discussion_id, submitted_at, evidence_id
  );

CREATE TRIGGER discussion_supplemental_evidence_immutable_update
BEFORE UPDATE ON discussion_supplemental_evidence
BEGIN SELECT RAISE(ABORT, 'Discussion supplemental evidence is immutable'); END;

CREATE TRIGGER discussion_supplemental_evidence_immutable_delete
BEFORE DELETE ON discussion_supplemental_evidence
BEGIN SELECT RAISE(ABORT, 'Discussion supplemental evidence is immutable'); END;
