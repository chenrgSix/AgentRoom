ALTER TABLE run_events
  ADD COLUMN session_json TEXT CHECK (
    session_json IS NULL OR (
      json_valid(session_json) AND json_type(session_json) = 'object'
    )
  );
