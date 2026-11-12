// SPDX-License-Identifier: AGPL-3.0-or-later
import { StripeError, type StripeClient } from "./b5-stripe";
import type { CapRaise } from "./b4-flux";
import { readGrantEligibility } from "./flux-grants";
import { fluxRecipientOf } from "./flux-link";
// Cloud auto top-up charging. The owner's saved authorization (topup_settings) is the mandate; this module is the only thing that spends it.
// Single flight: one OPEN attempt per home (unique partial index, migration 0136), claimed together with the monthly cap reservation in ONE batch,
// so concurrent sweeps charge once and a retry of a lost response resumes the same attempt under the same Stripe idempotency keys.

// ITEM 9 guard: decided in held-until-item9-highs.ts (off while HELD_UNTIL_ITEM9_HIGHS, whatever the env says).
import { topupChargingEnabled, topupOffered } from "./held-until-item9-highs";
export { topupChargingEnabled };
/** After a paid attempt the sweep waits this long: Flux balance freshness is unconfirmed, so a stale read must not buy twice. */
export const TOPUP_COOLDOWN_MS = 10 * 60_000;
/** An open attempt not advanced for this long is resumed (same keys) by the sweep. */
export const TOPUP_RESUME_AFTER_MS = 2 * 60_000;
export const TOPUP_MAX_DECLINES = 3;

/** UTC month key; the owner's monthly cap resets at 00:00 UTC on the first. */
export const topupMonthKey = (now: number): string => new Date(now).toISOString().slice(0, 7);

export interface TopupSettings { home_id: string; enabled: number; amount_cents: number; threshold_cents: number; cap_cents: number; revision: number; applied_revision: number | null; consent_id: string | null }
export interface TopupAttempt {
  attempt_id: string; home_id: string; settings_revision: number; amount_cents: number; month_key: string; state: string;
  invoice_id: string | null; tax_cents: number | null; error: string | null; claimed_at: number; updated_at: number; paid_at: number | null; granted_at: number | null;
  pay_started_at: number | null; checked_at: number | null;
}
export type ClaimResult = { claimed: true; attempt: TopupAttempt } | { claimed: false; reason: "off" | "revision" | "open" | "cap" | "paused" | "cooldown" | "backoff" | "held" };

/**
 * Claim one attempt and reserve its amount against the monthly cap, atomically. Fenced on the settings row (enabled, applied, revision) in the
 * same statements, so a change after the sweep read the row claims nothing. The reservation upsert tags last_attempt; the attempt insert fires
 * only when that tag is its own, so a refused reservation (cap) inserts nothing, and an open attempt aborts the whole batch (index).
 */
export async function claimTopupAttempt(env: Env, s: TopupSettings, now: number, attemptId: string = crypto.randomUUID()): Promise<ClaimResult> {
  // ITEM 9 guard (GrokBuild Low): refused here too while HELD_UNTIL_ITEM9_HIGHS, whatever the caller checked: no reservation, no attempt row.
  if (!topupOffered()) return { claimed: false, reason: "held" };
  const month = topupMonthKey(now);
  const st = await env.DB.prepare("SELECT paused_at, last_paid_at, retry_after FROM topup_state WHERE home_id=?").bind(s.home_id).first<{ paused_at: number | null; last_paid_at: number | null; retry_after: number | null }>();
  if (st?.paused_at != null) return { claimed: false, reason: "paused" };
  if (st?.retry_after != null && st.retry_after > now) return { claimed: false, reason: "backoff" };
  if (st?.last_paid_at != null && now - st.last_paid_at < TOPUP_COOLDOWN_MS) return { claimed: false, reason: "cooldown" };
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO topup_month (home_id, month_key, reserved_cents, last_attempt)
        SELECT ?1, ?2, ?3, ?4 WHERE ?3 <= ?5
          AND EXISTS (SELECT 1 FROM topup_settings WHERE home_id=?1 AND enabled=1 AND revision=?6 AND applied_revision=revision)
          AND NOT EXISTS (SELECT 1 FROM topup_attempts WHERE home_id=?1 AND state IN ('claimed','invoiced','paid'))
        ON CONFLICT (home_id, month_key) DO UPDATE SET reserved_cents = reserved_cents + excluded.reserved_cents, last_attempt = excluded.last_attempt
          WHERE reserved_cents + excluded.reserved_cents <= ?5`)
        .bind(s.home_id, month, s.amount_cents, attemptId, s.cap_cents, s.revision),
      env.DB.prepare(`INSERT INTO topup_attempts (attempt_id, home_id, settings_revision, amount_cents, month_key, state, claimed_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, 'claimed', ?6, ?6 WHERE EXISTS (SELECT 1 FROM topup_month WHERE home_id=?2 AND month_key=?5 AND last_attempt=?1)`)
        .bind(attemptId, s.home_id, s.revision, s.amount_cents, month, now),
    ]);
  } catch {
    return { claimed: false, reason: "open" }; // the one-open-attempt index refused the insert; the batch rolled back
  }
  const attempt = await env.DB.prepare("SELECT * FROM topup_attempts WHERE attempt_id=?").bind(attemptId).first<TopupAttempt>();
  if (attempt) return { claimed: true, attempt };
  const cur = await env.DB.prepare("SELECT 1 AS x FROM topup_settings WHERE home_id=? AND enabled=1 AND revision=? AND applied_revision=revision").bind(s.home_id, s.revision).first();
  if (!cur) return { claimed: false, reason: s.revision ? "revision" : "off" };
  const open = await env.DB.prepare("SELECT 1 AS x FROM topup_attempts WHERE home_id=? AND state IN ('claimed','invoiced','paid')").bind(s.home_id).first();
  return { claimed: false, reason: open ? "open" : "cap" };
}

/** Move an open attempt to a closing state and give back its reservation when no money was taken. Idempotent: only an open attempt moves. */
export async function closeTopupAttempt(env: Env, a: TopupAttempt, state: "declined" | "action_required" | "abandoned", error: string | null, now: number): Promise<boolean> {
  // Release first, while the attempt is still open, then close it: both in one batch, so a repeat releases nothing.
  const [, moved] = await env.DB.batch([
    // The month is read from the row, not from the caller's copy: the reservation moves to the charge month right before payment.
    env.DB.prepare(`UPDATE topup_month SET reserved_cents = MAX(0, reserved_cents - ?1) WHERE home_id=?2
      AND month_key=(SELECT month_key FROM topup_attempts WHERE attempt_id=?3 AND state IN ('claimed','invoiced'))`).bind(a.amount_cents, a.home_id, a.attempt_id),
    env.DB.prepare("UPDATE topup_attempts SET state=?, error=?, updated_at=? WHERE attempt_id=? AND state IN ('claimed','invoiced')").bind(state, error, now, a.attempt_id),
  ]);
  return (moved.meta.changes ?? 0) > 0;
}

// ---- The charge -------------------------------------------------------------------------------------------------------------------------


export type TopupNotice = "topup_declined" | "topup_action_needed" | "topup_cap_reached" | "topup_address_needed" | "topup_ineligible";
export interface TopupDeps {
  stripe: StripeClient;
  /** A home sold through Link (Managed Payments) is never charged by us. */
  isLink(homeId: string): Promise<boolean>;
  /** Queue the owner's notice. `lease` is the home lease the caller holds; the notice must be queued under it (the sweep passes it). */
  notify(kind: TopupNotice, homeId: string, key: string, lease?: unknown): Promise<void>;
  /** The wall clock. The cap month is read from it right before the first pay call (tests inject it); defaults to Date.now. */
  clock?: () => number;
  /** Stripe Tax product tax code for the top-up line, when configured. */
  taxCode?: string | null;
  /** Replaces topupPrecheck (tests, and the exact Flux call when it exists). */
  precheck?: (env: Env, a: TopupAttempt) => Promise<TopupPrecheck>;
  /** The fetcher the default precheck sends its Flux reads through (tests). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}
/** `kind`: "ineligible" (Flux says the account cannot take credit), "refused" (Flux answered 400) or "transient" (nothing learned: retried on the normal cadence). */
export type TopupPrecheck = { allow: true } | { allow: false; kind: "ineligible" | "refused" | "transient"; reason: string };
/**
 * THE PRECHECK. Run before any Stripe call, on every attempt: Flux is asked whether a grant to this home's Flux account would be accepted
 * (readGrantEligibility). Only 200 with eligible exactly true allows the charge; capability absent, a timeout, a 5xx, malformed JSON, a network
 * error, an unlinked home, Flux off: nothing is charged. It is a prediction: a grant refused after a charge is still handled by the grant path.
 */
export async function topupPrecheck(env: Env, a: TopupAttempt, doFetch?: TopupDeps["fetch"]): Promise<TopupPrecheck> {
  let accountId: string | null = null;
  try { accountId = await fluxRecipientOf(env, a.home_id); } catch { /* read as unlinked */ }
  if (accountId === null) return { allow: false, kind: "transient", reason: "unlinked" };
  const e = await readGrantEligibility(env, accountId, doFetch);
  if (e.r === "eligible") return { allow: true };
  if (e.r === "ineligible") return { allow: false, kind: "ineligible", reason: e.reason };
  if (e.r === "refused") return { allow: false, kind: "refused", reason: "refused" };
  return { allow: false, kind: "transient", reason: e.why };
}
const DAY_MS = 86_400_000;
/** An ineligible account is not paused: it is looked at again in 24 hours. The owner hears once per episode (the stable key names the problem
 *  and the last paid charge, like the tax notice), and ONE digest alert per episode says nothing was charged (no refund is owed). */
async function ineligibleHold(env: Env, d: TopupDeps, a: TopupAttempt, reason: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO topup_state (home_id, retry_after) VALUES (?1, ?2)
    ON CONFLICT (home_id) DO UPDATE SET retry_after=excluded.retry_after`).bind(a.home_id, now + DAY_MS).run();
  const ep = (await env.DB.prepare("SELECT last_paid_at AS t FROM topup_state WHERE home_id=?").bind(a.home_id).first<{ t: number | null }>())?.t ?? 0;
  await precheckAlert(env, a, "topup.flux_ineligible", `alert:topup-precheck:ineligible:${a.home_id}:${ep}`, reason, now);
  const seen = await env.DB.prepare("SELECT 1 AS x FROM topup_state WHERE home_id=?1 AND notified_reason IS ?2").bind(a.home_id, `precheck_${reason}`).first();
  if (seen) return;
  try {
    await d.notify("topup_ineligible", a.home_id, `address:${reason}:${ep}`);
    await env.DB.prepare("UPDATE topup_state SET notified_reason=?2 WHERE home_id=?1").bind(a.home_id, `precheck_${reason}`).run();
  } catch { /* no marker written: the next look in 24 hours sends it again (the key keeps it one notice) */ }
}
async function precheckAlert(env: Env, a: TopupAttempt, kind: string, id: string, reason: string, now: number): Promise<void> {
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(id, a.home_id, kind, "high", JSON.stringify({ attemptId: a.attempt_id, reason, charged: false }), now).run();
}
export type ChargeOutcome = "paid" | "declined" | "action_required" | "abandoned" | "retry";

const key = (a: TopupAttempt, step: string) => `topup:${a.attempt_id}:${step}`;
const isStripe = (e: unknown): e is StripeError => e instanceof StripeError;
/** A refusal that proves nothing was created or charged; anything else (network, 5xx, in flight) is indeterminate and resumed under the same keys. */
const definite = (e: StripeError): boolean => e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429;

async function setState(env: Env, a: TopupAttempt, from: string[], to: string, now: number, extra: { invoice?: string } = {}): Promise<void> {
  await env.DB.prepare(`UPDATE topup_attempts SET state=?, updated_at=?, invoice_id=COALESCE(?, invoice_id) WHERE attempt_id=? AND state IN (${from.map(() => "?").join(",")})`)
    .bind(to, now, extra.invoice ?? null, a.attempt_id, ...from).run();
}
/** A pause stays until the owner acts: a different card seen by the sweep (recoverPaused), or top-up switched off and on (saveTopup). The method
 *  that failed is kept so "a different card" can be told. */
async function pause(env: Env, homeId: string, reason: string, now: number, method: string | null): Promise<void> {
  await env.DB.prepare(`INSERT INTO topup_state (home_id, paused_at, pause_reason, paused_method) VALUES (?,?,?,?)
    ON CONFLICT (home_id) DO UPDATE SET paused_at=excluded.paused_at, pause_reason=excluded.pause_reason, paused_method=excluded.paused_method, recheck_at=NULL, notified_reason=NULL`).bind(homeId, now, reason, method).run();
}
/** The notice of a pause. The marker (notified_reason) is written only AFTER the notice was queued, so a notice that failed leaves the pause
 *  unmarked and the sweep (renoticePaused) sends it again; the notice id is derived from the pause time, so a repeat is one notice. */
const pauseNotice = (reason: string): TopupNotice => (reason === "declined" ? "topup_declined" : "topup_action_needed");
async function noticePause(env: Env, d: TopupDeps, homeId: string, reason: string, pausedAt: number): Promise<void> {
  try {
    await d.notify(pauseNotice(reason), homeId, `paused:${pausedAt}`);
    await env.DB.prepare("UPDATE topup_state SET notified_reason=?2 WHERE home_id=?1 AND paused_at=?3 AND pause_reason=?2").bind(homeId, reason, pausedAt).run();
  } catch { /* the home is paused either way; the next sweep sends the notice again */ }
}
/** The attempt reached Stripe's "paid": record it, start the cooldown and clear any backoff. Only an open, unpaid attempt moves. */
async function markPaid(env: Env, a: TopupAttempt, tax: number | null | undefined, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE topup_attempts SET state='paid', paid_at=?, updated_at=?, tax_cents=? WHERE attempt_id=? AND state IN ('claimed','invoiced')").bind(now, now, tax ?? null, a.attempt_id),
    env.DB.prepare(`INSERT INTO topup_state (home_id, last_paid_at, declines) VALUES (?,?,0)
      ON CONFLICT (home_id) DO UPDATE SET last_paid_at=excluded.last_paid_at, declines=0, retry_after=NULL, retry_fails=0, notified_reason=NULL`).bind(a.home_id, now),
  ]);
}
/** What became of an invoice we are about to give up on. "paid": the money was taken (the response was lost, or it was paid at finalize), so the
 *  attempt goes on to its grant. "closed": void or draft, nothing can be charged. An uncollectible invoice is still payable (Stripe allows paying
 *  it and voiding it), so it is voided like an open one and only a void that took effect closes it. "unknown": Stripe could not be read or the
 *  void did not take; the attempt stays open and is resumed. */
async function settleInvoice(d: TopupDeps, a: TopupAttempt, invoice: string): Promise<{ r: "paid"; tax: number | null } | { r: "closed" } | { r: "unknown" }> {
  const read = async () => {
    const cur = await d.stripe.getInvoice(invoice);
    if (cur.status === "paid") return { r: "paid" as const, tax: (cur as { tax?: number | null }).tax ?? null };
    if (cur.status !== "open" && cur.status !== "uncollectible") return { r: "closed" as const };
    return null;
  };
  try {
    const first = await read();
    if (first) return first;
    try { await d.stripe.voidInvoice(invoice, key(a, "void")); return { r: "closed" }; } catch { /* a payment racing the void: read again below */ }
    return (await read()) ?? { r: "unknown" };
  } catch { return { r: "unknown" }; }
}
/** Tax or address trouble that only the passage of time or the owner can fix: back off (1 h, 2 h, 4 h ... up to a day) so the sweep does not make
 *  a new invoice every pass, and tell the owner once per reason. */
async function backoff(env: Env, d: TopupDeps, a: TopupAttempt, reason: string, now: number, tell: boolean): Promise<void> {
  await env.DB.prepare(`INSERT INTO topup_state (home_id, retry_after, retry_fails) VALUES (?1, ?2 + 3600000, 1)
    ON CONFLICT (home_id) DO UPDATE SET retry_fails = retry_fails + 1, retry_after = ?2 + MIN(86400000, 3600000 * (1 << MIN(retry_fails, 5)))`).bind(a.home_id, now).run();
  if (!tell) return;
  // One notice per reason: queued first, marked after. A notice that could not be queued leaves no marker, so the next backoff sends it.
  const seen = await env.DB.prepare("SELECT 1 AS x FROM topup_state WHERE home_id=?1 AND notified_reason IS ?2").bind(a.home_id, reason).first();
  if (seen) return;
  try {
    // The key names the problem, not the attempt: every attempt of one episode (since the last paid charge) carries the same key, so a notice that
    // went out but whose marker was lost is not sent twice. A paid charge ends the episode and the next trouble is a new notice.
    const ep = await env.DB.prepare("SELECT last_paid_at AS t FROM topup_state WHERE home_id=?").bind(a.home_id).first<{ t: number | null }>();
    await d.notify("topup_address_needed", a.home_id, `address:${reason}:${ep?.t ?? 0}`);
    await env.DB.prepare("UPDATE topup_state SET notified_reason=?2 WHERE home_id=?1").bind(a.home_id, reason).run();
  } catch { /* no marker written: tried again at the next backoff */ }
}
/** Make the cap month the month the charge lands in. The reservation was made in the claim month; right before the FIRST money movement (the
 *  finalize call, which may settle the invoice from credit balance, or the pay call) it moves to the current UTC month, and only if that month
 *  can hold it. pay_started_at then freezes it: a retry after midnight of a response lost before it never moves the reservation again. */
async function fixPayMonth(env: Env, a: TopupAttempt, now: number): Promise<"ok" | "cap" | "gone" | "rolled"> {
  const cur = await env.DB.prepare("SELECT month_key, pay_started_at, state FROM topup_attempts WHERE attempt_id=?").bind(a.attempt_id).first<{ month_key: string; pay_started_at: number | null; state: string }>();
  if (!cur || (cur.state !== "claimed" && cur.state !== "invoiced")) return "gone";
  // The stamp is written BEFORE the pay call, so a restart in between leaves it set with no call sent. A resume in the same UTC month is the same
  // charge month. A resume in a later month cannot tell "sent" from "not sent": the caller reads the invoice (paid counts in the stamp month, open is
  // voided and the attempt starts over in the new month), so a charge never lands in a month that holds no reservation of it.
  if (cur.pay_started_at != null) return topupMonthKey(cur.pay_started_at) === topupMonthKey(now) ? "ok" : "rolled";
  const month = topupMonthKey(now);
  if (cur.month_key === month) {
    await env.DB.prepare("UPDATE topup_attempts SET pay_started_at=? WHERE attempt_id=? AND pay_started_at IS NULL").bind(now, a.attempt_id).run();
    return "ok";
  }
  const cap = `(SELECT cap_cents FROM topup_settings WHERE home_id=?1)`;
  const open = `EXISTS (SELECT 1 FROM topup_attempts WHERE attempt_id=?4 AND state IN ('claimed','invoiced') AND pay_started_at IS NULL)`;
  const tagged = `EXISTS (SELECT 1 FROM topup_month WHERE home_id=?1 AND month_key=?2 AND last_attempt=?4)`;
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO topup_month (home_id, month_key, reserved_cents, last_attempt) SELECT ?1, ?2, ?3, ?4 WHERE ?3 <= ${cap} AND ${open}
      ON CONFLICT (home_id, month_key) DO UPDATE SET reserved_cents = reserved_cents + excluded.reserved_cents, last_attempt = excluded.last_attempt
        WHERE reserved_cents + excluded.reserved_cents <= ${cap}`).bind(a.home_id, month, a.amount_cents, a.attempt_id),
    env.DB.prepare(`UPDATE topup_month SET reserved_cents = MAX(0, reserved_cents - ?3) WHERE home_id=?1 AND month_key=?5 AND ${tagged} AND ${open}`)
      .bind(a.home_id, month, a.amount_cents, a.attempt_id, cur.month_key),
    env.DB.prepare(`UPDATE topup_attempts SET month_key=?2, pay_started_at=?5, updated_at=?5 WHERE attempt_id=?4 AND home_id=?1 AND state IN ('claimed','invoiced') AND pay_started_at IS NULL AND ${tagged}`)
      .bind(a.home_id, month, a.amount_cents, a.attempt_id, now),
  ]);
  return (res[2]!.meta.changes ?? 0) > 0 ? "ok" : "cap";
}

/**
 * Run one claimed attempt as far as it goes. Every Stripe call carries a key derived from the attempt, so a retry after a lost response
 * replays the same objects and the card is charged once. The settings revision is re-read before the charge: a change stops the attempt and
 * voids the invoice. Tax is Stripe Tax on the invoice; when it is not complete the invoice is voided and nothing is charged.
 */
export async function runTopupAttempt(env: Env, d: TopupDeps, a: TopupAttempt, now: number): Promise<ChargeOutcome> {
  // Give up on the attempt. An invoice is read first: if Stripe took the money (the response was lost, or the owner changed the settings after
  // the charge), the attempt is NOT abandoned, it goes on to its grant. If Stripe cannot be read or the void did not take, it stays open.
  // `after` runs only once the attempt really closed, so a repeated resume never repeats a notice or a pause.
  const stop = async (state: "declined" | "action_required" | "abandoned", why: string, invoice: string | null, after?: () => Promise<void>): Promise<ChargeOutcome> => {
    if (invoice) {
      const settled = await settleInvoice(d, a, invoice);
      if (settled.r === "paid") { await markPaid(env, a, settled.tax, now); return "paid"; }
      if (settled.r === "unknown") return "retry";
    }
    if (await closeTopupAttempt(env, a, state, why, now) && after) await after();
    return state;
  };
  const current = async () => env.DB.prepare("SELECT 1 AS x FROM topup_settings WHERE home_id=? AND enabled=1 AND revision=? AND applied_revision=revision").bind(a.home_id, a.settings_revision).first();
  // The home's own state, read right before money moves on every path (a fresh claim and a resumed attempt alike): an owner stop, spending off or a
  // billing hold that came after the claim ends the attempt.
  const homeOpen = async () => env.DB.prepare("SELECT 1 AS x FROM flux_home_keys WHERE home_id=? AND state='active' AND spending_off=0 AND billing_hold=0").bind(a.home_id).first();
  if (!(await current())) return stop("abandoned", "revision_changed", a.invoice_id);
  if (!(await homeOpen())) return stop("abandoned", "home_state", a.invoice_id);
  if (await d.isLink(a.home_id)) return stop("abandoned", "link_buyer", a.invoice_id);
  const sub = await env.DB.prepare("SELECT customer_id, subscription_id FROM billing_subscriptions WHERE home_id=? AND status IN ('active','trialing')").bind(a.home_id).first<{ customer_id: string; subscription_id: string | null }>();
  if (!sub) return stop("abandoned", "no_subscription", a.invoice_id);
  let invId: string | null = a.invoice_id; // the invoice this run knows of, for the catch below
  // A fresh clock read each time: the month of the money movement is the UTC month of this call, not of the sweep's start.
  const pinMonth = () => fixPayMonth(env, a, (d.clock ?? Date.now)());
  try {
    const cust = await d.stripe.customerTaxState(sub.customer_id);
    if (cust.deleted || !cust.country) return stop("abandoned", "no_tax_address", a.invoice_id, () => backoff(env, d, a, "tax", now, true));
    // The live subscription decides, not our copy: a cancellation Stripe knows and the webhook has not yet brought to D1 must stop the charge.
    let subPm: string | null = null;
    if (sub.subscription_id) {
      const live = await d.stripe.getSubscription(sub.subscription_id);
      if (live.status !== "active" && live.status !== "trialing") return stop("abandoned", `subscription_${live.status ?? "unknown"}`.slice(0, 80), a.invoice_id, () => backoff(env, d, a, "subscription", now, false));
      subPm = live.default_payment_method ?? null;
    } else if (!cust.liveSubscription) return stop("abandoned", "no_live_subscription", a.invoice_id, () => backoff(env, d, a, "subscription", now, false));
    // The mandate is "I authorize Ferrox Labs, LLC to charge my payment method" (legal-flows.ts WORDING.topupCharge): the customer's saved payment
    // method as it stands now, not one named card. The subscription's current default is that method (it follows a card update); the customer
    // default is the fallback when Stripe names none on the subscription.
    const method = subPm ?? cust.defaultPaymentMethod;
    if (!method) return stop("action_required", "no_payment_method", a.invoice_id, async () => { await pause(env, a.home_id, "no_payment_method", now, null); await noticePause(env, d, a.home_id, "no_payment_method", now); });
    const pre = await (d.precheck ?? ((e, x) => topupPrecheck(e, x, d.fetch)))(env, a);
    if (!pre.allow) {
      const why = `precheck_${pre.reason}`.slice(0, 80);
      if (pre.kind === "transient") return stop("abandoned", why, a.invoice_id); // nothing learned: no notice, no alert, the normal cadence asks again
      if (pre.kind === "refused") return stop("abandoned", why, a.invoice_id, async () => {
        await backoff(env, d, a, "precheck_refused", now, false);
        await precheckAlert(env, a, "topup.precheck_refused", `alert:topup-precheck:refused:${a.home_id}:${a.settings_revision}`, pre.reason, now);
      });
      return stop("abandoned", why, a.invoice_id, () => ineligibleHold(env, d, a, pre.reason, now));
    }
    const inv = await d.stripe.createInvoice({ customerId: sub.customer_id, attemptId: a.attempt_id }, key(a, "inv"));
    invId = inv.id;
    await setState(env, a, ["claimed", "invoiced"], "invoiced", now, { invoice: inv.id });
    await d.stripe.addInvoiceItem({ customerId: sub.customer_id, invoiceId: inv.id, amountCents: a.amount_cents, description: "Murage Cloud credit top-up", taxCode: d.taxCode }, key(a, "item"));
    // Finalize can take the money itself (Stripe applies the customer's credit balance to the invoice), so the reservation is pinned to the current
    // UTC month BEFORE it, under the cap: whichever way the invoice settles, it settled in a month that holds the reservation.
    const pinned = await pinMonth();
    if (pinned === "gone") return "retry";
    if (pinned !== "ok") return stop("abandoned", pinned === "cap" ? "month_cap" : "month_rolled", inv.id);
    const fin = await d.stripe.finalizeInvoice(inv.id, key(a, "fin"));
    if (fin.automatic_tax?.status !== "complete") return stop("abandoned", "tax_not_complete", inv.id, () => backoff(env, d, a, "tax", now, true));
    if (!(await current())) return stop("abandoned", "revision_changed", inv.id);
    if (!(await homeOpen())) return stop("abandoned", "home_state", inv.id);
    let paid = fin.status === "paid";
    if (!paid) {
      // The pin ran before finalize and holds for the pay call; this second read only catches midnight passing in between ("rolled").
      const month = await pinMonth();
      if (month === "gone") return "retry";
      if (month !== "ok") return stop("abandoned", month === "cap" ? "month_cap" : "month_rolled", inv.id);
      try {
        const res = await d.stripe.payInvoice(inv.id, key(a, "pay"), { paymentMethod: method });
        paid = res.status === "paid";
      } catch (e) {
        if (isStripe(e) && e.status === 402) {
          if (e.code === "stripe_authentication_required" || e.code === "authentication_required") {
            return stop("action_required", "authentication_required", inv.id, async () => { await pause(env, a.home_id, "authentication_required", now, method); await noticePause(env, d, a.home_id, "authentication_required", now); });
          }
          return stop("declined", (e.code || "stripe_card_declined").slice(0, 80), inv.id, async () => {
            const row = await env.DB.prepare(`INSERT INTO topup_state (home_id, declines) VALUES (?,1)
              ON CONFLICT (home_id) DO UPDATE SET declines = declines + 1 RETURNING declines`).bind(a.home_id).first<{ declines: number }>();
            if ((row?.declines ?? 0) >= TOPUP_MAX_DECLINES) { await pause(env, a.home_id, "declined", now, method); await noticePause(env, d, a.home_id, "declined", now); return; }
            try { await d.notify("topup_declined", a.home_id, a.attempt_id); } catch { /* one decline notice lost: the home is not paused and the next decline tells again */ }
          });
        }
        throw e;
      }
    }
    if (!paid) return "retry"; // open but not paid and no refusal: unknown, resumed under the same keys
    await markPaid(env, a, fin.tax, now);
    return "paid";
  } catch (e) {
    if (isStripe(e) && definite(e)) {
      // A refusal that proves nothing was charged (a tax location Stripe cannot use is a 400): void the invoice and back off, so the sweep does not
      // make a new invoice every pass. A tax refusal also tells the owner once (same notice as a missing address).
      const tax = /tax|location/i.test(`${e.code} ${e.message}`);
      return stop("abandoned", (e.code || `stripe_${e.status}`).slice(0, 80), invId, () => backoff(env, d, a, tax ? "tax" : `stripe_${e.status}`, now, tax));
    }
    return "retry";
  }
}

// ---- The sweep --------------------------------------------------------------------------------------------------------------------------

/** An open attempt this old is no longer resumed under its Stripe keys (they expire after 24 h): Stripe is asked what became of it. */
export const TOPUP_STALE_AFTER_MS = 20 * 3_600_000;
/** A paid attempt still not granted this long after the charge raises an alert (alert only: the money stays, ops decide). */
export const TOPUP_UNGRANTED_ALERT_MS = 24 * 3_600_000;
/** A paid and granted attempt whose cap raise stays unconfirmed this long is closed anyway; the cap catch-up repairs the cap. */
export const TOPUP_CAP_WAIT_MS = 60 * 60_000;
export const TOPUP_SWEEP_HOMES = 100;
/** Paused homes whose card is looked at per sweep, and how long a looked-at home waits before it is looked at again. */
export const TOPUP_RECOVER_HOMES = 25;
export const TOPUP_RECHECK_MS = 15 * 60_000;
export type CapRaiseResult = CapRaise;

export interface TopupSweepCtx<L> {
  now: number;
  deps: TopupDeps;
  /** One home's work under its billing lease; a busy home is skipped until the next sweep. */
  onHome(homeId: string, work: (lease: L) => Promise<void>): Promise<void>;
  /** The home's spendable balance in microcents from the router; null when unknown (the home is then left alone). */
  spendable(homeId: string): Promise<number | null>;
  /** Ask for the credit grant of a paid top-up invoice (grantOnce, kind topup); true when it is granted. */
  grant(lease: L, homeId: string, invoiceId: string): Promise<boolean>;
  /** Raise the home's cap to cover what it can spend. Owner caps, owner stops and spending off are never touched. */
  raiseCap(homeId: string): Promise<CapRaiseResult>;
  fence?(lease: L): Promise<void>;
  /** False while the flag is off or Flux cannot read a balance: open attempts are still settled, nothing new is claimed or charged. Default true. */
  charging?: boolean;
  /** PRODFLUX r4 A: false while Flux cannot issue (fluxReadiness(env).issue: a credential or the API base missing). Open attempts run exactly
   *  as with it true (the precheck answers transient flux_not_ready, so nothing is charged and an open invoice is voided); NO new attempt is
   *  claimed. Default true. */
  claiming?: boolean;
  /** False when a grant cannot be sent at all (Flux stubbed or its routes off): a paid attempt then raises the page alert at once. Default true. */
  canGrant?: boolean;
}

async function alertOnce(env: Env, homeId: string, kind: string, id: string, detail: Record<string, unknown>, now: number): Promise<void> {
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(id, homeId, kind, "high", JSON.stringify(detail), now).run();
}

/** A claimed or invoiced attempt past the point its keys can be replayed: paid at Stripe means the charge happened (carry on to the grant),
 *  anything else is voided and given up. A Stripe error leaves it for the next sweep. */
async function resolveStale<L>(env: Env, ctx: TopupSweepCtx<L>, a: TopupAttempt, why = "stale"): Promise<"paid" | "closed" | "later"> {
  try {
    if (a.invoice_id) {
      const inv = await ctx.deps.stripe.getInvoice(a.invoice_id);
      if (inv.status === "paid") { await markPaid(env, a, inv.tax, ctx.now); return "paid"; }
      // Abandon only after a void that took effect (or an invoice that is no longer open). A void that failed, perhaps because a payment landed
      // first, leaves the attempt open and the invoice is read again next pass; a paid one then goes to its grant.
      const settled = await settleInvoice(ctx.deps, a, a.invoice_id);
      if (settled.r === "paid") { await markPaid(env, a, settled.tax, ctx.now); return "paid"; }
      if (settled.r === "unknown") return "later";
    }
    await closeTopupAttempt(env, a, "abandoned", why, ctx.now);
    return "closed";
  } catch { return "later"; }
}

/** A paid attempt: the grant first, then the cap raise, then the attempt is done. Until the grant lands the attempt stays open, so no second charge. */
async function settlePaid<L>(env: Env, ctx: TopupSweepCtx<L>, lease: L, a: TopupAttempt): Promise<void> {
  const paidAt = a.paid_at ?? a.updated_at;
  if (!a.invoice_id) return;
  let granted = false;
  if (ctx.canGrant !== false) { try { granted = await ctx.grant(lease, a.home_id, a.invoice_id); } catch { granted = false; } }
  if (!granted) {
    const row = await env.DB.prepare("SELECT granted_at FROM credit_grants WHERE invoice_id=? AND kind='topup'").bind(a.invoice_id).first<{ granted_at: number | null }>();
    granted = row?.granted_at != null;
  }
  if (!granted) {
    // A grant that cannot be sent at all (Flux stubbed or off) will not become sendable by waiting a day: the page alert is raised now.
    if (ctx.canGrant === false || ctx.now - paidAt >= TOPUP_UNGRANTED_ALERT_MS) {
      await alertOnce(env, a.home_id, "topup.paid_not_granted", `alert:topup-paid-ungranted:${a.invoice_id}`, { attemptId: a.attempt_id, invoiceId: a.invoice_id, grantable: ctx.canGrant !== false }, ctx.now);
    }
    return;
  }
  let cap: CapRaiseResult = "unknown";
  try { cap = await ctx.raiseCap(a.home_id); } catch { cap = "unknown"; }
  if ((cap === "unknown" || cap === "raced") && ctx.now - paidAt < TOPUP_CAP_WAIT_MS) return;
  await env.DB.prepare("UPDATE topup_attempts SET state='done', granted_at=?, updated_at=? WHERE attempt_id=? AND state='paid'").bind(ctx.now, ctx.now, a.attempt_id).run();
  // The credit is delivered, so a page raised while it could not be sent ends here (Astra r5): sweepMonitoring delivers the resolve notice, once.
  await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE id=? AND resolved_at IS NULL").bind(ctx.now, `alert:topup-paid-ungranted:${a.invoice_id}`).run();
}

/** A paused home recovers when the owner acts. Switching top-up off and on lifts the pause in saveTopup; a card update shows here: the live payment
 *  method (the subscription's, else the customer's) is a method other than the one that failed. Bounded and rotated, so a pile of paused homes
 *  never costs more than TOPUP_RECOVER_HOMES Stripe reads per sweep. */
async function recoverPaused(env: Env, ctx: { now: number; deps: TopupDeps }): Promise<void> {
  const rows = await env.DB.prepare(`SELECT t.home_id, t.paused_method, b.customer_id, b.subscription_id FROM topup_state t
    JOIN billing_subscriptions b ON b.home_id=t.home_id AND b.status IN ('active','trialing')
    WHERE t.paused_at IS NOT NULL AND (t.recheck_at IS NULL OR t.recheck_at<=?) ORDER BY COALESCE(t.recheck_at,0), t.home_id LIMIT ?`)
    .bind(ctx.now, TOPUP_RECOVER_HOMES).all<{ home_id: string; paused_method: string | null; customer_id: string; subscription_id: string | null }>();
  for (const r of rows.results) {
    await env.DB.prepare("UPDATE topup_state SET recheck_at=? WHERE home_id=?").bind(ctx.now + TOPUP_RECHECK_MS, r.home_id).run();
    try {
      const sub = r.subscription_id ? await ctx.deps.stripe.getSubscription(r.subscription_id) : null;
      const cust = await ctx.deps.stripe.customerTaxState(r.customer_id);
      const live = sub?.default_payment_method ?? cust.defaultPaymentMethod ?? null;
      if (live && live !== r.paused_method) {
        await env.DB.prepare(`UPDATE topup_state SET paused_at=NULL, pause_reason=NULL, paused_method=NULL, declines=0, retry_after=NULL, retry_fails=0, notified_reason=NULL
          WHERE home_id=? AND paused_at IS NOT NULL`).bind(r.home_id).run();
      }
    } catch { /* Stripe unreadable: looked at again after the recheck delay */ }
  }
}

/** The sweep's context for one home: its notices are queued under the lease the sweep holds (notify would otherwise try to take the lease again and find the home busy). */
function leased<L>(ctx: TopupSweepCtx<L>, lease: L): TopupSweepCtx<L> {
  return { ...ctx, deps: { ...ctx.deps, notify: (kind, homeId, key) => ctx.deps.notify(kind, homeId, key, lease) } };
}

/** Paused homes whose notice was never marked as queued (the notice failed when the pause was made): sent again, under the home's lease. */
async function renoticePaused<L>(env: Env, ctx: TopupSweepCtx<L>): Promise<void> {
  const rows = await env.DB.prepare(`SELECT home_id, pause_reason, paused_at FROM topup_state WHERE paused_at IS NOT NULL AND pause_reason IS NOT NULL
    AND notified_reason IS NOT pause_reason ORDER BY COALESCE(sweep_checked_at,0), home_id LIMIT 25`).all<{ home_id: string; pause_reason: string; paused_at: number }>();
  for (const r of rows.results) {
    // Stamped BEFORE the lease is tried (sweep_checked_at: a paused home is never in the charge sweep's page, so the stamp is free here): a home
    // that is busy every pass moves to the back, and the 26th unnoticed home is reached.
    await env.DB.prepare("UPDATE topup_state SET sweep_checked_at=? WHERE home_id=?").bind(ctx.now, r.home_id).run();
    await ctx.onHome(r.home_id, async (lease) => { await noticePause(env, leased(ctx, lease).deps, r.home_id, r.pause_reason, r.paused_at); });
  }
}

/** Drive one open attempt as far as it goes in this sweep. */
async function advance<L>(env: Env, ctx: TopupSweepCtx<L>, lease: L, start: TopupAttempt): Promise<void> {
  let a = start;
  if (a.state === "claimed" || a.state === "invoiced") {
    // With charging off an open attempt is only settled: the invoice is read, a paid one goes to its grant, an open one is voided and the
    // reservation returned. runTopupAttempt (which could create an invoice and pay it) is never reached.
    if (ctx.charging === false || ctx.now - a.claimed_at >= TOPUP_STALE_AFTER_MS) {
      const r = await resolveStale(env, ctx, a, ctx.charging === false ? "charging_off" : "stale");
      if (r !== "paid") return;
    } else {
      if (ctx.fence) await ctx.fence(lease);
      if ((await runTopupAttempt(env, ctx.deps, a, ctx.now)) !== "paid") return;
    }
    const fresh = await env.DB.prepare("SELECT * FROM topup_attempts WHERE attempt_id=?").bind(a.attempt_id).first<TopupAttempt>();
    if (!fresh || fresh.state !== "paid") return;
    a = fresh;
  }
  if (a.state === "paid") await settlePaid(env, ctx, lease, a);
}

/**
 * The 5-minute sweep. Open attempts first (resume, grant, cap raise), then homes whose balance fell below their threshold. Homes with spending
 * off, stopped, on a billing hold, paused, in cooldown, or with an open attempt are never asked. A home is claimed only while its saved
 * authorization is enabled and applied; the claim fences on that row. Balance reads are not assumed fresh: the single-flight claim, the
 * cooldown after a paid attempt and the open-until-granted rule are what keep one low balance from buying twice.
 */
export async function sweepAutoTopup<L>(env: Env, ctx0: TopupSweepCtx<L>): Promise<void> {
  const ctx = ctx0;
  const charging = ctx.charging !== false;
  // Least recently looked at first (checked_at), so a pile of paid attempts waiting for a grant cannot hold every slot and starve a newer attempt
  // whose Stripe response was lost: each pass moves what it handled to the back of the line.
  const open = await env.DB.prepare(`SELECT * FROM topup_attempts WHERE state IN ('claimed','invoiced','paid')
    AND (state='paid' OR updated_at<=?) ORDER BY COALESCE(checked_at,0), updated_at, attempt_id LIMIT 50`).bind(ctx.now - TOPUP_RESUME_AFTER_MS).all<TopupAttempt>();
  // The one cheap read when nothing is open: with charging off and no open attempt there is nothing to recover and nothing to start.
  if (!charging && open.results.length === 0) return;
  if (charging) { await recoverPaused(env, ctx); await renoticePaused(env, ctx0); }
  for (const a of open.results) {
    // Stamped BEFORE the lease is tried: a home that is busy every sweep still moves to the back of the line, and cannot hold a slot forever.
    await env.DB.prepare("UPDATE topup_attempts SET checked_at=? WHERE attempt_id=?").bind(ctx.now, a.attempt_id).run();
    await ctx.onHome(a.home_id, async (lease0) => {
      const lease = lease0; const ctx = leased(ctx0, lease0);
      const cur = await env.DB.prepare("SELECT * FROM topup_attempts WHERE attempt_id=?").bind(a.attempt_id).first<TopupAttempt>();
      if (cur && ["claimed", "invoiced", "paid"].includes(cur.state)) await advance(env, ctx, lease, cur);
    });
  }
  if (!charging) return; // recovery done; a new charge starts only with the flag on
  if (ctx.claiming === false) return; // PRODFLUX r4 A: Flux cannot issue (a secret or the API base missing): no new claim until it can
  const homes = await env.DB.prepare(`SELECT s.home_id, s.enabled, s.amount_cents, s.threshold_cents, s.cap_cents, s.revision, s.applied_revision, s.consent_id
    FROM topup_settings s
    JOIN flux_home_keys k ON k.home_id=s.home_id AND k.state='active' AND k.spending_off=0 AND k.billing_hold=0
    JOIN billing_subscriptions b ON b.home_id=s.home_id AND b.status IN ('active','trialing')
    LEFT JOIN topup_state t ON t.home_id=s.home_id
    WHERE s.enabled=1 AND s.applied_revision=s.revision AND t.paused_at IS NULL AND (t.last_paid_at IS NULL OR t.last_paid_at<=?) AND (t.retry_after IS NULL OR t.retry_after<=?)
      AND NOT EXISTS (SELECT 1 FROM topup_attempts x WHERE x.home_id=s.home_id AND x.state IN ('claimed','invoiced','paid'))
    ORDER BY COALESCE(t.sweep_checked_at,0), s.home_id LIMIT ?`).bind(ctx.now - TOPUP_COOLDOWN_MS, ctx.now, TOPUP_SWEEP_HOMES).all<TopupSettings>();
  for (const s of homes.results) {
    // Least recently examined first, stamped BEFORE the lease is tried: the page is a window that moves, so neither a home past the first
    // TOPUP_SWEEP_HOMES nor a home that is busy every sweep holds a slot or starves the rest.
    await env.DB.prepare(`INSERT INTO topup_state (home_id, sweep_checked_at) VALUES (?,?)
      ON CONFLICT (home_id) DO UPDATE SET sweep_checked_at=excluded.sweep_checked_at`).bind(s.home_id, ctx.now).run();
    await ctx.onHome(s.home_id, async (lease0) => {
      const lease = lease0; const ctx = leased(ctx0, lease0);
      const spendable = await ctx.spendable(s.home_id);
      if (spendable === null || spendable >= s.threshold_cents * 10_000) return;
      const claim = await claimTopupAttempt(env, s, ctx.now);
      if (!claim.claimed) {
        if (claim.reason === "cap") {
          const month = topupMonthKey(ctx.now);
          // Queue the notice, then write the month marker: a notice that failed leaves no marker and is tried again next sweep.
          const told = await env.DB.prepare("SELECT 1 AS x FROM topup_state WHERE home_id=? AND cap_notice_month=?").bind(s.home_id, month).first();
          if (!told) {
            try {
              await ctx.deps.notify("topup_cap_reached", s.home_id, month);
              await env.DB.prepare(`INSERT INTO topup_state (home_id, cap_notice_month) VALUES (?,?)
                ON CONFLICT (home_id) DO UPDATE SET cap_notice_month=excluded.cap_notice_month`).bind(s.home_id, month).run();
            } catch { /* no marker written: tried again next sweep */ }
          }
        }
        return;
      }
      await advance(env, ctx, lease, claim.attempt);
    });
  }
}
