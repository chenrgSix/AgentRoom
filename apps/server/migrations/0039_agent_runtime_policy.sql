ALTER TABLE agents ADD COLUMN runtime_policy_json TEXT CHECK (
  runtime_policy_json IS NULL OR (
    json_valid(runtime_policy_json) AND
    json_type(runtime_policy_json) = 'object' AND
    json_type(runtime_policy_json, '$.filesystemAccess') = 'text' AND
    json_extract(runtime_policy_json, '$.filesystemAccess') IN (
      'read-only', 'workspace-write', 'local-policy'
    )
  )
);
