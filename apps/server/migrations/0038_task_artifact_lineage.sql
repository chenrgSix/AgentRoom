CREATE UNIQUE INDEX task_artifact_refs_identity_scope_idx
  ON task_artifact_refs(artifact_id, task_id, room_id);

CREATE TABLE task_artifact_relations (
  relation_id TEXT PRIMARY KEY CHECK (relation_id GLOB 'relation_*'),
  source_artifact_id TEXT NOT NULL,
  target_artifact_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'derives_from', 'reviews', 'verifies'
  )),
  created_by_member_id TEXT REFERENCES team_members(member_id) ON DELETE RESTRICT,
  created_by_agent_id TEXT REFERENCES agents(agent_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (source_artifact_id <> target_artifact_id),
  CHECK (
    (created_by_member_id IS NOT NULL) != (created_by_agent_id IS NOT NULL)
  ),
  UNIQUE (source_artifact_id, target_artifact_id, relation_type),
  FOREIGN KEY (source_artifact_id, task_id, room_id)
    REFERENCES task_artifact_refs(artifact_id, task_id, room_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (target_artifact_id, task_id, room_id)
    REFERENCES task_artifact_refs(artifact_id, task_id, room_id)
      ON DELETE RESTRICT
) STRICT;

CREATE INDEX task_artifact_relations_source_idx
  ON task_artifact_relations(source_artifact_id, relation_id);

CREATE INDEX task_artifact_relations_target_idx
  ON task_artifact_relations(target_artifact_id, relation_id);

CREATE TRIGGER task_artifact_relations_require_history_insert
BEFORE INSERT ON task_artifact_relations
WHEN NOT EXISTS (
  SELECT 1
  FROM task_artifact_refs source
  JOIN task_artifact_refs target
    ON target.artifact_id = NEW.target_artifact_id
  WHERE source.artifact_id = NEW.source_artifact_id
    AND source.task_id = NEW.task_id
    AND source.room_id = NEW.room_id
    AND target.task_id = NEW.task_id
    AND target.room_id = NEW.room_id
    AND target.artifact_revision < source.artifact_revision
    AND NEW.created_by_member_id IS source.created_by_member_id
    AND NEW.created_by_agent_id IS source.created_by_agent_id
    AND NEW.created_at = source.created_at
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Artifact relation must target older evidence in the same Task history'
  );
END;

CREATE TRIGGER task_artifact_relations_bound_insert
BEFORE INSERT ON task_artifact_relations
WHEN (
  SELECT count(*) FROM task_artifact_relations
  WHERE source_artifact_id = NEW.source_artifact_id
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'Artifact relation limit exceeded');
END;

CREATE TRIGGER task_artifact_relations_immutable_update
BEFORE UPDATE ON task_artifact_relations
BEGIN
  SELECT RAISE(ABORT, 'Artifact relations are immutable');
END;

CREATE TRIGGER task_artifact_relations_immutable_delete
BEFORE DELETE ON task_artifact_relations
BEGIN
  SELECT RAISE(ABORT, 'Artifact relations are immutable');
END;

ALTER TABLE artifact_publications
  ADD COLUMN relations_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(relations_json) AND
    json_type(relations_json) = 'array' AND
    json_array_length(relations_json) <= 20
  );

CREATE TRIGGER artifact_publications_restrict_lineage_update
BEFORE UPDATE ON artifact_publications
WHEN NEW.relations_json <> OLD.relations_json
BEGIN
  SELECT RAISE(ABORT, 'Artifact publication lineage is immutable');
END;

CREATE TRIGGER artifact_publications_require_bound_lineage_update
BEFORE UPDATE ON artifact_publications
WHEN NEW.state = 'bound' AND (
  json_array_length(NEW.relations_json) <> (
    SELECT count(*) FROM task_artifact_relations relation
    WHERE relation.source_artifact_id = NEW.artifact_id
  ) OR
  EXISTS (
    SELECT 1 FROM json_each(NEW.relations_json) requested
    WHERE NOT EXISTS (
      SELECT 1 FROM task_artifact_relations relation
      WHERE relation.source_artifact_id = NEW.artifact_id
        AND relation.target_artifact_id =
          json_extract(requested.value, '$.targetArtifactId')
        AND relation.relation_type = json_extract(requested.value, '$.type')
    )
  ) OR
  EXISTS (
    SELECT 1 FROM task_artifact_relations relation
    WHERE relation.source_artifact_id = NEW.artifact_id
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.relations_json) requested
        WHERE relation.target_artifact_id =
          json_extract(requested.value, '$.targetArtifactId')
          AND relation.relation_type = json_extract(requested.value, '$.type')
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Bound Artifact lineage does not match its publication');
END;
