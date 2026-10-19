-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Provisioning is retryable: the enrollment token is kept wrapped (never plain) so a later attempt can re-deliver it,
-- and every home has a bounded attempt budget. Giving up releases the resources, refunds and tells the customer.
ALTER TABLE cloud_provision_intents ADD COLUMN token_wrapped TEXT;
CREATE TABLE provision_attempts (
  home_id TEXT PRIMARY KEY,
  resource_generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  gave_up_at INTEGER,
  give_up_code TEXT,
  cleaned_at INTEGER
);
