-- B5 (customer journey, lane B): the in-app Cancel plan is keepable by its CX reference.
-- plan_cancellations is lane A's table (branch cloud-v2/journey-a, migration 0093_cancellation_feedback.sql, A5): the receipt of a
-- signed-in Cancel plan, keyed by its customer-facing CX-... reference. Created here only if it does not exist yet (identical columns and
-- indexes), so this branch works on its own and is a no-op once lane A's 0093 has run first.
CREATE TABLE IF NOT EXISTS plan_cancellations (
  reference TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_cancellations_home_sub ON plan_cancellations (home_id, subscription_id);
CREATE INDEX IF NOT EXISTS plan_cancellations_user ON plan_cancellations (user_id);
-- Astra JOURNEY-B-1 #16: cancel_references is lane A's table too (0093_cancellation_feedback.sql, cancel-reference.ts allocateCancelRef): every
-- customer-facing CX- reference ever handed out, from the ONE allocator shared by the public form (cancellation_requests.ref) and every
-- signed-in receipt (plan_cancellations.reference: Cancel plan and Delete my Cloud), so one number never names two cancellations in either
-- table. Created here only if it does not exist yet (identical columns), and the references already handed out are reserved; a no-op once
-- lane A's 0093 has run first.
CREATE TABLE IF NOT EXISTS cancel_references (
  reference TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO cancel_references (reference,owner,created_at) SELECT ref,'public:'||id,created_at FROM cancellation_requests;
INSERT OR IGNORE INTO cancel_references (reference,owner,created_at) SELECT reference,'plan:'||home_id||':'||subscription_id,received_at FROM plan_cancellations;

-- B5: Keep my plan for an in-app cancellation (POST /v1/account/cancellations/{CX reference}/keep): who kept it and when. The plan's
-- state lives in billing_subscriptions (the in-app intent is cleared and synced to Stripe); this is the record, and it stops a late
-- Stripe event from bringing the cancellation back.
CREATE TABLE plan_cancellation_keeps (
  reference TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kept_at INTEGER NOT NULL,
  -- Astra JOURNEY-B-1 #4/#12: the in-app intent revision this Keep made (billing_subscriptions.cancel_intent_rev after the clear). The Keep is
  -- read from it (the summary's keeping state), never from cached flags.
  -- One row per Keep: the revision is unique per subscription (two Keeps in the same millisecond stay two rows).
  revision INTEGER NOT NULL,
  PRIMARY KEY (reference, revision)
);

-- Astra JOURNEY-B-5 #1: every attempt sent under a subscription mutation's idempotency key (b5-billing.ts syncCancellation), as a JSON array of
-- Unix ms, recorded BEFORE the request is sent. A pending renew request is retired only on its key's own authoritative answer, or on a
-- subscription Stripe shows ended while no attempt is younger than the request lifetime; a row's age never retires it (cancel.key_unsettled
-- only reports it). NULL on rows written before this column: their created_at is their one attempt.
ALTER TABLE sub_mutations ADD COLUMN dispatched_at TEXT;
-- Astra JOURNEY-BCORE-1 #4: the attempts recorded in dispatched_at are the OUTSTANDING ones only. An attempt Stripe answered (any 4xx that is
-- not 409 idempotency_key_in_use: refused, nothing done, it can never land) is taken off the list again (b5-billing.ts ANSWERED_SQL), so an
-- answered refusal never refreshes the outstanding-attempt gate. '[]' = no attempt outstanding.

-- Astra JOURNEY-BCORE-1 #1: the public cancellation path's mutations record every attempt too (public-cancellation.ts reconcileSubscription),
-- with the same meaning: a JSON array of Unix ms of the attempts sent under the key whose answer never came back. NULL on older rows: their
-- created_at is their one attempt.
ALTER TABLE cancellation_stripe_mutations ADD COLUMN dispatched_at TEXT;

-- Astra JOURNEY-BCORE-1 #3: the in-app cancellation sweep's own attempt bookkeeping, persisted BEFORE each row is worked on: when it was last
-- attempted (fair rotation: the row attempted longest ago goes first), how many attempts failed in a row and when it is eligible again
-- (backoff). A successful sync clears the backoff. Independent of cancel_verified_at, which only a successful read-back advances.
ALTER TABLE billing_subscriptions ADD COLUMN cancel_sync_attempt_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN cancel_sync_next_at INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN cancel_sync_failures INTEGER NOT NULL DEFAULT 0;

-- Astra JOURNEY-BCORE-1 #2: the end date an in-app cancellation promised (the paid period's end when the customer pressed Cancel plan or Delete
-- my Cloud), frozen with the intent (IN_APP_CANCEL_INTENT_SQL) and never moved by a later renewal; a new intent after a Keep freezes it again.
ALTER TABLE billing_subscriptions ADD COLUMN cancel_promised_end INTEGER;

-- Astra INTEGRATED-2 #2/#5: THE Stripe-end checkpoint of a subscription: the id of the subscription Stripe itself showed ENDED (a DELETE answer
-- or a read-back with status canceled / incomplete_expired, a 404, or the customer.subscription.deleted webhook). Never written from a local
-- status: a local canceled / disputed ends the SERVICE only. Every reader of "Stripe confirmed the end" (planEndState, noFurtherCharge, a
-- withdrawal's or refund's plan end, coverage reconciliation, a deletion's retirement) reads this (subscription-gateway.ts stripeEndConfirmed).
-- Holding the id (not a flag) means a replacement subscription on the same row is never taken as ended. Rows already ended with no end still
-- owed (no open refund operation or coverage end, not parked, not disputed) are backfilled; anything else waits for its own retry to confirm.
ALTER TABLE billing_subscriptions ADD COLUMN stripe_end_confirmed TEXT;
UPDATE billing_subscriptions SET stripe_end_confirmed=subscription_id WHERE subscription_id IS NOT NULL AND status IN ('canceled','incomplete_expired')
  AND NOT EXISTS (SELECT 1 FROM refund_ops o WHERE o.done_at IS NULL AND o.canceled_at IS NULL
    AND ((o.end_plan=1 AND o.subscription_id=billing_subscriptions.subscription_id) OR o.cancel_subscription_id=billing_subscriptions.subscription_id))
  AND NOT EXISTS (SELECT 1 FROM refund_coverage w WHERE w.subscription_id=billing_subscriptions.subscription_id AND w.end_plan=1 AND w.ended_at IS NULL);

-- Astra JOURNEY-BCORE-2 #1/#5/#7, JOURNEY-BCORE-3 #1/#2: EVERY cancellation (Cancel plan, Delete my Cloud, a public declaration) gets its OWN
-- generation-bound resolution obligation, written in the SAME fenced batch as the cancellation itself. One row per cancellation (subscription,
-- generation), never one per subscription: a public cancellation and an in-app Delete of the same plan each keep their own obligation, so
-- holding, timing out or keeping one never stalls or withdraws the other's enforcement; the earliest actionable promise is recomputed from the
-- standing rows whenever they are read. A new generation of the SAME owner (a public request whose end moved) withdraws that owner's older open
-- rows in the same batch. generation: 'in_app:<customer_cancel_at>' (the episode's stamp, set when Cancel plan is pressed and cleared by Keep) or
-- 'public:<cancellation_requests.id>:<effective_at>'. promised_end_at is frozen at cancel time and never moved by a renewal (or by a later Stripe
-- period: the resolver has its own date guard). A Keep sets state='withdrawn' for its generation in the SAME batch that clears the cancellation,
-- and the sweep acts only while the generation is still current, under the home's lease, and only once the clock (re-read under the lease right
-- before the destructive call) has reached promised_end_at - 5 s (Stripe timestamps are whole seconds): then the NORMAL cancel ends the
-- subscription (DELETE, the call every end-now cancellation makes). Launch version: if Stripe refuses it because a subscription schedule is
-- attached, NO further write is made for that subscription: the row is parked (schedule_id set, last_error 'cancel.schedule_attached', one
-- deduplicated ops alert with the subscription, the promised end and the refusal) until an operator releases or cancels the schedule by hand in
-- the Stripe dashboard; later passes only read the subscription and make the normal cancel again once no schedule is attached.
-- state: open (due at the boundary), resolved (Stripe shows the subscription ended), withdrawn (kept, replaced). 'terminated' is a legacy
-- synonym of resolved. Charges after the promise are recorded apart (cancel_late_refunds), also after resolution. Repeated failures alert
-- (cancel.resolution_unresolved after 3 attempts).
CREATE TABLE cancel_resolutions (
  subscription_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  source TEXT NOT NULL,
  generation TEXT NOT NULL,
  promised_end_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  schedule_id TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_error TEXT,
  ended_at INTEGER,
  late_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (subscription_id, generation)
);
CREATE INDEX cancel_resolutions_due ON cancel_resolutions (state, next_attempt_at);

-- Astra JOURNEY-BCORE-3 #3: every provider call a resolution makes (the normal cancel: DELETE of the subscription) is journaled
-- BEFORE it is sent, under its idempotency key. The key is kept while the attempt's outcome is unresolved (no answer, a 5xx answered for the
-- first time, 429, in flight); it is rotated (seq+1) only after an AUTHORITATIVE failure: Stripe's answer was a refusal (4xx) or a cached failure
-- replayed (Idempotent-Replayed 5xx), AND a live read right after shows the state unchanged. state: unresolved, failed (authoritative), done.
CREATE TABLE cancel_resolution_attempts (
  subscription_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  seq INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'unresolved',
  sends INTEGER NOT NULL DEFAULT 0,
  first_sent_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  answered_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (subscription_id, generation, action, target, seq)
);

-- Astra JOURNEY-BCORE-3 #5-#8: a charge on a subscription with a promised end (cancel-charges.ts). RECORD ONLY, and WITHOUT an amount: the
-- control plane never computes what is refunded for a post-promise charge. ONE record per invoice paid on such a subscription (the invoice.paid
-- webhook, or the durable backfill that tracks every invoice by id and continues after the resolution), carrying the invoice, the promise and
-- the full line snapshot (all pages; each line's own tax amounts, discounts and price id). `hint` (and each line's hint) says what a line looks
-- like (served usage, renewal after the end, before the end, one-off); it is never an amount. An operator executes the record by its id with the
-- amount they decide (POST /v1/admin/cancellations/late-refunds/{id}/execute {amountCents}), which opens the ledger refund (refund_ops kind
-- cancellation_late) like the first-month refund requests; ops are alerted (cancel.late_renewal_charge). request_id: the public declaration
-- whose end it was recorded against (its customer is told when the refund is executed).
CREATE TABLE cancel_late_refunds (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL UNIQUE,
  payment_intent TEXT,
  paid_cents INTEGER NOT NULL,
  currency TEXT,
  promised_end_at INTEGER NOT NULL,
  hint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  executed_cents INTEGER,
  refund_op_id TEXT
);

-- Astra JOURNEY-BCORE-3 #8: every invoice of a subscription with a promised end, tracked BY ID from the first time it is seen (webhook or any
-- listing) until it is final (paid and recorded or judged, void, uncollectible): an invoice that is not final yet is read again by its id on
-- every backfill, so one that settles between two listings is never lost. status: Stripe's status when last read.
CREATE TABLE cancel_invoice_checks (
  subscription_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  status TEXT,
  first_seen_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, invoice_id)
);
