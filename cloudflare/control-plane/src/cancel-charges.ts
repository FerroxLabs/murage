// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra JOURNEY-BCORE-3 #5-#8: charges on a subscription whose cancellation promised an end. RECORD ONLY, and the control plane NEVER computes a
// refund amount for them: every invoice paid on such a subscription after the promise creates ONE cancellation_late record (cancel_late_refunds)
// carrying the invoice, the promised end and the full line snapshot (all pages; each line's own tax amounts, discounts and price id), with NO
// amount. An operator executes it by its id with the amount they decide (public-cancellation.ts executeLateRefund), the same record-only pattern
// as the first-month refund requests. Whether a line looks like served usage, a renewal after the end, time before it or a one-off item is kept
// ONLY as a hint on the record and its lines, never as an amount.
// Sources: the invoice.paid webhook (every payment, whenever it settles), and the durable backfill, which tracks every invoice of the subscription
// BY ID from the first time it is seen until it is final (cancel_invoice_checks) and continues after the resolution; listings run in the
// invoice's own lifecycle order (draft, open, paid), so an invoice that settles between two listings is seen in at least one of them and then
// read again by its id. Nothing here is a snapshot diff.
import { type InvoiceLineView, type InvoiceView, type StripeClient } from "./b5-stripe";

/** Stripe timestamps are whole seconds: five seconds is the whole tolerance on a promised end (the same precision the termination uses). */
export const CHARGE_PRECISION_MS = 5_000;
/** The backfill keeps looking at a resolved cancellation's subscription this long after it was resolved (and for as long as an invoice it saw is
 *  not final): a missed webhook for a late final invoice or a retried collection is still recorded. */
export const CHARGE_WATCH_MS = 35 * 24 * 3_600_000;

export interface ChargePromise { subscriptionId: string; homeId: string; promisedEndAt: number; requestId?: string | null }

/** The EARLIEST end still promised for a subscription (Astra JOURNEY-BCORE-3 #2/#11): every standing resolution row (open, terminated or resolved:
 *  a withdrawn one was kept or replaced), the in-app cancellation on record (customer_cancel_at set; a Keep clears it) and every running or
 *  carried-out public declaration. Null: nothing was promised. Never the mutable current_period_end. */
export async function promiseOf(env: Env, subscriptionId: string | null): Promise<ChargePromise | null> {
  if (!subscriptionId) return null;
  const r = await env.DB.prepare(`SELECT MIN(at) AS at, MAX(home) AS home FROM (
      SELECT promised_end_at AS at, home_id AS home FROM cancel_resolutions WHERE subscription_id=?1 AND state IN ('open','terminated','resolved')
      UNION ALL SELECT cancel_promised_end, home_id FROM billing_subscriptions WHERE subscription_id=?1 AND customer_cancel_at IS NOT NULL AND cancel_promised_end IS NOT NULL
      UNION ALL SELECT effective_at, home_id FROM cancellation_requests WHERE subscription_id=?1 AND match_state='matched' AND home_id IS NOT NULL AND effective_at IS NOT NULL
        AND status IN ('open','reason_pending','held','executing','completed'))`).bind(subscriptionId).first<{ at: number | null; home: string | null }>();
  return r?.at !== null && r?.at !== undefined && r.home ? { subscriptionId, homeId: r.home, promisedEndAt: r.at } : null;
}

/** What a line looks like, for the operator only (never an amount): served usage (a metered price), a one-off invoice item, time after the
 *  promised end, time straddling it, or time before it. */
export type LineHint = "served_usage" | "one_off" | "after_end" | "straddles_end" | "before_end" | "undated";
export interface LineSnapshot extends InvoiceLineView { hint: LineHint }

const finalStatus = (s: string | null) => s === "paid" || s === "void" || s === "uncollectible";

/** The recurring usage type of a line's price: the line's own when it carries one, else the Price read once (best effort: a hint only). */
async function usageTypeOf(stripe: StripeClient, l: InvoiceLineView, cache: Map<string, string | null>): Promise<string | null> {
  if (l.usageType) return l.usageType;
  if (!l.price || typeof stripe.getPrice !== "function") return null;
  if (!cache.has(l.price)) {
    let t: string | null = null;
    try { t = (await stripe.getPrice(l.price)).recurring?.usage_type ?? null; } catch { t = null; }
    cache.set(l.price, t);
  }
  return cache.get(l.price) ?? null;
}
function lineHint(l: InvoiceLineView, usage: string | null, promisedEndAt: number): LineHint {
  if (usage === "metered") return "served_usage";
  if (l.source === "invoice_item") return "one_off";
  const cutoff = promisedEndAt - CHARGE_PRECISION_MS;
  if (l.period.start === null) return "undated";
  if (l.period.start * 1000 >= cutoff) return "after_end";
  if (l.period.end !== null && l.period.end * 1000 > promisedEndAt + CHARGE_PRECISION_MS) return "straddles_end";
  return "before_end";
}
/** The record's hint: the one kind every charged line shares, else 'mixed'. */
function recordHint(lines: LineSnapshot[]): string {
  const kinds = new Set(lines.filter((l) => (l.amount ?? 0) !== 0).map((l) => l.hint));
  return kinds.size === 1 ? [...kinds][0] : kinds.size === 0 ? "nothing_charged" : "mixed";
}

/** Whether an invoice is a charge after the promise: collected at or after the promised end (less the precision), or any of its lines is for
 *  time starting at or after it. An invoice paid before the promise for time before it is the paid period itself, not a post-promise charge. */
function afterPromise(inv: InvoiceView, lines: InvoiceLineView[], promisedEndAt: number): boolean {
  const cutoff = promisedEndAt - CHARGE_PRECISION_MS;
  return (inv.paid_at ?? inv.created) * 1000 >= cutoff || lines.some((l) => l.period.start !== null && l.period.start * 1000 >= cutoff);
}

/** Tracks ONE invoice by id and, when it is paid after the promise, records it (once per invoice: cancel_late_refunds.invoice_id is unique) with
 *  its full line snapshot and no amount. Returns 'recorded' (a new record), 'final' (nothing more will happen to it) or 'pending' (open or
 *  draft: read again by id on the next backfill). Lines that cannot be read completely throw (the caller stays retryable). */
export async function recordInvoice(env: Env, stripe: StripeClient, p: ChargePromise, inv: InvoiceView, now: number,
  cache: Map<string, string | null> = new Map()): Promise<"recorded" | "final" | "pending"> {
  if (!inv.id) return "final";
  // A paid invoice is tracked as 'paid' only once it has been judged (recorded, or not a post-promise charge): one whose lines could not be read
  // stays 'paid_unjudged', which is not final, so the next backfill reads it again by id.
  const track = (status: string | null) => env.DB.prepare(`INSERT INTO cancel_invoice_checks (subscription_id,invoice_id,status,first_seen_at,checked_at) VALUES (?,?,?,?,?)
    ON CONFLICT(subscription_id,invoice_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at`).bind(p.subscriptionId, inv.id, status, now, now).run();
  await track(inv.status === "paid" ? "paid_unjudged" : inv.status);
  if (inv.status !== "paid") return finalStatus(inv.status) ? "final" : "pending";
  const judged = async (r: "recorded" | "final") => { await track("paid"); return r; };
  if (inv.amount_paid <= 0) return judged("final");
  if (await env.DB.prepare("SELECT 1 AS x FROM cancel_late_refunds WHERE invoice_id=?").bind(inv.id).first()) return judged("final");
  const raw = inv.lines?.has_more === true ? await stripe.listInvoiceLines(inv.id) : inv.lines?.data ?? [];
  if (!afterPromise(inv, raw, p.promisedEndAt)) return judged("final");
  const lines: LineSnapshot[] = [];
  for (const l of raw) {
    const usage = await usageTypeOf(stripe, l, cache);
    lines.push({ ...l, usageType: usage, hint: lineHint(l, usage, p.promisedEndAt) });
  }
  const others = (await env.DB.prepare("SELECT id,kind,amount_cents FROM refund_ops WHERE invoice_id=? ORDER BY created_at").bind(inv.id)
    .all<{ id: string; kind: string; amount_cents: number | null }>()).results;
  const snapshot = { invoice: { id: inv.id, status: inv.status, amountPaid: inv.amount_paid, amountDue: inv.amount_due, total: inv.total ?? null, tax: inv.tax,
    currency: inv.currency ?? null, created: inv.created, paidAt: inv.paid_at ?? null, billingReason: inv.billing_reason }, lines, otherRefunds: others };
  const owner = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(p.homeId).first<{ owner_id: string }>();
  const id = `cxr-late:${p.subscriptionId}:${inv.id}`;
  // The public declaration whose end it was recorded against (its customer is told when the operator executes it), whichever path recorded it.
  const requestId = p.requestId ?? (await env.DB.prepare(`SELECT id FROM cancellation_requests WHERE subscription_id=? AND match_state='matched' AND effective_at IS NOT NULL
    AND status IN ('open','reason_pending','held','executing','completed') ORDER BY effective_at, received_at LIMIT 1`).bind(p.subscriptionId).first<{ id: string }>())?.id ?? null;
  const hint = recordHint(lines);
  const res = await env.DB.prepare(`INSERT INTO cancel_late_refunds (id,subscription_id,home_id,user_id,invoice_id,payment_intent,paid_cents,currency,promised_end_at,hint,
      snapshot_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(id, p.subscriptionId, p.homeId, owner?.owner_id ?? "", inv.id, inv.payment_intent, inv.amount_paid, inv.currency ?? null, p.promisedEndAt, hint,
      JSON.stringify(snapshot), requestId, now).run();
  if ((res.meta.changes ?? 0) !== 1) return judged("final");
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(`cancel.late_renewal_charge:${id}`, p.homeId, "cancel.late_renewal_charge", "high",
      JSON.stringify({ record: id, subscriptionId: p.subscriptionId, invoiceId: inv.id, paidCents: inv.amount_paid, promisedEndAt: p.promisedEndAt, hint }), now).run();
  return judged("recorded");
}

/** The durable backfill for one subscription: first every invoice it already tracks that is not final yet, read again BY ID; then every invoice
 *  Stripe lists for it, in lifecycle order (draft, open, paid: an invoice moving on between two listings appears in the later one). Each is
 *  tracked and, once paid after the promise, recorded. `pending`: invoices still open or in draft (or not judged yet). One invoice that cannot be
 *  recorded never stops the others; a listing that cannot be completed throws. */
export async function backfillCharges(env: Env, stripe: StripeClient, p: ChargePromise, now: number): Promise<{ recorded: number; pending: number }> {
  const cache = new Map<string, string | null>();
  let recorded = 0;
  const done = new Set<string>();
  const tracked = (await env.DB.prepare("SELECT invoice_id,status FROM cancel_invoice_checks WHERE subscription_id=?").bind(p.subscriptionId)
    .all<{ invoice_id: string; status: string | null }>()).results;
  for (const t of tracked) {
    if (finalStatus(t.status)) { done.add(t.invoice_id); continue; }
    // One invoice that cannot be read now never holds back the others (or the listings): it stays tracked and is read again next time.
    // Astra JOURNEY-BCORE-4 #5: the WHOLE attempt (the read and the recording, its line pages included) is isolated; its tracked status stays
    // unfinished (paid_unjudged, open, draft) and it is read again next time.
    try {
      const inv = await stripe.getInvoice(t.invoice_id);
      if (!inv?.id) continue;
      if ((await recordInvoice(env, stripe, p, inv, now, cache)) === "recorded") recorded += 1;
    } catch { continue; }
  }
  for (const status of ["draft", "open", "paid"] as const) {
    for (const inv of await stripe.listSubscriptionInvoices(p.subscriptionId, status)) {
      if (done.has(inv.id)) continue;
      try { if ((await recordInvoice(env, stripe, p, { ...inv, status: inv.status ?? status }, now, cache)) === "recorded") recorded += 1; }
      catch { continue; } // this invoice stays unfinished (tracked) and is read again by id; the others and the later listings go on
    }
  }
  const pending = (await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_invoice_checks WHERE subscription_id=? AND (status IS NULL OR status NOT IN ('paid','void','uncollectible'))")
    .bind(p.subscriptionId).first<{ n: number }>())?.n ?? 0;
  return { recorded, pending };
}
