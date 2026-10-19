// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP10 (plan Test 6, the clarify / candidate / signed-in clarification / correction rows) over the real worker + D1.
// Stripe, the identity reader, the mailer and the alert webhook are fakes. No request carries a credential except the operator's admin token.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { acquireHomeLease } from "../src/billing-lease";
import { authFetch, cloudMember, jwksFetch, supabaseEnv } from "./cloud-member";
import { clearPublicHandlers } from "../src/public-routes";
import { registerCancellation, setCancellationDeps, sweepCancellations } from "../src/public-cancellation";
import { registerClarify } from "../src/clarify";
import { needsStepUp } from "../src/customer-identity";
import { stubFluxHooks, type BillingNotifier } from "../src/b5-billing";
import type { StripeClient } from "../src/b5-stripe";
import { reserveMail, type IdentityRead } from "../src/public-tokens";
import { fmtDate, fmtReceived } from "../src/cancellation-strings";
import { fmtExecuteByDate, MISSING_DE, S, t } from "../src/notice-strings";
import {
  ALERT_RETRY_MS, alertAtOf, authorize, executeByOf, flushMail, MAIL_ESCALATE_AFTER, itemAtOf, queueStatus, registerWithdrawalNotices, senderTrusted, setNoticeDeps, sweepWithdrawalNotices, utcDayStart, windowEndOf,
  type NoticeRow,
} from "../src/withdrawal-notices";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const USER = "wp9-owner";
const SUBJ = "7a1c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";   // the Supabase user id
const HOME = "wp9-home";
const SUBID = "sub_wp9";
const CUS = "cus_wp9";
const CONS = "consent-wp9";
const IMAGE = `sha256:${"b".repeat(64)}`;
const ADMIN = "wp9-admin-token";
const MADE = NOW - 3 * DAY;          // the contract was made 3 days ago
const RECEIVED = NOW - DAY;          // the notice arrived yesterday

let cur: number;
let stripeBlocked = false;
let supa: IdentityRead;
let readerDown = false;
const reader = { async emailGen(): Promise<IdentityRead> { if (readerDown) throw new Error("down"); return { ...supa }; } };
interface Mail { to: string; subject: string; text: string }
let mails: Mail[];
let calls: { op: string; [k: string]: unknown }[];
let paid: Record<string, unknown>[];
let invoiceById: Record<string, { id: string; amount_paid: number; tax: number; payment_intent: string | null }>;
let refunds: { id: string; amount: number }[];
let notes: { id: string; invoice: string; amount: number; refund: string | null; status: string; metadata: Record<string, string> }[];
let hooks: { body: string }[];
let hookOk = false;
let mailFails = 0;
const P_START = MADE;
const P_END = MADE + 30 * DAY;
const identifiers: Record<string, string[]> = {};
const invoice = (id: string, createdMs: number, startMs: number, endMs: number, cents = 9900) => ({ id, status: "paid", amount_paid: cents, amount_due: 0, auto_advance: false, subscription: SUBID,
  billing_reason: "subscription_cycle", payment_intent: `pi_${id}`, tax: 0, created: Math.floor(createdMs / 1000), subscriptionMetadata: {},
  lines: { data: [{ price: "price_pro", proration: false, subscription: SUBID, item: null, source: "subscription", period: { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) }, amount: cents }], has_more: false } });
function addInvoice(i: ReturnType<typeof invoice>) { paid.push(i); invoiceById[i.id] = { id: i.id, amount_paid: i.amount_paid, tax: 0, payment_intent: i.payment_intent }; }

// r1-12: WP8's stateful Stripe fake: the subscription as Stripe keeps it (cancel_at, pause, status), read back by the reconciliation, so a test
// proves the mutation LANDED (not merely that it was attempted), and a renewal at the period end follows what Stripe holds.
let subState: { status: string; cancel_at: number | null; pause_collection: string | null };
const fakeStripe = {
  setCancelAt: async (id: string, at: number | null, key?: string) => { calls.push({ op: "setCancelAt", id, at, key }); subState.cancel_at = at; return { id }; },
  setPauseCollection: async (id: string, behavior: string | null, key: string) => { calls.push({ op: "pause", id, behavior, key }); subState.pause_collection = behavior; return { id }; },
  cancelSubscription: async (id: string) => { if (stripeBlocked) throw new Error("stripe down"); calls.push({ op: "cancel", id }); subState.status = "canceled"; return { id, status: "canceled" }; },
  getSubscription: async (id: string) => ({ id, status: subState.status, current_period_start: Math.floor(P_START / 1000), current_period_end: Math.floor(P_END / 1000),
    cancel_at: subState.cancel_at, pause_collection: subState.pause_collection }),
  listSubscriptionInvoices: async (_id: string, status: string) => (status === "paid" ? paid : []),
  setInvoiceAutoAdvance: async (id: string, on: boolean, key: string) => { calls.push({ op: "autoAdvance", id, on, key }); return { id }; },
  customersForIdentifier: async (i: string) => identifiers[i] ?? [],
  listPaidInvoices: async () => ({ data: paid }),
  getInvoice: async (id: string) => invoiceById[id],
  listRefunds: async (pi: string) => ({ data: refunds.filter((r) => (r as unknown as { pi: string }).pi === pi) }),
  getRefund: async (id: string) => refunds.find((r) => r.id === id)!,
  createRefund: async (i: { paymentIntent: string; amountCents?: number }) => { const r = { id: `re_${refunds.length + 1}`, amount: i.amountCents ?? 0, pi: i.paymentIntent, status: "succeeded", payment_intent: i.paymentIntent, metadata: {} }; refunds.push(r); calls.push({ op: "refund", amount: r.amount }); return r; },
  listCreditNotes: async (invoiceId: string) => ({ data: notes.filter((n) => n.invoice === invoiceId) }),
  getCreditNote: async (id: string) => notes.find((n) => n.id === id)!,
  createCreditNote: async (i: { invoiceId: string; amountCents: number; opId: string; submission: number }) => {
    if (stripeBlocked) throw new Error("stripe down");
    const r = { id: `re_${refunds.length + 1}`, amount: i.amountCents, pi: invoiceById[i.invoiceId].payment_intent, status: "succeeded" }; refunds.push(r as never);
    const n = { id: `cn_${notes.length + 1}`, status: "issued", invoice: i.invoiceId, amount: i.amountCents, refund: r.id, metadata: { op_id: i.opId, submission: String(i.submission) } };
    notes.push(n); calls.push({ op: "credit_note", amount: i.amountCents, invoice: i.invoiceId }); return n;
  },
} as unknown as StripeClient;

const notifier: BillingNotifier = { notify: async () => undefined };
const flux = { ...stubFluxHooks, stub: false, capabilities: { reversalTargets: true } as const, stopForBilling: async () => undefined, changePlan: async () => undefined, grantMonthlyCredits: async () => undefined,
  usedIncludedCreditMicrocents: async () => ({ usedMicrocents: 0 }), setAutoRecharge: async () => undefined } as never;
const mailer = { async send(m: Mail & { from: unknown; html: string }) { if (mailFails > 0) { mailFails -= 1; throw new Error("smtp down"); } mails.push({ to: m.to, subject: m.subject, text: m.text }); } };
const fetcher = (async (_url: unknown, init?: { body?: string }) => { hooks.push({ body: String(init?.body ?? "") }); return new Response("{}", { status: hookOk ? 200 : 500 }); }) as unknown as typeof fetch;
const deps = (over: Record<string, unknown> = {}) => ({ now: () => cur, reader, stripe: fakeStripe, mailer, billing: { notifier, flux }, siteOrigin: "https://murage.test", fetcher, ...over });

let signedIn: string | null = null;
let stepUpOk = false;
const worker = createWorker(fetch, fetch, {}, {}, { accountUser: async () => (signedIn ? ({ id: signedIn } as never) : null), stepUp: async () => stepUpOk });
const testEnv = () => ({ ...env, IDENTITY_READER: reader, CLOUD_ADMIN_TOKEN: ADMIN, ALERT_WEBHOOK_URL: "https://alerts.test/hook", MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;
let ipCounter = 0;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${(ipCounter++ % 250) + 1}`, ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* html */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const post = (path: string, body: unknown) => call("POST", path, body);
const adminPost = (path: string, body: unknown) => call("POST", path, body, { authorization: `Bearer ${ADMIN}` });
const adminGet = (path: string) => call("GET", path, undefined, { authorization: `Bearer ${ADMIN}` });
const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const row = async (id: string) => (await env.DB.prepare("SELECT * FROM withdrawal_notices WHERE id=?").bind(id).first<NoticeRow>())!;
const setClock = (ms: number) => { cur = ms; };

const gmailAuth = { source: "boundary", spf: { result: "pass", domain: "gmail.com" }, dkim: { result: "pass", domain: "gmail.com" } };
let msgN = 0;
const intakeBody = (over: Record<string, unknown> = {}) => ({ receivedAt: RECEIVED, from: ["pat@gmail.com"], boundaryAuth: gmailAuth, messageId: `<m${++msgN}@mail.test>`, language: "en",
  classification: "withdrawal", classificationBasis: "says: I withdraw", ...over });
async function intake(over: Record<string, unknown> = {}) {
  const r = await adminPost("/v1/admin/withdrawals/intake", intakeBody(over));
  expect([200, 201]).toContain(r.status);
  return { id: r.body.id as string, res: r.body };
}
const LINK = "https:\\/\\/murage\\.test\\/(?:verify|not-me)#([A-Za-z0-9_-]{22})\\.([A-Za-z0-9_-]{43})";
function tokens(m?: Mail) {
  const mail = m ?? verifyMails().pop()!;
  expect(mail, "a verification mail").toBeTruthy();
  const c = new RegExp(`(?:Confirm withdrawal|Widerruf bestätigen): ${LINK}`).exec(mail.text)!;
  const r = new RegExp(`(?:This wasn't me|Das war ich nicht): ${LINK}`).exec(mail.text)!;
  return { confirm: { selector: c[1], secret: c[2] }, repudiate: { selector: r[1], secret: r[2] } };
}
const confirm = (tok: { selector: string; secret: string }) => post("/v1/public/withdrawal/confirm", tok);
const repudiate = (tok: { selector: string; secret: string }) => post("/v1/public/withdrawal/repudiate", tok);
const execute = (id: string) => adminPost(`/v1/admin/withdrawals/${id}/execute`, {});
const verifyMails = () => mails.filter((m) => /(Confirm withdrawal|Widerruf bestätigen): https/.test(m.text));
const submissions = () => calls.filter((c) => c.op === "refund" || c.op === "credit_note");
const ops = () => count("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='withdrawal' AND home_id=?", HOME);
const wds = () => count("SELECT COUNT(*) AS n FROM withdrawals WHERE home_id=?", HOME);

beforeEach(async () => {
  cur = NOW; supa = { id: SUBJ, email: "pat@gmail.com", updatedAt: "2026-10-01T00:00:00.000Z" }; readerDown = false; stripeBlocked = false; mails = []; calls = []; paid = [];
  invoiceById = {}; refunds = []; notes = []; hooks = []; hookOk = false; mailFails = 0; signedIn = null; stepUpOk = false;
  subState = { status: "active", cancel_at: null, pause_collection: null };
  addInvoice(invoice("in_first", MADE, MADE, MADE + 30 * DAY));
  setNoticeDeps(deps()); setCancellationDeps(deps());
  clearPublicHandlers(); registerCancellation(); registerWithdrawalNotices(); registerClarify();
  await env.DB.batch(["cancellation_requests", "cancellation_mail", "cancellation_cases", "withdrawal_notices", "withdrawal_authorizations", "withdrawal_notice_events", "withdrawal_notice_cases", "withdrawal_notice_mail", "withdrawals", "refund_ops", "verify_tokens",
    "public_mail_limits", "billing_subscriptions", "checkout_consents", "cloud_alerts", "cloud_homes", "supabase_identities"].map((tbl) => env.DB.prepare(`DELETE FROM ${tbl}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'Pat', 'cloud-wp9@cloud-account.invalid',1,?,?)`).bind(USER, NOW, NOW),
    env.DB.prepare(`INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)`).bind(SUBJ, USER, NOW - 30 * DAY, "pat@gmail.com"),
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(HOME, "inst-wp9", USER, IMAGE, NOW, NOW),
    env.DB.prepare(`INSERT INTO checkout_consents (id,home_id,user_id,created_at,screen_version,cloud_terms_version,tos_version,privacy_version,terms_accepted,recurring_authorized,early_start,eu_region,topup_enabled,
      renewal_text,wording,billing_country,plan,price_cents,start_at,first_charge_at,delayed_start,tax_source,completed_at,contract_made_at,stripe_subscription_id,stripe_session_id)
      VALUES (?,?,?,?,'s1','c1','t1','p1',1,1,0,1,0,'Renews monthly.','w','DE','pro',9900,?,?,0,'stripe_tax',?,?,?,'cs_wp9')`).bind(CONS, HOME, USER, MADE - 60_000, MADE, MADE, MADE, MADE, SUBID),
    env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at,consent_id,first_invoice_id,first_paid_at,
      first_invoice_cents,first_invoice_tax_cents,first_period_start,first_period_end,first_payment_intent) VALUES (?,?,?,'pro','active',?,?,?,?,?,'in_first',?,9900,0,?,?,'pi_in_first')`)
      .bind(HOME, CUS, SUBID, MADE, MADE + 30 * DAY, NOW, NOW, CONS, MADE, MADE, MADE + 30 * DAY),
  ]);
});


// ---------------------------------------------------------------------------------------------------------------------------------------
type Tok = { selector: string; secret: string };
const LINK_RE = (label: string) => new RegExp(`${label}: https://murage\\.test/(?:clarify|verify|not-me)#([A-Za-z0-9_-]{22})\\.([A-Za-z0-9_-]{43})`);
const tok = (m: Mail, label: string): Tok => { const x = LINK_RE(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).exec(m.text)!; expect(x, `link for ${label}`).toBeTruthy(); return { selector: x[1], secret: x[2] }; };
const NOW_LABEL = { en: "End now, delete my server with everything on it, and get everything back", de: "Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen" };
const END_LABEL = { en: "End at the end of the month I've paid for", de: "Zum Ende des bezahlten Monats beenden" };
const askMails = () => mails.filter((m) => m.text.includes(NOW_LABEL.en) || m.text.includes(NOW_LABEL.de));
const askTokens = (m = askMails().pop()!, lang: "en" | "de" = "en") => { expect(m, "an ask mail").toBeTruthy(); return { now: tok(m, NOW_LABEL[lang]), end: tok(m, END_LABEL[lang]) }; };
const WD_LABEL = "Withdraw now and delete my server";
const correctionMails = () => mails.filter((m) => m.subject === t("subjectCorrection", "en") || m.subject === t("subjectCorrection", "de"));
const holdMails = () => mails.filter((m) => /This wasn't me: https/.test(m.text) && !/Confirm withdrawal/.test(m.text));
const holdToken = (): Tok => { const m = holdMails().pop()!; expect(m, "a cancellation confirmation with the hold link").toBeTruthy(); const x = /This wasn't me: https:\/\/murage\.test\/(?:verify|not-me)#([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/.exec(m.text)!; return { selector: x[1], secret: x[2] }; };
const clarify = (t0: Tok, action: string) => post("/v1/public/clarify", { ...t0, action });
const cand = async (over: Record<string, unknown> = {}) => intake({ classification: "candidate", classificationBasis: "says: cancel", ...over });
const reqOf = async (id: string) => (await env.DB.prepare("SELECT * FROM cancellation_requests WHERE id=(SELECT cancellation_request_id FROM withdrawal_notices WHERE id=?)").bind(id).first<Record<string, unknown>>())!;
const classify = (id: string, classification: string, extra: Record<string, unknown> = {}) => adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification, basis: "re-read", ...extra });
const setCancelCalls = () => calls.filter((c) => c.op === "setCancelAt");
/** Stripe's own renewal at the period end, from what it holds: a cancel_at at or before the end ends the subscription; otherwise it renews and charges. */
function stripeRenewal() {
  if (subState.status !== "active") return;
  if (subState.cancel_at !== null && subState.cancel_at * 1000 <= P_END) { subState.status = "canceled"; return; }
  addInvoice(invoice("in_renew", P_END, P_END, P_END + 30 * DAY));
}
const unusedClarify = (id: string) => count("SELECT COUNT(*) AS n FROM verify_tokens WHERE subject_id=? AND purpose='clarify' AND used_at IS NULL", id);

describe("candidate: the ask email and the renewal stop", () => {
  it("a dateless cancel from the account email: ask email with two buttons AND the scheduled stop with its confirmation and hold link; the notice stays a candidate", async () => {
    const { id } = await cand();
    const n = await row(id);
    expect(n.classification).toBe("candidate");
    expect(n.state).toBe("open");
    expect(n.classification_rev).toBe(1);                       // sending never changes the classification
    expect(askMails()).toHaveLength(1);
    expect(askMails()[0].text).toContain(t("ask", "en", { received_at: fmtReceived(RECEIVED, "en"), plan_name: "pro", plan_started_on: fmtDate(MADE, "en") }));
    const r = await reqOf(id);
    expect(r.kind).toBe("ordinary_earliest");
    expect(r.received_at).toBe(RECEIVED);                        // the ORIGINAL receipt
    expect(r.effective_at).toBe(P_END);
    expect(r.status).toBe("open");
    expect(setCancelCalls().map((c) => c.at)).toContain(P_END / 1000);   // through WP8's request, at the end of the paid month
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    const hold = holdMails();
    expect(hold).toHaveLength(1);
    expect(hold[0].text).toContain(fmtDate(P_END, "en"));        // the exact end date
    expect(hold[0].to).toBe("pat@gmail.com");
    expect(await wds()).toBe(0);
    expect(await unusedClarify(id)).toBe(2);
  });
  it("the ask email in German is the plan's German", async () => {
    const { id } = await cand({ language: "de" });
    const m = askMails().pop()!;
    expect(m.text).toContain(t("ask", "de", { received_at: fmtReceived(RECEIVED, "de"), plan_name: "pro", plan_started_on: fmtDate(MADE, "de") }));
    expect(m.text).toContain(`${NOW_LABEL.de}: https://murage.test/clarify#`);
    expect((await row(id)).language).toBe("de");
  });
  it("a candidate from another address gets no automatic action (the stop is an instruction only the account's own address can give)", async () => {
    const { id } = await cand({ from: ["someone@example.test"], boundaryAuth: undefined, accountId: USER });
    expect((await row(id)).cancellation_request_id).toBeNull();
    expect(askMails()).toHaveLength(0);
    expect(setCancelCalls()).toHaveLength(0);
  });
  it("fallback only: an explicit withdrawal (whole-plan refund) gets the verification email and NO ask email, no cancellation", async () => {
    const { id } = await intake({ classificationBasis: "says: cancel my plan and refund everything I paid" });
    expect(askMails()).toHaveLength(0);
    expect(verifyMails()).toHaveLength(1);
    expect((await row(id)).cancellation_request_id).toBeNull();
  });
  it("a support question gets no email at all; mixed intent keeps the withdrawal; a wrong label never closes a candidate", async () => {
    const s = await intake({ classification: "support", classificationBasis: "why was I charged twice" });
    expect(mails).toHaveLength(0);
    expect((await row(s.id)).state).toBe("open");
    mails = [];
    await env.DB.prepare("DELETE FROM withdrawal_notices").run();
    const w = await intake({ classificationBasis: "I withdraw now; why was I charged twice?" });
    expect((await row(w.id)).classification).toBe("withdrawal");
    expect(verifyMails()).toHaveLength(1);
    await env.DB.prepare("DELETE FROM withdrawal_notices").run(); await env.DB.prepare("DELETE FROM verify_tokens").run(); await env.DB.prepare("DELETE FROM withdrawal_notice_mail").run();
    const c = await cand();
    const re = await classify(c.id, "support");
    expect(re.status).toBe(200);
    const n = await row(c.id);
    expect(n.state).toBe("open");                                // the case, its evidence and its deadline stay
    expect(n.execute_by).toBe(executeByOf(RECEIVED));
    setClock(executeByOf(RECEIVED) + 2000);
    await sweepWithdrawalNotices(testEnv());
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='reclassified'", c.id)).toBe(1);
  });
});

describe("clarify links", () => {
  it("withdraw now: one fenced transaction: classification withdrawal, rev+1, executing, one authorization (via clarify), one withdrawal and refund; the sibling is dead; original timing", async () => {
    const { id } = await cand();
    const k = askTokens();
    const r = await clarify(k.now, "withdraw_now");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: "withdrawn", receivedAt: RECEIVED, effectiveAt: RECEIVED });
    const n = await row(id);
    expect(n).toMatchObject({ classification: "withdrawal", classification_rev: 2, state: expect.stringMatching(/executing|completed/), executed_via: "clarify", clarified_action: "withdraw_now", received_at: RECEIVED, eligibility_at: RECEIVED });
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_authorizations WHERE notice_id=? AND via='clarify'", id)).toBe(1);
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    expect(await unusedClarify(id)).toBe(0);
    const sib = await clarify(k.end, "cancel_at_end");
    expect(sib.status).toBe(200);
    expect(sib.body.outcome).toBe("refused");
    expect(await wds()).toBe(1);
    // the same link again: the committed state, nothing acted twice
    const again = await clarify(k.now, "withdraw_now");
    expect(again.body.outcome).toBe("withdrawn");
    expect(await wds()).toBe(1);
  });
  it("end at the end of the paid month: classification cancellation, rev+1, no withdrawal; the later confirmation states the end date; the other button is refused", async () => {
    const { id } = await cand();
    const k = askTokens();
    const r = await clarify(k.end, "cancel_at_end");
    expect(r.body).toMatchObject({ outcome: "cancel_scheduled", receivedAt: RECEIVED, effectiveAt: P_END });
    const n = await row(id);
    expect(n).toMatchObject({ classification: "cancellation", classification_rev: 2, state: "open", clarified_action: "cancel_at_end" });
    expect(await wds()).toBe(0);
    expect((await clarify(k.now, "withdraw_now")).body.outcome).toBe("refused");
    expect(await wds()).toBe(0);
    const last = mails.filter((m) => m.subject === "Murage Cloud: your plan").pop()!;
    expect(last.text).toContain(fmtDate(P_END, "en"));
    expect(last.text).not.toContain("plan continues");
  });
  it("concurrent presses of the two buttons: exactly one wins, the other is refused", async () => {
    for (const first of ["now", "end"] as const) {
      await env.DB.batch(["withdrawal_notices", "withdrawal_authorizations", "withdrawals", "refund_ops", "verify_tokens", "cancellation_requests", "withdrawal_notice_mail"].map((x) => env.DB.prepare(`DELETE FROM ${x}`)));
      mails = []; calls = [];
      const { id } = await cand();
      const k = askTokens();
      const [a, b] = first === "now"
        ? await Promise.all([clarify(k.now, "withdraw_now"), clarify(k.end, "cancel_at_end")])
        : await Promise.all([clarify(k.end, "cancel_at_end"), clarify(k.now, "withdraw_now")]);
      const outs = [a.body.outcome, b.body.outcome].sort();
      expect(outs.filter((o) => o === "refused")).toHaveLength(1);
      const n = await row(id);
      expect(n.clarified_action).not.toBeNull();
      expect(n.classification_rev).toBe(2);
      expect(await wds()).toBe(n.clarified_action === "withdraw_now" ? 1 : 0);
      expect(await ops()).toBe(n.clarified_action === "withdraw_now" ? 1 : 0);
    }
  });
  it("the same button pressed twice at once: one effect, both told the committed state", async () => {
    const { id } = await cand();
    const k = askTokens();
    const [a, b] = await Promise.all([clarify(k.now, "withdraw_now"), clarify(k.now, "withdraw_now")]);
    expect([a.body.outcome, b.body.outcome]).toEqual(["withdrawn", "withdrawn"]);
    expect(await wds()).toBe(1);
    expect((await row(id)).classification_rev).toBe(2);
  });
  it("a redeem after a reclassification is refused as stale (consumes nothing); a reclassification after the redeem cannot undo the authorization", async () => {
    const { id } = await cand();
    const k = askTokens();
    // r1-4: an undecided relabel (support) keeps the candidate's choices; a withdrawal label is what moves the ask links' revision away
    expect((await classify(id, "withdrawal")).status).toBe(200);
    const stale = await clarify(k.now, "withdraw_now");
    expect(stale.status).toBe(200);
    expect(stale.body.outcome).toBe("stale");
    expect(await wds()).toBe(0);
    expect((await env.DB.prepare("SELECT used_at FROM verify_tokens WHERE selector=?").bind(k.now.selector).first<{ used_at: number | null }>())!.used_at).toBeNull();
    // fresh run: redeem, then reclassify
    await env.DB.batch(["withdrawal_notices", "verify_tokens", "cancellation_requests", "withdrawal_notice_mail"].map((x) => env.DB.prepare(`DELETE FROM ${x}`)));
    mails = [];
    const c2 = await cand();
    await clarify(askTokens().now, "withdraw_now");
    const re = await classify(c2.id, "support");
    expect(re.status).toBe(409);
    expect(re.body.error).toBe("not_open");
    expect((await row(c2.id)).classification).toBe("withdrawal");
    expect(await wds()).toBe(1);
  });
  it("scanner prefetch: GET is refused and changes nothing; the lookup names the plan, the action and the end date and consumes nothing", async () => {
    const { id } = await cand();
    const k = askTokens();
    const g = await call("GET", "/v1/public/clarify");
    expect(g.status).toBe(405);
    const lk = await post("/v1/public/token/lookup", k.end);
    expect(lk.body).toMatchObject({ kind: "clarify", state: "open", action: "cancel_at_end", planName: "pro", planStartedOn: expect.any(String), effectiveAt: P_END, receivedAt: RECEIVED });
    const lk2 = await post("/v1/public/token/lookup", k.now);
    expect(lk2.body).toMatchObject({ kind: "clarify", action: "withdraw_now" });
    expect(await unusedClarify(id)).toBe(2);
    expect((await row(id)).classification_rev).toBe(1);
  });
  it("action substitution and purpose mixing are refused", async () => {
    await cand();
    const k = askTokens();
    expect((await clarify(k.end, "withdraw_now")).body.error).toBe("link_invalid");
    expect((await clarify(k.now, "cancel_at_end")).body.error).toBe("link_invalid");
    expect((await post("/v1/public/withdrawal/confirm", k.now)).body.error).toBe("link_invalid");
    expect((await post("/v1/public/withdrawal/repudiate", k.end)).body.error).toBe("link_invalid");
    expect(await wds()).toBe(0);
    // a confirm token on the clarify endpoint
    await env.DB.batch(["withdrawal_notices", "verify_tokens", "withdrawal_notice_mail"].map((x) => env.DB.prepare(`DELETE FROM ${x}`)));
    mails = [];
    await intake();
    expect((await clarify(tokens().confirm, "withdraw_now")).body.error).toBe("link_invalid");
  });
  for (const state of ["repudiated", "kept", "executing", "completed"] as const) {
    it(`a ${state} notice cannot be reopened by a clarify link (the page renders the committed state, the link is not consumed)`, async () => {
      const { id } = await cand();
      const k = askTokens();
      await env.DB.prepare("UPDATE withdrawal_notices SET state=? WHERE id=?").bind(state, id).run();
      for (const [t0, a] of [[k.now, "withdraw_now"], [k.end, "cancel_at_end"]] as const) {
        const r = await clarify(t0, a);
        expect(r.status).toBe(200);
        expect(r.body.outcome).toBe("closed");
      }
      expect(await wds()).toBe(0);
      expect(await unusedClarify(id)).toBe(2);
      expect((await row(id)).classification).toBe("candidate");
      // and not signed in either
      signedIn = USER;
      const s = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 1 });
      expect(s.body.outcome).toBe("closed");
      expect(await wds()).toBe(0);
    });
  }
  it("a link past its 14-day cap is expired (no new link is sent), and the lookup says so", async () => {
    setClock(NOW - 20 * DAY);                                    // links issued long ago: past their cap by the real clock the public routes use
    await cand();
    const k = askTokens();
    setClock(NOW);
    const r = await clarify(k.now, "withdraw_now");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("link_expired");
    expect(r.body.canResend).toBe(false);                        // r1-11: no new link exists for a clarify link; the signed-in route is the way
    const before = mails.length;
    expect((await post("/v1/public/withdrawal/new-link", { selector: k.now.selector })).status).toBe(202);
    expect(mails.length).toBe(before);
  });
  it("the identity guard holds: a changed account email refuses the link", async () => {
    await cand();
    const k = askTokens();
    supa = { ...supa, email: "other@example.test", updatedAt: "2026-10-05T00:00:00.000Z" };
    expect((await clarify(k.now, "withdraw_now")).body.error).toBe("identity_changed");
    expect(await wds()).toBe(0);
  });
});

describe("no answer still stops the renewal; the hold link keeps the plan", () => {
  it("unanswered across the renewal date: the stop stays scheduled (no charge), no server is deleted, the notice goes overdue and stays open", async () => {
    const { id } = await cand();
    // r1-12: the stop LANDED in Stripe (read back by the reconciliation), not merely attempted
    await sweepCancellations(testEnv());
    expect(subState.cancel_at).toBe(P_END / 1000);
    expect(await reqOf(id)).toMatchObject({ stripe_synced: 1, stripe_cancel_at: P_END, status: "open" });
    expect((await reqOf(id)).stripe_verified_at).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE subscription_id=? AND state='pending'", SUBID)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_stripe_mutations WHERE subscription_id=? AND kind='cancel_at' AND state='confirmed' AND value=?", SUBID, P_END / 1000)).toBeGreaterThan(0);
    // the period ends: Stripe follows what it holds, so the subscription ends instead of renewing (no renewal invoice, nothing charged)
    setClock(P_END + HOUR);
    stripeRenewal();
    expect(subState.status).toBe("canceled");
    expect(paid.map((i) => i.id)).toEqual(["in_first"]);
    await sweepCancellations(testEnv());
    await sweepWithdrawalNotices(testEnv());
    const n = await row(id);
    expect(n.state).toBe("open");
    expect(n.classification).toBe("candidate");
    expect(n.overdue_at).not.toBeNull();
    expect(queueStatus(n, cur)).toBe("overdue");
    expect(await wds()).toBe(0);
    expect(setCancelCalls().map((c) => c.at)).toContain(P_END / 1000);
    expect((await reqOf(id)).status).toBe("completed");
    expect(submissions()).toHaveLength(0);                      // no refund path ran: nothing was withdrawn on a guess
    expect(calls.filter((c) => c.op === "cancel")).toHaveLength(0);   // Stripe ended it at cancel_at; nothing had to be forced
  });
  it("the hold link before the end date keeps the plan; the later answer 'end at the end of the month' confirms the COMMITTED state: the plan continues", async () => {
    const { id } = await cand();
    const hold = await repudiate(holdToken());
    expect(hold.status).toBe(200);
    expect((await reqOf(id)).status).toBe("held");
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    const k = askTokens();
    const r = await clarify(k.end, "cancel_at_end");
    expect(r.body.outcome).toBe("cancel_held");                  // r1-7: the committed state (held: the plan continues), never "scheduled"
    expect(r.body.effectiveAt).toBeUndefined();
    expect((await reqOf(id)).status).toBe("held");               // nothing rescheduled
    const last = mails.filter((m) => m.subject === "Murage Cloud: your plan").pop()!;
    expect(last.text).toContain("your plan continues");
    expect(last.text).not.toContain(`Your plan ends on`);
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
  });
});

describe("signed-in clarification (aal1, original timestamps, terminal guards)", () => {
  it("is not a step-up route", () => {
    expect(needsStepUp("POST", "/v1/account/notices/abc/clarify")).toBe(false);
  });
  it("GET /v1/account/notices: a candidate's shape", async () => {
    const { id } = await cand();
    signedIn = USER;
    const r = await call("GET", "/v1/account/notices");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ notices: [{ id, kind: "candidate", classificationRev: 1, receivedAt: RECEIVED, eligibilityAt: RECEIVED, planName: "pro", planStartedOn: new Date(MADE).toISOString().slice(0, 10),
      effectiveAt: P_END, choices: ["withdraw_now", "cancel_at_end"], expiresAt: executeByOf(RECEIVED) + 1000 }] });
    signedIn = null;
    expect((await call("GET", "/v1/account/notices")).status).toBe(401);
  });
  it("GET /v1/account/notices: a classified withdrawal offers ['confirm']; a correction notice offers both choices; settled, other accounts' and terminal notices are not listed", async () => {
    const w = await intake();
    signedIn = USER;
    let r = await call("GET", "/v1/account/notices");
    expect((r.body.notices as Record<string, unknown>[]).map((n) => [n.kind, n.choices])).toEqual([["withdrawal", ["confirm"]]]);
    expect((r.body.notices as Record<string, unknown>[])[0].effectiveAt).toBeUndefined();
    tokens();                                                    // the trusted email went
    expect((await classify(w.id, "support")).status).toBe(200);
    r = await call("GET", "/v1/account/notices");
    expect((r.body.notices as Record<string, unknown>[]).map((n) => [n.kind, n.choices, n.classificationRev])).toEqual([["correction", ["withdraw_now", "cancel_at_end"], 2]]);
    signedIn = "someone-else";
    expect((await call("GET", "/v1/account/notices")).body.notices).toEqual([]);
    signedIn = USER;
    await env.DB.prepare("UPDATE withdrawal_notices SET state='executing' WHERE id=?").bind(w.id).run();
    expect((await call("GET", "/v1/account/notices")).body.notices).toEqual([]);
  });
  it("after the link expired AND the window for links passed, the holder settles it signed in: withdraw now keeps received_at and eligibility_at, one refund", async () => {
    setClock(NOW - 20 * DAY);
    const { id } = await cand();
    const k = askTokens();
    setClock(RECEIVED + 16 * DAY);
    expect((await clarify(k.now, "withdraw_now")).body.error).toBe("link_expired");
    signedIn = USER;
    const stale = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale_revision");
    expect(await wds()).toBe(0);
    const ok = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ outcome: "withdrawn", receivedAt: RECEIVED });
    const n = await row(id);
    expect(n).toMatchObject({ received_at: RECEIVED, eligibility_at: RECEIVED, executed_via: "clarify", classification: "withdrawal" });
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    // a repeat is the committed state, not a second withdrawal
    const rep = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 1 });
    expect(rep.body.outcome).toBe("withdrawn");
    expect(await wds()).toBe(1);
  });
  it("end at the end of the paid month signed in; another account's notice is not found; the other choice is then refused", async () => {
    const { id } = await cand();
    signedIn = "someone-else";
    expect((await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 1 })).status).toBe(404);
    signedIn = USER;
    const ok = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 1 });
    expect(ok.body).toMatchObject({ outcome: "cancel_scheduled", effectiveAt: P_END });
    expect((await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 1 })).body.outcome).toBe("refused");
    expect(await unusedClarify(id)).toBe(0);
    expect(await wds()).toBe(0);
    expect((await call("POST", `/v1/account/notices/${id}/clarify`, { action: "bogus", classificationRev: 1 })).status).toBe(400);
  });
  it("a signed-in press racing the link press: one winner", async () => {
    const { id } = await cand();
    const k = askTokens();
    signedIn = USER;
    const [a, b] = await Promise.all([call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 1 }), clarify(k.now, "withdraw_now")]);
    const n = await row(id);
    expect(n.clarified_action).not.toBeNull();
    expect(await wds()).toBe(n.clarified_action === "withdraw_now" ? 1 : 0);
    expect([a.body.outcome, b.body.outcome]).toContain("refused");
  });
});

describe("correction after the trusted email", () => {
  it("reclassified to cancellation: the correction names the end date and carries ONE fresh withdraw-now link; the old links are dead; redeeming it withdraws from the original receipt", async () => {
    const { id } = await intake();
    const old = tokens();
    const re = await classify(id, "cancellation");
    expect(re.status).toBe(200);
    const c = correctionMails();
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain(t("correctionCancellation", "en", { received_at: fmtReceived(RECEIVED, "en"), plan_name: "pro", plan_started_on: fmtDate(MADE, "en"), effective_at: fmtDate(P_END, "en") }));
    expect((await confirm(old.confirm)).body.error).toBe("link_invalid");
    expect((await repudiate(old.repudiate)).body.error).toBe("link_invalid");
    expect(askMails()).toHaveLength(0);
    expect((await row(id)).correction_due).toBe(0);              // sent
    const r = await clarify(tok(c[0], WD_LABEL), "withdraw_now");
    expect(r.body).toMatchObject({ outcome: "withdrawn", receivedAt: RECEIVED });
    expect(await wds()).toBe(1);
    expect((await row(id)).eligibility_at).toBe(RECEIVED);
  });
  it("reclassified to support: the 'plan continues for now' wording; sweeping again sends nothing twice; a later reclassification makes the first link stale", async () => {
    const { id } = await intake();
    tokens();
    await classify(id, "support");
    const first = correctionMails();
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain("your plan continues for now");
    await sweepWithdrawalNotices(testEnv()); await sweepWithdrawalNotices(testEnv());
    expect(correctionMails()).toHaveLength(1);
    const t1 = tok(first[0], WD_LABEL);
    await classify(id, "unclear");
    expect(correctionMails()).toHaveLength(2);
    expect((await clarify(t1, "withdraw_now")).body.error).toBe("link_invalid");     // replaced by the new revision's link
    expect((await clarify(tok(correctionMails()[1], WD_LABEL), "withdraw_now")).body.outcome).toBe("withdrawn");
  });
  it("German correction wording is the plan's German", async () => {
    const { id } = await intake({ language: "de" });
    tokens();
    await classify(id, "support");
    const m = correctionMails()[0];
    expect(m.text).toContain(t("correctionSupport", "de", { received_at: fmtReceived(RECEIVED, "de"), plan_name: "pro", plan_started_on: fmtDate(MADE, "de") }));
    expect(m.text).toContain("Jetzt widerrufen und Server löschen: https");
  });
  it("no correction when the trusted email never went (the notice was classified away before it was sent)", async () => {
    const { id } = await cand();
    mails = [];
    await classify(id, "support");
    expect(correctionMails()).toHaveLength(0);
  });
  it("a notice put back to withdrawal gets fresh links and an older clarify link is stale", async () => {
    const { id } = await cand();
    const k = askTokens();
    await classify(id, "withdrawal");
    expect(verifyMails()).toHaveLength(1);
    expect((await clarify(k.now, "withdraw_now")).body.outcome).toBe("stale");
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
  });
  it("a settled notice cannot be reclassified by the operator", async () => {
    const { id } = await cand();
    await clarify(askTokens().end, "cancel_at_end");
    const r = await classify(id, "support");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("settled");
  });
});

describe("strings", () => {
  it("the clarify page copy is the plan's, en and de, and the new keys without German are listed", () => {
    expect(S.clarifyNowButton).toEqual({ en: "Withdraw now and delete my server", de: "Jetzt widerrufen und Server löschen" });
    expect(S.clarifyEndButton.en).toBe("End at the end of the paid month");
    expect(S.clarifyNowText.en).toContain("Your server is deleted, with everything on it.");
    expect(S.clarifyNowText.de).toContain("Ihr Server wird gelöscht, mit allem darauf.");
    expect(S.clarifyEndText.en).toContain("Nothing is refunded.");
    expect(S.clarifyExpired.de).toContain("Ihre ursprünglichen Daten gelten weiter.");
    expect(S.ask.de).toContain("Wenn wir nichts von Ihnen hören, endet Ihr Plan zum Ende des bezahlten Monats und verlängert sich nicht.");
    for (const k of ["subjectAsk", "subjectCorrection", "subjectClarified", "ask", "correctionCancellation", "correctionSupport", "clarifyNowHeading", "clarifyExpired"] as const) expect(MISSING_DE).not.toContain(k);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------------
// r1 (Astra WP10-1): one test per fix and the reviewer's missing scenarios.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const holdLease = async () => { expect(await acquireHomeLease(env as unknown as Env, HOME, "test-holder")).not.toBeNull(); };
const leaseGen = async () => (await env.DB.prepare("SELECT generation FROM billing_home_leases WHERE home_id=?").bind(HOME).first<{ generation: number }>())!.generation;
const freeLease = () => env.DB.prepare("UPDATE billing_home_leases SET holder=NULL, lease_until=NULL WHERE home_id=? AND holder='test-holder'").bind(HOME).run();
/** An operator reclassification landing while a press waits for the home lease: after the press's own checks, before its commit. */
const relabelNow = (id: string, to: string) => env.DB.prepare(`UPDATE withdrawal_notices SET classification=?, classification_rev=classification_rev+1,
    ask_rev=CASE WHEN ?='withdrawal' THEN NULL ELSE ask_rev END, last_op='op-relabel' WHERE id=?`).bind(to, to, id).run();
const usedAt = async (t0: Tok) => (await env.DB.prepare("SELECT used_at FROM verify_tokens WHERE selector=?").bind(t0.selector).first<{ used_at: number | null }>())?.used_at;
const planMails = () => mails.filter((m) => m.subject === "Murage Cloud: your plan");
const vars = (lang: "en" | "de" = "en") => ({ received_at: fmtReceived(RECEIVED, lang), plan_name: "pro", plan_started_on: fmtDate(MADE, lang) });

describe("r1-1 the notice's cancellation is bound to its frozen contract", () => {
  it("bound at insertion; after a crash before attribution WP8's sweep never moves it to a replacement plan; the operator cannot either", async () => {
    const { id } = await cand();
    const r0 = await reqOf(id);
    expect(r0).toMatchObject({ notice_id: id, account_id: USER, supabase_sub: SUBJ, home_id: HOME, subscription_id: SUBID, match_state: "matched" });
    // crash before attribution; meanwhile the contract ended and the same account (same email) bought a replacement plan
    await env.DB.batch([
      env.DB.prepare("UPDATE cancellation_requests SET match_state='pending', attributed_at=NULL, effective_at=NULL, next_match_at=NULL WHERE id=?").bind(r0.id),
      env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE subscription_id=?").bind(SUBID),
      env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES ('home-repl','inst-repl',?,'ready','ready',?,'k',?,?)`).bind(USER, IMAGE, NOW, NOW),
      env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at)
        VALUES ('home-repl',?,'sub_replacement','pro','active',?,?,?,?)`).bind(CUS, NOW, NOW + 30 * DAY, NOW, NOW),
    ]);
    calls = [];
    await sweepCancellations(testEnv());
    const r = await reqOf(id);
    expect(r).toMatchObject({ id: r0.id, subscription_id: SUBID, home_id: HOME, match_state: "unmatched", superseded_by: "contract_ended", attributed_at: null });
    expect(calls.filter((c) => c.id === "sub_replacement")).toHaveLength(0);
    const a = await adminPost(`/v1/admin/cancellations/${r0.id}/attribute`, { accountId: USER, basis: "support" });
    expect(a.status).toBe(409);
    expect(a.body.error).toBe("notice_bound");
  });
  it("stop filing: a crash between filing and linking resumes into the same row; concurrent sweeps file exactly one request", async () => {
    const { id } = await cand();
    const rid = (await reqOf(id)).id as string;
    await env.DB.batch([env.DB.prepare("UPDATE withdrawal_notices SET cancellation_request_id=NULL WHERE id=?").bind(id),
      env.DB.prepare("UPDATE cancellation_requests SET match_state='pending', attributed_at=NULL, next_match_at=NULL WHERE id=?").bind(rid)]);
    await Promise.all([sweepWithdrawalNotices(testEnv()), sweepWithdrawalNotices(testEnv()), sweepCancellations(testEnv())]);
    await sweepWithdrawalNotices(testEnv());
    expect(await count("SELECT COUNT(*) AS n FROM cancellation_requests WHERE notice_id=?", id)).toBe(1);
    expect((await row(id)).cancellation_request_id).toBe(rid);
    expect(await reqOf(id)).toMatchObject({ match_state: "matched", subscription_id: SUBID, received_at: RECEIVED, effective_at: P_END });
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='renewal_stop_scheduled'", id)).toBe(2);   // first filing, one re-link
  });
});

describe("r1-2 the holder's authenticated choice always counts", () => {
  it("an other-address candidate: the signed-in holder's cancel_at_end creates the cancellation; cancel_pending until it is handed over", async () => {
    const { id } = await cand({ from: ["someone@example.test"], boundaryAuth: undefined, accountId: USER });
    await env.DB.prepare("UPDATE supabase_identities SET contact_email=NULL WHERE sub=?").bind(SUBJ).run();
    signedIn = USER;
    const first = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 1 });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("cancel_pending");          // committed choice, no durable handoff yet: never "scheduled"
    expect((await row(id)).cancellation_request_id).toBeNull();
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='pat@gmail.com' WHERE sub=?").bind(SUBJ).run();
    await sweepWithdrawalNotices(testEnv());
    expect(await reqOf(id)).toMatchObject({ notice_id: id, subscription_id: SUBID, status: "open", effective_at: P_END, received_at: RECEIVED });
    expect(subState.cancel_at).toBe(P_END / 1000);
    const again = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 1 });
    expect(again.body).toMatchObject({ outcome: "cancel_scheduled", effectiveAt: P_END });
    expect(planMails().pop()!.text).toContain(fmtDate(P_END, "en"));
  });
});

describe("r1-3 a press that loses to a reclassification consumes nothing", () => {
  for (const [label, action] of [["now", "withdraw_now"], ["end", "cancel_at_end"]] as const) {
    it(`${action}: the relabel lands while the press waits for the lease; the commit refuses, the link stays unused and the button is issued again`, async () => {
      const { id } = await cand();
      const k = askTokens();
      const t0 = label === "now" ? k.now : k.end;
      await holdLease();
      const g0 = await leaseGen();
      const p = clarify(t0, action);
      await sleep(250);
      await relabelNow(id, "withdrawal");
      await freeLease();
      const r = await p;
      expect(r.body.outcome).toBe("stale");
      expect(await leaseGen()).toBeGreaterThan(g0);              // it got the lease: refused at the commit, not by its precheck
      expect(await usedAt(t0)).toBeNull();
      expect((await row(id)).clarified_action).toBeNull();
      expect(await wds()).toBe(0);
      expect((await classify(id, "candidate")).status).toBe(200);
      const k2 = askTokens();
      const t2 = label === "now" ? k2.now : k2.end;
      expect(t2.selector).not.toBe(t0.selector);
      expect((await clarify(t2, action)).body.outcome).toBe(action === "withdraw_now" ? "withdrawn" : "cancel_scheduled");
    });
  }
  it("revision moved twice (candidate -> withdrawal -> candidate): the first ask's links are dead, the new ones work", async () => {
    const { id } = await cand();
    const k = askTokens();
    await classify(id, "withdrawal");
    await classify(id, "candidate");
    expect((await row(id)).classification_rev).toBe(3);
    for (const [t0, a] of [[k.now, "withdraw_now"], [k.end, "cancel_at_end"]] as const) {
      const r = await clarify(t0, a);
      expect(r.body.error ?? r.body.outcome).toMatch(/link_invalid|stale/);
    }
    expect(await wds()).toBe(0);
    expect((await clarify(askTokens().end, "cancel_at_end")).body.outcome).toBe("cancel_scheduled");
  });
});

describe("r1-4 a wrong label never suppresses a candidate", () => {
  it("relabelled support then unclear (revision moved twice): the old links are stale, fresh choices go at the new revision, the holder's choice wins", async () => {
    const { id } = await cand();
    const k = askTokens();
    await classify(id, "support");
    setClock(NOW + 2 * HOUR);                                    // a fresh hourly mail allowance for the third ask
    await classify(id, "unclear");
    // r2-1: a stale ask_rev never passes; the open question was asked again at revision 3.
    expect((await row(id))).toMatchObject({ classification: "unclear", classification_rev: 3, candidate_obligation: 1, ask_rev: 3 });
    const old = await clarify(k.now, "withdraw_now");
    expect(old.body.error ?? old.body.outcome).toMatch(/link_invalid|stale/);     // replaced by the fresh ask, or stale: never acted on
    expect(await wds()).toBe(0);
    expect((await clarify(askTokens().now, "withdraw_now")).body.outcome).toBe("withdrawn");
    expect(await wds()).toBe(1);
    expect((await row(id))).toMatchObject({ classification: "withdrawal", candidate_obligation: 0 });
  });
  it("relabelled support: still a candidate on the account page with its deadline; the stop stays; it goes overdue and escalates", async () => {
    const { id } = await cand();
    await classify(id, "support");
    signedIn = USER;
    const l = await call("GET", "/v1/account/notices");
    expect(l.body.notices).toEqual([expect.objectContaining({ id, kind: "candidate", classificationRev: 2, choices: ["withdraw_now", "cancel_at_end"], effectiveAt: P_END,
      expiresAt: executeByOf(RECEIVED) + 1000 })]);
    expect((await reqOf(id)).status).toBe("open");
    setClock(executeByOf(RECEIVED) + 2000);
    await sweepWithdrawalNotices(testEnv());
    const n = await row(id);
    expect(n.overdue_at).not.toBeNull();
    expect(queueStatus(n, cur)).toBe("overdue");
    expect(hooks.length).toBeGreaterThan(0);                     // the overdue alert went to ops
  });
  it("the holder's answer clears the obligation: a settled notice is neither listed nor escalated", async () => {
    const { id } = await cand();
    await clarify(askTokens().end, "cancel_at_end");
    expect((await row(id)).candidate_obligation).toBe(0);
    setClock(executeByOf(RECEIVED) + 2000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).overdue_at).toBeNull();
  });
});

describe("r1-5 a corrected end date", () => {
  it("re-dates the provisional stop from the original receipt; the receipt stays; Stripe follows", async () => {
    const { id } = await cand();
    const before = await reqOf(id);
    const later = new Date(P_END + 5 * DAY).toISOString().slice(0, 10);
    expect((await classify(id, "cancellation", { requestedDate: later })).status).toBe(200);
    const r = await reqOf(id);
    expect(r).toMatchObject({ id: before.id, kind: "ordinary_date", requested_date: later, received_at: RECEIVED, receipt_sha256: before.receipt_sha256, ref: before.ref, status: "open" });
    expect(r.effective_at as number).toBeGreaterThan(P_END);
    expect(subState.cancel_at).toBe((r.effective_at as number) / 1000);
    expect((await row(id)).requested_date).toBe(later);
    expect(holdMails().pop()!.text).toContain(fmtDate(r.effective_at as number, "en"));   // the confirmation again, with the new end
  });
  it("a held stop keeps its hold and case when re-dated; a same-label correction needs no new revision", async () => {
    const { id } = await cand();
    expect((await repudiate(holdToken())).status).toBe(200);
    const held = await reqOf(id);
    const later = new Date(P_END + 5 * DAY).toISOString().slice(0, 10);
    await classify(id, "cancellation");
    const rev = (await row(id)).classification_rev;
    expect((await classify(id, "cancellation", { requestedDate: later })).status).toBe(200);
    expect((await row(id)).classification_rev).toBe(rev);
    const r = await reqOf(id);
    expect(r).toMatchObject({ status: "held", held_at: held.held_at, case_id: held.case_id, requested_date: later, receipt_sha256: held.receipt_sha256 });
    expect(r.keep_at).toBe(r.effective_at);
    expect(subState.cancel_at).toBeNull();                        // held: nothing is scheduled in Stripe
  });
});

describe("r1-6 trusted email, then candidate", () => {
  it("a superseding two-choice clarification retracts the earlier email; correction_due clears when it is delivered", async () => {
    const { id } = await intake();
    tokens();
    expect((await row(id)).verification_sent_at).not.toBeNull();
    expect((await classify(id, "candidate")).status).toBe(200);
    const m = correctionMails().pop()!;
    expect(m.text).toContain(t("askRetract", "en"));
    expect(m.text).toContain(t("ask", "en", vars()));
    expect((await row(id)).correction_due).toBe(0);
    expect((await clarify(askTokens(m).end, "cancel_at_end")).body.outcome).toBe("cancel_scheduled");
  });
  it("German: the plan's German ask under the German retraction", async () => {
    const { id } = await intake({ language: "de" });
    tokens(verifyMails().pop());
    await classify(id, "candidate");
    const m = mails.filter((x) => x.text.includes(t("askRetract", "de"))).pop()!;
    expect(m.text).toContain(t("ask", "de", vars("de")));
    for (const k of ["askRetract", "askRetractOther", "correctionHeld", "correctionEnded"] as const) expect(MISSING_DE).not.toContain(k);
  });
  it("from another address (no stop): the retraction says the plan continues for now", async () => {
    const { id } = await intake({ from: ["someone@example.test"], boundaryAuth: undefined, accountId: USER });
    tokens();
    await classify(id, "candidate");
    const m = correctionMails().pop()!;
    expect(m.text).toContain(t("askRetractOther", "en", vars()));
    expect((await row(id)).cancellation_request_id).toBeNull();
  });
  it("failed mail: the retraction is retried until delivered; correction_due stays until the CURRENT revision's mail is delivered", async () => {
    const { id } = await intake();
    tokens();
    mailFails = 1000;
    await classify(id, "candidate");
    expect((await row(id)).correction_due).toBe(1);
    await classify(id, "support");                               // the revision moves on while the retraction is undelivered
    expect((await row(id)).correction_due).toBe(1);
    mailFails = 0;
    await sweepWithdrawalNotices(testEnv());
    expect(mails.filter((x) => x.text.includes(t("askRetract", "en")))).toHaveLength(0);   // the older revision's mail is not sent
    expect(correctionMails().pop()!.text).toContain("your plan continues for now");
    expect((await row(id)).correction_due).toBe(0);
  });
});

describe("r1-7 committed cancellation state", () => {
  it("held, then reclassified to cancellation: the correction says the plan continues; a copy rendered before the hold is rendered afresh", async () => {
    const { id } = await intake();
    tokens();
    await classify(id, "candidate");
    const hold = holdToken();
    mailFails = 1000;
    await classify(id, "cancellation");                          // rendered as 'scheduled', not delivered
    mailFails = 0;
    expect((await repudiate(hold)).status).toBe(200);
    expect((await reqOf(id)).status).toBe("held");
    setClock(NOW + 2 * HOUR);                                    // past the hourly mail allowance the failed attempt used
    await sweepWithdrawalNotices(testEnv());
    const c = correctionMails().pop()!;
    expect(c.text).toContain(t("correctionHeld", "en", vars()));
    expect(c.text).not.toContain("and then stops");
    signedIn = USER;
    const r = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: (await row(id)).classification_rev });
    expect(r.body.outcome).toBe("cancel_held");
    expect(planMails().pop()!.text).toContain("your plan continues");
  });
});

describe("r1-8 after a withdrawal the stop and its hold are retired", () => {
  it("withdraw now: once the plan is ended, the cancellation is superseded and its hold link no longer promises anything", async () => {
    const { id } = await cand();
    const hold = holdToken();
    expect((await clarify(askTokens().now, "withdraw_now")).body.outcome).toBe("withdrawn");
    await sweepWithdrawalNotices(testEnv());
    expect(await reqOf(id)).toMatchObject({ status: "completed", superseded_by: `withdrawal:${id}` });
    const before = mails.length;
    const h = await repudiate(hold);
    expect(h.status).toBe(409);
    expect(h.body.error).toBe("link_invalid");
    expect(mails.slice(before).some((m) => m.text.includes("plan continues"))).toBe(false);
    await sweepCancellations(testEnv());
    expect((await reqOf(id)).status).toBe("completed");
  });
});

describe("r1-9 the confirmation when the ask links expire unanswered", () => {
  it("goes once, from the committed state: the end date", async () => {
    await cand();
    setClock(NOW + 8 * DAY);
    await sweepWithdrawalNotices(testEnv());
    await sweepWithdrawalNotices(testEnv());
    const conf = planMails();
    expect(conf).toHaveLength(1);
    expect(conf[0].text).toContain(fmtDate(P_END, "en"));
  });
  it("hold -> kept -> expiry: the plan continues and renews, no cancellation claim", async () => {
    const { id } = await cand();
    expect((await repudiate(holdToken())).status).toBe(200);
    setClock(P_END + HOUR);
    await sweepCancellations(testEnv());
    expect((await reqOf(id)).status).toBe("kept");
    stripeRenewal();
    expect(paid.map((i) => i.id)).toContain("in_renew");
    await sweepWithdrawalNotices(testEnv());
    const conf = planMails();
    expect(conf).toHaveLength(1);
    expect(conf[0].text).toContain("your plan continues");
    expect(conf[0].text).not.toContain(`Your plan ends on`);
  });
});

describe("r1-10/11 signed-in revision conflicts and expired links", () => {
  it("a signed-in cancel that loses its UPDATE to a reclassification answers 409 stale_revision", async () => {
    const { id } = await cand();
    signedIn = USER;
    await holdLease();
    const p = call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 1 });
    await sleep(250);
    await relabelNow(id, "withdrawal");
    await freeLease();
    const r = await p;
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "stale_revision", classificationRev: 2 });
    expect((await row(id)).clarified_action).toBeNull();
  });
  it("an expired correction: past the link cap the correction still goes (pointing to sign-in) and the holder settles it signed in", async () => {
    const { id } = await intake();
    tokens();
    setClock(RECEIVED + 14 * DAY + HOUR);
    await classify(id, "support");
    const c = correctionMails().pop()!;
    expect(c.text).toContain(t("clarifyExpired", "en"));
    expect(c.text).not.toContain("https://murage.test/clarify#");
    signedIn = USER;
    const l = await call("GET", "/v1/account/notices");
    expect((l.body.notices as Record<string, unknown>[]).map((n) => n.kind)).toEqual(["correction"]);
    const ok = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 2 });
    expect(ok.body).toMatchObject({ outcome: "withdrawn", receivedAt: RECEIVED });
    expect((await row(id))).toMatchObject({ received_at: RECEIVED, eligibility_at: RECEIVED, classification: "withdrawal" });
    expect(await wds()).toBe(1);
  });
});

describe("r1 a real aal1 session", () => {
  const realWorker = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });
  const realCall = async (method: string, path: string, token: string, body?: unknown) => {
    const ctx = createExecutionContext();
    const res = await realWorker.fetch(new Request(`https://cp.test${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: method === "GET" ? undefined : JSON.stringify(body) }), { ...testEnv(), ...supabaseEnv } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: await res.json<Record<string, unknown>>() };
  };
  it("an ordinary Supabase sign-in (aal1, no step-up, nothing injected) lists the notice and settles it", async () => {
    const member = await cloudMember("aal1-holder@example.test");
    const { id } = await cand();
    await env.DB.prepare("UPDATE withdrawal_notices SET account_id=?, supabase_sub=? WHERE id=?").bind(member.userId, member.sub, id).run();
    const l = await realCall("GET", "/v1/account/notices", member.token);
    expect(l.status).toBe(200);
    expect((l.body.notices as Record<string, unknown>[]).map((n) => [n.id, n.kind])).toEqual([[id, "candidate"]]);
    const r = await realCall("POST", `/v1/account/notices/${id}/clarify`, member.token, { action: "withdraw_now", classificationRev: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: "withdrawn", receivedAt: RECEIVED });
    expect(await wds()).toBe(1);
    expect((await realCall("GET", "/v1/account/notices", "not-a-token")).status).toBe(401);
  });
});

describe("r1 migration 0065 over a populated database", () => {
  it("is additive: existing notices and requests are kept, open candidates get their obligation, and the package works on it", async () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0065"))!;
    for (const query of m.queries) expect(query.replace(/--.*$/gm, "").trim()).toMatch(/^(ALTER TABLE \w+ ADD COLUMN |CREATE (UNIQUE )?INDEX |UPDATE withdrawal_notices SET candidate_obligation=1)/);
    const { id } = await cand();
    const s = await intake({ classification: "support", classificationBasis: "a question" });
    const rid = (await reqOf(id)).id as string;
    const added = { withdrawal_notices: ["clarified_action", "clarified_at", "cancellation_request_id", "candidate_obligation", "ask_rev", "requested_date"],
      cancellation_requests: ["notice_id", "superseded_by"] };
    await env.DB.batch([env.DB.prepare("DROP INDEX withdrawal_notices_cancellation"), env.DB.prepare("DROP INDEX cancellation_requests_notice"),
      ...Object.entries(added).flatMap(([tb, cols]) => cols.map((c) => env.DB.prepare(`ALTER TABLE ${tb} DROP COLUMN ${c}`)))]);
    const before = await env.DB.prepare("SELECT * FROM withdrawal_notices WHERE id=?").bind(id).first<Record<string, unknown>>();
    const reqBefore = await env.DB.prepare("SELECT * FROM cancellation_requests WHERE id=?").bind(rid).first<Record<string, unknown>>();
    await env.DB.batch(m.queries.map((query) => env.DB.prepare(query)));
    expect(await env.DB.prepare("SELECT * FROM withdrawal_notices WHERE id=?").bind(id).first()).toEqual({ ...before, clarified_action: null, clarified_at: null,
      cancellation_request_id: null, candidate_obligation: 1, ask_rev: 1, requested_date: null });
    expect((await row(s.id)).candidate_obligation).toBe(0);
    expect(await env.DB.prepare("SELECT * FROM cancellation_requests WHERE id=?").bind(rid).first()).toEqual({ ...reqBefore, notice_id: null, superseded_by: null });
    await env.DB.prepare("DELETE FROM verify_tokens").run();
    mails = [];
    const c2 = await cand();
    expect(askMails()).toHaveLength(1);
    expect((await reqOf(c2.id)).notice_id).toBe(c2.id);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------------
// r2 (Astra WP10-2): one test per fix and the reviewer's two remaining scenarios.
const authorizations = (id: string) => count("SELECT COUNT(*) AS n FROM withdrawal_authorizations WHERE notice_id=?", id);

describe("r2-1 consume and authorisation require the exact current revision", () => {
  it("candidate -> support during withdraw_now: nothing consumed, nothing authorised, the press replays as stale; fresh revision-bound choices work", async () => {
    const { id } = await cand();
    const k = askTokens();
    await holdLease();
    const g0 = await leaseGen();
    const p = clarify(k.now, "withdraw_now");
    await sleep(250);
    await relabelNow(id, "support");                             // keeps candidate_obligation=1 and ask_rev=1
    await freeLease();
    const r = await p;
    expect(r.body.outcome).toBe("stale");
    expect(await leaseGen()).toBeGreaterThan(g0);              // refused at the commit, not by the precheck
    expect(await usedAt(k.now)).toBeNull();
    expect(await usedAt(k.end)).toBeNull();
    expect(await authorizations(id)).toBe(0);
    expect(await wds()).toBe(0);
    expect((await row(id))).toMatchObject({ state: "open", clarified_action: null, candidate_obligation: 1, classification: "support", classification_rev: 2 });
    // replay: still nothing consumed and nothing authorised, for either button
    expect((await clarify(k.now, "withdraw_now")).body.outcome).toBe("stale");
    expect((await clarify(k.end, "cancel_at_end")).body.outcome).toBe("stale");
    expect(await usedAt(k.now)).toBeNull();
    expect(await authorizations(id)).toBe(0);
    // signed in with the old revision: the conflict, never a consume
    signedIn = USER;
    const s = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 1 });
    expect(s.status).toBe(409);
    expect(s.body).toMatchObject({ error: "stale_revision", classificationRev: 2 });
    // the sweep issues fresh choices bound to revision 2; they work
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).ask_rev).toBe(2);
    const k2 = askTokens();
    expect(k2.now.selector).not.toBe(k.now.selector);
    expect((await clarify(k2.now, "withdraw_now")).body.outcome).toBe("withdrawn");
    expect(await authorizations(id)).toBe(1);
    expect(await wds()).toBe(1);
  });
});

describe("r2-2 a relabelled candidate keeps its persistent escalation", () => {
  it("overdue candidate relabelled support then unclear: the alert is rebased to each revision and retried until acknowledged", async () => {
    const { id } = await cand();
    setClock(executeByOf(RECEIVED) + 2000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id))).toMatchObject({ alert_rev: 1, alert_acked_at: null });
    expect((await row(id)).overdue_at).not.toBeNull();
    for (const [label, rev] of [["support", 2], ["unclear", 3]] as const) {
      await classify(id, label);
      setClock(cur + ALERT_RETRY_MS + 1000);
      const before = hooks.length;
      await sweepWithdrawalNotices(testEnv());
      const n = await row(id);
      expect(n.alert_raised_at).not.toBeNull();
      expect(n).toMatchObject({ alert_rev: rev, alert_acked_at: null, candidate_obligation: 1 });
      expect(hooks.length).toBeGreaterThan(before);              // retried under the new revision
    }
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='alert_withdrawn'", id)).toBe(0);
    // an alert lost before this fix (withdrawn, overdue mark kept) is raised again
    await env.DB.prepare("UPDATE withdrawal_notices SET alert_raised_at=NULL, alert_rev=NULL, alert_last_at=NULL WHERE id=?").bind(id).run();
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id))).toMatchObject({ alert_rev: 3 });
    expect((await row(id)).alert_raised_at).not.toBeNull();
    // the holder's answer ends it
    signedIn = USER;
    expect((await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 3 })).status).toBe(200);
    setClock(cur + ALERT_RETRY_MS + 1000);
    const before = hooks.length;
    await sweepWithdrawalNotices(testEnv());
    expect(hooks.length).toBe(before);
  });
});

describe("r2-3 every ask is rendered from the cancellation status and revalidated before it is sent", () => {
  it("an ordinary ask rendered while the stop was scheduled is rendered afresh after a hold: no 'does not renew' promise", async () => {
    mailFails = 1000;
    const { id } = await cand();                                 // the ask is rendered (scheduled) and kept, not delivered
    expect(askMails()).toHaveLength(0);
    await env.DB.prepare("UPDATE cancellation_requests SET status='held', held_from='open', held_at=? WHERE id=?").bind(cur, (await reqOf(id)).id).run();
    mailFails = 0;
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    const a = askMails().pop()!;
    expect(a.subject).toBe("Murage Cloud: please tell us what you want");
    expect(a.text).toContain(t("askHeld", "en", vars()));
    expect(a.text).not.toContain("does not renew");
    expect(askTokens(a).now).toBeTruthy();
  });
  it("an other-address candidate asked again after a relabel: the plan continues, no stop is promised", async () => {
    const { id } = await cand({ from: ["someone@example.test"], boundaryAuth: undefined, accountId: USER });
    await env.DB.prepare("UPDATE withdrawal_notices SET ask_rev=1 WHERE id=?").bind(id).run();     // asked before (e.g. by an operator resend)
    await classify(id, "unclear");
    const a = askMails().pop()!;
    expect(a.text).toContain(t("askOpen", "en", vars()));
    expect(a.text).not.toContain("does not renew");
  });
});

describe("r2-7 distinct retraction wording for ended / held / pending / scheduled", () => {
  const retracted = async () => { const { id } = await intake(); tokens(); return id; };
  it("contract ended: the retraction never says the plan continues and offers the withdrawal only", async () => {
    const id = await retracted();
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE subscription_id=?").bind(SUBID).run();
    await classify(id, "candidate");
    expect((await reqOf(id)).superseded_by).toBe("contract_ended");
    const m = correctionMails().pop()!;
    expect(m.text).toContain(t("askRetract", "en"));
    expect(m.text).toContain(t("askEnded", "en", vars()));
    expect(m.text).not.toContain("continues");
    expect(m.text).not.toContain("End at the end of the month I've paid for: https");
    expect(tok(m, NOW_LABEL.en).selector).toBeTruthy();
  });
  it("held: the retraction says the plan continues and renews", async () => {
    const id = await retracted();
    mailFails = 1000;
    await classify(id, "candidate");
    await env.DB.prepare("UPDATE cancellation_requests SET status='held', held_from='open', held_at=? WHERE id=?").bind(cur, (await reqOf(id)).id).run();
    mailFails = 0;
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    const m = correctionMails().pop()!;
    expect(m.text).toContain(`${t("askRetract", "en")}\n\n${t("askHeld", "en", vars())}`);
    expect(m.text).not.toContain("does not renew");
  });
  it("pending: filed, not scheduled yet: no end date, no 'continues'", async () => {
    const id = await retracted();
    mailFails = 1000;
    await classify(id, "candidate");
    await env.DB.prepare("UPDATE cancellation_requests SET match_state='pending', attributed_at=NULL, effective_at=NULL WHERE id=?").bind((await reqOf(id)).id).run();
    mailFails = 0;
    setClock(NOW + 2 * HOUR);
    await flushMail(testEnv() as unknown as Env, deps() as never, id);
    const m = correctionMails().pop()!;
    expect(m.text).toContain(`${t("askRetract", "en")}\n\n${t("askPending", "en", vars())}`);
    expect(m.text).not.toContain("continues");
  });
  it("scheduled: the retraction and the plan's ask", async () => {
    const id = await retracted();
    await classify(id, "candidate");
    expect(correctionMails().pop()!.text).toContain(`${t("askRetract", "en")}\n\n${t("ask", "en", vars())}`);
  });
});

describe("r2-4 a kept hold is retired by the withdrawal too", () => {
  it("hold -> kept -> withdraw now: the kept request is superseded; a replay of the used hold link is refused, never 'your plan continues'", async () => {
    const { id } = await cand();
    const k = askTokens();
    const hold = holdToken();
    expect((await repudiate(hold)).status).toBe(200);
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='customer', completed_at=? WHERE id=?").bind(cur, (await reqOf(id)).id).run();
    const keptAt = (await reqOf(id)).completed_at;
    expect((await clarify(k.now, "withdraw_now")).body.outcome).toBe("withdrawn");
    await sweepWithdrawalNotices(testEnv());
    expect(await reqOf(id)).toMatchObject({ status: "kept", superseded_by: `withdrawal:${id}`, completed_at: keptAt });
    const before = mails.length;
    const r = await repudiate(hold);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("link_invalid");
    expect(JSON.stringify(r.body)).not.toContain("continues");
    expect(mails.slice(before).some((m) => m.text.includes("plan continues"))).toBe(false);
  });
  it("recovery: a kept request left live by a crash after the withdrawal is retired by the sweep", async () => {
    const { id } = await cand();
    const k = askTokens();
    expect((await repudiate(holdToken())).status).toBe(200);
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='timeout', completed_at=? WHERE id=?").bind(cur, (await reqOf(id)).id).run();
    expect((await clarify(k.now, "withdraw_now")).body.outcome).toBe("withdrawn");
    await sweepWithdrawalNotices(testEnv());
    await env.DB.prepare("UPDATE cancellation_requests SET superseded_by=NULL WHERE id=?").bind((await reqOf(id)).id).run();   // the crash
    await sweepWithdrawalNotices(testEnv());
    expect((await reqOf(id)).superseded_by).toBe(`withdrawal:${id}`);
  });
});

describe("r2-5 the expiry confirmation is serialised against the holder's settlement", () => {
  it("a signed-in withdrawal committing while the expiry mail reads the identity: the superseded confirmation is discarded, never sent", async () => {
    const { id } = await cand();
    setClock(NOW + 8 * DAY);
    const orig = reader.emailGen;
    let fired = false;
    reader.emailGen = async () => {
      const pending = await env.DB.prepare("SELECT 1 AS x FROM withdrawal_notice_mail WHERE notice_id=? AND kind='expiry' AND sent_at IS NULL").bind(id).first();
      if (pending && !fired) {
        fired = true;
        signedIn = USER;
        const r = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "withdraw_now", classificationRev: 1 });
        expect(r.body.outcome).toBe("withdrawn");
      }
      return orig.call(reader);
    };
    try { await sweepWithdrawalNotices(testEnv()); await sweepWithdrawalNotices(testEnv()); } finally { reader.emailGen = orig; }
    expect(fired).toBe(true);
    expect(planMails()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='expiry' AND sent_at IS NOT NULL AND last_error IN ('superseded','skipped')", id)).toBe(1);
    expect((await row(id)).clarified_action).toBe("withdraw_now");
  });
});

describe("r3-1 a delayed reissue never replaces the links of a newer revision", () => {
  it("revision 2's ask paused, revision 3 delivered, revision 2 resumed: only revision 3's links are live and they work", async () => {
    const { id } = await cand();
    askTokens();                                                 // revision 1's ask went
    const before = askMails().length;
    const orig = reader.emailGen;
    let fired = false;
    reader.emailGen = async () => {
      const pending = await env.DB.prepare("SELECT 1 AS x FROM withdrawal_notice_mail WHERE notice_id=? AND kind='ask:2' AND sent_at IS NULL AND payload IS NULL").bind(id).first();
      if (pending && !fired) {
        fired = true;                                            // revision 2's render is paused here; revision 3 is classified and delivered
        expect((await classify(id, "unclear")).status).toBe(200);
      }
      return orig.call(reader);
    };
    try { expect((await classify(id, "support")).status).toBe(200); } finally { reader.emailGen = orig; }
    expect(fired).toBe(true);
    expect((await row(id))).toMatchObject({ classification_rev: 3, ask_rev: 3 });
    const live = (await env.DB.prepare("SELECT classification_rev AS r FROM verify_tokens WHERE subject_id=? AND purpose='clarify' AND used_at IS NULL").bind(id).all<{ r: number }>()).results;
    expect(live.map((x) => x.r)).toEqual([3, 3]);
    const sent = askMails().slice(before);
    expect(sent).toHaveLength(1);                                // revision 3's ask only; revision 2's render issued and sent nothing
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND sent_at IS NULL", id)).toBe(0);
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect(askMails().slice(before)).toHaveLength(1);
    expect((await clarify(askTokens(sent[0]).now, "withdraw_now")).body.outcome).toBe("withdrawn");
  });
});

describe("r3-2 every cancellation-dependent mail is dispatched under a renewed home lease", () => {
  it("the lease lapses while the ask is revalidated and a hold commits: the stale sender's send is refused; the ask goes in the held wording", async () => {
    const { id } = await cand();
    const hold = holdToken();
    const before = askMails().length;
    const orig = reader.emailGen;
    let fired = false;
    reader.emailGen = async () => {
      const rendered = await env.DB.prepare("SELECT 1 AS x FROM withdrawal_notice_mail WHERE notice_id=? AND kind='ask:2' AND sent_at IS NULL AND payload IS NOT NULL").bind(id).first();
      if (rendered && !fired) {
        fired = true;                                            // the final validation under the lease: the lease lapses, a successor holds the plan
        await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id=?").bind(HOME).run();
        expect((await repudiate(hold)).status).toBe(200);
      }
      return orig.call(reader);
    };
    try { expect((await classify(id, "support")).status).toBe(200); } finally { reader.emailGen = orig; }
    expect(fired).toBe(true);
    expect(["held", "kept"]).toContain((await reqOf(id)).status);
    expect(askMails().slice(before)).toHaveLength(0);            // the ask rendered on the scheduled stop was not sent
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    const sent = askMails().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(t("askHeld", "en", vars()));
    expect(sent.some((m) => m.text.includes("does not renew"))).toBe(false);
  });
});

describe("r2-6 a notice cancellation that cannot be scheduled is escalated, never discarded", () => {
  it("an end date beyond the calendar's reach: linked, WP8's scheduling alert raised once, the notice stays visible as processing", async () => {
    const far = new Date(NOW + 7 * 366 * DAY).toISOString().slice(0, 10);
    const { id } = await cand({ from: ["someone@example.test"], boundaryAuth: undefined, accountId: USER });
    expect((await classify(id, "cancellation", { requestedDate: far })).status).toBe(200);
    signedIn = USER;
    const r = await call("POST", `/v1/account/notices/${id}/clarify`, { action: "cancel_at_end", classificationRev: 2 });
    expect(r.body.outcome).toBe("cancel_pending");
    const rid = (await row(id)).cancellation_request_id;
    expect(rid).not.toBeNull();
    expect((await reqOf(id)).schedule_escalated_at).not.toBeNull();
    const alerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancellation.no_schedule' AND home_id=?", `cx-req:${rid}`);
    expect(await alerts()).toBe(1);
    await sweepWithdrawalNotices(testEnv());
    await sweepCancellations(testEnv());
    expect(await alerts()).toBe(1);                              // once, while the sweep keeps retrying
    const l = await call("GET", "/v1/account/notices");
    expect(l.body.notices).toEqual([expect.objectContaining({ id, kind: "processing", choices: [] })]);
    expect((l.body.notices as Record<string, unknown>[])[0].effectiveAt).toBeUndefined();
    expect(planMails()).toHaveLength(0);                         // no end date is confirmed while none is scheduled
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// r4 (Astra WP10-4): one test per fix.
/** The ask row of revision 1 put back to "not sent yet, nothing kept", so the next flush renders it afresh (new links). */
async function askUnsent(id: string) {
  await env.DB.prepare("UPDATE withdrawal_notice_mail SET sent_at=NULL, payload=NULL, claimed_until=NULL, last_error=NULL WHERE notice_id=? AND kind='ask:1'").bind(id).run();
}
const liveClarify = async (id: string) => (await env.DB.prepare("SELECT selector FROM verify_tokens WHERE subject_id=? AND purpose='clarify' AND used_at IS NULL ORDER BY selector")
  .bind(id).all<{ selector: string }>()).results.map((r) => r.selector);
const passThrough = (target: object, p: string | symbol) => { const v = Reflect.get(target, p, target) as unknown; return typeof v === "function" ? v.bind(target) : v; };

describe("r4-1 a sender whose claim lapsed never replaces the links another sender delivered", () => {
  it("A issues the first button, its claim lapses, B issues both, sends and marks the row sent, A resumes: exactly one live pair, the one in B's mail", async () => {
    const { id } = await cand();
    askTokens();                                                 // revision 1's ask went once
    await askUnsent(id);
    mails = [];
    // Sender A works on a database that, just before A stores the SECOND button (on its own, or in a batch), lets sender B run start to finish.
    // B's clock is past A's two-minute claim, so A's claim looks lapsed to B.
    let fired = false;
    const runB = async () => { fired = true; await flushMail(testEnv(), deps({ now: () => cur + 3 * 60_000 }) as never, id); };
    const real = new WeakMap<object, D1PreparedStatement>();
    const second = new WeakSet<object>();
    const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const px = new Proxy(st, { get(t0, p) {
        if (p !== "bind") return passThrough(t0, p);
        return (...b: unknown[]) => {
          const bound = t0.bind(...b);
          if (!(/INSERT INTO verify_tokens/.test(sql) && b.includes("cancel_at_end"))) return bound;
          const s2 = new Proxy(bound, { get(t1, p1) { return p1 === "run" ? async () => { if (!fired) await runB(); return t1.run(); } : passThrough(t1, p1); } });
          real.set(s2, bound);
          second.add(s2);
          return s2;
        };
      } });
      real.set(px, st);
      return px;
    };
    const dbA = new Proxy(env.DB, { get(t0, p) {
      if (p === "prepare") return (sql: string) => wrap(t0.prepare(sql), sql);
      if (p === "batch") return async (stmts: D1PreparedStatement[]) => {
        if (!fired && stmts.some((x) => second.has(x))) await runB();
        return t0.batch(stmts.map((x) => real.get(x) ?? x));
      };
      return passThrough(t0, p);
    } });
    await flushMail({ ...testEnv(), DB: dbA } as unknown as Env, deps({ now: () => cur }) as never, id);
    expect(fired).toBe(true);
    const sent = askMails();
    expect(sent).toHaveLength(1);                                // B's mail; A sent nothing
    const b = askTokens(sent[0]);
    expect(await liveClarify(id)).toEqual([b.now.selector, b.end.selector].sort());   // exactly one live pair: the one in the sent mail
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='ask:1' AND sent_at IS NOT NULL", id)).toBe(1);
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect(askMails()).toHaveLength(1);                          // nothing is re-sent, nothing re-issued
    expect(await liveClarify(id)).toEqual([b.now.selector, b.end.selector].sort());
    await clarify(b.end, "cancel_at_end");                       // the delivered link works
    expect((await row(id)).clarified_action).toBe("cancel_at_end");
  });
});

describe("r4-2 a mail that keeps losing the home lease is escalated, and the alert clears once it goes", () => {
  it("lease lost at every final check: counted as failed tries, mail_stuck after the limit; then the lease holds: sent once, alert resolved", async () => {
    const { id } = await cand();
    askTokens();
    await askUnsent(id);
    mails = [];
    let breakLease = true;
    const orig = reader.emailGen;
    reader.emailGen = async () => {
      // the identity read inside the final check outlasts the lease
      if (breakLease) await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id=?").bind(HOME).run();
      return orig.call(reader);
    };
    try {
      for (let i = 0; i < MAIL_ESCALATE_AFTER + 2; i += 1) { setClock(NOW + (i + 1) * 130_000); await flushMail(testEnv(), deps({ now: () => cur }) as never, id); }
      expect(askMails()).toHaveLength(0);
      const r = (await env.DB.prepare("SELECT attempts,escalated_at,last_error,sent_at FROM withdrawal_notice_mail WHERE notice_id=? AND kind='ask:1'").bind(id)
        .first<{ attempts: number; escalated_at: number | null; last_error: string; sent_at: number | null }>())!;
      expect(r.sent_at).toBeNull();
      expect(r.last_error).toBe("lease_lost");
      expect(r.attempts).toBeGreaterThanOrEqual(MAIL_ESCALATE_AFTER);
      expect(r.escalated_at).not.toBeNull();
      expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.mail_stuck' AND resolved_at IS NULL")).toBe(1);
      breakLease = false;
      setClock(cur + 130_000);
      await flushMail(testEnv(), deps({ now: () => cur }) as never, id);
    } finally { reader.emailGen = orig; }
    expect(askMails()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='ask:1' AND sent_at IS NOT NULL AND last_error IS NULL", id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.mail_stuck' AND resolved_at IS NULL")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.mail_stuck' AND resolved_at IS NOT NULL")).toBe(1);
    const t0 = askTokens();
    expect(await liveClarify(id)).toEqual([t0.now.selector, t0.end.selector].sort());
  });
});
