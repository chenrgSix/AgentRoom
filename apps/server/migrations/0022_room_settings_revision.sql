ALTER TABLE rooms ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1
  CHECK (settings_revision > 0);
