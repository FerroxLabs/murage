-- Astra SUPPORT5 P1 #2: a stolen aal2 session can enrol its own TOTP factor in Supabase directly, so "aal2 and a fresh
-- amr" cannot tell the member's authenticator from the attacker's. The control plane keeps the list of TRUSTED factors
-- per Cloud account; fresh step-up counts only when the factor that verified the session (the hook's server-set
-- `mfa_factor_id` claim, from auth.sessions.factor_id) is on this list and out of its hold. src/trusted-factors.ts,
-- CONTRACT.md section 3a.
CREATE TABLE cloud_trusted_factors (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  factor_id TEXT NOT NULL,              -- the Supabase auth.mfa_factors id (lower-case UUID)
  factor_type TEXT NOT NULL CHECK (factor_type IN ('totp', 'webauthn')),
  via TEXT NOT NULL CHECK (via IN ('email_code', 'trusted_factor')),
  trusted_at INTEGER NOT NULL,          -- ms
  usable_at INTEGER NOT NULL,           -- ms; trusted_at + 24 h for 'email_code', trusted_at for 'trusted_factor'
  PRIMARY KEY (user_id, factor_id)
);

-- One live ownership code per account, emailed to the account's current Supabase address. HMAC only; single use;
-- 10 minutes; 5 attempts.
CREATE TABLE cloud_factor_trust_codes (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  factor_id TEXT NOT NULL,
  email TEXT NOT NULL,                  -- the address the code was sent to; must still be Supabase's address at redemption
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every trust change, for the member's notices, support and rate limits. No code or secret is stored.
CREATE TABLE cloud_factor_trust_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  factor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code_sent', 'code_refused', 'trusted_email_code', 'trusted_by_factor')),
  at INTEGER NOT NULL
);
CREATE INDEX cloud_factor_trust_events_user_at ON cloud_factor_trust_events (user_id, at);
