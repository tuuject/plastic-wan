-- Programmatic Admin API keys (CLI / evaluation tooling). Only the SHA-256
-- digest of a key is stored; the plaintext exists exactly once, in the create
-- response, and is never recoverable afterwards. Revocation sets revoked_at,
-- which permanently disables the key without deleting its audit metadata.
CREATE TABLE admin_api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;
