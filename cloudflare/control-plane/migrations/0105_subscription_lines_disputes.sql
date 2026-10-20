-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra TAXCOUNTRY-7. New columns, tables and indexes only; no existing row is rewritten.
--
-- P1-a: SUBSCRIPTION-SCOPED payment lines (b3-control.ts processPayments). The home's payment_version belongs to ONE subscription, the line
-- it rests on (payment_line, NULL until an event names one: legacy homes keep exactly their current ordering). Every other subscription's
-- events are kept on their own line here: its high-water version and whether it is closed (ended by its own cancellation, or left when the
-- home moved to another line). A closed line never touches the home again; a replacement's activation is never outranked by the end of the
-- contract it replaced.
ALTER TABLE cloud_homes ADD COLUMN payment_line TEXT;
CREATE TABLE cloud_subscription_lines (
  home_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, subscription_id)
);
-- P1-b: every dispute, recorded against the contract its payment belongs to (scope 'current' | 'historical' | 'unattributed'). While
-- closed_at is unset the payment's reimbursements are held (legal-refunds.ts intend): no refund or credit note of a payment the bank is
-- already reversing. Stripe's closure (charge.dispute.closed / funds_withdrawn / funds_reinstated, b5-billing.ts settleDispute) sets
-- closed_at and outcome from the dispute's CURRENT state (retrieved from Stripe, never ordered by event time) and records the principal
-- moved (fees excluded): returned_cents is the money the bank kept for the customer on a loss (amount less anything reinstated), which the
-- refund ledger counts as already returned for that payment (legal-flows.ts disputeReturned). Ops may still close a row by hand (closed_at,
-- outcome): a manual 'lost' with no returned_cents counts the disputed amount as returned.
CREATE TABLE payment_disputes (
  dispute_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  payment_intent TEXT,
  invoice_id TEXT,
  subscription_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('current', 'historical', 'unattributed')),
  reason TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  outcome TEXT,
  amount_cents INTEGER,
  currency TEXT,
  status TEXT,
  withdrawn_cents INTEGER NOT NULL DEFAULT 0,
  reinstated_cents INTEGER NOT NULL DEFAULT 0,
  returned_cents INTEGER,
  updated_at INTEGER,
  -- Round 9b (currency): the disputed charge's currency, and 0 once any movement is not known exactly in it (a balance transaction in
  -- another currency, an amount that is not a whole number of cents, or a dispute currency that differs from the charge's). Never
  -- converted: returned_cents stays unset and every refund of the payment is HELD for an operator (legal-refunds.ts disputeGate).
  charge_currency TEXT,
  movement_exact INTEGER NOT NULL DEFAULT 1 CHECK (movement_exact IN (0, 1)),
  -- Round 10 (Astra TAXCOUNTRY-9 P1-2): an INEXACT dispute's exit. A lost one holds the payment's refunds until an operator records, WITH
  -- evidence (the bank statement or Stripe balance transaction they read), the principal it actually returned in the charge's currency
  -- (resolved_returned_cents; legal-routes.ts POST /v1/admin/disputes/{id}/resolve-returned). resolve_by is the deadline that resolution is
  -- alerted against (dispute.inexact_lost, escalated once passed). A new movement or outcome Stripe reports afterwards clears resolved_at
  -- (the refunds are held again until it is resolved again). A won inexact dispute returned nothing: no resolution is needed.
  resolved_returned_cents INTEGER,
  resolved_at INTEGER,
  resolved_by TEXT,
  resolved_evidence TEXT,
  resolve_by INTEGER,
  CHECK (resolved_at IS NULL OR (resolved_returned_cents IS NOT NULL AND resolved_returned_cents>=0
    AND resolved_by IS NOT NULL AND length(trim(resolved_by))>0 AND resolved_evidence IS NOT NULL AND length(trim(resolved_evidence))>0))
);
CREATE INDEX payment_disputes_invoice ON payment_disputes(invoice_id);
CREATE INDEX payment_disputes_intent ON payment_disputes(payment_intent);
-- Each balance movement of a dispute, once by Stripe's balance transaction id (so every event, in any order or repeated, adds it once):
-- the principal in the dispute's currency, its fee kept apart (never counted as money returned to the customer).
CREATE TABLE payment_dispute_funds (
  txn_id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('withdrawn', 'reinstated')),
  cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX payment_dispute_funds_dispute ON payment_dispute_funds(dispute_id);
-- Every dispute event handled, once by event id; one arriving after the row was closed is recorded too (after_closure), never ignored.
CREATE TABLE payment_dispute_events (
  event_id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT,
  after_closure INTEGER NOT NULL DEFAULT 0 CHECK (after_closure IN (0, 1)),
  recorded_at INTEGER NOT NULL
);
-- B4 (b4-flux.ts stopForBilling / grantMonthlyCredits): 1 when the current billing hold includes a stop that named no invoice (a
-- cancellation, a suspension): such a hold is lifted only by the period rule, never by another contract's paid invoice.
ALTER TABLE flux_home_keys ADD COLUMN billing_hold_unattributed INTEGER NOT NULL DEFAULT 0;
-- Astra TAXCOUNTRY-8 P1-2: the payment line (subscription) whose stop set that unattributed hold, NULL when unknown. A paid invoice of
-- ANOTHER contract that took the home may lift a hold its predecessor's line set (b4-flux.ts, round 9b); the hold of the current line is
-- still lifted only by the period rule.
ALTER TABLE flux_home_keys ADD COLUMN billing_hold_line TEXT;
CREATE INDEX payment_disputes_payment ON payment_disputes(payment_intent) WHERE closed_at IS NULL;
-- P2-e: orphan customer records (cloud_ops_state customer_orphan:*) by age, so the ops listing pages through them oldest first with a
-- keyset cursor and the review sweep reaches every overdue one whatever their number. The expression is b5-billing.ts ORPHAN_AGE_SQL.
CREATE INDEX cloud_ops_state_orphan_age ON cloud_ops_state(
  (CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.recordedAt'),json_extract(value,'$.createdAt'),0) ELSE 0 END), key)
  WHERE key>='customer_orphan:' AND key<'customer_orphan;';
-- Round 9b (dispute credits): a LOST dispute returned money through the bank; the disputed invoice's included credits are owed back for it.
-- The frozen reversal-target formula (FLUX-REVERSAL-TARGET-CONTRACT: T = floor(G x min(succeeded_refunds, paid) / paid)) counts refunds
-- only, so a chargeback never enters a target: the owed reversal is recorded here, one row per dispute, with a credit.dispute_reversal_owed
-- alert (b5-billing.ts disputeCreditObligation). returned_cents follows the dispute's current returned money; a reinstatement lowers it and
-- a full one (or a win) clears it (state 'cleared'). Nothing is ever reversed at the router from this row.
CREATE TABLE dispute_credit_obligations (
  dispute_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  returned_cents INTEGER NOT NULL,
  exact INTEGER NOT NULL DEFAULT 1 CHECK (exact IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('owed', 'cleared')),
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Round 10 (Astra TAXCOUNTRY-9 P2-a): the APPLIED RECEIPT. Ops applies the owed credit adjustment by hand (the frozen formula is never
  -- changed) and records it with evidence (legal-routes.ts POST /v1/admin/dispute-credit-obligations/{id}/applied): the returned amount the
  -- adjustment was made for, when, by whom, and the evidence (the Flux adjustment's reference). The obligation is OPEN while what was applied
  -- differs from what is owed now (returned_cents; 0 once cleared): alerted (credit.dispute_reversal_owed) until applied, and alerted again
  -- when a later reinstatement or win changes what is owed after it was applied.
  applied_returned_cents INTEGER,
  applied_at INTEGER,
  applied_by TEXT,
  applied_evidence TEXT,
  CHECK (applied_at IS NULL OR (applied_returned_cents IS NOT NULL AND applied_returned_cents>=0
    AND applied_by IS NOT NULL AND length(trim(applied_by))>0 AND applied_evidence IS NOT NULL AND length(trim(applied_evidence))>0))
);
CREATE INDEX dispute_credit_obligations_owed ON dispute_credit_obligations(home_id) WHERE state='owed';
-- Round 10 (Astra TAXCOUNTRY-9 P1-5): WHY a home is suspended. 'billing' is written by the lifecycle's grace expiry (b3-control.ts
-- reconcileB3); a home suspended before this column existed (NULL) was suspended that same way (the only path then). A paid event on a
-- billing-suspended home resumes it (resume_required, with a deadline; refunded if the resume cannot complete); a home suspended for any
-- other reason, or one under an abuse closure, is never resumed or kept from deletion by a payment: that money is refunded.
ALTER TABLE cloud_homes ADD COLUMN suspension_cause TEXT CHECK (suspension_cause IS NULL OR suspension_cause IN ('billing', 'abuse', 'operator'));
