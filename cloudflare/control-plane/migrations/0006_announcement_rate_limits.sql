-- `POST /v1/announcements/subscribe` is unauthenticated, because the caller is
-- somebody's first run and no account exists yet. It writes to the owner's
-- mailing list, so without a limit one script can fill that list with
-- addresses nobody typed. Two subjects share this table: the address being
-- subscribed, and the caller. Both are stored as HMACs, never as plaintext —
-- a spam ledger must stay useless to anyone who reads it.
CREATE TABLE announcement_rate_limits (
  subject_key TEXT PRIMARY KEY CHECK (length(subject_key) = 64),
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX announcement_rate_limits_updated_idx
  ON announcement_rate_limits(updated_at);
