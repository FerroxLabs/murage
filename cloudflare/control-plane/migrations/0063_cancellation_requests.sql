-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud checkout WP8: the public no-login cancellation (plan 5.2, 312k BGB). One row per declaration pressed on /cancel.
-- Dates are frozen from received_at (server clock): matching later never moves them. Every status change is ONE conditional UPDATE
-- (WHERE status IN (...)) so "This wasn't me" and the immediate end race to exactly one outcome.
CREATE TABLE cancellation_requests (
  id TEXT PRIMARY KEY,                       -- 128-bit random hex: the receipt capability
  ref TEXT NOT NULL UNIQUE,                  -- the reference number printed on the receipt
  received_at INTEGER NOT NULL,              -- the legal time of the declaration (frozen)
  fields_json TEXT NOT NULL,                 -- every field as entered
  kind TEXT NOT NULL CHECK (kind IN ('ordinary_earliest','ordinary_date','extraordinary')),
  requested_date TEXT,                       -- YYYY-MM-DD as entered
  reason TEXT,
  entered_email TEXT NOT NULL,               -- the account email as typed (lower case)
  entered_name TEXT NOT NULL,
  identifier TEXT,
  confirm_email TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en','de')),
  claimed_ip TEXT,                           -- claimed, never verified
  claimed_ua TEXT,
  match_state TEXT NOT NULL DEFAULT 'pending' CHECK (match_state IN ('pending','matched','unmatched')),
  -- Identification is the attribution. Never 'customer_reconfirmed' (plan 5.2, r8 Fable P3-8): the CHECK refuses it.
  attribution_basis TEXT CHECK (attribution_basis IN ('account_email','identifier','support')),
  attributed_at INTEGER,
  account_id TEXT,                           -- control-plane user id of the plan's owner
  supabase_sub TEXT,                         -- that account's Supabase user id (the link binding)
  home_id TEXT,
  subscription_id TEXT,
  effective_at INTEGER,                      -- LEGAL end (frozen from received_at); never changed by hold_until
  fallback_end_at INTEGER,                   -- extraordinary: the end of the paid month current at received_at, if the reason is rejected
  hold_until INTEGER,                        -- operational expiry of "This wasn't me"; NULL = open (reason check running)
  keep_at INTEGER,                           -- a held case closes as 'kept' at this time
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reason_pending','held','executing','completed','kept')),
  held_at INTEGER,
  held_from TEXT,
  case_id TEXT,
  receipt_sha256 TEXT NOT NULL,
  reason_decision TEXT CHECK (reason_decision IN ('accept','reject')),
  reason_decided_at INTEGER,
  reason_note TEXT,
  completed_at INTEGER,
  stripe_synced INTEGER NOT NULL DEFAULT 1,  -- 0 = Stripe's cancel_at still has to be brought in line with the status
  stripe_cancel_at INTEGER,
  last_op TEXT,                              -- id of the last transition: follow-up statements in its batch are conditioned on it
  late_checked_at INTEGER,
  escalated_at INTEGER,
  -- r1 (Astra WP8-1): the receipt as rendered at submission (immutable bytes, receipt_sha256 is their digest), the seller path frozen at
  -- attribution (a Managed Payments contract stays MP after it is cancelled), the escalation deadlines (identification: the next renewal
  -- minus 3 days, reason check: 3 working days), who closed a kept case, and when Stripe last read back in line.
  receipt_html TEXT,
  seller_path TEXT CHECK (seller_path IN ('direct','mp')),
  identify_due_at INTEGER,
  reason_due_at INTEGER,
  kept_by TEXT CHECK (kept_by IN ('timeout','customer')),
  stripe_verified_at INTEGER,
  -- r2 (Astra WP8-2 #6/#9): fair retry scheduling (each sweep step takes the rows longest unattended first, and a row that did not progress
  -- moves to the back) and one escalation marker per kind, so one escalation never suppresses another.
  next_match_at INTEGER,
  match_attempts INTEGER NOT NULL DEFAULT 0,
  exec_checked_at INTEGER,
  stripe_attempt_at INTEGER,
  identify_escalated_at INTEGER,
  reason_escalated_at INTEGER,
  schedule_escalated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cancellation_requests_status ON cancellation_requests (status, match_state);
CREATE INDEX cancellation_requests_email ON cancellation_requests (entered_email);

-- Mail outbox: written in the same batch as the transition, rendered and sent from the COMMITTED state, retried until sent.
CREATE TABLE cancellation_mail (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- r1: one sender per delivery (claim), a stable payload for its retries (rendered once per committed transition, wiped when sent),
  -- retries never stop (backoff), ops hears once when a delivery keeps failing.
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claimed_until INTEGER,
  payload_json TEXT,                         -- r2 (Astra WP8-2 #10): an AES-GCM envelope (CANCELLATION_MAIL_KEY), never the plain link
  payload_op TEXT,
  escalated_at INTEGER,
  UNIQUE (request_id, kind)
);
CREATE INDEX cancellation_mail_due ON cancellation_mail (sent_at, next_attempt_at);

-- A case is opened for every "This wasn't me" press (held, or too late to hold). One per request.
CREATE TABLE cancellation_cases (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  opened_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  closed_at INTEGER,
  outcome TEXT
);

-- r1 (Astra WP8-1 #4/#5): the journal of every Stripe change this package makes to a subscription (cancel_at, pause_collection, cancel).
-- Written with its own idempotency key BEFORE the call, an unresolved row is settled by sending its own request again with its own key
-- before anything newer is decided, a confirmed failure is superseded and the intent goes out under a FRESH key, done only on read-back.
CREATE TABLE cancellation_stripe_mutations (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cancel_at','pause','cancel_now','release','void')),
  value INTEGER,                             -- cancel_at: Unix seconds or NULL (clear), pause: 1 on, 0 off
  -- r2 (Astra WP8-2 #2): every renewal draft a pause held back is settled by its OWN journal row: 'release' (collection on: owed) or 'void'
  -- (service after the plan's legal end: never owed). released_at on a pause row: all its drafts verified settled.
  invoice_id TEXT,
  released_at INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','superseded')),
  provider_error TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  -- r4 (Astra WP8-4 #2): on a pause row, the settle passes in a row that failed on a read or transport error, and since when; kept across
  -- passes so a failure that persists is escalated while the obligation stays open. Reset by a pass that reads every obligation.
  settle_failures INTEGER NOT NULL DEFAULT 0,
  settle_failing_since INTEGER
);
CREATE INDEX cancellation_stripe_mutations_open ON cancellation_stripe_mutations (subscription_id, state);
