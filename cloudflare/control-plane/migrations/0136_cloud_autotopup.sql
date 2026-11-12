-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud auto top-up charging. One row per attempt; at most one OPEN attempt (claimed, invoiced, paid) per home, so concurrent sweeps charge once.
-- A paid attempt stays open until its credit grant landed and the cap was raised, so a failed grant never allows a second charge.
CREATE TABLE topup_attempts (
  attempt_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  settings_revision INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed','invoiced','paid','done','declined','action_required','abandoned')),
  invoice_id TEXT,
  tax_cents INTEGER,
  error TEXT,
  claimed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paid_at INTEGER,
  granted_at INTEGER
);
CREATE UNIQUE INDEX topup_attempts_one_open ON topup_attempts (home_id) WHERE state IN ('claimed','invoiced','paid');
CREATE INDEX topup_attempts_invoice ON topup_attempts (invoice_id);
-- Cents reserved against the owner's monthly cap, per UTC month. The reservation is made in the same batch as the claim.
CREATE TABLE topup_month (
  home_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  reserved_cents INTEGER NOT NULL,
  last_attempt TEXT,
  PRIMARY KEY (home_id, month_key)
);
-- Per-home pause (declines, authentication needed) and the short cooldown after a paid attempt.
CREATE TABLE topup_state (
  home_id TEXT PRIMARY KEY,
  paused_at INTEGER,
  pause_reason TEXT,
  declines INTEGER NOT NULL DEFAULT 0,
  last_paid_at INTEGER,
  cap_notice_month TEXT
);
ALTER TABLE flux_home_keys ADD COLUMN cap_checked_at INTEGER;
