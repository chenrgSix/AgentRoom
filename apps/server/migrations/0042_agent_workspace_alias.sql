ALTER TABLE agents ADD COLUMN workspace_alias TEXT
CHECK (
  workspace_alias IS NULL OR (
    length(workspace_alias) BETWEEN 1 AND 80 AND
    workspace_alias = trim(workspace_alias) AND
    workspace_alias NOT IN ('.', '..') AND
    instr(workspace_alias, '/') = 0 AND
    instr(workspace_alias, char(92)) = 0
  )
);
