-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud checkout WP9: emailed withdrawal notices (plan 5.3; SUPPORT-DESIGN 4.5 "Execute withdrawal (5a)"). Number 0064 is the BUILD-PLAN slot.
-- One row per notice. `received_at` is the legal receipt (never changed) and the effective time of the withdrawal; `eligibility_at` is the earlier of
-- received_at and an ACCEPTED sent_at and is the one time every eligibility check uses. Every state change is ONE conditional UPDATE
-- (WHERE state='open' ...) in the same fenced batch as the token consumption, the authorization record and the withdrawal/refund rows.
CREATE TABLE withdrawal_notices (
  id TEXT PRIMARY KEY,                       -- 128-bit random hex
  received_at INTEGER NOT NULL,
  received_basis TEXT NOT NULL,
  received_flagged INTEGER NOT NULL DEFAULT 0,   -- receipt time uncertain: the earliest time the evidence supports was used
  sent_at INTEGER,                           -- evidenced send time (accepted evidence only)
  sent_basis TEXT CHECK (sent_basis IN ('provider_received_header','bounce_report','customer_provider_record','postmark')),
  sent_evidence_ref TEXT,
  sent_accepted_by TEXT,
  sent_accepted_at INTEGER,
  eligibility_at INTEGER NOT NULL,           -- min(received_at, sent_at) when sent_at is accepted, else received_at
  classification TEXT NOT NULL CHECK (classification IN ('withdrawal','cancellation','candidate','support','unclear')),
  classification_rev INTEGER NOT NULL DEFAULT 1,
  classification_basis TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','executing','completed','repudiated','kept')),
  sender TEXT NOT NULL,                      -- the From address(es) as parsed at our boundary, comma separated, lower case
  sender_count INTEGER NOT NULL DEFAULT 1,
  sender_was_account_email INTEGER NOT NULL DEFAULT 0,
  sender_auth TEXT NOT NULL,                 -- JSON: our boundary's SPF/DKIM results, the alignment and enforcement basis, and which check failed
  sender_trusted INTEGER NOT NULL DEFAULT 0,
  subject_hash TEXT,
  body_hash TEXT,
  message_id TEXT,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','de')),
  match_state TEXT NOT NULL DEFAULT 'pending' CHECK (match_state IN ('pending','matched','unmatched','ambiguous')),
  match_note TEXT,
  account_id TEXT,                           -- control-plane user id
  supabase_sub TEXT,                         -- that account's Supabase user id (the token binding)
  home_id TEXT,
  consent_id TEXT,                           -- the contract the notice falls under (by window), not the latest one
  subscription_id TEXT,
  plan_name TEXT,
  plan_started_at INTEGER,
  verification_kind TEXT CHECK (verification_kind IN ('trusted','same_address_failed','other_sender')),
  verification_sent_at INTEGER,
  coalesced_into TEXT,                       -- another open notice of the same account and contract carries the verification email
  repudiated_at INTEGER,
  case_id TEXT,
  executed_via TEXT CHECK (executed_via IN ('link','signed_in','execute','clarify')),
  executing_at INTEGER,
  completed_at INTEGER,
  withdrawal_id TEXT,
  refund_op_id TEXT,
  execute_by INTEGER NOT NULL,               -- 23:59:59 UTC on date(received_at)+13
  item_raised_at INTEGER,                    -- the dated (5a) item appeared (day 12)
  overdue_at INTEGER,
  alert_raised_at INTEGER,                   -- the day-13 "refund due today" alert, retried until acknowledged
  alert_acked_at INTEGER,
  alert_acked_by TEXT,
  alert_attempts INTEGER NOT NULL DEFAULT 0,
  alert_last_at INTEGER,
  alert_rev INTEGER,                         -- r2-2: the classification_rev the alert was raised for; a reclassified notice's alert is withdrawn
  correction_due INTEGER NOT NULL DEFAULT 0, -- the trusted email already went and the notice was reclassified away: WP10 sends the correction
  last_op TEXT,                              -- id of the last transition: follow-up statements in its batch are conditioned on it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX withdrawal_notices_state ON withdrawal_notices (state, classification);
CREATE INDEX withdrawal_notices_contract ON withdrawal_notices (account_id, consent_id);
CREATE UNIQUE INDEX withdrawal_notices_message ON withdrawal_notices (message_id) WHERE message_id IS NOT NULL;

-- The serialization point of an authorization: one row per notice, written in the SAME batch as the open -> executing transition.
CREATE TABLE withdrawal_authorizations (
  notice_id TEXT PRIMARY KEY,
  via TEXT NOT NULL CHECK (via IN ('link','signed_in','execute','clarify')),
  at INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  consent_id TEXT
);

-- Every classification change, refusal, Execute and alert event: actor and time, and why.
CREATE TABLE withdrawal_notice_events (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX withdrawal_notice_events_notice ON withdrawal_notice_events (notice_id, at);

-- A case is opened for every "This wasn't me" press (stopped, or too late to stop). One per notice.
CREATE TABLE withdrawal_notice_cases (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL UNIQUE,
  opened_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  closed_at INTEGER,
  outcome TEXT
);

-- Mail outbox: written in the batch of the change it reports, rendered from the COMMITTED state when it is sent, retried until sent.
CREATE TABLE withdrawal_notice_mail (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mail_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_try_at INTEGER,
  claimed_until INTEGER,    -- exclusive claim while one sweep delivers this row
  payload TEXT,             -- the rendered mail (with its links), fixed at first render so a retry sends the SAME links; cleared once sent
  escalated_at INTEGER      -- after 20 failed tries ops is told; the row is never abandoned
);
CREATE INDEX withdrawal_notice_mail_due ON withdrawal_notice_mail (sent_at, attempts);

-- The contract a notice falls under: insert-only (support design 4.5). Never updated, never deleted; holds no payment fields.
CREATE TABLE contract_links (
  consent_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  customer_id TEXT,
  session_id TEXT,
  subscription_id TEXT,
  provenance TEXT NOT NULL CHECK (provenance IN ('checkout_completed','backfill')),
  created_at INTEGER NOT NULL
);
CREATE TRIGGER contract_links_no_update BEFORE UPDATE ON contract_links BEGIN SELECT RAISE(ABORT, 'contract_links_insert_only'); END;
CREATE TRIGGER contract_links_no_delete BEFORE DELETE ON contract_links BEGIN SELECT RAISE(ABORT, 'contract_links_insert_only'); END;

-- r2-1 (Astra WP9-2 #1): the payment moment of a contract, frozen while it could still be read (billing_subscriptions holds only the home's CURRENT
-- subscription, so a later replacement erases it). Written once (INSERT OR IGNORE), never changed: the guarantee window of a replacement contract
-- runs from this, never from whatever the home holds now. WP5's checkout_consents.paid_at, when present, takes precedence. Rows may be deleted
-- (retention), never moved.
CREATE TABLE contract_deadlines (
  consent_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  source TEXT NOT NULL,                      -- 'observed' (read from the billing row while it was this contract's) | 'billing'
  frozen_at INTEGER NOT NULL
);
CREATE TRIGGER contract_deadlines_no_update BEFORE UPDATE ON contract_deadlines BEGIN SELECT RAISE(ABORT, 'contract_deadlines_write_once'); END;
