-- POST /v1/announcements/unsubscribe (site forwarder only): one row per address and Sendlane list that opted out. The address is never
-- stored: email_key is the same HMAC the per-address rate limit uses. A later subscribe for the SAME list that carries no fresh consent
-- text finds the row and is not sent to Sendlane, so an opt-out is not silently undone. A forwarded subscribe with consentText for that
-- list deletes its row, and only after Sendlane accepted the add; a consent for the waitlist list leaves the announcement list's row.
-- Kept apart from announcement_consents on purpose: that table is pruned at 3 years and its source column is a closed list.
CREATE TABLE announcement_optouts (
  email_key TEXT NOT NULL CHECK (length(email_key) = 64),
  list_id TEXT NOT NULL,
  unsubscribed_at INTEGER NOT NULL,
  -- A fresh random token each time an unsubscribe writes the row. A subscribe's consent clears only the row token it read, so an
  -- unsubscribe in the same millisecond (same unsubscribed_at) is never deleted by mistake.
  row_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  -- 1 while a compensating unsubscribe failed and the address may still be on the Sendlane list. A later subscribe without consent
  -- retries the unsubscribe before answering; the flag clears when Sendlane confirms. Rows with 0 keep the cheap short-circuit.
  comp_pending INTEGER NOT NULL DEFAULT 0 CHECK (comp_pending IN (0, 1)),
  -- The token of the call that last armed comp_pending. Every arm writes a fresh random value; every clear matches (row_id, comp_nonce)
  -- with the value that clearing call armed or read before its own Sendlane call, so a call can never clear an arm that came after it.
  comp_nonce TEXT,
  PRIMARY KEY (email_key, list_id)
);
