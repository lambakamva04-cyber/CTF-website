-- The area OMG works in ("Soweto, Johannesburg"): the page title, the H1 and
-- the description name it. SQLite cannot change a CHECK, so the table is rebuilt.
CREATE TABLE site_text_new (
  key   TEXT PRIMARY KEY CHECK (key IN ('phone', 'instagram', 'facebook_url', 'facebook_name', 'tagline', 'home_calls', 'bridal_note', 'area')),
  value TEXT NOT NULL CHECK (length(value) <= 400)
);
INSERT INTO site_text_new (key, value) SELECT key, value FROM site_text;
DROP TABLE site_text;
ALTER TABLE site_text_new RENAME TO site_text;
