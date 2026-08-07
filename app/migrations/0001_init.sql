-- Cut Through Faster — control platform schema.
--
-- Tenancy model: every row that carries client data has an `org_id`. The Worker
-- derives org_id from the session and passes it into every query as a bound
-- parameter, so a caller can never read another client's calls.

PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE,
  timezone             TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
  -- JSON array of bookable service names, shown in the dashboard.
  services             TEXT NOT NULL DEFAULT '[]',
  -- Vapi linkage. A webhook is matched to an org by assistant id first, then
  -- by phone number id, so either one is enough to onboard a client.
  vapi_assistant_id    TEXT,
  vapi_phone_number_id TEXT,
  -- Fallback E.164 number rung when staff take over a call and have no
  -- personal number on their user record.
  takeover_number      TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_org_assistant
  ON organizations (vapi_assistant_id) WHERE vapi_assistant_id IS NOT NULL;
CREATE UNIQUE INDEX idx_org_phone_number
  ON organizations (vapi_phone_number_id) WHERE vapi_phone_number_id IS NOT NULL;

-- Email is stored pre-lowercased so the unique index is a true case-insensitive
-- constraint without needing an expression index.
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email                TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  phone                TEXT,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled             INTEGER NOT NULL DEFAULT 0,
  last_login_at        INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX idx_users_org ON users (org_id);

-- `id` holds the SHA-256 of the session token, never the token itself, so a
-- database leak cannot be replayed as a login.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE calls (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  vapi_call_id   TEXT NOT NULL UNIQUE,
  -- Live-control endpoint handed to us by Vapi on the call object. Present only
  -- while the call is up; this is what takeover and hang-up POST to.
  control_url    TEXT,
  listen_url     TEXT,
  status         TEXT NOT NULL DEFAULT 'ringing'
                   CHECK (status IN ('ringing', 'in-progress', 'transferring', 'ended')),
  caller_name    TEXT,
  caller_number  TEXT,
  started_at     INTEGER NOT NULL,
  answered_at    INTEGER,
  ended_at       INTEGER,
  duration_s     INTEGER,
  intent         TEXT,
  outcome        TEXT CHECK (outcome IN ('booked', 'inquiry', 'escalated', 'missed', 'resolved')),
  service        TEXT,
  booking_when   TEXT,
  summary        TEXT,
  recording_url  TEXT,
  ended_reason   TEXT,
  taken_over_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  taken_over_at  INTEGER,
  transfer_to    TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_calls_org_started ON calls (org_id, started_at DESC);
CREATE INDEX idx_calls_org_status ON calls (org_id, status);
CREATE INDEX idx_calls_org_outcome_started ON calls (org_id, outcome, started_at DESC);

-- One row per utterance. `seq` is a per-call counter the client uses as a
-- cursor, so live polling only ever fetches lines it has not seen.
CREATE TABLE transcript_lines (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id  TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  speaker  TEXT NOT NULL CHECK (speaker IN ('ai', 'caller', 'human', 'system')),
  text     TEXT NOT NULL,
  at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_transcript_call_seq ON transcript_lines (call_id, seq);

-- Vapi retries webhooks. Recording delivered ids makes ingestion idempotent so
-- a retry cannot duplicate transcript lines or double-count a call.
CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_events_received ON webhook_events (received_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     TEXT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_org_created ON audit_log (org_id, created_at DESC);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  successful INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_login_attempts_email ON login_attempts (email, created_at DESC);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, created_at DESC);
