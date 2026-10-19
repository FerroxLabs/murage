// SPDX-License-Identifier: AGPL-3.0-or-later
// Customer-journey routes, lane A (CUSTOMER-JOURNEY-CP.md). Small, signed-in account routes that sit beside the legal flows:
//   POST /v1/account/cancel-plan/reason   A1: why the customer cancelled (a reason from a list, optional free text), after the cancel
//   POST /v1/account/refund-request       A2: records a first-month refund request and emails a receipt (no money moves)
//   GET  /v1/account/invoices             A4: the customer's Stripe invoices (list only; links only under a fresh second step)
//   POST /v1/account/invoices/:id/email   A4: emails the hosted invoice link to the verified address
// Nothing here moves money, changes a subscription or gates a cancellation.
import { z } from "zod";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { cfg, noticeId, notify, readJSON, recordNotice, type BillingDependencies, type RefundIntakeQuote } from "./b5-billing";
import { StripeError, stripeClient, type CustomerInvoice } from "./b5-stripe";
import { isCancelRef } from "./cancel-reference";
import { HTTPError, json } from "./http";
import { htmlOf, isoDate, quoteFirstMonthRefund, type PinnedPayment } from "./legal-flows";
import { euUkFullRefundFor, euUkFullRefundQuote } from "./legal-refunds";

const nowOf = (deps: BillingDependencies) => (deps.now ?? Date.now)();
async function currentUser(request: Request, deps: BillingDependencies, auth: ControlPlaneAuth) {
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  return user;
}

// ---- A1: cancellation reason ----------------------------------------------------------------------------------------------------

/** The reasons the cancel screen offers (nothing pre-selected). `other` is the one that usually comes with free text. */
export const CANCEL_REASONS = ["too_expensive", "not_using_it", "missing_feature", "technical_problem", "switching_service", "temporary_pause", "other"] as const;
export const CANCEL_TEXT_MAX = 500;
/** Free text is kept 13 months from the day it was written, then deleted by the billing sweep (purgeCancellationFeedback). */
export const FEEDBACK_RETENTION_MONTHS = 13;
const reasonBody = z.object({
  cancellationId: z.string().refine(isCancelRef),
  reason: z.enum(CANCEL_REASONS),
  text: z.string().max(CANCEL_TEXT_MAX).optional(),
}).strict();

/** The same day `months` calendar months later (UTC, time of day kept), clamped to the destination month's last day: 31 January plus 13 months
 *  is 28 (or 29) February, never 3 March (setUTCMonth would overflow into the next month). */
export const monthsLater = (ms: number, months: number): number => {
  const d = new Date(ms);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
};

/** A separate call AFTER the cancel (the receipt's `reference` is the cancellationId). It reads the customer's own receipt and writes one
 *  feedback row; it never touches the subscription, the cancel intent or any email, so it can fail or never be sent without any effect on the
 *  cancellation. The free text is stored here and nowhere else: not in alerts, not in logs, not in any error. A second call by the same
 *  customer for the same cancellation replaces the first answer. */
export async function cancelReason(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  const body = await readJSON(request, reasonBody);
  const receipt = await env.DB.prepare("SELECT home_id FROM plan_cancellations WHERE reference=? AND user_id=?").bind(body.cancellationId, user.id).first<{ home_id: string }>();
  if (!receipt) throw new HTTPError(404, "not_found");
  const now = nowOf(deps);
  const text = body.text?.trim() ? body.text.trim() : null;
  await env.DB.prepare(`INSERT INTO cancellation_feedback (cancellation_id,user_id,home_id,reason,text,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(cancellation_id) DO UPDATE SET reason=excluded.reason,text=excluded.text,updated_at=excluded.updated_at`)
    .bind(body.cancellationId, user.id, receipt.home_id, body.reason, text, now, now, monthsLater(now, FEEDBACK_RETENTION_MONTHS)).run();
  return json({ recorded: true, cancellationId: body.cancellationId, reason: body.reason, receivedAt: now });
}

/** The 13-month retention: rows whose time is up are deleted by the billing sweep. */
export async function purgeCancellationFeedback(env: Env, now: number): Promise<void> {
  await env.DB.prepare("DELETE FROM cancellation_feedback WHERE expires_at<=?").bind(now).run();
}
/** Everything lane A keeps with a clock, in the billing sweep: the 13-month feedback and the one-minute invoice list cache. */
export async function sweepJourney(env: Env, now: number): Promise<void> {
  await purgeCancellationFeedback(env, now);
  await env.DB.prepare("DELETE FROM invoice_list_cache WHERE fetched_at<=?").bind(now - 60 * 60_000).run();
  await env.DB.prepare("DELETE FROM invoice_email_log WHERE at<=?").bind(now - DAY_MS).run();
}
/** Deletes everything this customer wrote on the cancel screen. There is no account-erasure path in the control plane yet (an account is only
 *  ever suspended, then its home deleted); whichever one is added calls this with the account's id. Until then the 13-month sweep is the purge. */
export async function eraseCancellationFeedback(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM cancellation_feedback WHERE user_id=?").bind(userId).run();
}

// ---- A2: refund request record --------------------------------------------------------------------------------------------------

interface RefundRequestRow { id: string; home_id: string; received_at: number; eligible: number; deadline: number | null; window_open: number; pending_reasons: string | null }

/** The home's ONE open refund.requested alert lists every outstanding (not yet executed) request (Astra JOURNEY-A-1 A2): a later request, for
 *  another payment, is added to the open alert instead of being lost behind it, and an executed one leaves it. The list is recomputed from
 *  refund_requests in the write itself (order of receipt), so concurrent requests cannot drop each other; a changed list is delivered to ops
 *  again (delivered_at cleared, revision bumped). Once nothing is outstanding the alert is resolved. Only request ids, never customer text. */
export function refundAlertStatements(env: Env, homeId: string, now: number): D1PreparedStatement[] {
  const ids = "(SELECT json_group_array(id) FROM (SELECT id FROM refund_requests WHERE home_id=? AND decided_at IS NULL ORDER BY received_at,id))";
  return [
    env.DB.prepare(`UPDATE cloud_alerts SET detail=json_object('requestIds',json(${ids}),'outstanding',(SELECT COUNT(*) FROM refund_requests WHERE home_id=? AND decided_at IS NULL),
        'revision',COALESCE(json_extract(detail,'$.revision'),0)+1),delivered_at=NULL,delivery_attempts=0
      WHERE home_id=? AND kind='refund.requested' AND resolved_at IS NULL AND COALESCE(json_extract(detail,'$.requestIds'),'') IS NOT ${ids}`)
      .bind(homeId, homeId, homeId, homeId),
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='refund.requested' AND resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM refund_requests WHERE home_id=? AND decided_at IS NULL)`).bind(now, homeId, homeId),
  ];
}

/** The operator executed this request (legal-routes.ts refundFirstMonth by requestId): it is no longer outstanding, and the alert follows. */
export async function refundRequestDecided(env: Env, requestId: string, homeId: string, opId: string | null, now: number): Promise<void> {
  await env.DB.batch([env.DB.prepare("UPDATE refund_requests SET decided_at=COALESCE(decided_at,?),refund_op_id=COALESCE(refund_op_id,?) WHERE id=?").bind(now, opId, requestId),
    ...refundAlertStatements(env, homeId, now)]);
}

/** Astra JOURNEY-A-3 #7: the window of ANY quote outcome, in every shape the quote paths produce: windowEndsAt (lane A, the EU/UK entitlement),
 *  lane B's top-level { deadline, startsWhenReady }, or its nested window { deadline | endsAt, startsWhenReady }. The flag is carried from
 *  wherever the quote put it; a key that is absent is unknown (never read as "no deadline"). */
export function intakeWindowOf(quote: RefundIntakeQuote): { eligible: boolean; reason: string | null; windowEndsAt: number | null; startsWhenReady: boolean } {
  const w = quote.window ?? null;
  const endsAt = quote.windowEndsAt !== undefined ? quote.windowEndsAt : quote.deadline !== undefined ? quote.deadline
    : w?.deadline !== undefined ? w.deadline : w?.endsAt !== undefined ? w.endsAt : null;
  const startsWhenReady = quote.startsWhenReady === true || w?.startsWhenReady === true;
  return { eligible: quote.eligible, reason: quote.reason, windowEndsAt: endsAt ?? null, startsWhenReady };
}

/** The request's window, from the quote's window shape (lane B: { deadline: number | null, startsWhenReady: boolean }; Astra JOURNEY-B-1 #17).
 *  A window that starts when the server is first ready (the server is not ready yet) is OPEN with its end not known yet: deadline null,
 *  windowOpen true, and a request otherwise eligible stays eligible. Only a deadline that cannot be read at all (no startsWhenReady) is unknown
 *  (closed for the answer, a person checks it). Every quote outcome goes through intakeWindowOf first (Astra JOURNEY-A-3 #7). */
export function requestWindow(quoteIn: RefundIntakeQuote, now: number):
  { deadline: number | null; windowOpen: boolean; startsWhenReady: boolean; eligible: boolean } {
  const quote = intakeWindowOf(quoteIn);
  const startsWhenReady = quote.startsWhenReady && quote.windowEndsAt === null;
  const deadline = startsWhenReady ? null : quote.windowEndsAt;
  const windowOpen = startsWhenReady || (deadline !== null && now <= deadline);
  // A window not started is never "expired": a window_expired verdict cannot stand against it.
  const eligible = quote.eligible || (startsWhenReady && quote.reason === "window_expired");
  return { deadline, windowOpen, startsWhenReady, eligible };
}

/** The intake's canonical dry run as of `now`: the EU/UK 14-day full refund first, then the 7-day offer, on the request's own payment and its
 *  consent as recorded (an explicit null included, Astra JOURNEY-A-3 #5). Astra JOURNEY-A-11 #2: both are judged on the ONE snapshot captured
 *  for the request (its payment, subscription and consent), never on the home's live row, which a replacement may have changed since. */
async function intakeQuote(env: Env, deps: BillingDependencies, homeId: string, now: number,
  pinned: { invoiceId: string; consentId: string | null; snapshot: { pay: PinnedPayment; subscriptionId: string | null } }): Promise<RefundIntakeQuote> {
  if (deps.refundIntakeQuote) return deps.refundIntakeQuote(env, homeId, now, pinned);
  let stripe: ReturnType<typeof stripeClient> | null = null;
  try { stripe = stripeClient(cfg(env), deps.stripeFetch); } catch { stripe = null; }
  const { subscriptionId } = pinned.snapshot;
  const eu = subscriptionId === null ? null
    : await euUkFullRefundFor(env, homeId, now, { ...pinned, snapshot: { pay: pinned.snapshot.pay, subscriptionId } });
  return eu ? await euUkFullRefundQuote(env, homeId, eu)
    : await quoteFirstMonthRefund(env, homeId, now, { stripe, consentId: pinned.consentId, pinned: pinned.snapshot.pay });
}

/** POST /v1/account/refund-request (no body). Records that the signed-in customer asked for the first-month refund and emails a receipt. It decides
 *  nothing and moves no money: the refund itself stays the operator flow (/v1/admin/refund-first-month) with its once-per-person limit. One
 *  request per account per payment (the first payment's invoice): asking again returns the same request, with nothing sent again. The answer
 *  {requestId, receivedAt, eligible, status: eligible|pending, pendingReasons, windowOpen, deadline} is informational, as of the request:
 *  `eligible` only when the canonical checks pass, else `pending` with the reason codes; a request outside the window is still recorded (the
 *  operator may still decide it) and says so. The operator executes it by its id (legal-routes.ts refundFirstMonth), as of its receipt. */
export async function refundRequest(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  // Astra JOURNEY-A-11 #2: the payment, its subscription and its consent (an explicit null included) are captured in ONE statement, so they
  // always belong together, and that same snapshot is quoted and stored: a replacement checkout after this read can never mix in its payment.
  // Astra INTEGRATED-1 #3: a DELETED home's retained payment (still the customer's own: owner_id) stays requestable; a live home comes first.
  const pay = await env.DB.prepare(`SELECT h.id AS home_id, b.first_invoice_id AS invoice, b.first_paid_at AS paid_at, b.consent_id AS consent,
      b.subscription_id AS subscription, b.first_invoice_cents AS cents, b.first_invoice_tax_cents AS tax, b.first_period_start AS ps,
      b.first_period_end AS pe, b.first_payment_intent AS pi
    FROM cloud_homes h JOIN billing_subscriptions b ON b.home_id=h.id
    WHERE h.owner_id=? AND b.first_invoice_id IS NOT NULL AND b.first_paid_at IS NOT NULL
    ORDER BY h.desired_state='deleted', h.created_at DESC LIMIT 1`).bind(user.id).first<{ home_id: string; invoice: string; paid_at: number; consent: string | null; subscription: string | null;
      cents: number | null; tax: number | null; ps: number | null; pe: number | null; pi: string | null }>();
  if (!pay) throw new HTTPError(409, "no_first_payment");
  // The same shape pinCurrentPayment gives (a payment without an amount is no payment to quote: the quote then says so).
  const snapshot: PinnedPayment | null = pay.cents ? { invoiceId: pay.invoice, paymentIntent: pay.pi, paidCents: pay.cents, taxCents: pay.tax ?? 0,
    paidAt: pay.paid_at, periodStart: pay.ps, periodEnd: pay.pe } : null;
  const existing = () => env.DB.prepare("SELECT id,home_id,received_at,eligible,deadline,window_open,pending_reasons FROM refund_requests WHERE user_id=? AND payment_key=?")
    .bind(user.id, pay.invoice).first<RefundRequestRow>();
  const answer = (r: RefundRequestRow, again: boolean) => {
    const reasons = r.pending_reasons ? JSON.parse(r.pending_reasons) as string[] : [];
    return json({ requestId: r.id, receivedAt: r.received_at, eligible: r.eligible === 1, status: r.eligible === 1 ? "eligible" : "pending", pendingReasons: reasons,
      windowOpen: r.window_open === 1, deadline: r.deadline, startsWhenReady: r.window_open === 1 && r.deadline === null, alreadyRequested: again }, again ? 200 : 201);
  };
  const before = await existing();
  if (before) return answer(before, true);

  const now = nowOf(deps);
  // Astra JOURNEY-A-1 A2: the window and the eligibility are two different answers. The window is only the date. Eligibility is the operator
  // flow's own canonical checks, as a dry run as of now (the EU/UK 14-day full refund first, then the 7-day offer: once per person and payment
  // method, abuse closure, refunds already made against the payment). Anything not confirmed is "pending", with the reasons; a person decides.
  // Astra JOURNEY-A-3 #6: the payment as of receipt (the snapshot above), kept with the request for its decision after a replacement checkout.
  const quote: RefundIntakeQuote = snapshot
    ? await intakeQuote(env, deps, pay.home_id, now, { invoiceId: pay.invoice, consentId: pay.consent, snapshot: { pay: snapshot, subscriptionId: pay.subscription } })
    : { eligible: false, reason: "no_first_payment", windowEndsAt: null };
  const { deadline, windowOpen, startsWhenReady, eligible } = requestWindow(quote, now);
  const reasons = eligible ? [] : [quote.reason ?? "not_eligible"];
  const id = `rr-${crypto.randomUUID()}`;
  const windowLine = startsWhenReady ? "Your refund window has not started yet: it starts when your server is first ready, so your request is inside it."
    : deadline === null ? "We could not read the refund window for your payment yet; a person checks it."
    : windowOpen ? `Your request arrived inside the refund window for your first payment, which ends on ${isoDate(deadline)}.`
      : `Your request arrived after the refund window for your first payment ended on ${isoDate(deadline)}. We still read every request.`;
  const text = [`We received your refund request.`, "",
    `Request ID: ${id}`, `Received: ${isoDate(now)}`, "",
    windowLine, ...(eligible || !windowOpen ? [] : ["We still need to check a few things before we can confirm the refund."]), "",
    `A person looks at every refund request and we will email you the decision. Nothing has been refunded yet, and your request does not change your plan.`].join("\n");
  const data = { requestId: id, emailSubject: "Murage Cloud: we received your refund request", emailText: text, emailHtml: htmlOf(text) };
  // The request, its receipt email (recorded, so a send that fails is retried by the sweep) and the ops alert go in together, and only the
  // first writer of the (account, payment) pair does any of it.
  const [ins] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO refund_requests (id,home_id,user_id,payment_key,consent_id,received_at,eligible,deadline,window_open,pending_reasons,
        payment_snapshot,subscription_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, pay.home_id, user.id, pay.invoice, pay.consent, now, eligible ? 1 : 0, deadline, windowOpen ? 1 : 0, reasons.length ? JSON.stringify(reasons) : null,
        snapshot ? JSON.stringify(snapshot) : null, pay.subscription),
    ...[recordNotice(pay.home_id, "refund_request_received", id, data, now, true)].map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))),
    env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), pay.home_id, "refund.requested", "warning", "{}", now),
    ...refundAlertStatements(env, pay.home_id, now),
  ]);
  const row = (await existing())!;
  if (ins.meta.changes === 1) {
    try { await notify(env, deps, pay.home_id, "refund_request_received", id, data); } catch { /* recorded above; the sweep sends it */ }
  }
  return answer(row, ins.meta.changes !== 1);
}

// ---- A4: invoices ----------------------------------------------------------------------------------------------------------------

export const INVOICE_CACHE_MS = 60_000;
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,64}$/;
interface InvoiceListed { id: string; number: string | null; date: string; amountCents: number; currency: string; status: string }
const listed = (i: CustomerInvoice): InvoiceListed => ({ id: i.id, number: i.number, date: isoDate(i.created * 1000), amountCents: i.totalCents, currency: i.currency, status: i.status });

/** The customer's Stripe customers (a customer can have had more than one home), each with a home to send mail from. */
/** Every Stripe customer of the account's homes: each home's billing customer and, since a checkout may move a home to a NEW customer
 *  created with the declared address (b5-billing.ts prepareCheckoutCustomer, Astra TAXCOUNTRY-5), every customer it was moved away from
 *  (cloud_ops_state `customer_previous:`), so no receipt the member had before a switch drops out of the list. */
async function customersOf(env: Env, userId: string): Promise<{ customer: string; home: string }[]> {
  const rows = await env.DB.prepare(`SELECT customer, home FROM (
      SELECT b.customer_id AS customer, h.id AS home, h.created_at AS c, 0 AS o FROM billing_subscriptions b JOIN cloud_homes h ON h.id=b.home_id
        WHERE h.owner_id=? AND b.customer_id IS NOT NULL
      UNION ALL
      SELECT CASE WHEN json_valid(s.value) THEN json_extract(s.value,'$.customerId') END, h.id, h.created_at, 1 FROM cloud_ops_state s
        JOIN cloud_homes h ON h.id=(CASE WHEN json_valid(s.value) THEN json_extract(s.value,'$.homeId') END)
        WHERE substr(s.key,1,18)='customer_previous:' AND h.owner_id=?)
    WHERE customer IS NOT NULL ORDER BY c DESC, o`).bind(userId, userId).all<{ customer: string; home: string }>();
  const seen = new Set<string>();
  return rows.results.filter((r) => !seen.has(r.customer) && seen.add(r.customer));
}
/** The fresh second factor alone (no first-purchase bootstrap): what unlocks the invoice links in the list. */
const steppedUp = async (request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<boolean> => {
  try { return await (deps.trustedStepUp ?? deps.stepUp ?? (async () => false))(env, request, auth); } catch { return false; }
};
const stripeFailed = (e: unknown): never => { if (e instanceof StripeError) throw new HTTPError(503, "invoices_unavailable"); throw e; };

/** GET /v1/account/invoices under normal sign-in: [{id, number, date, amountCents, currency, status}] newest first, from Stripe, cached for 60
 *  seconds per customer. With a fresh second factor each row also carries hostedInvoiceUrl and invoicePdf (read live, never cached or stored);
 *  without one the links are not in the answer at all: POST /v1/account/invoices/:id/email sends the hosted link to the verified address. */
export async function listInvoices(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  const now = nowOf(deps);
  const links = await steppedUp(request, env, deps, auth);
  if (!links) {
    const hit = await env.DB.prepare("SELECT body FROM invoice_list_cache WHERE user_id=? AND fetched_at>?").bind(user.id, now - INVOICE_CACHE_MS).first<{ body: string }>();
    if (hit) return json(JSON.parse(hit.body) as never);
  }
  const owned = await customersOf(env, user.id);
  const stripe = stripeClient(cfg(env), deps.stripeFetch);
  let all: CustomerInvoice[] = [];
  try { for (const c of owned) all = all.concat(await stripe.listCustomerInvoices(c.customer)); } catch (e) { return stripeFailed(e); }
  all.sort((a, b) => b.created - a.created);
  if (links) return json(all.map((i) => ({ ...listed(i), hostedInvoiceUrl: i.hostedInvoiceUrl, invoicePdf: i.invoicePdf })) as never);
  const body = all.map(listed);
  await env.DB.prepare("INSERT INTO invoice_list_cache (user_id,fetched_at,body) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET fetched_at=excluded.fetched_at,body=excluded.body")
    .bind(user.id, now, JSON.stringify(body)).run();
  return json(body as never);
}

/** The invoice email budget, per account (the verified recipient is the account's own address): requests are throttled before Stripe is asked,
 *  and new emails are limited per hour and per day. A second press for the same invoice in the same minute is the same email and spends no
 *  email budget (it still counts as a request). */
export const INVOICE_EMAIL_LIMITS = { requestsPerHour: 10, sendsPerHour: 3, sendsPerDay: 10 } as const;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** How long until one more fits under `limit` in the sliding `window`, or null if it fits now. */
function waitFor(ats: number[], limit: number, window: number, now: number): number | null {
  const inside = ats.filter((a) => a > now - window).sort((a, b) => a - b);
  return inside.length < limit ? null : inside[inside.length - limit] + window - now;
}
async function invoiceEmailWait(env: Env, userId: string, now: number, sendsOnly = false): Promise<number | null> {
  const rows = (await env.DB.prepare("SELECT kind,at FROM invoice_email_log WHERE user_id=? AND at>?").bind(userId, now - DAY_MS).all<{ kind: string; at: number }>()).results;
  const of = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.at);
  const waits = [sendsOnly ? null : waitFor(of("request"), INVOICE_EMAIL_LIMITS.requestsPerHour, HOUR_MS, now),
    waitFor(of("send"), INVOICE_EMAIL_LIMITS.sendsPerHour, HOUR_MS, now), waitFor(of("send"), INVOICE_EMAIL_LIMITS.sendsPerDay, DAY_MS, now)]
    .filter((w): w is number => w !== null);
  return waits.length ? Math.max(...waits) : null;
}
function tooMany(waitMs: number): Response {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  const res = json({ error: "too_many_requests", retryAfterSeconds: seconds }, 429);
  res.headers.set("retry-after", String(seconds));
  return res;
}
const sendsSql = (window: string) => `(SELECT COUNT(*) FROM invoice_email_log WHERE user_id=? AND kind='send' AND at>${window})`;

/** POST /v1/account/invoices/:id/email: sends the invoice's hosted link to the account's verified address. No second factor is needed because
 *  the link goes only where the customer's own mail already goes (never to an address in the request, which takes no body). The invoice must be
 *  one of this customer's own (a Stripe customer of their homes). The answer never contains the link. */
export async function emailInvoice(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth, invoiceId: string): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  if (!INVOICE_ID.test(invoiceId)) throw new HTTPError(404, "not_found");
  const now = nowOf(deps);
  // The account's budget, BEFORE Stripe is asked: the request itself is counted in one conditional write (10 an hour), and an exhausted email
  // budget is answered here too, so a burst of requests never reaches Stripe.
  const counted = await env.DB.prepare(`INSERT INTO invoice_email_log (user_id,kind,at) SELECT ?,'request',?
    WHERE (SELECT COUNT(*) FROM invoice_email_log WHERE user_id=? AND kind='request' AND at>?)<?`)
    .bind(user.id, now, user.id, now - HOUR_MS, INVOICE_EMAIL_LIMITS.requestsPerHour).run();
  if (counted.meta.changes !== 1) return tooMany((await invoiceEmailWait(env, user.id, now)) ?? HOUR_MS);
  const exhausted = await invoiceEmailWait(env, user.id, now, true);
  if (exhausted !== null) return tooMany(exhausted);
  const owned = await customersOf(env, user.id);
  let invoice: CustomerInvoice | null;
  try { invoice = await stripeClient(cfg(env), deps.stripeFetch).getCustomerInvoice(invoiceId); } catch (e) { return stripeFailed(e); }
  const mine = invoice && invoice.status !== "draft" ? owned.find((c) => c.customer === invoice!.customer) : undefined;
  if (!invoice || !mine) throw new HTTPError(404, "not_found");
  if (!invoice.hostedInvoiceUrl) throw new HTTPError(409, "invoice_unavailable");
  const label = invoice.number ?? invoice.id;
  const text = [`Here is your Murage Cloud invoice ${label} (${isoDate(invoice.created * 1000)}).`, "",
    `Open it to view, print or download the PDF:`, invoice.hostedInvoiceUrl, "",
    `You asked for this from your account page. If it was not you, you can ignore this email: the link only works for someone who has this message.`].join("\n");
  const data = { invoiceId: invoice.id, emailSubject: `Murage Cloud: your invoice ${label}`, emailText: text, emailHtml: htmlOf(text) };
  // One mail per invoice per minute (a second press in the same minute is the same notice); the notice is recorded first so a failed send is retried.
  const key = `${invoice.id}:${Math.floor(now / 60_000)}`;
  const id = noticeId("invoice_link", mine.home, key);
  // A new email spends one unit of the account's email budget, in the same batch that records it: the 'send' row is written only while the
  // hourly and daily budget allows and this exact email is not already recorded, and the notice only if that row was (changes()=1).
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO invoice_email_log (user_id,kind,at) SELECT ?,'send',? WHERE NOT EXISTS (SELECT 1 FROM billing_notices WHERE id=?)
      AND ${sendsSql("?")}<? AND ${sendsSql("?")}<?`)
      .bind(user.id, now, id, user.id, now - HOUR_MS, INVOICE_EMAIL_LIMITS.sendsPerHour, user.id, now - DAY_MS, INVOICE_EMAIL_LIMITS.sendsPerDay),
    ...[recordNotice(mine.home, "invoice_link", key, data, now, true)].map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))),
  ]);
  if (!await env.DB.prepare("SELECT 1 AS x FROM billing_notices WHERE id=?").bind(id).first()) {
    return tooMany((await invoiceEmailWait(env, user.id, now, true)) ?? HOUR_MS);
  }
  let sent = true;
  try { await notify(env, deps, mine.home, "invoice_link", key, data); } catch { sent = false; }
  return json({ sent, queued: !sent, invoiceId: invoice.id });
}

export async function journeyRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const only = (method: string) => { if (request.method !== method) throw new HTTPError(405, "method_not_allowed"); };
  if (path === "/v1/account/cancel-plan/reason") { only("POST"); return cancelReason(request, env, deps, auth); }
  if (path === "/v1/account/refund-request") { only("POST"); return refundRequest(request, env, deps, auth); }
  if (path === "/v1/account/invoices") { only("GET"); return listInvoices(request, env, deps, auth); }
  const email = /^\/v1\/account\/invoices\/([^/]+)\/email$/.exec(path);
  if (email) { only("POST"); return emailInvoice(request, env, deps, auth, email[1]); }
  return null;
}
