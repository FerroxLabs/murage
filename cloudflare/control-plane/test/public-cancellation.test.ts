// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP8 (plan Test 5): the public 312k cancellation over the real worker + D1. Stripe, the identity reader and the mailer are fakes.
// No login anywhere: no request below carries a credential except the operator's admin token on the /v1/admin routes.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { clearPublicHandlers, publicRoute, setPublicRouteDeps } from "../src/public-routes";
import { stubFluxHooks, type BillingNotifier } from "../src/b5-billing";
import { addMonthsUtc, berlin, fmtDate, fmtReceived, MISSING_DE, periodContaining, S } from "../src/cancellation-strings";
import { decideReason, flushMail, keepPlan, reconcileSubscription, registerCancellation, renderReceipt, resumeHeld, setCancellationDeps, sweepCancellations } from "../src/public-cancellation";
import { anchoredMonthUtc, workingDaysAfter } from "../src/cancellation-strings";
import { StripeError, stripeClient } from "../src/b5-stripe";
import { needsStepUp } from "../src/customer-identity";
import { advanceRefundOp, type RefundContext } from "../src/legal-refunds";
import type { StripeClient } from "../src/b5-stripe";
import { issueToken, sweepPublicTokens, type IdentityRead } from "../src/public-tokens";
import { dropSink, engagedSink, installSink, realSends, sunk } from "./sink-fixture";

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const USER = "wp8-owner";
const SUBJ = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";   // the Supabase user id
const HOME = "wp8-home";
const SUBID = "sub_wp8";
const CUS = "cus_wp8";
const IMAGE = `sha256:${"a".repeat(64)}`;
const ADMIN = "wp8-admin-token";
// The paid month ends on day <= 28 at 12:00 UTC about 20 days from now, so month arithmetic is exact whatever day the suite runs.
const RAW_END = new Date(NOW + 20 * DAY);
const P_END = Date.UTC(RAW_END.getUTCFullYear(), RAW_END.getUTCMonth(), Math.min(RAW_END.getUTCDate(), 28), 12);
const P_START = addMonthsUtc(P_END, -1);
const P_END_2 = addMonthsUtc(P_END, 1);

let cur: number;
let stripeBlocked = false;
let supa: IdentityRead;
let readerDown = false;
let onRead: (() => Promise<void>) | null = null;
const reader = { async emailGen(): Promise<IdentityRead> { if (onRead) { const f = onRead; onRead = null; await f(); } if (readerDown) throw new Error("down"); return { ...supa }; } };
interface Mail { to: string; subject: string; text: string }
let mails: Mail[];
let calls: { op: string; [k: string]: unknown }[];
let paid: Record<string, unknown>[];
let invoiceById: Record<string, { id: string; status?: string; amount_paid: number; tax: number; payment_intent: string | null }>;
let identifiers: Record<string, string[]>;
let refunds: { id: string; amount: number }[];
let notes: { id: string; invoice: string; amount: number; refund: string | null; status: string; metadata: Record<string, string> }[];
// Stripe's subscription as the fake keeps it (read back by the reconciliation), drafts held back by a pause, and failure switches.
let subState: { status: string; cancel_at: number | null; pause_collection: string | null };
let drafts: { id: string; auto_advance: boolean; created: number; status?: string; start?: number; end?: number }[];
let refundBlocked = false;
let failCancelAtOnce: StripeError | null = null;
let onGet: (() => Promise<void>) | null = null;
// r2: release failures (each a failure Stripe cached against its key), a hook inside setCancelAt, Stripe ignoring cancel_at, the status
// new refunds get, and a mailer whose acknowledgement is lost after it delivered.
let failRelease: StripeError[] = [];
let onSetCancelAt: (() => Promise<void>) | null = null;
let ignoreCancelAt = false;
let refundStatusNext = "succeeded";
let ackLost = 0;
// r3: void failures (each cached against its key), and the keys of setCancelAt calls still outstanding (Stripe answers a second request
// under a key whose first request has not finished with 409 idempotency_key_in_use).
let failVoid: StripeError[] = [];
const inFlightKeys = new Set<string>();
// r4: a hook run when Stripe cancels the subscription (after it switched collection off on the draft and open invoices).
let onCancel: (() => void) | null = null;
// r4: invoice reads failing in transport (no Stripe answer at all).
let invoiceReadDown = false;
// r4: invoice ids whose read comes back incomplete (open, auto_advance missing).
const incompleteRead = new Set<string>();
const draftView = (x: { id: string; auto_advance: boolean; created: number; status?: string; start?: number; end?: number }) => ({ id: x.id, status: x.status ?? "draft", auto_advance: x.auto_advance,
  created: x.created, amount_paid: 0, amount_due: 9900, tax: 0, payment_intent: null, subscription: SUBID, billing_reason: "subscription_cycle", subscriptionMetadata: {},
  lines: { data: x.start !== undefined ? [{ price: "price_pro", proration: false, subscription: SUBID, item: null, source: "subscription",
    period: { start: Math.floor(x.start / 1000), end: Math.floor(x.end! / 1000) }, amount: 9900 }] : [], has_more: false } });

const invoice = (id: string, createdMs: number, startMs: number, endMs: number, cents = 9900) => ({ id, status: "paid", amount_paid: cents, amount_due: 0, auto_advance: false, subscription: SUBID,
  billing_reason: "subscription_cycle", payment_intent: `pi_${id}`, tax: 0, created: Math.floor(createdMs / 1000), subscriptionMetadata: {},
  lines: { data: [{ price: "price_pro", proration: false, subscription: SUBID, item: null, source: "subscription", period: { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) }, amount: cents }], has_more: false } });
function addInvoice(i: ReturnType<typeof invoice>) { paid.push(i); invoiceById[i.id] = { id: i.id, status: i.status, amount_paid: i.amount_paid, tax: 0, payment_intent: i.payment_intent }; }

const fakeStripe = {
  setCancelAt: async (id: string, at: number | null, key?: string) => {
    calls.push({ op: "setCancelAt", id, at, key });
    if (key && inFlightKeys.has(key)) throw new StripeError(409, "idempotency_key_in_use", { inFlight: true });
    if (key) inFlightKeys.add(key);
    try {
      if (onSetCancelAt) { const f = onSetCancelAt; onSetCancelAt = null; await f(); }
      if (failCancelAtOnce) { const e = failCancelAtOnce; failCancelAtOnce = null; throw e; }
      if (!ignoreCancelAt) subState.cancel_at = at;
      return { id };
    } finally { if (key) inFlightKeys.delete(key); }
  },
  setPauseCollection: async (id: string, behavior: string | null, key: string) => { calls.push({ op: "pause", id, behavior, key }); subState.pause_collection = behavior; return { id }; },
  // Stripe's documented behaviour (Astra WP8-4 #1): cancelling a subscription switches auto_advance off on its draft and open invoices.
  cancelSubscription: async (id: string) => {
    if (stripeBlocked) throw new Error("stripe down"); calls.push({ op: "cancel", id }); subState.status = "canceled";
    for (const x of drafts) if ((x.status ?? "draft") === "draft" || x.status === "open") x.auto_advance = false;
    if (onCancel) { const f = onCancel; onCancel = null; f(); }
    return { id, status: "canceled" };
  },
  getSubscription: async (id: string) => { if (onGet) { const f = onGet; onGet = null; await f(); } return { id, status: subState.status, current_period_start: Math.floor(P_START / 1000), current_period_end: Math.floor(P_END / 1000),
    cancel_at: subState.cancel_at, pause_collection: subState.pause_collection }; },
  customersForIdentifier: async (i: string) => identifiers[i] ?? [],
  listPaidInvoices: async () => ({ data: paid }),
  listSubscriptionInvoices: async (_id: string, status: string) => (status === "paid" ? paid : drafts.filter((x) => (x.status ?? "draft") === "draft").map(draftView)),
  setInvoiceAutoAdvance: async (id: string, on: boolean, key: string) => {
    calls.push({ op: "autoAdvance", id, on, key });
    const fail = failRelease.shift(); if (fail) throw fail;
    const x = drafts.find((v) => v.id === id); if (x) x.auto_advance = on; return { id };
  },
  finalizeInvoice: async (id: string, key: string) => { calls.push({ op: "finalize", id, key }); const x = drafts.find((v) => v.id === id)!; x.status = "open"; return { id, status: "open" }; },
  voidInvoice: async (id: string, key: string) => { calls.push({ op: "void", id, key }); const fail = failVoid.shift(); if (fail) throw fail; const x = drafts.find((v) => v.id === id)!; x.status = "void"; return { id, status: "void" }; },
  getInvoice: async (id: string) => {
    if (invoiceReadDown) throw new Error("network down");
    const x = drafts.find((v) => v.id === id);
    if (x && incompleteRead.has(id)) return { ...draftView(x), status: "open", auto_advance: null };
    return x ? draftView(x) : invoiceById[id];
  },
  listRefunds: async (pi: string) => ({ data: refunds.filter((r) => (r as unknown as { pi: string }).pi === pi) }),
  getRefund: async (id: string) => refunds.find((r) => r.id === id)!,
  createRefund: async (i: { paymentIntent: string; amountCents?: number }) => {
    if (refundBlocked) throw new Error("stripe down"); const r = { id: `re_${refunds.length + 1}`, amount: i.amountCents ?? 0, pi: i.paymentIntent, status: "succeeded", payment_intent: i.paymentIntent, metadata: {} }; refunds.push(r); calls.push({ op: "refund", amount: r.amount }); return r; },
  listCreditNotes: async (invoiceId: string) => ({ data: notes.filter((n) => n.invoice === invoiceId) }),
  getCreditNote: async (id: string) => notes.find((n) => n.id === id)!,
  createCreditNote: async (i: { invoiceId: string; amountCents: number; opId: string; submission: number }) => {
    if (refundBlocked) throw new Error("stripe down");
    const r = { id: `re_${refunds.length + 1}`, amount: i.amountCents, pi: invoiceById[i.invoiceId].payment_intent, status: refundStatusNext }; refunds.push(r as never);
    const n = { id: `cn_${notes.length + 1}`, status: "issued", invoice: i.invoiceId, amount: i.amountCents, refund: r.id, metadata: { op_id: i.opId, submission: String(i.submission) } };
    notes.push(n); calls.push({ op: "credit_note", amount: i.amountCents, invoice: i.invoiceId }); return n;
  },
} as unknown as StripeClient;
const notifier: BillingNotifier = { notify: async () => undefined };
let mailFail = 0;
const mailer = { async send(m: Mail & { from: unknown; html: string }) {
  if (mailFail > 0) { mailFail -= 1; throw new Error("smtp down"); }
  mails.push({ to: m.to, subject: m.subject, text: m.text });
  if (ackLost > 0) { ackLost -= 1; throw new Error("delivered, acknowledgement lost"); }
} };

const worker = createWorker();
let sinkOn = false;   // the staging mail sink engaged and no injected mailer (Astra TRUSTCODE-1 P3-3)
const testEnv = () => ({ ...env, ...(sinkOn ? engagedSink() : {}), IDENTITY_READER: reader, CLOUD_ADMIN_TOKEN: ADMIN, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;
let ipCounter = 0;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${(ipCounter++ % 250) + 1}`, ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* html */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const post = (path: string, body: unknown, headers?: Record<string, string>) => call("POST", path, body, headers);
const adminPost = (path: string, body: unknown) => call("POST", path, body, { authorization: `Bearer ${ADMIN}` });
const base = { type: "end_of_paid_month", email: "pat@example.test", name: "Pat Q", confirmationEmail: "pat@example.test" };
const submit = (over: Record<string, unknown> = {}, headers?: Record<string, string>) => post("/v1/public/cancellation", { ...base, ...over }, headers);
const row = async (id: string) => (await env.DB.prepare("SELECT * FROM cancellation_requests WHERE id=?").bind(id).first<Record<string, unknown>>())!;
const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const hold = (token: { selector: string; secret: string }) => post("/v1/public/withdrawal/repudiate", token);
async function holdToken(id: string): Promise<{ selector: string; secret: string }> {
  const m = mails.map((x) => /verify#([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/.exec(x.text)).filter(Boolean).pop();
  expect(m, "a mail with the hold link").toBeTruthy();
  void id;
  return { selector: m![1], secret: m![2] };
}
const setClock = (ms: number) => { cur = ms; };

beforeEach(async () => {
  cur = NOW; supa = { id: SUBJ, email: "pat@example.test", updatedAt: "2026-10-01T00:00:00.000Z" }; readerDown = false;
  stripeBlocked = false; refundBlocked = false; failCancelAtOnce = null; onGet = null; mailFail = 0; mails = [];
  onRead = null; failRelease = []; failVoid = []; inFlightKeys.clear(); onSetCancelAt = null; ignoreCancelAt = false; refundStatusNext = "succeeded"; ackLost = 0; onCancel = null; invoiceReadDown = false; incompleteRead.clear();
  subState = { status: "active", cancel_at: null, pause_collection: null }; drafts = []; calls = []; paid = []; invoiceById = {}; identifiers = {}; refunds = []; notes = [];
  addInvoice(invoice("in_cur", P_START, P_START, P_END));
  setCancellationDeps({ now: () => cur, reader, stripe: fakeStripe, mailer, billing: { notifier }, siteOrigin: "https://murage.test" });
  clearPublicHandlers(); registerCancellation();
  // Token expiry runs on the test clock too (Astra WP8-1 fixture defect: it ran on Date.now while the cancellation used `cur`).
  setPublicRouteDeps({ now: () => cur, reader });
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'Pat', 'cloud-wp8@cloud-account.invalid',1,?,?)`).bind(USER, NOW, NOW),
    env.DB.prepare(`INSERT OR IGNORE INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)`).bind(SUBJ, USER, NOW, "pat@example.test"),
    env.DB.prepare(`INSERT OR IGNORE INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(HOME, "inst-wp8", USER, IMAGE, NOW, NOW),
    env.DB.prepare(`INSERT OR IGNORE INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at)
      VALUES (?,?,?,'pro','active',?,?,?,?)`).bind(HOME, CUS, SUBID, P_START, P_END, NOW, NOW),
  ]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe("pure helpers", () => {
  it("Berlin time: MEZ in winter, MESZ in summer, switching at 01:00 UTC on the last Sunday of March and October", () => {
    expect(berlin(Date.UTC(2026, 0, 15, 12)).label).toBe("MEZ");
    expect(berlin(Date.UTC(2026, 6, 15, 12)).label).toBe("MESZ");
    expect(berlin(Date.UTC(2026, 2, 29, 0, 59)).label).toBe("MEZ");
    expect(berlin(Date.UTC(2026, 2, 29, 1, 0)).label).toBe("MESZ");
    expect(berlin(Date.UTC(2026, 9, 25, 0, 59)).label).toBe("MESZ");
    expect(berlin(Date.UTC(2026, 9, 25, 1, 0)).label).toBe("MEZ");
  });
  it("received_at: UTC in English; MEZ/MESZ followed by UTC in German", () => {
    expect(fmtReceived(Date.UTC(2026, 9, 11, 14, 3, 22), "en")).toBe("2026-10-11 14:03:22 UTC");
    expect(fmtReceived(Date.UTC(2026, 9, 11, 14, 3, 22), "de")).toBe("11.10.2026 16:03:22 MESZ (14:03:22 UTC)");
    expect(fmtReceived(Date.UTC(2026, 11, 11, 14, 3, 22), "de")).toBe("11.12.2026 15:03:22 MEZ (14:03:22 UTC)");
    expect(fmtReceived(Date.UTC(2026, 9, 11, 23, 30, 0), "de")).toBe("12.10.2026 01:30:00 MESZ (23:30:00 UTC)");
    expect(fmtDate(Date.UTC(2026, 10, 10), "de")).toBe("10.11.2026");
  });
  it("paid months: the period containing an instant, rolled by calendar months and anchored on the end day", () => {
    const p = { start: Date.UTC(2026, 9, 31), end: Date.UTC(2026, 10, 30) };
    expect(periodContaining(p, Date.UTC(2026, 10, 1))).toEqual(p);
    expect(periodContaining(p, Date.UTC(2026, 11, 5))!.end).toBe(Date.UTC(2026, 11, 31));      // anchor 31: Nov 30 -> Dec 31 (Astra WP8-1 #6)
    expect(periodContaining(p, Date.UTC(2026, 8, 5))!.end).toBe(Date.UTC(2026, 8, 30));
    expect(periodContaining(p, Date.UTC(2026, 9, 5))!.end).toBe(Date.UTC(2026, 9, 31));
    expect(addMonthsUtc(Date.UTC(2026, 0, 31), 1)).toBe(Date.UTC(2026, 1, 28));
    expect(periodContaining(p, p.end)!.start).toBe(p.end);          // the instant a period ends belongs to the next one
  });
});

describe("Test 5: the three types, matched", () => {
  it("end_of_paid_month: effective_at = the end of the paid month at received_at, cancel_at = effective_at, hold_until = effective_at", async () => {
    const r = await submit();
    expect(r.status).toBe(201);
    const q = await row(r.body.id as string);
    expect(q).toMatchObject({ kind: "ordinary_earliest", status: "open", match_state: "matched", attribution_basis: "account_email", received_at: NOW, effective_at: P_END, hold_until: P_END,
      subscription_id: SUBID, stripe_synced: 1 });
    expect(calls.filter((c) => c.op === "setCancelAt")).toEqual([expect.objectContaining({ id: SUBID, at: P_END / 1000 })]);
  });
  it("on_date: the end of the paid month that includes the date (here the second month); a date inside the first month gives the first", async () => {
    const later = new Date(P_END + 5 * DAY).toISOString().slice(0, 10);
    const a = await submit({ type: "on_date", requestedDate: later });
    expect(await row(a.body.id as string)).toMatchObject({ kind: "ordinary_date", effective_at: P_END_2, requested_date: later, status: "open" });
    const inFirst = new Date(NOW + 3 * DAY).toISOString().slice(0, 10);
    const b = await submit({ type: "on_date", requestedDate: inFirst });
    expect(await row(b.body.id as string)).toMatchObject({ effective_at: P_END });
    expect(calls.filter((c) => c.op === "setCancelAt").map((c) => c.at)).toEqual([P_END_2 / 1000, P_END / 1000]);
  });
  it("now_for_cause: reason_pending, legal date received_at, fallback = the paid month end, hold_until open; the reason check is queued; nothing is ended", async () => {
    const r = await submit({ type: "now_for_cause", reason: "I was charged twice and cannot use the service." });
    const q = await row(r.body.id as string);
    expect(q).toMatchObject({ kind: "extraordinary", status: "reason_pending", effective_at: NOW, fallback_end_at: P_END, hold_until: null });
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.reason_check'")).toBe(1);
  });
  it("validation: a date in the past, a missing reason, an unknown type and extra fields are refused with {error}", async () => {
    expect((await submit({ type: "on_date", requestedDate: new Date(NOW - 2 * DAY).toISOString().slice(0, 10) })).body).toEqual({ error: "invalid_request" });
    expect((await submit({ type: "on_date" })).status).toBe(400);
    expect((await submit({ type: "now_for_cause" })).body).toEqual({ error: "invalid_request" });
    expect((await submit({ type: "whenever" })).status).toBe(400);
    expect((await submit({ extra: 1 })).status).toBe(400);
    expect((await call("GET", "/v1/public/cancellation")).status).toBe(405);
  });
});

describe("Test 5: matched and unmatched senders", () => {
  it("the 201 answer is identical for a matched and an unmatched email (no account oracle), apart from id, time and receipt url", async () => {
    const a = await submit();
    const b = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
    const strip = (x: Record<string, unknown>) => ({ ...x, id: "x", receivedAt: 0, receiptUrl: "x" });
    expect(a.status).toBe(201);
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(a.body).toMatchObject({ type: "end_of_paid_month", matched: false, effectiveAt: null });
    expect(a.body.receiptUrl).toBe(`/cancel/receipt/${a.body.id}`);
  });
  it("the receipt page does not differ for a matched and an unmatched declaration either", async () => {
    const a = await submit({ name: "Same Name" }); const b = await submit({ email: "nobody@example.test", confirmationEmail: "pat@example.test", name: "Same Name" });
    const ra = (await call("GET", `/v1/public/cancellation/${a.body.id}/receipt`)).text; const rb = (await call("GET", `/v1/public/cancellation/${b.body.id}/receipt`)).text;
    const norm = (t: string, id: string) => t.replace(id, "ID").replace(/CX-[A-Z0-9]{8}/g, "REF").replace(/pat@example\.test|nobody@example\.test/g, "EMAIL");
    expect(norm(ra, a.body.id as string)).toBe(norm(rb, b.body.id as string));
  });
  it("unmatched: stays pending support identification; the declarant gets the unmatched text word for word; no account mail goes out", async () => {
    const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test", requestedDate: undefined });
    const q = await row(r.body.id as string);
    expect(q).toMatchObject({ match_state: "unmatched", status: "open", effective_at: null, attributed_at: null });
    expect(calls).toEqual([]);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("nobody@example.test");
    expect(mails[0].text).toContain(`We received your cancellation on ${fmtReceived(NOW, "en")}. You asked to end your plan at the end of the month you have paid for. Your plan ends at the end of the month you have paid for that was running on ${fmtReceived(NOW, "en")}. We are finding your plan and will send the exact date.`);
  });
  it("unmatched, German: the same text in the plan's German", async () => {
    await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test", language: "de", type: "now_for_cause", reason: "Grund" });
    expect(mails[0].text).toContain(`Wir haben Ihre Kündigung am ${fmtReceived(NOW, "de")} erhalten. Sie haben verlangt, Ihren Plan sofort aus wichtigem Grund zu beenden. Ihr Plan endet am ${fmtReceived(NOW, "de")}, wenn wir Ihren Grund annehmen, sonst am Ende des bezahlten Monats. Wir suchen Ihren Plan und senden Ihnen das genaue Datum.`);
  });
  it("an identifier that Stripe knows attributes the declaration by itself (basis identifier); one that matches nothing does not", async () => {
    identifiers["INV-0042"] = [CUS];
    const ok = await submit({ email: "someone.else@example.test", confirmationEmail: "someone.else@example.test", identifier: "INV-0042" });
    expect(await row(ok.body.id as string)).toMatchObject({ match_state: "matched", attribution_basis: "identifier", effective_at: P_END, account_id: USER });
    const no = await submit({ email: "someone.else@example.test", confirmationEmail: "someone.else@example.test", identifier: "INV-9999" });
    expect(await row(no.body.id as string)).toMatchObject({ match_state: "unmatched", attributed_at: null });
  });
  it("an email shared by two live plans is not guessed: the declaration waits for support", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES ('wp8-home2','inst-2',?,'ready','ready',?,'k',?,?)`).bind(USER, IMAGE, NOW, NOW),
      env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at) VALUES ('wp8-home2','cus2','sub2','pro','active',?,?,?,?)`).bind(P_START, P_END, NOW, NOW),
    ]);
    const r = await submit();
    expect(await row(r.body.id as string)).toMatchObject({ match_state: "unmatched" });
  });
  it("support identifies the plan: attribution_basis support, the frozen received_at governs, the account email hears with 'This wasn't me'; customer_reconfirmed cannot exist", async () => {
    const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
    const id = r.body.id as string;
    setClock(NOW + 2 * DAY);
    mails = [];
    expect((await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "customer_reconfirmed" })).status).toBe(400);
    expect((await post(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" })).status).toBe(401);
    const a = await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    expect(a.status).toBe(200);
    expect(await row(id)).toMatchObject({ match_state: "matched", attribution_basis: "support", received_at: NOW, effective_at: P_END, attributed_at: NOW + 2 * DAY });
    expect(mails.map((m) => m.to).sort()).toEqual(["nobody@example.test", "pat@example.test"]);
    expect(mails.find((m) => m.to === "pat@example.test")!.text).toContain("If this wasn't you, press This wasn't me.");
    expect(mails.find((m) => m.to === "nobody@example.test")!.text).not.toContain("press This wasn't me");
    expect((await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" })).status).toBe(409);
    await expect(env.DB.prepare("UPDATE cancellation_requests SET attribution_basis='customer_reconfirmed' WHERE id=?").bind(id).run()).rejects.toThrow();
  });
  it("r1 #13: identification is queued at receipt; with no candidate plan (renewal unknown) it is urgent at once, once", async () => {
    await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.identify'")).toBe(1);
    await sweepCancellations(env); await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.unidentified'")).toBe(1);
  });
  it("r1 #13: with candidate plans the urgent escalation is 3 days before the earliest renewal, not 3 days after receipt", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES ('wp8-home2','inst-2',?,'ready','ready',?,'k',?,?)`).bind(USER, IMAGE, NOW, NOW),
      env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at) VALUES ('wp8-home2','cus2','sub2','pro','active',?,?,?,?)`).bind(P_START, P_END, NOW, NOW),
    ]);
    const r = await submit();                  // two live plans: not guessed
    expect(await row(r.body.id as string)).toMatchObject({ match_state: "unmatched", identify_due_at: P_END - 3 * DAY });
    setClock(P_END - 3 * DAY - 1000); await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.unidentified'")).toBe(0);
    setClock(P_END - 3 * DAY); await sweepCancellations(env); await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.unidentified'")).toBe(1);
  });
  it("rate limit: the sixth request in an hour from one email is refused 429 {error}; so is the sixth from one IP", async () => {
    for (let i = 0; i < 5; i += 1) expect((await submit({ email: "limit@example.test", confirmationEmail: "limit@example.test" })).status).toBe(201);
    expect(await submit({ email: "limit@example.test", confirmationEmail: "limit@example.test" })).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    await env.DB.prepare("DELETE FROM public_mail_limits").run();
    for (let i = 0; i < 5; i += 1) expect((await submit({ email: `ip${i}@example.test`, confirmationEmail: "a@example.test" }, { "cf-connecting-ip": "198.51.100.7" })).status).toBe(201);
    expect((await submit({ email: "ip9@example.test", confirmationEmail: "a@example.test" }, { "cf-connecting-ip": "198.51.100.7" })).status).toBe(429);
  });
});

describe("Test 5: receipt contents and time zones", () => {
  it("the receipt holds the declaration, every field as entered, the type, received_at in UTC (en), the reference; its SHA-256 is the stored one", async () => {
    const r = await submit({ name: "Pat <b>Q</b>", identifier: "INV-1", type: "now_for_cause", reason: "Serious & real" });
    const id = r.body.id as string;
    const g = await call("GET", `/v1/public/cancellation/${id}/receipt`);
    expect(g.status).toBe(200);
    expect(g.headers.get("content-type")).toContain("text/html");
    expect(g.text).toContain(`This is your cancellation declaration, made by pressing Cancel now on ${fmtReceived(NOW, "en")}, the time we received it.`);
    for (const piece of ["pat@example.test", "Pat &lt;b&gt;Q&lt;/b&gt;", "INV-1", "Serious &amp; real", "End my plan now for a serious reason", (await row(id)).ref as string, "UTC"]) expect(g.text).toContain(piece);
    const q = await row(id);
    const bytes = new TextEncoder().encode(g.text);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
    expect(sha).toBe(q.receipt_sha256);
    expect((await call("GET", "/v1/public/cancellation/00000000000000000000000000000000/receipt")).status).toBe(404);
    expect((await call("POST", `/v1/public/cancellation/${id}/receipt`, {})).status).toBe(405);
  });
  it("German receipt: the plan's sentence, MEZ/MESZ followed by UTC, the German field labels", async () => {
    const r = await submit({ language: "de", identifier: "INV-1" });
    const g = (await call("GET", `/v1/public/cancellation/${r.body.id}/receipt`)).text;
    expect(g).toContain(`Dies ist Ihre Kündigungserklärung, abgegeben durch Drücken von „Jetzt kündigen“ am ${fmtReceived(NOW, "de")}, dem Zeitpunkt, zu dem wir sie erhalten haben.`);
    expect(g).toMatch(/ME(S)?Z \(\d\d:\d\d:\d\d UTC\)/);
    for (const label of ["E-Mail-Adresse Ihres Murage-Kontos", "Ihr Name", "Etwas anderes, das Ihren Plan identifiziert (optional): Rechnungsnummer oder die E-Mail-Adresse auf Ihrer Quittung",
      "E-Mail-Adresse für Ihre Bestätigung", "Herunterladen", "Zum Ende des bezahlten Monats kündigen"]) expect(g).toContain(label);
  });
  it("renderReceipt is a pure function of the stored fields", () => {
    const f = { id: "a".repeat(32), ref: "CX-AAAAAAAA", received_at: Date.UTC(2026, 11, 11, 14, 3, 22), kind: "ordinary_date" as const, requested_date: "2027-01-15", reason: null,
      entered_email: "a@b.test", entered_name: "A", identifier: null, confirm_email: "a@b.test", language: "de" as const };
    expect(renderReceipt(f)).toBe(renderReceipt({ ...f }));
    expect(renderReceipt(f)).toContain("15.01.2027");
    expect(renderReceipt(f)).toContain("11.12.2026 15:03:22 MEZ (14:03:22 UTC)");
  });
});

describe("Test 5: the durable confirmation is sent at once", () => {
  it("matched, same address: one mail, with the paid-month end sentence and the 'This wasn't me' link", async () => {
    await submit();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("pat@example.test");
    expect(mails[0].text).toContain(`Your plan ends on ${fmtDate(P_END, "en")}.`);
    expect(mails[0].text).toContain("If this wasn't you, press This wasn't me.");
    expect(mails[0].text).toMatch(/https:\/\/murage\.test\/verify#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/);
  });
  it("matched, another confirmation address: that address gets the declaration without the link, the account email gets it with the link", async () => {
    await submit({ confirmationEmail: "friend@example.test" });
    expect(mails.map((m) => m.to).sort()).toEqual(["friend@example.test", "pat@example.test"]);
    expect(mails.find((m) => m.to === "friend@example.test")!.text).not.toContain("verify#");
    expect(mails.find((m) => m.to === "friend@example.test")!.text).toContain(`Your plan ends on ${fmtDate(P_END, "en")}.`);
  });
  it("chosen date: both the asked date and the legal end date appear", async () => {
    const d = new Date(P_END + 5 * DAY).toISOString().slice(0, 10);
    await submit({ type: "on_date", requestedDate: d });
    expect(mails[0].text).toContain(`You asked to end your plan on ${d}. It ends on ${fmtDate(P_END_2, "en")}, the end of the month you have paid for that includes that date.`);
  });
  it("serious reason: the text names received_at and BOTH end dates (accepted: received_at; rejected: the paid month end)", async () => {
    await submit({ type: "now_for_cause", reason: "Serious", language: "de" });
    expect(mails[0].text).toContain(`Sie haben verlangt, Ihren Plan sofort zu beenden, zum ${fmtReceived(NOW, "de")}. Wir prüfen Ihren Grund innerhalb von 3 Werktagen. Wenn wir ihn annehmen, endete Ihr Plan am ${fmtReceived(NOW, "de")} und wir erstatten die ungenutzten Tage. Wenn nicht, endet er am ${fmtDate(P_END, "de")} und wir sagen Ihnen, warum.`);
    expect(mails[0].text).toContain("Falls Sie das nicht waren, drücken Sie Das war ich nicht.");
  });
  it("a mail that cannot be sent stays queued and goes out on the next sweep, once", async () => {
    readerDown = true;
    await submit({ confirmationEmail: "friend@example.test" });
    expect(mails.map((m) => m.to)).toEqual(["friend@example.test"]);          // the account mail needs the reader
    readerDown = false;
    await sweepCancellations(env); await sweepCancellations(env);
    expect(mails.filter((m) => m.to === "pat@example.test")).toHaveLength(1);
  });
});

describe("Test 5: the reason check", () => {
  async function pending() {
    const r = await submit({ type: "now_for_cause", reason: "Serious reason" });
    return r.body.id as string;
  }
  it("accepted: ends at received_at, the unused days are refunded pro rata (extraordinary, frozen values), the plan is cancelled, status completed", async () => {
    const id = await pending();
    setClock(NOW + DAY);
    mails = [];
    const r = await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" });
    expect(r.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "completed", reason_decision: "accept", effective_at: NOW });
    const op = (await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(`cxl-ext:${id}`).first<Record<string, unknown>>())!;
    expect(op).toMatchObject({ kind: "extraordinary", end_plan: 1, cutover_at: NOW, old_invoice_id: "in_cur", old_period_start: P_START, old_period_end: P_END, amount_cents: Math.round(9900 * (P_END - NOW) / (P_END - P_START)) });
    expect(calls.some((c) => c.op === "cancel")).toBe(true);
    expect(mails.some((m) => m.to === "pat@example.test" && m.text.includes("We accepted your reason"))).toBe(true);
    // deciding again is refused
    expect(await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "x" })).toMatchObject({ status: 409, body: { error: "not_reason_pending" } });
  });
  it("rejected: the declaration counts as a cancellation at the end of the paid month at received_at; the reason (note) is told; cancel_at is that date", async () => {
    const id = await pending();
    mails = []; calls = [];
    const r = await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "A price complaint is not a serious reason." });
    expect(r.body).toEqual({ status: "open" });
    expect(await row(id)).toMatchObject({ status: "open", effective_at: P_END, hold_until: P_END, reason_decision: "reject", stripe_synced: 1 });
    expect(calls.filter((c) => c.op === "setCancelAt").map((c) => c.at)).toEqual([P_END / 1000]);
    expect(mails.map((m) => m.to).sort()).toEqual(["pat@example.test", "pat@example.test"]);
    expect(mails[0].text).toContain("A price complaint is not a serious reason.");
    expect(mails[0].text).toContain(fmtDate(P_END, "en"));
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
  });
  it("without a note or with a bad decision the operator route refuses; without the admin token it is 401", async () => {
    const id = await pending();
    expect((await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "maybe" })).status).toBe(400);
    expect((await post(`/v1/admin/cancellations/${id}/reason`, { decision: "accept" })).status).toBe(401);
    expect((await adminPost(`/v1/admin/cancellations/${"f".repeat(32)}/reason`, { decision: "accept" })).status).toBe(404);
    // r1 #14: a rejection needs its reason why
    expect(await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject" })).toMatchObject({ status: 400, body: { error: "note_required" } });
    expect(await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "   " })).toMatchObject({ status: 400, body: { error: "note_required" } });
    expect((await row(id)).status).toBe("reason_pending");
  });
  it("'This wasn't me' during the reason check holds it and stops the check; a later decision is refused", async () => {
    const id = await pending();
    const res = await hold(await holdToken(id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "held", kind: "cancellation", message: "We've put the cancellation on hold and your plan continues. If you do want to cancel, use Cancel your contract here or your account page." });
    expect(await row(id)).toMatchObject({ status: "held", held_from: "reason_pending", case_id: `case-${id}`, keep_at: P_END, effective_at: NOW, received_at: NOW });
    // r1 #3: a reason check never sets cancel_at; it pauses collection, and the hold lifts the pause.
    expect(calls.filter((c) => c.op === "setCancelAt")).toEqual([]);
    expect(calls.filter((c) => c.op === "pause").map((c) => c.behavior)).toEqual(["keep_as_draft", null]);
    expect(await decideReason(env, { now: () => cur, reader, stripe: fakeStripe, mailer }, id, "accept", "")).toEqual({ ok: false, code: "not_reason_pending" });
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
  });
});

describe("Test 5: 'This wasn't me'", () => {
  it("before effective_at: held, case opened, the plan continues (Stripe cancel_at cleared), the legal dates kept, the hold mail sent once; a replay changes nothing", async () => {
    const r = await submit(); const id = r.body.id as string;
    const tok = await holdToken(id);
    mails = [];
    const a = await hold(tok);
    expect(a.body).toMatchObject({ outcome: "held" });
    expect(await row(id)).toMatchObject({ status: "held", received_at: NOW, effective_at: P_END, held_at: NOW, keep_at: P_END, stripe_synced: 1 });
    expect(calls.filter((c) => c.op === "setCancelAt").pop()).toMatchObject({ id: SUBID, at: null });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=?", id)).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toBe("We've put the cancellation on hold and your plan continues. If you do want to cancel, use Cancel your contract here or your account page.");
    const again = await hold(tok);
    expect(again.body).toMatchObject({ outcome: "held" });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=?", id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_mail WHERE kind='held_account'")).toBe(1);
  });
  it("German page copy comes from the committed state", async () => {
    const r = await submit({ language: "de" }); const id = r.body.id as string;
    const a = await hold(await holdToken(id));
    expect(a.body.message).toBe("Wir haben die Kündigung angehalten, und Ihr Plan läuft weiter. Wenn Sie doch kündigen möchten, nutzen Sie „Verträge hier kündigen“ oder Ihre Kontoseite.");
  });
  it("after hold_until the link no longer holds: the end already took effect, a case is opened, copy says when", async () => {
    const r = await submit(); const id = r.body.id as string;
    const tok = await holdToken(id);
    setClock(P_END + 1000);
    const a = await hold(tok);
    expect(a.body).toMatchObject({ outcome: "too_late_completed", effectiveAt: P_END, message: `This cancellation already took effect on ${fmtDate(P_END, "en")}, so we could not put it on hold. We have opened a case and will look at it. You can start a new plan at any time.` });
    expect(await row(id)).toMatchObject({ status: "completed" });     // r1 #11: the due end took effect before the copy says so
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=?", id)).toBe(1);
  });
  it("after the immediate end started: executing, a case is opened, the end stands", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    stripeBlocked = true;
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "" });
    stripeBlocked = false;
    expect((await row(id)).status).toBe("executing");
    const a = await hold(tok);
    expect(a.body).toMatchObject({ outcome: "too_late_executing", message: "This cancellation is already being carried out, so we could not put it on hold. We have opened a case and will look at it." });
    expect((await row(id)).status).toBe("executing");
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=?", id)).toBe(1);
  });
  it("after completion: too_late_completed with the date", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "" });
    expect((await row(id)).status).toBe("completed");
    expect((await hold(tok)).body).toMatchObject({ outcome: "too_late_completed", effectiveAt: NOW });
  });
  it("a link of another account, a wrong secret, a purpose mismatch and a GET are refused; nothing changes", async () => {
    const r = await submit(); const id = r.body.id as string;
    const tok = await holdToken(id);
    expect((await post("/v1/public/withdrawal/repudiate", { selector: tok.selector, secret: "z".repeat(43) })).status).toBe(409);
    expect((await post("/v1/public/withdrawal/confirm", tok)).status).toBe(409);
    expect((await call("GET", "/v1/public/withdrawal/repudiate")).status).toBe(405);
    expect((await row(id)).status).toBe("open");
    supa = { ...supa, email: "changed@example.test" };
    expect(await hold(tok)).toMatchObject({ status: 409, body: { error: "identity_changed" } });
    expect((await row(id)).status).toBe("open");
  });
  it("lookup of the hold link says cancellation and never consumes", async () => {
    const r = await submit(); const id = r.body.id as string;
    const tok = await holdToken(id);
    const l = await post("/v1/public/token/lookup", tok);
    expect(l.body).toMatchObject({ kind: "cancellation", state: "open", planName: "pro", effectiveAt: P_END });
    expect((await row(id)).status).toBe("open");
  });
});

describe("Test 5: hold outcomes", () => {
  it("held and unanswered: closes as kept at effective_at, the plan continues (Stripe stays cleared), the case closes", async () => {
    const r = await submit(); const id = r.body.id as string;
    await hold(await holdToken(id));
    setClock(P_END - DAY); await sweepCancellations(env);
    expect((await row(id)).status).toBe("held");
    setClock(P_END + 1000); await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ status: "kept", stripe_synced: 1 });
    expect(calls.filter((c) => c.op === "setCancelAt").slice(1).every((c) => c.at === null)).toBe(true);
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=? AND outcome='kept'", id)).toBe(1);
  });
  it("a held immediate end closes as kept at the end of the paid month current at received_at", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    await hold(await holdToken(id));
    setClock(P_END - 1000); await sweepCancellations(env);
    expect((await row(id)).status).toBe("held");
    setClock(P_END + 1000); await sweepCancellations(env);
    expect((await row(id)).status).toBe("kept");
  });
  it("found valid before effective_at: back to open with the original dates and cancel_at re-set; no new consent", async () => {
    const r = await submit(); const id = r.body.id as string;
    await hold(await holdToken(id));
    setClock(NOW + 3 * DAY);
    calls = [];
    expect(await resumeHeld(env, { now: () => cur, reader, stripe: fakeStripe, mailer, billing: { notifier } }, id)).toEqual({ ok: true, status: "open" });
    expect(await row(id)).toMatchObject({ status: "open", received_at: NOW, effective_at: P_END, hold_until: P_END });
    expect(calls.filter((c) => c.op === "setCancelAt")).toEqual([expect.objectContaining({ at: P_END / 1000 })]);
    expect((await adminPost(`/v1/admin/cancellations/${id}/resume`, {})).status).toBe(409);
  });
  it("found valid after effective_at: ends now and every renewal charged after effective_at is RECORDED (no amount); an operator executes it (cancellation_late)", async () => {
    const r = await submit(); const id = r.body.id as string;
    await hold(await holdToken(id));
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + 2 * DAY);
    calls = [];
    const res = await adminPost(`/v1/admin/cancellations/${id}/resume`, { note: "entitled" });
    expect(res.body).toEqual({ status: "completed" });
    expect(calls.some((c) => c.op === "cancel")).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    expect(await lateRecords()).toEqual([{ invoice_id: "in_renewal", request_id: id, paid_cents: 9900, hint: "after_end", executed_at: null }]);
    expect((await executeLate("in_renewal", 9900)).status).toBe(200);
    const ops = (await env.DB.prepare("SELECT id,kind,invoice_id FROM refund_ops").all<{ id: string; kind: string; invoice_id: string }>()).results;
    expect(ops).toEqual([{ id: `cxl-late:${id}:in_renewal`, kind: "cancellation_late", invoice_id: "in_renewal" }]);
  });
  it("found valid for a held immediate end: the reason check resumes with its legal date intact", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    await hold(await holdToken(id));
    expect(await resumeHeld(env, { now: () => cur, reader, stripe: fakeStripe, mailer }, id)).toEqual({ ok: true, status: "reason_pending" });
    expect(await row(id)).toMatchObject({ status: "reason_pending", effective_at: NOW, received_at: NOW });
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "" });
    expect(await row(id)).toMatchObject({ status: "completed", effective_at: NOW });
  });
});

describe("Test 5: late charge after the end date", () => {
  it("identification came after a renewal: that renewal is recorded once; the operator refunds it in full by id (cancellation_late), service ends at effective_at, the customer is told", async () => {
    const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" }); const id = r.body.id as string;
    // the plan renewed after the declaration; our record moved to the new month
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?, current_period_end=? WHERE home_id=?").bind(P_END, P_END_2, HOME).run();
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + DAY);
    mails = []; calls = [];
    const a = await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    expect(a.status).toBe(200);
    expect(await row(id)).toMatchObject({ effective_at: P_END, received_at: NOW });
    expect(calls.some((c) => c.op === "cancel")).toBe(true);
    expect(refunds).toHaveLength(0);
    expect(await lateRecords()).toEqual([{ invoice_id: "in_renewal", request_id: id, paid_cents: 9900, hint: "after_end", executed_at: null }]);   // not the invoice before effective_at
    expect((await executeLate("in_renewal", 9900)).status).toBe(200);
    const ops = (await env.DB.prepare("SELECT id,kind,invoice_id,paid_cents,end_plan FROM refund_ops").all<Record<string, unknown>>()).results;
    expect(ops).toEqual([{ id: `cxl-late:${id}:in_renewal`, kind: "cancellation_late", invoice_id: "in_renewal", paid_cents: 9900, end_plan: 1 }]);   // not the invoice before effective_at
    expect(refunds.map((x) => x.amount)).toEqual([9900]);
    expect(mails.some((m) => m.to === "pat@example.test" && m.text.includes("We have refunded it in full"))).toBe(true);
    // idempotent: the sweep and a second check open nothing more
    await sweepCancellations(env); setClock(P_END + 3 * DAY); await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
    expect(refunds).toHaveLength(1);
  });
  it("Astra JOURNEY-BCORE-3 #5: a MIXED invoice and a whole-late one are each ONE record with all their lines and no amount; nothing is refunded by itself", async () => {
    const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" }); const id = r.body.id as string;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?, current_period_end=? WHERE home_id=?").bind(P_END, P_END_2, HOME).run();
    const mixed = invoice("in_mixed", P_END, P_END, P_END_2, 11400);
    mixed.lines.data = [{ price: "price_metered", proration: false, subscription: SUBID, item: null, source: "subscription", period: { start: Math.floor((P_END - DAY) / 1000), end: Math.floor(P_END / 1000) }, amount: 1500, usageType: "metered" } as never,
      { price: "price_pro", proration: false, subscription: SUBID, item: null, source: "subscription", period: { start: Math.floor(P_END / 1000), end: Math.floor(P_END_2 / 1000) }, amount: 9900 } as never];
    addInvoice(mixed);
    addInvoice(invoice("in_whole", P_END, P_END, P_END_2));
    setClock(P_END + DAY);
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    expect(await lateRecords()).toEqual([{ invoice_id: "in_mixed", request_id: id, paid_cents: 11400, hint: "mixed", executed_at: null },
      { invoice_id: "in_whole", request_id: id, paid_cents: 9900, hint: "after_end", executed_at: null }]);
    const snap = JSON.parse((await env.DB.prepare("SELECT snapshot_json FROM cancel_late_refunds WHERE invoice_id='in_mixed'").first<{ snapshot_json: string }>())!.snapshot_json);
    expect(snap.lines.map((l: { amount: number; hint: string }) => [l.amount, l.hint])).toEqual([[1500, "served_usage"], [9900, "after_end"]]);
    await sweepCancellations(env); setClock(P_END + 3 * DAY); await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM cancel_late_refunds")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    expect(refunds).toHaveLength(0);
  });
  it("a refund operation advanced twice at once gives one refund (the op id is the idempotency key)", async () => {
    const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" }); const id = r.body.id as string;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?, current_period_end=? WHERE home_id=?").bind(P_END, P_END_2, HOME).run();
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + DAY);
    // Stripe refuses during attribution, so the operation is still OPEN when the two advances race (the fixture defect: it raced a finished one).
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    refundBlocked = true;
    expect((await executeLate("in_renewal", 9900)).status).toBe(200);
    refundBlocked = false;
    expect(refunds).toHaveLength(0);
    expect(await env.DB.prepare("SELECT done_at FROM refund_ops WHERE id=?").bind(`cxl-late:${id}:in_renewal`).first()).toMatchObject({ done_at: null });
    const ctx: RefundContext = { stripe: fakeStripe, flux: stubFluxHooks, deps: { notifier }, now: cur };
    await Promise.all([advanceRefundOp(env, ctx, `cxl-late:${id}:in_renewal`), advanceRefundOp(env, ctx, `cxl-late:${id}:in_renewal`)]);
    expect(refunds).toHaveLength(1);
  });
});

describe("Test 5: race between hold and execution", () => {
  for (let i = 0; i < 4; i += 1) {
    it(`round ${i}: the press and the accepted reason compete; exactly one outcome, consistently reported`, async () => {
      await env.DB.prepare("DELETE FROM public_mail_limits").run();
      const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
      const tok = await holdToken(id);
      const d = { now: () => cur, reader, stripe: fakeStripe, mailer, billing: { notifier } };
      const [h, a] = await Promise.all([hold(tok), decideReason(env, d, id, "accept", "ok")]);
      const q = await row(id);
      expect(["held", "completed", "executing"]).toContain(q.status);
      expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=?", id)).toBe(1);   // the press opens a case either way
      if (q.status === "held") {
        expect(h.body.outcome).toBe("held"); expect(a.ok).toBe(false);
        expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
        expect(calls.some((c) => c.op === "cancel")).toBe(false);
      } else {
        expect(a.ok).toBe(true);
        expect(["too_late_executing", "too_late_completed"]).toContain(h.body.outcome);
        expect(q.reason_decision).toBe("accept");
      }
      expect(await count("SELECT COUNT(*) AS n FROM cancellation_requests WHERE status='held' AND reason_decision IS NOT NULL")).toBe(0);
    });
  }
  it("two presses of the same link at once: one wins, the other gets the same committed state; one case, one hold mail", async () => {
    const r = await submit(); const id = r.body.id as string;
    const tok = await holdToken(id);
    const [a, b] = await Promise.all([hold(tok), hold(tok)]);
    expect(a.body.outcome).toBe("held"); expect(b.body.outcome).toBe("held");
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_mail WHERE kind='held_account'")).toBe(1);
  });
});

describe("strings", () => {
  it("every string has German (the launch gate is empty)", () => {
    expect(MISSING_DE).toEqual([]);
    for (const k of Object.keys(S) as (keyof typeof S)[]) expect(S[k].de).not.toBeNull();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------------
// Astra WP8-1 round 1: one test (or more) per finding, and the rules the review listed as uncovered.

const HOUR = 3_600_000;
const MINUTE = 60_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const deps8 = () => ({ now: () => cur, reader, stripe: fakeStripe, mailer, billing: { notifier }, siteOrigin: "https://murage.test" });
const alerts = (kind: string) => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=?", kind);
/** Astra JOURNEY-BCORE-3 #5-#8: post-promise charges are records (no amount); an operator executes one by id with the amount they decide. */
const lateRecords = () => env.DB.prepare("SELECT invoice_id,request_id,paid_cents,hint,executed_at FROM cancel_late_refunds ORDER BY invoice_id").all<Record<string, unknown>>().then((r) => r.results);
const executeLate = (inv: string, cents: number) => adminPost(`/v1/admin/cancellations/late-refunds/cxr-late:${SUBID}:${inv}/execute`, { amountCents: cents });
const lateSetup = async () => {
  const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
  await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?, current_period_end=? WHERE home_id=?").bind(P_END, P_END_2, HOME).run();
  return r.body.id as string;
};

describe("r1 #1: no account oracle in time or headers", () => {
  it("the 201 is written before any matching, Stripe call or mail; those run after the answer (waitUntil)", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() { /* */ } } as unknown as ExecutionContext;
    const res = (await publicRoute(new Request("https://cp.test/v1/public/cancellation", { method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.40" }, body: JSON.stringify(base) }), testEnv(), {}, ctx))!;
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect(await row(id)).toMatchObject({ match_state: "pending", status: "open", effective_at: null });
    expect(mails).toEqual([]); expect(calls).toEqual([]);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(await row(id)).toMatchObject({ match_state: "matched", effective_at: P_END });
    expect(mails).toHaveLength(1);
  });
  it("public responses carry no Server-Timing and no D1 bookmark, for a matched and an unmatched sender alike", async () => {
    const a = await submit(); const b = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
    for (const r of [a, b]) { expect(r.headers.get("server-timing")).toBeNull(); expect(r.headers.get("x-d1-bookmark")).toBeNull(); }
    const names = (h: Headers) => { const out: string[] = []; h.forEach((_v, k) => out.push(k)); return out.sort(); };
    expect(names(a.headers)).toEqual(names(b.headers));
    const receiptRes = await call("GET", `/v1/public/cancellation/${a.body.id}/receipt`);
    expect(receiptRes.headers.get("server-timing")).toBeNull();
  });
  it("a pending intake left behind (no waitUntil) is matched by the sweep, its receipt mail carrying the match", async () => {
    const res = (await publicRoute(new Request("https://cp.test/v1/public/cancellation", { method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.41" }, body: JSON.stringify({ ...base, confirmationEmail: "friend@example.test" }) }), testEnv(), {}))!;
    const id = ((await res.json()) as { id: string }).id;
    expect((await row(id)).match_state).toBe("pending");
    await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ match_state: "matched" });
    expect(mails.map((m) => m.to).sort()).toEqual(["friend@example.test", "pat@example.test"]);
    expect(mails.find((m) => m.to === "friend@example.test")!.text).toContain(`Your plan ends on ${fmtDate(P_END, "en")}.`);
  });
});

describe("r1 #2: the hold lasts until hold_until; confirmation never depends on a link", () => {
  it("r2 #1: the link acts until hold_until; pressed after 20 days (past 7 days and receipt + 14 days) it holds at once, no further click", async () => {
    const r = await submit({ type: "on_date", requestedDate: ymd(P_END + 5 * DAY) }); const id = r.body.id as string;
    const tok = await holdToken(id);
    expect(await env.DB.prepare("SELECT expires_at FROM verify_tokens WHERE selector=?").bind(tok.selector).first()).toEqual({ expires_at: P_END_2 });   // = hold_until
    setClock(NOW + 20 * DAY);
    mails = [];
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(await row(id)).toMatchObject({ status: "held", effective_at: P_END_2, received_at: NOW });
    expect(mails.map((m) => m.subject)).toEqual(["Your Murage Cloud cancellation is on hold"]);
  });
  it("attribution after hold_until still sends the account its confirmation (without a link)", async () => {
    const id = await lateSetup();
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + DAY); mails = [];
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    const acct = mails.find((m) => m.to === "pat@example.test" && m.subject === "Your Murage Cloud cancellation");
    expect(acct, "the account confirmation").toBeTruthy();
    expect(acct!.text).not.toContain("verify#");
    expect(acct!.text).toContain(`Your plan ends on ${fmtDate(P_END, "en")}.`);
  });
});

describe("r1 #3: a reason check never ends the plan early", () => {
  it("across the renewal: collection paused, never cancelled; a hold after the renewal lifts the pause and releases the held-back draft", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    expect(subState).toMatchObject({ pause_collection: "keep_as_draft", cancel_at: null, status: "active" });
    drafts.push({ id: "in_draft", auto_advance: false, created: Math.floor(P_END / 1000) });
    setClock(P_END + DAY); await sweepCancellations(env);
    expect((await row(id)).status).toBe("reason_pending");
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    // r2 #1: the first link still acts after the renewal (the hold has no end before the decision): no fresh link, no extra click
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(subState).toMatchObject({ pause_collection: null, cancel_at: null, status: "active" });
    expect(drafts[0].auto_advance).toBe(true);
  });
  it("an accepted reason for a later date is carried out at that date, never earlier; the accepted mail waits until it is true", async () => {
    const later = ymd(P_END + 5 * DAY); const eff = Date.parse(`${later}T00:00:00Z`);
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    const r = await submit({ type: "now_for_cause", reason: "Serious", requestedDate: later }); const id = r.body.id as string;
    setClock(NOW + DAY); mails = [];
    expect((await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" })).body).toEqual({ status: "open" });
    expect(await row(id)).toMatchObject({ status: "open", reason_decision: "accept", effective_at: eff, hold_until: eff });
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    expect(subState).toMatchObject({ cancel_at: null, pause_collection: null });
    expect(mails.some((m) => m.text.includes("We accepted your reason"))).toBe(false);
    setClock(eff - 1000); await sweepCancellations(env);
    expect((await row(id)).status).toBe("open");
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    setClock(eff + 1000); await sweepCancellations(env);
    expect((await row(id)).status).toBe("completed");
    expect(await env.DB.prepare("SELECT cutover_at, old_invoice_id FROM refund_ops WHERE id=?").bind(`cxl-ext:${id}`).first()).toEqual({ cutover_at: eff, old_invoice_id: "in_renewal" });
    expect(calls.some((c) => c.op === "cancel")).toBe(true);
    expect(mails.filter((m) => m.text.includes("We accepted your reason")).map((m) => m.to)).toEqual(["pat@example.test", "pat@example.test"]);   // declarant and account
  });
  it("an accepted end whose execution crashed (Stripe down) is finished by the sweep, once", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    stripeBlocked = true;
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" });
    expect((await row(id)).status).toBe("executing");
    stripeBlocked = false;
    await sweepCancellations(env); await sweepCancellations(env);
    expect((await row(id)).status).toBe("completed");
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id=?", `cxl-ext:${id}`)).toBe(1);
    expect(refunds).toHaveLength(1);
  });
});

describe("r1 #4/#5: Stripe follows ALL declarations, journaled and read back", () => {
  it("two declarations on one plan: holding the earlier one leaves the later end in Stripe (it never clears another declaration)", async () => {
    const a = await submit(); const tokA = await holdToken(a.body.id as string);
    const b = await submit({ type: "on_date", requestedDate: ymd(P_END + 5 * DAY) });
    expect(subState.cancel_at).toBe(P_END / 1000);
    await hold(tokA);
    expect(subState.cancel_at).toBe(P_END_2 / 1000);
    expect(await row(a.body.id as string)).toMatchObject({ status: "held", stripe_synced: 1 });
    expect(await row(b.body.id as string)).toMatchObject({ status: "open", stripe_synced: 1, stripe_cancel_at: P_END_2 });
  });
  it("a failure Stripe cached against its key is recorded and superseded; the intent goes out under a fresh key and is read back", async () => {
    failCancelAtOnce = new StripeError(500, "stripe_api_error", { replayed: true, requestId: "req_1" });
    const r = await submit();
    const keys = calls.filter((c) => c.op === "setCancelAt").map((c) => c.key as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    const muts = (await env.DB.prepare("SELECT state, provider_error, idempotency_key FROM cancellation_stripe_mutations ORDER BY created_at, rowid").all<{ state: string; provider_error: string | null; idempotency_key: string }>()).results;
    expect(muts.map((m) => m.state)).toEqual(["superseded", "confirmed"]);
    expect(JSON.parse(muts[0].provider_error!)).toMatchObject({ status: 500, replayed: true });
    expect(subState.cancel_at).toBe(P_END / 1000);
    expect(await row(r.body.id as string)).toMatchObject({ stripe_synced: 1 });
  });
  it("an unresolved mutation of a crashed holder is settled with ITS OWN key before anything newer is decided", async () => {
    await submit();
    await env.DB.prepare("INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at) VALUES ('m-old',?,?,'cancel_at',?,'cxlmut:m-old','pending',?)")
      .bind(SUBID, HOME, P_END_2 / 1000, NOW - 1000).run();
    calls = [];
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    const sent = calls.filter((c) => c.op === "setCancelAt").map((c) => [c.key, c.at]);
    expect(sent[0]).toEqual(["cxlmut:m-old", P_END_2 / 1000]);
    expect(sent[1]).toEqual([expect.stringMatching(/^cxlmut:/), P_END / 1000]);
    expect(await env.DB.prepare("SELECT state FROM cancellation_stripe_mutations WHERE id='m-old'").first()).toEqual({ state: "confirmed" });
    expect(subState.cancel_at).toBe(P_END / 1000);
  });
  it("a transition committed while Stripe was being read is not marked synced by the stale writer; the sweep syncs it", async () => {
    const r = await submit(); const id = r.body.id as string;
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0 WHERE id=?").bind(id).run();
    onGet = async () => { await env.DB.prepare("UPDATE cancellation_requests SET last_op='newer', stripe_synced=0 WHERE id=?").bind(id).run(); };
    await reconcileSubscription(env, deps8(), SUBID);
    expect(await row(id)).toMatchObject({ stripe_synced: 0, last_op: "newer" });
    await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ stripe_synced: 1 });
  });
  it("drift is repaired: open declarations are re-read against Stripe periodically", async () => {
    await submit();
    subState.cancel_at = null;                                    // changed behind our back
    setClock(NOW + HOUR); await sweepCancellations(env);
    expect(subState.cancel_at).toBeNull();                        // not due yet
    setClock(NOW + 7 * HOUR); await sweepCancellations(env);
    expect(subState.cancel_at).toBe(P_END / 1000);
  });
});

describe("r1 #6: paid months follow the billing anchor", () => {
  it("anchored on the 31st: Oct 31 -> Nov 30 -> Dec 31 -> Jan 31 -> Feb 28 -> Mar 31", () => {
    const p = { start: Date.UTC(2026, 9, 31, 12), end: Date.UTC(2026, 10, 30, 12) };
    expect(periodContaining(p, Date.UTC(2026, 11, 15))).toEqual({ start: Date.UTC(2026, 10, 30, 12), end: Date.UTC(2026, 11, 31, 12) });
    expect(periodContaining(p, Date.UTC(2027, 1, 10))).toEqual({ start: Date.UTC(2027, 0, 31, 12), end: Date.UTC(2027, 1, 28, 12) });
    expect(periodContaining(p, Date.UTC(2027, 2, 1))!.end).toBe(Date.UTC(2027, 2, 31, 12));
    expect(periodContaining(p, Date.UTC(2026, 9, 1))).toEqual({ start: Date.UTC(2026, 8, 30, 12), end: Date.UTC(2026, 9, 31, 12) });
    expect(anchoredMonthUtc(Date.UTC(2026, 10, 30, 12), 1, 31)).toBe(Date.UTC(2026, 11, 31, 12));
    // an explicit anchor (Stripe's billing_cycle_anchor day) wins: anchored on the 30th it stays on the 30th
    expect(periodContaining({ start: Date.UTC(2026, 10, 30), end: Date.UTC(2026, 11, 30) }, Date.UTC(2027, 0, 5), 30)!.end).toBe(Date.UTC(2027, 0, 30));
  });
});

describe("r1 #7/#8: late refunds", () => {
  it("every page of a subscription's invoices is read; an incomplete listing throws; paid_at is Stripe's collection time", async () => {
    const pages = [{ data: [{ id: "in_a", status: "paid", amount_paid: 1 }], has_more: true }, { data: [{ id: "in_b", status: "paid", amount_paid: 2, status_transitions: { paid_at: 123 } }], has_more: false }];
    const urls: string[] = []; let n = 0;
    const c = stripeClient({ secretKey: "sk_test_x", apiVersion: "x" } as never, (async (u: string) => { urls.push(String(u)); return new Response(JSON.stringify(pages[n++]), { status: 200 }); }) as never);
    const got = await c.listSubscriptionInvoices(SUBID, "paid");
    expect(got.map((i) => i.id)).toEqual(["in_a", "in_b"]);
    expect(got[1].paid_at).toBe(123);
    expect(urls[0]).toContain("status=paid"); expect(urls[1]).toContain("starting_after=in_a");
    const endless = stripeClient({ secretKey: "sk_test_x", apiVersion: "x" } as never, (async () => new Response(JSON.stringify({ data: [{ id: "in_a" }], has_more: true }), { status: 200 })) as never);
    await expect(endless.listSubscriptionInvoices(SUBID, "paid")).rejects.toThrow("invoices_incomplete");
  });
  it("a renewal invoiced before effective_at for service after it and a late collection for service before it are both RECORDED, each with its hint; nothing is refunded by itself", async () => {
    const id = await lateSetup();
    addInvoice(invoice("in_early_renewal", P_END - HOUR, P_END, P_END_2));
    addInvoice(invoice("in_old_late", P_END + 2 * DAY, addMonthsUtc(P_START, -1), P_START));
    setClock(P_END + 3 * DAY);
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    expect((await lateRecords()).map((x) => [x.invoice_id, x.hint])).toEqual([["in_early_renewal", "after_end"], ["in_old_late", "before_end"]]);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
  });
  it("a Managed Payments contract keeps the MP path after it was cancelled (the seller is frozen at attribution)", async () => {
    const row0: Record<string, unknown> = { id: "consent-wp8", home_id: HOME, user_id: USER, email: null, created_at: NOW - 60_000, screen_version: "s1", cloud_terms_version: "c1",
      tos_version: "t1", privacy_version: "p1", terms_accepted: 1, recurring_authorized: 1, early_start: 0, eu_region: 0, topup_enabled: 0, renewal_text: "Renews monthly.",
      wording: "w", billing_country: "DE", plan: "pro", price_cents: 9900, start_at: NOW - 60_000, first_charge_at: NOW - 60_000, delayed_start: 0,
      tax_source: "managed_payments", quoted_total_cents: 9900, quote_id: "quote-wp8", stripe_price_id: "price_pro" };
    const cols = Object.keys(row0);
    await env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row0[c])).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET consent_id='consent-wp8' WHERE home_id=?").bind(HOME).run();
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    expect((await row(id)).seller_path).toBe("mp");
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" });
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + DAY); await sweepCancellations(env);
    expect((await executeLate("in_renewal", 9900)).status).toBe(200);
    const ops = (await env.DB.prepare("SELECT id, detail FROM refund_ops ORDER BY id").all<{ id: string; detail: string }>()).results;
    expect(ops.map((o) => [o.id, JSON.parse(o.detail).path])).toEqual([[`cxl-ext:${id}`, "mp"], [`cxl-late:${id}:in_renewal`, "mp"]]);
  });
});

describe("r1 #9: found valid late", () => {
  it("after the case closed as kept: the operator's late resolution keeps the original dates; renewals after effective_at are recorded for the operator", async () => {
    const r = await submit(); const id = r.body.id as string;
    await hold(await holdToken(id));
    setClock(P_END + 1000); await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ status: "kept", kept_by: "timeout" });
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + 2 * DAY);
    expect((await adminPost(`/v1/admin/cancellations/${id}/resume`, { note: "entitled" })).body).toEqual({ status: "completed" });
    expect(await row(id)).toMatchObject({ status: "completed", received_at: NOW, effective_at: P_END, kept_by: null });
    expect((await lateRecords()).map((x) => [x.invoice_id, x.request_id])).toEqual([["in_renewal", id]]);
    expect(await env.DB.prepare("SELECT outcome FROM cancellation_cases WHERE request_id=?").bind(id).first()).toEqual({ outcome: "found_valid" });
  });
  it("a rejected reason that was then held is never checked again when found valid", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "Not serious." });
    expect((await hold(tok)).body.outcome).toBe("held");
    expect(await row(id)).toMatchObject({ held_from: "open", keep_at: P_END });
    expect(await resumeHeld(env, deps8(), id)).toEqual({ ok: true, status: "open" });
    expect(await row(id)).toMatchObject({ status: "open", reason_decision: "reject", effective_at: P_END });
    expect(subState.cancel_at).toBe(P_END / 1000);
  });
});

describe("r1 #10: mail delivery", () => {
  it("two sweeps at once send each mail once, and the delivered hold link stays valid", async () => {
    readerDown = true; await submit(); readerDown = false; mails = [];
    await Promise.all([flushMail(env, deps8()), flushMail(env, deps8())]);
    expect(mails.filter((m) => m.to === "pat@example.test")).toHaveLength(1);
    expect((await hold(await holdToken(""))).body).toMatchObject({ outcome: "held" });
  });
  it("a delivery that keeps failing is retried for ever with backoff and one stable link; ops hears once", async () => {
    mailFail = 1000; await submit();
    const sel = (await env.DB.prepare("SELECT selector FROM verify_tokens").first<{ selector: string }>())!.selector;
    for (let i = 0; i < 12; i += 1) { setClock(cur + 7 * HOUR); await flushMail(env, deps8()); }
    const m = (await env.DB.prepare("SELECT sent_at, attempts FROM cancellation_mail WHERE kind='confirm_account'").first<{ sent_at: number | null; attempts: number }>())!;
    expect(m.sent_at).toBeNull(); expect(m.attempts).toBeGreaterThanOrEqual(12);
    expect(await alerts("cancellation.mail_failing")).toBe(1);
    expect((await env.DB.prepare("SELECT selector FROM verify_tokens").first<{ selector: string }>())!.selector).toBe(sel);
    mailFail = 0; setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(mails).toHaveLength(1);
    expect((await holdToken("")).selector).toBe(sel);
    expect(await env.DB.prepare("SELECT payload_json FROM cancellation_mail WHERE kind='confirm_account'").first()).toEqual({ payload_json: null });
  });
});

describe("r1 #11: content from the committed state", () => {
  it("the confirmation repeats the immutable declaration: name, account email, identifier, received_at, reference", async () => {
    const r = await submit({ name: "Pat Q", identifier: "INV-77", confirmationEmail: "friend@example.test" });
    const ref = (await row(r.body.id as string)).ref as string;
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      for (const piece of ["Your name: Pat Q", "Email address of your Murage account: pat@example.test", "invoice number, or the email on your receipt: INV-77",
        `Received: ${fmtReceived(NOW, "en")}`, `Reference: ${ref}`, "Email for your confirmation: friend@example.test", "What you asked for: End my plan at the end of the month I've paid for"]) expect(m.text).toContain(piece);
    }
  });
  it("a confirmation that goes out after a hold says the cancellation is on hold, never that the plan ends", async () => {
    readerDown = true; const r = await submit({ confirmationEmail: "friend@example.test" }); const id = r.body.id as string;
    await env.DB.prepare("UPDATE cancellation_requests SET status='held', held_from='open', last_op='held-op' WHERE id=?").bind(id).run();
    readerDown = false; mails = [];
    await flushMail(env, deps8());
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("We've put the cancellation on hold and your plan continues.");
    expect(mails[0].text).not.toContain("Your plan ends on");
    expect(mails[0].text).not.toContain("verify#");
  });
  it("the late-refund mail waits for the ledger and carries the ledger's own status line", async () => {
    const id = await lateSetup();
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + DAY); mails = [];
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    refundBlocked = true;
    expect((await executeLate("in_renewal", 9900)).status).toBe(200);
    refundBlocked = false;
    expect(mails.some((m) => m.text.includes("We have refunded it in full"))).toBe(false);
    await advanceRefundOp(env, { stripe: fakeStripe, flux: stubFluxHooks, deps: { notifier }, now: cur }, `cxl-late:${id}:in_renewal`);
    setClock(cur + 11 * MINUTE); await flushMail(env, deps8(), id);
    const late = mails.find((m) => m.text.includes("We have refunded it in full"))!;
    expect(late.to).toBe("pat@example.test");
    expect(late.text).toMatch(/Your refund: (sent on|processed on) \d{4}-\d{2}-\d{2} \(UTC\)/);
  });
});

describe("r1 #12: Keep my plan", () => {
  const keep = async (id: string, user: string | null, step: boolean) => {
    const w = createWorker(fetch, fetch, {}, {}, { accountUser: async () => (user ? { id: user } : null), stepUp: async () => step } as never);
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request(`https://cp.test/v1/account/cancellations/${id}/keep`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  it("is sign-in only, like Cancel plan (owner rule 2026-10-12, B5: a plain Keep restores the prior state and moves no money)", () => {
    expect(needsStepUp("POST", "/v1/account/cancellations/abc/keep")).toBe(false);
    expect(needsStepUp("POST", "/v1/account/cancel-plan")).toBe(false);
  });
  it("signed in, own plan, before effective_at: kept, Stripe cancel_at cleared; anything else refused", async () => {
    const r = await submit(); const id = r.body.id as string;
    expect(subState.cancel_at).toBe(P_END / 1000);
    expect((await keep(id, null, true)).status).toBe(401);
    expect(await keep(id, "someone-else", false)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await keep(id, "someone-else", true)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await row(id)).status).toBe("open");
    expect(await keep(id, USER, false)).toMatchObject({ status: 200, body: { status: "kept" } }); // no step-up needed
    expect(await row(id)).toMatchObject({ status: "kept", kept_by: "customer", effective_at: P_END, received_at: NOW });
    expect(subState.cancel_at).toBeNull();
    expect(await keep(id, USER, true)).toMatchObject({ status: 409, body: { error: "already_kept" } });
  });
  it("Astra CS-1 #2: the account summary names the open public cancellation (id, kind, end) for Keep my plan; Keep clears it and cancel_at once Stripe confirms", async () => {
    const summary = async () => {
      const w = createWorker(fetch, fetch, {}, {}, { accountUser: async () => ({ id: USER }), stepUp: async () => true } as never);
      const ctx = createExecutionContext();
      const res = await w.fetch(new Request("https://cp.test/v1/account/cloud", { method: "GET" }), testEnv(), ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      return ((await res.json()) as { subscription: Record<string, unknown> }).subscription;
    };
    const subRow = () => env.DB.prepare("SELECT cancel_at FROM billing_subscriptions WHERE home_id=?").bind(HOME).first();
    const r = await submit(); const id = r.body.id as string;
    expect(await summary()).toMatchObject({ cancelAtPeriodEnd: true, activeUntil: P_END,
      cancellation: expect.objectContaining({ id, kind: "ordinary_earliest", endsAt: P_END, keepable: true, keepIds: [id] }) });
    // Stripe has not cleared yet (its read-back still shows the end): kept is recorded, cancel_at stays, the answer says so.
    ignoreCancelAt = true;
    expect(await keep(id, USER, true)).toMatchObject({ status: 200, body: { status: "kept", stripeConfirmed: false } });
    expect(await subRow()).toEqual({ cancel_at: P_END });
    expect(await summary()).toMatchObject({ cancellation: expect.objectContaining({ id: null, keepable: false, keepIds: [] }) });
    // Stripe confirms on the next pass: cancel_at is reset and the plan renews.
    ignoreCancelAt = false;
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    expect(subState.cancel_at).toBeNull();
    expect(await subRow()).toEqual({ cancel_at: null });
    expect(await summary()).toMatchObject({ cancelAtPeriodEnd: false, cancellation: expect.objectContaining({ id: null, keepIds: [] }) });
    expect(await keep(id, USER, true)).toMatchObject({ status: 409, body: { error: "already_kept" } });
  });
  it("the home's row carries Stripe's confirmed cancel_at from the flow itself (no webhook), and loses it when the plan is kept", async () => {
    const subRow = () => env.DB.prepare("SELECT cancel_at, cancel_at_period_end, cancel_intent_rev, cancel_synced_rev FROM billing_subscriptions WHERE home_id=?").bind(HOME).first();
    const r = await submit(); const id = r.body.id as string;
    expect(await row(id)).toMatchObject({ status: "open", stripe_synced: 1, stripe_cancel_at: P_END });
    // Set in the same batch that marked the declaration synced; the in-app path's flag and revisions are untouched.
    expect(await subRow()).toEqual({ cancel_at: P_END, cancel_at_period_end: 0, cancel_intent_rev: 0, cancel_synced_rev: 0 });
    expect(await keep(id, USER, true)).toMatchObject({ status: 200, body: { status: "kept" } });
    expect(await subRow()).toEqual({ cancel_at: null, cancel_at_period_end: 0, cancel_intent_rev: 0, cancel_synced_rev: 0 });
  });
  it("after effective_at it is too late; a serious reason under check is not an end-of-month cancellation", async () => {
    const a = await submit(); const b = await submit({ type: "now_for_cause", reason: "Serious" });
    expect(await keepPlan(env, deps8(), b.body.id as string, USER)).toEqual({ ok: false, code: "not_keepable" });
    setClock(P_END + 1000);
    expect(await keep(a.body.id as string, USER, true)).toMatchObject({ status: 409, body: { error: "too_late" } });
  });
});

describe("r1 #13: deadlines", () => {
  it("working days: Friday + 3 = end of Wednesday; Monday + 3 = end of Thursday", () => {
    expect(workingDaysAfter(Date.UTC(2026, 9, 9, 15), 3)).toBe(Date.UTC(2026, 9, 15));
    expect(workingDaysAfter(Date.UTC(2026, 9, 12, 9), 3)).toBe(Date.UTC(2026, 9, 16));
  });
  it("the reason check is due at the end of the 3rd working day after attribution and escalated then, not before, once", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const due = workingDaysAfter(NOW, 3);
    expect((await row(id)).reason_due_at).toBe(due);
    setClock(due - 1000); await sweepCancellations(env);
    expect(await alerts("cancellation.reason_overdue")).toBe(0);
    setClock(due); await sweepCancellations(env); await sweepCancellations(env);
    expect(await alerts("cancellation.reason_overdue")).toBe(1);
  });
  it("two overdue requests each raise their own alert (one open alert per scope)", async () => {
    await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
    await submit({ email: "nobody2@example.test", confirmationEmail: "nobody2@example.test" });
    await sweepCancellations(env);
    expect(await alerts("cancellation.unidentified")).toBe(2);
  });
});

describe("r1 #15: the receipt is immutable", () => {
  it("the stored bytes are served, verified against receipt_sha256, with the security headers; tampered bytes are never served", async () => {
    const r = await submit(); const id = r.body.id as string;
    const g = await call("GET", `/v1/public/cancellation/${id}/receipt`);
    expect(g.text).toBe((await row(id)).receipt_html);
    expect(g.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(g.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(g.headers.get("cache-control")).toBe("no-store");
    expect(g.headers.get("referrer-policy")).toBe("no-referrer");
    expect(g.headers.get("x-content-type-options")).toBe("nosniff");
    expect(g.headers.get("x-robots-tag")).toBe("noindex");
    await env.DB.prepare("UPDATE cancellation_requests SET receipt_html=replace(receipt_html,'Pat Q','Mallory') WHERE id=?").bind(id).run();
    expect(await call("GET", `/v1/public/cancellation/${id}/receipt`)).toMatchObject({ status: 500, body: { error: "receipt_unavailable" } });
    expect(await alerts("cancellation.receipt_integrity")).toBe(1);
  });
});

describe("r1: migration 0063 over a populated database", () => {
  it("is additive: it applies over a populated baseline, leaves existing rows alone, and the package works on it", async () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0063"))!;
    expect(m).toBeTruthy();
    for (const query of m.queries) expect(query.replace(/--.*$/gm, "").trim()).toMatch(/^CREATE (TABLE|INDEX) /);
    await env.DB.prepare("INSERT INTO billing_home_leases (home_id,holder,lease_until) VALUES ('home-b63','h',123)").run();
    const before = await env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id='home-b63'").first();
    const subBefore = await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(HOME).first();
    await env.DB.batch(["cancellation_stripe_mutations", "cancellation_cases", "cancellation_mail", "cancellation_requests"].map((tb) => env.DB.prepare(`DROP TABLE ${tb}`)));
    await env.DB.batch(m.queries.map((query) => env.DB.prepare(query)));
    // The later migrations' column additions to these tables (0092: decl_rev, decl_n), as a database migrated in order has them.
    const later = env.TEST_MIGRATIONS.filter((x) => x.name > m.name).flatMap((x) => x.queries)
      .filter((query) => /^ALTER TABLE (cancellation_stripe_mutations|cancellation_cases|cancellation_mail|cancellation_requests) ADD COLUMN /.test(query.replace(/--.*$/gm, "").trim()));
    if (later.length) await env.DB.batch(later.map((query) => env.DB.prepare(query)));
    expect(await env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id='home-b63'").first()).toEqual(before);
    expect(await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(HOME).first()).toEqual(subBefore);
    await env.DB.prepare("DELETE FROM billing_home_leases WHERE home_id='home-b63'").run();
    const r = await submit();
    expect(await row(r.body.id as string)).toMatchObject({ match_state: "matched", stripe_synced: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Astra WP8-2 round 2: one test (or more) per finding, and the rules the review listed as partially covered.

const P_END_3 = addMonthsUtc(P_END, 2);
const linkSelectors = () => mails.map((x) => /verify#([A-Za-z0-9_-]{22})\./.exec(x.text)?.[1]).filter(Boolean);
const keyless = () => ({ ...env, CANCELLATION_MAIL_KEY: undefined }) as unknown as Env;

describe("r2 #1: the hold lasts until hold_until, during the reason check too", () => {
  it("a reason check still open 40 days past the fallback end can still be held with the first link (no 30-day cap, no extra click)", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    setClock(P_END + 40 * DAY); await sweepCancellations(env);
    expect((await row(id)).status).toBe("reason_pending");
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(await row(id)).toMatchObject({ status: "held", held_from: "reason_pending", effective_at: NOW, received_at: NOW });
  });
  it("a link issued with the old 7-day limit, pressed after it while the hold is open, holds at once: identity verified, same atomic transition", async () => {
    const r = await submit({ type: "on_date", requestedDate: ymd(P_END + 5 * DAY) }); const id = r.body.id as string;
    const legacy = (await issueToken(env, { now: () => cur }, { purpose: "repudiate", subjectKind: "cancellation", subjectId: id, accountId: SUBJ, accountEmail: "pat@example.test",
      supabaseUpdatedAt: supa.updatedAt, receivedAt: NOW, capAt: P_END_2 }))!;
    expect(legacy.expiresAt).toBe(NOW + 7 * DAY);
    const tok = { selector: legacy.selector, secret: legacy.secret };
    setClock(NOW + 20 * DAY);
    supa = { ...supa, email: "changed@example.test" };
    expect(await hold(tok)).toMatchObject({ status: 409, body: { error: "identity_changed", canResend: true } });
    readerDown = true;
    expect(await hold(tok)).toMatchObject({ status: 503, body: { error: "identity_unavailable" } });
    readerDown = false; supa = { ...supa, email: "pat@example.test" };
    expect((await row(id)).status).toBe("open");
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(await row(id)).toMatchObject({ status: "held", effective_at: P_END_2, received_at: NOW });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_cases WHERE request_id=?", id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE selector=? AND used_at IS NOT NULL", tok.selector)).toBe(1);
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });            // a replay changes nothing
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_mail WHERE kind='held_account'")).toBe(1);
  });
});

describe("r2 #2: unpause releases every held-back draft through its own journal row", () => {
  it("multi-renewal: two drafts held back during the check; a release Stripe failed (cached) goes out again under a fresh key and is read back", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    setClock(P_END + DAY); await sweepCancellations(env);
    drafts.push({ id: "in_d2", auto_advance: false, created: Math.floor(P_END_2 / 1000), start: P_END_2, end: P_END_3 });
    setClock(P_END_2 + DAY); await sweepCancellations(env);
    expect(drafts.map((x) => x.auto_advance)).toEqual([false, false]);
    failRelease = [new StripeError(500, "api_error", { replayed: true, requestId: "req_r" })];
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(drafts.map((x) => x.auto_advance)).toEqual([true, true]);
    const rel = (await env.DB.prepare("SELECT invoice_id, state, idempotency_key, provider_error FROM cancellation_stripe_mutations WHERE kind='release' ORDER BY created_at, rowid")
      .all<{ invoice_id: string; state: string; idempotency_key: string; provider_error: string | null }>()).results;
    expect(rel.map((x) => [x.invoice_id, x.state])).toEqual([["in_d1", "superseded"], ["in_d2", "confirmed"], ["in_d1", "confirmed"]]);
    expect(new Set(rel.map((x) => x.idempotency_key)).size).toBe(3);
    expect(JSON.parse(rel[0].provider_error!)).toMatchObject({ status: 500, replayed: true });
    expect(await row(id)).toMatchObject({ status: "held", stripe_synced: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(0);
  });
  it("a release that keeps failing after the unpause succeeded is NOT reported synced; the sweep retries it until Stripe shows it released", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    setClock(P_END + DAY);
    failRelease = [0, 1, 2].map(() => new StripeError(500, "api_error", { replayed: true }));
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(subState.pause_collection).toBeNull();
    expect(drafts[0].auto_advance).toBe(false);
    expect(await row(id)).toMatchObject({ stripe_synced: 0 });
    expect(await alerts("cancellation.drafts_unsettled")).toBe(1);
    await sweepCancellations(env);
    expect(drafts[0].auto_advance).toBe(true);
    expect(await row(id)).toMatchObject({ stripe_synced: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='release' AND state='confirmed'")).toBe(1);
  });
  it("journal lease-loss race: the holder loses the lease during its Stripe call; its write lands nowhere and the next holder settles that row with ITS key first", async () => {
    await submit();
    subState.cancel_at = null; calls = [];
    onSetCancelAt = async () => {
      await env.DB.prepare("UPDATE billing_home_leases SET holder='thief', generation=generation+1, lease_until=? WHERE home_id=?").bind(Date.now() + 60_000, HOME).run();
    };
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("busy");
    const pending = (await env.DB.prepare("SELECT idempotency_key FROM cancellation_stripe_mutations WHERE state='pending'").all<{ idempotency_key: string }>()).results;
    expect(pending).toHaveLength(1);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL, lease_until=NULL WHERE home_id=?").bind(HOME).run();
    calls = [];
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    expect(calls.filter((c) => c.op === "setCancelAt")[0]).toMatchObject({ key: pending[0].idempotency_key, at: P_END / 1000 });
    expect(await env.DB.prepare("SELECT state FROM cancellation_stripe_mutations WHERE idempotency_key=?").bind(pending[0].idempotency_key).first()).toEqual({ state: "confirmed" });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE state='pending'")).toBe(0);
    expect(subState.cancel_at).toBe(P_END / 1000);
  });
});

describe("r2 #3/#4/#10: mail claims, identity and sealed payloads", () => {
  it("a stale sender never mints another token: a second sender takes the delivery over while the first renders; one delivery, and its link holds", async () => {
    readerDown = true; await submit(); readerDown = false; mails = [];
    onRead = async () => { await flushMail(env, { ...deps8(), now: () => cur + 6 * MINUTE }); };   // sender B: A's claim looks lapsed to it
    await flushMail(env, deps8());                                                                  // sender A
    expect(mails.filter((m) => m.to === "pat@example.test")).toHaveLength(1);
    expect((await hold(await holdToken(""))).body).toMatchObject({ outcome: "held" });
  });
  it("delivery acknowledgement lost: every retry sends the SAME link (reloaded after the claim) and the first delivered link still holds", async () => {
    ackLost = 1;
    await submit();
    await flushMail(env, deps8());
    const sels = linkSelectors();
    expect(sels.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sels).size).toBe(1);
    expect((await hold(await holdToken(""))).body).toMatchObject({ outcome: "held" });
  });
  it("the kept payload is an AES-GCM envelope (never the plain link) bound to its delivery; it is wiped once sent", async () => {
    mailFail = 1000; await submit();
    const p = (await env.DB.prepare("SELECT payload_json FROM cancellation_mail WHERE kind='confirm_account'").first<{ payload_json: string }>())!.payload_json;
    expect(p).not.toContain("verify");
    expect(p).not.toContain("pat@example.test");
    expect(JSON.parse(p)).toMatchObject({ v: 1, alg: "A256GCM" });
    const sel = (await env.DB.prepare("SELECT selector FROM verify_tokens").first<{ selector: string }>())!.selector;
    expect(p).not.toContain(sel);
    // copied to another delivery it never opens: that delivery renders its own mail
    mailFail = 0;
    await env.DB.prepare("UPDATE cancellation_mail SET payload_json=?, payload_op=(SELECT last_op FROM cancellation_requests), sent_at=NULL, next_attempt_at=0 WHERE kind='receipt_declarant'").bind(p).run();
    setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_mail WHERE payload_json IS NOT NULL")).toBe(0);
    expect(linkSelectors()).toEqual([sel]);
  });
  it("cached account mail follows the email generation: after an email change the retry goes to the new address with a new link, never to the old one", async () => {
    mailFail = 1000; await submit(); mailFail = 0;
    const old = (await env.DB.prepare("SELECT selector FROM verify_tokens").first<{ selector: string }>())!.selector;
    supa = { ...supa, email: "new@example.test", updatedAt: "2026-10-05T00:00:00.000Z" };
    setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(mails.map((m) => m.to)).toEqual(["new@example.test"]);
    const tok = await holdToken("");
    expect(tok.selector).not.toBe(old);
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
  });
  it("the identity is verified before every send of a kept payload: reader down, nothing is sent", async () => {
    mailFail = 1000; await submit(); mailFail = 0;
    readerDown = true; setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(mails).toHaveLength(0);
    readerDown = false; setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(mails.map((m) => m.to)).toEqual(["pat@example.test"]);
  });
  it("obsolete payloads are wiped: once the hold is over the kept link is gone and the confirmation goes without it", async () => {
    mailFail = 1000; await submit();
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_mail WHERE payload_json IS NOT NULL")).toBe(1);
    setClock(P_END + 1000); await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_mail WHERE payload_json IS NOT NULL")).toBe(0);
    mailFail = 0; setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    const acct = mails.find((m) => m.subject === "Your Murage Cloud cancellation")!;
    expect(acct.text).not.toContain("verify#");
  });
  it("without CANCELLATION_MAIL_KEY a link mail fails closed: nothing stored, nothing sent; with it, sent", async () => {
    readerDown = true; await submit(); readerDown = false; mails = [];
    await flushMail(keyless(), deps8());
    expect(mails).toHaveLength(0);
    expect(await env.DB.prepare("SELECT last_error, payload_json FROM cancellation_mail WHERE kind='confirm_account'").first()).toEqual({ last_error: "mail_key_missing", payload_json: null });
    setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(mails.map((m) => m.to)).toEqual(["pat@example.test"]);
  });
  it("past the former 20-attempt ceiling a failing delivery is still retried with one stable link; ops hears once", async () => {
    mailFail = 1000; await submit();
    const sel = (await env.DB.prepare("SELECT selector FROM verify_tokens").first<{ selector: string }>())!.selector;
    for (let i = 0; i < 25; i += 1) { setClock(cur + 7 * HOUR); await flushMail(env, deps8()); }
    expect((await env.DB.prepare("SELECT attempts FROM cancellation_mail WHERE kind='confirm_account'").first<{ attempts: number }>())!.attempts).toBeGreaterThan(20);
    expect(await alerts("cancellation.mail_failing")).toBe(1);
    mailFail = 0; setClock(cur + 7 * HOUR); await flushMail(env, deps8());
    expect(linkSelectors()).toEqual([sel]);
  });
});

describe("r2 #5: Keep my plan is final", () => {
  it("support cannot reopen a declaration the customer kept (409 kept_by_customer); one kept because nobody answered still can", async () => {
    const a = await submit(); const id = a.body.id as string;
    expect(await keepPlan(env, deps8(), id, USER)).toEqual({ ok: true, status: "kept", stripeConfirmed: true });
    expect(await resumeHeld(env, deps8(), id)).toEqual({ ok: false, code: "kept_by_customer" });
    expect(await adminPost(`/v1/admin/cancellations/${id}/resume`, {})).toMatchObject({ status: 409, body: { error: "kept_by_customer" } });
    expect(await row(id)).toMatchObject({ status: "kept", kept_by: "customer" });
    expect(subState.cancel_at).toBeNull();
    // held, then kept by the customer: still final
    const b = await submit({ type: "on_date", requestedDate: ymd(P_END + 5 * DAY) }); const idB = b.body.id as string;
    await hold(await holdToken(idB));
    expect(await keepPlan(env, deps8(), idB, USER)).toEqual({ ok: true, status: "kept", stripeConfirmed: true });
    expect(await resumeHeld(env, deps8(), idB)).toEqual({ ok: false, code: "kept_by_customer" });
    expect(await env.DB.prepare("SELECT outcome FROM cancellation_cases WHERE request_id=?").bind(idB).first()).toEqual({ outcome: "kept_by_customer" });
  });
  it("Astra JOURNEY-BCORE-2 #1: a public declaration writes its generation-bound resolution when it gets its end; Keep withdraws it in the same batch", async () => {
    const r = await submit(); const id = r.body.id as string;
    const res = () => env.DB.prepare("SELECT source,generation,promised_end_at,state,next_attempt_at FROM cancel_resolutions").all().then((x) => x.results);
    const q = await row(id);
    expect(await res()).toEqual([{ source: "public", generation: `public:${id}:${q.effective_at}`, promised_end_at: q.effective_at, state: "open", next_attempt_at: Number(q.effective_at) - 5000 }]);
    expect(await keepPlan(env, deps8(), id, USER)).toEqual({ ok: true, status: "kept", stripeConfirmed: true });
    expect(await res()).toMatchObject([{ state: "withdrawn" }]);
  });
  it("Keep my plan racing the due end: exactly one wins, and each side reports it", async () => {
    const r = await submit(); const id = r.body.id as string;
    setClock(P_END);
    const [k] = await Promise.all([keepPlan(env, { ...deps8(), now: () => P_END - 1 }, id, USER), sweepCancellations(env)]);
    const q = await row(id);
    if (k.ok) {
      expect(q).toMatchObject({ status: "kept", kept_by: "customer" });
      expect(calls.some((c) => c.op === "cancel")).toBe(false);
    } else {
      expect(q.status).toBe("completed");
      expect(["not_keepable", "too_late"]).toContain(k.code);
    }
    expect(await keepPlan(env, deps8(), id, USER)).toMatchObject({ ok: false });
  });
});

describe("r2 #6: async recovery is fair and never silently pending", () => {
  it("50 requests that cannot be scheduled never starve request 51; each is escalated once as no_schedule", async () => {
    const far = ymd(NOW + 6 * 366 * DAY);
    const ins = (id: string, at: number, date: string) => env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,requested_date,entered_email,entered_name,confirm_email,language,
        receipt_sha256,created_at,updated_at) VALUES (?,?,?,'{}','ordinary_date',?,'pat@example.test','Pat','pat@example.test','en','x',?,?)`).bind(id, `CX-${id}`, at, date, at, at);
    await env.DB.batch(Array.from({ length: 50 }, (_, i) => ins(`far${String(i).padStart(29, "0")}`, NOW - 1000 + i, far)));
    await ins("near".padEnd(32, "0"), NOW, ymd(P_END + 5 * DAY)).run();
    await sweepCancellations(env);
    setClock(cur + 2 * MINUTE); await sweepCancellations(env);
    expect(await row("near".padEnd(32, "0"))).toMatchObject({ match_state: "matched", effective_at: P_END_2 });
    expect(await alerts("cancellation.no_schedule")).toBe(50);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_requests WHERE id LIKE 'far%' AND match_state='pending' AND schedule_escalated_at IS NOT NULL AND next_match_at IS NOT NULL")).toBe(50);
  });
});

describe("r2 #7: execution and refund told apart", () => {
  it("no 'plan has ended' while the end is being carried out; after it is, the accepted mail goes out once", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    stripeBlocked = true; mails = [];
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" });
    expect((await row(id)).status).toBe("executing");
    await flushMail(env, deps8());
    expect(mails.some((m) => m.subject === "Your Murage Cloud plan has ended" || m.text.includes("Your plan ended"))).toBe(false);
    stripeBlocked = false; setClock(cur + 11 * MINUTE); await sweepCancellations(env);
    expect((await row(id)).status).toBe("completed");
    const acc = mails.filter((m) => m.subject === "Your Murage Cloud plan has ended");
    expect(acc).toHaveLength(2);
    for (const m of acc) expect(m.text).toMatch(/Your refund: (sent on|processed on) /);
  });
  it("a failed late refund is never 'refunded in full': the mail says it is delayed, with the ledger's line", async () => {
    const id = await lateSetup();
    addInvoice(invoice("in_renewal", P_END, P_END, P_END_2));
    setClock(P_END + DAY); mails = [];
    refundStatusNext = "failed";
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    expect((await executeLate("in_renewal", 9900)).status).toBe(200);
    setClock(cur + 11 * MINUTE); await flushMail(env, deps8(), id);
    // r3 #6: the subject comes from the same ledger state as the body: never "a charge was refunded" for a failed refund.
    expect(mails.some((m) => m.subject === "Your Murage Cloud cancellation: a charge was refunded")).toBe(false);
    const late = mails.find((m) => m.subject === "Your Murage Cloud cancellation: a refund is delayed")!;
    expect(late).toBeTruthy();
    expect(late.text).not.toContain("We have refunded it in full");
    expect(late.text).toContain("the refund is delayed and we are trying again");
    expect(late.text).toContain("Your refund: delayed; we are trying again.");
  });
  it("the page answer carries the refund state and its line beside the execution state", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" });
    const a = await hold(tok);
    expect(a.body).toMatchObject({ outcome: "too_late_completed", caseOpened: true, refund: { status: "processed", path: "direct" } });
    expect(a.body.refundLine).toMatch(/^Your refund: processed on \d{4}-\d{2}-\d{2} \(UTC\); your bank may take 5 to 10 business days to show it\.$/);
    expect(a.body.completedAt).toBe(cur);
  });
});

describe("r2 P2 #8: a late decision inside periods a pause held back", () => {
  it("rejected after two held-back renewals: ends at the paid month of receipt; both drafts are voided (never owed), nothing refunded", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    drafts.push({ id: "in_d2", auto_advance: false, created: Math.floor(P_END_2 / 1000), start: P_END_2, end: P_END_3 });
    setClock(P_END_2 + DAY);
    expect((await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "Not serious." })).body).toEqual({ status: "completed" });
    expect(await row(id)).toMatchObject({ status: "completed", effective_at: P_END, stripe_synced: 1 });
    expect(drafts.map((x) => [x.status, x.auto_advance])).toEqual([["void", false], ["void", false]]);
    expect(subState.status).toBe("canceled");
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='void' AND state='confirmed'")).toBe(2);
  });
  it("accepted for a date inside an unpaid held-back period: the straddling draft is released (time before the end owed, r3 #3), the later one voided; the ext op settles at zero explicitly", async () => {
    const later = ymd(P_END + 5 * DAY); const eff = Date.parse(`${later}T00:00:00Z`);
    const r = await submit({ type: "now_for_cause", reason: "Serious", requestedDate: later }); const id = r.body.id as string;
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    drafts.push({ id: "in_d2", auto_advance: false, created: Math.floor(P_END_2 / 1000), start: P_END_2, end: P_END_3 });
    setClock(P_END_2 + DAY); mails = [];
    expect((await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" })).body).toEqual({ status: "completed" });
    // r3 #3 (owner default): in_d1 pays for five days before the end: released, not waived; in_d2 lies wholly after it: voided.
    expect(drafts.map((x) => [x.status ?? "draft", x.auto_advance])).toEqual([["draft", true], ["void", false]]);
    // r4 #1: the cancellation switched collection off on in_d1; it was released again AFTER the cancel, and only then was the pause closed.
    const order = calls.filter((c) => c.op === "cancel" || (c.op === "autoAdvance" && c.id === "in_d1")).map((c) => c.op);
    expect(order).toEqual(["autoAdvance", "cancel", "autoAdvance"]);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(0);
    const op = (await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(`cxl-ext:${id}`).first<Record<string, unknown>>())!;
    expect(op).toMatchObject({ cutover_at: eff, old_invoice_id: "in_cur", amount_cents: 0, last_error: null });
    expect(op.done_at).not.toBeNull();
    expect(refunds).toHaveLength(0);
    expect(subState.status).toBe("canceled");
    await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops")).toBe(1);
    const acc = mails.filter((m) => m.subject === "Your Murage Cloud plan has ended");
    expect(acc.length).toBe(2);
    for (const m of acc) { expect(m.text).toContain("there is nothing to refund"); expect(m.text).not.toContain("Your refund:"); }
    // Stripe collects the released straddling renewal: it is RECORDED (straddling the end, no amount); the operator decides the part after
    // the end and executes it by id, and the mail says only that part was refunded.
    drafts.splice(0, 1);
    addInvoice({ ...invoice("in_d1", P_END, P_END, P_END_2), paid_at: Math.floor((cur + HOUR) / 1000) } as ReturnType<typeof invoice>);
    setClock(cur + 2 * HOUR); mails = [];
    await sweepCancellations(env);
    expect(await count("SELECT COUNT(*) AS n FROM refund_ops WHERE id=?", `cxl-late:${id}:in_d1`)).toBe(0);
    expect(await lateRecords()).toEqual([{ invoice_id: "in_d1", request_id: id, paid_cents: 9900, hint: "straddles_end", executed_at: null }]);
    const part = Math.round(9900 * (P_END_2 - eff) / (P_END_2 - P_END));
    expect((await executeLate("in_d1", part)).status).toBe(200);
    const lateOp = (await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(`cxl-late:${id}:in_d1`).first<Record<string, unknown>>())!;
    expect(lateOp).toMatchObject({ kind: "cancellation_late", amount_cents: part, basis: "unused_fraction" });
    expect(part).toBeGreaterThan(0); expect(part).toBeLessThan(9900);
    expect(refunds.map((x) => x.amount)).toEqual([part]);
    const late = mails.filter((m) => m.subject === "Your Murage Cloud cancellation: a charge was refunded");
    expect(late.length).toBeGreaterThan(0);
    for (const m of late) { expect(m.text).toContain("We have refunded the part for the time after that date"); expect(m.text).not.toContain("in full"); }
  });
});

describe("r2 P2 #9: one escalation marker per kind, stable alert scopes", () => {
  it("an identification escalation never suppresses the later reason escalation", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious", email: "nobody@example.test", confirmationEmail: "nobody@example.test" }); const id = r.body.id as string;
    await sweepCancellations(env);
    expect(await alerts("cancellation.unidentified")).toBe(1);
    await adminPost(`/v1/admin/cancellations/${id}/attribute`, { accountId: USER, basis: "support" });
    const due = (await row(id)).reason_due_at as number;
    expect((await row(id)).status).toBe("reason_pending");
    setClock(due); await sweepCancellations(env); await sweepCancellations(env);
    expect(await alerts("cancellation.reason_overdue")).toBe(1);
  });
  it("Stripe that never confirms raises ONE open alert for the subscription, not one an hour", async () => {
    ignoreCancelAt = true;
    await submit();
    for (let i = 0; i < 4; i += 1) { setClock(cur + HOUR); await sweepCancellations(env); }
    expect(await alerts("cancellation.stripe_unconfirmed")).toBe(1);
  });
});

// Astra WP8-3 (round 3): one test per finding.
describe("r3 #4: the no_schedule escalation is never lost", () => {
  it("an alert insert that fails rolls the marker back; the next retry escalates exactly once", async () => {
    const far = ymd(NOW + 6 * 366 * DAY);
    const fid = "farr3".padEnd(32, "0");
    await env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,requested_date,entered_email,entered_name,confirm_email,language,
        receipt_sha256,created_at,updated_at) VALUES (?,?,?,'{}','ordinary_date',?,'pat@example.test','Pat','pat@example.test','en','x',?,?)`).bind(fid, "CX-FARR3", NOW, far, NOW, NOW).run();
    await env.DB.prepare("CREATE TRIGGER r3_alert_fail BEFORE INSERT ON cloud_alerts WHEN NEW.kind='cancellation.no_schedule' BEGIN SELECT RAISE(ABORT, 'alert store down'); END").run();
    try { await sweepCancellations(env); } finally { await env.DB.prepare("DROP TRIGGER r3_alert_fail").run(); }
    expect(await alerts("cancellation.no_schedule")).toBe(0);
    expect(await row(fid)).toMatchObject({ match_state: "pending", schedule_escalated_at: null });
    for (let i = 0; i < 4; i += 1) { setClock(cur + 2 * HOUR); await sweepCancellations(env); }
    expect(await alerts("cancellation.no_schedule")).toBe(1);
    expect((await row(fid)).schedule_escalated_at).not.toBeNull();
  });
});

describe("r3 #5: the hold link row lives as long as the hold can be needed", () => {
  it("a reason still pending past cap + grace keeps its selector and consumed tombstone; once decided and past the cap, the row goes", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    await holdToken(id);
    expect(await row(id)).toMatchObject({ status: "reason_pending" });
    await env.DB.prepare("UPDATE verify_tokens SET used_at=?, used_by='r3' WHERE subject_kind='cancellation' AND subject_id=?").bind(NOW, id).run();
    const far = NOW + 3 * 365 * DAY;
    await sweepPublicTokens(env, far);
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE subject_kind='cancellation' AND subject_id=? AND used_at IS NOT NULL", id)).toBe(1);
    await env.DB.prepare("UPDATE cancellation_requests SET status='completed' WHERE id=?").bind(id).run();
    await sweepPublicTokens(env, far);
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE subject_kind='cancellation' AND subject_id=?", id)).toBe(0);
  });
});

describe("r3 #1/#2: every held-back invoice stays an obligation until a read shows it settled against the current cutoff", () => {
  beforeEach(() => { failVoid = []; inFlightKeys.clear(); });
  it("#1 finalized but not voided (open) is retried by invoice id on the next healthy pass; the pause is released only after it is void", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    setClock(P_END + DAY); await sweepCancellations(env);
    failVoid = [0, 1, 2].map(() => new StripeError(500, "api_error", { replayed: true }));
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "Not serious." });
    expect(drafts[0].status).toBe("open");
    expect(await row(id)).toMatchObject({ stripe_synced: 0 });
    expect(await alerts("cancellation.drafts_unsettled")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(1);
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(drafts[0].status).toBe("void");
    expect(await row(id)).toMatchObject({ status: "completed", stripe_synced: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='void' AND invoice_id='in_d1' AND state='confirmed'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(0);
  });
  it("#2 a pending release resolved with its own key is then judged against the current cutoff: released under the old view, voided now", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    setClock(P_END + DAY); await sweepCancellations(env);
    await env.DB.prepare(`INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,invoice_id)
      VALUES ('r3rel',?,?,'release',NULL,'cxlrelease:r3rel','pending',?,'in_d1')`).bind(SUBID, HOME, cur).run();
    calls = [];
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "Not serious." });
    expect(calls.find((c) => c.op === "autoAdvance")).toMatchObject({ id: "in_d1", key: "cxlrelease:r3rel" });
    expect(await env.DB.prepare("SELECT state FROM cancellation_stripe_mutations WHERE id='r3rel'").first()).toEqual({ state: "confirmed" });
    expect(drafts[0].status).toBe("void");
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='void' AND invoice_id='in_d1' AND state='confirmed'")).toBe(1);
    expect(await row(id)).toMatchObject({ status: "completed", effective_at: P_END, stripe_synced: 1 });
  });
});

describe("r3: the lease lost while the old Stripe call is still outstanding", () => {
  beforeEach(() => { inFlightKeys.clear(); });
  it("the next holder starts before the old call returns: the old key is still in flight, so it stops; nothing goes out under another key; the late answer lands nowhere; the row is settled by its own key", async () => {
    await submit();
    subState.cancel_at = null; calls = [];
    let second: unknown = null;
    onSetCancelAt = async () => {
      // The old holder's lease lapses while its call is outstanding; the next holder runs to its end before that call returns.
      await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL, lease_until=NULL WHERE home_id=?").bind(HOME).run();
      try { second = await reconcileSubscription(env, deps8(), SUBID); } catch (e) { second = e; }
    };
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("busy");
    expect(second).toBeInstanceOf(StripeError);
    expect((second as StripeError).meta.inFlight).toBe(true);
    const sent = calls.filter((c) => c.op === "setCancelAt");
    expect(sent).toHaveLength(2);
    expect(sent[1].key).toBe(sent[0].key);
    const pending = (await env.DB.prepare("SELECT idempotency_key FROM cancellation_stripe_mutations WHERE state='pending'").all<{ idempotency_key: string }>()).results;
    expect(pending.map((x) => x.idempotency_key)).toEqual([sent[0].key]);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL, lease_until=NULL WHERE home_id=?").bind(HOME).run();
    calls = [];
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    expect(calls.filter((c) => c.op === "setCancelAt")).toEqual([expect.objectContaining({ key: sent[0].key, at: P_END / 1000 })]);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE state='pending'")).toBe(0);
    expect(await env.DB.prepare("SELECT state FROM cancellation_stripe_mutations WHERE idempotency_key=?").bind(sent[0].key).first()).toEqual({ state: "confirmed" });
    expect(subState.cancel_at).toBe(P_END / 1000);
  });
});

describe("r4 #1: obligations stay open through the cancellation", () => {
  it("a release the cancellation undid, and that fails again after it, keeps the pause open; the next pass releases it, reads it back and closes", async () => {
    const later = ymd(P_END + 5 * DAY);
    const r = await submit({ type: "now_for_cause", reason: "Serious", requestedDate: later }); const id = r.body.id as string;
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    setClock(P_END_2 + DAY);
    // Three fresh keys fail after the cancel in ensureExecution, three more in the completed request's reconciliation right after it.
    onCancel = () => { failRelease = [0, 1, 2, 3, 4, 5].map(() => new StripeError(500, "api_error", { replayed: true })); };
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "accept", note: "ok" });
    expect(subState.status).toBe("canceled");
    expect(drafts[0].auto_advance).toBe(false);
    expect(await row(id)).toMatchObject({ status: "completed", stripe_synced: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(1);
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(drafts[0]).toMatchObject({ auto_advance: true });
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(0);
    expect(await row(id)).toMatchObject({ status: "completed", stripe_synced: 1 });
  });
});

describe("r4 #2: invoice reads that keep failing are escalated while the obligation stays open", () => {
  it("three failing passes, counted across passes with the first failure's time, raise ONE alert; a healthy pass then settles and closes", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    drafts.push({ id: "in_d1", auto_advance: false, created: Math.floor(P_END / 1000), start: P_END, end: P_END_2 });
    setClock(P_END + DAY); await sweepCancellations(env);
    invoiceReadDown = true;
    const first = cur;
    await adminPost(`/v1/admin/cancellations/${id}/reason`, { decision: "reject", note: "Not serious." });
    const pause = () => env.DB.prepare("SELECT settle_failures, settle_failing_since FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL").first();
    expect(await pause()).toEqual({ settle_failures: 1, settle_failing_since: first });
    expect(await alerts("cancellation.drafts_unsettled")).toBe(0);
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(await pause()).toEqual({ settle_failures: 2, settle_failing_since: first });
    expect(await alerts("cancellation.drafts_unsettled")).toBe(0);
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(await pause()).toEqual({ settle_failures: 3, settle_failing_since: first });
    expect(await alerts("cancellation.drafts_unsettled")).toBe(1);
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(await alerts("cancellation.drafts_unsettled")).toBe(1);
    expect(drafts[0].status ?? "draft").toBe("draft");
    expect(await row(id)).toMatchObject({ status: "completed", stripe_synced: 0 });
    invoiceReadDown = false;
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(drafts[0].status).toBe("void");
    expect(await pause()).toBeNull();
    expect(await row(id)).toMatchObject({ status: "completed", stripe_synced: 1 });
  });
});

describe("r4 #3: a replacement hold link is issued for as long as the hold is open", () => {
  it("a reason check past the original 365-day cap: after an email-generation change, /new-link mails a fresh bounded link that holds; legal dates unchanged", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const old = await holdToken(id);
    const before = await row(id);
    const cap = Math.max(before.received_at as number, (before.effective_at as number | null) ?? 0, (before.fallback_end_at as number | null) ?? 0) + 365 * DAY;
    setClock(cap + 10 * DAY);
    supa = { ...supa, updatedAt: "2027-01-01T00:00:00.000Z" };
    expect(await hold(old)).toMatchObject({ status: 409, body: { error: "identity_changed", canResend: true } });
    mails = [];
    expect((await post("/v1/public/withdrawal/new-link", { selector: old.selector })).status).toBe(202);
    expect(mails.length).toBe(1);
    const fresh = await holdToken(id);
    expect(fresh.selector).not.toBe(old.selector);
    expect(await env.DB.prepare("SELECT expires_at FROM verify_tokens WHERE selector=?").bind(fresh.selector).first()).toEqual({ expires_at: cur + 30 * DAY });
    expect((await hold(fresh)).body).toMatchObject({ outcome: "held" });
    expect(await row(id)).toMatchObject({ status: "held", received_at: before.received_at, effective_at: before.effective_at, fallback_end_at: before.fallback_end_at });
  });
});

describe("r4 #4: an incomplete read-back never settles a release", () => {
  it("open with auto_advance missing is not settled: the release is retried and escalated, the pause stays open; an explicit true then settles it", async () => {
    const r = await submit({ type: "now_for_cause", reason: "Serious" }); const id = r.body.id as string;
    const tok = await holdToken(id);
    drafts.push({ id: "in_draft", auto_advance: false, created: Math.floor(P_END / 1000) });
    setClock(P_END + DAY); await sweepCancellations(env);
    incompleteRead.add("in_draft"); calls = [];
    expect((await hold(tok)).body).toMatchObject({ outcome: "held" });
    expect(calls.filter((c) => c.op === "autoAdvance" && c.id === "in_draft").length).toBe(3);
    expect(await alerts("cancellation.drafts_unsettled")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(1);
    incompleteRead.clear();
    setClock(cur + 2 * HOUR); await sweepCancellations(env);
    expect(drafts[0].auto_advance).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE kind='pause' AND value=1 AND released_at IS NULL")).toBe(0);
  });
});

describe("the staging mail sink through the production sender (Astra TRUSTCODE-1 P3-3)", () => {
  it("cancellation mail: the real route, with the sink engaged and NO injected mailer, writes the sink rows and nothing reaches a provider", async () => {
    await installSink();
    sinkOn = true;
    try {
      setCancellationDeps({ now: () => cur, reader, stripe: fakeStripe, billing: { notifier }, siteOrigin: "https://murage.test" });
      const r = await submit({ email: "nobody@example.test", confirmationEmail: "nobody@example.test" });
      expect(r.status).toBe(201);
      expect(mails).toEqual([]);
      const rows = await sunk();
      expect(rows.map((x) => x.to_addr)).toEqual(["nobody@example.test"]);
      expect(rows[0].text).toContain(`We received your cancellation on ${fmtReceived(NOW, "en")}.`);
      const matched = await submit();
      expect(matched.status).toBe(201);
      expect((await sunk()).map((x) => x.to_addr).sort()).toEqual(["nobody@example.test", "pat@example.test"]);
      expect(realSends).toEqual([]);
    } finally { sinkOn = false; await dropSink(); }
  });
});

describe("Astra JOURNEY-BCORE-1 #1: the public path settles a pending request by its own key before any newer intent is confirmed", () => {
  const mut = (id: string) => env.DB.prepare("SELECT state,dispatched_at FROM cancellation_stripe_mutations WHERE id=?").bind(id).first<{ state: string; dispatched_at: string | null }>();
  /** A Keep's clear (cancel_at=null) went out at NOW and its answer was lost; Stripe shows no end; a newer cancellation wants P_END. */
  async function lostClear() {
    const r = await submit();
    const id = r.body.id as string;
    await env.DB.prepare(`INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,dispatched_at)
      VALUES ('m-keep',?,?,'cancel_at',NULL,'cxlmut:m-keep','pending',?,json_array(?))`).bind(SUBID, HOME, NOW, NOW).run();
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0 WHERE id=?").bind(id).run();
    subState.cancel_at = null;
    calls = [];
    return id;
  }

  it("probe: the retry of cancel_at=null gets an uncached 429 -> the newer cancellation is NOT confirmed -> the delayed original cannot clear it", async () => {
    const id = await lostClear();
    failCancelAtOnce = new StripeError(429, "stripe_rate_limit", { type: "invalid_request_error" }); // not replayed: the key is not settled
    const confirmedBefore = await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE state='confirmed'");
    setClock(NOW + 1000);
    expect(await reconcileSubscription(env, deps8(), SUBID).catch(() => "unresolved")).toBe("unresolved");
    // The 429 settled nothing: the clear stays pending (the answered retry is off the outstanding list; the lost original stays on it).
    expect((await mut("m-keep"))!.state).toBe("pending");
    expect(JSON.parse((await mut("m-keep"))!.dispatched_at!)).toEqual([NOW]);
    // Nothing newer was sent, nothing confirmed, nothing marked synced.
    expect(calls.filter((c) => c.op === "setCancelAt").map((c) => c.key)).toEqual(["cxlmut:m-keep"]);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE state='confirmed'")).toBe(confirmedBefore);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE state='pending'")).toBe(1);
    expect(await row(id)).toMatchObject({ stripe_synced: 0 });
    // The delayed original clear lands now: Stripe shows no end (it had none). The next pass settles its key (Stripe answers 2xx for it),
    // and only then sends the cancellation, which nothing can clear any more.
    subState.cancel_at = null;
    setClock(NOW + 2 * 60_000);
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    expect((await mut("m-keep"))!.state).toBe("confirmed");
    expect(subState.cancel_at).toBe(P_END / 1000);
    expect(await row(id)).toMatchObject({ stripe_synced: 1, stripe_cancel_at: P_END });
  });

  it("a validation 400 on the retry settles nothing either; the request is retired only when Stripe shows the subscription ended and every outstanding attempt is old", async () => {
    await lostClear();
    failCancelAtOnce = new StripeError(400, "stripe_parameter_invalid", { type: "invalid_request_error" });
    subState.status = "canceled";
    setClock(NOW + 60_000); // the lost original is one minute old: it may still land
    await reconcileSubscription(env, deps8(), SUBID).catch(() => undefined);
    expect((await mut("m-keep"))!.state).toBe("pending");
    failCancelAtOnce = new StripeError(400, "stripe_parameter_invalid", { type: "invalid_request_error" });
    setClock(NOW + 6 * 60_000); // older than Stripe's request timeout plus margin, and the subscription has ended at Stripe
    await reconcileSubscription(env, deps8(), SUBID).catch(() => undefined);
    expect((await mut("m-keep"))!.state).toBe("superseded");
  });

  it("a fresh request answered with an uncached 429 stays pending and is settled by its own key on the next pass", async () => {
    const r = await submit({ type: "on_date", requestedDate: ymd(P_END + 5 * DAY) });
    void r;
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0").run();
    subState.cancel_at = null; calls = [];
    failCancelAtOnce = new StripeError(429, "stripe_rate_limit", { type: "invalid_request_error" });
    await reconcileSubscription(env, deps8(), SUBID).catch(() => undefined);
    const pending = (await env.DB.prepare("SELECT id,idempotency_key AS k FROM cancellation_stripe_mutations WHERE state='pending'").all<{ id: string; k: string }>()).results;
    expect(pending).toHaveLength(1);
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    expect(calls.filter((c) => c.op === "setCancelAt").map((c) => c.key)).toEqual([pending[0].k, pending[0].k]);
    expect((await mut(pending[0].id))!.state).toBe("confirmed");
  });
});

// ---- follow-up 1: why the plan ended (summary), and a declaration the plan did not live to see -----------------------------------------
describe("follow-up 1 #1/#2: endedReason and refundState; a declaration outlived by an earlier end is completed and superseded", () => {
  const summary = async () => {
    const w = createWorker(fetch, fetch, {}, {}, { accountUser: async () => ({ id: USER }), stepUp: async () => true } as never);
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request("https://cp.test/v1/account/cloud", { method: "GET" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    return ((await res.json()) as { subscription: Record<string, unknown> }).subscription;
  };
  /** Stripe ended the subscription at `at` (its deletion on record): local canceled, ended_at stamped once, THE checkpoint set. */
  const stripeEnded = async (at: number, status = "canceled") => {
    subState.status = "canceled";
    await env.DB.prepare("UPDATE billing_subscriptions SET status=?,ended_at=?,stripe_end_confirmed=subscription_id,updated_at=? WHERE home_id=?")
      .bind(status, status === "canceled" ? at : null, at, HOME).run();
  };
  const refundOp = (id: string, kind: string, at: number, refundedAt: number | null) => env.DB.prepare(`INSERT INTO refund_ops
    (id,kind,home_id,user_id,invoice_id,payment_intent,end_plan,subscription_id,canceled_at,refunded_at,done_at,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?)`)
    .bind(id, kind, HOME, USER, "in_cur", "pi_in_cur", SUBID, at, refundedAt, refundedAt, at, at).run();
  const gaveUp = (at: number) => env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at,last_error,gave_up_at,give_up_code) VALUES (?,1,5,?,?,?,?)")
    .bind(HOME, at - HOUR, "host_403_resource_limit_exceeded", at, "host_403_resource_limit_exceeded").run();

  it("#1 null while the plan runs: no reason, no refund state", async () => {
    expect(await summary()).toMatchObject({ ended: false, endedReason: null, refundState: null });
  });
  it("#1 setup_failed_refunded, refund pending then sent", async () => {
    const t = NOW + HOUR;
    await gaveUp(t); await stripeEnded(t);
    await refundOp(`no_capacity:in_cur`, "no_capacity", t, null);
    expect(await summary()).toMatchObject({ ended: true, endedAt: t, endedReason: "setup_failed_refunded", refundState: "pending" });
    await env.DB.prepare("UPDATE refund_ops SET refunded_at=?,done_at=? WHERE id='no_capacity:in_cur'").bind(t + HOUR, t + HOUR).run();
    expect(await summary()).toMatchObject({ ended: true, endedReason: "setup_failed_refunded", refundState: "sent" });
  });
  it("#1 setup_failed_refunded with only the queued refund (no operation yet): pending", async () => {
    const t = NOW + HOUR;
    await gaveUp(t); await stripeEnded(t);
    // The give-up writes its obligation with the payment it refunds and that payment's identity (Astra MAILRETRY-13 P1-5).
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,1,?,'refund_required','{"paymentId":"in_cur"}',?)`)
      .bind(`refund:provision_failed:${HOME}:in_cur`, HOME, USER, t).run();
    await env.DB.prepare("INSERT INTO cloud_refund_identities (obligation_id,home_id,payment_id,subscription_id,captured_at) VALUES (?,?,?,?,?)")
      .bind(`refund:provision_failed:${HOME}:in_cur`, HOME, "in_cur", SUBID, t).run();
    expect(await summary()).toMatchObject({ endedReason: "setup_failed_refunded", refundState: "pending" });
  });
  it("MAILRETRY-14 P2-b: the home was given up for an earlier payment A (its own subscription); THIS contract is cancelled: 'cancelled', never A's failed setup or refund", async () => {
    const t0 = NOW - DAY; const t = NOW + HOUR;
    await gaveUp(t0);
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at,completed_at) VALUES (?,?,1,?,'refund_required','{"paymentId":"in_a"}',?,NULL)`)
      .bind(`refund:provision_failed:${HOME}:in_a`, HOME, USER, t0).run();
    await env.DB.prepare("INSERT INTO cloud_refund_identities (obligation_id,home_id,payment_id,subscription_id,captured_at) VALUES (?,?,?,?,?)")
      .bind(`refund:provision_failed:${HOME}:in_a`, HOME, "in_a", "sub_a_old", t0).run();
    await env.DB.prepare("INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,subscription_id,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)")
      .bind("no_capacity:in_a", "no_capacity", HOME, USER, "in_a", "sub_a_old", t0, t0).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET customer_cancel_at=? WHERE home_id=?").bind(NOW, HOME).run();
    await stripeEnded(t);
    expect(await summary()).toMatchObject({ ended: true, endedReason: "cancelled", refundState: null });
  });
  it("#1 withdrawn: the first-month refund ended it (refund sent)", async () => {
    const t = NOW + HOUR;
    await refundOp("firstmonth:wp8", "first_month", t, t + 1000); await stripeEnded(t);
    expect(await summary()).toMatchObject({ ended: true, endedReason: "withdrawn", refundState: "sent" });
  });
  it("#1 cancelled: an in-app cancellation ended it (no refund)", async () => {
    const t = NOW + HOUR;
    await env.DB.prepare("UPDATE billing_subscriptions SET customer_cancel_at=? WHERE home_id=?").bind(NOW, HOME).run();
    await stripeEnded(t);
    expect(await summary()).toMatchObject({ ended: true, endedReason: "cancelled", refundState: null });
  });
  it("#1 dispute: a payment dispute ended it", async () => {
    const t = NOW + HOUR;
    await env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES (?,?,'dispute_opened','{}',?)").bind(`${HOME}:dispute_opened:du_1`, HOME, t).run();
    await stripeEnded(t, "disputed");
    expect(await summary()).toMatchObject({ endedReason: "dispute", refundState: null });
  });

  it("#2 the staging shape: declared 05:12 for the period end, setup failed and refunded at 05:36, Stripe deleted at 05:36, the verifier later: completed and superseded", async () => {
    const r = await submit(); const id = r.body.id as string;
    const before = await row(id);
    expect(before).toMatchObject({ status: "open", effective_at: P_END, match_state: "matched" });
    const failedAt = NOW + 24 * MINUTE;
    await gaveUp(failedAt); await stripeEnded(failedAt);
    await refundOp(`no_capacity:in_cur`, "no_capacity", failedAt, failedAt + MINUTE);
    // The verifier runs later.
    setClock(NOW + 3 * HOUR);
    expect(await reconcileSubscription(env, deps8(), SUBID)).toBe("synced");
    const after = await row(id);
    expect(after).toMatchObject({ status: "completed", superseded_by: "plan_ended:setup_failed_refunded", completed_at: NOW + 3 * HOUR,
      effective_at: P_END, received_at: NOW, stripe_synced: 1 });
    // The receipt is the customer's record: never changed.
    expect(after.receipt_html).toBe(before.receipt_html); expect(after.receipt_sha256).toBe(before.receipt_sha256);
    expect((await call("GET", `/v1/public/cancellation/${id}/receipt`)).text).toBe(before.receipt_html);
    // The account summary agrees: ended at the real time, with the real reason; nothing is open, nothing to keep.
    expect(await summary()).toMatchObject({ ended: true, endedAt: failedAt, activeUntil: failedAt, endedReason: "setup_failed_refunded", refundState: "sent",
      cancellation: { state: null, endsAt: null, id: null, kind: null, keepable: false, keepIds: [] } });
    expect(await alerts("cancellation.subscription_gone")).toBe(0);
    // Idempotent; never un-completed, and the promise never moves, also once its date has passed.
    setClock(P_END + DAY); await sweepCancellations(env); await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ status: "completed", superseded_by: "plan_ended:setup_failed_refunded", effective_at: P_END, completed_at: NOW + 3 * HOUR });
  });

  it("#2 an ordinary declaration whose plan ends ON its date: unchanged (completed by its own end, never superseded)", async () => {
    const r = await submit(); const id = r.body.id as string;
    setClock(P_END - DAY); await sweepCancellations(env);
    expect((await row(id)).status).toBe("open");
    setClock(P_END + 1000); await sweepCancellations(env); await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ status: "completed", superseded_by: null, effective_at: P_END });
    expect(calls.some((c) => c.op === "cancel")).toBe(true);
    expect(await summary()).toMatchObject({ ended: true, endedAt: P_END, endedReason: "cancelled", refundState: null });
  });

  // ---- Astra INTEGRATED-5 #1: the end reason comes only from evidence that ended THIS contract, and the first cause wins ----
  it("INTEGRATED-5 #1 a declined first-month refund followed by an in-app cancellation reads cancelled, not withdrawn", async () => {
    const asked = NOW + HOUR;
    // Decided at nothing to refund, done, its end step never ran (a declined request ends nothing).
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,payment_intent,amount_cents,basis,end_plan,subscription_id,decided_at,done_at,
      created_at,updated_at) VALUES ('firstmonth:declined','first_month',?,?,'in_cur','pi_in_cur',0,'not_first_payment',1,?,?,?,?,?)`)
      .bind(HOME, USER, SUBID, asked, asked, asked, asked).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET customer_cancel_at=? WHERE home_id=?").bind(asked + HOUR, HOME).run();
    await stripeEnded(asked + 2 * HOUR);
    expect(await summary()).toMatchObject({ ended: true, endedReason: "cancelled", refundState: null });
  });
  it("INTEGRATED-5 #1 an earlier contract's withdrawal never names the replacement's end; this contract's own does", async () => {
    const wd = (id: string, consent: string, at: number) => env.DB.prepare(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,confirmed_at,early_start,days_supplied,
      deducted_cents,refund_cents,basis,status) VALUES (?,?,?,?,?,1,0,0,0,'pending','completed')`).bind(id, HOME, USER, consent, at).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET consent_id='consent-new' WHERE home_id=?").bind(HOME).run();
    await wd("wd-old", "consent-old", NOW - DAY);
    await stripeEnded(NOW + HOUR);
    expect(await summary()).toMatchObject({ ended: true, endedReason: "cancelled" });
    // (one withdrawal per home is ever on record: withdrawals_home) The same home's withdrawal of THIS contract instead:
    await env.DB.prepare("DELETE FROM withdrawals WHERE id='wd-old'").run();
    await wd("wd-new", "consent-new", NOW + MINUTE);
    expect(await summary()).toMatchObject({ endedReason: "withdrawn" });
  });
  it("INTEGRATED-5 #1 a plan cancelled first and disputed afterwards keeps its cancellation", async () => {
    const t = NOW + HOUR;
    await stripeEnded(t);
    await env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES (?,?,'dispute_opened','{}',?)").bind(`${HOME}:dispute_opened:du_2`, HOME, t + DAY).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET status='disputed',updated_at=? WHERE home_id=?").bind(t + DAY, HOME).run();
    expect(await summary()).toMatchObject({ endedReason: "cancelled" });
  });

  // ---- Astra INTEGRATED-5 #2: a queued obligation is never hidden by an earlier settled refund ----
  it("INTEGRATED-5 #2 a completed earlier refund plus a newly queued retired-home payment reads pending; all settled reads sent", async () => {
    const t = NOW + HOUR;
    await refundOp("firstmonth:wp8", "first_month", t, t + 1000); await stripeEnded(t);
    expect(await summary()).toMatchObject({ endedReason: "withdrawn", refundState: "sent" });
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,1,?,'refund_required',?,?)`)
      .bind("refund:retired:in_late", HOME, USER, JSON.stringify({ paymentId: "in_late", version: 2 }), t + DAY).run();
    expect(await summary()).toMatchObject({ refundState: "pending" });
    // Its operation opened and refunded: the operation stands for that payment (the queued row is acknowledged in the next batch).
    await refundOp("no_capacity:in_late", "no_capacity", t + DAY, t + DAY + 1000);
    expect(await summary()).toMatchObject({ refundState: "sent" });
    await env.DB.prepare("UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id='refund:retired:in_late'")
      .bind(t + DAY + 2000, JSON.stringify({ outcome: "refunded", paymentId: "in_late" })).run();
    expect(await summary()).toMatchObject({ refundState: "sent" });
  });

  // ---- Astra INTEGRATED-5 #3: the first verification after the promised date still supersedes ----
  it("INTEGRATED-5 #3 first verified after the promised date: completed by its date, then superseded; the summary shows the real end", async () => {
    const r = await submit(); const id = r.body.id as string;
    const before = await row(id);
    expect(before).toMatchObject({ status: "open", effective_at: P_END });
    const failedAt = NOW + 24 * MINUTE;
    await gaveUp(failedAt); await stripeEnded(failedAt);
    await refundOp(`no_capacity:in_cur`, "no_capacity", failedAt, failedAt + MINUTE);
    // Nothing ran until after the promise: the sweep's due-end pass completes it first, the verifier then corrects it.
    setClock(P_END + DAY); await sweepCancellations(env);
    const after = await row(id);
    expect(after).toMatchObject({ status: "completed", superseded_by: "plan_ended:setup_failed_refunded", completed_at: P_END + DAY, effective_at: P_END });
    expect(after.receipt_html).toBe(before.receipt_html); expect(after.receipt_sha256).toBe(before.receipt_sha256);
    expect(await summary()).toMatchObject({ ended: true, endedAt: failedAt, endedReason: "setup_failed_refunded", refundState: "sent" });
    // Idempotent: never un-completed, the promise never moves.
    await sweepCancellations(env); await sweepCancellations(env);
    expect(await row(id)).toMatchObject({ status: "completed", superseded_by: "plan_ended:setup_failed_refunded", completed_at: P_END + DAY, effective_at: P_END });
  });
});
