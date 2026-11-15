-- Reviews are rated out of 5 stars (they were out of 4). SQLite cannot change
-- a CHECK constraint in place, so the table is rebuilt and every review is
-- copied across unchanged, with its name, rating, comment and dates.
CREATE TABLE reviews_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT    NOT NULL CHECK (length(comment) BETWEEN 10 AND 500),
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at  INTEGER NOT NULL,
  approved_at INTEGER
);
INSERT INTO reviews_new (id, name, rating, comment, status, created_at, approved_at)
  SELECT id, name, rating, comment, status, created_at, approved_at FROM reviews;
DROP TABLE reviews;
ALTER TABLE reviews_new RENAME TO reviews;
CREATE INDEX reviews_status_created ON reviews (status, created_at);
