CREATE TABLE web_owner_recovery_credentials (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
) STRICT;
