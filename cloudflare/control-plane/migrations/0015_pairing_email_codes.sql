-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One live email code per (account, home) for first-device pairing. Only an HMAC
-- of the code is stored, never the code. No foreign key: a hard home deletion
-- must not be blocked by, or leave behind, a pairing code.
CREATE TABLE pairing_email_codes (
  account_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, home_id)
);
CREATE INDEX pairing_email_codes_expires_idx ON pairing_email_codes(expires_at);
