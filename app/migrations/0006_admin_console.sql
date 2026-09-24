-- The CTF admin console: oversight of every client, and the power to suspend,
-- disable and block. Builds on 0003_platform_and_consent (platform_role,
-- organizations.status) and 0005_two_factor (TOTP).
--
-- Every column added here has a default or is nullable, so code deployed
-- before this migration keeps working against the new schema.

-- CTF's own organization. The admin logins live in it, but it is the operator
-- of the platform, not a client: it is left out of every client list and total,
-- and the console refuses to suspend or block it. Set by hand, never by the app:
--   UPDATE organizations SET is_platform = 1 WHERE slug = '<ctf org slug>';
ALTER TABLE organizations ADD COLUMN is_platform INTEGER NOT NULL DEFAULT 0;

-- A block is permanent where a suspension is not. A blocked organization keeps
-- status = 'suspended', so every existing gate already keeps it out; blocked_at
-- is what stops the console from ever reactivating it. Undoing a block is a
-- deliberate database change, not a button.
ALTER TABLE organizations ADD COLUMN blocked_at INTEGER;
-- Why the last suspension or block happened, as entered by the admin.
ALTER TABLE organizations ADD COLUMN status_reason TEXT;

-- An enforcement action CTF took against a single login. users.disabled = 1 is
-- set alongside it, so every existing sign-in gate applies; this column is what
-- stops the client's own owner from simply re-enabling the login from their
-- Team panel. NULL means CTF has not intervened.
ALTER TABLE users ADD COLUMN platform_hold TEXT
  CHECK (platform_hold IS NULL OR platform_hold IN ('disabled', 'blocked'));
ALTER TABLE users ADD COLUMN platform_hold_at INTEGER;
ALTER TABLE users ADD COLUMN platform_hold_reason TEXT;

-- Addresses that may never sign up, or be added as a login, again. Written by
-- a block; removed only by hand.
CREATE TABLE blocked_emails (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  org_id     TEXT,
  blocked_by TEXT,
  blocked_at INTEGER NOT NULL
);

-- Re-verification for destructive console actions. An admin enters a fresh
-- authenticator code and the session may act for five minutes. A stolen admin
-- cookie on its own can look, but cannot suspend, disable or block anybody.
ALTER TABLE sessions ADD COLUMN stepped_up_until INTEGER;

-- What CTF staff are told about. Deliberately minimal: which organization, what
-- happened, when. The summary never names the new person, so the inbox carries
-- no more personal information than it has to.
CREATE TABLE platform_notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('login_added', 'org_signup')),
  org_id     TEXT REFERENCES organizations (id) ON DELETE CASCADE,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);

CREATE INDEX idx_platform_notifications_recent ON platform_notifications (created_at DESC);
