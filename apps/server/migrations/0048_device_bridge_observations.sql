CREATE TABLE device_bridge_observations (
  device_id TEXT PRIMARY KEY,
  connection_epoch INTEGER NOT NULL CHECK (connection_epoch > 0),
  bridge_version TEXT NOT NULL
    CHECK (
      length(bridge_version) BETWEEN 5 AND 80
      AND bridge_version = trim(bridge_version)
      AND substr(bridge_version, 1, 1) GLOB '[0-9]'
      AND bridge_version NOT GLOB '*[^0-9A-Za-z.-]*'
    ),
  observed_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
) STRICT;
