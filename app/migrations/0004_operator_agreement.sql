-- Adds the operator agreement as a third acceptable document.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- Nothing references terms_acceptances, which makes this safe: it is a leaf.
-- The rows are copied rather than discarded because an acceptance record whose
-- history is lost proves nothing about what anyone agreed to.

CREATE TABLE terms_acceptances_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL,
  document    TEXT NOT NULL CHECK (document IN ('terms', 'privacy', 'operator')),
  version     TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);

INSERT INTO terms_acceptances_new (id, user_id, org_id, document, version, accepted_at, ip, user_agent)
SELECT id, user_id, org_id, document, version, accepted_at, ip, user_agent FROM terms_acceptances;

DROP TABLE terms_acceptances;

ALTER TABLE terms_acceptances_new RENAME TO terms_acceptances;

CREATE INDEX idx_terms_user ON terms_acceptances (user_id, document, accepted_at DESC);
