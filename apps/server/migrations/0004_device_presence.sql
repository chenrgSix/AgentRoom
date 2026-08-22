CREATE TABLE device_presence (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  connection_epoch INTEGER NOT NULL CHECK (connection_epoch > 0),
  adapter_available INTEGER NOT NULL CHECK (adapter_available IN (0, 1)),
  last_heartbeat_at TEXT NOT NULL
) STRICT;
