-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Step-up by a fresh emailed 6-digit code (src/step-up-email.ts; Astra STEPUP-EMAIL-1 contract). Additive: new tables, one nullable
-- column on desktop_pairing_codes and two on checkout_resume_attempts (below); no existing column or row changes.
-- 0091-0098 are reserved by sibling branches.
-- This file SUPERSEDES the earlier drafts of 0099 on this branch (one kept a response_body column). No draft was ever applied to any
-- environment (staging D1 stops below 0099), so this is the only 0099 any database will run: the final schema, no forward migration.

-- One frozen protected operation. Created by the step-up refusal (403 step_up_required), approved by a verified code, claimed once by the
-- retried request that matches it exactly (the claim is the operation's durable record), then holding a MINIMAL replay record of its outcome.
-- intent_id is a reference, never a credential: every use re-checks the user, the Supabase session, the request fingerprint, the frozen
-- target and its versions (in the claiming statement itself) and, once approved, the confirmed address.
-- No response body is ever stored (Astra STEPUP-EMAIL-2 #1): a secret-bearing operation (export key, Flux key, pairing code, payment or
-- portal session links, log lines) keeps no body at all; any other keeps its status, error code and operation reference only.
CREATE TABLE cloud_stepup_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  -- SHA-256 of the canonical (method, path, query, body) with stepUpIntentId removed.
  params_hash TEXT NOT NULL,
  -- SHA-256 of the same request with its checkout consent's disclosureToken removed (NULL when it carries none). Only to tell a resend that
  -- differs in that token alone (a refreshed token after confirmation): it answers 403 stepup_request_changed and keeps the approval, at
  -- most token_mismatches times (Astra STEPUP-EMAIL-9 #1). It authorizes nothing: only params_hash is ever claimed.
  token_free_hash TEXT,
  token_mismatches INTEGER NOT NULL DEFAULT 0,
  -- The route's resolved target and its material versions, frozen when the intent is created (step-up-email.ts targetSpec): the current
  -- home (id, generation, lifecycle), the Flux home (lifecycle, link and cap versions), the owner's monotonic Flux link revision (absence
  -- included), the ONE home and subscription a billing action touches (plan, status, period), the export.
  target_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  -- The target as the operation's OWN durable reservation left it (a Flux mint's claim advances the lifecycle and cap versions before
  -- its dispatch), written in the same transaction as that reservation: a resumption recognises its own change; any other is a move.
  reserved_target TEXT,
  -- 1: the operation's answer carries a secret; a duplicate of it, once completed, is 410 already_completed and nothing else.
  secret INTEGER NOT NULL CHECK (secret IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'executing', 'done')),
  email TEXT,
  email_gen TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  grant_expires_at INTEGER,
  claimed_at INTEGER,
  -- The operation record (Astra STEPUP-EMAIL-3): the claim's fencing token and until when it runs before a retry may reconcile it; its
  -- kind; its explicit phase (claimed: lease bookkeeping only; dispatched: an external call journaled under the operation's stable identity
  -- before it was made; committed: its durable effect, marked in the same transaction; delivered: the token-fenced finalization;
  -- compensating: the sweep queued the revocation of an undelivered Flux key; compensated: the router confirmed it), and the dispatch
  -- reference (non-secret: e.g. the Flux home and generation).
  exec_token TEXT,
  exec_until INTEGER,
  op_kind TEXT,
  phase TEXT CHECK (phase IN ('claimed', 'dispatched', 'committed', 'delivered', 'compensating', 'compensated')),
  dispatch_ref TEXT,
  -- The resource lease the claim acquired in the same batch (billing_home_leases or the Flux home lease), held for this record's holder.
  lease_kind TEXT CHECK (lease_kind IN ('billing', 'flux')),
  lease_home TEXT,
  lease_holder TEXT,
  lease_generation INTEGER,
  done_at INTEGER,
  -- The minimal replay record: status (NULL: completed, answer unknown), error code, operation reference (non-secret ids only).
  response_status INTEGER,
  response_code TEXT,
  response_ref TEXT,
  -- The bound continuation of POST /v1/account/home/logs/request: reading THAT collection (home, generation, collect_logs command) until
  -- the original grant deadline (grant_expires_at), never a new window.
  continuation_home TEXT,
  continuation_generation INTEGER,
  continuation_command TEXT
);
CREATE INDEX cloud_stepup_intents_user ON cloud_stepup_intents (user_id, session_id, state);
CREATE INDEX cloud_stepup_intents_expiry ON cloud_stepup_intents (expires_at);
CREATE INDEX cloud_stepup_intents_phase ON cloud_stepup_intents (op_kind, phase);

-- The one live emailed challenge per (account, Supabase session): a resend replaces it. Only the HMAC of the code is stored.
CREATE TABLE cloud_stepup_challenges (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  email_gen TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

-- Security events for the email step-up, separate from cloud_factor_trust_events (whose trusted_* kinds feed "nothing to protect").
-- code_reserved rows are the account-wide issuance ledger (5 per rolling 24 h, 30 s apart), whatever the delivery outcome.
CREATE TABLE cloud_stepup_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code_reserved', 'send_failed', 'code_refused', 'granted', 'claimed')),
  intent_id TEXT,
  challenge_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX cloud_stepup_events_user ON cloud_stepup_events (user_id, kind, at);

-- A desktop pairing code is bound to the home generation it was issued for (src/pairing.ts; Astra STEPUP-EMAIL-5 #2): issuance writes it
-- in the creating statement (under an emailed approval, only while the home is still the frozen target), and redemption refuses a code
-- whose generation is not the home's current one. NULL (a code from before this column) pairs nothing; codes live 10 minutes.
ALTER TABLE desktop_pairing_codes ADD COLUMN generation INTEGER;

-- A step-up checkout attempt (src/b5-billing.ts; Astra STEPUP-EMAIL-6 #3) keeps, from BEFORE its Stripe dispatch, the exact Stripe price and
-- the original idempotency key, so the exact retry and a later /checkout/resume replay it under that key even when the batch recording the
-- session never landed. NULL on every other attempt.
ALTER TABLE checkout_resume_attempts ADD COLUMN stripe_price_id TEXT;
ALTER TABLE checkout_resume_attempts ADD COLUMN idempotency_key TEXT;
