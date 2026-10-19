-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Legal flows, review fixes (Astra review of ca3f90bbd): one open checkout per home, one refund ledger with resumable
-- operations, contract/service timestamps, the region hold, tax quotes shown before consent, document-version assent and
-- re-acceptance, durable notice delivery, explicit abuse closures, the export pause deadline, and top-up sync state.

-- #1 One open checkout per home. A retry with the same choices reuses the session; a changed choice expires the old one first.
CREATE TABLE open_checkouts (
  home_id TEXT PRIMARY KEY,
  consent_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,             -- creating | open | completed
  session_id TEXT,
  session_url TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- #2 #6 #7 #10 #12 #18 What the customer was shown and what actually happened, kept separately.
ALTER TABLE checkout_consents ADD COLUMN contract_made_at INTEGER;      -- Stripe's time for the completed checkout
ALTER TABLE checkout_consents ADD COLUMN confirmation_sent_at INTEGER;  -- the durable confirmation was handed off
ALTER TABLE checkout_consents ADD COLUMN effective_country TEXT;        -- Stripe's collected billing country (the authority)
ALTER TABLE checkout_consents ADD COLUMN effective_eu_region INTEGER;
ALTER TABLE checkout_consents ADD COLUMN region_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_consents ADD COLUMN effective_start_at INTEGER;    -- start_at, or day 15 after a region hold
ALTER TABLE checkout_consents ADD COLUMN postal_code TEXT;
ALTER TABLE checkout_consents ADD COLUMN quote_id TEXT;
ALTER TABLE checkout_consents ADD COLUMN tax_source TEXT;               -- stripe_tax | unavailable | none
ALTER TABLE checkout_consents ADD COLUMN quoted_tax_cents INTEGER;
ALTER TABLE checkout_consents ADD COLUMN quoted_total_cents INTEGER;
ALTER TABLE checkout_consents ADD COLUMN quoted_topup_total_cents INTEGER;
ALTER TABLE checkout_consents ADD COLUMN disclosure TEXT;               -- immutable JSON of everything shown
ALTER TABLE checkout_consents ADD COLUMN user_agent_seen TEXT;
ALTER TABLE checkout_consents ADD COLUMN client_meta TEXT;              -- claimed (forwarded by the portal) vs observed, or "unavailable"

-- #10 A server-priced disclosure: the Stripe Tax calculation the consent screen showed.
CREATE TABLE tax_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  country TEXT NOT NULL,
  postal_code TEXT,
  price_cents INTEGER NOT NULL,
  tax_cents INTEGER,
  total_cents INTEGER,
  topup_amount_cents INTEGER NOT NULL,
  topup_tax_cents INTEGER,
  topup_total_cents INTEGER,
  source TEXT NOT NULL,                   -- stripe_tax | unavailable
  calculation_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX tax_quotes_user ON tax_quotes(user_id, created_at);

-- #7 When the service was actually supplied (paid entitlement handed to the lifecycle). #14 next yearly reminder.
ALTER TABLE billing_subscriptions ADD COLUMN service_supplied_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN reminder_due_at INTEGER;
CREATE INDEX billing_subscriptions_reminder ON billing_subscriptions(reminder_due_at);

-- #16 Only an explicit, evidenced abuse closure disqualifies the 7-day refund.
CREATE TABLE abuse_closures (
  home_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  closed_at INTEGER NOT NULL
);

-- #3 #4 #5 One refund ledger for every route. Each row is a resumable operation with its own checkpoints; the sum of decided
-- amounts against one invoice can never exceed what was paid (checked in the same batch that decides an amount).
CREATE TABLE refund_ops (
  id TEXT PRIMARY KEY,                    -- firstmonth:<user> | withdrawal:<withdrawal id> | regionhold:<invoice> | duplicate:<invoice>
  kind TEXT NOT NULL,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  invoice_id TEXT,
  payment_intent TEXT,
  paid_cents INTEGER,
  target_cents INTEGER,
  amount_cents INTEGER,
  basis TEXT,
  detail TEXT,
  end_plan INTEGER NOT NULL,              -- cancel the tracked subscription
  cancel_subscription_id TEXT,            -- or this one (a duplicate)
  decided_at INTEGER,
  stripe_refund_id TEXT,
  refunded_at INTEGER,
  canceled_at INTEGER,
  credits_revoked_at INTEGER,
  notified_at INTEGER,
  done_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX refund_ops_due ON refund_ops(next_attempt_at) WHERE done_at IS NULL;
CREATE INDEX refund_ops_invoice ON refund_ops(invoice_id);
CREATE INDEX refund_ops_pi ON refund_ops(payment_intent);
CREATE INDEX refund_ops_home ON refund_ops(home_id);
ALTER TABLE withdrawals ADD COLUMN refund_op_id TEXT;
ALTER TABLE withdrawals ADD COLUMN service_supplied_at INTEGER;

-- #8 One non-extendable pause per deletion cycle (the home generation while suspended).
ALTER TABLE data_export_requests ADD COLUMN pause_until INTEGER;
ALTER TABLE data_export_requests ADD COLUMN cycle INTEGER;
UPDATE data_export_requests SET pause_until = requested_at + 604800000 WHERE pause_until IS NULL;

-- #12 Every acceptance of a set of document versions (checkout or re-acceptance), and the 30-day change notices.
CREATE TABLE terms_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cloud_terms_version TEXT NOT NULL,
  tos_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  source TEXT NOT NULL,                   -- checkout | reaccept
  consent_id TEXT,
  wording TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  client_meta TEXT NOT NULL
);
CREATE INDEX terms_acceptances_user ON terms_acceptances(user_id, accepted_at);
CREATE TABLE terms_change_notices (
  user_id TEXT NOT NULL,
  cloud_terms_version TEXT NOT NULL,
  tos_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  home_id TEXT NOT NULL,
  notified_at INTEGER NOT NULL,
  effective_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, cloud_terms_version, tos_version, privacy_version)
);

-- #13 #15 Durable delivery: no attempt or age limit drops a pending event or notice; an atomic claim stops double sends.
ALTER TABLE stripe_events ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE billing_notices ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_notices ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE billing_notices ADD COLUMN claimed_until INTEGER;
CREATE INDEX billing_notices_unsent ON billing_notices(next_attempt_at) WHERE sent_at IS NULL;

-- #17 The authorization is applied to Flux auto-recharge (B4); until it is, the row says so.
ALTER TABLE topup_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topup_settings ADD COLUMN applied_revision INTEGER;
ALTER TABLE topup_settings ADD COLUMN applied_at INTEGER;
ALTER TABLE topup_settings ADD COLUMN apply_error TEXT;
