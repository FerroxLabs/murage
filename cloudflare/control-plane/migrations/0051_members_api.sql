-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Members-area routes (members-api.ts). 0041: makerkit-auth also uses 0040.

-- A server-issued plan-change quote: the exact proration the member saw (Stripe proration_date), bound to the subscription, item and prices.
CREATE TABLE plan_quotes (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  from_price TEXT NOT NULL,
  to_plan TEXT NOT NULL,
  to_price TEXT NOT NULL,
  proration_date INTEGER NOT NULL,     -- Unix seconds, passed identically to the preview and to the update
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Plan changes the member asked for. state: requested (pending update at Stripe) | paid | applied | payment_failed | expired
CREATE TABLE plan_changes (
  id TEXT PRIMARY KEY,                 -- planchange:<quote id>
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  from_plan TEXT NOT NULL,
  to_plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  invoice_id TEXT,                     -- the upgrade's own invoice: its failure never touches the paid subscription
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX plan_changes_home ON plan_changes(home_id, created_at);
CREATE INDEX plan_changes_invoice ON plan_changes(invoice_id);

-- One resize per upgrade, one step per sweep, every step under the home's billing lease and fenced by the home's lifecycle generation.
CREATE TABLE plan_resizes (
  id TEXT PRIMARY KEY,                 -- resize:<home>:<subscription>:<plan>
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,         -- cloud_homes.generation when queued: any lifecycle transition since stops provider work
  resource_generation INTEGER NOT NULL,
  from_plan TEXT NOT NULL,
  to_plan TEXT NOT NULL,
  state TEXT NOT NULL,                 -- queued | snapshotting | snapshotted | powering_off | changing | powering_on | checking | recovering | restoring | done | unhealthy | failed
  server_id TEXT,
  from_type TEXT,
  target_type TEXT,
  action_id TEXT,
  snapshot_ref TEXT,
  pending_op TEXT,                     -- journal: the provider call in flight (snapshot | shutdown | forceoff | change_type | poweron); reconciled before anything else
  attempts INTEGER NOT NULL DEFAULT 0,
  powered_on_at INTEGER,
  step_at INTEGER,
  shutdown_sent_at INTEGER,            -- a shutdown was sent (acknowledged or not) and the server has not yet been verified back on
  next_at INTEGER NOT NULL,
  alerted_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE UNIQUE INDEX plan_resizes_one_active ON plan_resizes(home_id) WHERE state NOT IN ('done', 'unhealthy', 'failed');
CREATE INDEX plan_resizes_due ON plan_resizes(next_at) WHERE state NOT IN ('done', 'unhealthy', 'failed');

-- Flux must learn the new plan: set in the same statement that moves the plan, cleared only after Flux took it (retried on redelivery).
ALTER TABLE billing_subscriptions ADD COLUMN flux_plan_dirty INTEGER NOT NULL DEFAULT 0;

-- The exact Stripe price a checkout consent was sold at (set with its session); Finish checkout reuses a consent only for that price.
ALTER TABLE checkout_consents ADD COLUMN stripe_price_id TEXT;

-- Finish checkout: one immutable attempt per replacement session: its id, expiry and the COMPLETE creation request, replayed byte for byte
-- under the same Stripe idempotency key until recorded.
CREATE TABLE checkout_resume_attempts (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  payload TEXT NOT NULL,               -- the createCheckoutSession input, as sent the first time
  state TEXT NOT NULL,                 -- creating | done | abandoned
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX checkout_resume_attempts_home ON checkout_resume_attempts(home_id, consent_id, state);
