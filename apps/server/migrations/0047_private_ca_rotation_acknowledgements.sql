CREATE TABLE device_private_ca_rotation_acknowledgements (
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL CHECK (installation_id GLOB 'install_*'),
  expected_current_trust_epoch INTEGER NOT NULL
    CHECK (expected_current_trust_epoch BETWEEN 1 AND 2147483647),
  accepted_next_trust_epoch INTEGER NOT NULL
    CHECK (accepted_next_trust_epoch BETWEEN 2 AND 2147483647),
  ca_certificate_sha256 TEXT NOT NULL
    CHECK (length(ca_certificate_sha256) = 64),
  operation_id TEXT NOT NULL UNIQUE CHECK (operation_id GLOB 'op_*'),
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (device_id, installation_id, accepted_next_trust_epoch),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
  CHECK (accepted_next_trust_epoch = expected_current_trust_epoch + 1)
) STRICT;

