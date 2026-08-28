ALTER TABLE device_pairing_sessions ADD COLUMN trust_mode TEXT
  CHECK (trust_mode IS NULL OR trust_mode = 'private_scoped_ca');

ALTER TABLE device_pairing_sessions ADD COLUMN trust_origin TEXT
  CHECK (
    trust_origin IS NULL OR
    (length(trust_origin) BETWEEN 9 AND 2048 AND trust_origin GLOB 'https://*')
  );

ALTER TABLE device_pairing_sessions ADD COLUMN trust_installation_id TEXT
  CHECK (
    trust_installation_id IS NULL OR
    trust_installation_id GLOB 'install_*'
  );

ALTER TABLE device_pairing_sessions ADD COLUMN trust_epoch INTEGER
  CHECK (trust_epoch IS NULL OR trust_epoch BETWEEN 1 AND 2147483647);

ALTER TABLE device_pairing_sessions ADD COLUMN trust_ca_sha256 TEXT
  CHECK (trust_ca_sha256 IS NULL OR length(trust_ca_sha256) = 64);

ALTER TABLE device_pairing_sessions ADD COLUMN
  device_supports_scoped_private_trust INTEGER
  CHECK (
    device_supports_scoped_private_trust IS NULL OR
    device_supports_scoped_private_trust IN (0, 1)
  );

CREATE TRIGGER device_pairing_trust_insert_guard
BEFORE INSERT ON device_pairing_sessions
WHEN NOT (
  (NEW.trust_mode IS NULL AND NEW.trust_origin IS NULL AND
    NEW.trust_installation_id IS NULL AND NEW.trust_epoch IS NULL AND
    NEW.trust_ca_sha256 IS NULL) OR
  (NEW.trust_mode = 'private_scoped_ca' AND NEW.trust_origin IS NOT NULL AND
    NEW.trust_installation_id IS NOT NULL AND NEW.trust_epoch IS NOT NULL AND
    NEW.trust_ca_sha256 IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'incomplete device pairing trust descriptor');
END;

CREATE TRIGGER device_pairing_trust_update_guard
BEFORE UPDATE OF trust_mode, trust_origin, trust_installation_id, trust_epoch,
  trust_ca_sha256 ON device_pairing_sessions
WHEN NOT (
  (NEW.trust_mode IS NULL AND NEW.trust_origin IS NULL AND
    NEW.trust_installation_id IS NULL AND NEW.trust_epoch IS NULL AND
    NEW.trust_ca_sha256 IS NULL) OR
  (NEW.trust_mode = 'private_scoped_ca' AND NEW.trust_origin IS NOT NULL AND
    NEW.trust_installation_id IS NOT NULL AND NEW.trust_epoch IS NOT NULL AND
    NEW.trust_ca_sha256 IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'incomplete device pairing trust descriptor');
END;
