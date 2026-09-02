CREATE TABLE remote_provider_bindings (
  provider_binding_id TEXT PRIMARY KEY CHECK (provider_binding_id GLOB 'provider_*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  request_digest TEXT NOT NULL UNIQUE CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL CHECK (repository_id GLOB 'repo_*'),
  provider_origin TEXT NOT NULL CHECK (length(provider_origin) BETWEEN 1 AND 512),
  provider_repository_id TEXT NOT NULL CHECK (
    length(provider_repository_id) BETWEEN 1 AND 256
  ),
  ci_checks_json TEXT NOT NULL CHECK (
    json_valid(ci_checks_json) AND json_type(ci_checks_json) = 'array' AND
    json_array_length(ci_checks_json) BETWEEN 1 AND 16
  ),
  created_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  binding_digest TEXT NOT NULL UNIQUE CHECK (
    length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'
  ),
  binding_json TEXT NOT NULL CHECK (
    json_valid(binding_json) AND json_type(binding_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, repository_id, provider_origin, provider_repository_id),
  CHECK (json_extract(binding_json, '$.version') = schema_version),
  CHECK (json_extract(binding_json, '$.providerBindingId') = provider_binding_id),
  CHECK (json_extract(binding_json, '$.teamId') = team_id),
  CHECK (json_extract(binding_json, '$.repositoryId') = repository_id),
  CHECK (json_extract(binding_json, '$.providerOrigin') = provider_origin),
  CHECK (json_extract(binding_json, '$.providerRepositoryId') = provider_repository_id),
  CHECK (json_extract(binding_json, '$.createdByMemberId') = created_by_member_id),
  CHECK (json_extract(binding_json, '$.bindingDigest') = binding_digest),
  CHECK (json_extract(binding_json, '$.createdAt') = created_at),
  CHECK (json(json_extract(binding_json, '$.ciChecks')) = json(ci_checks_json))
) STRICT;

CREATE TRIGGER remote_provider_bindings_require_owner_insert
BEFORE INSERT ON remote_provider_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM team_members member
  JOIN teams team ON team.team_id = member.team_id
  WHERE member.member_id = NEW.created_by_member_id
    AND member.team_id = NEW.team_id
    AND member.role = 'owner'
    AND team.archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'Remote provider binding owner scope is invalid'); END;

CREATE TRIGGER remote_provider_bindings_immutable_update
BEFORE UPDATE ON remote_provider_bindings
BEGIN SELECT RAISE(ABORT, 'Remote provider binding is immutable'); END;

CREATE TRIGGER remote_provider_bindings_immutable_delete
BEFORE DELETE ON remote_provider_bindings
BEGIN SELECT RAISE(ABORT, 'Remote provider binding is retained'); END;

CREATE TABLE remote_provider_binding_revocations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id GLOB 'op_*'),
  provider_binding_id TEXT NOT NULL UNIQUE REFERENCES remote_provider_bindings(
    provider_binding_id
  ) ON DELETE RESTRICT,
  expected_binding_digest TEXT NOT NULL CHECK (
    length(expected_binding_digest) = 64 AND
    expected_binding_digest NOT GLOB '*[^0-9a-f]*'
  ),
  revoked_by_member_id TEXT NOT NULL REFERENCES team_members(member_id)
    ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  revocation_digest TEXT NOT NULL UNIQUE CHECK (
    length(revocation_digest) = 64 AND revocation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  revocation_json TEXT NOT NULL CHECK (
    json_valid(revocation_json) AND json_type(revocation_json) = 'object'
  ),
  revoked_at TEXT NOT NULL,
  CHECK (json_extract(revocation_json, '$.version') = 1),
  CHECK (json_extract(revocation_json, '$.operationId') = operation_id),
  CHECK (json_extract(revocation_json, '$.providerBindingId') = provider_binding_id),
  CHECK (json_extract(revocation_json, '$.expectedBindingDigest') = expected_binding_digest),
  CHECK (json_extract(revocation_json, '$.revokedByMemberId') = revoked_by_member_id),
  CHECK (json_extract(revocation_json, '$.reason') = reason),
  CHECK (json_extract(revocation_json, '$.revocationDigest') = revocation_digest),
  CHECK (json_extract(revocation_json, '$.revokedAt') = revoked_at)
) STRICT;

CREATE TRIGGER remote_provider_revocations_require_owner_insert
BEFORE INSERT ON remote_provider_binding_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM remote_provider_bindings binding
  JOIN team_members member ON member.member_id = NEW.revoked_by_member_id
  WHERE binding.provider_binding_id = NEW.provider_binding_id
    AND binding.binding_digest = NEW.expected_binding_digest
    AND member.team_id = binding.team_id
    AND member.role = 'owner'
)
BEGIN SELECT RAISE(ABORT, 'Remote provider revocation owner scope is invalid'); END;

CREATE TRIGGER remote_provider_revocations_immutable_update
BEFORE UPDATE ON remote_provider_binding_revocations
BEGIN SELECT RAISE(ABORT, 'Remote provider revocation is immutable'); END;

CREATE TRIGGER remote_provider_revocations_immutable_delete
BEFORE DELETE ON remote_provider_binding_revocations
BEGIN SELECT RAISE(ABORT, 'Remote provider revocation is retained'); END;
