-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra review of caaf065b0.
-- 1. An event Stripe delivered in another API version is reconciled: its object is retrieved in the pinned version and the ordinary
--    handler applies it under the home's billing lease. The raw event stays in stripe_events as received; the reconciliation's completion
--    is recorded here, in the same fenced write that marks the event processed.
CREATE TABLE stripe_event_reconciliations (
  event_id TEXT PRIMARY KEY,
  event_api_version TEXT NOT NULL,
  pinned_api_version TEXT NOT NULL,
  object_id TEXT NOT NULL,
  outcome TEXT,
  reconciled_at INTEGER NOT NULL
);
