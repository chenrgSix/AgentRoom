ALTER TABLE discussions
  ADD COLUMN execution_model TEXT NOT NULL DEFAULT 'sequential'
    CHECK (execution_model IN ('sequential', 'parallel_wave'));

ALTER TABLE discussions
  ADD COLUMN current_wave INTEGER NOT NULL DEFAULT 0
    CHECK (current_wave >= 0);

CREATE TABLE discussion_waves (
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
  UNIQUE (discussion_id, ordinal)
) STRICT;

CREATE INDEX discussion_waves_discussion_idx
  ON discussion_waves(discussion_id, ordinal);
CREATE INDEX discussion_waves_open_idx
  ON discussion_waves(state, deadline_at, discussion_id, ordinal)
  WHERE state = 'open';
CREATE UNIQUE INDEX discussion_waves_one_open_idx
  ON discussion_waves(discussion_id)
  WHERE state = 'open';

ALTER TABLE discussion_turns
  ADD COLUMN wave_id TEXT
    REFERENCES discussion_waves(wave_id) ON DELETE CASCADE;

ALTER TABLE discussion_turns
  ADD COLUMN wave_member_ordinal INTEGER
    CHECK (wave_member_ordinal IS NULL OR wave_member_ordinal >= 0);

ALTER TABLE discussion_turns
  ADD COLUMN terminal_reason TEXT
    CHECK (
      terminal_reason IS NULL OR
      length(trim(terminal_reason)) BETWEEN 1 AND 160
    );

INSERT INTO discussion_waves (
  wave_id, discussion_id, ordinal, phase, input_message_id, state,
  deadline_at, expected_members, version, created_at, updated_at, closed_at
)
SELECT
  'wave_legacy_' || substr(dt.turn_id, 6),
  dt.discussion_id,
  dt.ordinal,
  CASE WHEN dt.kind = 'finalization' THEN 'finalization' ELSE 'contribution' END,
  dt.input_message_id,
  CASE dt.state
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'canceled' THEN 'canceled'
    ELSE 'open'
  END,
  d.deadline_at,
  1,
  1,
  dt.created_at,
  dt.updated_at,
  CASE
    WHEN dt.state IN ('completed', 'failed', 'canceled')
      THEN coalesce(dt.completed_at, dt.updated_at)
    ELSE NULL
  END
FROM discussion_turns dt
JOIN discussions d ON d.discussion_id = dt.discussion_id;

UPDATE discussion_turns
SET wave_id = 'wave_legacy_' || substr(turn_id, 6),
    wave_member_ordinal = 0;

UPDATE discussions
SET execution_model = 'parallel_wave',
    current_wave = coalesce((
      SELECT max(ordinal)
      FROM discussion_waves
      WHERE discussion_id = discussions.discussion_id
    ), 0);

CREATE UNIQUE INDEX discussion_turns_wave_member_idx
  ON discussion_turns(wave_id, wave_member_ordinal)
  WHERE wave_id IS NOT NULL;
CREATE UNIQUE INDEX discussion_turns_wave_agent_idx
  ON discussion_turns(wave_id, speaker_agent_id)
  WHERE wave_id IS NOT NULL;
CREATE INDEX discussion_turns_wave_idx
  ON discussion_turns(wave_id, wave_member_ordinal);

ALTER TABLE runs
  ADD COLUMN orchestration_key TEXT
    CHECK (
      orchestration_key IS NULL OR
      length(trim(orchestration_key)) BETWEEN 1 AND 200
    );

CREATE UNIQUE INDEX runs_orchestration_key_idx
  ON runs(orchestration_key)
  WHERE orchestration_key IS NOT NULL;
