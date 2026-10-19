-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra MAILRETRY-11 P2-B: one open alert per home, kind AND subject. A provision.failed alert is about one payment: when a second payment of
-- the same home is given up, its alert must open alongside the first one (still open, delivered once on its own), never by closing the first
-- as if resolved nor by copying its text. The open-alert index was (home_id, kind); kind is the alert's event name (the webhook payload's
-- `kind`, the daily summary's grouping), so the payment goes in a new key column instead. Every other alert keeps subject '' and the exact
-- dedupe it had (one open per home and kind). Existing rows get ''. No data changes.
ALTER TABLE cloud_alerts ADD COLUMN subject TEXT NOT NULL DEFAULT '';
DROP INDEX cloud_alerts_open;
CREATE UNIQUE INDEX cloud_alerts_open ON cloud_alerts(home_id, kind, subject) WHERE resolved_at IS NULL;
-- Astra MAILRETRY-12 P1: per-payment version high-water marks. The home's payment_version follows its CURRENT payment line only; an event
-- for another payment that was given up on (handled with no effect) records its version here, per (home, payment), never on the home, so
-- it can never make an event of the current payment stale. New table, no existing rows touched.
CREATE TABLE cloud_payment_lines (
  home_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, payment_id)
);
-- Round 8b: a NEW payment that re-opens a home given up on for an earlier payment provisions at a new resource generation, with a fresh
-- provision intent. The earlier attempt's intent (one row per home in cloud_provision_intents) is moved here verbatim (its wrapped token
-- dropped; the token itself was revoked at the give-up), keyed by home and resource generation, naming the payment that superseded it.
-- It is never reused. New table, no existing rows touched.
CREATE TABLE cloud_provision_intents_superseded (
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  cp_generation INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  volume_phase TEXT NOT NULL,
  server_phase TEXT NOT NULL,
  volume_claim TEXT,
  server_claim TEXT,
  volume_id TEXT,
  server_id TEXT,
  volume_json TEXT,
  state TEXT NOT NULL,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  superseded_by_payment TEXT NOT NULL,
  superseded_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, resource_generation)
);
-- Round 9 (Astra MAILRETRY-13 P3): a per-generation cleanup claim on the setup budget. The failed-home branch, the give-up and a reopen
-- each release a given-up attempt's resources; only the pass holding this claim (a short lease, released on failure) runs the cleanup, so it
-- runs once. Two nullable columns, existing rows untouched.
ALTER TABLE provision_attempts ADD COLUMN cleanup_claim TEXT;
ALTER TABLE provision_attempts ADD COLUMN cleanup_claimed_until INTEGER;
-- Round 9 (Astra MAILRETRY-13 P1-2): the resource generation a machine endpoint's deletion was requested for (the give-up, or a reopen
-- asking for the old endpoint's cleanup). The cleanup sweep honours a 'deleting' row only while the home is still at that generation (NULL:
-- every other path, unchanged). Nullable column, existing rows untouched.
ALTER TABLE machine_endpoints ADD COLUMN delete_resource_generation INTEGER;
-- Round 9 (Astra MAILRETRY-13 P1-5): the payment identity of a provision-failed refund obligation, captured with the obligation at the
-- give-up: the invoice (the payment id) and, when it is provable then, its subscription. Opening the refund operation ends THAT subscription,
-- never whatever subscription the home has by then. New table, no existing rows touched.
CREATE TABLE cloud_refund_identities (
  obligation_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  subscription_id TEXT,
  captured_at INTEGER NOT NULL
);
-- Round 10 (Astra MAILRETRY-14 P1): the per-generation resource ledger. Every provider create is recorded here, under the resource generation
-- of the setup attempt that dispatches it, in the same batch that re-proves that generation is still the home's current one (a stale attempt
-- dispatches nothing). A create that still lands after its attempt was given up or superseded is found from here and destroyed, for every
-- generation, even after the budget row moved on; a generation is closed (reclaimed_at) only from a listing taken once its last dispatch has
-- settled. The claim columns serialize that cleanup (one pass destroys). New table, no existing rows touched.
CREATE TABLE cloud_resource_dispatches (
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  last_dispatch_at INTEGER NOT NULL,
  reclaimed_at INTEGER,
  claim TEXT,
  claimed_until INTEGER,
  -- Round 11 (Astra MAILRETRY-15 P2-b): the purge of the generation's snapshots and backups is its own step: set once a purge succeeded,
  -- cleared by a new dispatch or a pass that destroyed something; the generation closes only with it set.
  purged_at INTEGER,
  -- Round 11 (Astra MAILRETRY-15 P1-1): a generation kept open by a dispatch that never settled is looked at again no sooner than this.
  next_check_at INTEGER,
  PRIMARY KEY (home_id, resource_generation)
);
CREATE INDEX cloud_resource_dispatches_open ON cloud_resource_dispatches(last_dispatch_at) WHERE reclaimed_at IS NULL;
-- Round 11 (Astra MAILRETRY-15 P1-1): one row per provider create dispatched through the fence, whatever path ran it (the cron reconcile or the
-- admin HTTP reconcile, which has no fixed duration limit). settled_at is written only when the provider ANSWERED (outcome 'created': the
-- resource exists; 'failed': a provider error answer, the request did not execute) or the call was never sent ('not_sent'). An aborted call
-- (its deadline_at bound passed), a network failure or an invocation that died leaves settled_at NULL: the generation is never closed by a
-- listing that found nothing while such a call exists; it stays reclaimable, re-checked at a bounded cadence, and alerted after hours. Round
-- 12: it is settled by a complete listing proving absence taken after the provider's request lifetime, or by an operator with evidence.
CREATE TABLE cloud_resource_dispatch_calls (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  role TEXT NOT NULL,
  dispatched_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  settled_at INTEGER,
  outcome TEXT,
  -- Round 12 (Astra MAILRETRY-16): the DATABASE's clock at dispatch and at settlement (ordering against a listing's anchor, never a worker's
  -- Date.now()); the settlement's evidence (the resource id the call made, the listing anchor that proved absence after the provider's
  -- request lifetime, or the operator's reference); and the kind of an operator's evidence. role is also 'subaccount' (a Storage Box
  -- sub-account create, recorded before it is sent). An operator confirmation needs evidence: a provider log entry, a cancellation, or a
  -- re-check made at least the provider lifetime bound (70 minutes, PROVIDER_REQUEST_LIFETIME_MS) after the dispatch. Astra INTEGRATED-7 P2:
  -- the confirmation predicate is NULL-safe (a NULL kind, evidence or settled_at fails it; SQLite's CHECK passes on NULL), and no call is
  -- ever settled by elapsed time alone (P1).
  dispatched_db_at INTEGER,
  settled_db_at INTEGER,
  evidence TEXT,
  evidence_kind TEXT,
  CHECK (outcome IS NULL OR outcome<>'operator_confirmed' OR COALESCE(evidence_kind IS NOT NULL AND evidence IS NOT NULL
    AND settled_at IS NOT NULL AND evidence_kind IN ('provider_log','cancellation','recheck') AND length(trim(evidence))>0
    AND (evidence_kind<>'recheck' OR settled_at>=dispatched_at+4200000), 0)=1)
);
CREATE INDEX cloud_resource_dispatch_calls_gen ON cloud_resource_dispatch_calls(home_id, resource_generation);
-- Round 8b (B4 grants, b4-flux.ts): redeliver marks a pending grant the dispute's own Stop cancelled ('held'); once the dispute returned
-- nothing of its invoice it is re-delivered under the SAME grant id ('due'; the app endpoint dedupes a grant id).
ALTER TABLE flux_grants ADD COLUMN redeliver TEXT CHECK (redeliver IS NULL OR redeliver IN ('held','due'));
-- Round 9 (Astra INTEGRATED-9), reworked in round 10 (Astra INTEGRATED-10): THE B4 GRANT LEDGER (b4-flux-ledger.ts). It replaces the
-- per-grant reversal flags of 0086 (reversal_state, reversal_reason, reversal_attempts, reversal_last_attempt_at): one ACCOUNT per grant, its
-- CAUSES as rows and its DISPATCHES as fenced claims.
--  * flux_grant_accounts: amount (the grant), paid_cents (its invoice's payment, with its source) and returned_cents (the money its causes
--    returned) give desired_microcents = amount - floor(amount x min(returned, paid) / paid): what the customer is entitled to NOW, held to
--    that formula by a CHECK. sized=0 when money was returned but the payment's amount is unknown (no automatic action, no settlement; only
--    an operator's EVIDENCED sizing, paid_source 'operator' + sizing_evidence, sizes it). applied_microcents is what Flux holds for the grant
--    by EVIDENCE only. router_state: none, maybe (a delivery dispatched, unconfirmed), delivered, revoking (a revoke dispatched, unconfirmed),
--    revoked (confirmed tombstone), manual (an operator adjusted it). The DEBT is desired - applied, kept for itself (never cleared by a
--    receipt's revision); debt_since is when it arose (the overdue page). settled_revision is informational only.
--  * flux_grant_causes: one row per refund, lost dispute, cancellation (the stop that cancelled the delivery, with the paid entitlement
--    retained then) and legacy reversal (provenance carried over from the dropped flags below).
--  * flux_grant_dispatches: one row per send, revoke and operator adjustment: a unique fencing token, the revision it acts on, claimed_at
--    stamped by the claim itself, an expiry, and a completion that applies only while the token still owns the row. At most ONE open
--    dispatch per grant. An AMBIGUOUS answer keeps the row open (state 'open', last_outcome): only an authoritative answer or a subsuming
--    dispatch ends it. An operator's receipt names its Flux adjustment reference, unique across all receipts.
CREATE TABLE flux_grant_accounts (
  grant_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  invoice_id TEXT,
  amount_microcents INTEGER NOT NULL CHECK (amount_microcents > 0),
  paid_cents INTEGER CHECK (paid_cents IS NULL OR paid_cents > 0),
  paid_source TEXT CHECK (paid_source IS NULL OR paid_source IN ('refund_coverage', 'refund_ops', 'operator')),
  sizing_evidence TEXT,
  sized_by TEXT,
  returned_cents INTEGER NOT NULL DEFAULT 0 CHECK (returned_cents >= 0),
  sized INTEGER NOT NULL DEFAULT 1 CHECK (sized IN (0, 1)),
  desired_microcents INTEGER NOT NULL,
  applied_microcents INTEGER NOT NULL DEFAULT 0,
  delivered_confirmed_microcents INTEGER NOT NULL DEFAULT 0 CHECK (delivered_confirmed_microcents >= 0),
  router_state TEXT NOT NULL DEFAULT 'none' CHECK (router_state IN ('none', 'maybe', 'delivered', 'revoking', 'revoked', 'manual')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  settled_revision INTEGER,
  debt_since INTEGER,
  last_tried_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (desired_microcents >= 0 AND desired_microcents <= amount_microcents),
  CHECK (applied_microcents >= 0 AND applied_microcents <= amount_microcents),
  -- INTEGRATED-10: an unsized account is exactly "money returned, payment amount unknown".
  CHECK (sized = 1 OR (returned_cents > 0 AND paid_cents IS NULL)),
  -- A sized account's entitlement IS the formula (nothing typed by hand).
  CHECK (sized = 0 OR (returned_cents = 0 AND desired_microcents = amount_microcents)
    OR (paid_cents IS NOT NULL AND desired_microcents = amount_microcents - (amount_microcents * MIN(returned_cents, paid_cents)) / paid_cents)),
  -- An operator's sizing carries its evidence and its author.
  CHECK (COALESCE(paid_source IS NOT 'operator' OR (sizing_evidence IS NOT NULL AND length(trim(sizing_evidence)) > 0
    AND sized_by IS NOT NULL AND length(trim(sized_by)) > 0), 0) = 1)
);
CREATE INDEX flux_grant_accounts_home ON flux_grant_accounts (home_id, invoice_id);
CREATE INDEX flux_grant_accounts_tried ON flux_grant_accounts (last_tried_at);
-- The sweep's revoke candidates (REVOKE_AUTO's own terms), least recently tried first, without scanning every account.
CREATE INDEX flux_grant_accounts_revoke ON flux_grant_accounts (last_tried_at)
  WHERE sized = 1 AND desired_microcents = 0 AND router_state IN ('maybe', 'delivered', 'revoking');
CREATE TABLE flux_grant_causes (
  grant_id TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('refund', 'dispute_loss', 'cancellation', 'legacy_reversal')),
  ref TEXT NOT NULL,
  returned_cents INTEGER NOT NULL DEFAULT 0 CHECK (returned_cents >= 0),
  retained_microcents INTEGER CHECK (retained_microcents IS NULL OR retained_microcents >= 0),
  evidence TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (grant_id, cause, ref)
);
CREATE TABLE flux_grant_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deliver', 'revoke', 'operator')),
  revision INTEGER NOT NULL,
  target_microcents INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'applied', 'refused', 'superseded')),
  outcome TEXT,
  last_outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  applied_microcents INTEGER,
  adjustment_ref TEXT,
  evidence TEXT,
  by TEXT,
  completed_at INTEGER,
  -- INTEGRATED-12 (R8): an operator's receipt is PENDING VERIFICATION until Flux's own record of the adjustment confirms its amount; while
  -- pending it moves no stored balance (the claim stays open, the obligation stays alerted with the stated amount and reference).
  receipt_microcents INTEGER,
  receipt_evidence TEXT,
  receipt_by TEXT,
  receipt_at INTEGER,
  CHECK (COALESCE(kind <> 'operator' OR state <> 'applied' OR (applied_microcents IS NOT NULL AND evidence IS NOT NULL AND length(trim(evidence)) > 0
    AND adjustment_ref IS NOT NULL AND length(trim(adjustment_ref)) > 0 AND by IS NOT NULL AND length(trim(by)) > 0), 0) = 1),
  CHECK (receipt_at IS NULL OR (kind = 'operator' AND receipt_microcents IS NOT NULL AND receipt_evidence IS NOT NULL AND length(trim(receipt_evidence)) > 0
    AND receipt_by IS NOT NULL AND length(trim(receipt_by)) > 0))
);
CREATE UNIQUE INDEX flux_grant_dispatches_open ON flux_grant_dispatches (grant_id) WHERE state = 'open';
CREATE INDEX flux_grant_dispatches_grant ON flux_grant_dispatches (grant_id, kind, state);
CREATE UNIQUE INDEX flux_grant_dispatches_adjustment ON flux_grant_dispatches (adjustment_ref) WHERE adjustment_ref IS NOT NULL;
-- INTEGRATED-10 (L7): the durable cursor of the bounded reconciliation (one row per cursor name).
CREATE TABLE flux_ledger_cursors (
  name TEXT PRIMARY KEY,
  position TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- INTEGRATED-10 P2: the access paths of the reconciliation (the invoice of a home's refunds and disputes, the open-dispute scopes).
CREATE INDEX refund_coverage_invoice ON refund_coverage (home_id, invoice_id);
CREATE INDEX payment_disputes_home_invoice ON payment_disputes (home_id, invoice_id);
CREATE INDEX payment_disputes_open_invoice ON payment_disputes (home_id, invoice_id) WHERE closed_at IS NULL;
CREATE INDEX payment_disputes_open_contract ON payment_disputes (home_id, subscription_id) WHERE closed_at IS NULL;
CREATE INDEX refund_ops_home_invoice ON refund_ops (home_id, invoice_id);
-- INTEGRATED-10 P1: THE BACKFILL, from the columns about to be dropped, BEFORE they are dropped. Nothing is invented:
--  * applied: a delivery acknowledged (status 'done') holds the grant; a CONFIRMED revoke (status 'reversed', the only state the old code
--    wrote on an explicit revoked/tombstoned answer) holds nothing; anything else holds nothing by evidence.
--  * router_state: 'revoked' only when confirmed. A reversal marked 'done' or 'requested' that was ATTEMPTED but never confirmed stays
--    'revoking' (ambiguous: the request may still execute). Not attempted: the delivery's own evidence (done -> delivered, attempted or
--    claimed -> maybe, else none).
--  * desired, returned, paid and sized from the payment's records as they stand (the same formula as the ledger).
--  * debt_since: the grant's creation when a debt (or a possible holding) stands.
INSERT INTO flux_grant_accounts (grant_id, home_id, invoice_id, amount_microcents, paid_cents, paid_source, returned_cents, sized,
  desired_microcents, applied_microcents, delivered_confirmed_microcents, router_state, debt_since, updated_at)
WITH base AS (
  SELECT g.grant_id, g.home_id, g.invoice_id, g.amount_microcents AS amt, g.status, g.reversal_state AS rs, g.reversal_attempts AS ra,
    g.attempts, g.claim_id, g.created_at,
    CASE WHEN g.invoice_id IS NULL THEN 0 ELSE
      MAX(0, COALESCE((SELECT SUM(c.covered_cents) FROM refund_coverage c WHERE c.home_id = g.home_id AND c.invoice_id = g.invoice_id), 0))
      + MAX(0, COALESCE((SELECT SUM(CASE WHEN d.closed_at IS NULL THEN 0
          WHEN d.movement_exact = 0 THEN CASE WHEN d.outcome = 'lost' AND d.resolved_at IS NOT NULL THEN COALESCE(d.resolved_returned_cents, 0) ELSE 0 END
          WHEN d.returned_cents IS NOT NULL THEN d.returned_cents
          WHEN d.outcome = 'lost' THEN COALESCE(d.amount_cents, 0) ELSE 0 END)
        FROM payment_disputes d WHERE d.home_id = g.home_id AND d.invoice_id = g.invoice_id), 0)) END AS ret,
    (SELECT MAX(c.paid_cents) FROM refund_coverage c WHERE c.home_id = g.home_id AND c.invoice_id = g.invoice_id AND c.paid_cents > 0) AS pc,
    (SELECT MAX(o.paid_cents) FROM refund_ops o WHERE o.home_id = g.home_id AND o.invoice_id = g.invoice_id AND o.paid_cents > 0) AS po
  FROM flux_grants g),
calc AS (
  SELECT *, COALESCE(pc, po) AS paid, CASE WHEN pc IS NOT NULL THEN 'refund_coverage' WHEN po IS NOT NULL THEN 'refund_ops' END AS psrc,
    CASE WHEN status = 'done' THEN amt ELSE 0 END AS applied,
    CASE WHEN status = 'reversed' THEN 'revoked'
      WHEN rs IN ('requested', 'done') AND ra > 0 THEN 'revoking'
      WHEN status = 'done' THEN 'delivered'
      WHEN attempts > 0 OR claim_id IS NOT NULL THEN 'maybe'
      ELSE 'none' END AS rstate
  FROM base),
fin AS (
  SELECT *, CASE WHEN ret = 0 OR paid IS NOT NULL THEN 1 ELSE 0 END AS sized,
    CASE WHEN ret = 0 OR paid IS NULL THEN amt ELSE amt - (amt * MIN(ret, paid)) / paid END AS desired
  FROM calc)
SELECT grant_id, home_id, invoice_id, amt, CASE WHEN sized = 1 AND ret > 0 THEN paid END, CASE WHEN sized = 1 AND ret > 0 THEN psrc END, ret, sized,
  desired, applied, CASE WHEN status IN ('done', 'reversed') THEN amt ELSE 0 END, rstate,
  CASE WHEN desired <> applied OR rstate IN ('maybe', 'revoking') OR sized = 0 THEN created_at END, created_at
FROM fin;
-- The causes behind those amounts, and the dropped flags' provenance (returned 0: it never sets an amount).
INSERT INTO flux_grant_causes (grant_id, cause, ref, returned_cents, evidence, revision, recorded_at, updated_at)
SELECT a.grant_id, 'refund', c.payment_intent, MAX(0, c.covered_cents), 'refund_coverage:' || c.payment_intent || ':succeeded', 1, a.updated_at, a.updated_at
FROM flux_grant_accounts a JOIN refund_coverage c ON c.home_id = a.home_id AND c.invoice_id = a.invoice_id;
INSERT INTO flux_grant_causes (grant_id, cause, ref, returned_cents, evidence, revision, recorded_at, updated_at)
SELECT a.grant_id, 'dispute_loss', d.dispute_id, MAX(0, CASE WHEN d.closed_at IS NULL THEN 0
    WHEN d.movement_exact = 0 THEN CASE WHEN d.outcome = 'lost' AND d.resolved_at IS NOT NULL THEN COALESCE(d.resolved_returned_cents, 0) ELSE 0 END
    WHEN d.returned_cents IS NOT NULL THEN d.returned_cents WHEN d.outcome = 'lost' THEN COALESCE(d.amount_cents, 0) ELSE 0 END),
  'payment_disputes:' || d.dispute_id || ':' || COALESCE(d.outcome, 'open') || CASE WHEN d.movement_exact = 0 THEN ':inexact' ELSE '' END, 1, a.updated_at, a.updated_at
FROM flux_grant_accounts a JOIN payment_disputes d ON d.home_id = a.home_id AND d.invoice_id = a.invoice_id;
INSERT INTO flux_grant_causes (grant_id, cause, ref, returned_cents, evidence, revision, recorded_at, updated_at)
SELECT grant_id, 'legacy_reversal', 'migration:0106', 0,
  'flux_grants.reversal_state=' || reversal_state || ';reason=' || COALESCE(reversal_reason, '') || ';attempts=' || reversal_attempts
    || ';last_attempt_at=' || COALESCE(reversal_last_attempt_at, '') || ';status=' || status
    || CASE WHEN status = 'reversed' THEN ';confirmed' ELSE ';unconfirmed' END, 1, created_at, created_at
FROM flux_grants WHERE reversal_state <> 'none';
INSERT INTO flux_grant_causes (grant_id, cause, ref, returned_cents, retained_microcents, evidence, revision, recorded_at, updated_at)
SELECT g.grant_id, 'cancellation', 'migration:0106', 0, a.desired_microcents, 'flux_grants.status=cancelled (before the ledger)', 1, g.created_at, g.created_at
FROM flux_grants g JOIN flux_grant_accounts a ON a.grant_id = g.grant_id WHERE g.status = 'cancelled';
-- OUTSTANDING OWNERSHIP: an unconfirmed revoke that was attempted may still execute (R6): it keeps an OPEN revoke dispatch (expired, so a
-- confirmed revoke may supersede it; nothing else can). A delivery claim still held keeps an OPEN deliver dispatch under its own id (the
-- delivery id the router saw), unless such a revoke subsumes it (then recorded as superseded).
INSERT INTO flux_grant_dispatches (dispatch_id, grant_id, kind, revision, target_microcents, claimed_at, expires_at, state, outcome, last_outcome, attempts)
SELECT 'migration:revoke:' || grant_id, grant_id, 'revoke', 1, 0, COALESCE(reversal_last_attempt_at, created_at), COALESCE(reversal_last_attempt_at, created_at),
  'open', NULL, 'migration:0106:unconfirmed', reversal_attempts
FROM flux_grants WHERE reversal_state IN ('requested', 'done') AND reversal_attempts > 0 AND status <> 'reversed';
INSERT INTO flux_grant_dispatches (dispatch_id, grant_id, kind, revision, target_microcents, claimed_at, expires_at, state, outcome, last_outcome, attempts)
SELECT g.claim_id, g.grant_id, 'deliver', 1, g.amount_microcents, COALESCE(g.claimed_at, g.created_at), COALESCE(g.claimed_at, g.created_at) + 300000,
  CASE WHEN EXISTS (SELECT 1 FROM flux_grant_dispatches x WHERE x.grant_id = g.grant_id AND x.state = 'open') THEN 'superseded' ELSE 'open' END,
  CASE WHEN EXISTS (SELECT 1 FROM flux_grant_dispatches x WHERE x.grant_id = g.grant_id AND x.state = 'open') THEN 'migration:0106:subsumed_by_revoke' END,
  'migration:0106:claim', MAX(1, g.attempts)
FROM flux_grants g WHERE g.claim_id IS NOT NULL AND g.status IN ('pending', 'cancelled');
DROP INDEX flux_grants_by_reversal;
ALTER TABLE flux_grants DROP COLUMN reversal_state;
ALTER TABLE flux_grants DROP COLUMN reversal_reason;
ALTER TABLE flux_grants DROP COLUMN reversal_attempts;
ALTER TABLE flux_grants DROP COLUMN reversal_last_attempt_at;
-- Round 9 (Astra INTEGRATED-9 P1, b3-control.ts processPayments): CANCELLATION HISTORY, kept apart from the home's current entitlement. Every
-- cancellation event acknowledged for a home records its line (subscription; '' for a legacy entry without one) and version here, once per
-- event, so a later payment_problem replacing 'canceled' can never erase the fact that a paid entry at or below that version was overtaken
-- by a cancellation (its money is then owed back: refund:closed_line).
CREATE TABLE cloud_payment_cancellations (
  home_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  line TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, event_id)
);
-- INTEGRATED-10 P2: the history does not start empty: every cancellation ALREADY acknowledged in the preserved inbox is recorded now.
INSERT OR IGNORE INTO cloud_payment_cancellations (home_id, event_id, line, version, recorded_at)
SELECT home_id, id, COALESCE(json_extract(payload, '$.subscriptionId'), ''), version, processed_at
FROM cloud_payment_inbox WHERE processed_at IS NOT NULL AND json_valid(payload) AND json_extract(payload, '$.status') = 'canceled';
-- Round 9 (Astra INTEGRATED-9 P2): RETAINED payment entries: retry age and backoff (attempts, retained since, next try) and ONE overdue
-- page (paged_at). INTEGRATED-10: the age is the entry's durable receipt time (cloud_payment_inbox.received_at), never the first time a pass
-- happened to look at it.
CREATE TABLE cloud_payment_retention (
  entry_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_retained_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  paged_at INTEGER
);
CREATE INDEX cloud_payment_retention_home ON cloud_payment_retention (home_id, next_attempt_at);
CREATE INDEX cloud_payment_inbox_pending ON cloud_payment_inbox (received_at) WHERE processed_at IS NULL;
CREATE INDEX cloud_payment_inbox_home_pending ON cloud_payment_inbox (home_id, version) WHERE processed_at IS NULL;
-- INTEGRATED-12 P2: the DRAINAGE FRONTIER of historical payment entries (one row per name): the (received_at, entry id) position the reserved
-- slots of the next pass start after, so historical obligations advance across passes whatever a hot home keeps adding.
-- INTEGRATED-13 P2: the position moves only after the page's work is recorded, and each LAP is bounded by its horizon (lap_horizon: the
-- newest receipt time when the lap began): an entry received later waits for the next lap, so continuing arrivals can never keep the cursor
-- from wrapping.
CREATE TABLE cloud_payment_frontier (
  name TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  lap_horizon INTEGER
);
-- INTEGRATED-10 P1 (b5-billing.ts markDisputeCreditApplied): a B5 dispute credit adjustment is made under a VERSIONED CLAIM: the claim names
-- the obligation's revision (raised by every change of what is owed); competing claims are excluded; the receipt completes it once.
ALTER TABLE dispute_credit_obligations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dispute_credit_obligations ADD COLUMN claim_token TEXT;
ALTER TABLE dispute_credit_obligations ADD COLUMN claim_by TEXT;
ALTER TABLE dispute_credit_obligations ADD COLUMN claim_revision INTEGER;
ALTER TABLE dispute_credit_obligations ADD COLUMN claimed_at INTEGER;
-- G-F1 (STRIPE-8) / INTEGRATED-11: THE DISPUTE HOLD, one row PER EVENT that armed it (event_id), written from the dispute event itself
-- FIRST (before the home is resolved, outside any lease). It is ALWAYS scoped (a CHECK): the disputed payment intent, its invoice, or (only
-- when neither is known) its customer; never a hold on everyone. An event no record of ours can be attributed to holds nothing (paged as
-- unmatched instead). While a row is unreleased (attributed_at IS NULL) every refund in its scope is held. It is released ONLY by the
-- committed checkpoint of the event that armed it (attributed_at, home_id), or by an operator's evidenced close (closed_by, close_evidence).
-- Amounts and closure are never read from here. Unreleased after 15 minutes it pages (paged_at).
CREATE TABLE dispute_holds (
  event_id TEXT PRIMARY KEY,
  charge_id TEXT NOT NULL,
  dispute_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payment_intent TEXT,
  invoice_id TEXT,
  customer_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  held_at INTEGER NOT NULL,
  home_id TEXT,
  attributed_at INTEGER,
  paged_at INTEGER,
  closed_by TEXT,
  close_evidence TEXT,
  -- INTEGRATED-12: 1 while the hold's scope is not completely attributed (its invoice, or anything at all, not known yet): such a hold fences
  -- every refund it COULD belong to (its customer's when known, else every refund) until the scope is resolved (retried on every pass of
  -- its event), released, or closed by an operator with evidence. Written BEFORE any Stripe lookup.
  scope_pending INTEGER NOT NULL DEFAULT 0 CHECK (scope_pending IN (0, 1)),
  CHECK (payment_intent IS NOT NULL OR invoice_id IS NOT NULL OR customer_id IS NOT NULL OR scope_pending = 1),
  CHECK (closed_by IS NULL OR (attributed_at IS NOT NULL AND close_evidence IS NOT NULL AND length(trim(close_evidence)) > 0))
);
CREATE INDEX dispute_holds_intent ON dispute_holds (payment_intent) WHERE attributed_at IS NULL;
CREATE INDEX dispute_holds_invoice ON dispute_holds (invoice_id) WHERE attributed_at IS NULL;
CREATE INDEX dispute_holds_customer ON dispute_holds (customer_id) WHERE attributed_at IS NULL;
CREATE INDEX dispute_holds_unattributed ON dispute_holds (held_at) WHERE attributed_at IS NULL;
CREATE INDEX dispute_holds_pending ON dispute_holds (scope_pending) WHERE attributed_at IS NULL;
CREATE INDEX dispute_holds_charge ON dispute_holds (charge_id);
-- Astra FLUX-7 / INTEGRATED-10 (b5-billing.ts pollOpenDisputes): an open dispute past Stripe's webhook retry window is polled; when it was
-- last read and how many reads in a row failed. Nullable / defaulted columns, existing rows untouched.
ALTER TABLE payment_disputes ADD COLUMN polled_at INTEGER;
ALTER TABLE payment_disputes ADD COLUMN poll_failures INTEGER NOT NULL DEFAULT 0;
CREATE INDEX payment_disputes_open_age ON payment_disputes (opened_at) WHERE closed_at IS NULL;
-- INTEGRATED-13 P2 (legal-refunds.ts advanceLeased): the RELEASE GENERATION of a refund operation. Every wake of a refund held by a dispute
-- hold (the hold closed, released or narrowed: WAKE_HELD_BY_HOLD_SQL) raises it; a worker's failure bookkeeping imposes its retry backoff
-- only while the generation is the one it read, so a release that lands during a pass is never overwritten by the stale backoff.
ALTER TABLE refund_ops ADD COLUMN wake_gen INTEGER NOT NULL DEFAULT 0;
-- INTEGRATED-15 P2 (dispute-sql.ts homeOwnsCustomerSql): THE CUSTOMER OWNERSHIP INDEX. Admission (the refund gate's read and the claim),
-- the hold wake and attribution ask, per unreleased hold, whether a home EVER owned the hold's customer. That used to re-read the home's
-- orphan and create-journal JSON history for every hold on every read; it is now one primary-key lookup here. One row per (customer, home)
-- ever recorded by: the ownership ledger `customer_home:<customer>`, a previous-customer record
-- `customer_previous:<home>:<customer>`, an orphan record `customer_orphan:<home>:<attempt>` or a create journal row
-- `tax_customer:<home>:<key>` naming the customer. INSERT-ONLY (never deleted, never rewritten): ownership is immutable history, so a record
-- deleted later (a create journal closed by its switch batch, an orphan reviewed) never narrows a hold. Kept by triggers on every write of
-- those records, whatever code path writes them, and backfilled below from the rows that exist now. The CURRENT pointer
-- (billing_subscriptions) is not copied here: the predicate reads it directly, and a pointer that moves leaves its previous customer in
-- the ledger and the previous-customer record. No trigger on billing_subscriptions: D1 counts a trigger's writes in meta.changes, and
-- the customer switch reads the pointer update's changes as its compare-and-set. (SQL changes() excludes trigger writes; no caller
-- checks meta.changes of an ownership-record write that names a customer: the create journal is written before its customer exists.)
-- The triggers insert only what is missing (NOT EXISTS), never relying on OR IGNORE: inside a trigger, the conflict policy of the
-- OUTER statement (an INSERT OR REPLACE, an upsert) overrides the trigger's own, and a duplicate would abort the writer.
CREATE TABLE customer_owners (
  customer_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  PRIMARY KEY (customer_id, home_id)
) WITHOUT ROWID;
-- The (customer, home) each ownership record of cloud_ops_state names (one definition for the backfill and the triggers). A home is the
-- record's own `homeId` when the key is built from it, else the key's first segment; a customer is the key's (customer_home:,
-- customer_previous:) or the value's `customerId` (customer_orphan:, tax_customer:).
CREATE VIEW customer_owner_records AS
SELECT key, customer_id, home_id FROM (
  SELECT key, substr(key, 15) AS customer_id, CASE WHEN json_valid(value) THEN json_extract(value, '$.homeId') END AS home_id
    FROM cloud_ops_state WHERE key >= 'customer_home:' AND key < 'customer_home;'
  UNION ALL
  SELECT key,
    CASE WHEN json_valid(value) AND key = 'customer_previous:' || json_extract(value, '$.homeId') || ':' || json_extract(value, '$.customerId')
      THEN json_extract(value, '$.customerId') ELSE substr(substr(key, 19), instr(substr(key, 19), ':') + 1) END,
    CASE WHEN json_valid(value) AND key = 'customer_previous:' || json_extract(value, '$.homeId') || ':' || json_extract(value, '$.customerId')
      THEN json_extract(value, '$.homeId') ELSE substr(substr(key, 19), 1, instr(substr(key, 19), ':') - 1) END
    FROM cloud_ops_state WHERE key >= 'customer_previous:' AND key < 'customer_previous;'
  UNION ALL
  SELECT key, CASE WHEN json_valid(value) THEN json_extract(value, '$.customerId') END,
    CASE WHEN json_valid(value) AND substr(key, 1, 17 + length(json_extract(value, '$.homeId'))) = 'customer_orphan:' || json_extract(value, '$.homeId') || ':'
      THEN json_extract(value, '$.homeId') ELSE substr(substr(key, 17), 1, instr(substr(key, 17), ':') - 1) END
    FROM cloud_ops_state WHERE key >= 'customer_orphan:' AND key < 'customer_orphan;'
  UNION ALL
  SELECT key, CASE WHEN json_valid(value) THEN json_extract(value, '$.customerId') END,
    CASE WHEN json_valid(value) AND substr(key, 1, 14 + length(json_extract(value, '$.homeId'))) = 'tax_customer:' || json_extract(value, '$.homeId') || ':'
      THEN json_extract(value, '$.homeId') ELSE substr(substr(key, 14), 1, instr(substr(key, 14), ':') - 1) END
    FROM cloud_ops_state WHERE key >= 'tax_customer:' AND key < 'tax_customer;'
) WHERE typeof(customer_id) = 'text' AND customer_id <> '' AND typeof(home_id) = 'text' AND home_id <> '';
INSERT OR IGNORE INTO customer_owners (customer_id, home_id) SELECT customer_id, home_id FROM customer_owner_records;
CREATE TRIGGER customer_owners_record_insert AFTER INSERT ON cloud_ops_state
  WHEN substr(NEW.key, 1, 14) = 'customer_home:' OR substr(NEW.key, 1, 18) = 'customer_previous:' OR substr(NEW.key, 1, 16) = 'customer_orphan:'
    OR substr(NEW.key, 1, 13) = 'tax_customer:'
  BEGIN INSERT INTO customer_owners (customer_id, home_id) SELECT r.customer_id, r.home_id FROM customer_owner_records r WHERE r.key = NEW.key
    AND NOT EXISTS (SELECT 1 FROM customer_owners o WHERE o.customer_id = r.customer_id AND o.home_id = r.home_id); END;
CREATE TRIGGER customer_owners_record_update AFTER UPDATE ON cloud_ops_state
  WHEN substr(NEW.key, 1, 14) = 'customer_home:' OR substr(NEW.key, 1, 18) = 'customer_previous:' OR substr(NEW.key, 1, 16) = 'customer_orphan:'
    OR substr(NEW.key, 1, 13) = 'tax_customer:'
  BEGIN INSERT INTO customer_owners (customer_id, home_id) SELECT r.customer_id, r.home_id FROM customer_owner_records r WHERE r.key = NEW.key
    AND NOT EXISTS (SELECT 1 FROM customer_owners o WHERE o.customer_id = r.customer_id AND o.home_id = r.home_id); END;
