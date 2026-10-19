-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra review of ea25303b6.
-- 1. The lifecycle no longer writes service_intervals (billing state, written only under the home's billing lease). It appends its
--    service start/end to its own journal, applied to service_intervals under the lease (src/service-intervals.ts).
CREATE TABLE service_interval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start','end')),
  at INTEGER NOT NULL,
  subscription_id TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE INDEX service_interval_log_pending ON service_interval_log(home_id, applied_at, id);
-- 2. What the customer actually paid at checkout (Adaptive Pricing's presentment amount and currency, or the session's own amount):
--    reported in the confirmation. total_cents / tax_cents stay the integration (USD) amounts used for refund accounting. The tax in the
--    charged currency is NULL when Stripe did not itemize it there.
ALTER TABLE checkout_consents ADD COLUMN charged_total_cents INTEGER;
ALTER TABLE checkout_consents ADD COLUMN charged_tax_cents INTEGER;
