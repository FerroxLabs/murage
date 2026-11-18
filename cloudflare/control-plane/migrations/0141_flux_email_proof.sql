-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 r3, sections 1, 2, 5): proof that a Cloud account holds the inbox of its contact address, asked
-- ONLY when Flux says an existing Flux account matches that address (ensure-account answers 202 pending_verification).
--
-- The ONE writer of a stamp is the challenge consume batch (src/flux-email-proof.ts verifyProof): the guess is spent, the exact challenge is
-- consumed (hash, address, revision, expiry, guesses), and only when that consume changed a row is supabase_identities stamped, and only when
-- the stamp changed a row is a wake queued. No JWT claim, no operator route and no other path writes email_verified_at.
-- The ONE clear is the address move in cloud-accounts.ts reconcileEmail (the same statement that moves contact_email). Existing rows and new
-- accounts start unstamped. No backfill.
ALTER TABLE supabase_identities ADD COLUMN email_verified_at INTEGER;
ALTER TABLE supabase_identities ADD COLUMN email_verified_for TEXT;

-- One live challenge per account: a resend replaces the row (new id, new hash), so an older code stops working.
CREATE TABLE flux_email_proof (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  sub TEXT NOT NULL,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,
  email_revision INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  guesses INTEGER NOT NULL DEFAULT 0 CHECK (guesses >= 0 AND guesses <= 5),
  sends INTEGER NOT NULL DEFAULT 1,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

-- The send quota (5 a day, 30 s apart, per account), reserved inside the INSERT like the step-up code's (step-up-email.ts sendCode).
CREATE TABLE flux_email_proof_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code_reserved', 'send_failed', 'code_refused', 'verified')),
  at INTEGER NOT NULL
);
CREATE INDEX flux_email_proof_events_by_account ON flux_email_proof_events (account_id, kind, at);

-- A queued wake-up: written only by the verify batch, on the unproven -> proven transition for that revision. Run inline after the verify
-- and by the cron sweep for any row left behind (at most 5 tries, then the account's hold alert is delivered again).
CREATE TABLE flux_email_wake (
  account_id TEXT NOT NULL,
  email_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  last_try_at INTEGER,
  PRIMARY KEY (account_id, email_revision)
);

-- Support's two acts (no stamp among them): a resend to the STORED address, and a dispute. An open dispute blocks every stamp and every wake
-- for the account until POST /v1/internal/flux/email-proof/dispute-clear.
CREATE TABLE flux_email_proof_disputes (
  account_id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  by TEXT NOT NULL,
  email_revision INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE flux_email_proof_audit (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  act TEXT NOT NULL CHECK (act IN ('resend', 'dispute', 'dispute_linked', 'dispute_clear')),
  operator TEXT NOT NULL,
  email_revision INTEGER,
  note TEXT,
  sent_at INTEGER,
  message_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX flux_email_proof_audit_by_account ON flux_email_proof_audit (account_id, at);
