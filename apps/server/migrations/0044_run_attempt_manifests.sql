ALTER TABLE runs ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1
  CHECK (attempt_number > 0);
ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT REFERENCES runs(run_id)
  ON DELETE RESTRICT;
ALTER TABLE runs ADD COLUMN context_manifest_json TEXT CHECK (
  context_manifest_json IS NULL OR (
    json_valid(context_manifest_json) AND
    json_type(context_manifest_json) = 'object'
  )
);

UPDATE runs AS run
SET attempt_number = (
  SELECT COUNT(*)
  FROM runs AS earlier
  WHERE earlier.task_id = run.task_id
    AND (
      earlier.created_at < run.created_at OR
      (earlier.created_at = run.created_at AND earlier.run_id <= run.run_id)
    )
);

CREATE UNIQUE INDEX runs_task_attempt_number_idx
  ON runs(task_id, attempt_number);
CREATE INDEX runs_retry_lineage_idx
  ON runs(retry_of_run_id, attempt_number, run_id)
  WHERE retry_of_run_id IS NOT NULL;

CREATE TABLE run_retry_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  parent_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  retry_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE RESTRICT,
  created_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE run_ambiguity_acknowledgements (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  task_id TEXT NOT NULL REFERENCES agent_tasks(task_id) ON DELETE RESTRICT,
  acknowledged_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  task_revision_before INTEGER NOT NULL CHECK (task_revision_before > 0),
  task_revision_after INTEGER NOT NULL CHECK (
    task_revision_after = task_revision_before + 1
  ),
  acknowledged_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER runs_require_retry_scope_insert
BEFORE INSERT ON runs
WHEN NEW.retry_of_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs parent
  WHERE parent.run_id = NEW.retry_of_run_id
    AND parent.task_id = NEW.task_id
    AND parent.room_id = NEW.room_id
    AND parent.target_agent_id = NEW.target_agent_id
    AND parent.attempt_number < NEW.attempt_number
)
BEGIN
  SELECT RAISE(ABORT, 'Run retry lineage is invalid');
END;

CREATE TRIGGER runs_attempt_identity_immutable_update
BEFORE UPDATE OF attempt_number, retry_of_run_id, context_manifest_json ON runs
WHEN NEW.attempt_number <> OLD.attempt_number OR
     NEW.retry_of_run_id IS NOT OLD.retry_of_run_id OR
     (OLD.context_manifest_json IS NOT NULL AND
       NEW.context_manifest_json IS NOT OLD.context_manifest_json)
BEGIN
  SELECT RAISE(ABORT, 'Run attempt identity and Context Manifest are immutable');
END;

CREATE TRIGGER run_ambiguity_ack_requires_unknown_insert
BEFORE INSERT ON run_ambiguity_acknowledgements
WHEN NOT EXISTS (
  SELECT 1 FROM runs run
  WHERE run.run_id = NEW.run_id
    AND run.task_id = NEW.task_id
    AND run.state = 'outcome_unknown'
)
BEGIN
  SELECT RAISE(ABORT, 'Only an outcome_unknown Run may be acknowledged');
END;

CREATE TRIGGER run_ambiguity_acknowledgements_immutable_update
BEFORE UPDATE ON run_ambiguity_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'Run ambiguity acknowledgements are immutable');
END;

CREATE TRIGGER run_ambiguity_acknowledgements_immutable_delete
BEFORE DELETE ON run_ambiguity_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'Run ambiguity acknowledgements are immutable');
END;
