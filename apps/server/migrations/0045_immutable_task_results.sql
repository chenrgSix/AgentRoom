CREATE TABLE task_results (
  result_id TEXT PRIMARY KEY CHECK (result_id GLOB 'result_*'),
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  state TEXT NOT NULL CHECK (
    state IN ('proposed', 'accepted', 'rejected', 'superseded')
  ),
  definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
  criteria_revision INTEGER NOT NULL CHECK (criteria_revision > 0),
  proposed_at_task_revision INTEGER NOT NULL
    CHECK (proposed_at_task_revision > 0),
  supersedes_result_id TEXT UNIQUE REFERENCES task_results(result_id)
    ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('satisfied', 'partial', 'not_satisfied', 'informational')
  ),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 20000),
  risks_json TEXT NOT NULL CHECK (
    json_valid(risks_json) AND json_type(risks_json) = 'array'
  ),
  open_questions_json TEXT NOT NULL CHECK (
    json_valid(open_questions_json) AND json_type(open_questions_json) = 'array'
  ),
  proposed_by_kind TEXT NOT NULL CHECK (
    proposed_by_kind IN (
      'member', 'manual_agent', 'managed_agent', 'orchestrator'
    )
  ),
  proposed_by_member_id TEXT REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  proposed_by_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  proposed_by_run_id TEXT REFERENCES runs(run_id) ON DELETE RESTRICT,
  proposed_by_discussion_id TEXT REFERENCES discussions(discussion_id)
    ON DELETE RESTRICT,
  proposed_at TEXT NOT NULL,
  FOREIGN KEY (task_id, room_id)
    REFERENCES agent_tasks(task_id, room_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, definition_revision)
    REFERENCES task_definition_revisions(task_id, definition_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (task_id, criteria_revision)
    REFERENCES task_criteria_revisions(task_id, criteria_revision)
    ON DELETE RESTRICT,
  UNIQUE (task_id, result_version),
  UNIQUE (result_id, task_id, criteria_revision),
  CHECK (
    (proposed_by_kind = 'member' AND proposed_by_member_id IS NOT NULL AND
      proposed_by_agent_id IS NULL AND proposed_by_run_id IS NULL AND
      proposed_by_discussion_id IS NULL) OR
    (proposed_by_kind IN ('manual_agent', 'managed_agent') AND
      proposed_by_member_id IS NULL AND proposed_by_agent_id IS NOT NULL AND
      proposed_by_run_id IS NOT NULL AND proposed_by_discussion_id IS NULL) OR
    (proposed_by_kind = 'orchestrator' AND proposed_by_member_id IS NULL AND
      proposed_by_agent_id IS NULL AND proposed_by_run_id IS NULL AND
      proposed_by_discussion_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX task_results_task_version_idx
  ON task_results(task_id, result_version DESC, result_id DESC);
CREATE INDEX task_results_task_state_idx
  ON task_results(task_id, state, proposed_at DESC, result_id DESC);

CREATE TABLE result_next_actions (
  result_id TEXT NOT NULL REFERENCES task_results(result_id) ON DELETE RESTRICT,
  next_action_key TEXT NOT NULL CHECK (next_action_key GLOB 'next_*'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 50),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
  PRIMARY KEY (result_id, next_action_key),
  UNIQUE (result_id, ordinal)
) STRICT;

CREATE TABLE result_evidence_refs (
  result_id TEXT NOT NULL REFERENCES task_results(result_id) ON DELETE RESTRICT,
  evidence_ref_id TEXT NOT NULL CHECK (evidence_ref_id GLOB 'evidence_*'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  evidence_kind TEXT NOT NULL CHECK (
    evidence_kind IN ('artifact', 'run_event', 'message', 'memory', 'discussion')
  ),
  artifact_id TEXT REFERENCES task_artifact_refs(artifact_id) ON DELETE RESTRICT,
  run_id TEXT,
  run_sequence INTEGER,
  message_id TEXT REFERENCES messages(message_id) ON DELETE RESTRICT,
  memory_id TEXT REFERENCES memory_entries(memory_id) ON DELETE RESTRICT,
  discussion_id TEXT REFERENCES discussions(discussion_id) ON DELETE RESTRICT,
  PRIMARY KEY (result_id, evidence_ref_id),
  UNIQUE (result_id, ordinal),
  FOREIGN KEY (run_id, run_sequence)
    REFERENCES run_events(run_id, sequence) ON DELETE RESTRICT,
  CHECK (
    (evidence_kind = 'artifact' AND artifact_id IS NOT NULL AND
      run_id IS NULL AND run_sequence IS NULL AND message_id IS NULL AND
      memory_id IS NULL AND discussion_id IS NULL) OR
    (evidence_kind = 'run_event' AND artifact_id IS NULL AND
      run_id IS NOT NULL AND run_sequence IS NOT NULL AND message_id IS NULL AND
      memory_id IS NULL AND discussion_id IS NULL) OR
    (evidence_kind = 'message' AND artifact_id IS NULL AND
      run_id IS NULL AND run_sequence IS NULL AND message_id IS NOT NULL AND
      memory_id IS NULL AND discussion_id IS NULL) OR
    (evidence_kind = 'memory' AND artifact_id IS NULL AND
      run_id IS NULL AND run_sequence IS NULL AND message_id IS NULL AND
      memory_id IS NOT NULL AND discussion_id IS NULL) OR
    (evidence_kind = 'discussion' AND artifact_id IS NULL AND
      run_id IS NULL AND run_sequence IS NULL AND message_id IS NULL AND
      memory_id IS NULL AND discussion_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE result_criterion_claims (
  result_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  criteria_revision INTEGER NOT NULL CHECK (criteria_revision > 0),
  criterion_key TEXT NOT NULL CHECK (criterion_key GLOB 'criterion_*'),
  coverage TEXT NOT NULL CHECK (
    coverage IN ('satisfied', 'unresolved', 'not_satisfied', 'not_applicable')
  ),
  explanation TEXT NOT NULL CHECK (
    length(trim(explanation)) BETWEEN 1 AND 4000
  ),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  PRIMARY KEY (result_id, criterion_key),
  UNIQUE (result_id, ordinal),
  FOREIGN KEY (result_id, task_id, criteria_revision)
    REFERENCES task_results(result_id, task_id, criteria_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (task_id, criteria_revision, criterion_key)
    REFERENCES task_criteria_entries(task_id, criteria_revision, criterion_key)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE result_claim_evidence (
  result_id TEXT NOT NULL,
  criterion_key TEXT NOT NULL,
  evidence_ref_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  PRIMARY KEY (result_id, criterion_key, evidence_ref_id),
  UNIQUE (result_id, criterion_key, ordinal),
  FOREIGN KEY (result_id, criterion_key)
    REFERENCES result_criterion_claims(result_id, criterion_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (result_id, evidence_ref_id)
    REFERENCES result_evidence_refs(result_id, evidence_ref_id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE result_reviews (
  result_id TEXT PRIMARY KEY REFERENCES task_results(result_id)
    ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  review_revision INTEGER NOT NULL CHECK (review_revision = 1),
  reviewed_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 4000),
  task_revision_before INTEGER NOT NULL CHECK (task_revision_before > 0),
  task_revision_after INTEGER NOT NULL CHECK (
    task_revision_after = task_revision_before + 1
  ),
  completed_task INTEGER NOT NULL CHECK (completed_task IN (0, 1)),
  reviewed_at TEXT NOT NULL
) STRICT;

CREATE TABLE task_result_sources (
  child_task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id)
    ON DELETE RESTRICT,
  source_result_id TEXT NOT NULL,
  next_action_key TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  created_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_result_id, next_action_key)
    REFERENCES result_next_actions(result_id, next_action_key)
    ON DELETE RESTRICT
) STRICT;

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
        (NEW.proposed_by_kind = 'manual_agent' AND agent.integration_mode = 'manual') OR
        (NEW.proposed_by_kind = 'managed_agent' AND agent.integration_mode = 'managed')
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

CREATE TRIGGER task_results_require_supersession_scope_insert
BEFORE INSERT ON task_results
WHEN NEW.supersedes_result_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM task_results previous
  WHERE previous.result_id = NEW.supersedes_result_id
    AND previous.task_id = NEW.task_id
    AND previous.room_id = NEW.room_id
    AND previous.state IN ('proposed', 'rejected')
)
BEGIN
  SELECT RAISE(ABORT, 'Result supersession must replace a correctable Task Result');
END;

CREATE TRIGGER result_evidence_refs_require_task_scope_insert
BEFORE INSERT ON result_evidence_refs
WHEN NOT EXISTS (
  SELECT 1 FROM task_results result
  WHERE result.result_id = NEW.result_id AND (
    (NEW.evidence_kind = 'artifact' AND EXISTS (
      SELECT 1 FROM task_artifact_refs artifact
      WHERE artifact.artifact_id = NEW.artifact_id
        AND artifact.task_id = result.task_id
        AND artifact.room_id = result.room_id
    )) OR
    (NEW.evidence_kind = 'run_event' AND EXISTS (
      SELECT 1 FROM run_events event
      JOIN runs run ON run.run_id = event.run_id
      WHERE event.run_id = NEW.run_id AND event.sequence = NEW.run_sequence
        AND run.task_id = result.task_id AND run.room_id = result.room_id
    )) OR
    (NEW.evidence_kind = 'message' AND EXISTS (
      SELECT 1 FROM messages message
      WHERE message.message_id = NEW.message_id
        AND message.task_id = result.task_id AND message.room_id = result.room_id
    )) OR
    (NEW.evidence_kind = 'memory' AND EXISTS (
      SELECT 1 FROM memory_entries memory
      WHERE memory.memory_id = NEW.memory_id AND memory.room_id = result.room_id
        AND (memory.task_id IS NULL OR memory.task_id = result.task_id)
    )) OR
    (NEW.evidence_kind = 'discussion' AND EXISTS (
      SELECT 1 FROM discussions discussion
      WHERE discussion.discussion_id = NEW.discussion_id
        AND discussion.task_id = result.task_id
        AND discussion.room_id = result.room_id
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Result evidence must belong to the same Task scope');
END;

CREATE TRIGGER result_reviews_require_proposed_insert
BEFORE INSERT ON result_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM task_results result
  WHERE result.result_id = NEW.result_id AND result.state = 'proposed'
)
BEGIN
  SELECT RAISE(ABORT, 'Only a proposed Result may be reviewed');
END;

CREATE TRIGGER task_results_immutable_payload_update
BEFORE UPDATE ON task_results
WHEN NEW.result_id <> OLD.result_id OR NEW.task_id <> OLD.task_id OR
  NEW.room_id <> OLD.room_id OR NEW.result_version <> OLD.result_version OR
  NEW.operation_id <> OLD.operation_id OR
  NEW.definition_revision <> OLD.definition_revision OR
  NEW.criteria_revision <> OLD.criteria_revision OR
  NEW.proposed_at_task_revision <> OLD.proposed_at_task_revision OR
  NEW.supersedes_result_id IS NOT OLD.supersedes_result_id OR
  NEW.outcome <> OLD.outcome OR NEW.summary <> OLD.summary OR
  NEW.risks_json <> OLD.risks_json OR
  NEW.open_questions_json <> OLD.open_questions_json OR
  NEW.proposed_by_kind <> OLD.proposed_by_kind OR
  NEW.proposed_by_member_id IS NOT OLD.proposed_by_member_id OR
  NEW.proposed_by_agent_id IS NOT OLD.proposed_by_agent_id OR
  NEW.proposed_by_run_id IS NOT OLD.proposed_by_run_id OR
  NEW.proposed_by_discussion_id IS NOT OLD.proposed_by_discussion_id OR
  NEW.proposed_at <> OLD.proposed_at
BEGIN
  SELECT RAISE(ABORT, 'Result proposal is immutable');
END;

CREATE TRIGGER task_results_require_state_transition_update
BEFORE UPDATE OF state ON task_results
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'proposed' AND NEW.state IN ('accepted', 'rejected', 'superseded')) OR
  (OLD.state = 'rejected' AND NEW.state = 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'Result state transition is invalid');
END;

CREATE TRIGGER task_results_immutable_delete
BEFORE DELETE ON task_results
BEGIN
  SELECT RAISE(ABORT, 'Results are immutable');
END;

CREATE TRIGGER result_next_actions_immutable_update
BEFORE UPDATE ON result_next_actions
BEGIN
  SELECT RAISE(ABORT, 'Result next actions are immutable');
END;

CREATE TRIGGER result_next_actions_immutable_delete
BEFORE DELETE ON result_next_actions
BEGIN
  SELECT RAISE(ABORT, 'Result next actions are immutable');
END;

CREATE TRIGGER result_evidence_refs_immutable_update
BEFORE UPDATE ON result_evidence_refs
BEGIN
  SELECT RAISE(ABORT, 'Result evidence is immutable');
END;

CREATE TRIGGER result_evidence_refs_immutable_delete
BEFORE DELETE ON result_evidence_refs
BEGIN
  SELECT RAISE(ABORT, 'Result evidence is immutable');
END;

CREATE TRIGGER result_criterion_claims_immutable_update
BEFORE UPDATE ON result_criterion_claims
BEGIN
  SELECT RAISE(ABORT, 'Result criterion claims are immutable');
END;

CREATE TRIGGER result_criterion_claims_immutable_delete
BEFORE DELETE ON result_criterion_claims
BEGIN
  SELECT RAISE(ABORT, 'Result criterion claims are immutable');
END;

CREATE TRIGGER result_claim_evidence_immutable_update
BEFORE UPDATE ON result_claim_evidence
BEGIN
  SELECT RAISE(ABORT, 'Result claim evidence is immutable');
END;

CREATE TRIGGER result_claim_evidence_immutable_delete
BEFORE DELETE ON result_claim_evidence
BEGIN
  SELECT RAISE(ABORT, 'Result claim evidence is immutable');
END;

CREATE TRIGGER result_reviews_immutable_update
BEFORE UPDATE ON result_reviews
BEGIN
  SELECT RAISE(ABORT, 'Result reviews are immutable');
END;

CREATE TRIGGER result_reviews_immutable_delete
BEFORE DELETE ON result_reviews
BEGIN
  SELECT RAISE(ABORT, 'Result reviews are immutable');
END;

CREATE TRIGGER task_result_sources_immutable_update
BEFORE UPDATE ON task_result_sources
BEGIN
  SELECT RAISE(ABORT, 'Result-to-Task source edges are immutable');
END;

CREATE TRIGGER task_result_sources_immutable_delete
BEFORE DELETE ON task_result_sources
BEGIN
  SELECT RAISE(ABORT, 'Result-to-Task source edges are immutable');
END;

CREATE TRIGGER task_result_sources_require_same_room_insert
BEFORE INSERT ON task_result_sources
WHEN NOT EXISTS (
  SELECT 1 FROM agent_tasks child
  JOIN task_results result ON result.result_id = NEW.source_result_id
  WHERE child.task_id = NEW.child_task_id AND child.room_id = result.room_id
    AND result.state = 'accepted'
)
BEGIN
  SELECT RAISE(ABORT, 'Result child Task must remain in the same Room');
END;

CREATE TRIGGER agent_tasks_require_valid_completion_result_update
BEFORE UPDATE OF completion_result_id, lifecycle_state, completion_policy
ON agent_tasks
WHEN (
  NEW.completion_result_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_results result
    WHERE result.result_id = NEW.completion_result_id
      AND result.task_id = NEW.task_id
      AND result.state = 'accepted'
      AND result.definition_revision = NEW.definition_revision
      AND result.criteria_revision = NEW.criteria_revision
  )
) OR (
  NEW.lifecycle_state = 'completed' AND
  NEW.completion_policy = 'accepted_result_required' AND
  NEW.completion_result_id IS NULL
) OR (
  NEW.lifecycle_state = 'completed' AND
  NEW.completion_result_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM task_criteria_entries criterion
    WHERE criterion.task_id = NEW.task_id
      AND criterion.criteria_revision = NEW.criteria_revision
      AND criterion.required = 1 AND NOT EXISTS (
        SELECT 1 FROM result_criterion_claims claim
        WHERE claim.result_id = NEW.completion_result_id
          AND claim.criterion_key = criterion.criterion_key
          AND claim.coverage = 'satisfied'
          AND EXISTS (
            SELECT 1 FROM result_claim_evidence link
            JOIN result_evidence_refs evidence
              ON evidence.result_id = link.result_id
             AND evidence.evidence_ref_id = link.evidence_ref_id
            WHERE link.result_id = claim.result_id
              AND link.criterion_key = claim.criterion_key
              AND evidence.evidence_kind = 'artifact'
          )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Task completion Result is invalid or stale');
END;
