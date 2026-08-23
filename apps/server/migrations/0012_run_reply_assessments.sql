ALTER TABLE run_events
  ADD COLUMN assessment_json TEXT
  CHECK (assessment_json IS NULL OR json_valid(assessment_json));
