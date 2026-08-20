-- Two-factor authentication: TOTP, email one-time codes, and backup codes.

-- Which second factor this account uses. 'none' for everyone until they enrol,
-- so the migration cannot lock anybody out of an account they already have.
ALTER TABLE users ADD COLUMN two_factor_method TEXT NOT NULL DEFAULT 'none'
  CHECK (two_factor_method IN ('none', 'totp', 'email'));

-- The TOTP seed, AES-GCM encrypted with a key held in the Worker's secrets
-- rather than in this database. A seed in the clear is not like a password
-- hash: whoever reads it can mint valid codes indefinitely and invisibly.
ALTER TABLE users ADD COLUMN totp_secret TEXT;

-- Enrolment is two steps — issue a secret, then prove an app can compute a code
-- from it. Until this is set the secret exists but the factor is not live, so a
-- half-finished enrolment cannot lock anyone out.
ALTER TABLE users ADD COLUMN totp_confirmed_at INTEGER;

-- The step of the last code accepted. Anything at or below it is refused, which
-- is what stops a captured code being replayed inside its own window.
ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;

CREATE INDEX idx_users_two_factor ON users (two_factor_method)
  WHERE two_factor_method != 'none';

-- Single-use recovery codes, stored as hashes for the same reason session
-- tokens are: a leaked table should not be a set of working credentials.
--
-- These matter more here than on most platforms. There is no self-service
-- password reset and sign-in is Google-based, so an owner who loses their phone
-- with no backup code has no way back in without someone editing the database.
CREATE TABLE backup_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_ip    TEXT
);

CREATE INDEX idx_backup_codes_user ON backup_codes (user_id) WHERE used_at IS NULL;

-- A login that has passed the first factor and is waiting on the second.
--
-- Kept server-side and keyed by an opaque token rather than issuing a
-- "half-authenticated" session cookie: a row here grants nothing at all, so
-- there is no partially-privileged state for a bug to widen. It also survives
-- the browser being closed mid-login, which a memory-held challenge would not.
CREATE TABLE login_challenges (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  method        TEXT NOT NULL CHECK (method IN ('totp', 'email')),
  -- Only set for the email factor: the hash of the six digits that were sent.
  code_hash     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX idx_login_challenges_expiry ON login_challenges (expires_at);
CREATE INDEX idx_login_challenges_user ON login_challenges (user_id);
