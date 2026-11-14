-- OMG booking calendar, reviews and admin sessions.

-- One-off values the Worker creates for itself (the salt for hashing IPs).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- What visitors ask for. Pending until OMG confirms it on the admin page.
CREATE TABLE booking_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  phone      TEXT    NOT NULL CHECK (length(phone) BETWEEN 9 AND 25),
  service    TEXT    NOT NULL CHECK (length(service) <= 40),
  date       TEXT    NOT NULL CHECK (length(date) = 10),
  start      TEXT    NOT NULL CHECK (length(start) = 5),
  minutes    INTEGER NOT NULL CHECK (minutes BETWEEN 5 AND 1440),
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX booking_requests_status_date ON booking_requests (status, date, start);
CREATE INDEX booking_requests_dedupe ON booking_requests (phone, date, start);

-- Time that is taken: confirmed bookings and time off. The public calendar
-- sees only the start and end of these; never the label or the client.
CREATE TABLE blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL CHECK (length(date) = 10),
  start      TEXT    NOT NULL CHECK (length(start) = 5),
  end        TEXT    NOT NULL CHECK (length(end) = 5),
  kind       TEXT    NOT NULL CHECK (kind IN ('booking', 'closed')),
  label      TEXT    CHECK (label IS NULL OR length(label) <= 80),
  request_id INTEGER REFERENCES booking_requests (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX blocks_date ON blocks (date, start);

CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  comment     TEXT    NOT NULL CHECK (length(comment) BETWEEN 10 AND 500),
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at  INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE INDEX reviews_status_created ON reviews (status, created_at);

-- Admin sessions. Only a SHA-256 hash of each token is stored.
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Fixed-window request counters, keyed by a salted hash of the client IP.
CREATE TABLE rate_limits (
  key        TEXT    PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expires ON rate_limits (expires_at);
