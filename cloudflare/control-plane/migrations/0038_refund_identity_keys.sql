-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One voluntary 7-day first-month refund per person or payment method (Sean, 2026-10-10).
-- At a plan's first payment we record who paid, as keyed HMAC-SHA256 hashes only (never the card fingerprint, email or address itself):
--   card    : Stripe's card.fingerprint (the card number; a wallet's device token for Apple Pay / Google Pay)
--   email   : each normalized email of the payment (billing, Link, Stripe customer, Murage account)
--   billing : normalized billing name plus billing address
-- The offer is for a customer's FIRST payment: a payment sharing any key with an earlier payment is not eligible. The EU/UK statutory
-- withdrawal right is never limited by this table.
-- Append-only: rows are never changed (a trigger refuses UPDATE). Deletion is reserved for the retention purge.
CREATE TABLE refund_identity_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('card','email','billing')),
  key_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (invoice_id, kind, key_hash)
);
CREATE INDEX refund_identity_keys_hash ON refund_identity_keys (key_hash, paid_at);

-- One row per first payment whose keys were captured: tells "captured, and these are all the keys" apart from "not captured yet".
-- source: how the payment method was read (card | wallet | link | other | unreadable); fingerprint: 1 when a card key was recorded.
CREATE TABLE refund_identity_captures (
  invoice_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  fingerprint INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL
);

CREATE TRIGGER refund_identity_keys_append_only BEFORE UPDATE ON refund_identity_keys
BEGIN SELECT RAISE(ABORT, 'refund_identity_keys_append_only'); END;
CREATE TRIGGER refund_identity_captures_append_only BEFORE UPDATE ON refund_identity_captures
BEGIN SELECT RAISE(ABORT, 'refund_identity_captures_append_only'); END;
