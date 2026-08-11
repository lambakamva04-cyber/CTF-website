-- Turns a single hand-seeded organization into a platform: self-service signup
-- behind an approval gate, a CTF-level view for billing, recorded consent, and
-- request throttling.

-- Organization lifecycle.
--   pending   — signed up, cannot see call data, waiting for CTF to activate
--   active    — paying client, full access
--   suspended — access withdrawn (non-payment, abuse); data retained
-- Defaults to 'pending' so a row created by any future code path is closed
-- until someone decides otherwise.
ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'active', 'suspended'));
ALTER TABLE organizations ADD COLUMN activated_at INTEGER;
ALTER TABLE organizations ADD COLUMN activated_by TEXT;
ALTER TABLE organizations ADD COLUMN billing_email TEXT;
-- Free-text so a plan can be renamed without a migration.
ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE organizations ADD COLUMN signup_note TEXT;

CREATE INDEX idx_org_status ON organizations (status);

-- The CTF master account. Deliberately a property of a *user*, not an org: it
-- is a person at CTF who can see billing totals, not a client organization with
-- extra powers. 'none' for every client login.
ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'none'
  CHECK (platform_role IN ('none', 'ctf_admin'));

CREATE INDEX idx_users_platform_role ON users (platform_role)
  WHERE platform_role != 'none';

-- Consent, recorded per user per document version. Kept append-only: a new
-- acceptance is a new row, so the history of what someone agreed to and when
-- survives a policy rewrite. That history is the point — an acceptance record
-- that can be silently overwritten proves nothing.
CREATE TABLE terms_acceptances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL,
  document    TEXT NOT NULL CHECK (document IN ('terms', 'privacy')),
  version     TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);

CREATE INDEX idx_terms_user ON terms_acceptances (user_id, document, accepted_at DESC);

-- Fixed-window request counters. A window is identified by a bucket key
-- (subject + route class + window start), so a row is created once per window
-- and incremented thereafter; expired rows are pruned by the nightly cron.
CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  hits         INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_expiry ON rate_limits (expires_at);

-- Signup details are held with the OAuth state rather than passed through the
-- browser, so the organization name and consent cannot be tampered with between
-- starting a signup and returning from Google.
ALTER TABLE oauth_states ADD COLUMN signup_payload TEXT;

-- The organization that already exists was created before this gate and is a
-- live, working account; it would be wrong to lock it out.
UPDATE organizations SET status = 'active', activated_at = 1786100000000;
