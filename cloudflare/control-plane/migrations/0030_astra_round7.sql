-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 7.
-- Cancellation is terminal per subscription: once a customer's cancellation has been confirmed at Stripe, this holds that subscription id and
-- no renewal request for it is ever sent again (a late one that still lands is corrected by the next read-back).
ALTER TABLE billing_subscriptions ADD COLUMN cancel_terminal_sub TEXT;
-- The first real invoice of a delayed start is held (auto_advance=false) while it is a draft, compared with the agreed total, and only then
-- finalized and paid. Each step is recorded so a retry resumes instead of repeating it.
CREATE TABLE first_invoice_holds (
  invoice_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  agreed_cents INTEGER NOT NULL,
  amount_due INTEGER,
  state TEXT NOT NULL CHECK(state IN ('seen','held','finalized','paid','pay_declined','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
