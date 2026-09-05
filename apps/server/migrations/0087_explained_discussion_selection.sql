-- convenewire:migration foreign_keys=off

CREATE TABLE discussion_waves_v2 (
  wave_id TEXT PRIMARY KEY CHECK (wave_id GLOB 'wave_*'),
  discussion_id TEXT NOT NULL
    REFERENCES discussions(discussion_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  phase TEXT NOT NULL CHECK (phase IN (
    'contribution', 'review', 'finalization'
  )),
  input_message_id TEXT NOT NULL
    REFERENCES messages(message_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'open', 'completed', 'partial', 'failed', 'canceled'
  )),
  deadline_at TEXT NOT NULL,
  expected_members INTEGER NOT NULL CHECK (expected_members BETWEEN 1 AND 5),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  selection_json TEXT
    CHECK (
      selection_json IS NULL OR (
        json_valid(selection_json) AND
        json_type(selection_json) = 'object' AND
        json_extract(selection_json, '$.version') IN (1, 2) AND
        json_extract(selection_json, '$.strategy') IN (
          'all_eligible', 'question_focused', 'finalizer'
        ) AND
        json_type(selection_json, '$.focusQuestionIds') = 'array' AND
        json_type(selection_json, '$.eligibleAgentIds') = 'array' AND
        json_type(selection_json, '$.selectedAgentIds') = 'array' AND
        json_array_length(selection_json, '$.selectedAgentIds') BETWEEN 1 AND 5 AND
        json_type(selection_json, '$.requiredRoles') = 'array' AND
        json_extract(selection_json, '$.focusedParticipantLimit') BETWEEN 2 AND 5 AND
        length(json_extract(selection_json, '$.selectionDigest')) = 64 AND
        (json_extract(selection_json, '$.version') = 1 OR coalesce(
          json_type(selection_json, '$.explanations') = 'array' AND
          json_array_length(selection_json, '$.explanations') =
            json_array_length(selection_json, '$.selectedAgentIds'), 0
        ))
      )
    ),
  UNIQUE (discussion_id, ordinal)
) STRICT;

INSERT INTO discussion_waves_v2 SELECT * FROM discussion_waves;
DROP TABLE discussion_waves;
ALTER TABLE discussion_waves_v2 RENAME TO discussion_waves;

CREATE INDEX discussion_waves_discussion_idx
  ON discussion_waves(discussion_id, ordinal);
CREATE INDEX discussion_waves_open_idx
  ON discussion_waves(state, deadline_at, discussion_id, ordinal)
  WHERE state = 'open';
CREATE UNIQUE INDEX discussion_waves_one_open_idx
  ON discussion_waves(discussion_id)
  WHERE state = 'open';

CREATE TRIGGER discussion_wave_selection_required_insert
BEFORE INSERT ON discussion_waves
WHEN NEW.selection_json IS NULL
BEGIN SELECT RAISE(ABORT, 'Discussion Wave selection is required'); END;

CREATE TRIGGER discussion_wave_selection_immutable_update
BEFORE UPDATE OF selection_json ON discussion_waves
WHEN NEW.selection_json IS NOT OLD.selection_json
BEGIN SELECT RAISE(ABORT, 'Discussion Wave selection is immutable'); END;
