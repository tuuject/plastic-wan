-- Rebuild the parent and its only child together: foreign_keys stays enabled,
-- and existing sessions survive this schema-only migration.
CREATE TEMP TABLE saved_admin_sessions AS SELECT * FROM admin_sessions;
DROP TABLE admin_sessions;
CREATE TABLE admin_users_new (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  webauthn_user_id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
) STRICT;
INSERT INTO admin_users_new (id, username, password_hash, created_at, updated_at, last_login_at)
SELECT id, username, password_hash, created_at, updated_at, last_login_at FROM admin_users;
DROP TABLE admin_users;
ALTER TABLE admin_users_new RENAME TO admin_users;
CREATE TABLE admin_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
INSERT INTO admin_sessions SELECT * FROM saved_admin_sessions;
DROP TABLE saved_admin_sessions;
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);
CREATE TABLE admin_passkeys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  rp_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;
CREATE INDEX admin_passkeys_user_idx ON admin_passkeys(user_id);
