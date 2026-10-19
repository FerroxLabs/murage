-- SPDX-License-Identifier: AGPL-3.0-or-later
-- TRUST-FIRST-FACTOR.md revision 4, part D (Astra TRUST-3 #2, TRUST-4 P2-1..P2-5): the FIRST purchase on an account with nothing to protect
-- proceeds on the email sign-in alone, under this purchase authorization. One row per account, for ever: never deleted by the code, and a
-- consumed or closed row is never reused (the triggers below refuse any change to one). src/purchase-bootstrap.ts.
--   open       reserved by POST /v1/billing/reserve (in the same batch as the home, only while the protect-set is empty); checkout and
--              resume may issue Stripe sessions for it until issue_until, from the same Supabase session, for the same home
--   submitted  checkout.session.completed, payment pending: no new checkout authority
--   parked     the paid completion parked (acceptance line missing): no new checkout authority
--   consumed   the accepted payment was recorded (same transaction as the paid moment, on every paid path)
--   closed     the first purchase was rejected or its payment failed (closed_reason)
--   expired    past issue_until with every Stripe session it issued terminal: ONE more generation may be claimed (compare-and-swap)
CREATE TABLE cloud_purchase_bootstraps (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  session_id TEXT NOT NULL,             -- the Supabase session_id that reserved; only it may continue
  home_id TEXT NOT NULL,                -- the home reserved in the same batch
  consent_id TEXT,                      -- the order (checkout_consents.id) of the latest issued Stripe session
  stripe_customer_id TEXT,              -- the Stripe customer this operation created (never looked up, never reused)
  stripe_session_id TEXT,               -- the latest Stripe Checkout session issued for it
  state TEXT NOT NULL CHECK (state IN ('open', 'submitted', 'parked', 'consumed', 'closed', 'expired')),
  created_at INTEGER NOT NULL,          -- ms
  issue_until INTEGER NOT NULL,         -- ms; created_at + 30 min: no new or replacement Stripe session after it (an issued one still pays)
  consumed_at INTEGER,                  -- ms; set once, with state 'consumed'
  closed_reason TEXT
);
CREATE INDEX cloud_purchase_bootstraps_home ON cloud_purchase_bootstraps (home_id);
-- consumed and closed are final; expired may only become the NEXT generation's open row; a generation never goes back.
CREATE TRIGGER cloud_purchase_bootstraps_final BEFORE UPDATE ON cloud_purchase_bootstraps
  WHEN OLD.state IN ('consumed', 'closed') BEGIN SELECT RAISE(ABORT, 'purchase_bootstrap_final'); END;
CREATE TRIGGER cloud_purchase_bootstraps_expired BEFORE UPDATE ON cloud_purchase_bootstraps
  WHEN OLD.state = 'expired' AND NOT (NEW.state = 'open' AND NEW.generation = OLD.generation + 1)
  BEGIN SELECT RAISE(ABORT, 'purchase_bootstrap_expired'); END;
CREATE TRIGGER cloud_purchase_bootstraps_generation BEFORE UPDATE ON cloud_purchase_bootstraps
  WHEN NEW.generation < OLD.generation OR NEW.user_id <> OLD.user_id BEGIN SELECT RAISE(ABORT, 'purchase_bootstrap_generation'); END;

-- Every expired generation, kept as history (insert-only): its home, order, customer and session stay on record after the next generation
-- reuses the account's row, and they are the ONLY records the next claim may find on the account.
CREATE TABLE cloud_purchase_bootstrap_history (
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  consent_id TEXT,
  stripe_customer_id TEXT,
  stripe_session_id TEXT,
  state TEXT NOT NULL CHECK (state = 'expired'),
  created_at INTEGER NOT NULL,
  issue_until INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, generation)
);
CREATE TRIGGER cloud_purchase_bootstrap_history_no_update BEFORE UPDATE ON cloud_purchase_bootstrap_history
  BEGIN SELECT RAISE(ABORT, 'purchase_bootstrap_history_insert_only'); END;
