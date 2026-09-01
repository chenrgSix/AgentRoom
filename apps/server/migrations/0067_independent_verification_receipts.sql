CREATE TABLE repository_verification_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  request_digest TEXT NOT NULL UNIQUE CHECK (
    length(request_digest) = 64 AND
    request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  checkpoint_id TEXT NOT NULL REFERENCES repository_checkpoints(checkpoint_id)
    ON DELETE RESTRICT,
  profile_id TEXT NOT NULL CHECK (profile_id GLOB 'profile_*'),
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  profile_digest TEXT NOT NULL CHECK (
    length(profile_digest) = 64 AND
    profile_digest NOT GLOB '*[^0-9a-f]*'
  ),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE RESTRICT,
  admitted_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  UNIQUE (checkpoint_id, profile_id, profile_revision, profile_digest),
  CHECK (json_extract(request_json, '$.operationId') IS operation_id),
  CHECK (json_extract(request_json, '$.requestDigest') IS request_digest),
  CHECK (json_extract(request_json, '$.action.kind') = 'verify'),
  CHECK (json_extract(request_json, '$.action.verify.profile.profileId') IS profile_id),
  CHECK (json_extract(request_json, '$.action.verify.profile.revision') IS profile_revision),
  CHECK (json_extract(request_json, '$.action.verify.profile.digest') IS profile_digest),
  CHECK (json_extract(request_json, '$.deviceId') IS device_id),
  CHECK (json_extract(request_json, '$.deadline') IS deadline)
) STRICT;

ALTER TABLE artifact_publications
  ADD COLUMN verification_operation_id TEXT
  REFERENCES repository_verification_operations(operation_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX artifact_publications_verification_log_idx
  ON artifact_publications(verification_operation_id)
  WHERE verification_operation_id IS NOT NULL;

CREATE TRIGGER artifact_publications_verification_log_scope_insert
BEFORE INSERT ON artifact_publications
WHEN NEW.verification_operation_id IS NOT NULL AND NOT (
  NEW.artifact_type = 'test_result' AND EXISTS (
    SELECT 1 FROM repository_verification_operations verification
    JOIN repository_checkpoints checkpoint
      ON checkpoint.checkpoint_id = verification.checkpoint_id
    JOIN repository_capture_operations capture
      ON capture.operation_id = checkpoint.operation_id
    JOIN workspace_leases lease
      ON lease.capture_operation_id = capture.operation_id
    WHERE verification.operation_id = NEW.verification_operation_id
      AND lease.lease_id = NEW.lease_id
      AND verification.device_id = NEW.device_id
      AND json_extract(verification.request_json, '$.execution.runId') = NEW.run_id
  )
)
BEGIN SELECT RAISE(ABORT, 'Verification log publication scope is invalid'); END;

CREATE TRIGGER artifact_publications_verification_operation_immutable
BEFORE UPDATE OF verification_operation_id ON artifact_publications
WHEN NEW.verification_operation_id IS NOT OLD.verification_operation_id
BEGIN SELECT RAISE(ABORT, 'Verification log authority is immutable'); END;

CREATE TABLE verification_receipts (
  verification_id TEXT PRIMARY KEY CHECK (verification_id GLOB 'verification_*'),
  operation_id TEXT NOT NULL UNIQUE
    REFERENCES repository_verification_operations(operation_id) ON DELETE RESTRICT,
  receipt_digest TEXT NOT NULL UNIQUE CHECK (
    length(receipt_digest) = 64 AND
    receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('passed', 'failed', 'timed_out', 'canceled', 'outcome_unknown')
  ),
  log_artifact_id TEXT REFERENCES task_artifact_refs(artifact_id) ON DELETE RESTRICT,
  log_artifact_revision INTEGER,
  recorded_at TEXT NOT NULL,
  CHECK (json_extract(receipt_json, '$.verificationId') IS verification_id),
  CHECK (json_extract(receipt_json, '$.operationId') IS operation_id),
  CHECK (json_extract(receipt_json, '$.outcome') IS outcome),
  CHECK (
    (log_artifact_id IS NULL AND log_artifact_revision IS NULL AND
      json_type(receipt_json, '$.logArtifact') = 'null') OR
    (log_artifact_id IS NOT NULL AND log_artifact_revision > 0 AND
      json_extract(receipt_json, '$.logArtifact.artifactId') IS log_artifact_id AND
      json_extract(receipt_json, '$.logArtifact.artifactRevision') IS log_artifact_revision)
  )
) STRICT;

CREATE TRIGGER repository_verification_operations_immutable_update
BEFORE UPDATE ON repository_verification_operations
BEGIN SELECT RAISE(ABORT, 'Repository verification operations are immutable'); END;

CREATE TRIGGER repository_verification_operations_immutable_delete
BEFORE DELETE ON repository_verification_operations
BEGIN SELECT RAISE(ABORT, 'Repository verification operations are retained'); END;

CREATE TRIGGER verification_receipts_immutable_update
BEFORE UPDATE ON verification_receipts
BEGIN SELECT RAISE(ABORT, 'Verification receipts are immutable'); END;

CREATE TRIGGER verification_receipts_immutable_delete
BEFORE DELETE ON verification_receipts
BEGIN SELECT RAISE(ABORT, 'Verification receipts are retained evidence'); END;
