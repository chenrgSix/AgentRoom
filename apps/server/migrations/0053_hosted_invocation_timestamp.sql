DROP TRIGGER hosted_invocation_intents_require_monotonic_state;

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
