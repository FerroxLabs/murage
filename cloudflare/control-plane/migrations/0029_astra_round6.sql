-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 6. Lease fencing: every acquisition bumps a generation, and a write applies only for the (holder, generation) that still holds
-- the lease on DATABASE time (a worker's own clock is never trusted).
ALTER TABLE billing_home_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
-- Subscription mutations are a journal: an outstanding Stripe change is reconciled by the next holder, and a corrective change always
-- gets its own row and its own idempotency key (Stripe replays the first answer for a reused key without applying anything).
CREATE TABLE sub_mutations (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  desired_cancel INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','superseded')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX sub_mutations_open ON sub_mutations(home_id, subscription_id, state);
-- Stripe's actual renewal state is re-read against the customer's intent (at least daily, and at once after a superseded mutation, whose
-- request may still land late).
ALTER TABLE billing_subscriptions ADD COLUMN cancel_verified_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN cancel_verify_dirty INTEGER NOT NULL DEFAULT 0;
