DROP TRIGGER hosted_credential_keyrings_retire_once;

-- A local installation may adopt trusted recovery authority without changing
-- the data key version referenced by its immutable credential envelopes.
-- Only that one-way root upgrade and the existing one-time retirement are
-- mutable; trusted keyrings cannot be downgraded or arbitrarily rewrapped.
CREATE TRIGGER hosted_credential_keyrings_retire_once
BEFORE UPDATE ON hosted_credential_keyrings
WHEN
  NEW.key_version IS NOT OLD.key_version OR
  NEW.active_slot IS NOT OLD.active_slot OR
  NEW.key_derivation IS NOT OLD.key_derivation OR
  NEW.wrapping_cipher IS NOT OLD.wrapping_cipher OR
  NEW.created_at IS NOT OLD.created_at OR
  NOT (
    (
      NEW.root_mode IS OLD.root_mode AND
      NEW.kdf_salt IS OLD.kdf_salt AND
      NEW.local_root_key IS OLD.local_root_key AND
      NEW.wrapped_data_key_ciphertext IS OLD.wrapped_data_key_ciphertext AND
      NEW.wrapped_data_key_nonce IS OLD.wrapped_data_key_nonce AND
      NEW.wrapped_data_key_auth_tag IS OLD.wrapped_data_key_auth_tag AND
      OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
    ) OR (
      OLD.root_mode = 'local_database' AND
      NEW.root_mode = 'trusted_recovery' AND
      OLD.local_root_key IS NOT NULL AND NEW.local_root_key IS NULL AND
      NEW.retired_at IS OLD.retired_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Hosted credential keyring update is invalid');
END;
