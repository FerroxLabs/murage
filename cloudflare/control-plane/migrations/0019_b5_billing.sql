-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B5 billing: Stripe webhook inbox, subscription state, notices, provisioner choices, volume snapshots.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX stripe_events_unprocessed ON stripe_events(received_at) WHERE processed_at IS NULL;
CREATE TABLE billing_subscriptions (
  home_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  previous_plan TEXT,
  price_id TEXT,
  status TEXT NOT NULL DEFAULT 'checkout_created',
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_start INTEGER,
  current_period_end INTEGER,
  fp_tid TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX billing_subscriptions_customer ON billing_subscriptions(customer_id);
CREATE TABLE billing_notices (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE TABLE provision_choices (
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  provider TEXT NOT NULL,
  server_type TEXT NOT NULL,
  location TEXT NOT NULL,
  arch TEXT NOT NULL,
  image TEXT NOT NULL,
  tried TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, resource_generation)
);
CREATE TABLE volume_snapshots (
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  covers_volume INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, resource_generation)
);
CREATE TABLE flux_hook_stub_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook TEXT NOT NULL,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);
-- Backups: one Storage Box sub-account per home. No password, key or restic secret is stored.
CREATE TABLE backup_subaccounts (
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  box_id INTEGER NOT NULL,
  subaccount_id TEXT NOT NULL,
  username TEXT NOT NULL,
  server TEXT NOT NULL,
  directory TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (home_id, resource_generation)
);
