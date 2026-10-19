// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra JOURNEY-BCORE-6 #1: THE one gateway for every Stripe subscription write the control plane makes (end now, cancel_at_period_end,
// cancel_at, pause collection, the upgrade's price change). No other file calls the raw StripeClient subscription mutations
// (test/subscription-gateway.test.ts scans src/ for them). The gateway reads the PARKED predicate under the home lease the caller holds, right
// before the call: a parked subscription gets NO write (the launch rule: an attached schedule is ops-only) and the caller is answered
// { parked: true }. The caller's own durable row (a journaled mutation, a refund operation, a stored Stripe event, a cancellation
// resolution) stays pending; the resolver's hourly read-only inspection is the only thing that clears parking (unparkQs), and it nudges that
// pending work to run again at once.
import type { StripeClient } from "./b5-stripe";
import { fence, q, type HomeLease, type Q } from "./billing-lease";

/** Astra JOURNEY-BCORE-4 #1/#4, JOURNEY-BCORE-5: THE parked predicate. A subscription is PARKED iff a resolution row of it, in ANY state,
 *  carries schedule_id: the schedule that refused the normal cancel, written the moment Stripe refused (before any read-back), on a carrier row
 *  when the subscription has none (public-cancellation.ts parkOnSchedule). Nothing clears it but the resolver's hourly READ-ONLY inspection
 *  seeing the schedule gone (or the subscription ended): never a Keep, a new Cancel, a withdrawn or re-opened resolution. While parked, no
 *  automatic path writes to Stripe for it: every write goes through writeSubscription, which refuses. A Keep still commits its local
 *  reversal. `parkedSql` is the same predicate as SQL. */
export const parkedSql = (subExpr: string) => `EXISTS (SELECT 1 FROM cancel_resolutions pk WHERE pk.subscription_id=${subExpr} AND pk.schedule_id IS NOT NULL)`;
export const scheduleParked = async (env: Env, subscriptionId: string): Promise<boolean> =>
  (await env.DB.prepare(`SELECT ${parkedSql("?")} AS x`).bind(subscriptionId).first<{ x: number }>())?.x === 1;

/** Astra INTEGRATED-2 #2/#5, THE Stripe-end checkpoint (billing_subscriptions.stripe_end_confirmed, migration 0096): the subscription id Stripe
 *  itself showed ENDED. Written ONLY from Stripe's terminal evidence (stripeEndedQ: cancelConfirmed's confirmed DELETE or read-back, a 404,
 *  markEndedQ's live read, syncCancellation's read-back, the customer.subscription.deleted webhook, an update read showing it canceled), never
 *  from a local status write. Every place that says "Stripe confirmed the end" reads it (stripeEndConfirmedSql / stripeEndConfirmed): until it
 *  is set the end stays owed and its owner retries it through this gateway. */
export const stripeEndConfirmedSql = (b: string) => `(${b}.stripe_end_confirmed IS NOT NULL AND ${b}.stripe_end_confirmed=${b}.subscription_id)`;
export const stripeEndConfirmed = async (env: Env, subscriptionId: string | null): Promise<boolean> => subscriptionId !== null
  && (await env.DB.prepare(`SELECT 1 AS x FROM billing_subscriptions b WHERE b.subscription_id=? AND ${stripeEndConfirmedSql("b")}`).bind(subscriptionId).first()) !== null;
/** RULE B: a home whose customer asked to delete it (a delete hold, not cancelled) is not retired while its plan's end is owed: a subscription
 *  neither ended at Stripe (THE checkpoint) nor confirmed ending by Stripe's read-back of the in-app intent (cancel_at_period_end, no revision
 *  waiting). Astra INTEGRATED-3 #2: the scheduled-end exception holds only while the subscription is NOT parked (planEndState's rule): a
 *  parked subscription may still renew whatever its cached flag says, so its home waits for THE checkpoint. SQL over `cloud_homes.id`. */
export const DELETION_BILLING_OPEN_SQL = `(EXISTS (SELECT 1 FROM cloud_recovery_holds dh WHERE dh.home_id=cloud_homes.id AND dh.action='delete' AND dh.canceled_at IS NULL)
  AND EXISTS (SELECT 1 FROM billing_subscriptions db WHERE db.home_id=cloud_homes.id AND db.subscription_id IS NOT NULL
  AND NOT ${stripeEndConfirmedSql("db")} AND NOT (db.cancel_at_period_end=1 AND db.cancel_intent_rev=db.cancel_synced_rev AND db.status NOT IN ('canceled','disputed')
    AND NOT ${parkedSql("db.subscription_id")})))`;
/** The checkpoint's one writer (run fenced, under the home's lease, only on Stripe's terminal evidence for `subscriptionId`). */
export const STRIPE_ENDED_SET = "stripe_end_confirmed=subscription_id";
/** The same, from the status Stripe answered in a read (bind: that status): set only when it shows the subscription ended. */
export const STRIPE_ENDED_ON_STATUS = "stripe_end_confirmed=CASE WHEN ? IN ('canceled','incomplete_expired') THEN subscription_id ELSE stripe_end_confirmed END";
export const stripeEndedQ = (subscriptionId: string): Q =>
  q(`UPDATE billing_subscriptions SET ${STRIPE_ENDED_SET} WHERE subscription_id=? AND stripe_end_confirmed IS NOT subscription_id`, subscriptionId);

/** The error code a caller records when the gateway refused a write because the subscription is parked (refund_ops.last_error,
 *  stripe_events.error): the work stays pending and unparkQs makes it due again the moment parking clears. */
export const PARKED_CODE = "subscription_parked";
/** Astra JOURNEY-BCORE-7 #4: the recorded code carries the parked subscription's identity (`subscription_parked:<id>`), so clearing ONE
 *  subscription wakes only the work held back on it. */
export const parkedCodeOf = (subscriptionId: string): string => `${PARKED_CODE}:${subscriptionId}`;
/** Thrown by a caller whose step cannot finish without the write (cancelConfirmed): its checkpoint stays open, nothing is lost. Its message
 *  is the identity-carrying code (parkedCodeOf), which the event and refund bookkeeping record as their error. */
export class SubscriptionParked extends Error { constructor(readonly subscriptionId: string) { super(parkedCodeOf(subscriptionId)); } }

type Opts = { prorate: boolean; invoiceNow: boolean };
export type SubscriptionWrite =
  /** DELETE /v1/subscriptions/:id (end now). */
  | { kind: "cancel_now"; opts?: Opts; key?: string }
  | { kind: "cancel_at_period_end"; value: boolean; key: string }
  | { kind: "cancel_at"; value: number | null; key: string }
  | { kind: "pause"; value: "keep_as_draft" | null; key: string }
  | { kind: "price"; itemId: string; priceId: string; prorationDate: number; key: string };
type Answers = {
  cancel_now: Awaited<ReturnType<StripeClient["cancelSubscription"]>>;
  cancel_at_period_end: Awaited<ReturnType<StripeClient["setCancelAtPeriodEnd"]>>;
  cancel_at: Awaited<ReturnType<StripeClient["setCancelAt"]>>;
  pause: Awaited<ReturnType<StripeClient["setPauseCollection"]>>;
  price: Awaited<ReturnType<StripeClient["changeSubscriptionPrice"]>>;
};
/** What Stripe answered for a write of kind K (callers name the answer's type without naming the raw client method). */
export type SubscriptionAnswer<K extends SubscriptionWrite["kind"]> = Answers[K];
export type GatewayResult<K extends SubscriptionWrite["kind"]> = { parked: true } | { parked: false; answer: Answers[K] };

/** Sends ONE subscription write, or none when the subscription is parked. Under the caller's home lease: the lease is fenced (a worker that
 *  lost it throws LeaseLost and writes nothing) and the parked predicate read, both immediately before the call. Stripe's errors pass through
 *  unchanged (each caller keeps its own settlement rules). */
export async function writeSubscription<W extends SubscriptionWrite>(env: Env, lease: HomeLease, stripe: StripeClient, subscriptionId: string, w: W):
  Promise<GatewayResult<W["kind"]>> {
  await fence(env, lease);
  if (await scheduleParked(env, subscriptionId)) return { parked: true };
  const x: SubscriptionWrite = w;
  const send = (): Promise<unknown> => {
    switch (x.kind) {
      case "cancel_now": return stripe.cancelSubscription(subscriptionId, x.opts, x.key);
      case "cancel_at_period_end": return stripe.setCancelAtPeriodEnd(subscriptionId, x.value, x.key);
      case "cancel_at": return stripe.setCancelAt(subscriptionId, x.value, x.key);
      case "pause": return stripe.setPauseCollection(subscriptionId, x.value, x.key);
      case "price": return stripe.changeSubscriptionPrice({ subscriptionId, itemId: x.itemId, priceId: x.priceId, prorationDate: x.prorationDate }, x.key);
      default: throw new Error("unknown_subscription_write");
    }
  };
  return { parked: false, answer: await send() as Answers[W["kind"]] };
}

/** Clears the subscription's parking (every row's schedule_id) and makes the work the gateway held back ON THIS SUBSCRIPTION due NOW: its
 *  refund operations and the stored Stripe events that stopped on it (matched by the identity in the recorded code: Astra JOURNEY-BCORE-7 #4;
 *  other subscriptions' parked work keeps its own backoff). Only the resolver's hourly read issues it: the schedule is gone, or the
 *  subscription has ended (Astra JOURNEY-BCORE-5 #1). */
export const unparkQs = (subscriptionId: string, now: number): Q[] => [
  q("UPDATE cancel_resolutions SET schedule_id=NULL WHERE subscription_id=? AND schedule_id IS NOT NULL", subscriptionId),
  q(`UPDATE refund_ops SET next_attempt_at=? WHERE done_at IS NULL AND last_error=? AND (subscription_id=? OR cancel_subscription_id=?)`, now, parkedCodeOf(subscriptionId), subscriptionId, subscriptionId),
  q("UPDATE stripe_events SET next_attempt_at=? WHERE processed_at IS NULL AND error=?", now, parkedCodeOf(subscriptionId)),
];
