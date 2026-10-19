-- SPDX-License-Identifier: AGPL-3.0-or-later
-- First payments whose identity capture was incomplete (refund-identity.ts): Stripe could not show the payment itself (only the customer
-- or account email was read), or it carried neither a card, a billing identity nor a payment email. The sweep reads them again (with
-- backoff) and adds any key it finds; the row is removed once the capture is complete, or 14 days after the payment (nothing more will
-- come). A capture with no key at all is never recorded: the payment stays uncaptured and its own refund check stays pending.
CREATE TABLE refund_identity_enrich (
  invoice_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  payment_intent TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);
