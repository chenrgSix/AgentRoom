CREATE TABLE agent_provision_requests (
  request_id TEXT PRIMARY KEY CHECK (request_id GLOB 'agentprov_*'),
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  template_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL UNIQUE CHECK (agent_id GLOB 'agent_*'),
  requested_by_member_id TEXT NOT NULL
    REFERENCES team_members(member_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (length(trim(role)) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'delivered', 'accepted', 'ready', 'rejected')
  ),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR rejection_reason IN (
      'provisioning_disabled', 'invalid_code', 'rate_limited', 'busy',
      'template_not_found', 'identity_conflict', 'invalid_request',
      'configuration_failed'
    )
  ),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  responded_at TEXT,
  ready_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'rejected' AND rejection_reason IS NOT NULL) OR
    (status <> 'rejected' AND rejection_reason IS NULL)
  )
) STRICT;

CREATE INDEX agent_provision_requests_owner_idx
  ON agent_provision_requests(team_id, requested_by_member_id, created_at);

CREATE INDEX agent_provision_requests_device_idx
  ON agent_provision_requests(device_id, status, created_at);
