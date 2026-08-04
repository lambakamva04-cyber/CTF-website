-- Google sign-in and the state it needs.
--
-- Sign-in with Google matches an existing user by email; it never creates one.
-- The dashboard exposes clients' live calls and caller phone numbers, so having
-- a Google account must not be a way in — only a way to authenticate as a login
-- that was deliberately provisioned.

-- Google's stable subject id, recorded on first successful Google sign-in. Kept
-- separate from email because a user can change their email address at Google
-- while `sub` stays fixed; matching on it afterwards avoids re-linking.
ALTER TABLE users ADD COLUMN google_sub TEXT;

CREATE UNIQUE INDEX idx_users_google_sub
  ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Records when a login last authenticated through Google, for the audit trail.
ALTER TABLE users ADD COLUMN google_linked_at INTEGER;

-- Single-use CSRF state and replay-preventing nonce for the OAuth round trip.
-- Rows are deleted the moment they are redeemed, so a replayed callback finds
-- nothing and is rejected.
CREATE TABLE oauth_states (
  state       TEXT PRIMARY KEY,
  nonce       TEXT NOT NULL,
  redirect_to TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX idx_oauth_states_expiry ON oauth_states (expires_at);
