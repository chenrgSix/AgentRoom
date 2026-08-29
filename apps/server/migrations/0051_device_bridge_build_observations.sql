CREATE TABLE device_bridge_observations_v2 (
  device_id TEXT PRIMARY KEY,
  connection_epoch INTEGER NOT NULL CHECK (connection_epoch > 0),
  bridge_version TEXT NOT NULL
    CHECK (
      length(bridge_version) BETWEEN 5 AND 80
      AND bridge_version = trim(bridge_version)
      AND substr(bridge_version, 1, 1) GLOB '[0-9]'
      AND bridge_version NOT GLOB '*[^0-9A-Za-z.-]*'
    ),
  source_commit TEXT,
  executable_sha256 TEXT,
  observed_at TEXT NOT NULL,
  CHECK (
    (source_commit IS NULL AND executable_sha256 IS NULL)
    OR (
      length(source_commit) = 40
      AND source_commit NOT GLOB '*[^0-9a-f]*'
      AND length(executable_sha256) = 64
      AND executable_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
) STRICT;

INSERT INTO device_bridge_observations_v2 (
  device_id,
  connection_epoch,
  bridge_version,
  source_commit,
  executable_sha256,
  observed_at
)
SELECT
  device_id,
  connection_epoch,
  bridge_version,
  NULL,
  NULL,
  observed_at
FROM device_bridge_observations;

DROP TABLE device_bridge_observations;
ALTER TABLE device_bridge_observations_v2 RENAME TO device_bridge_observations;
