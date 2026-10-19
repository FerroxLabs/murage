-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B5: WebAuthn second factor for Cloud accounts. A factor belongs to the Better Auth user.
-- Challenges are single use. A step-up row says "this session proved a factor recently".
CREATE TABLE account_factors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  counter INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX account_factors_user_idx ON account_factors (user_id);
CREATE TABLE account_factor_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE account_stepups (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verified_until INTEGER NOT NULL
);
