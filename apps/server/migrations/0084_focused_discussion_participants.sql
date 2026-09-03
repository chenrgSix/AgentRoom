UPDATE discussions
SET policy_json = json_set(
  policy_json,
  '$.participantSelectionMode', 'all_eligible',
  '$.focusedParticipantLimit', 5
)
WHERE json_type(policy_json, '$.participantSelectionMode') IS NULL
   OR json_type(policy_json, '$.focusedParticipantLimit') IS NULL;

ALTER TABLE discussion_waves
  ADD COLUMN selection_json TEXT
    CHECK (
      selection_json IS NULL OR (
        json_valid(selection_json) AND
        json_type(selection_json) = 'object' AND
        json_extract(selection_json, '$.version') = 1 AND
        json_extract(selection_json, '$.strategy') IN (
          'all_eligible', 'question_focused', 'finalizer'
        ) AND
        json_type(selection_json, '$.focusQuestionIds') = 'array' AND
        json_type(selection_json, '$.eligibleAgentIds') = 'array' AND
        json_type(selection_json, '$.selectedAgentIds') = 'array' AND
        json_array_length(selection_json, '$.selectedAgentIds') BETWEEN 1 AND 5 AND
        json_type(selection_json, '$.requiredRoles') = 'array' AND
        json_extract(selection_json, '$.focusedParticipantLimit') BETWEEN 2 AND 5 AND
        length(json_extract(selection_json, '$.selectionDigest')) = 64
      )
    );

CREATE TRIGGER discussion_wave_selection_required_insert
BEFORE INSERT ON discussion_waves
WHEN NEW.selection_json IS NULL
BEGIN SELECT RAISE(ABORT, 'Discussion Wave selection is required'); END;

CREATE TRIGGER discussion_wave_selection_immutable_update
BEFORE UPDATE OF selection_json ON discussion_waves
WHEN NEW.selection_json IS NOT OLD.selection_json
BEGIN SELECT RAISE(ABORT, 'Discussion Wave selection is immutable'); END;
