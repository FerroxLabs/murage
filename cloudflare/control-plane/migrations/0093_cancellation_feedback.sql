-- Murage Cloud customer journey, lane A (control plane). New tables, plus evidence columns on checkout_consents (A6) and the Flux off switch (A8), at the end.
--
-- cancel_references: every customer-facing cancellation reference ("CX-" and eight characters) ever handed out, from ONE allocator
-- (cancel-reference.ts allocateCancelRef) shared by the public cancel form (cancellation_requests.ref) and the signed-in cancel
-- (plan_cancellations.reference): a reference is reserved here first, so the same number never names two cancellations in either table.
-- The public form's existing references are reserved below. `owner` only says who took it (public:<request id> or plan:<home>:<subscription>).
CREATE TABLE cancel_references (
  reference TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO cancel_references (reference,owner,created_at) SELECT ref,'public:'||id,created_at FROM cancellation_requests;

-- plan_cancellations: the receipt of a signed-in "Cancel plan" (POST /v1/account/cancel-plan). One row per home and subscription,
-- written when the cancel is recorded; `reference` is the customer-facing CX-... number (cancel-reference.ts, the same generator as the
-- public cancel form), shown on the receipt screen and in the cancellation email. The cancel never depends on this row: Stripe's
-- read-back decides, the row only names it. No foreign key on user_id: recording a receipt must never be able to fail a cancel.
CREATE TABLE plan_cancellations (
  reference TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX plan_cancellations_home_sub ON plan_cancellations (home_id, subscription_id);
CREATE INDEX plan_cancellations_user ON plan_cancellations (user_id);

-- cancellation_feedback (A1): why a customer cancelled, from POST /v1/account/cancel-plan/reason, a separate call after the cancel that can
-- never block or change it. cancellation_id is plan_cancellations.reference. `text` is the customer's optional free text (at most 500
-- characters); it is read only by people reading feedback, never copied into an alert, a log or an email. Kept 13 months from the day it was
-- written (expires_at), then deleted by the billing sweep (journey.ts purgeCancellationFeedback); eraseCancellationFeedback(user_id) is the hook for
-- an account erasure, which does not exist in the control plane yet.
CREATE TABLE cancellation_feedback (
  cancellation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('too_expensive','not_using_it','missing_feature','technical_problem','switching_service','temporary_pause','other')),
  text TEXT CHECK (text IS NULL OR length(text) <= 500),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cancellation_feedback_expiry ON cancellation_feedback (expires_at);
CREATE INDEX cancellation_feedback_user ON cancellation_feedback (user_id);

-- refund_requests (A2): a customer's request for the first-month refund, from POST /v1/account/refund-request. It RECORDS the request and
-- nothing else: no money moves and no refund is executed here; the refund stays the operator flow (/v1/admin/refund-first-month, which takes
-- this row's id: decided as of received_at, for payment_key and consent_id, with every limit of that flow). One request per account per
-- payment: payment_key is the first payment's invoice id, and a second call returns the same row. eligible = the operator flow's canonical
-- checks passed when the request arrived (else pending, with pending_reasons, a JSON list of reason codes); window_open/deadline = the date only. decided_at/refund_op_id: set when the operator executed it (refund_ops id).
CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payment_key TEXT NOT NULL,
  consent_id TEXT,
  received_at INTEGER NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0,1)),
  deadline INTEGER,
  window_open INTEGER NOT NULL DEFAULT 0 CHECK (window_open IN (0,1)),
  pending_reasons TEXT,
  decided_at INTEGER,
  refund_op_id TEXT,
  -- Astra JOURNEY-A-3 #6: the payment as of receipt (legal-flows PinnedPayment JSON of payment_key) and that payment's subscription, so a
  -- request whose payment a replacement checkout later superseded is still decided on its own payment, never the replacement's.
  payment_snapshot TEXT,
  subscription_id TEXT
);
CREATE UNIQUE INDEX refund_requests_account_payment ON refund_requests (user_id, payment_key);

-- invoice_list_cache (A4): GET /v1/account/invoices answers from Stripe and keeps the answer 60 seconds per account so a page that asks twice
-- does not ask Stripe twice. The body is the list WITHOUT links (hosted_invoice_url / invoice_pdf are never stored); rows older than an hour
-- are deleted by the billing sweep.
CREATE TABLE invoice_list_cache (
  user_id TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  body TEXT NOT NULL
);

-- invoice_email_log (A4): the account's budget for POST /v1/account/invoices/:id/email. A 'request' row for every accepted request (at most 10
-- an hour, counted BEFORE Stripe is asked); a 'send' row for every new invoice email recorded (at most 3 an hour and 10 a day per account,
-- i.e. per verified recipient). Holds no invoice, link or address. Rows older than a day are deleted by the billing sweep.
CREATE TABLE invoice_email_log (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request','send')),
  at INTEGER NOT NULL
);
CREATE INDEX invoice_email_log_user ON invoice_email_log (user_id, kind, at);

-- A6 (Astra JOURNEY-A-2): terminal settlement evidence for a checkout, so a refunded failed home is retired only when no checkout of it can
-- still be submitted or paid (b3-control CHECKOUT_MAY_SETTLE_SQL), never on age. session_inflight_at: a Checkout session was requested from
-- Stripe for this consent and its answer is not yet recorded (set before the call, cleared with stripe_session_id, or by that session's own
-- confirmed expiry). session_expired_at: Stripe confirmed (checkout.session.expired) that the consent's current session expired unsubmitted.
-- Existing rows: a session the home's open checkout already shows expired is backfilled; nothing is inferred from age.
ALTER TABLE checkout_consents ADD COLUMN session_inflight_at INTEGER;
ALTER TABLE checkout_consents ADD COLUMN session_expired_at INTEGER;
-- Astra JOURNEY-A-3 #2: the identity of the request in flight (the Stripe idempotency key, also sent as the session's metadata issuance_id).
-- Set with session_inflight_at, cleared with it; a checkout.session.expired/completed event settles the marker only when it names this id.
ALTER TABLE checkout_consents ADD COLUMN session_issuance_id TEXT;
UPDATE checkout_consents SET session_expired_at=(SELECT o.updated_at FROM open_checkouts o WHERE o.session_id=checkout_consents.stripe_session_id AND o.state='expired')
  WHERE contract_made_at IS NULL AND stripe_session_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM open_checkouts o WHERE o.session_id=checkout_consents.stripe_session_id AND o.state='expired');
-- Astra JOURNEY-A-4 #3: the billing sweep's fair scheduling of markers (b5-billing sweepBilling), one row per marker (consent and issuance id,
-- '' for none): stamped before each reconciliation attempt, whatever its outcome (a failure, a busy home), with backoff; the sweep takes the
-- markers due soonest, so permanently unresolved ones never starve newer ones. Sweep bookkeeping only (no billing state): a new issuance
-- starts with no row (due at once), and rows of settled markers are dropped by the sweep.
CREATE TABLE checkout_marker_schedule (
  consent_id TEXT NOT NULL,
  issuance_id TEXT NOT NULL,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (consent_id, issuance_id)
);
-- Astra JOURNEY-A-4 #2: an explicit UNRESOLVED-LEGACY state. A pre-upgrade creation attempt or consent may have a Stripe session nobody
-- recorded (the code before this migration journaled nothing before asking Stripe): a consent with no contract, not rejected or failed,
-- whose session was never recorded, or whose home still shows a creation attempt in flight for it (a new checkout, or a "Finish checkout"
-- replacement), gets the marker 'legacy:<consent>' from its creation time. It keeps a failed home from retiring until the sweep
-- (b5-billing reconcileSessionMarker) has listed the customer's sessions by the consent's metadata at Stripe and found every one terminal.
UPDATE checkout_consents SET session_inflight_at=created_at, session_issuance_id='legacy:'||id
  WHERE session_inflight_at IS NULL AND contract_made_at IS NULL AND rejected_at IS NULL AND payment_failed_at IS NULL
    AND (stripe_session_id IS NULL
      OR EXISTS (SELECT 1 FROM open_checkouts o WHERE o.home_id=checkout_consents.home_id AND o.consent_id=checkout_consents.id AND o.state='creating')
      OR EXISTS (SELECT 1 FROM checkout_resume_attempts a WHERE a.home_id=checkout_consents.home_id AND a.consent_id=checkout_consents.id AND a.state='creating'));

-- A8 (Astra JOURNEY-A-2): Flux spending switched off, an explicit state. flux_home_keys.cap_microcents must stay positive (0086), so off is its
-- own flag: Flux is told a limit of zero (b4-flux EFFECTIVE_CAP) while the owner's last limit stays stored for switching back on (step-up).
ALTER TABLE flux_home_keys ADD COLUMN spending_off INTEGER NOT NULL DEFAULT 0 CHECK (spending_off IN (0,1));
-- Astra JOURNEY-A-4 #6: when spending was switched off (cleared when switched back on). An off the router has not confirmed is pending; the
-- status shows how long, and past an hour b4-flux sweepFlux raises flux.spending_off_unconfirmed and the customer is offered support.
ALTER TABLE flux_home_keys ADD COLUMN spending_off_at INTEGER;

-- Astra JOURNEY-A-5/A-6: a refund's credit adjustment follows the money ACTUALLY returned, as a VERSIONED CUMULATIVE TARGET per grant (contract:
-- lanes/cloud-v2/b4/FLUX-REVERSAL-TARGET-CONTRACT.md). A refund-driven row (reason 'refunded') has scope 'target'; every other reversal keeps
-- scope 'full' (the final, unversioned reversal of the grant's unused value). For a target row:
--   covered_cents/paid_cents: the payment's coverage the target follows (Stripe's refund listing, status succeeded only); the target removal
--     T = floor(G x min(covered, paid) / paid) in router microcents (G: the grant's frozen amount), the router clamping to G - consumed;
--   target_revision: monotonic per grant, bumped on EVERY coverage change (up, down, full); target_microcents/sent_revision: the last T asked
--     and the highest revision ever dispatched (stamped before the call); applied_revision/removed_microcents: the router's receipt, recorded
--     only when it names the latest revision; reversed_at: set once the latest revision is applied (NULL = due).
ALTER TABLE credit_reversals ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full','target'));
ALTER TABLE credit_reversals ADD COLUMN covered_cents INTEGER;
ALTER TABLE credit_reversals ADD COLUMN paid_cents INTEGER;
ALTER TABLE credit_reversals ADD COLUMN payment_intent TEXT;
ALTER TABLE credit_reversals ADD COLUMN target_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_reversals ADD COLUMN target_microcents INTEGER;
ALTER TABLE credit_reversals ADD COLUMN sent_revision INTEGER;
ALTER TABLE credit_reversals ADD COLUMN applied_revision INTEGER;
ALTER TABLE credit_reversals ADD COLUMN removed_microcents INTEGER;
-- Astra JOURNEY-A-8 #3: a FINAL target (lane B: a turned-away order's, an unserved renewal's refund-backed reversal): versioned and
-- reversible like any target (it follows the money actually returned), and its grant is never asked for again (as a scope 'full' row).
ALTER TABLE credit_reversals ADD COLUMN final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0,1));
-- Astra JOURNEY-A-8 #1: what is known of a grant's delivery to the router. NULL: no ask was ever dispatched; 'dispatched': every dispatched
-- ask was refused definitively (nothing applied); 'ambiguous': an ask may have been applied without a definitive answer (a 503, a lost
-- response, a timeout: stamped before each dispatch). Only NULL (or not_applied_reversed) lets a target settle at zero locally; otherwise the
-- router is asked (grant_not_found settles a 'dispatched' grant; an 'ambiguous' one needs a receipt).
ALTER TABLE credit_grants ADD COLUMN delivery_state TEXT CHECK (delivery_state IN ('dispatched','ambiguous'));
CREATE INDEX credit_reversals_payment ON credit_reversals (payment_intent) WHERE payment_intent IS NOT NULL;
-- Astra JOURNEY-A-6 #1/#4: PAYMENT-LEVEL coverage reconciliation, kept independently of any reversal row (b5-billing reconcilePaymentCoverage).
-- One row per refunded payment of a home: its invoice (the grants it paid for are discovered from it on every pass), the contract it belongs
-- to, what was paid, and the last listing (covered: succeeded refunds; open: refunds neither succeeded nor failed/canceled). end_plan: an
-- external full refund of the RETAINED contract was reported; service ends only once the listing shows the whole payment covered (ended_at),
-- never on the event's own claim. Polled hourly while any work is pending (open refunds, unknown paid amount, an unsettled target, an end
-- awaiting coverage with refunds still open), then for 120 days after the last coverage change.
CREATE TABLE refund_coverage (
  home_id TEXT NOT NULL,
  payment_intent TEXT NOT NULL,
  invoice_id TEXT,
  subscription_id TEXT,
  paid_cents INTEGER,
  covered_cents INTEGER NOT NULL DEFAULT 0,
  open_cents INTEGER NOT NULL DEFAULT 0,
  end_plan INTEGER NOT NULL DEFAULT 0 CHECK (end_plan IN (0,1)),
  ended_at INTEGER,
  checked_at INTEGER,
  changed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, payment_intent)
);
CREATE INDEX refund_coverage_payment ON refund_coverage (payment_intent);
CREATE INDEX refund_coverage_checked ON refund_coverage (checked_at);
-- Astra JOURNEY-A-6 #6: the Flux sweep's rotation over switched-off homes (b4-flux sweepFlux): stamped before each router status read, so every
-- such home is polled for cap drift in turn, pending operations or not.
ALTER TABLE flux_home_keys ADD COLUMN spending_off_checked_at INTEGER;
