-- Astra MAKERKIT4 #3: one monotonic revision covers a mapped account's contact email AND its conflict state. Every email
-- move, conflict set and conflict clear is conditioned on the revision read and increments it, so a delayed request can
-- neither restore an obsolete address (changed away and back) nor erase a newer conflict. src/cloud-accounts.ts.
ALTER TABLE supabase_identities ADD COLUMN email_revision INTEGER NOT NULL DEFAULT 0;

-- Astra MAKERKIT4 #2: a Supabase-identity customer pairs the desktop app with a one-time code made in the members area
-- (signed in, fresh aal2), never with a Better Auth login. Stored as an HMAC only; single use; short-lived; bound to one
-- account and one home. src/pairing.ts, CONTRACT.md section 8.
CREATE TABLE desktop_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  home_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX desktop_pairing_codes_owner_idx ON desktop_pairing_codes (account_id, home_id);
