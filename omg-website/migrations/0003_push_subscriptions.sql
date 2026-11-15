-- Phone alerts for OMG: the browsers (on OMG's phone, tablet or computer)
-- that asked to be told about new booking requests and reviews. Each row is
-- the push address the browser gave us. No personal data is stored here, and
-- no alert ever carries any: it only wakes the admin page, which then asks the
-- server what is new with OMG's own sign-in.
CREATE TABLE push_subscriptions (
  endpoint   TEXT    PRIMARY KEY CHECK (length(endpoint) BETWEEN 20 AND 1024),
  created_at INTEGER NOT NULL
);
