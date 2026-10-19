-- SPDX-License-Identifier: AGPL-3.0-or-later
-- TRUST-FIRST-FACTOR.md revision 2, part B (Astra TRUST-1 #6, TRUST-2 Q2/F1/F6): the 24-hour first-factor hold is waived only for an
-- account with NOTHING TO PROTECT, and at most once per account. The emailed-code request reserves this row (INSERT ... ON CONFLICT: a live
-- reservation is left alone, so a second concurrent first-factor request takes the normal held path); the code verify consumes it in the same batch that
-- spends the code and stages the factor, bound to that factor, that Supabase session and that operation. An unconsumed reservation past
-- expires_at (the code's TTL) may be reclaimed by a new request; a consumed row is history and is never deleted or reused.
-- src/trusted-factors.ts.
CREATE TABLE cloud_factor_bootstraps (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  factor_id TEXT NOT NULL,              -- the Supabase factor the reservation (and so the waiver) is bound to
  session_id TEXT NOT NULL,             -- the Supabase session_id that asked for the code; only it may consume
  op TEXT,                              -- the trust operation that consumed it (NULL while reserved)
  requested_at INTEGER NOT NULL,        -- ms
  consumed_at INTEGER,                  -- ms; NULL while reserved; set once, never cleared
  expires_at INTEGER NOT NULL           -- ms; = the code's expiry; past it an unconsumed reservation may be reclaimed
);
