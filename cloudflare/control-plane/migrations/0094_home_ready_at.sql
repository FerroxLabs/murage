-- B3 (customer journey): the 7-day first-month refund runs from the LATER of the first payment and the day the server is ready.
-- cloud_homes.ready_at: when the "your server is ready" email was queued (b3-control.ts, the first canary pass: the same batch records that
-- notice, so the date the customer is told and the date the window runs from are one timestamp). Written once, never moved.
ALTER TABLE cloud_homes ADD COLUMN ready_at INTEGER;
-- Astra JOURNEY-B-1 #7: ready_at is the moment the ready email was QUEUED (legal-flows.ts queueServerReady, in the same batch as the
-- billing_notices server_ready row), never the canary pass itself. ready_pending_at: the first canary pass (b3-control.ts), the durable
-- work item "this home's ready email is owed": the billing sweep queues it for every home with ready_pending_at set and ready_at NULL, with
-- no age cutoff, so the refund clock never starts without the email that tells the customer.
-- Astra JOURNEY-B-2 #6: the refund clock itself runs from that email's successful HANDOFF (billing_notices server_ready:<home>:first,
-- sent_at; checkout-moments.ts readyAnchorSql), not from ready_at: queued but not handed off, the window stays open.
ALTER TABLE cloud_homes ADD COLUMN ready_pending_at INTEGER;
-- Homes that were already ready before this column: the moment their canary first passed (the lifecycle's outbox entry), if it is still kept.
UPDATE cloud_homes SET ready_at=(SELECT MIN(o.created_at) FROM cloud_outbox o WHERE o.home_id=cloud_homes.id AND o.kind='canary_passed') WHERE ready_at IS NULL;
-- Astra JOURNEY-B-1 #9: ready_legacy=1 is the persistent evidence that a home was ready before ready_at existed but no date is kept (it keeps
-- the payment-based window). Written ONCE, here, from the evidence there is now (the home is or was observed ready); never derived later
-- from the mutable lifecycle state. Every other home with ready_at NULL has never been ready: its window stays open (startsWhenReady) whatever
-- its state becomes (failed, stopped, deleting).
ALTER TABLE cloud_homes ADD COLUMN ready_legacy INTEGER NOT NULL DEFAULT 0;
UPDATE cloud_homes SET ready_legacy=1 WHERE ready_at IS NULL AND (desired_state IN ('ready','payment_problem','suspended') OR observed_state='ready');

-- Astra CANCEL-SUMMARY-2 #7: the moment a subscription ENDED (status became 'canceled'), written once and never moved, so the account
-- summary's endedAt (and activeUntil for an ended plan) no longer follows the mutable updated_at when a later, delayed update arrives.
-- Existing ended rows: their updated_at, the best record there is. From now on every statement that ends a subscription stamps it in the
-- same write (b5-billing.ts FORWARD_ENDED_AT and the literal 'canceled' writes; not a trigger, whose writes D1 counts in meta.changes).
ALTER TABLE billing_subscriptions ADD COLUMN ended_at INTEGER;
UPDATE billing_subscriptions SET ended_at=updated_at WHERE status='canceled' AND ended_at IS NULL;

-- Astra JOURNEY-B-3 #8: when the billing sweep last tried to finish a plan move still owed to Flux (flux_plan_dirty) for this row. The sweep
-- picks the least recently tried rows first and stamps each before it checks it, so rows without usable invoice evidence never starve one
-- that has it.
ALTER TABLE billing_subscriptions ADD COLUMN flux_plan_attempt_at INTEGER;
