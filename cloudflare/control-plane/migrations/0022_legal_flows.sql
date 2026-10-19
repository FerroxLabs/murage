-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Legal flows (CHECKOUT.md): consent log, delayed start, auto top-up settings, first-month refund, data export pause.
-- One record per checkout. Written BEFORE the Stripe session is created; never updated except to attach the Stripe ids and tax.
CREATE TABLE checkout_consents (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  screen_version TEXT NOT NULL,
  cloud_terms_version TEXT NOT NULL,
  tos_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  terms_accepted INTEGER NOT NULL,
  recurring_authorized INTEGER NOT NULL,
  early_start INTEGER NOT NULL,
  eu_region INTEGER NOT NULL,
  topup_enabled INTEGER NOT NULL,
  topup_amount_cents INTEGER,
  topup_threshold_cents INTEGER,
  topup_cap_cents INTEGER,
  topup_text TEXT,
  renewal_text TEXT NOT NULL,
  wording TEXT NOT NULL,
  billing_country TEXT NOT NULL,
  tax_id TEXT,
  plan TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  tax_line TEXT,
  start_at INTEGER NOT NULL,
  first_charge_at INTEGER NOT NULL,
  delayed_start INTEGER NOT NULL,
  ip TEXT,
  ip_seen TEXT,
  user_agent TEXT,
  stripe_session_id TEXT,
  stripe_subscription_id TEXT,
  stripe_country TEXT,
  total_cents INTEGER,
  tax_cents INTEGER,
  completed_at INTEGER
);
CREATE INDEX checkout_consents_home ON checkout_consents(home_id, created_at);
CREATE INDEX checkout_consents_user ON checkout_consents(user_id, created_at);

-- The exact text of every document version a customer accepted, kept as proof (version ids are content hashes, so a row never changes).
CREATE TABLE legal_doc_archive (
  version_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  text TEXT NOT NULL,
  archived_at INTEGER NOT NULL
);

ALTER TABLE billing_subscriptions ADD COLUMN consent_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN service_start_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_charge_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_invoice_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN first_paid_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_invoice_cents INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_invoice_tax_cents INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_period_start INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_period_end INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN first_payment_intent TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN abuse_closed_at INTEGER;

-- Auto top-up settings, stored for B4 (the Flux side reads these; this table is the customer's authorization).
CREATE TABLE topup_settings (
  home_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  threshold_cents INTEGER NOT NULL,
  cap_cents INTEGER NOT NULL,
  cap_period TEXT NOT NULL,
  cap_resets TEXT NOT NULL,
  consent_id TEXT,
  updated_at INTEGER NOT NULL
);
-- Every change to the top-up authorization, kept as proof.
CREATE TABLE topup_events (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  threshold_cents INTEGER NOT NULL,
  cap_cents INTEGER NOT NULL,
  source TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

-- The first-month refund is given once per customer (the account owner).
CREATE TABLE first_month_refunds (
  user_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  used_credit_cents INTEGER NOT NULL,
  stripe_refund_id TEXT,
  created_at INTEGER NOT NULL
);

-- "Request my data". While one is open (and under 7 days old) the day-14 deletion waits.
CREATE TABLE data_export_requests (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  delivered_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX data_export_requests_home ON data_export_requests(home_id, status);

-- EU online withdrawal function (Directive 2023/2673): one row per withdrawal, with the time the statement was confirmed.
CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  name TEXT,
  confirmed_at INTEGER NOT NULL,
  early_start INTEGER NOT NULL,
  days_supplied INTEGER NOT NULL,
  deducted_cents INTEGER NOT NULL,
  refund_cents INTEGER NOT NULL,
  basis TEXT NOT NULL,
  stripe_refund_id TEXT,
  status TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE UNIQUE INDEX withdrawals_home ON withdrawals(home_id);
