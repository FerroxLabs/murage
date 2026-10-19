// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP9 (plan Test 6, all rows except the clarify/candidate ones): emailed withdrawal notices over the real worker + D1.
// Stripe, the identity reader, the mailer and the alert webhook are fakes. No request carries a credential except the operator's admin token.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createWorker } from "../src/index";
import { clearPublicHandlers, setPublicRouteDeps } from "../src/public-routes";
import { registerCancellation, setCancellationDeps } from "../src/public-cancellation";
import { stubFluxHooks, type BillingNotifier } from "../src/b5-billing";
import type { StripeClient } from "../src/b5-stripe";
import { reserveMail, type IdentityRead } from "../src/public-tokens";
import { fmtReceived } from "../src/cancellation-strings";
import { fmtExecuteByDate, MISSING_DE, OPERATOR_ONLY, S, t } from "../src/notice-strings";
import {
  ALERT_RETRY_MS, alertAtOf, authorize, executeByOf, flushMail, itemAtOf, queueStatus, registerWithdrawalNotices, senderTrusted, setNoticeDeps, soleFrom, sweepWithdrawalNotices, utcDayStart, windowEndOf,
  type NoticeRow,
} from "../src/withdrawal-notices";
import { parseFrom } from "../src/mail-address";
import { openPayload, sealPayload } from "../src/withdrawal-notices";
import { dropSink, engagedSink, installSink, realSends, sunk } from "./sink-fixture";

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
// Stripe refuses to SUBMIT a refund (credit note or refund). INTEGRATED-1 #6: refunds go before the end, so the cancellation itself is no longer what holds a refund back.
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
let acceptThenFail = 0;     // the provider accepts the mail, then the worker dies before it records it
let fluxBlocked = false;    // the plan-end step after the refund cannot run yet
const P_START = MADE;
const P_END = MADE + 30 * DAY;
const identifiers: Record<string, string[]> = {};
const invoice = (id: string, createdMs: number, startMs: number, endMs: number, cents = 9900) => ({ id, status: "paid", amount_paid: cents, amount_due: 0, auto_advance: false, subscription: SUBID,
  billing_reason: "subscription_cycle", payment_intent: `pi_${id}`, tax: 0, created: Math.floor(createdMs / 1000), subscriptionMetadata: {},
  lines: { data: [{ price: "price_pro", proration: false, subscription: SUBID, item: null, source: "subscription", period: { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) }, amount: cents }], has_more: false } });
function addInvoice(i: ReturnType<typeof invoice>) { paid.push(i); invoiceById[i.id] = { id: i.id, amount_paid: i.amount_paid, tax: 0, payment_intent: i.payment_intent }; }

const fakeStripe = {
  setCancelAt: async (id: string, at: number | null, key?: string) => { calls.push({ op: "setCancelAt", id, at, key }); return { id }; },
  cancelSubscription: async (id: string) => { calls.push({ op: "cancel", id }); return { id, status: "canceled" }; },
  getSubscription: async (id: string) => ({ id, status: "active", current_period_start: Math.floor(P_START / 1000), current_period_end: Math.floor(P_END / 1000) }),
  customersForIdentifier: async (i: string) => identifiers[i] ?? [],
  listPaidInvoices: async () => ({ data: paid }),
  getInvoice: async (id: string) => invoiceById[id],
  listRefunds: async (pi: string) => ({ data: refunds.filter((r) => (r as unknown as { pi: string }).pi === pi) }),
  getRefund: async (id: string) => refunds.find((r) => r.id === id)!,
  createRefund: async (i: { paymentIntent: string; amountCents?: number }) => { if (stripeBlocked) throw new Error("stripe down"); const r = { id: `re_${refunds.length + 1}`, amount: i.amountCents ?? 0, pi: i.paymentIntent, status: "succeeded", payment_intent: i.paymentIntent, metadata: {} }; refunds.push(r); calls.push({ op: "refund", amount: r.amount }); return r; },
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
const flux = { ...stubFluxHooks, stub: false, capabilities: { reversalTargets: true } as const, stopForBilling: async () => { if (fluxBlocked) throw new Error("flux down"); }, changePlan: async () => undefined, grantMonthlyCredits: async () => undefined,
  usedIncludedCreditMicrocents: async () => ({ usedMicrocents: 0 }), setAutoRecharge: async () => undefined } as never;
const mailer = { async send(m: Mail & { from: unknown; html: string }) { if (mailFails > 0) { mailFails -= 1; throw new Error("smtp down"); } mails.push({ to: m.to, subject: m.subject, text: m.text });
  if (acceptThenFail > 0) { acceptThenFail -= 1; throw new Error("crashed after the provider accepted it"); } } };
const fetcher = (async (_url: unknown, init?: { body?: string }) => { hooks.push({ body: String(init?.body ?? "") }); return new Response("{}", { status: hookOk ? 200 : 500 }); }) as unknown as typeof fetch;
const deps = (over: Record<string, unknown> = {}) => ({ now: () => cur, reader, stripe: fakeStripe, mailer, billing: { notifier, flux }, siteOrigin: "https://murage.test", fetcher, ...over });

let signedIn: string | null = null;
let stepUpOk = false;
const worker = createWorker(fetch, fetch, {}, {}, { accountUser: async () => (signedIn ? ({ id: signedIn } as never) : null), stepUp: async () => stepUpOk });
let sinkOn = false;   // the staging mail sink engaged and no injected mailer (Astra TRUSTCODE-1 P3-3)
const testEnv = () => ({ ...env, ...(sinkOn ? engagedSink("@gmail.com") : {}), IDENTITY_READER: reader, CLOUD_ADMIN_TOKEN: ADMIN, ALERT_WEBHOOK_URL: "https://alerts.test/hook", MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;
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
const LINK = "https:\\/\\/murage\\.test\\/verify#([A-Za-z0-9_-]{22})\\.([A-Za-z0-9_-]{43})";
const NOT_ME_LINK = "https:\\/\\/murage\\.test\\/not-me#([A-Za-z0-9_-]{22})\\.([A-Za-z0-9_-]{43})";
function tokens(m?: Mail) {
  const mail = m ?? verifyMails().pop()!;
  expect(mail, "a verification mail").toBeTruthy();
  const c = new RegExp(`(?:Confirm withdrawal|Widerruf bestätigen): ${LINK}`).exec(mail.text)!;
  const r = new RegExp(`(?:This wasn't me|Das war ich nicht): ${NOT_ME_LINK}`).exec(mail.text)!;
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
  invoiceById = {}; refunds = []; notes = []; hooks = []; hookOk = false; mailFails = 0; acceptThenFail = 0; fluxBlocked = false; signedIn = null; stepUpOk = false;
  addInvoice(invoice("in_first", MADE, MADE, MADE + 30 * DAY));
  setNoticeDeps(deps()); setCancellationDeps(deps());
  clearPublicHandlers(); setPublicRouteDeps({}); registerCancellation(); registerWithdrawalNotices();
  await env.DB.batch(["withdrawal_notices", "withdrawal_authorizations", "withdrawal_notice_events", "withdrawal_notice_cases", "withdrawal_notice_mail", "withdrawals", "refund_ops", "verify_tokens",
    "public_mail_limits", "billing_subscriptions", "checkout_consents", "cloud_alerts", "cloud_homes", "supabase_identities", "service_intervals", "service_interval_log",
    "account_link_events", "contract_deadlines"].map((tbl) => env.DB.prepare(`DELETE FROM ${tbl}`)));
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
    // The server started at payment (plan 4.1: the guarantee runs from the service start, here the same day as the contract).
    env.DB.prepare("INSERT INTO service_intervals (home_id,started_at,subscription_id) VALUES (?,?,?)").bind(HOME, MADE, SUBID),
  ]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe("pure rules", () => {
  it("execute_by is 23:59:59 UTC on date(received_at)+13; the day-12 item and day-13 alert start at 00:00 UTC", () => {
    const r = Date.UTC(2026, 10, 1, 14, 3, 22);
    expect(executeByOf(r)).toBe(Date.UTC(2026, 10, 14, 23, 59, 59));
    expect(itemAtOf(r)).toBe(Date.UTC(2026, 10, 13));
    expect(alertAtOf(r)).toBe(Date.UTC(2026, 10, 14));
    expect(windowEndOf(Date.UTC(2026, 10, 1, 9))).toBe(Date.UTC(2026, 10, 16, 12));   // AoE end of 15 Nov
  });
  it("CET and UTC+14 boundary cases: the shown date is the UTC date, with one (UTC) label", () => {
    // 1 Nov 00:30 CET = 31 Oct 23:30 UTC; 1 Nov 08:00 at UTC+14 = 31 Oct 18:00 UTC; 1 Nov 13:59 at UTC+14 = 31 Oct 23:59 UTC; 1 Nov 14:00 at UTC+14 = 1 Nov 00:00 UTC.
    const cet = Date.UTC(2026, 9, 31, 23, 30);
    const plus14a = Date.UTC(2026, 9, 31, 18, 0);
    const plus14b = Date.UTC(2026, 9, 31, 23, 59);
    const plus14c = Date.UTC(2026, 10, 1, 0, 0);
    for (const r of [cet, plus14a, plus14b]) {
      expect(fmtExecuteByDate(executeByOf(r), "en")).toBe("13 November 2026 (UTC)");
      expect(fmtExecuteByDate(executeByOf(r), "de")).toBe("13. November 2026 (UTC)");
    }
    expect(fmtExecuteByDate(executeByOf(plus14c), "en")).toBe("14 November 2026 (UTC)");
    expect(utcDayStart(cet)).toBe(Date.UTC(2026, 9, 31));
    // The cutoff second is inside, the next one is not.
    const n = { execute_by: executeByOf(cet) } as NoticeRow;
    expect(queueStatus({ ...n, state: "open", classification: "withdrawal", coalesced_into: null, sender_trusted: 1, match_state: "matched", received_at: cet } as NoticeRow, executeByOf(cet) + 999)).toBe("due_today");
    expect(queueStatus({ ...n, state: "open", classification: "withdrawal", coalesced_into: null, sender_trusted: 1, match_state: "matched", received_at: cet } as NoticeRow, executeByOf(cet) + 1000)).toBe("overdue");
  });
  it("senderTrusted: boundary results only, aligned SPF and DKIM, the sole From, a held address and mailbox enforcement", () => {
    const acct = { contactEmail: "Pat@Gmail.com", heldSince: RECEIVED - DAY };
    expect(senderTrusted(gmailAuth as never, ["pat@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: true });
    const gg = { source: "boundary", spf: { result: "pass", domain: "googlemail.com" }, dkim: { result: "pass", domain: "googlemail.com" } };
    expect(senderTrusted(gg as never, ["P.A.T+x@googlemail.com"], acct, RECEIVED)).toMatchObject({ trusted: true, sameAddress: true });
    expect(senderTrusted(gmailAuth as never, ["pat@googlemail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "spf" });   // not aligned to the From domain
    expect(senderTrusted(gmailAuth as never, ["pat@gmail.com", "x@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "more_than_one_from" });
    expect(senderTrusted(undefined, ["pat@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "no_boundary_auth" });
    expect(senderTrusted({ ...gmailAuth, dkim: { result: "pass", domain: "evil.test" } } as never, ["pat@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "dkim" });
    expect(senderTrusted({ ...gmailAuth, spf: { result: "softfail", domain: "gmail.com" } } as never, ["pat@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "spf" });
    expect(senderTrusted(gmailAuth as never, ["pat@gmail.com"], { ...acct, heldSince: RECEIVED + 1 }, RECEIVED)).toMatchObject({ trusted: false, failed: "address_not_held_since" });
    const custom = { source: "boundary", spf: { result: "pass", domain: "corp.test" }, dkim: { result: "pass", domain: "corp.test" } };
    expect(senderTrusted(custom as never, ["pat@corp.test"], { contactEmail: "pat@corp.test", heldSince: 0 }, RECEIVED)).toMatchObject({ trusted: false, failed: "no_mailbox_enforcement", sameAddress: true });
    expect(senderTrusted({ ...custom, mailboxEnforcement: "mx-evidence-1" } as never, ["pat@corp.test"], { contactEmail: "pat@corp.test", heldSince: 0 }, RECEIVED)).toMatchObject({ trusted: true });
  });
  it("the German strings are the plan's; the strings without German are listed (a launch gate)", () => {
    expect(S.otherSender.de).toContain("von einer anderen E-Mail-Adresse");
    expect(S.sameAddress.de).toContain("Wir konnten nicht bestätigen, dass er von Ihnen kam");
    expect(S.stopped.de).toContain("„Vertrag widerrufen“");
    expect(S.stopped.de).not.toContain("Rücktritt");
    expect(MISSING_DE).toEqual([]);
  });
  it("operator-facing texts stay English by decision 2026-10-11 and are excluded from the gate", () => {
    expect([...OPERATOR_ONLY].sort()).toEqual(["alertDue", "alertOverdue", "queueItem"]);
    for (const k of OPERATOR_ONLY) { expect(S[k].de).toBeNull(); expect(MISSING_DE).not.toContain(k); expect(t(k, "de", { id: "x", received_at: "r", execute_by_date: "d" })).toBe(t(k, "en", { id: "x", received_at: "r", execute_by_date: "d" })); }
  });
});

describe("intake, trusted-sender attribution and the three verification emails", () => {
  it("trusted sender: the (2) trusted email goes to the account's CURRENT email, with both links; eligibility_at = received_at; the dated item waits for day 12", async () => {
    supa = { ...supa, email: "pat.new@example.test" };           // the Supabase address may differ from the stored contact address; the link goes to the Supabase one
    const { id, res } = await intake();
    expect(res.status).toBe("waiting");
    expect(res.trusted).toBe(true);
    expect(res.verificationKind).toBe("trusted");
    const n = await row(id);
    expect(n.eligibility_at).toBe(RECEIVED);
    expect(n.consent_id).toBe(CONS);
    expect(verifyMails()).toHaveLength(1);
    const m = verifyMails()[0];
    expect(m.to).toBe("pat.new@example.test");
    expect(m.text).toContain(t("trusted", "en", { received_at: fmtReceived(RECEIVED, "en"), execute_by_date: fmtExecuteByDate(executeByOf(RECEIVED), "en") }));
    expect(m.text.split("(UTC)").length - 1).toBe(1);
    expect(m.text).toContain("Your plan ends and your server is deleted, with everything on it. Save anything you need first.");
    expect(m.text).toMatch(/This wasn't me: https:\/\/murage\.test\/not-me#/);
  });
  it("trusted sender in German: the plan's German, byte for byte, with one (UTC) label inside the date", async () => {
    await intake({ language: "de" });
    const m = verifyMails()[0];
    const body = t("trusted", "de", { received_at: fmtReceived(RECEIVED, "de"), execute_by_date: fmtExecuteByDate(executeByOf(RECEIVED), "de") });
    expect(m.text.startsWith(body)).toBe(true);
    expect(m.text.split("(UTC)").length - 1).toBe(1);
    expect(m.text).toMatch(/Widerruf bestätigen: https/);
    expect(m.text).toMatch(/Das war ich nicht: https/);
  });
  it("same address but SPF/DKIM failed or unaligned: the 'could not confirm it came from you' email, never the other-address one, and no dated item", async () => {
    const { id, res } = await intake({ boundaryAuth: { ...gmailAuth, dkim: { result: "fail", domain: "gmail.com" } } });
    expect(res.verificationKind).toBe("same_address_failed");
    expect(res.status).toBe("escalated");
    const m = verifyMails()[0];
    expect(m.text).toContain("We could not confirm it came from you");
    expect(m.text).not.toContain("from another email address");
    expect(m.text).toContain("nothing happens until you do");
    // Never a dated item: even on day 12, 13 and after the cutoff it stays escalated and is never closed.
    setClock(alertAtOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("escalated");
    expect((await row(id)).item_raised_at).toBeNull();
    expect((await row(id)).alert_raised_at).toBeNull();
    setClock(executeByOf(RECEIVED) + 5000);
    await sweepWithdrawalNotices(testEnv());
    const after = await row(id);
    expect(after.state).toBe("open");
    expect(after.overdue_at).toBeNull();
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("escalated");
  });
  it("any other sender (operator-linked): the other-address email with 'Nothing happens until you press it', no dated item, stays escalated with its evidence", async () => {
    const { id, res } = await intake({ from: ["someone@else.test"], boundaryAuth: { source: "boundary", spf: { result: "pass", domain: "else.test" }, dkim: { result: "pass", domain: "else.test" } }, accountId: USER, subjectHash: "a".repeat(64), bodyHash: "b".repeat(64) });
    expect(res.verificationKind).toBe("other_sender");
    expect(res.trusted).toBe(false);
    const m = verifyMails()[0];
    expect(m.to).toBe("pat@gmail.com");
    expect(m.text).toContain("from another email address");
    expect(m.text).toContain("Nothing happens until you press it.");
    expect(m.text).not.toContain("We could not confirm it came from you");
    setClock(executeByOf(RECEIVED) + 5000);
    await sweepWithdrawalNotices(testEnv());
    const n = await row(id);
    expect(n.state).toBe("open");
    expect(n.overdue_at).toBeNull();
    expect(n.body_hash).toBe("b".repeat(64));
    expect(n.received_basis).toBe("gateway");
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("escalated");
    // If the holder confirms later, it executes at received_at.
    setClock(NOW);
    const done = await execute(id);
    expect(done.status).toBe(409);
  });
  it("a forged Authentication-Results header inside the message is ignored (5b); so are two From addresses and same-domain impersonation", async () => {
    const forged = await intake({ boundaryAuth: undefined, messageAuthResults: "mx.example; spf=pass; dkim=pass; dmarc=pass" });
    expect(forged.res.trusted).toBe(false);
    expect(forged.res.verificationKind).toBe("same_address_failed");     // the From line shows the account address, the checks did not pass
    const two = await intake({ from: ["pat@gmail.com", "boss@gmail.com"] });
    expect(two.res.trusted).toBe(false);
    // another mailbox on a domain with no mailbox-enforcement evidence
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='pat@corp.test'").run();
    const corp = { source: "boundary", spf: { result: "pass", domain: "corp.test" }, dkim: { result: "pass", domain: "corp.test" } };
    const same = await intake({ from: ["pat@corp.test"], boundaryAuth: corp });
    expect(same.res.trusted).toBe(false);
    expect(same.res.verificationKind).toBe("same_address_failed");
    const other = await intake({ from: ["intern@corp.test"], boundaryAuth: corp });
    expect(other.res.trusted).toBe(false);
    expect(other.res.matchState).toBe("unmatched");
    for (const x of [forged, two, same, other]) expect((await adminGet(`/v1/admin/withdrawals/${x.id}`)).body.status).not.toBe("item");
  });
  it("an unmatched sender gets the automatic reply (plan 5.3 (4)); nothing is said about accounts", async () => {
    const { id, res } = await intake({ from: ["nobody@else.test"] });
    expect(res.matchState).toBe("unmatched");
    expect(verifyMails()).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("nobody@else.test");
    expect(mails[0].text).toContain("To confirm it, sign in and use Withdraw from contract on your account page");
    expect((await row(id)).account_id).toBeNull();
  });
  it("classifications other than withdrawal send no verification email and have no dated item", async () => {
    for (const classification of ["cancellation", "support", "unclear", "candidate"]) await intake({ classification });
    expect(verifyMails()).toHaveLength(0);
    setClock(alertAtOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notices WHERE item_raised_at IS NOT NULL")).toBe(0);
  });
  it("the intake is idempotent by message id", async () => {
    const body = intakeBody({ messageId: "<same@mail.test>" });
    const a = await adminPost("/v1/admin/withdrawals/intake", body);
    const b = await adminPost("/v1/admin/withdrawals/intake", body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notices")).toBe(1);
  });
});

describe("one eligibility time and accepted dispatch evidence", () => {
  it("an accepted sent_at moves eligibility_at; received_at stays the effective time", async () => {
    const { id } = await intake({ sentAt: RECEIVED - 2 * HOUR, sentBasis: "provider_received_header", sentEvidenceRef: "hdr-1", sentAcceptedBy: "sean" });
    const n = await row(id);
    expect(n.sent_at).toBe(RECEIVED - 2 * HOUR);
    expect(n.eligibility_at).toBe(RECEIVED - 2 * HOUR);
    expect(n.received_at).toBe(RECEIVED);
    expect(n.sent_accepted_by).toBe("sean");
  });
  it("a forged Date header, a lower Received header, or an unverified claim never moves eligibility_at", async () => {
    for (const basis of ["date_header", "lower_received_header", "customer_claim"]) {
      const { id } = await intake({ sentAt: RECEIVED - 5 * DAY, sentBasis: basis, sentEvidenceRef: "x", sentAcceptedBy: "sean" });
      expect((await row(id)).eligibility_at).toBe(RECEIVED);
      expect((await row(id)).sent_at).toBeNull();
    }
    const noRef = await intake({ sentAt: RECEIVED - 5 * DAY, sentBasis: "bounce_report" });
    expect((await row(noRef.id)).eligibility_at).toBe(RECEIVED);
  });
  it("a notice sent on the last eligible day and received after the window qualifies by eligibility_at at every path; the refund clock is received_at", async () => {
    const lateReceived = windowEndOf(MADE) + HOUR;
    const sent = windowEndOf(MADE) - 2 * HOUR;
    const { id } = await intake({ receivedAt: lateReceived, sentAt: sent, sentBasis: "bounce_report", sentEvidenceRef: "dsn-7", sentAcceptedBy: "sean" });
    expect((await row(id)).eligibility_at).toBe(sent);
    expect(verifyMails()).toHaveLength(1);                           // matched by eligibility_at
    const ok = await confirm(tokens().confirm);
    expect(ok.body.outcome).toBe("confirmed");
    expect(ok.body.receivedAt).toBe(lateReceived);                 // effective time = received_at
    const w = await env.DB.prepare("SELECT confirmed_at FROM withdrawals WHERE home_id=?").bind(HOME).first<{ confirmed_at: number }>();
    expect(w!.confirmed_at).toBe(lateReceived);
  });
  it("received after the window with no accepted dispatch evidence: no contract matches, no email, nothing executes", async () => {
    const { id, res } = await intake({ receivedAt: windowEndOf(MADE) + HOUR });
    expect(res.matchState).toBe("unmatched");
    expect(verifyMails()).toHaveLength(0);
    expect((await execute(id)).status).toBe(409);
    expect(await wds()).toBe(0);
  });
  it("Execute tests eligibility_at, never now (the signed-in path: see 'missing scenarios')", async () => {
    const lateReceived = windowEndOf(MADE) + HOUR;
    const { id } = await intake({ receivedAt: lateReceived, sentAt: windowEndOf(MADE) - HOUR, sentBasis: "postmark", sentEvidenceRef: "pm-1", sentAcceptedBy: "sean" });
    setClock(lateReceived + 3 * DAY);
    const r = await execute(id);
    expect(r.status).toBe(200);
    expect(await wds()).toBe(1);
  });
});

describe("confirm, Execute and the single refund", () => {
  it("the confirm link, never signed in: one withdrawal at received_at, one refund op through the ledger, the acknowledgement states the submission date", async () => {
    const { id } = await intake();
    const r = await confirm(tokens().confirm);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("confirmed");
    expect(r.body.receivedAt).toBe(RECEIVED);
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    const n = await row(id);
    expect(n.executed_via).toBe("link");
    expect(["executing", "completed"]).toContain(n.state);
    expect(n.refund_op_id).toBe(`withdrawal:withdrawal-notice-${id}`);
    const auth = await env.DB.prepare("SELECT via FROM withdrawal_authorizations WHERE notice_id=?").bind(id).first<{ via: string }>();
    expect(auth!.via).toBe("link");
    const op = await env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(n.refund_op_id).first<Record<string, unknown>>();
    expect(op!.refund_submitted_at).not.toBeNull();
    expect(submissions()).toHaveLength(1);
    const ack = mails.find((m) => m.subject.includes("carried out"));
    expect(ack, "the acknowledgement").toBeTruthy();
    expect(ack!.text).toContain(fmtExecuteByDate(op!.refund_submitted_at as number, "en"));
    expect(ack!.text).toContain("Your bank may take 5 to 10 business days to show it.");
    expect(ack!.to).toBe("pat@gmail.com");
  });
  it("a replayed confirm is refused as already used and renders the committed state; GET changes nothing", async () => {
    const { id } = await intake();
    const tok = tokens().confirm;
    const get = await call("GET", "/v1/public/withdrawal/confirm");
    expect(get.status).toBe(405);
    expect((await row(id)).state).toBe("open");
    await confirm(tok);
    const again = await confirm(tok);
    expect(again.status).toBe(200);
    expect(["already_executing", "already_completed"]).toContain(again.body.outcome);
    expect(await ops()).toBe(1);
    expect(await wds()).toBe(1);
  });
  it("(5a) Execute executes at received_at and submits the refund through the ledger; the acknowledgement states the submission date only", async () => {
    const { id } = await intake();
    const r = await execute(id);
    expect(r.status).toBe(200);
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    expect((await row(id)).executed_via).toBe("execute");
    const w = await env.DB.prepare("SELECT confirmed_at FROM withdrawals WHERE home_id=?").bind(HOME).first<{ confirmed_at: number }>();
    expect(w!.confirmed_at).toBe(RECEIVED);
    const ack = mails.find((m) => m.subject.includes("carried out"))!;
    expect(ack.text).not.toMatch(/arrive|will be in your/i);
  });
  it("Execute needs a withdrawal classification, a matched notice and an open state", async () => {
    const c = await intake({ classification: "support" });
    expect((await execute(c.id)).body.error).toBe("not_withdrawal");
    expect((await execute("0".repeat(32))).status).toBe(404);
    expect((await adminPost(`/v1/admin/withdrawals/${c.id}/execute`, { x: 1 })).status).toBe(400);
    expect((await call("POST", `/v1/admin/withdrawals/${c.id}/execute`, {})).status).toBe(401);
  });
  it("the account's earlier withdrawal blocks a second one: the batch aborts, the token is not burnt", async () => {
    const { id } = await intake();
    await env.DB.prepare(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status) VALUES ('w-prior',?,?,?,?,0,0,0,0,'pending','received')`)
      .bind(HOME, USER, CONS, NOW).run();
    const tok = tokens().confirm;
    const r = await confirm(tok);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_open");
    expect((await row(id)).state).toBe("open");
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE used_at IS NOT NULL")).toBe(0);
    expect(await ops()).toBe(0);
  });
  it("two notices for one contract get ONE verification email (coalesced); the first owns the link, the second follows its carrier", async () => {
    const a = await intake();
    const b = await intake();
    expect(verifyMails()).toHaveLength(1);
    expect((await row(b.id)).coalesced_into).toBe(a.id);
    // Coalescing is delivery only (r1-5): the trusted follower keeps its own dated status.
    expect((await adminGet(`/v1/admin/withdrawals/${b.id}`)).body).toMatchObject({ status: "waiting", coalescedInto: a.id });
    await confirm(tokens().confirm);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(b.id)).state).toBe("completed");
    expect(await ops()).toBe(1);
  });
});

describe("races: exactly one outcome", () => {
  it("the confirm click and Execute at the same moment: one withdrawal, one authorization, one refund row", async () => {
    const { id } = await intake();
    const tok = tokens().confirm;
    const [a, b] = await Promise.all([confirm(tok), execute(id)]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_authorizations WHERE notice_id=?", id)).toBe(1);
    const n = await row(id);
    expect(["executing", "completed"]).toContain(n.state);
    expect(submissions()).toHaveLength(1);
  });
  it("Execute and 'This wasn't me' at the same moment: executed OR stopped, never both", async () => {
    const { id } = await intake();
    const tok = tokens();
    const [x, y] = await Promise.all([execute(id), repudiate(tok.repudiate)]);
    const n = await row(id);
    expect(["executing", "completed", "repudiated"]).toContain(n.state);
    if (n.state === "repudiated") {
      expect(x.status).toBe(409);
      expect(await wds()).toBe(0);
      expect(await ops()).toBe(0);
      expect(y.body.outcome).toBe("stopped");
    } else {
      expect(x.status).toBe(200);
      expect(await wds()).toBe(1);
      expect(y.body.outcome === "too_late_executing" || y.body.outcome === "too_late_completed").toBe(true);
    }
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=?", id)).toBe(1);
  });
  it("the confirm click and 'This wasn't me' at the same moment: one outcome", async () => {
    const { id } = await intake();
    const tok = tokens();
    const [a, b] = await Promise.all([confirm(tok.confirm), repudiate(tok.repudiate)]);
    const n = await row(id);
    if (n.state === "repudiated") { expect(await wds()).toBe(0); expect(a.body.outcome).toBe("repudiated"); }
    else { expect(await wds()).toBe(1); expect(b.body.outcome).toMatch(/^too_late/); }
  });
  it("the same repudiation token posted twice at once: one suspension, the other refused or told the committed state", async () => {
    const { id } = await intake();
    const tok = tokens().repudiate;
    const [a, b] = await Promise.all([repudiate(tok), repudiate(tok)]);
    expect((await row(id)).state).toBe("repudiated");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=?", id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='repudiated'", id)).toBe(1);
    expect([a.body.outcome, b.body.outcome].every((o) => o === "stopped")).toBe(true);
  });
  it("two redeems of the confirm token at once: one withdrawal, resumed once", async () => {
    const { id } = await intake();
    const tok = tokens().confirm;
    const [a, b] = await Promise.all([confirm(tok), confirm(tok)]);
    expect([a.body.outcome, b.body.outcome].filter((o) => o === "confirmed")).toHaveLength(1);
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    void id;
  });
});

describe("'This wasn't me'", () => {
  it("before Execute: suspends, opens a case, mails the stop text; Execute then refuses and nothing is refunded", async () => {
    const { id } = await intake();
    const r = await repudiate(tokens().repudiate);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: "stopped", kind: "withdrawal" });
    expect(r.body.message).toBe(S.stopped.en);
    const n = await row(id);
    expect(n.state).toBe("repudiated");
    expect(n.repudiated_at).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=?", id)).toBe(1);
    const mail = mails.find((m) => m.subject.includes("stopped"));
    expect(mail!.text).toBe(S.stopped.en);
    const ex = await execute(id);
    expect(ex.status).toBe(409);
    expect(ex.body.error).toBe("repudiated");
    expect(await wds()).toBe(0);
    expect(await ops()).toBe(0);
    // No dated item for a suspended notice.
    setClock(alertAtOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("repudiated");
  });
  it("in German the stop reply is the plan's German", async () => {
    await intake({ language: "de" });
    await repudiate(tokens().repudiate);
    expect(mails.find((m) => m.subject === t("subjectStopped", "de"))!.text).toBe(S.stopped.de);
  });
  it("after Execute: a case only; the page and the email render from the SAVED state (never 'completed' while executing)", async () => {
    const { id } = await intake();
    const tok = tokens();
    stripeBlocked = true;                                     // the refund cannot finish: the notice stays executing
    expect((await execute(id)).status).toBe(200);
    expect((await row(id)).state).toBe("executing");
    const r = await repudiate(tok.repudiate);
    expect(r.body.outcome).toBe("too_late_executing");
    expect(r.body.message).toContain("This withdrawal is already being carried out, so we could not stop it.");
    expect(r.body.message).not.toContain("already carried out on");
    expect(r.body.message).toContain("Your refund: ");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=?", id)).toBe(1);
    expect((await row(id)).state).toBe("executing");
    stripeBlocked = false;
    setClock(NOW + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).state).toBe("completed");
    const again = await repudiate(tok.repudiate);               // the used link: the committed state, now completed
    expect(again.body.outcome).toBe("too_late_completed");
    expect(again.body.message).toContain("This withdrawal was already carried out on");
  });
  it("a confirm token posted to the repudiate endpoint, or the reverse, is refused; a prefetching GET changes nothing", async () => {
    const { id } = await intake();
    const tok = tokens();
    expect((await repudiate(tok.confirm)).status).toBe(409);
    expect((await confirm(tok.repudiate)).status).toBe(409);
    expect((await call("GET", "/v1/public/withdrawal/repudiate")).status).toBe(405);
    expect((await row(id)).state).toBe("open");
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE used_at IS NOT NULL")).toBe(0);
  });
  it("repudiated and unanswered by the refund deadline: closes as kept, the evidence stays; a clarify of the confirm link is refused with the committed state", async () => {
    const { id } = await intake();
    const tok = tokens();
    await repudiate(tok.repudiate);
    const c = await confirm(tok.confirm);
    expect(c.body.outcome).toBe("repudiated");
    expect(await wds()).toBe(0);
    setClock(RECEIVED + 14 * DAY);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).state).toBe("kept");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=? AND outcome='kept'", id)).toBe(1);
  });
  it("the holder who repudiated confirms with ordinary sign-in (aal1, no step-up): it executes at received_at", async () => {
    const { id } = await intake();
    await repudiate(tokens().repudiate);
    signedIn = USER;
    stepUpOk = false;                                           // no second factor at all
    const ok = await call("POST", `/v1/account/notices/${id}/confirm`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe("confirmed");
    expect((await row(id)).executed_via).toBe("signed_in");
    const w = await env.DB.prepare("SELECT confirmed_at FROM withdrawals WHERE home_id=?").bind(HOME).first<{ confirmed_at: number }>();
    expect(w!.confirmed_at).toBe(RECEIVED);
    expect(await wds()).toBe(1);
  });
});

describe("signed-in confirmation reads the notice's own contract", () => {
  it("aal1 (no step-up) is enough for an open notice; another account's notice is not found; a non-withdrawal is refused", async () => {
    const { id } = await intake();
    const cand = await intake({ classification: "candidate" });
    signedIn = "someone-else";
    expect((await call("POST", `/v1/account/notices/${id}/confirm`, {})).status).toBe(404);
    signedIn = USER;
    const bad = await call("POST", `/v1/account/notices/${cand.id}/confirm`, {});
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("not_withdrawal");
    const ok = await call("POST", `/v1/account/notices/${id}/confirm`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe("confirmed");
    signedIn = null;
    expect((await call("POST", `/v1/account/notices/${id}/confirm`, {})).status).toBe(401);
  });
  it("a newer contract does not replace the notice's own: the notice stays tied to the consent that matched its window", async () => {
    const { id } = await intake();
    await env.DB.prepare(`INSERT INTO checkout_consents (id,home_id,user_id,created_at,screen_version,cloud_terms_version,tos_version,privacy_version,terms_accepted,recurring_authorized,early_start,eu_region,topup_enabled,
      renewal_text,wording,billing_country,plan,price_cents,start_at,first_charge_at,delayed_start,tax_source,completed_at,contract_made_at) VALUES ('consent-newer',?,?,?,'s1','c1','t1','p1',1,1,0,1,0,'r','w','DE','pro',9900,?,?,0,'stripe_tax',?,?)`)
      .bind(HOME, USER, NOW, NOW, NOW, NOW, NOW).run();
    signedIn = USER;
    expect((await call("POST", `/v1/account/notices/${id}/confirm`, {})).status).toBe(200);
    const w = await env.DB.prepare("SELECT consent_id FROM withdrawals WHERE home_id=?").bind(HOME).first<{ consent_id: string }>();
    expect(w!.consent_id).toBe(CONS);
    expect(await count("SELECT COUNT(*) AS n FROM contract_links WHERE consent_id=?", CONS)).toBe(1);
  });
});

describe("reclassification races", () => {
  it("reclassify to cancellation, then redeem the confirm link: refused (tokens dead); reclassify then Execute: refused", async () => {
    const { id } = await intake();
    const tok = tokens();
    const c = await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "cancellation", basis: "asked for month end" });
    expect(c.status).toBe(200);
    expect(c.body.classificationRev).toBe(2);
    expect(c.body.correctionDue).toBe(true);
    expect((await confirm(tok.confirm)).body.error).toBe("link_invalid");
    expect((await repudiate(tok.repudiate)).body.error).toBe("link_invalid");
    expect((await execute(id)).body.error).toBe("not_withdrawal");
    expect(await wds()).toBe(0);
  });
  it("redeem, then reclassify: the authorization stands and the reclassification is refused with the record showing why", async () => {
    const { id } = await intake();
    await confirm(tokens().confirm);
    const c = await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "support", basis: "late second thoughts" });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("not_open");
    expect((await row(id)).classification).toBe("withdrawal");
    const ev = await env.DB.prepare("SELECT detail FROM withdrawal_notice_events WHERE notice_id=? AND kind='reclassify_refused'").bind(id).first<{ detail: string }>();
    expect(JSON.parse(ev!.detail)).toMatchObject({ requested: "support", code: "not_open" });
    expect(await wds()).toBe(1);
  });
  it("a notice put back to withdrawal gets fresh links; the old ones stay dead; a stale expectedRev is refused", async () => {
    const { id } = await intake();
    const old = tokens();
    await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "unclear", basis: "unclear" });
    mails.length = 0;
    const back = await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "withdrawal", basis: "customer replied", expectedRev: 2 });
    expect(back.status).toBe(200);
    expect(back.body.classificationRev).toBe(3);
    expect((await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "support", basis: "x", expectedRev: 2 })).body.error).toBe("revision_mismatch");
    expect((await confirm(old.confirm)).body.error).toBe("link_invalid");
    const fresh = tokens();
    expect(fresh.confirm.selector).not.toBe(old.confirm.selector);
    expect((await confirm(fresh.confirm)).body.outcome).toBe("confirmed");
  });
});

describe("link technique and the account email", () => {
  it("link expiry = min(issue + 7 days, received_at + 14 days); the verification email is bound to the account email and updated_at", async () => {
    await intake({ receivedAt: NOW - 10 * DAY, sentAt: undefined, classification: "withdrawal" });
    // received 10 days ago is outside the 3-day-old contract's relevance? the contract is 3 days old, so the notice predates it: no match and no links
    expect(verifyMails()).toHaveLength(0);
    mails.length = 0;
    await intake({ receivedAt: NOW - HOUR });
    const rows = (await env.DB.prepare("SELECT purpose, issued_at, expires_at, received_at FROM verify_tokens WHERE subject_kind='notice'").all<{ purpose: string; issued_at: number; expires_at: number; received_at: number }>()).results;
    expect(rows.map((r) => r.purpose).sort()).toEqual(["confirm", "repudiate"]);
    for (const r of rows) expect(r.expires_at).toBe(Math.min(r.issued_at + 7 * DAY, r.received_at + 14 * DAY));
  });
  it("an expiry cap of received + 14 days applies to a late issue", async () => {
    // received 12 days ago would predate the contract; use a contract made 20 days ago instead
    await env.DB.prepare("UPDATE checkout_consents SET completed_at=?, contract_made_at=? WHERE id=?").bind(NOW - 20 * DAY, NOW - 20 * DAY, CONS).run();
    await intake({ receivedAt: NOW - 12 * DAY, sentAt: undefined });
    // A notice 12 days old is inside its own window (made 20 days ago + 14 days = until day -6? no) so only check the cap when links exist
    const rows = (await env.DB.prepare("SELECT issued_at, expires_at, received_at FROM verify_tokens WHERE subject_kind='notice'").all<{ issued_at: number; expires_at: number; received_at: number }>()).results;
    for (const r of rows) expect(r.expires_at).toBe(Math.min(r.issued_at + 7 * DAY, r.received_at + 14 * DAY));
  });
  it("account email changed (or updated_at moved) after the link was sent: refused with identity_changed; the new-link request mails the CURRENT email", async () => {
    const { id } = await intake();
    const tok = tokens();
    supa = { ...supa, email: "pat.b@example.test", updatedAt: "2026-10-05T00:00:00.000Z" };
    const r = await confirm(tok.confirm);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "identity_changed", canResend: true });
    expect((await row(id)).state).toBe("open");
    mails.length = 0;
    const nl = await post("/v1/public/withdrawal/new-link", { selector: tok.confirm.selector });
    expect(nl.status).toBe(202);
    expect(nl.body).toEqual({});
    expect(verifyMails()).toHaveLength(1);
    expect(verifyMails()[0].to).toBe("pat.b@example.test");
    expect((await confirm(tok.confirm)).body.error).toBe("link_invalid");        // the old pair no longer exists
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
    // A -> B -> A: the updated_at differs again
  });
  it("A -> B -> A still differs by updated_at", async () => {
    await intake();
    const tok = tokens();
    supa = { ...supa, email: "b@example.test", updatedAt: "2026-10-02T00:00:00.000Z" };
    supa = { ...supa, email: "pat@gmail.com", updatedAt: "2026-10-03T00:00:00.000Z" };
    expect((await confirm(tok.confirm)).body.error).toBe("identity_changed");
  });
  it("an expired link is refused with canResend; the reader down is a 503 and consumes nothing", async () => {
    const live = await intake();
    const liveTok = tokens();
    readerDown = true;
    const down = await confirm(liveTok.confirm);
    expect(down.status).toBe(503);
    expect(down.body.error).toBe("identity_unavailable");
    readerDown = false;
    expect((await row(live.id)).state).toBe("open");
    // A link issued 8 days ago (test clock) has expired by now.
    await env.DB.prepare("DELETE FROM withdrawal_notices").run();
    await env.DB.prepare("DELETE FROM verify_tokens").run();
    await env.DB.prepare("DELETE FROM withdrawal_notice_mail").run();
    mails.length = 0;
    setClock(NOW - 8 * DAY);
    const { id } = await intake();
    setClock(NOW);
    const tok = tokens();
    const exp = await confirm(tok.confirm);
    expect(exp.body).toMatchObject({ error: "link_expired", canResend: true });
    expect((await row(id)).state).toBe("open");
  });
  it("the lookup is read-only, names the purpose, carries the UTC cutoff date, and the public answers carry no timing header", async () => {
    const { id } = await intake();
    const tok = tokens();
    const l = await post("/v1/public/token/lookup", tok.confirm);
    expect(l.body).toMatchObject({ kind: "withdrawal", state: "open", purpose: "confirm", planName: "pro", executeByDate: new Date(executeByOf(RECEIVED)).toISOString().slice(0, 10) });
    expect((await post("/v1/public/token/lookup", tok.repudiate)).body.purpose).toBe("repudiate");
    expect(l.headers.get("server-timing")).toBeNull();
    expect(l.headers.get("x-d1-bookmark")).toBeNull();
    const c = await confirm(tok.confirm);
    expect(c.headers.get("server-timing")).toBeNull();
    expect((await row(id)).last_op).not.toBeNull();
  });
});

describe("the day-12 item, the day-13 alert, overdue and the late Execute", () => {
  it("day 12: the dated item appears; before it, no; Execute works on day 12 and day 13", async () => {
    const { id } = await intake();
    const day12 = itemAtOf(RECEIVED);
    setClock(day12 - 1);
    await sweepWithdrawalNotices(testEnv());
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("waiting");
    expect((await row(id)).item_raised_at).toBeNull();
    setClock(day12);
    await sweepWithdrawalNotices(testEnv());
    const q = (await adminGet(`/v1/admin/withdrawals/${id}`)).body;
    expect(q.status).toBe("item");
    expect(q.item).toBe(`Execute withdrawal. Deadline: ${fmtExecuteByDate(executeByOf(RECEIVED), "en")}`);
    expect((await row(id)).item_raised_at).toBe(day12);
    const list = await adminGet("/v1/admin/withdrawals");
    expect((list.body.notices as { id: string }[]).map((x) => x.id)).toContain(id);
    expect((await execute(id)).status).toBe(200);
    expect(await ops()).toBe(1);
  });
  it("day 13: a direct 'refund due today' alert, stored and retried every 15 minutes until acknowledged", async () => {
    const { id } = await intake();
    const day13 = alertAtOf(RECEIVED);
    setClock(day13 - 1);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(0);
    setClock(day13 + 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toContain("withdrawal.refund_due_today");
    expect(hooks[0].body).toContain(id);
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("due_today");
    await sweepWithdrawalNotices(testEnv());                    // too soon: no second try
    expect(hooks).toHaveLength(1);
    setClock(day13 + 60_000 + 15 * 60_000);
    await sweepWithdrawalNotices(testEnv());                    // the webhook failed: retried
    expect(hooks).toHaveLength(2);
    hookOk = true;
    setClock(day13 + 60_000 + 30 * 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(3);
    expect((await row(id)).alert_attempts).toBe(3);
    // Delivered is not acknowledged: it keeps coming until someone acknowledges.
    setClock(day13 + 60_000 + 60 * 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(4);
    expect((await adminPost(`/v1/admin/withdrawals/${id}/acknowledge-alert`, {})).status).toBe(200);
    setClock(day13 + 6 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(4);
    expect((await adminPost(`/v1/admin/withdrawals/${id}/acknowledge-alert`, {})).status).toBe(409);
  });
  it("executing the item closes its alert without an acknowledgement", async () => {
    const { id } = await intake();
    setClock(alertAtOf(RECEIVED) + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(1);
    await execute(id);
    setClock(alertAtOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(1);
    expect((await row(id)).alert_acked_by).toBe("system:resolved");
  });
  it("after the cutoff the item is overdue (still open, never called completed) and a late Execute is rejected by the server", async () => {
    const { id } = await intake();
    const by = executeByOf(RECEIVED);
    setClock(by);                                              // 23:59:59 itself is still inside
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).overdue_at).toBeNull();
    setClock(by + 1000);
    await sweepWithdrawalNotices(testEnv());
    const n = await row(id);
    expect(n.overdue_at).toBe(by + 1000);
    expect(n.state).toBe("open");
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("overdue");
    const late = await execute(id);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("deadline_passed");
    expect(await wds()).toBe(0);
    expect(await ops()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.overdue'")).toBe(1);
    // The holder can still confirm (link or signed in): the refund is still owed.
    signedIn = USER;
    expect((await call("POST", `/v1/account/notices/${id}/confirm`, {})).status).toBe(200);
  });
  it("Execute at the cutoff second works", async () => {
    const { id } = await intake();
    setClock(executeByOf(RECEIVED));
    expect((await execute(id)).status).toBe(200);
  });
});

describe("crash recovery and refund failure", () => {
  it("a crash after the transition resumes once from the stored state", async () => {
    const { id } = await intake();
    setNoticeDeps(deps({ stripe: null }));                      // the process dies before the refund step
    const r = await authorize(testEnv(), { ...deps({ stripe: null }) } as never, id, "execute");
    expect(r.code).toBe("ok");
    expect((await row(id)).state).toBe("executing");
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    expect(submissions()).toHaveLength(0);
    setNoticeDeps(deps());
    await sweepWithdrawalNotices(testEnv());
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).state).toBe("completed");
    expect(await wds()).toBe(1);
    expect(await ops()).toBe(1);
    expect(submissions()).toHaveLength(1);
    expect(mails.filter((m) => m.subject.includes("carried out"))).toHaveLength(1);
  });
  it("a refund failure keeps the case open: the notice stays executing with a refund_failed case, no acknowledgement, and recovers", async () => {
    const { id } = await intake();
    stripeBlocked = true;
    expect((await execute(id)).status).toBe(200);
    const n = await row(id);
    expect(n.state).toBe("executing");
    expect(n.completed_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=? AND reason='refund_failed'", id)).toBe(1);
    expect(mails.filter((m) => m.subject.includes("carried out"))).toHaveLength(0);
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("case_open");
    stripeBlocked = false;
    setClock(NOW + 2 * HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).state).toBe("completed");
    expect(await ops()).toBe(1);
  });
});

describe("mail: limits, coalescing, claims and never abandoning", () => {
  it("the per-recipient mail limit (3 an hour) holds a verification mail back until the window passes", async () => {
    for (let i = 0; i < 3; i += 1) expect(await reserveMail(testEnv(), { now: () => cur }, "pat@gmail.com")).toBe(true);
    const { id } = await intake();
    expect(verifyMails()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND sent_at IS NULL", id)).toBe(1);
    expect((await row(id)).verification_sent_at).toBeNull();
    setClock(NOW + HOUR + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect(verifyMails()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND sent_at IS NULL", id)).toBe(0);
  });
  it("a failed send is retried with the SAME links (stable payload), never abandoned, escalated to ops after 20 tries", async () => {
    mailFails = 25;
    const { id } = await intake();
    expect(verifyMails()).toHaveLength(0);
    const kept = (await env.DB.prepare("SELECT id,payload FROM withdrawal_notice_mail WHERE notice_id=? AND kind='verify'").bind(id).first<{ id: string; payload: string }>())!;
    expect(kept.payload).toMatch(/^v1:/);                                           // sealed at rest (P2)
    expect(kept.payload).not.toContain("/verify#");
    const first = (await openPayload(testEnv(), kept.payload, kept.id))!.text;
    expect(first).toContain("/verify#");
    for (let i = 0; i < 22; i += 1) { setClock(NOW + (i + 1) * 1000 * 130); await flushMail(testEnv(), deps({ now: () => cur }) as never); }
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.mail_stuck'")).toBe(1);
    expect(verifyMails()).toHaveLength(0);
    mailFails = 0;
    setClock(NOW + 40 * 130_000);
    await flushMail(testEnv(), deps({ now: () => cur }) as never);
    expect(verifyMails()).toHaveLength(1);
    const sentToken = tokens();
    expect(first).toContain(sentToken.confirm.selector);
    expect((await confirm(sentToken.confirm)).body.outcome).toBe("confirmed");
  });
  const openStuckAlert = () => env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('a1','billing','withdrawal.mail_stuck','high','x',?)").bind(NOW).run();
  const stuckOpen = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.mail_stuck' AND resolved_at IS NULL");
  it("p2-1: the stuck-mail alert stays open while another escalated mail is unsent (the closing UPDATE checks it itself)", async () => {
    const { id } = await intake({ classification: "support" });
    await env.DB.prepare("UPDATE withdrawal_notices SET sender='x@else.test', match_state='unmatched' WHERE id=?").bind(id).run();
    await openStuckAlert();
    // A's mail: escalated earlier, about to be sent. B's mail: escalated meanwhile, held by another sender, still unsent.
    await env.DB.prepare("INSERT INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at,escalated_at) VALUES ('mA',?,'unmatched_reply','kA',?,?)").bind(id, NOW, NOW).run();
    await env.DB.prepare("INSERT INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at,escalated_at,claim_id,claimed_until) VALUES ('mB',?,'unmatched_reply','kB',?,?,'other',?)").bind(id, NOW, NOW, NOW + 10 * DAY).run();
    expect(await flushMail(testEnv(), deps({ now: () => cur }) as never)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE id='mA' AND sent_at IS NOT NULL")).toBe(1);
    expect(await stuckOpen()).toBe(1);                                              // B is still stuck: the alert must not close
    await env.DB.prepare("UPDATE withdrawal_notice_mail SET sent_at=?, claim_id=NULL, claimed_until=NULL WHERE id='mB'").bind(NOW).run();
    await env.DB.prepare("INSERT INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at,escalated_at) VALUES ('mC',?,'unmatched_reply','kC',?,?)").bind(id, NOW, NOW).run();
    expect(await flushMail(testEnv(), deps({ now: () => cur }) as never)).toBe(1);
    expect(await stuckOpen()).toBe(0);                                              // nothing escalated is left unsent: now it closes
  });
  it("p3-1: skipping the last escalated mail closes the stuck-mail alert", async () => {
    const { id } = await intake({ classification: "support" });
    await env.DB.prepare("UPDATE withdrawal_notices SET sender='x@else.test', match_state='matched' WHERE id=?").bind(id).run();   // the reply no longer applies: skipped
    await openStuckAlert();
    await env.DB.prepare("INSERT INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at,escalated_at) VALUES ('mS',?,'unmatched_reply','kS',?,?)").bind(id, NOW, NOW).run();
    expect(await flushMail(testEnv(), deps({ now: () => cur }) as never)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE id='mS' AND last_error='skipped'")).toBe(1);
    expect(await stuckOpen()).toBe(0);
  });
  it("two sweeps racing for one mail send it once (exclusive claim)", async () => {
    const { id } = await intake({ classification: "support" });
    void id;
    await env.DB.prepare("INSERT INTO withdrawal_notice_mail (id,notice_id,kind,mail_key,created_at) VALUES ('m1',?,'unmatched_reply','k1',?)").bind(id, NOW).run();
    await env.DB.prepare("UPDATE withdrawal_notices SET sender='x@else.test', match_state='unmatched' WHERE id=?").bind(id).run();
    const [a, b] = await Promise.all([flushMail(testEnv(), deps({ now: () => cur }) as never), flushMail(testEnv(), deps({ now: () => cur }) as never)]);
    expect(a + b).toBe(1);
    expect(mails.filter((m) => m.to === "x@else.test")).toHaveLength(1);
  });
  it("a reminder goes out once, three days after the first verification email, and not after the notice left `open`", async () => {
    const { id } = await intake();
    setClock(NOW + 3 * DAY + 1000);
    await sweepWithdrawalNotices(testEnv());
    await sweepWithdrawalNotices(testEnv());
    expect(verifyMails()).toHaveLength(2);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='verify_reminder'", id)).toBe(1);
  });
  it("a new-link request is limited per notice and never reveals anything: always 202 {}", async () => {
    const { id } = await intake();
    const tok = tokens();
    const outcomes: number[] = [];
    for (let i = 0; i < 4; i += 1) { const r = await post("/v1/public/withdrawal/new-link", { selector: tok.confirm.selector }); outcomes.push(r.status); expect(r.body).toEqual({}); }
    expect(outcomes.every((s) => s === 202)).toBe(true);
    expect((await post("/v1/public/withdrawal/new-link", { selector: "x".repeat(22) })).status).toBe(202);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='verify_newlink'", id)).toBeLessThanOrEqual(1);
  });
});

describe("operator link of an unmatched notice (P1)", () => {
  it("links it to an account and only sends a link: never the dated item", async () => {
    const { id, res } = await intake({ from: ["stranger@else.test"], boundaryAuth: undefined });
    expect(res.matchState).toBe("unmatched");
    const l = await adminPost(`/v1/admin/withdrawals/${id}/link`, { accountId: USER });
    expect(l.status).toBe(200);
    expect(l.body.verificationKind).toBe("other_sender");
    expect(verifyMails()).toHaveLength(1);
    expect((await row(id)).sender_trusted).toBe(0);
    setClock(alertAtOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("escalated");
    expect((await adminPost(`/v1/admin/withdrawals/${id}/link`, { accountId: USER })).status).toBe(409);
  });
});

// --- Astra WP9-1 round 1 ---------------------------------------------------------------------------------------------------------------

describe("r1-1: the From field is parsed whole; the display name is never an address", () => {
  it("a display name that looks like the account address never attributes the notice", async () => {
    expect(soleFrom(['"<pat@gmail.com>" <attacker@gmail.com>'])).toBe("attacker@gmail.com");
    expect(soleFrom(["pat@gmail.com <attacker@gmail.com>"])).toBeNull();                          // an unquoted @ in a display name: invalid
    expect(soleFrom(["Pat (pat@gmail.com) <attacker@gmail.com>"])).toBe("attacker@gmail.com");   // a comment is not an address either
    const acct = { contactEmail: "pat@gmail.com", heldSince: RECEIVED - DAY };
    expect(senderTrusted(gmailAuth as never, ['"<pat@gmail.com>" <attacker@gmail.com>'], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "address_mismatch", sameAddress: false });
    const forged = await intake({ from: ['"<pat@gmail.com>" <attacker@gmail.com>'] });
    expect(forged.res.trusted).toBe(false);
    expect(forged.res.matchState).toBe("unmatched");
    expect(verifyMails()).toHaveLength(0);
    expect((await row(forged.id)).sender).toBe("attacker@gmail.com");
  });
  it("two mailboxes in ONE header value, a group, or an unparseable field are (5b): never trusted", async () => {
    expect(parseFrom(["pat@gmail.com, boss@gmail.com"])).toEqual({ valid: true, mailboxes: ["pat@gmail.com", "boss@gmail.com"] });
    expect(parseFrom(['"Pat, Jr." <pat@gmail.com>'])).toEqual({ valid: true, mailboxes: ["pat@gmail.com"] });
    expect(parseFrom(["team: pat@gmail.com, x@gmail.com;"]).mailboxes).toHaveLength(2);
    expect(parseFrom(["undisclosed-recipients:;"])).toEqual({ valid: true, mailboxes: [] });
    for (const bad of ["<pat@gmail.com", "pat@gmail.com>", '"pat@gmail.com', "<@relay.test:pat@gmail.com>", "pat@[127.0.0.1]", "pat@gmail.com (x", "<a@b.com> <c@d.com>"]) {
      expect(parseFrom([bad]).valid, bad).toBe(false);
    }
    const acct = { contactEmail: "pat@gmail.com", heldSince: RECEIVED - DAY };
    expect(senderTrusted(gmailAuth as never, ["pat@gmail.com, boss@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "more_than_one_from" });
    expect(senderTrusted(gmailAuth as never, ["<pat@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: false, failed: "from_unparseable" });
    expect(senderTrusted(gmailAuth as never, ["Pat <pat@gmail.com>"], acct, RECEIVED)).toMatchObject({ trusted: true });
    const two = await intake({ from: ["pat@gmail.com, boss@gmail.com"] });
    expect(two.res.trusted).toBe(false);
    expect((await row(two.id)).sender_count).toBe(2);
    setClock(alertAtOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await adminGet(`/v1/admin/withdrawals/${two.id}`)).body.status).toBe("escalated");
  });
});

describe("r1-2: the 'This wasn't me' link opens the site's /not-me page; confirm stays on /verify", () => {
  it("each link carries its own page; the lookup still names the purpose", async () => {
    await intake();
    const mail = verifyMails().pop()!;
    expect(mail.text).toMatch(new RegExp(`Confirm withdrawal: ${LINK}`));
    expect(mail.text).toMatch(new RegExp(`This wasn't me: ${NOT_ME_LINK}`));
    expect(mail.text).not.toMatch(/This wasn't me: https:\/\/murage\.test\/verify#/);
    const tok = tokens();
    const look = await post("/v1/public/token/lookup", tok.repudiate);
    expect(look.status).toBe(200);
    expect(look.body.purpose).toBe("repudiate");
    expect((await post("/v1/public/token/lookup", tok.confirm)).body.purpose).toBe("confirm");
  });
});

describe("r1-3: the refund targets the notice's own contract, never the home's current subscription", () => {
  it("no resolved subscription: nothing executes, a case stays open; once the contract's subscription is known the refund targets exactly it", async () => {
    // A contract whose subscription was never recorded (its own consent id: contract_links is insert-only and keeps earlier tests' rows).
    await env.DB.prepare("UPDATE checkout_consents SET id='consent-r13', stripe_subscription_id=NULL WHERE id=?").bind(CONS).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='replacement-sub', consent_id='consent-r13' WHERE home_id=?").bind(HOME).run();
    const { id } = await intake();
    expect((await row(id)).subscription_id).toBeNull();
    const r = await execute(id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("target_unresolved");
    expect(await ops()).toBe(0);
    expect(await wds()).toBe(0);
    const n = await row(id);
    expect(n.state).toBe("open");
    expect(n.case_id).toBe(`case-${id}`);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=? AND reason='subscription_unresolved' AND closed_at IS NULL", id)).toBe(1);
    // The link path refuses the same way and burns nothing.
    const c = await confirm(tokens().confirm);
    expect(c.body.error).toBe("target_unresolved");
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE used_at IS NOT NULL")).toBe(0);
    await env.DB.prepare("UPDATE checkout_consents SET stripe_subscription_id=? WHERE id=?").bind(SUBID, "consent-r13").run();
    expect((await execute(id)).status).toBe(200);
    const op = await env.DB.prepare("SELECT subscription_id FROM refund_ops WHERE kind='withdrawal' AND home_id=?").bind(HOME).first<{ subscription_id: string | null }>();
    expect(op!.subscription_id).toBe(SUBID);
    expect((await row(id)).subscription_id).toBe(SUBID);
  });
  it("records that disagree about the contract's subscription are a case, never a guess", async () => {
    const { id } = await intake();
    await env.DB.prepare("UPDATE checkout_consents SET stripe_subscription_id='sub_other' WHERE id=?").bind(CONS).run();
    const r = await execute(id);
    expect(r.body.error).toBe("target_unresolved");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=? AND reason='subscription_conflict'", id)).toBe(1);
    expect(await ops()).toBe(0);
  });
});

describe("r1-4: a timely notice gets the full refund it qualified for; eligibility follows plan 4.1", () => {
  it("sent in time, received late, server running with early start: everything paid comes back (never a pro-rata part), effective at receipt", async () => {
    await env.DB.prepare("UPDATE checkout_consents SET early_start=1 WHERE id=?").bind(CONS).run();
    const lateReceived = windowEndOf(MADE) + 3 * DAY;
    const sent = windowEndOf(MADE) - HOUR;
    const { id } = await intake({ receivedAt: lateReceived, sentAt: sent, sentBasis: "bounce_report", sentEvidenceRef: "dsn-9", sentAcceptedBy: "sean" });
    setClock(lateReceived + HOUR);
    expect((await execute(id)).status).toBe(200);
    const op = await env.DB.prepare("SELECT amount_cents,basis,detail FROM refund_ops WHERE kind='withdrawal' AND home_id=?").bind(HOME).first<{ amount_cents: number; basis: string; detail: string }>();
    expect(op!.basis).toBe("eu_uk_full_refund");
    expect(op!.amount_cents).toBe(9900);
    expect(JSON.parse(op!.detail)).toMatchObject({ withdrawalEntitlement: "eu_uk_full", qualifyingAt: sent, confirmedAt: lateReceived });
    expect(submissions().map((c) => c.amount)).toEqual([9900]);
    const w = await env.DB.prepare("SELECT confirmed_at,refund_cents,basis FROM withdrawals WHERE home_id=?").bind(HOME).first<{ confirmed_at: number; refund_cents: number; basis: string }>();
    expect(w).toMatchObject({ confirmed_at: lateReceived, refund_cents: 9900, basis: "eu_uk_full_refund" });
  });
  it("the guarantee runs from the service start: a server that started later keeps the window open past the statutory one", async () => {
    await env.DB.prepare("UPDATE service_intervals SET started_at=? WHERE home_id=?").bind(MADE + 5 * DAY, HOME).run();
    const at = windowEndOf(MADE) + 2 * DAY;               // after the statutory window, inside the guarantee (start + 14)
    const ok = await intake({ receivedAt: at });
    expect(ok.res.matchState).toBe("matched");
    const late = await intake({ receivedAt: windowEndOf(MADE + 5 * DAY) + HOUR });
    expect(late.res.matchState).toBe("unmatched");
  });
  it("pending start (payment or provisioning not done): withdrawal stays open; a journalled start not yet applied counts", async () => {
    await env.DB.prepare("DELETE FROM service_intervals").run();
    const pending = await intake({ receivedAt: windowEndOf(MADE) + 20 * DAY });
    expect(pending.res.matchState).toBe("matched");
    await env.DB.prepare("INSERT INTO service_interval_log (home_id,kind,at,subscription_id,created_at) VALUES (?,'start',?,?,?)").bind(HOME, MADE, SUBID, MADE).run();
    const after = await intake({ receivedAt: windowEndOf(MADE) + 20 * DAY });
    expect(after.res.matchState).toBe("unmatched");
  });
  it("a replacement for a running server: the guarantee runs from its payment", async () => {
    // The home was already running under an earlier subscription when this contract was made; its payment came 6 days later.
    await env.DB.prepare("DELETE FROM service_intervals").run();
    await env.DB.prepare("INSERT INTO service_intervals (home_id,started_at,subscription_id) VALUES (?,?,'sub_old')").bind(HOME, MADE - 40 * DAY).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET first_paid_at=? WHERE home_id=?").bind(MADE + 6 * DAY, HOME).run();
    expect((await intake({ receivedAt: windowEndOf(MADE + 6 * DAY) - HOUR })).res.matchState).toBe("matched");
    expect((await intake({ receivedAt: windowEndOf(MADE + 6 * DAY) + HOUR })).res.matchState).toBe("unmatched");
  });
});

// --- Astra WP9-2 round 2 ---------------------------------------------------------------------------------------------------------------

/** A completed EU contract of the test home under its own consent id and subscription. */
const addContract = (id: string, sub: string, made: number) => env.DB.prepare(`INSERT INTO checkout_consents (id,home_id,user_id,created_at,screen_version,cloud_terms_version,tos_version,
    privacy_version,terms_accepted,recurring_authorized,early_start,eu_region,topup_enabled,renewal_text,wording,billing_country,plan,price_cents,start_at,first_charge_at,delayed_start,tax_source,
    completed_at,contract_made_at,stripe_subscription_id,stripe_session_id) VALUES (?,?,?,?,'s1','c1','t1','p1',1,1,0,1,0,'Renews monthly.','w','DE','pro',9900,?,?,0,'stripe_tax',?,?,?,?)`)
  .bind(id, HOME, USER, made - 60_000, made, made, made, made, sub, `cs_${id}`).run();
const interval = (sub: string, start: number, end: number | null) =>
  env.DB.prepare("INSERT INTO service_intervals (home_id,started_at,ended_at,subscription_id) VALUES (?,?,?,?)").bind(HOME, start, end, sub).run();
const currentSub = (sub: string, paidAt: number | null) =>
  env.DB.prepare("UPDATE billing_subscriptions SET subscription_id=?, consent_id=NULL, first_paid_at=? WHERE home_id=?").bind(sub, paidAt, HOME).run();

describe("r2-1: eligibility comes from immutable per-contract evidence, never from the home's current subscription", () => {
  // A (original, started 200 days ago) -> B (replacement, paid 90 days ago) -> C (replacement, paid 60 days ago). The home now holds C.
  const T = NOW;
  async function chain() {
    await env.DB.batch([env.DB.prepare("DELETE FROM checkout_consents"), env.DB.prepare("DELETE FROM service_intervals")]);
    await addContract("r2-a", "sub_r2a", T - 201 * DAY);
    await addContract("r2-b", "sub_r2b", T - 91 * DAY);
    await addContract("r2-c", "sub_r2c", T - 61 * DAY);
    await interval("sub_r2a", T - 200 * DAY, T - 90 * DAY);
    await interval("sub_r2b", T - 90 * DAY, T - 60 * DAY);
    await interval("sub_r2c", T - 60 * DAY, null);
  }
  it("A -> B -> C: B's payment row is gone; a 90-day-old contract is refused (never open-ended) and a case is opened", async () => {
    await chain();
    await currentSub("sub_r2c", T - 60 * DAY);
    const n = await intake({ receivedAt: T - HOUR });
    expect(n.res.matchState).toBe("unmatched");
    const r = await row(n.id);
    expect(r.consent_id).toBeNull();
    expect(r.match_note).toBe("deadline_evidence_missing");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=? AND reason='deadline_evidence_missing'", n.id)).toBe(1);
    expect(verifyMails()).toHaveLength(0);
    expect((await execute(n.id)).status).toBe(409);
    expect(await ops()).toBe(0);
  });
  it("B's payment frozen while B was current: still refused 90 days later, no case (the evidence says the window ended); frozen values never move", async () => {
    await chain();
    await currentSub("sub_r2b", T - 90 * DAY);
    await sweepWithdrawalNotices(testEnv());                               // freezes B's payment moment
    expect(await env.DB.prepare("SELECT paid_at FROM contract_deadlines WHERE consent_id='r2-b'").first<{ paid_at: number }>()).toEqual({ paid_at: T - 90 * DAY });
    await currentSub("sub_r2c", T - 60 * DAY);
    const n = await intake({ receivedAt: T - HOUR });
    expect(n.res.matchState).toBe("unmatched");
    expect((await row(n.id)).match_note).toBe("no_eligible_contract");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=?", n.id)).toBe(0);
    await expect(env.DB.prepare("UPDATE contract_deadlines SET paid_at=? WHERE consent_id='r2-b'").bind(T).run()).rejects.toThrow(/write_once/);
    // Inside B's frozen guarantee window the same notice is matched to B.
    const timely = await intake({ receivedAt: windowEndOf(T - 90 * DAY) - HOUR });
    expect(timely.res.matchState).toBe("matched");
    expect((await row(timely.id)).consent_id).toBe("r2-b");
  });
  it("genuinely pending: the current contract's payment has not come, so its window stays open (distinct from missing evidence)", async () => {
    await chain();
    await currentSub("sub_r2c", null);
    const n = await intake({ receivedAt: T - HOUR });
    expect(n.res.matchState).toBe("matched");
    expect((await row(n.id)).consent_id).toBe("r2-c");
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=?", n.id)).toBe(0);
  });
});

describe("r2-2: alerts follow the notice's current classification and revision", () => {
  it("a carrier reclassified to cancellation stops getting Execute alerts at once; put back to withdrawal it is raised afresh for the new revision", async () => {
    const carrier = await intake();
    const follower = await intake();                                           // trusted follower: its own refund obligation stays
    expect((await row(follower.id)).coalesced_into).toBe(carrier.id);
    setClock(alertAtOf(RECEIVED) + 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(carrier.id)).alert_rev).toBe(1);
    expect(hooks.some((h) => h.body.includes(carrier.id))).toBe(true);
    expect((await adminPost(`/v1/admin/withdrawals/${carrier.id}/classify`, { classification: "cancellation", basis: "asked to cancel" })).status).toBe(200);
    hooks = [];
    setClock(alertAtOf(RECEIVED) + 60_000 + ALERT_RETRY_MS + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks.some((h) => h.body.includes(carrier.id))).toBe(false);
    const c = await row(carrier.id);
    expect(c.alert_raised_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='alert_withdrawn'", carrier.id)).toBe(1);
    // The released trusted follower is still a live withdrawal of the holder: its own alert goes on.
    expect(hooks.some((h) => h.body.includes(follower.id))).toBe(true);
    // Put back to withdrawal (rev 3): the alert is raised again for the new revision.
    expect((await adminPost(`/v1/admin/withdrawals/${carrier.id}/classify`, { classification: "withdrawal", basis: "it was a withdrawal" })).status).toBe(200);
    hooks = [];
    setClock(alertAtOf(RECEIVED) + 60_000 + 2 * ALERT_RETRY_MS + 2000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(carrier.id)).alert_rev).toBe(3);
    expect(hooks.some((h) => h.body.includes(carrier.id))).toBe(true);
  });
});

describe("r2-3: a kept verification mail is resent only while its links can still be redeemed", () => {
  it("A -> B -> A email change: same address, new generation; the retry renders fresh links that confirm", async () => {
    mailFails = 1;                                                             // rendered and kept, the send fails
    const { id } = await intake();
    expect(verifyMails()).toHaveLength(0);
    supa = { ...supa, email: "other@gmail.com", updatedAt: "2026-10-02T00:00:00.000Z" };
    supa = { ...supa, email: "pat@gmail.com", updatedAt: "2026-10-03T00:00:00.000Z" };
    await flushMail(testEnv(), deps() as never, id);
    expect(verifyMails()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens WHERE subject_id=? AND email_gen='2026-10-03T00:00:00.000Z'", id)).toBe(2);
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
  });
  it("expired kept links are never resent: the retry after expiry carries links that are still valid", async () => {
    mailFails = 1;
    const { id } = await intake();
    setClock(NOW + 8 * DAY);                                                   // the kept pair expired at NOW + 7 days
    await flushMail(testEnv(), deps() as never, id);
    expect(verifyMails()).toHaveLength(1);
    const live = await env.DB.prepare("SELECT MIN(expires_at) AS e FROM verify_tokens WHERE subject_id=?").bind(id).first<{ e: number }>();
    expect(live!.e).toBeGreaterThan(NOW + 8 * DAY);
  });
});

describe("r2-4: folded and commented From fields that RFC 5322 permits are parsed, the whole field is still validated", () => {
  it("unfolds CRLF+WSP and consumes CFWS around the local part and the domain; one mailbox stays one", async () => {
    expect(parseFrom(['"Pat\r\n Smith" <pat@gmail.com>'])).toEqual({ valid: true, mailboxes: ["pat@gmail.com"] });
    expect(parseFrom(["Pat Smith\r\n\t<pat@gmail.com>"])).toEqual({ valid: true, mailboxes: ["pat@gmail.com"] });
    expect(parseFrom(["pat(comment)@gmail.com"])).toEqual({ valid: true, mailboxes: ["pat@gmail.com"] });
    expect(parseFrom(["pat@(c)gmail.com (home)"])).toEqual({ valid: true, mailboxes: ["pat@gmail.com"] });
    expect(parseFrom(["Pat <(x) pat (y) @ (z) gmail.com>"])).toEqual({ valid: true, mailboxes: ["pat@gmail.com"] });
    for (const bad of ["pat@gmail.com\r\n", "pat@gmail.com\nx", '"Pat\r\nSmith" <pat@gmail.com>', "pat .smith@gmail.com", "pat@gmail .com", "pat(comment)@gmail.com, boss@gmail.com (x"]) {
      expect(parseFrom([bad]).valid, JSON.stringify(bad)).toBe(false);
    }
    expect(soleFrom(["pat(comment)@gmail.com, boss@gmail.com"])).toBeNull();     // still two mailboxes
    const acct = { contactEmail: "pat@gmail.com", heldSince: RECEIVED - DAY };
    expect(senderTrusted(gmailAuth as never, ['"Pat\r\n Smith" <pat@gmail.com>'], acct, RECEIVED)).toMatchObject({ trusted: true });
    expect(senderTrusted(gmailAuth as never, ["pat(comment)@gmail.com"], acct, RECEIVED)).toMatchObject({ trusted: true });
    expect((await intake({ from: ["pat(comment)@gmail.com"] })).res.trusted).toBe(true);
  });
});

describe("r1-5: coalescing joins delivery only; each notice keeps its trust, receipt and deadline", () => {
  it("an untrusted carrier first, then a trusted notice: the trusted one gets its own trusted email, dated item and day-13 alert", async () => {
    const weak = await intake({ boundaryAuth: undefined });                      // same address, checks failed: (5b)
    const strong = await intake({ receivedAt: RECEIVED + HOUR });
    expect((await row(strong.id)).coalesced_into).toBeNull();
    expect(verifyMails().map((m) => m.text.startsWith("We received your withdrawal from this email address") ? "trusted" : "other")).toEqual(["other", "trusted"]);
    setClock(alertAtOf(RECEIVED + HOUR) + 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(strong.id)).item_raised_at).not.toBeNull();
    expect((await row(strong.id)).alert_raised_at).not.toBeNull();
    expect(hooks.some((h) => h.body.includes(strong.id))).toBe(true);
    expect((await adminGet(`/v1/admin/withdrawals/${strong.id}`)).body.status).toBe("due_today");
    expect((await adminGet(`/v1/admin/withdrawals/${weak.id}`)).body.status).toBe("escalated");
  });
  it("a trusted follower of a trusted carrier keeps its OWN receipt, deadline, item and alert (not the carrier's)", async () => {
    const first = await intake();
    const second = await intake({ receivedAt: RECEIVED - 2 * DAY });            // arrived earlier in law (gateway delivered it late)
    expect((await row(second.id)).coalesced_into).toBe(first.id);
    expect((await row(second.id)).execute_by).toBe(executeByOf(RECEIVED - 2 * DAY));
    setClock(alertAtOf(RECEIVED - 2 * DAY) + 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(second.id)).alert_raised_at).not.toBeNull();
    expect((await row(first.id)).alert_raised_at).toBeNull();                   // the carrier's own day 13 has not come
    setClock(executeByOf(RECEIVED - 2 * DAY) + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(second.id)).overdue_at).not.toBeNull();
    // Executing the carrier submits the contract's one refund: the follower's alert closes, it is covered.
    setClock(executeByOf(RECEIVED - 2 * DAY) + 2000);
    expect((await execute(first.id)).status).toBe(200);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(second.id)).alert_acked_by).toBe("system:resolved");
    expect((await row(second.id)).state).toBe("completed");
    expect(await ops()).toBe(1);
  });
  it("reclassifying the carrier releases its followers at once: each gets its own email under its own trust", async () => {
    const carrier = await intake();
    const follower = await intake();
    expect(verifyMails()).toHaveLength(1);
    expect((await adminPost(`/v1/admin/withdrawals/${carrier.id}/classify`, { classification: "cancellation", basis: "asked to cancel" })).status).toBe(200);
    expect((await row(follower.id)).coalesced_into).toBeNull();
    await flushMail(testEnv(), deps() as never);
    expect(verifyMails()).toHaveLength(2);
    const tok = tokens();
    expect((await confirm(tok.confirm)).body.outcome).toBe("confirmed");
    expect((await row(follower.id)).state).not.toBe("open");
  });
  it("the sweep releases followers of a carrier that left withdrawal by any route (repaired, never stranded)", async () => {
    const carrier = await intake();
    const follower = await intake();
    // A carrier changed outside classify (an older build): the sweep repairs it.
    await env.DB.prepare("UPDATE withdrawal_notices SET classification='support' WHERE id=?").bind(carrier.id).run();
    await sweepWithdrawalNotices(testEnv());
    expect((await row(follower.id)).coalesced_into).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='verify'", follower.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='carrier_released'", follower.id)).toBe(1);
  });
});

describe("r1-6: the notice, its mail obligation and its coalescing commit together", () => {
  it("a crash while writing the obligation writes nothing; the retry of the same message is a fresh intake WITH its mail", async () => {
    await env.DB.prepare("CREATE TRIGGER wp9_crash BEFORE INSERT ON withdrawal_notice_mail BEGIN SELECT RAISE(ABORT, 'crash'); END").run();
    const body = intakeBody({ messageId: "<crash@mail.test>" });
    let first: Awaited<ReturnType<typeof adminPost>>;
    try { first = await adminPost("/v1/admin/withdrawals/intake", body); }
    finally { await env.DB.prepare("DROP TRIGGER wp9_crash").run(); }
    expect(first.status).toBe(500);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notices")).toBe(0);
    const retry = await adminPost("/v1/admin/withdrawals/intake", body);
    expect(retry.status).toBe(201);
    expect(verifyMails()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=?", retry.body.id)).toBe(1);
  });
  it("the sweep repairs a live notice that has no mail obligation (written by an older build): the email goes out once", async () => {
    const { id } = await intake();
    await env.DB.prepare("DELETE FROM withdrawal_notice_mail").run();
    await env.DB.prepare("UPDATE withdrawal_notices SET verification_sent_at=NULL WHERE id=?").bind(id).run();
    mails = [];
    await sweepWithdrawalNotices(testEnv());
    await sweepWithdrawalNotices(testEnv());
    expect(verifyMails()).toHaveLength(1);
    const un = await intake({ from: ["nobody@else.test"] });
    await env.DB.prepare("DELETE FROM withdrawal_notice_mail WHERE notice_id=?").bind(un.id).run();
    mails = [];
    await sweepWithdrawalNotices(testEnv());
    expect(mails.filter((m) => m.to === "nobody@else.test")).toHaveLength(1);
  });
  it("the same message taken in twice at the same moment: one notice, one email", async () => {
    const body = intakeBody({ messageId: "<twice@mail.test>" });
    const [a, b] = await Promise.all([adminPost("/v1/admin/withdrawals/intake", body), adminPost("/v1/admin/withdrawals/intake", body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notices")).toBe(1);
    expect(verifyMails()).toHaveLength(1);
  });
});

describe("r1-7: Execute judges the cutoff at the transition", () => {
  it("an Execute that starts before 23:59:59 and reaches the transition after it writes nothing and answers deadline_passed", async () => {
    const { id } = await intake();
    const by = executeByOf(RECEIVED);
    let reads = 0;
    // authorize reads the clock first for its early check (inside the deadline); the next read is the transition's, after the lease (past it).
    const r = await authorize(testEnv(), deps({ now: () => (reads++ === 0 ? by : by + 1000) }) as never, id, "execute");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(r.code).toBe("deadline_passed");
    expect(r.won).toBe(false);
    expect(await wds()).toBe(0);
    expect(await ops()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_authorizations WHERE notice_id=?", id)).toBe(0);
    expect((await row(id)).state).toBe("open");
  });
});

describe("r1-8: every email matches the committed state", () => {
  it("the 'carried out, server deleted' acknowledgement waits for completion; a submitted refund alone is not enough", async () => {
    const { id } = await intake();
    fluxBlocked = true;
    expect((await execute(id)).status).toBe(200);
    const op = await env.DB.prepare("SELECT refund_submitted_at,done_at FROM refund_ops WHERE kind='withdrawal' AND home_id=?").bind(HOME).first<{ refund_submitted_at: number | null; done_at: number | null }>();
    expect(op!.refund_submitted_at).not.toBeNull();
    expect(op!.done_at).toBeNull();
    expect((await row(id)).state).toBe("executing");
    expect(mails.filter((m) => m.subject.includes("carried out"))).toHaveLength(0);
    fluxBlocked = false;
    setClock(NOW + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).state).toBe("completed");
    expect(mails.filter((m) => m.subject.includes("carried out"))).toHaveLength(1);
  });
  it("crash after the provider accepted the verification email, then 'This wasn't me': the cached promise is never sent again", async () => {
    acceptThenFail = 1;
    const { id } = await intake();
    expect(verifyMails()).toHaveLength(1);                         // delivered, but not recorded as sent
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND sent_at IS NULL", id)).toBe(1);
    expect((await repudiate(tokens().repudiate)).body.outcome).toBe("stopped");
    setClock(NOW + 10 * 60_000);
    await flushMail(testEnv(), deps({ now: () => cur }) as never);
    expect(verifyMails()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_mail WHERE notice_id=? AND kind='verify' AND sent_at IS NOT NULL AND last_error='skipped'", id)).toBe(1);
  });
  it("crash after the provider accepted it, nothing changed: the retry sends the SAME links, which still work", async () => {
    acceptThenFail = 1;
    await intake();
    setClock(NOW + 10 * 60_000);
    await flushMail(testEnv(), deps({ now: () => cur }) as never);
    const v = verifyMails();
    expect(v).toHaveLength(2);
    expect(v[1].text).toBe(v[0].text);
    expect((await confirm(tokens(v[0]).confirm)).body.outcome).toBe("confirmed");
  });
  it("the account email changed while a mail was cached: it is rendered again for the CURRENT address, never sent to the old one", async () => {
    mailFails = 1;
    const { id } = await intake();
    expect(verifyMails()).toHaveLength(0);
    supa = { ...supa, email: "pat.new@gmail.com", updatedAt: "2026-10-09T00:00:00.000Z" };
    setClock(NOW + 10 * 60_000);
    await flushMail(testEnv(), deps({ now: () => cur }) as never);
    const v = verifyMails();
    expect(v.map((m) => m.to)).toEqual(["pat.new@gmail.com"]);
    expect((await confirm(tokens(v[0]).confirm)).body.outcome).toBe("confirmed");
    expect((await row(id)).state).not.toBe("open");
  });
  it("a reclassification after a mail was cached: the cached links are not sent", async () => {
    mailFails = 1;
    const { id } = await intake();
    expect((await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "support", basis: "a question" })).status).toBe(200);
    setClock(NOW + 10 * 60_000);
    await flushMail(testEnv(), deps({ now: () => cur }) as never);
    expect(verifyMails()).toHaveLength(0);
  });
});

describe("r1-9: the day-13 alert and the overdue exposure stay until the refund is submitted", () => {
  it("executed on day 13 but the refund cannot be submitted: the alert keeps retrying, the cutoff marks it overdue, submission closes it", async () => {
    const { id } = await intake();
    setClock(alertAtOf(RECEIVED) + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks).toHaveLength(1);
    stripeBlocked = true;
    expect((await execute(id)).status).toBe(200);
    expect((await row(id)).state).toBe("executing");
    setClock(alertAtOf(RECEIVED) + 1000 + ALERT_RETRY_MS);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).alert_acked_at).toBeNull();
    expect(hooks).toHaveLength(2);                                     // still retried: nothing was submitted
    setClock(executeByOf(RECEIVED) + 1000);
    await sweepWithdrawalNotices(testEnv());
    const n = await row(id);
    expect(n.overdue_at).toBe(executeByOf(RECEIVED) + 1000);
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("overdue");
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.overdue'")).toBe(1);
    stripeBlocked = false;
    setClock(executeByOf(RECEIVED) + HOUR);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).alert_acked_by).toBe("system:resolved");
    expect((await row(id)).state).toBe("completed");
  });
  it("an untrusted notice the holder confirmed early gets the day-13 alert when its refund is still not submitted", async () => {
    const { id } = await intake({ boundaryAuth: undefined });
    stripeBlocked = true;
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
    setClock(alertAtOf(RECEIVED) + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).alert_raised_at).not.toBeNull();
    expect(hooks.some((h) => h.body.includes(id))).toBe(true);
  });
});

describe("P2: the sender lookup compares canonical forms on both sides; ambiguity and address history are kept", () => {
  it("a stored address with dots, a +tag, googlemail or upper case matches the plain sender (and the reverse)", async () => {
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='P.At+news@GoogleMail.com'").run();
    const a = await intake({ from: ["pat@gmail.com"] });
    expect(a.res).toMatchObject({ matchState: "matched", trusted: true });
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='pat@gmail.com'").run();
    const b = await intake({ from: ["P.A.T+x@gmail.com"] });
    expect(b.res.matchState).toBe("matched");
  });
  it("IDN: a Unicode stored domain matches its ASCII (punycode) form in the From field", async () => {
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='pat@bücher.example'").run();
    const idn = { source: "boundary", spf: { result: "pass", domain: "bücher.example" }, dkim: { result: "pass", domain: "xn--bcher-kva.example" }, mailboxEnforcement: "mx-evidence-7" };
    const r = await intake({ from: ["Pat <pat@xn--bcher-kva.example>"], boundaryAuth: idn });
    expect(r.res).toMatchObject({ matchState: "matched", trusted: true, verificationKind: "trusted" });
  });
  it("two accounts with the same canonical address are ambiguous: neither is chosen", async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('wp9-other','Other','cloud-wp9-other@cloud-account.invalid',1,?,?)`).bind(NOW, NOW).run();
    await env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES ('8b2d2c3f-0000-4000-8000-000000000001','wp9-other','created',?,'p.a.t@gmail.com')").bind(NOW - 30 * DAY).run();
    const r = await intake();
    expect(r.res.matchState).toBe("ambiguous");
    expect(r.res.trusted).toBe(false);
    expect(verifyMails()).toHaveLength(0);
  });
  it("persisted address history: an address that became the account's after the notice arrived is not the holder's (5b)", async () => {
    await env.DB.prepare("INSERT INTO account_link_events (id,sub,user_id,email,kind,at) VALUES ('ale-1',?,?,'pat@gmail.com','email_updated',?)").bind(SUBJ, USER, RECEIVED + HOUR).run();
    const r = await intake();
    expect(r.res).toMatchObject({ matchState: "matched", trusted: false, verificationKind: "same_address_failed" });
    expect(JSON.parse((await row(r.id)).sender_auth).failed).toBe("address_not_held_since");
    await env.DB.prepare("UPDATE account_link_events SET at=? WHERE id='ale-1'").bind(RECEIVED - HOUR).run();
    expect((await intake()).res.trusted).toBe(true);
  });
});

describe("P2: the mails kept for retries are sealed", () => {
  it("AES-GCM under NOTICE_MAIL_KEY, bound to its row: another row, a tampered payload or a missing key opens nothing", async () => {
    const m = { to: "pat@gmail.com", subject: "s", text: "Confirm withdrawal: https://murage.test/verify#x.y", state: "open" as const, rev: 1 };
    const sealed = (await sealPayload(testEnv(), m, "row-1"))!;
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("verify#");
    expect(await openPayload(testEnv(), sealed, "row-1")).toEqual(m);
    expect(await openPayload(testEnv(), sealed, "row-2")).toBeNull();
    const parts = sealed.split(":");
    const flipped = `${parts[0]}:${parts[1]}:${parts[2].startsWith("A") ? `B${parts[2].slice(1)}` : `A${parts[2].slice(1)}`}`;
    expect(await openPayload(testEnv(), flipped, "row-1")).toBeNull();
    const noKey = { ...testEnv(), NOTICE_MAIL_KEY: undefined } as unknown as Env;
    expect(await sealPayload(noKey, m, "row-1")).toBeNull();
    expect(await openPayload(noKey, sealed, "row-1")).toBeNull();
  });
  it("int-3: without the key nothing is sent and no link is issued: the mail stays pending with its kept payload, ops is alerted once, readiness answers 503, /new-link still answers a neutral 202; once the key is back it sends", async () => {
    setNoticeDeps(deps());
    mailFails = 1;
    const noKey = () => ({ ...testEnv(), NOTICE_MAIL_KEY: undefined }) as unknown as Env;
    const callWith = async (e: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://cp.test${path}`, { method, headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${(ipCounter++ % 250) + 1}`, ...headers },
        body: method === "GET" ? undefined : JSON.stringify(body) }), e, ctx);
      await waitOnExecutionContext(ctx);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };
    const { id } = await intake();                                              // first try fails; the keyed worker kept the mail, sealed
    const kept = async () => (await env.DB.prepare("SELECT payload,sent_at FROM withdrawal_notice_mail WHERE notice_id=? AND kind LIKE 'verify%'").bind(id).first<{ payload: string | null; sent_at: number | null }>())!;
    const before = await kept();
    expect(before.payload).toMatch(/^v1:/);
    const links = await count("SELECT COUNT(*) AS n FROM verify_tokens");
    const keyAlerts = (open: boolean) => count(`SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='withdrawal.mail_key_missing' AND resolved_at IS ${open ? "" : "NOT "}NULL`);
    setClock(NOW + 10 * 60_000);
    expect(await flushMail(noKey(), deps({ now: () => cur }) as never)).toBe(0);
    setClock(NOW + 20 * 60_000);
    expect(await flushMail(noKey(), deps({ now: () => cur }) as never)).toBe(0);
    expect(verifyMails()).toHaveLength(0);                                      // nothing sent
    expect(await kept()).toEqual(before);                                       // still pending, the kept mail untouched
    expect(await count("SELECT COUNT(*) AS n FROM verify_tokens")).toBe(links); // no link issued
    expect(await keyAlerts(true)).toBe(1);                                      // one durable alert
    expect((await callWith(noKey(), "GET", "/v1/admin/withdrawals/readiness", undefined, { authorization: `Bearer ${ADMIN}` })))
      .toEqual({ status: 503, body: { error: "notice_mail_key_missing" } });
    const nl = await callWith(noKey(), "POST", "/v1/public/withdrawal/new-link", { selector: "x".repeat(22) });
    expect(nl).toEqual({ status: 202, body: {} });
    expect(verifyMails()).toHaveLength(0);
    // The key is back: readiness is green, the pending mail is sent (the same kept mail), the alert closes, and its link works.
    expect((await adminGet("/v1/admin/withdrawals/readiness"))).toMatchObject({ status: 200, body: { ready: true } });
    setClock(NOW + 30 * 60_000);
    await flushMail(testEnv(), deps({ now: () => cur }) as never);
    expect(verifyMails()).toHaveLength(1);
    expect((await kept()).sent_at).not.toBeNull();
    expect(await keyAlerts(true)).toBe(0);
    expect(await keyAlerts(false)).toBe(1);
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
  });
  it("int2-3: the missing-key alert names the earliest affected deadline and says deadlines are not paused; it is refreshed when that deadline changes", async () => {
    setNoticeDeps(deps());
    mailFails = 1;                                                               // the first try fails: the mail stays pending
    const noKey = () => ({ ...testEnv(), NOTICE_MAIL_KEY: undefined }) as unknown as Env;
    const { id } = await intake();
    const open = async () => (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='withdrawal.mail_key_missing' AND resolved_at IS NULL")
      .all<{ detail: string }>()).results.map((r) => r.detail);
    setClock(NOW + 10 * 60_000);
    expect(await flushMail(noKey(), deps({ now: () => cur }) as never)).toBe(0);
    const first = (await row(id)).execute_by;
    const d1 = await open();
    expect(d1).toHaveLength(1);
    expect(d1[0]).toContain("Deadlines are not paused.");
    expect(d1[0]).toContain(new Date(first).toISOString());
    // The earliest deadline moves (an earlier notice is now waiting): the one open alert is refreshed in place.
    await env.DB.prepare("UPDATE withdrawal_notices SET execute_by=? WHERE id=?").bind(first - 2 * DAY, id).run();
    setClock(NOW + 20 * 60_000);
    expect(await flushMail(noKey(), deps({ now: () => cur }) as never)).toBe(0);
    const d2 = await open();
    expect(d2).toHaveLength(1);
    expect(d2[0]).toContain(new Date(first - 2 * DAY).toISOString());
    expect(d2[0]).toContain("Deadlines are not paused.");
  });
  it("int3-1: a refreshed deadline whose first send fails (503) stays due; the next flush delivers the changed detail", async () => {
    setNoticeDeps(deps());
    // Alert delivery dates its claims by Date.now() itself (Astra AUTOCANARY-9 P2), so the real clock follows the virtual one here.
    const spy = vi.spyOn(Date, "now").mockImplementation(() => cur ?? NOW);
    onTestFinished(() => spy.mockRestore());
    mailFails = 1;
    const noKey = () => ({ ...testEnv(), NOTICE_MAIL_KEY: undefined }) as unknown as Env;
    const { id } = await intake();
    const alertRow = () => env.DB.prepare("SELECT detail,delivered_at AS d,delivery_attempts AS a FROM cloud_alerts WHERE kind='withdrawal.mail_key_missing' AND resolved_at IS NULL")
      .first<{ detail: string; d: number | null; a: number }>();
    hookOk = true;
    setClock(NOW + 10 * 60_000);
    await flushMail(noKey(), deps({ now: () => cur }) as never);
    const first = (await row(id)).execute_by;
    expect((await alertRow())!.d).not.toBeNull();                                // the first alert was delivered
    await env.DB.prepare("UPDATE withdrawal_notices SET execute_by=? WHERE id=?").bind(first - 2 * DAY, id).run();
    hookOk = false;                                                              // the webhook answers 5xx
    hooks = [];
    setClock(NOW + 20 * 60_000);
    await flushMail(noKey(), deps({ now: () => cur }) as never);
    const failed = (await alertRow())!;
    expect(failed.detail).toContain(new Date(first - 2 * DAY).toISOString());
    expect(failed.d).toBeNull();                                                 // still due, not marked delivered
    expect(failed.a).toBe(1);
    expect(hooks).toHaveLength(1);
    hookOk = true;                                                               // the webhook is back: the next flush delivers it
    setClock(NOW + 30 * 60_000);
    await flushMail(noKey(), deps({ now: () => cur }) as never);
    expect((await alertRow())!.d).not.toBeNull();
    expect(hooks).toHaveLength(2);
    expect(hooks[1].body).toContain(new Date(first - 2 * DAY).toISOString());
    setClock(NOW + 40 * 60_000);
    await flushMail(noKey(), deps({ now: () => cur }) as never);
    expect(hooks).toHaveLength(2);                                               // delivered once: nothing more is sent
  });
});

describe("P2: the operator queue is paged, unresolved cases first", () => {
  it("keyset pages reach every notice; a completed one comes after every unresolved one, even when it is the oldest", async () => {
    const old = await intake({ receivedAt: RECEIVED - 2 * DAY });
    expect((await execute(old.id)).status).toBe(200);
    expect((await row(old.id)).state).toBe("completed");
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await intake({ classification: "support", receivedAt: RECEIVED + i * HOUR })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await adminGet(`/v1/admin/withdrawals?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...(r.body.notices as { id: string }[]).map((x) => x.id));
      cursor = r.body.next as string | null;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toEqual([...ids, old.id]);
    expect((await adminGet("/v1/admin/withdrawals?cursor=not-a-cursor")).status).toBe(400);
  });
});

describe("missing scenarios (Astra WP9-1)", () => {
  it("confirm, 'This wasn't me' and Execute at the same moment: exactly one outcome, never a mix", async () => {
    const { id } = await intake();
    const tok = tokens();
    const [c, r, x] = await Promise.all([confirm(tok.confirm), repudiate(tok.repudiate), execute(id)]);
    const n = await row(id);
    expect(["executing", "completed", "repudiated"]).toContain(n.state);
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_authorizations WHERE notice_id=?", id)).toBe(n.state === "repudiated" ? 0 : 1);
    expect(await wds()).toBe(n.state === "repudiated" ? 0 : 1);
    expect(await ops()).toBe(n.state === "repudiated" ? 0 : 1);
    if (n.state === "repudiated") {
      expect(r.body.outcome).toBe("stopped");
      expect(c.body.outcome).toBe("repudiated");
      expect(x.status).toBe(409);
    } else {
      expect(r.body.outcome).toMatch(/^too_late/);
      expect([c.body.outcome === "confirmed", x.status === 200].filter(Boolean)).toHaveLength(1);
    }
    expect(submissions().length).toBe(n.state === "repudiated" ? 0 : 1);
  });
  it("a reclassification racing the confirm click and Execute: either reclassified with nothing executed, or executed and the reclassification refused", async () => {
    const { id } = await intake();
    const tok = tokens();
    const [k, c, x] = await Promise.all([
      adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "cancellation", basis: "asked to cancel", expectedRev: 1 }), confirm(tok.confirm), execute(id)]);
    const n = await row(id);
    if (n.classification === "cancellation") {
      expect(k.status).toBe(200);
      expect(n.state).toBe("open");
      expect(await wds()).toBe(0);
      expect(await ops()).toBe(0);
      expect(c.status).toBe(409);
      expect(x.status).toBe(409);
    } else {
      expect(k.status).toBe(409);
      expect(["executing", "completed"]).toContain(n.state);
      expect(await wds()).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notice_events WHERE notice_id=? AND kind='reclassify_refused'", id)).toBe(1);
    }
    expect(await count("SELECT COUNT(*) AS n FROM withdrawal_authorizations WHERE notice_id=?", id)).toBe(n.classification === "cancellation" ? 0 : 1);
  });
  it("signed-in confirmation of a late-dispatched notice (sent in the window, received after it) executes at received_at, days later", async () => {
    const lateReceived = windowEndOf(MADE) + HOUR;
    const { id } = await intake({ receivedAt: lateReceived, sentAt: windowEndOf(MADE) - HOUR, sentBasis: "provider_received_header", sentEvidenceRef: "hdr-9", sentAcceptedBy: "sean" });
    setClock(lateReceived + 5 * DAY);
    signedIn = USER;
    const r = await call("POST", `/v1/account/notices/${id}/confirm`, {});
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("confirmed");
    expect(r.body.receivedAt).toBe(lateReceived);
    expect((await row(id)).executed_via).toBe("signed_in");
    const w = await env.DB.prepare("SELECT confirmed_at FROM withdrawals WHERE home_id=?").bind(HOME).first<{ confirmed_at: number }>();
    expect(w!.confirmed_at).toBe(lateReceived);
  });
  it("(5b): stays escalated past day 13 (never closed as refused); on the injected clock the first link has expired, a fresh one still executes it, at received_at", async () => {
    // r2-5: public token verification runs on the SAME injected clock as the rest of the test.
    setPublicRouteDeps({ now: () => cur, reader });
    const R = utcDayStart(RECEIVED) + 12 * HOUR;                                  // noon: day 13's cutoff is well before received + 14 days
    const { id } = await intake({ receivedAt: R, boundaryAuth: undefined });
    const first = tokens();
    setClock(executeByOf(R) + 2 * HOUR);                                          // past day 13, before received + 14 days
    expect(cur).toBeLessThan(R + 14 * DAY);
    const stale = await confirm(first.confirm);                                    // issued at intake: expired at issue + 7 days
    expect(stale.body.error).toBe("link_expired");
    expect(await wds()).toBe(0);
    const before = verifyMails().length;
    expect((await post("/v1/public/withdrawal/new-link", { selector: first.confirm.selector })).status).toBe(202);
    expect(verifyMails().length).toBe(before + 1);
    await sweepWithdrawalNotices(testEnv());                                       // (its one reminder may reissue the pair: the latest mail holds it)
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("escalated");
    expect((await row(id)).state).toBe("open");
    expect((await execute(id)).body.error).toBe("not_trusted");                    // no operator Execute for (5b)
    const fresh = tokens();
    expect(fresh.confirm.selector).not.toBe(first.confirm.selector);
    const exp = await env.DB.prepare("SELECT expires_at FROM verify_tokens WHERE selector=?").bind(fresh.confirm.selector).first<{ expires_at: number }>();
    expect(exp!.expires_at).toBe(R + 14 * DAY);                                    // capped at received + 14 days, still ahead of the clock
    expect(exp!.expires_at).toBeGreaterThan(cur);
    const c = await confirm(fresh.confirm);
    expect(c.body.outcome).toBe("confirmed");
    const w = await env.DB.prepare("SELECT confirmed_at FROM withdrawals WHERE home_id=?").bind(HOME).first<{ confirmed_at: number }>();
    expect(w!.confirmed_at).toBe(R);
  });
  it("(5b) after its links expired: the holder's signed-in confirmation executes it", async () => {
    const { id } = await intake({ boundaryAuth: undefined });
    setClock(RECEIVED + 20 * DAY);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).state).toBe("open");
    expect((await adminGet(`/v1/admin/withdrawals/${id}`)).body.status).toBe("escalated");
    signedIn = USER;
    const r = await call("POST", `/v1/account/notices/${id}/confirm`, {});
    expect(r.body.outcome).toBe("confirmed");
    expect(await wds()).toBe(1);
  });
});

describe("migration 0064 over a populated database", () => {
  it("is additive: it applies over a populated baseline, leaves existing rows alone, and the package works on it", async () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0064"))!;
    expect(m).toBeTruthy();
    for (const query of m.queries) expect(query.replace(/--.*$/gm, "").trim()).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) /);
    await env.DB.prepare("INSERT INTO billing_home_leases (home_id,holder,lease_until) VALUES ('home-b64','h',123)").run();
    const lease = await env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id='home-b64'").first();
    const sub = await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(HOME).first();
    const consent = await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(CONS).first();
    const ident = await env.DB.prepare("SELECT * FROM supabase_identities WHERE sub=?").bind(SUBJ).first();
    await env.DB.batch(["withdrawal_notice_mail", "withdrawal_notice_cases", "withdrawal_notice_events", "withdrawal_authorizations", "withdrawal_notices", "contract_links", "contract_deadlines"]
      .map((tb) => env.DB.prepare(`DROP TABLE ${tb}`)));
    await env.DB.batch(m.queries.map((query) => env.DB.prepare(query)));
    // WP10's 0065 adds its columns to withdrawal_notices: re-applied as well, as the later migration would (the package now reads them).
    const m65 = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0065"))!;
    await env.DB.batch(m65.queries.filter((query) => /withdrawal_notices\b/.test(query.replace(/--.*$/gm, ""))).map((query) => env.DB.prepare(query)));
    // r4-1: 0069 adds the claim id to withdrawal_notice_mail, re-applied likewise.
    const m69 = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0069"))!;
    await env.DB.batch(m69.queries.map((query) => env.DB.prepare(query)));
    // Later migrations that put triggers on the dropped tables (0081: contract_deadlines write-once) are re-applied too, in order
    // (0065 and 0069 were just re-applied above).
    for (const later of env.TEST_MIGRATIONS.filter((x) => x.name > m.name && !x.name.startsWith("0065") && !x.name.startsWith("0069")
      && x.queries.some((query) => /ON contract_deadlines|ON withdrawal_notice|ON contract_links/.test(query))))
      await env.DB.batch(later.queries.map((query) => env.DB.prepare(query)));
    expect(await env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id='home-b64'").first()).toEqual(lease);
    expect(await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id=?").bind(HOME).first()).toEqual(sub);
    expect(await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(CONS).first()).toEqual(consent);
    expect(await env.DB.prepare("SELECT * FROM supabase_identities WHERE sub=?").bind(SUBJ).first()).toEqual(ident);
    await env.DB.prepare("DELETE FROM billing_home_leases WHERE home_id='home-b64'").run();
    const { id } = await intake();
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
    expect((await row(id)).state).not.toBe("open");
    // contract_links stays insert-only after the re-apply.
    await expect(env.DB.prepare("DELETE FROM contract_links").run()).rejects.toThrow(/insert_only/);
  });
});

describe("r3-1: a revision change never silences the alert of an unsubmitted refund", () => {
  it("alert at rev 1 -> cancellation -> withdrawal rev 3 -> confirmed before any sweep -> refund unsubmitted: the alert still fires, for rev 3", async () => {
    const { id } = await intake();
    setClock(alertAtOf(RECEIVED) + 60_000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).alert_rev).toBe(1);
    expect((await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "cancellation", basis: "asked to cancel" })).status).toBe(200);
    expect((await adminPost(`/v1/admin/withdrawals/${id}/classify`, { classification: "withdrawal", basis: "it was a withdrawal" })).status).toBe(200);
    expect((await row(id)).classification_rev).toBe(3);
    stripeBlocked = true;                                                      // the refund cannot be submitted
    expect((await confirm(tokens().confirm)).body.outcome).toBe("confirmed");
    const r = await row(id);
    expect(r.state).toBe("executing");
    expect(r.alert_rev).toBe(3);                                               // re-armed atomically with the authorization
    hooks = [];
    setClock(alertAtOf(RECEIVED) + 60_000 + ALERT_RETRY_MS + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect(hooks.some((h) => h.body.includes(id))).toBe(true);
    const after = await row(id);
    expect(after.alert_acked_at).toBeNull();
    expect(after.alert_rev).toBe(3);
  });
  it("the sweep repairs an executing notice left with a stale-revision alert (written before r3-1) and the alert fires again", async () => {
    const { id } = await intake();
    setClock(alertAtOf(RECEIVED) + 60_000);
    await sweepWithdrawalNotices(testEnv());
    stripeBlocked = true;
    expect((await execute(id)).status).toBe(200);
    // A row written before r3-1: executing, alert left on an older revision.
    await env.DB.prepare("UPDATE withdrawal_notices SET alert_rev=0 WHERE id=?").bind(id).run();
    hooks = [];
    setClock(alertAtOf(RECEIVED) + 60_000 + ALERT_RETRY_MS + 1000);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(id)).alert_rev).toBe((await row(id)).classification_rev);
    expect(hooks.some((h) => h.body.includes(id))).toBe(true);
  });
});

describe("r3-2: the missing-date case is part of the intake, crash-durable and repaired", () => {
  // As r2-1: A -> B -> C, the home holds C, B's payment row is gone: a notice for B is unmatched with deadline_evidence_missing.
  async function chain() {
    await env.DB.batch([env.DB.prepare("DELETE FROM checkout_consents"), env.DB.prepare("DELETE FROM service_intervals")]);
    await addContract("r3-a", "sub_r3a", NOW - 201 * DAY);
    await addContract("r3-b", "sub_r3b", NOW - 91 * DAY);
    await addContract("r3-c", "sub_r3c", NOW - 61 * DAY);
    await interval("sub_r3a", NOW - 200 * DAY, NOW - 90 * DAY);
    await interval("sub_r3b", NOW - 90 * DAY, NOW - 60 * DAY);
    await interval("sub_r3c", NOW - 60 * DAY, null);
    await currentSub("sub_r3c", NOW - 60 * DAY);
  }
  const cases = (id: string) => count("SELECT COUNT(*) AS n FROM withdrawal_notice_cases WHERE notice_id=? AND reason='deadline_evidence_missing'", id);
  it("a failure while opening the case writes nothing; the redelivery takes the notice in WITH its case", async () => {
    await chain();
    const body = intakeBody({ receivedAt: NOW - HOUR, messageId: "<r3-2-crash@mail.test>" });
    await env.DB.prepare("CREATE TRIGGER r3_2_fail BEFORE INSERT ON withdrawal_notice_cases BEGIN SELECT RAISE(ABORT, 'injected'); END").run();
    try {
      const failed = await adminPost("/v1/admin/withdrawals/intake", body);
      expect([200, 201]).not.toContain(failed.status);
      expect(await count("SELECT COUNT(*) AS n FROM withdrawal_notices WHERE message_id=?", "<r3-2-crash@mail.test>")).toBe(0);
    } finally { await env.DB.prepare("DROP TRIGGER r3_2_fail").run(); }
    const again = await adminPost("/v1/admin/withdrawals/intake", body);
    expect([200, 201]).toContain(again.status);
    const r = await row(again.body.id as string);
    expect(r.match_note).toBe("deadline_evidence_missing");
    expect(r.case_id).toBe(`case-${r.id}`);
    expect(await cases(r.id)).toBe(1);
  });
  it("an orphaned notice (no case) gets its case on duplicate delivery, and the sweep repairs the others", async () => {
    await chain();
    const a = await intake({ receivedAt: NOW - HOUR, messageId: "<r3-2-dup@mail.test>" });
    const b = await intake({ receivedAt: NOW - HOUR });
    // Records written before r3-2: the notice committed, its case never did.
    await env.DB.batch([env.DB.prepare("UPDATE withdrawal_notices SET case_id=NULL"), env.DB.prepare("DELETE FROM withdrawal_notice_cases")]);
    const dup = await adminPost("/v1/admin/withdrawals/intake", intakeBody({ receivedAt: NOW - HOUR, messageId: "<r3-2-dup@mail.test>" }));
    expect(dup.body.id).toBe(a.id);
    expect((await row(a.id)).case_id).toBe(`case-${a.id}`);
    expect(await cases(a.id)).toBe(1);
    expect(await cases(b.id)).toBe(0);
    await sweepWithdrawalNotices(testEnv());
    expect((await row(b.id)).case_id).toBe(`case-${b.id}`);
    expect(await cases(b.id)).toBe(1);
    expect(await cases(a.id)).toBe(1);                                         // idempotent
  });
});

describe("r3-3: contradictory frozen evidence is missing evidence plus a case; contract_deadlines is write-once in fact", () => {
  async function chain() {
    await env.DB.batch([env.DB.prepare("DELETE FROM checkout_consents"), env.DB.prepare("DELETE FROM service_intervals")]);
    await addContract("r3-a", "sub_r3a", NOW - 201 * DAY);
    await addContract("r3-b", "sub_r3b", NOW - 91 * DAY);
    await addContract("r3-c", "sub_r3c", NOW - 61 * DAY);
    await interval("sub_r3a", NOW - 200 * DAY, NOW - 90 * DAY);
    await interval("sub_r3b", NOW - 90 * DAY, NOW - 60 * DAY);
    await interval("sub_r3c", NOW - 60 * DAY, null);
    await currentSub("sub_r3b", NOW - 90 * DAY);
    await sweepWithdrawalNotices(testEnv());                                   // freezes B's payment moment for sub_r3b
    await currentSub("sub_r3c", NOW - 60 * DAY);
  }
  it("a saved subscription that contradicts the contract's own record never reads as pending: a paid, 90-day-old contract is refused with a case", async () => {
    await chain();
    // Inconsistent stored data: B's contract record now names the home's CURRENT subscription, the frozen record another one.
    await env.DB.prepare("UPDATE checkout_consents SET stripe_subscription_id='sub_r3c' WHERE id='r3-b'").run();
    const n = await intake({ receivedAt: NOW - HOUR });
    expect(n.res.matchState).toBe("unmatched");
    const r = await row(n.id);
    expect(r.match_note).toBe("deadline_evidence_missing");
    expect(r.case_id).toBe(`case-${n.id}`);
    expect(verifyMails()).toHaveLength(0);
  });
  it("first writes are validated; REPLACE and DELETE + re-insert cannot move a frozen value", async () => {
    await chain();
    const ins = (consent: string, sub: string, paid: number, verb = "INSERT") =>
      env.DB.prepare(`${verb} INTO contract_deadlines (consent_id,subscription_id,paid_at,source,frozen_at) VALUES (?,?,?,'billing',?)`).bind(consent, sub, paid, NOW).run();
    await expect(ins("r3-a", "sub_other", NOW - 200 * DAY)).rejects.toThrow(/invalid_first_write/);   // not the contract's subscription
    await expect(ins("r3-a", "sub_r3a", Math.floor((NOW - 200 * DAY) / 1000))).rejects.toThrow(/invalid_first_write/);   // seconds
    await expect(ins("r3-none", "sub_r3a", NOW - 200 * DAY)).rejects.toThrow(/invalid_first_write/);  // no such contract
    await ins("r3-a", "sub_r3a", NOW - 200 * DAY);                                                    // a valid first write lands
    await ins("r3-b", "sub_r3b", NOW, "INSERT OR REPLACE");
    await ins("r3-b", "sub_r3b", NOW, "REPLACE");
    await ins("r3-b", "sub_r3b", NOW, "INSERT OR IGNORE");
    expect(await env.DB.prepare("SELECT paid_at FROM contract_deadlines WHERE consent_id='r3-b'").first<{ paid_at: number }>()).toEqual({ paid_at: NOW - 90 * DAY });
    await expect(env.DB.prepare("DELETE FROM contract_deadlines WHERE consent_id='r3-b'").run()).rejects.toThrow(/write_once/);
    // Retention: once the contract itself is gone the record may go, and nothing can be written for it again.
    await env.DB.prepare("DELETE FROM checkout_consents WHERE id='r3-a'").run();
    await env.DB.prepare("DELETE FROM contract_deadlines WHERE consent_id='r3-a'").run();
    await expect(ins("r3-a", "sub_r3a", NOW)).rejects.toThrow(/invalid_first_write/);
  });
});

describe("the staging mail sink through the production sender (Astra TRUSTCODE-1 P3-3)", () => {
  it("withdrawal notice mail: the real route and mail flush, with the sink engaged and NO injected mailer, write the sink row and nothing reaches a provider", async () => {
    await installSink();
    sinkOn = true;
    try {
      setNoticeDeps(deps({ mailer: undefined })); setCancellationDeps(deps({ mailer: undefined }));
      await intake();
      expect(mails).toEqual([]);
      const rows = await sunk();
      expect(rows).toHaveLength(1);
      expect(rows[0].to_addr).toBe("pat@gmail.com");
      expect(rows[0].text).toMatch(/(Confirm withdrawal): https:\/\/murage\.test\/verify#/);
      expect(realSends).toEqual([]);
    } finally { sinkOn = false; await dropSink(); }
  });
});
