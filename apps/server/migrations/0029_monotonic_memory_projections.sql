CREATE TRIGGER room_memory_projections_monotonic_source_update
BEFORE UPDATE OF source_sequence ON room_memory_projections
WHEN NEW.source_sequence < OLD.source_sequence
BEGIN
  SELECT RAISE(ABORT, 'Room memory projection source cursor cannot regress');
END;

CREATE TRIGGER agent_tasks_monotonic_summary_source_update
BEFORE UPDATE OF summary_source_sequence ON agent_tasks
WHEN NEW.summary_source_sequence < OLD.summary_source_sequence
BEGIN
  SELECT RAISE(ABORT, 'Task memory projection source cursor cannot regress');
END;
