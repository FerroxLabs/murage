-- Murage Cloud accounts live in the murage.ai members area (MakerKit on Supabase Auth). A Supabase user (the
-- token's `sub`) maps to exactly one control-plane account ("user".id): the one it created on first use. There is no
-- automatic linking to an existing account by email (a provider's "verified email" is not proof of owning that
-- account; Astra MAKERKIT1 #1). Contract: lanes/cloud-v2/makerkit/CONTRACT.md.
CREATE TABLE supabase_identities (
  sub TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES "user" ("id") ON DELETE CASCADE,
  via TEXT NOT NULL CHECK (via = 'created'),
  created_at INTEGER NOT NULL,
  -- Set while Supabase's current confirmed email for this user is held by another control-plane account: the address
  -- that could not be taken. Every request for this sub answers 409 account_email_conflict until it clears (Sean frees
  -- the address, or the member changes it again). The stored "user".email of a mapped account is a contact address
  -- only, never a login: Better Auth refuses to start a session for it (auth.ts). Astra MAKERKIT2 #1, #2.
  email_conflict TEXT
);

-- Every create, refusal and email change, for Sean and for audit. No token, no secret.
CREATE TABLE account_link_events (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'refused_email_taken', 'email_updated', 'email_conflict', 'email_conflict_cleared')),
  at INTEGER NOT NULL
);
CREATE INDEX account_link_events_sub_idx ON account_link_events (sub, at);
