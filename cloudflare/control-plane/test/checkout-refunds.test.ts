// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP3: the refund ledger carries the six new kinds; submitted is kept apart from succeeded; direct refunds go through a
// credit note, Managed Payments through POST /v1/refunds; one op id, one refund; never more than was paid. Real workerd + D1, Stripe is a fake.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireHomeLease, releaseHomeLease } from "../src/billing-lease";
import { recordExternalRefunds, stubFluxHooks, type BillingNotifier } from "../src/b5-billing";
import { advanceRefundOp, applyRefundEvent, getRefundOp, markAttributionUnresolved, reconcileAttributionHolds, reconcileRefundSubmissions, refundOpInsert, sweepRefundOps, type RefundContext, type RefundKind } from "../src/legal-refunds";
import { refundLine, refundState } from "../src/refund-kinds";
import { purgeRefundIdentity } from "../src/refund-identity";
import { StripeError, stripeClient, type StripeClient, type StripeFetch } from "../src/b5-stripe";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const OWNER = "wp3-owner";
const HOME = "wp3-home";
const IMAGE = `sha256:${"a".repeat(64)}`;

type Json = Record<string, unknown>;
interface FakeRefund { id: string; amount: number; status: string; payment_intent: string; metadata: Record<string, string>; presentment_details?: Json; created?: number }
interface FakeNote { id: string; status: string; invoice: string; amount: number; refund: string | null; metadata: Record<string, string>; created?: number;
  refunds?: string[]; refundTotal?: number | null }
// r1: a hook run inside createCreditNote (before or after the note exists at Stripe), and a listing that fails.
let beforeNote: (() => Promise<void>) | null; let afterNote: (() => Promise<void>) | null; let listNotesFails: boolean;
let refunds: FakeRefund[]; let notes: FakeNote[]; let calls: { op: string; key?: string; input?: Json }[];
let refundStatus: string; let notesWithoutRefund: boolean; let invoices: Record<string, { id: string; amount_paid: number; tax: number; payment_intent: string | null }>;
let notices: { kind: string; data: Json }[];
let ctxNow: number;

function fakeStripe(): StripeClient {
  const byKey = new Map<string, unknown>();
  const once = <T>(key: string | undefined, make: () => T): T => { if (key && byKey.has(key)) return byKey.get(key) as T; const v = make(); if (key) byKey.set(key, v); return v; };
  const mkRefund = (pi: string, amount: number, metadata: Record<string, string>): FakeRefund => {
    const r: FakeRefund = { id: `re_${refunds.length + 1}`, amount, status: refundStatus, payment_intent: pi, metadata, created: Math.floor(ctxNow / 1000) };
    if (refundStatus === "succeeded") r.presentment_details = { presentment_amount: Math.round(amount * 0.92), presentment_currency: "eur" };
    refunds.push(r); return r;
  };
  return {
    getInvoice: async (id: string) => { calls.push({ op: "getInvoice", input: { id } }); return invoices[id]; },
    listRefunds: async (pi: string) => ({ data: refunds.filter((r) => r.payment_intent === pi) }),
    getRefund: async (id: string) => refunds.find((r) => r.id === id)!,
    createRefund: async (i: { paymentIntent: string; amountCents?: number; reason?: string; opId?: string; submission?: number }, key: string) => {
      calls.push({ op: "POST /v1/refunds", key, input: i as unknown as Json });
      return once(key, () => mkRefund(i.paymentIntent, i.amountCents ?? 0, { op_id: i.opId ?? "", submission: String(i.submission ?? ""), reason: i.reason ?? "" }));
    },
    listCreditNotes: async (invoiceId: string, opts?: { opId?: string }) => {
      calls.push({ op: "listCreditNotes", input: { invoiceId, opId: opts?.opId ?? null } });
      if (listNotesFails) throw new Error("credit_notes_incomplete");
      return { data: notes.filter((n) => n.invoice === invoiceId) };
    },
    getCreditNote: async (id: string) => notes.find((n) => n.id === id)!,
    createCreditNote: async (i: { invoiceId: string; amountCents: number; opId: string; submission: number }, key: string) => {
      calls.push({ op: "POST /v1/credit_notes", key, input: i as unknown as Json });
      if (beforeNote) { const f = beforeNote; beforeNote = null; await f(); }
      const made = once(key, () => {
        const r = notesWithoutRefund ? null : mkRefund(invoices[i.invoiceId].payment_intent!, i.amountCents, {});
        const n: FakeNote = { id: `cn_${notes.length + 1}`, status: "issued", invoice: i.invoiceId, amount: i.amountCents, refund: r?.id ?? null,
          metadata: { op_id: i.opId, submission: String(i.submission) }, created: Math.floor(ctxNow / 1000) };
        notes.push(n); return n;
      });
      if (afterNote) { const f = afterNote; afterNote = null; await f(); }
      return made;
    },
  } as unknown as StripeClient;
}
const notifier: BillingNotifier = { notify: async (_e, n) => { notices.push({ kind: n.kind, data: n.data }); } };
const ctx = (stripe: StripeClient): RefundContext => ({ stripe, flux: stubFluxHooks, deps: { notifier }, now: ctxNow });
const row = (id: string) => env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first<Record<string, unknown>>();
const alerts = async (kind: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=?").bind(kind).first<{ n: number }>())!.n;

async function open(id: string, kind: RefundKind, o: { invoice?: string; paid?: number; path?: "direct" | "mp"; frozen?: { cutoverAt: number; oldInvoiceId: string; oldPeriodStart: number; oldPeriodEnd: number };
  paymentIntent?: string } = {}) {
  const [sql, binds] = refundOpInsert({ id, kind, homeId: HOME, userId: OWNER, invoiceId: o.invoice ?? "in_1", paidCents: o.paid ?? null, endPlan: false, paymentIntent: o.paymentIntent,
    detail: { path: o.path ?? "mp" }, subscriptionId: "sub_x", inheritSubscription: false, frozen: o.frozen }, NOW);
  await env.DB.prepare(sql).bind(...(binds ?? [])).run();
}

/** The state a crash after the note was made leaves: the intent (submission 1, its time) was written durably BEFORE the note (Astra WP3-3 #1). */
const submittedBeforeCrash = (id: string) => env.DB.prepare("UPDATE refund_ops SET submission=1, submitted_at=? WHERE id=?").bind(NOW + 3 * DAY, id).run();

beforeEach(async () => {
  refunds = []; notes = []; calls = []; notices = []; refundStatus = "succeeded"; notesWithoutRefund = false; ctxNow = NOW + 5 * DAY;
  beforeNote = null; afterNote = null; listNotesFails = false;
  invoices = { in_1: { id: "in_1", amount_paid: 4900, tax: 800, payment_intent: "pi_1" }, in_old: { id: "in_old", amount_paid: 4900, tax: 800, payment_intent: "pi_old" },
    in_2: { id: "in_2", amount_paid: 9900, tax: 1600, payment_intent: "pi_2" } };
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'P', 'wp3@example.test',1,?,?)`).bind(OWNER, NOW, NOW),
    env.DB.prepare(`INSERT OR IGNORE INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(HOME, "inst-wp3", OWNER, IMAGE, NOW, NOW),
    env.DB.prepare(`INSERT OR IGNORE INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,?,?,'starter','active',?,?)`)
      .bind(HOME, "cus_wp3", "sub_new", NOW, NOW),
  ]);
});

describe("WP3 every kind decides, submits and records refund_submitted_at apart from succeeded", () => {
  for (const kind of ["mismatch", "country_paused", "rejected_consent", "cancellation_late"] as const) {
    it(`${kind}: refunds the whole invoice (amount_paid, tax included) once, on Managed Payments with POST /v1/refunds`, async () => {
      await open(`op-${kind}`, kind);
      const done = await advanceRefundOp(env, ctx(fakeStripe()), `op-${kind}`);
      expect(done).toMatchObject({ kind, amount_cents: 4900, paid_cents: 4900, invoice_id: "in_1", payment_intent: "pi_1", refund_submitted_at: NOW + 5 * DAY,
        stripe_refund_status: "succeeded", refunded_at: NOW + 5 * DAY });
      expect(done!.done_at).not.toBeNull();
      expect(calls.filter((c) => c.op === "POST /v1/refunds")).toEqual([{ op: "POST /v1/refunds", key: `refundop:op-${kind}:1`,
        input: { paymentIntent: "pi_1", amountCents: 4900, reason: kind, opId: `op-${kind}`, submission: 1 } }]);
      expect(calls.some((c) => c.op === "POST /v1/credit_notes")).toBe(false);
      expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
    });
  }

  it("cutover: old invoice x unused fraction from the FROZEN values only (the invoice named in the op is not the one used)", async () => {
    await open("op-cut", "cutover", { invoice: "in_2", frozen: { cutoverAt: NOW + 10 * DAY, oldInvoiceId: "in_old", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY } });
    const done = await advanceRefundOp(env, ctx(fakeStripe()), "op-cut");
    expect(done).toMatchObject({ kind: "cutover", invoice_id: "in_old", paid_cents: 4900, amount_cents: 3267, cutover_at: NOW + 10 * DAY, old_invoice_id: "in_old",
      old_period_start: NOW, old_period_end: NOW + 30 * DAY });
    expect(refunds.map((r) => [r.payment_intent, r.amount])).toEqual([["pi_old", 3267]]);
  });

  it("extraordinary: pro rata from frozen values", async () => {
    await open("op-ext", "extraordinary", { invoice: "in_2", paid: 9900, frozen: { cutoverAt: NOW + 15 * DAY, oldInvoiceId: "in_2", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY } });
    expect(await advanceRefundOp(env, ctx(fakeStripe()), "op-ext")).toMatchObject({ amount_cents: 4950 });
    expect(refunds.map((r) => r.amount)).toEqual([4950]);
  });

  it("cutover without its frozen values waits, calls nothing at Stripe, and never guesses (ops hears after 3 tries)", async () => {
    await open("op-cut0", "cutover");
    const s = ctx(fakeStripe());
    for (let i = 0; i < 3; i++) { await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-cut0'").run(); await advanceRefundOp(env, s, "op-cut0"); }
    const r = (await row("op-cut0"))!;
    expect(r).toMatchObject({ decided_at: null, done_at: null, last_error: "frozen_values_missing", attempts: 3 });
    expect(refunds).toHaveLength(0);
    expect(await alerts("refund.stuck")).toBe(1);
  });
});

describe("WP3 states: submitted, succeeded, failed", () => {
  it("a refund Stripe has accepted but not finished is 'sent', not 'processed': refund_submitted_at set, refunded_at empty, case open", async () => {
    refundStatus = "pending";
    await open("op-pend", "mismatch");
    const op = await advanceRefundOp(env, ctx(fakeStripe()), "op-pend");
    expect(op).toMatchObject({ refund_submitted_at: NOW + 5 * DAY, stripe_refund_status: "pending", refunded_at: null, done_at: null });
    expect(refundState(op!, "mp").status).toBe("sent");
    expect(refundLine(op!, "en", "mp")).toContain("sent to your payment provider on");
    expect(notices).toHaveLength(0); // "refunded" is not announced before Stripe says succeeded
  });

  it("the later refund.updated(succeeded) completes it, keeps the submitted date, and the line becomes 'processed'", async () => {
    refundStatus = "pending";
    await open("op-pend2", "country_paused");
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-pend2");
    refunds[0].status = "succeeded";
    ctxNow = NOW + 7 * DAY;
    const lease = (await acquireHomeLease(env, HOME, "t"))!;
    const out = await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "succeeded", opId: "op-pend2", submission: "1", paymentIntent: "pi_1" });
    expect(out).toBe("refund_status_recorded");
    const op = (await getRefundOp(env, "op-pend2"))!;
    expect(op).toMatchObject({ refund_submitted_at: NOW + 5 * DAY, stripe_refund_status: "succeeded" });
    expect(op.done_at).not.toBeNull();
    expect(refundState(op, "mp")).toMatchObject({ status: "processed" });
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
  });

  it("failed refund: ops alert, the case stays open, the date is cleared and the line says delayed; the retry uses the next submission", async () => {
    refundStatus = "failed";
    await open("op-fail", "rejected_consent");
    const stripe = fakeStripe();
    const op = await advanceRefundOp(env, ctx(stripe), "op-fail");
    expect(op).toMatchObject({ done_at: null, refund_submitted_at: null, stripe_refund_status: "failed", stripe_refund_id: null, refunded_at: null });
    expect(refundLine(op!, "en", "mp")).toBe("Your refund: delayed; we are trying again.");
    expect(await alerts("refund.failed")).toBe(1);
    // Stripe works again: the next try submits submission 2 and completes.
    refundStatus = "succeeded";
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-fail'").run();
    const again = await advanceRefundOp(env, ctx(stripe), "op-fail");
    expect(again).toMatchObject({ stripe_refund_status: "succeeded", submission: 2 });
    expect(again!.done_at).not.toBeNull();
    expect(calls.filter((c) => c.op === "POST /v1/refunds").map((c) => c.key)).toEqual(["refundop:op-fail:1", "refundop:op-fail:2"]);
  });

  it("a refund that Stripe cancels later reopens a finished operation and alerts (existing failure handling covers the new kinds)", async () => {
    await open("op-late-fail", "mismatch");
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-late-fail");
    const lease = (await acquireHomeLease(env, HOME, "t2"))!;
    refunds[0].status = "canceled";
    const out = await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "canceled", opId: "op-late-fail", submission: "1", paymentIntent: "pi_1" });
    expect(out).toBe("refund_reopened");
    expect(await row("op-late-fail")).toMatchObject({ done_at: null, refunded_at: null, refund_submitted_at: null, stripe_refund_status: "canceled" });
    expect(await alerts("refund.failed")).toBe(1);
  });

  it("the presentment amount, the refund object and the tax portion are recorded", async () => {
    await open("op-pres", "mismatch");
    await advanceRefundOp(env, ctx(fakeStripe()), "op-pres");
    const j = JSON.parse(String((await row("op-pres"))!.presentment_json)) as Json;
    expect(j).toMatchObject({ requestedUsdCents: 4900, refundId: "re_1", status: "succeeded", taxCents: 800, presentment: { presentment_amount: 4508, presentment_currency: "eur" } });
  });
});

describe("WP3 direct path: credit note (Stripe Tax reversal)", () => {
  it("a direct refund is a credit note, not POST /v1/refunds; the note's refund is followed", async () => {
    await open("op-dir", "mismatch", { path: "direct" });
    const done = await advanceRefundOp(env, ctx(fakeStripe()), "op-dir");
    expect(calls.filter((c) => c.op.startsWith("POST"))).toEqual([{ op: "POST /v1/credit_notes", key: "creditnote:op-dir:1",
      input: { invoiceId: "in_1", amountCents: 4900, opId: "op-dir", submission: 1 } }]);
    expect(done).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1", refund_submitted_at: NOW + 5 * DAY, stripe_refund_status: "succeeded", amount_cents: 4900 });
    expect(done!.done_at).not.toBeNull();
  });

  it("a credit note whose refund id is not there yet is 'sent' and picked up on the next pass without a second credit note", async () => {
    notesWithoutRefund = true;
    await open("op-dir2", "cutover", { path: "direct", frozen: { cutoverAt: NOW + 15 * DAY, oldInvoiceId: "in_2", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY } });
    const stripe = fakeStripe();
    const first = await advanceRefundOp(env, ctx(stripe), "op-dir2");
    expect(first).toMatchObject({ credit_note_id: "cn_1", done_at: null, refund_submitted_at: NOW + 5 * DAY, stripe_refund_id: null });
    expect(first!.amount_cents).toBe(4950);
    notes[0].refund = mkLater();
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-dir2'").run();
    const second = await advanceRefundOp(env, ctx(stripe), "op-dir2");
    expect(second!.done_at).not.toBeNull();
    expect(notes).toHaveLength(1);
    function mkLater() { refunds.push({ id: "re_late", amount: 4950, status: "succeeded", payment_intent: "pi_2", metadata: {} }); return "re_late"; }
  });

  it("a credit note made before a crash is found by its op id and reused: never a second credit note", async () => {
    notes.push({ id: "cn_prior", status: "issued", invoice: "in_1", amount: 4900, refund: null, metadata: { op_id: "op-crash", submission: "1" } });
    refunds.push({ id: "re_prior", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} }); notes[0].refund = "re_prior";
    await open("op-crash", "mismatch", { path: "direct" });
    await submittedBeforeCrash("op-crash");
    const done = await advanceRefundOp(env, ctx(fakeStripe()), "op-crash");
    expect(calls.filter((c) => c.op.startsWith("POST"))).toEqual([]);
    expect(done).toMatchObject({ credit_note_id: "cn_prior", stripe_refund_id: "re_prior" });
    expect(done!.done_at).not.toBeNull();
  });

  it("a failed credit-note refund alerts ops and keeps the case open, and a retry never issues a second credit note", async () => {
    refundStatus = "failed";
    await open("op-dirfail", "rejected_consent", { path: "direct" });
    const stripe = fakeStripe();
    const first = await advanceRefundOp(env, ctx(stripe), "op-dirfail");
    expect(first).toMatchObject({ done_at: null, stripe_refund_status: "failed", credit_note_id: "cn_1" });
    expect(await alerts("refund.failed")).toBe(1);
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-dirfail'").run();
    await advanceRefundOp(env, ctx(stripe), "op-dirfail");
    expect(notes).toHaveLength(1);
    expect((await row("op-dirfail"))!.done_at).toBeNull();
  });
});

describe("WP3 idempotent and never more than was paid", () => {
  it("the op id is the idempotency key: opening twice and advancing twice gives one refund", async () => {
    await open("op-once", "cancellation_late"); await open("op-once", "cancellation_late");
    const stripe = fakeStripe();
    await Promise.all([advanceRefundOp(env, ctx(stripe), "op-once"), advanceRefundOp(env, ctx(stripe), "op-once")]);
    await advanceRefundOp(env, ctx(stripe), "op-once");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops WHERE id='op-once'").first<{ n: number }>())!.n).toBe(1);
    expect(refunds).toHaveLength(1);
  });

  it("several kinds against one invoice add up to at most what was paid (the ledger of the invoice)", async () => {
    await open("op-a", "cutover", { frozen: { cutoverAt: NOW + 15 * DAY, oldInvoiceId: "in_1", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY } });
    await open("op-b", "mismatch");
    await open("op-c", "cancellation_late");
    const stripe = fakeStripe();
    await sweepRefundOps(env, ctx(stripe));
    const total = (await env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id='in_1'").first<{ n: number }>())!.n;
    expect(total).toBe(4900);
    expect(refunds.reduce((n, r) => n + r.amount, 0)).toBe(4900);
    expect((await env.DB.prepare("SELECT decided_cents FROM refund_invoice_ledger WHERE invoice_id='in_1'").first<{ decided_cents: number }>())!.decided_cents).toBe(4900);
  });
});

describe("WP3 Stripe client: credit notes", () => {
  it("createCreditNote posts the invoice, the gross amount as the refund, and the op id; the idempotency key is the op's", async () => {
    const seen: { url: string; body: string; key: string | null }[] = [];
    const fetcher: StripeFetch = async (input, init) => {
      seen.push({ url: String(input), body: String(init?.body), key: new Headers(init?.headers as HeadersInit).get("idempotency-key") });
      return new Response(JSON.stringify({ id: "cn_9", status: "issued", invoice: "in_1", amount: 3267, refunds: [{ refund: "re_9", amount_refunded: 3267 }], metadata: { op_id: "op-x" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, fetcher);
    const note = await client.createCreditNote({ invoiceId: "in_1", amountCents: 3267, opId: "op-x", submission: 1 }, "creditnote:op-x:1");
    expect(note).toMatchObject({ id: "cn_9", refund: "re_9", amount: 3267 });
    expect(seen[0].url).toBe("https://api.stripe.com/v1/credit_notes");
    expect(seen[0].key).toBe("creditnote:op-x:1");
    const form = new URLSearchParams(seen[0].body);
    expect(form.get("invoice")).toBe("in_1");
    expect(form.get("amount")).toBe("3267");
    expect(form.get("refund_amount")).toBe("3267");
    expect(form.get("metadata[op_id]")).toBe("op-x");
  });
});

describe("WP3 Test 7 rerun pieces: the purge", () => {
  it("purges refund-identity keys of payments older than 24 months and keeps newer ones", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO refund_identity_keys (kind,key_hash,user_id,home_id,invoice_id,paid_at,created_at,norm,key_version) VALUES ('card',?, 'u','h','in_ancient',?,?,0,1)`)
        .bind("a".repeat(64), NOW - 800 * DAY, NOW - 800 * DAY),
      env.DB.prepare(`INSERT INTO refund_identity_keys (kind,key_hash,user_id,home_id,invoice_id,paid_at,created_at,norm,key_version) VALUES ('card',?, 'u','h','in_recent',?,?,0,1)`)
        .bind("b".repeat(64), NOW - 100 * DAY, NOW - 100 * DAY),
    ]);
    expect(await purgeRefundIdentity(env, NOW)).toBe(1);
    const left = await env.DB.prepare("SELECT invoice_id FROM refund_identity_keys ORDER BY invoice_id").all<{ invoice_id: string }>();
    expect(left.results.map((r) => r.invoice_id)).toEqual(["in_recent"]);
  });
});

// ---- Astra WP3-1 (round 1): one reproduction per finding, then the rules the review listed as untested ------------------------------------
const ledgerCents = async (inv: string) => (await env.DB.prepare("SELECT decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(inv).first<{ decided_cents: number }>())?.decided_cents ?? 0;
const externalOps = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='external'").first<{ n: number }>())!.n;
const paidOut = () => refunds.filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((n, r) => n + r.amount, 0);
const expireLease = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id=?").bind(HOME).run();
async function importExternal(stripe: StripeClient) {
  const lease = (await acquireHomeLease(env, HOME, `imp-${crypto.randomUUID()}`))!;
  try { return await recordExternalRefunds(env, lease, stripe as never, { homeId: HOME, userId: OWNER, paymentIntent: "pi_1", invoiceId: "in_1", subscriptionId: "sub_x" }, ctxNow); }
  finally { await releaseHomeLease(env, lease); }
}
const half = { cutoverAt: NOW + 15 * DAY, oldInvoiceId: "in_1", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY };

describe("Astra WP3-1 #1: a credit note's refund is ours, never an external refund", () => {
  it("one 2,450¢ credit-note payout stays 2,450¢ in the ledger, and a later full-refund obligation pays the other 2,450¢", async () => {
    await open("op-half", "extraordinary", { path: "direct", frozen: half });
    const stripe = fakeStripe();
    expect(await advanceRefundOp(env, ctx(stripe), "op-half")).toMatchObject({ amount_cents: 2450, credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    expect(refunds[0].metadata).toEqual({}); // Stripe does not copy the note's metadata onto its refund
    expect(await importExternal(stripe)).toBe(0);
    expect(await externalOps()).toBe(0);
    expect(await ledgerCents("in_1")).toBe(2450);
    await open("op-rest", "mismatch");
    expect(await advanceRefundOp(env, ctx(stripe), "op-rest")).toMatchObject({ amount_cents: 2450 });
    expect(paidOut()).toBe(4900);
    expect(await ledgerCents("in_1")).toBe(4900);
  });

  it("a genuine outside refund (Dashboard) next to our credit note is still imported, exactly once", async () => {
    await open("op-half2", "extraordinary", { path: "direct", frozen: half });
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-half2");
    refunds.push({ id: "re_dash", amount: 500, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    expect(await importExternal(stripe)).toBe(1);
    expect(await importExternal(stripe)).toBe(0);
    expect(await ledgerCents("in_1")).toBe(2950);
  });

  it("a crash after the note exists but before its checkpoint: the importer finds the note by its op id, records it on the op, imports nothing", async () => {
    await open("op-crash2", "mismatch", { path: "direct" });
    afterNote = async () => { await expireLease(); };
    const stripe = fakeStripe();
    const first = (await advanceRefundOp(env, ctx(stripe), "op-crash2"))!;
    expect(first).toMatchObject({ credit_note_id: null, stripe_refund_id: null, done_at: null, amount_cents: 4900 });
    expect(notes).toHaveLength(1);
    expect(await importExternal(stripe)).toBe(0);
    expect(await externalOps()).toBe(0);
    expect(await row("op-crash2")).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    expect(calls.filter((c) => c.op === "listCreditNotes").map((c) => c.input!.invoiceId)).toContain("in_1");
    const done = await advanceRefundOp(env, ctx(stripe), "op-crash2");
    expect(done!.done_at).not.toBeNull();
    expect(notes).toHaveLength(1);
    expect(await ledgerCents("in_1")).toBe(4900);
  });

  it("an importer that cannot list the invoice's credit notes imports nothing (the event is retried)", async () => {
    await open("op-crash3", "mismatch", { path: "direct" });
    afterNote = async () => { await expireLease(); };
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-crash3");
    listNotesFails = true;
    await expect(importExternal(stripe)).rejects.toThrow();
    expect(await externalOps()).toBe(0);
    expect(await ledgerCents("in_1")).toBe(4900);
  });
});

describe("Astra WP3-1 #2: a cutover never refunds the replacement payment", () => {
  it("frozen old invoice with no payment shown yet: waits (payment_unresolved), never falls back to the op's previous payment intent", async () => {
    invoices.in_old.payment_intent = null;
    await open("op-cutpi", "cutover", { invoice: "in_2", paymentIntent: "pi_new",
      frozen: { cutoverAt: NOW + 15 * DAY, oldInvoiceId: "in_old", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY } });
    const stripe = fakeStripe();
    const waiting = (await advanceRefundOp(env, ctx(stripe), "op-cutpi"))!;
    expect(waiting).toMatchObject({ decided_at: null, last_error: "payment_unresolved", done_at: null });
    expect(refunds).toHaveLength(0);
    // The old invoice's payment becomes known: the refund goes to IT, bound to the old invoice.
    invoices.in_old.payment_intent = "pi_old";
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-cutpi'").run();
    const done = (await advanceRefundOp(env, ctx(stripe), "op-cutpi"))!;
    expect(done).toMatchObject({ invoice_id: "in_old", payment_intent: "pi_old", amount_cents: 2450 });
    expect(refunds.map((r) => [r.payment_intent, r.amount])).toEqual([["pi_old", 2450]]);
    expect(refunds.some((r) => r.payment_intent === "pi_new")).toBe(false);
  });
});

describe("Astra WP3-1 #3: credit-note discovery reads every page", () => {
  const client = (pages: (url: URL) => Response) => {
    const seen: string[] = [];
    const fetcher: StripeFetch = async (input) => { const u = new URL(String(input)); seen.push(u.search); return pages(u); };
    return { seen, c: stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, fetcher) };
  };
  const note = (i: number, opId = "op-other") => ({ id: `cn_${i}`, status: "issued", invoice: "in_1", amount: 10, refunds: [], metadata: { op_id: opId } });
  const page = (data: unknown[], hasMore: boolean) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });

  it("follows has_more / starting_after until the op's note is found behind 100 newer notes", async () => {
    const { seen, c } = client((u) => u.searchParams.get("starting_after") ? page([note(101, "op-mine")], false)
      : page(Array.from({ length: 100 }, (_, i) => note(i + 1)), true));
    const r = await c.listCreditNotes("in_1", { opId: "op-mine" });
    expect(r.data.find((n) => n.metadata.op_id === "op-mine")?.id).toBe("cn_101");
    expect(seen).toHaveLength(2);
    expect(new URLSearchParams(seen[1]).get("starting_after")).toBe("cn_100");
  });

  it("stops at the page that holds the op's note, and reads to the end to establish absence", async () => {
    const { seen, c } = client(() => page([note(1, "op-mine")], true));
    await c.listCreditNotes("in_1", { opId: "op-mine" });
    expect(seen).toHaveLength(1);
    const all = client((u) => u.searchParams.get("starting_after") === "cn_1" ? page([note(2)], false) : page([note(1)], true));
    expect((await all.c.listCreditNotes("in_1", { opId: "op-mine" })).data).toHaveLength(2);
  });

  it("a listing that cannot be completed throws, it never reads as 'no note'", async () => {
    const broken = client(() => page([], true)); // has_more with nothing to continue from
    await expect(broken.c.listCreditNotes("in_1", { opId: "op-mine" })).rejects.toMatchObject({ code: "credit_notes_incomplete" });
  });

  it("the ledger asks by its op id, and an incomplete listing never authorises a new note (the 1,225¢ obligation pays 1,225¢ once)", async () => {
    await open("op-q", "cutover", { path: "direct", frozen: { cutoverAt: NOW + 22.5 * DAY, oldInvoiceId: "in_1", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY } });
    const stripe = fakeStripe();
    // The first attempt's answer is lost after the note was made.
    afterNote = async () => { throw new Error("connection reset"); };
    expect(await advanceRefundOp(env, ctx(stripe), "op-q")).toMatchObject({ amount_cents: 1225, credit_note_id: null, done_at: null });
    expect(notes).toHaveLength(1);
    // Recovery cannot complete the listing: no new note.
    listNotesFails = true;
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-q'").run();
    expect(await advanceRefundOp(env, ctx(stripe), "op-q")).toMatchObject({ credit_note_id: null, done_at: null });
    expect(calls.filter((c) => c.op === "POST /v1/credit_notes")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "listCreditNotes").every((c) => c.input!.opId === "op-q")).toBe(true);
    // Listing works again: the existing note is found and followed.
    listNotesFails = false;
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-q'").run();
    expect((await advanceRefundOp(env, ctx(stripe), "op-q"))!.done_at).not.toBeNull();
    expect(notes).toHaveLength(1);
    expect(paidOut()).toBe(1225);
  });
});

describe("Astra WP3-1 #4: a finished refund never keeps a stale status", () => {
  it("an older 'pending' event after success leaves 'succeeded' (Stripe's current state is read under the lease)", async () => {
    await open("op-st", "mismatch");
    const stripe = fakeStripe();
    expect(await advanceRefundOp(env, ctx(stripe), "op-st")).toMatchObject({ stripe_refund_status: "succeeded" });
    const lease = (await acquireHomeLease(env, HOME, "ev1"))!;
    await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "pending", opId: "op-st", submission: "1", paymentIntent: "pi_1" });
    expect(await row("op-st")).toMatchObject({ stripe_refund_status: "succeeded", refund_status: "succeeded" });
  });

  it("a 'pending' event read while Stripe already reports success completes the operation", async () => {
    refundStatus = "pending";
    await open("op-st2", "mismatch");
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-st2");
    refunds[0].status = "succeeded";
    const lease = (await acquireHomeLease(env, HOME, "ev2"))!;
    await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "pending", opId: "op-st2", submission: "1", paymentIntent: "pi_1" });
    const op = (await row("op-st2"))!;
    expect(op).toMatchObject({ stripe_refund_status: "succeeded" });
    expect(op.done_at).not.toBeNull();
  });

  it("a genuine later failure still reopens the finished operation, even when the event that brings it is an old one", async () => {
    await open("op-st3", "mismatch");
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-st3");
    refunds[0].status = "failed";
    const lease = (await acquireHomeLease(env, HOME, "ev3"))!;
    expect(await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "pending", opId: "op-st3", submission: "1", paymentIntent: "pi_1" }))
      .toBe("refund_reopened");
    expect(await row("op-st3")).toMatchObject({ done_at: null, stripe_refund_status: "failed", refunded_at: null });
    expect(await alerts("refund.failed")).toBe(1);
  });
});

describe("Astra WP3-1 #5: recovery records Stripe's creation time, not the time it was found", () => {
  it("a refund made 48 hours before the recovery keeps its own date (Managed Payments, found by op id)", async () => {
    await open("op-rec", "mismatch");
    refunds.push({ id: "re_prior", amount: 4900, status: "pending", payment_intent: "pi_1", metadata: { op_id: "op-rec", submission: "1" }, created: (NOW + 3 * DAY) / 1000 });
    const op = await advanceRefundOp(env, ctx(fakeStripe()), "op-rec");
    expect(op).toMatchObject({ stripe_refund_id: "re_prior", refund_submitted_at: NOW + 3 * DAY });
    expect(calls.some((c) => c.op === "POST /v1/refunds")).toBe(false);
  });

  it("a credit note found by its op id is dated when Stripe made it", async () => {
    notes.push({ id: "cn_old", status: "issued", invoice: "in_1", amount: 4900, refund: null, metadata: { op_id: "op-rec2", submission: "1" }, created: (NOW + 3 * DAY) / 1000 });
    await open("op-rec2", "mismatch", { path: "direct" });
    await submittedBeforeCrash("op-rec2");
    expect(await advanceRefundOp(env, ctx(fakeStripe()), "op-rec2")).toMatchObject({ credit_note_id: "cn_old", refund_submitted_at: NOW + 3 * DAY });
  });

  it("an object found without a creation time is never stamped with the discovery time", async () => {
    notes.push({ id: "cn_nodate", status: "issued", invoice: "in_1", amount: 4900, refund: null, metadata: { op_id: "op-rec3", submission: "1" } });
    await open("op-rec3", "mismatch", { path: "direct" });
    await submittedBeforeCrash("op-rec3");
    expect(await advanceRefundOp(env, ctx(fakeStripe()), "op-rec3")).toMatchObject({ credit_note_id: "cn_nodate", refund_submitted_at: null });
  });
});

describe("Astra WP3-1 #6: migration 0060 backfills rows written before it", () => {
  const backfill = async () => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0060"))!;
    const sql = m.queries.find((x) => /^\s*UPDATE refund_ops SET/i.test(x.replace(/^(\s*--[^\n]*\n)*/, "")))!;
    expect(sql).toBeTruthy();
    await env.DB.prepare(sql).run();
  };
  const legacy = (id: string, cols: Record<string, unknown>) => {
    const names = Object.keys(cols);
    return env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,created_at,updated_at,${names.join(",")}) VALUES (?,?,?,?,?,0,?,?,${names.map(() => "?").join(",")})`)
      .bind(id, "first_month", HOME, OWNER, "in_1", NOW, NOW, ...Object.values(cols)).run();
  };

  it("copies the recorded status, never takes the intent time as the submission, and the sweep dates each refund from Stripe", async () => {
    await legacy("old-pending", { stripe_refund_id: "re_p", refund_status: "pending", submitted_at: NOW + DAY, amount_cents: 4900, decided_at: NOW });
    await legacy("old-done", { stripe_refund_id: "re_d", refund_status: "succeeded", refunded_at: NOW + 2 * DAY, done_at: NOW + 2 * DAY, amount_cents: 4900, decided_at: NOW });
    await legacy("old-none", { submitted_at: NOW + DAY, amount_cents: 4900, decided_at: NOW });
    await backfill();
    expect(await row("old-pending")).toMatchObject({ stripe_refund_status: "pending", refund_submitted_at: null, submission_reconcile: 1 });
    expect(await row("old-done")).toMatchObject({ stripe_refund_status: "succeeded", refund_submitted_at: NOW + 2 * DAY, submission_reconcile: 1 });
    expect(await row("old-none")).toMatchObject({ stripe_refund_status: null, refund_submitted_at: null, submission_reconcile: 0 });
    refunds.push({ id: "re_p", amount: 4900, status: "pending", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY + 5_000) / 1000 },
      { id: "re_d", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=? WHERE id LIKE 'old-%'").bind(NOW + 365 * DAY).run(); // only the reconciliation runs
    await sweepRefundOps(env, ctx(fakeStripe()));
    const p = (await getRefundOp(env, "old-pending"))!;
    expect(p).toMatchObject({ stripe_refund_status: "pending", refund_submitted_at: NOW + DAY + 5_000, submission_reconcile: 0 });
    expect(refundState(p, "mp")).toMatchObject({ status: "sent", date: NOW + DAY + 5_000 });
    expect(await row("old-done")).toMatchObject({ stripe_refund_status: "succeeded", refund_submitted_at: NOW + DAY, submission_reconcile: 0 });
    // Rows the WP3 code writes are never marked.
    await open("op-new", "mismatch");
    await advanceRefundOp(env, ctx(fakeStripe()), "op-new");
    expect(await row("op-new")).toMatchObject({ submission_reconcile: 0 });
  });
});

describe("WP3 rules the review listed as untested", () => {
  it("a direct refund reverses the invoice's tax with the credit note (gross amount, tax portion recorded) and never a second time", async () => {
    await open("op-tax", "extraordinary", { path: "direct", frozen: half });
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-tax");
    const notesPosted = () => calls.filter((c) => c.op === "POST /v1/credit_notes");
    expect(notesPosted().map((c) => c.input!.amountCents)).toEqual([2450]); // gross: amount_paid x fraction, tax included, never added on top
    const j = JSON.parse(String((await row("op-tax"))!.presentment_json)) as Json;
    expect(j).toMatchObject({ requestedUsdCents: 2450, taxCents: 400 }); // 800 x 2450 / 4900
    // The same op again, and a second obligation for the whole invoice: one more note for the remaining half only, never the same tax twice.
    await advanceRefundOp(env, ctx(stripe), "op-tax");
    await open("op-tax2", "mismatch", { path: "direct" });
    await advanceRefundOp(env, ctx(stripe), "op-tax2");
    await open("op-tax3", "cancellation_late", { path: "direct" });
    expect(await advanceRefundOp(env, ctx(stripe), "op-tax3")).toMatchObject({ amount_cents: 0 });
    expect(notesPosted().map((c) => c.input!.amountCents)).toEqual([2450, 2450]);
    const taxes = await env.DB.prepare("SELECT presentment_json AS p FROM refund_ops WHERE presentment_json IS NOT NULL").all<{ p: string }>();
    expect(taxes.results.reduce((n, r) => n + Number((JSON.parse(r.p) as Json).taxCents), 0)).toBe(800);
  });

  it("the lease expiring while the credit note is created records nothing; the next holder finds the note by its op id and makes no second one", async () => {
    await open("op-lease", "country_paused", { path: "direct" });
    afterNote = async () => { await expireLease(); };
    const stripe = fakeStripe();
    expect(await advanceRefundOp(env, ctx(stripe), "op-lease")).toMatchObject({ credit_note_id: null, refund_submitted_at: null, done_at: null });
    ctxNow = NOW + 6 * DAY;
    const done = (await advanceRefundOp(env, ctx(stripe), "op-lease"))!;
    expect(done).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1", refund_submitted_at: NOW + 5 * DAY });
    expect(done.done_at).not.toBeNull();
    expect(notes).toHaveLength(1);
    expect(calls.filter((c) => c.op === "POST /v1/credit_notes")).toHaveLength(1);
  });

  it("two distinct new-kind operations against one invoice, advanced concurrently, pay at most the invoice once", async () => {
    await open("op-c1", "mismatch");
    await open("op-c2", "cancellation_late");
    const stripe = fakeStripe();
    await Promise.all([advanceRefundOp(env, ctx(stripe), "op-c1"), advanceRefundOp(env, ctx(stripe), "op-c2")]);
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL").run();
    await sweepRefundOps(env, ctx(stripe));
    const ops = (await env.DB.prepare("SELECT amount_cents, done_at FROM refund_ops WHERE id IN ('op-c1','op-c2') ORDER BY id").all<{ amount_cents: number; done_at: number | null }>()).results;
    expect(ops.every((o) => o.done_at !== null)).toBe(true);
    expect(ops.map((o) => o.amount_cents).sort((a, b) => a - b)).toEqual([0, 4900]);
    expect(paidOut()).toBe(4900);
    expect(await ledgerCents("in_1")).toBe(4900);
  });
});

// ---- Astra WP3-2 (round 2): one reproduction per finding --------------------------------------------------------------------------------
/** The real client's refund listing, served page by page (newest first, Stripe's order) from the fake's refunds. */
function pagedRefunds(stripe: StripeClient, broken = false): string[] {
  const seen: string[] = [];
  const fetcher: StripeFetch = async (input) => {
    const u = new URL(String(input)); seen.push(u.search);
    if (broken) return new Response(JSON.stringify({ data: [], has_more: true }), { status: 200 });
    const all = [...refunds].filter((r) => r.payment_intent === u.searchParams.get("payment_intent")).reverse();
    const after = u.searchParams.get("starting_after");
    const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    const limit = Number(u.searchParams.get("limit"));
    return new Response(JSON.stringify({ data: all.slice(from, from + limit), has_more: from + limit < all.length }), { status: 200 });
  };
  stripe.listRefunds = stripeClient({ secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" } as never, fetcher).listRefunds;
  return seen;
}

describe("Astra WP3-2 #3: the refund listing reads every page or fails closed", () => {
  const quarter = { cutoverAt: NOW + 22.5 * DAY, oldInvoiceId: "in_1", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY };
  const lostAnswer = async (id: string) => {
    // The op's refund was made, its answer was lost, and the idempotency key has since expired at Stripe; 100 newer refunds followed it.
    refunds.push({ id: "re_old", amount: 1225, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: id, submission: "1" }, created: (NOW + DAY) / 1000 });
    for (let i = 0; i < 100; i++) refunds.push({ id: `re_new${i}`, amount: 1, status: "succeeded", payment_intent: "pi_1", metadata: {}, created: (NOW + 2 * DAY) / 1000 });
    await env.DB.prepare("UPDATE refund_ops SET submission=1, submitted_at=? WHERE id=?").bind(NOW + DAY, id).run();
  };

  it("an older payout behind 100 newer refunds is found: the 1,225¢ obligation pays 1,225¢ once, never 2,450¢", async () => {
    await open("op-cap", "cutover", { frozen: quarter });
    await lostAnswer("op-cap");
    const stripe = fakeStripe();
    const seen = pagedRefunds(stripe);
    const done = (await advanceRefundOp(env, ctx(stripe), "op-cap"))!;
    expect(done).toMatchObject({ amount_cents: 1225, stripe_refund_id: "re_old", refund_submitted_at: NOW + DAY });
    expect(done.done_at).not.toBeNull();
    expect(calls.filter((c) => c.op === "POST /v1/refunds")).toHaveLength(0);
    expect(refunds.filter((r) => r.metadata.op_id === "op-cap").reduce((n, r) => n + r.amount, 0)).toBe(1225);
    expect(seen.length).toBe(2);
    expect(new URLSearchParams(seen[1]).get("starting_after")).toBe("re_new0");
  });

  it("a listing that cannot be completed issues nothing and imports nothing", async () => {
    await open("op-cap2", "cutover", { frozen: quarter });
    await lostAnswer("op-cap2");
    const stripe = fakeStripe();
    pagedRefunds(stripe, true);
    const op = (await advanceRefundOp(env, ctx(stripe), "op-cap2"))!;
    expect(op).toMatchObject({ done_at: null, stripe_refund_id: null, attempts: 1 });
    expect(calls.filter((c) => c.op === "POST /v1/refunds")).toHaveLength(0);
    await expect(importExternal(stripe)).rejects.toMatchObject({ code: "refunds_incomplete" });
    expect(await externalOps()).toBe(0);
  });
});

describe("Astra WP3-2 #1: a credit note is ours only when a local operation matches it", () => {
  it("a foreign 500¢ note carrying our op id next to our 2,450¢ payout is imported: the ledger holds 2,950¢, the op keeps its own note", async () => {
    await open("op-own", "extraordinary", { path: "direct", frozen: half });
    const stripe = fakeStripe();
    expect(await advanceRefundOp(env, ctx(stripe), "op-own")).toMatchObject({ amount_cents: 2450, credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    refunds.push({ id: "re_f", amount: 500, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    notes.push({ id: "cn_f", status: "issued", invoice: "in_1", amount: 500, refund: "re_f", metadata: { op_id: "op-own" } });
    expect(await importExternal(stripe)).toBe(1);
    expect(await externalOps()).toBe(1);
    expect(await ledgerCents("in_1")).toBe(2950);
    expect(paidOut()).toBe(2950);
    expect(await row("op-own")).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1" });
  });

  it("a note naming another home's operation is imported here and never checkpoints that operation", async () => {
    const [sql, binds] = refundOpInsert({ id: "op-b", kind: "mismatch", homeId: "wp3-home-b", userId: OWNER, invoiceId: "in_1", endPlan: false, detail: { path: "direct" },
      subscriptionId: "sub_b", inheritSubscription: false }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    await open("op-own2", "extraordinary", { path: "direct", frozen: half });
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-own2");
    refunds.push({ id: "re_g", amount: 300, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    notes.push({ id: "cn_g", status: "issued", invoice: "in_1", amount: 300, refund: "re_g", metadata: { op_id: "op-b" } });
    expect(await importExternal(stripe)).toBe(1);
    expect(await row("op-b")).toMatchObject({ credit_note_id: null, stripe_refund_id: null });
    expect(await ledgerCents("in_1")).toBe(2750);
  });

  it("a note naming a Managed Payments operation (which never makes notes) is imported", async () => {
    await open("op-mp", "mismatch", { path: "mp" });
    refunds.push({ id: "re_h", amount: 700, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    notes.push({ id: "cn_h", status: "issued", invoice: "in_1", amount: 700, refund: "re_h", metadata: { op_id: "op-mp" } });
    expect(await importExternal(fakeStripe())).toBe(1);
    expect(await row("op-mp")).toMatchObject({ credit_note_id: null, stripe_refund_id: null });
  });
});

describe("Astra WP3-2 #5: importer recovery keeps the note's own date", () => {
  it("a note recovered by the importer dates the submission by the note, not by its refund or the discovery", async () => {
    await open("op-date", "mismatch", { path: "direct" });
    afterNote = async () => { await expireLease(); };
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-date");
    expect(notes[0].created).toBe((NOW + 5 * DAY) / 1000);
    refunds[0].created = (NOW + 5 * DAY + 3_600_000) / 1000; // Stripe made the note's refund an hour after the note
    ctxNow = NOW + 7 * DAY;
    expect(await importExternal(stripe)).toBe(0);
    expect(await row("op-date")).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1", refund_submitted_at: NOW + 5 * DAY });
    const done = (await advanceRefundOp(env, ctx(stripe), "op-date"))!;
    expect(done.done_at).not.toBeNull();
    expect(done.refund_submitted_at).toBe(NOW + 5 * DAY);
  });
});

/** Migration 0060's backfill statements (every UPDATE in it), run against rows written as the code before it wrote them. */
async function backfill0060() {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0060"))!;
  const sqls = m.queries.filter((x) => /^\s*UPDATE refund_ops SET/i.test(x.replace(/^(\s*--[^\n]*\n)*/, "")));
  expect(sqls.length).toBeGreaterThan(0);
  for (const sql of sqls) await env.DB.prepare(sql).run();
}
function legacyRow(id: string, cols: Record<string, unknown>) {
  const names = Object.keys(cols);
  return env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,created_at,updated_at,${names.join(",")}) VALUES (?,?,?,?,?,0,?,?,${names.map(() => "?").join(",")})`)
    .bind(id, "withdrawal", HOME, OWNER, "in_1", NOW, NOW, ...Object.values(cols)).run();
}

describe("Astra WP3-2 #2: a backfilled refund Stripe reports failed reopens the case", () => {
  it("done_at, refunded_at and the withdrawal's completion are cleared under the lease, ops is alerted, then the mark is cleared", async () => {
    await legacyRow("old-wd", { stripe_refund_id: "re_wd", refund_status: "succeeded", refunded_at: NOW + 2 * DAY, done_at: NOW + 2 * DAY, notified_at: NOW + 2 * DAY,
      amount_cents: 4900, decided_at: NOW, submission: 1 });
    await env.DB.prepare(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status,stripe_refund_id,refund_op_id)
      VALUES ('wd-1',?,?,'c-1',?,0,0,0,4900,'full','completed','re_wd','old-wd')`).bind(HOME, OWNER, NOW).run();
    await backfill0060();
    expect(await row("old-wd")).toMatchObject({ submission_reconcile: 1, stripe_refund_status: "succeeded" });
    refunds.push({ id: "re_wd", amount: 4900, status: "failed", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    expect(await reconcileRefundSubmissions(env, ctx(fakeStripe()))).toBe(1);
    expect(await row("old-wd")).toMatchObject({ done_at: null, refunded_at: null, stripe_refund_id: null, refund_submitted_at: null, stripe_refund_status: "failed",
      refund_status: "failed", submission_reconcile: 0, next_attempt_at: ctxNow, last_error: "refund_failed" });
    expect((await env.DB.prepare("SELECT status FROM withdrawals WHERE id='wd-1'").first<{ status: string }>())!.status).toBe("processing");
    expect(await alerts("refund.failed")).toBe(1);
  });
});

describe("Astra WP3-2 #4: Stripe's own requires_action after success reopens and polls", () => {
  it("reopens the finished operation with its refund id kept, alerts, polls, and completes again without a second refund", async () => {
    await open("op-ra", "mismatch");
    const stripe = fakeStripe();
    const first = (await advanceRefundOp(env, ctx(stripe), "op-ra"))!;
    expect(first).toMatchObject({ stripe_refund_status: "succeeded", refund_submitted_at: NOW + 5 * DAY });
    refunds[0].status = "requires_action";
    const lease = (await acquireHomeLease(env, HOME, "ev-ra"))!;
    expect(await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "requires_action", opId: "op-ra", submission: "1", paymentIntent: "pi_1" }))
      .toBe("refund_reopened");
    await releaseHomeLease(env, lease);
    expect(await row("op-ra")).toMatchObject({ done_at: null, refunded_at: null, stripe_refund_id: "re_1", stripe_refund_status: "requires_action",
      refund_submitted_at: NOW + 5 * DAY, next_attempt_at: ctxNow + 3_600_000 });
    expect(await alerts("refund.stuck")).toBe(1);
    // Polled by the sweep: still waiting, then finished at Stripe.
    ctxNow += 2 * 3_600_000;
    await sweepRefundOps(env, ctx(stripe));
    expect(await row("op-ra")).toMatchObject({ done_at: null, stripe_refund_id: "re_1", last_error: "refund_requires_action" });
    refunds[0].status = "succeeded";
    ctxNow += 2 * 3_600_000;
    await sweepRefundOps(env, ctx(stripe));
    const done = (await row("op-ra"))!;
    expect(done.done_at).not.toBeNull();
    expect(done).toMatchObject({ stripe_refund_status: "succeeded", stripe_refund_id: "re_1" });
    expect(refunds).toHaveLength(1);
    expect(calls.filter((c) => c.op === "POST /v1/refunds")).toHaveLength(1);
  });

  it("an event's requires_action that Stripe does not confirm changes nothing (the stale-status protection stays)", async () => {
    await open("op-ra2", "mismatch");
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-ra2");
    const lease = (await acquireHomeLease(env, HOME, "ev-ra2"))!;
    await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_1", status: "requires_action", opId: "op-ra2", submission: "1", paymentIntent: "pi_1" });
    const op = (await row("op-ra2"))!;
    expect(op).toMatchObject({ stripe_refund_status: "succeeded" });
    expect(op.done_at).not.toBeNull();
  });
});

describe("Astra WP3-2 #6: backfill covers cleared ids; reconciliation retries fairly and escalates", () => {
  it("a failed or canceled row whose refund id was cleared still gets its recorded status, and is not marked", async () => {
    await legacyRow("old-f", { refund_status: "failed", amount_cents: 4900, decided_at: NOW, submission: 2 });
    await legacyRow("old-c", { refund_status: "canceled", amount_cents: 4900, decided_at: NOW, submission: 1 });
    await backfill0060();
    expect(await row("old-f")).toMatchObject({ stripe_refund_status: "failed", refund_submitted_at: null, submission_reconcile: 0 });
    expect(await row("old-c")).toMatchObject({ stripe_refund_status: "canceled", refund_submitted_at: null, submission_reconcile: 0 });
  });

  it("50 refunds Stripe no longer has never starve the row behind them; they are backed off and escalated", async () => {
    for (let i = 0; i < 50; i++) {
      await legacyRow(`r404-${String(i).padStart(2, "0")}`, { stripe_refund_id: `re_gone${i}`, refund_status: "succeeded", refunded_at: NOW + DAY, done_at: NOW + DAY, amount_cents: 1, decided_at: NOW });
    }
    await legacyRow("zz-good", { stripe_refund_id: "re_good", refund_status: "pending", amount_cents: 4900, decided_at: NOW, submission: 1 });
    await backfill0060();
    refunds.push({ id: "re_good", amount: 4900, status: "pending", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    const stripe = fakeStripe();
    const base = stripe.getRefund;
    stripe.getRefund = async (id: string) => { if (id.startsWith("re_gone")) throw new StripeError(404, "stripe_resource_missing", {}); return base(id); };
    expect(await reconcileRefundSubmissions(env, ctx(stripe))).toBe(0); // the oldest 50 all miss
    expect(await row("zz-good")).toMatchObject({ submission_reconcile: 1 });
    expect(await row("r404-00")).toMatchObject({ submission_reconcile: 1, reconcile_attempts: 1, reconcile_error: "stripe_resource_missing" });
    expect(await alerts("refund.reconcile_stuck")).toBe(0);
    expect(await reconcileRefundSubmissions(env, ctx(stripe))).toBe(1); // the missing ones are backed off: the next row is reached
    expect(await row("zz-good")).toMatchObject({ submission_reconcile: 0, stripe_refund_status: "pending", refund_submitted_at: NOW + DAY });
    ctxNow += 7 * 3_600_000;
    await reconcileRefundSubmissions(env, ctx(stripe));
    // A permanent 404 is escalated after its second miss (cloud_alerts keeps one open alert per home and kind: all 50 rows share this home).
    expect(await alerts("refund.reconcile_stuck")).toBe(1);
    const a = (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='refund.reconcile_stuck'").first<{ detail: string }>())!;
    expect(JSON.parse(a.detail)).toMatchObject({ missing: true, attempts: 2, error: "stripe_resource_missing" });
    ctxNow += 7 * 3_600_000;
    await reconcileRefundSubmissions(env, ctx(stripe));
    expect(await alerts("refund.reconcile_stuck")).toBe(1); // never repeated while open; the rows are still retried
    expect(await row("r404-49")).toMatchObject({ submission_reconcile: 1, reconcile_attempts: 3 });
  });
});

// ---- Astra WP3-3 (round 3): one reproduction per finding ---------------------------------------------------------------------------------
describe("Astra WP3-3 #1: an uncheckpointed operation adopts only the note it submitted", () => {
  /** A newer foreign 500¢ note that copies the operation's whole metadata, listed first (Stripe's newest-first order). */
  const foreignNote = (opId: string) => {
    refunds.push({ id: "re_f", amount: 500, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    notes.unshift({ id: "cn_f", status: "issued", invoice: "in_1", amount: 500, refund: "re_f", metadata: { op_id: opId, submission: "1" }, created: Math.floor(ctxNow / 1000) + 60 });
  };

  it("importer: a newer 500¢ foreign note never steals the uncheckpointed 2,450¢ op; the ledger holds 2,950¢ and a later full refund pays the 1,950¢ owed", async () => {
    await open("op-steal", "extraordinary", { path: "direct", frozen: half });
    afterNote = async () => { await expireLease(); };
    const stripe = fakeStripe();
    expect(await advanceRefundOp(env, ctx(stripe), "op-steal")).toMatchObject({ amount_cents: 2450, credit_note_id: null, stripe_refund_id: null });
    foreignNote("op-steal");
    expect(await importExternal(stripe)).toBe(1); // only the foreign refund is external
    expect(await row("op-steal")).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    expect(await row("external:re_f")).toMatchObject({ amount_cents: 500 });
    expect(await ledgerCents("in_1")).toBe(2950);
    expect(paidOut()).toBe(2950);
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-steal'").run();
    expect((await advanceRefundOp(env, ctx(stripe), "op-steal"))!.done_at).not.toBeNull();
    expect(calls.filter((c) => c.op === "POST /v1/credit_notes")).toHaveLength(1);
    await open("op-rest3", "mismatch", { path: "direct" });
    expect(await advanceRefundOp(env, ctx(stripe), "op-rest3")).toMatchObject({ amount_cents: 1950 });
    expect(paidOut()).toBe(4900);
    expect(await ledgerCents("in_1")).toBe(4900);
  });

  it("direct recovery: the op follows its own 2,450¢ note, never the newer foreign one listed first", async () => {
    await open("op-steal2", "extraordinary", { path: "direct", frozen: half });
    afterNote = async () => { await expireLease(); };
    const stripe = fakeStripe();
    await advanceRefundOp(env, ctx(stripe), "op-steal2");
    foreignNote("op-steal2");
    const done = (await advanceRefundOp(env, ctx(stripe), "op-steal2"))!;
    expect(done).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1", amount_cents: 2450 });
    expect(done.done_at).not.toBeNull();
    expect(calls.filter((c) => c.op === "POST /v1/credit_notes")).toHaveLength(1);
    expect(await importExternal(stripe)).toBe(1);
    expect(await ledgerCents("in_1")).toBe(2950);
    expect(paidOut()).toBe(2950);
  });

  it("direct recovery: an intent whose note was never made is not satisfied by a foreign note: its own note is made", async () => {
    await open("op-steal3", "extraordinary", { path: "direct", frozen: half });
    beforeNote = async () => { throw new Error("connection reset"); }; // intent recorded, no note at Stripe
    const stripe = fakeStripe();
    expect(await advanceRefundOp(env, ctx(stripe), "op-steal3")).toMatchObject({ credit_note_id: null, done_at: null });
    expect(notes).toHaveLength(0);
    foreignNote("op-steal3");
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-steal3'").run();
    const done = (await advanceRefundOp(env, ctx(stripe), "op-steal3"))!;
    expect(done.credit_note_id).not.toBe("cn_f");
    expect(done.done_at).not.toBeNull();
    expect(refunds.filter((r) => r.id !== "re_f").reduce((n, r) => n + r.amount, 0)).toBe(2450);
    expect(await importExternal(stripe)).toBe(1);
    expect(await ledgerCents("in_1")).toBe(2950);
  });

  it("an uncheckpointed note with no durable submission record is never adopted", async () => {
    await open("op-nosub", "mismatch", { path: "direct" });
    await env.DB.prepare("UPDATE refund_ops SET amount_cents=4900, decided_at=? WHERE id='op-nosub'").bind(NOW).run();
    refunds.push({ id: "re_n", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    notes.push({ id: "cn_n", status: "issued", invoice: "in_1", amount: 4900, refund: "re_n", metadata: { op_id: "op-nosub", submission: "0" } });
    expect(await importExternal(fakeStripe())).toBe(1);
    expect(await row("op-nosub")).toMatchObject({ credit_note_id: null, stripe_refund_id: null });
  });
});

describe("Astra WP3-3 #2: the backfill's requires_action reopen commits whole or not at all", () => {
  it("a lease lost at the reopen leaves the row still marked for reconciliation; the next pass reopens, alerts and polls", async () => {
    await legacyRow("old-ra", { stripe_refund_id: "re_ra", refund_status: "succeeded", refunded_at: NOW + 2 * DAY, done_at: NOW + 2 * DAY, notified_at: NOW + 2 * DAY,
      amount_cents: 4900, decided_at: NOW, submission: 1 });
    await env.DB.prepare(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status,stripe_refund_id,refund_op_id)
      VALUES ('wd-ra',?,?,'c-ra',?,0,0,0,4900,'full','completed','re_ra','old-ra')`).bind(HOME, OWNER, NOW).run();
    await backfill0060();
    refunds.push({ id: "re_ra", amount: 4900, status: "requires_action", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    const stripe = fakeStripe();
    const base = stripe.getRefund;
    stripe.getRefund = async (id: string) => { const r = await base(id); await expireLease(); return r; }; // the lease is lost while Stripe answers
    expect(await reconcileRefundSubmissions(env, ctx(stripe))).toBe(0);
    const kept = (await row("old-ra"))!;
    expect(kept).toMatchObject({ submission_reconcile: 1, refund_status: "succeeded", refund_submitted_at: NOW + 2 * DAY });
    expect(kept.done_at).not.toBeNull();
    expect(await alerts("refund.stuck")).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM withdrawals WHERE id='wd-ra'").first<{ status: string }>())!.status).toBe("completed");
    stripe.getRefund = base;
    expect(await reconcileRefundSubmissions(env, ctx(stripe))).toBe(1);
    expect(await row("old-ra")).toMatchObject({ submission_reconcile: 0, done_at: null, refunded_at: null, stripe_refund_id: "re_ra", refund_status: "requires_action",
      stripe_refund_status: "requires_action", refund_submitted_at: NOW + DAY, next_attempt_at: ctxNow + 3_600_000, last_error: "refund_requires_action" });
    expect(await alerts("refund.stuck")).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM withdrawals WHERE id='wd-ra'").first<{ status: string }>())!.status).toBe("processing");
  });
});

describe("Astra WP3-3 #3: the home's reconcile alert names every stuck row", () => {
  it("A recovers while B still fails: the alert is re-delivered naming B only, and resolves when B recovers", async () => {
    await legacyRow("st-a", { stripe_refund_id: "re_sa", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1 });
    await legacyRow("st-b", { stripe_refund_id: "re_sb", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1 });
    await backfill0060();
    const gone = new Set(["re_sa", "re_sb"]);
    refunds.push({ id: "re_sa", amount: 100, status: "pending", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 },
      { id: "re_sb", amount: 100, status: "pending", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    const stripe = fakeStripe();
    const base = stripe.getRefund;
    stripe.getRefund = async (id: string) => { if (gone.has(id)) throw new StripeError(404, "stripe_resource_missing", {}); return base(id); };
    const openAlert = () => env.DB.prepare("SELECT detail,delivered_at,resolved_at FROM cloud_alerts WHERE kind='refund.reconcile_stuck'")
      .first<{ detail: string; delivered_at: number | null; resolved_at: number | null }>();
    await reconcileRefundSubmissions(env, ctx(stripe));
    ctxNow += 7 * 3_600_000;
    await reconcileRefundSubmissions(env, ctx(stripe));
    expect(JSON.parse((await openAlert())!.detail).opIds).toEqual(["st-a", "st-b"]);
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE kind='refund.reconcile_stuck'").bind(ctxNow).run(); // ops was told
    gone.delete("re_sa");
    ctxNow += 7 * 3_600_000;
    await reconcileRefundSubmissions(env, ctx(stripe));
    expect(await row("st-a")).toMatchObject({ submission_reconcile: 0 });
    const a = (await openAlert())!;
    expect(a.resolved_at).toBeNull();
    expect(a.delivered_at).toBeNull(); // the changed set is delivered again
    expect(JSON.parse(a.detail)).toMatchObject({ opIds: ["st-b"], opId: "st-b" });
    expect(await alerts("refund.reconcile_stuck")).toBe(1);
    gone.delete("re_sb");
    ctxNow += 7 * 3_600_000;
    await reconcileRefundSubmissions(env, ctx(stripe));
    expect((await openAlert())!.resolved_at).toBe(ctxNow);
  });
});

describe("Astra WP3-3 #4: transport errors go through the reconciliation's backoff", () => {
  it("six fetch TypeErrors are counted, escalate after the threshold, and never stop the healthy row behind", async () => {
    await legacyRow("a-type", { stripe_refund_id: "re_te", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1 });
    await legacyRow("z-healthy", { stripe_refund_id: "re_ok", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1 });
    await backfill0060();
    refunds.push({ id: "re_ok", amount: 100, status: "pending", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    const stripe = fakeStripe();
    const base = stripe.getRefund;
    stripe.getRefund = async (id: string) => { if (id === "re_te") throw new TypeError("fetch failed"); return base(id); };
    expect(await reconcileRefundSubmissions(env, ctx(stripe))).toBe(1);
    expect(await row("z-healthy")).toMatchObject({ submission_reconcile: 0, refund_submitted_at: NOW + DAY });
    expect(await row("a-type")).toMatchObject({ submission_reconcile: 1, reconcile_attempts: 1, reconcile_error: "stripe_transport_error" });
    for (let i = 2; i <= 6; i++) {
      expect(await alerts("refund.reconcile_stuck")).toBe(0);
      ctxNow += 7 * 3_600_000;
      await reconcileRefundSubmissions(env, ctx(stripe));
      expect(await row("a-type")).toMatchObject({ reconcile_attempts: i });
    }
    expect(await alerts("refund.reconcile_stuck")).toBe(1);
    const a = (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='refund.reconcile_stuck'").first<{ detail: string }>())!;
    expect(JSON.parse(a.detail)).toMatchObject({ opIds: ["a-type"], error: "stripe_transport_error", missing: false, attempts: 6 });
  });

  it("a response that does not decode is retried the same way", async () => {
    await legacyRow("a-dec", { stripe_refund_id: "re_dec", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1 });
    await backfill0060();
    const stripe = fakeStripe();
    stripe.getRefund = async () => { throw new SyntaxError("Unexpected token < in JSON"); };
    await reconcileRefundSubmissions(env, ctx(stripe));
    expect(await row("a-dec")).toMatchObject({ submission_reconcile: 1, reconcile_attempts: 1, reconcile_error: "stripe_decode_error" });
  });
});

// ---- Astra WP3-4 (round 4) -------------------------------------------------------------------------------------------------------------------
const quarter = { cutoverAt: NOW + 22.5 * DAY, oldInvoiceId: "in_1", oldPeriodStart: NOW, oldPeriodEnd: NOW + 30 * DAY }; // 1,225¢ of 4,900¢
const claimOf = async (objectId: string) => (await env.DB.prepare("SELECT op_id FROM refund_object_claims WHERE object_id=?").bind(objectId).first<{ op_id: string }>())?.op_id ?? null;

describe("Astra WP3-4 #1: a note or refund belongs to exactly one operation, claimed in the database", () => {
  /** B (1,225¢, submission 1) finishes on its own note; A (1,225¢, submission 1) recorded its intent but its note never reached Stripe; then B's
   *  note is edited to carry A's op id and submission. Equal amounts and equal submission numbers: metadata alone would hand B's note to A. */
  async function copiedOwnership() {
    const stripe = fakeStripe();
    await open("op-own-b", "extraordinary", { path: "direct", frozen: quarter });
    expect(await advanceRefundOp(env, ctx(stripe), "op-own-b")).toMatchObject({ amount_cents: 1225, credit_note_id: "cn_1", stripe_refund_id: "re_1", submission: 1 });
    expect(await claimOf("cn_1")).toBe("op-own-b");
    expect(await claimOf("re_1")).toBe("op-own-b");
    await open("op-own-a", "extraordinary", { path: "direct", frozen: half }); // half of 4,900¢ less B's 1,225¢: 1,225¢ owed
    beforeNote = async () => { throw new Error("connection reset"); };
    expect(await advanceRefundOp(env, ctx(stripe), "op-own-a")).toMatchObject({ amount_cents: 1225, submission: 1, credit_note_id: null, done_at: null });
    expect((await row("op-own-a"))!.submitted_at).not.toBeNull();
    notes[0].metadata = { op_id: "op-own-a", submission: "1" };
    return stripe;
  }

  it("direct recovery: A never adopts B's note; A stays pending (attribution_unresolved), ops is alerted, no second note, 1,225¢ paid once", async () => {
    const stripe = await copiedOwnership();
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-own-a'").run();
      expect(await advanceRefundOp(env, ctx(stripe), "op-own-a")).toMatchObject({ done_at: null, refunded_at: null, credit_note_id: null, stripe_refund_id: null,
        last_error: "attribution_unresolved" });
    }
    expect(notes).toHaveLength(1);
    expect(paidOut()).toBe(1225);
    expect(await claimOf("cn_1")).toBe("op-own-b");
    expect(await claimOf("re_1")).toBe("op-own-b");
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    expect((await row("op-own-b"))!.done_at).not.toBeNull();
  });

  it("importer: the same copied note is never checkpointed on A; nothing is imported, A stays pending and ops is alerted", async () => {
    const stripe = await copiedOwnership();
    refunds.push({ id: "re_dash", amount: 100, status: "succeeded", payment_intent: "pi_1", metadata: {} }); // an outside refund makes the importer read the notes
    expect(await importExternal(stripe)).toBe(1); // only the outside refund
    expect(await row("external:re_dash")).toMatchObject({ amount_cents: 100 });
    expect(await row("op-own-a")).toMatchObject({ credit_note_id: null, stripe_refund_id: null, done_at: null, last_error: "attribution_unresolved" });
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    expect(await claimOf("cn_1")).toBe("op-own-b");
    expect(await ledgerCents("in_1")).toBe(2550); // both decisions stand plus the outside 100¢; A waits for a person
    expect(paidOut()).toBe(1325);
  });

  it("a Managed Payments refund held by another operation is never counted for a second one, whatever its metadata", async () => {
    const stripe = fakeStripe();
    await open("op-mp-b", "extraordinary", { frozen: quarter });
    expect(await advanceRefundOp(env, ctx(stripe), "op-mp-b")).toMatchObject({ stripe_refund_id: "re_1" });
    await open("op-mp-a", "extraordinary", { frozen: half });
    refunds[0].metadata = { op_id: "op-mp-a", submission: "1" }; // B's refund now names A
    const a = (await advanceRefundOp(env, ctx(stripe), "op-mp-a"))!;
    expect(a).toMatchObject({ done_at: null, refunded_at: null, last_error: "attribution_unresolved" });
    expect(await claimOf("re_1")).toBe("op-mp-b");
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
  });
});

describe("Astra WP3-4 #2: a note carrying several refunds never settles a single-refund obligation", () => {
  /** A 2,450¢ operation recorded its intent (submission 1) but its own note never reached Stripe; a note carrying its op id, submission and
   *  a 2,450¢ total is split over two refunds: 500¢ succeeded and 1,950¢ failed. */
  async function splitNote() {
    const stripe = fakeStripe();
    await open("op-split", "extraordinary", { path: "direct", frozen: half });
    beforeNote = async () => { throw new Error("connection reset"); };
    expect(await advanceRefundOp(env, ctx(stripe), "op-split")).toMatchObject({ amount_cents: 2450, submission: 1, credit_note_id: null, done_at: null });
    refunds.push({ id: "re_ok", amount: 500, status: "succeeded", payment_intent: "pi_1", metadata: {} },
      { id: "re_bad", amount: 1950, status: "failed", payment_intent: "pi_1", metadata: {} });
    notes.push({ id: "cn_split", status: "issued", invoice: "in_1", amount: 2450, refund: "re_ok", refunds: ["re_ok", "re_bad"], refundTotal: 2450,
      metadata: { op_id: "op-split", submission: "1" }, created: Math.floor(ctxNow / 1000) });
    return stripe;
  }

  it("direct recovery: 500¢ succeeded + 1,950¢ failed never completes the 2,450¢ obligation; it stays pending, alerted, with no second note", async () => {
    const stripe = await splitNote();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-split'").run();
      expect(await advanceRefundOp(env, ctx(stripe), "op-split")).toMatchObject({ done_at: null, refunded_at: null, credit_note_id: null, stripe_refund_id: null,
        last_error: "attribution_unresolved" });
    }
    expect(notes).toHaveLength(1);
    expect(await claimOf("cn_split")).toBeNull();
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(0);
  });

  it("importer: the split note is neither adopted nor imported as external; the operation is held for a person", async () => {
    const stripe = await splitNote();
    expect(await importExternal(stripe)).toBe(0);
    expect(await externalOps()).toBe(0);
    expect(await row("op-split")).toMatchObject({ credit_note_id: null, stripe_refund_id: null, done_at: null, last_error: "attribution_unresolved" });
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    expect(await ledgerCents("in_1")).toBe(2450);
  });
});

describe("Astra WP3-4 #4: a failed refund leaves the home's reconcile alert in the same batch, whoever reports it", () => {
  /** A and B escalate into the home's one refund.reconcile_stuck alert (Stripe answered 404 twice for each). */
  async function twoStuck() {
    await legacyRow("fw-a", { stripe_refund_id: "re_fa", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1, submitted_at: NOW });
    await legacyRow("fw-b", { stripe_refund_id: "re_fb", refund_status: "pending", amount_cents: 100, decided_at: NOW, submission: 1, submitted_at: NOW });
    await backfill0060();
    const gone = new Set(["re_fa", "re_fb"]);
    refunds.push({ id: "re_fa", amount: 100, status: "failed", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 },
      { id: "re_fb", amount: 100, status: "pending", payment_intent: "pi_1", metadata: {}, created: (NOW + DAY) / 1000 });
    const stripe = fakeStripe();
    const base = stripe.getRefund;
    stripe.getRefund = async (id: string) => { if (gone.has(id)) throw new StripeError(404, "stripe_resource_missing", {}); return base(id); };
    await reconcileRefundSubmissions(env, ctx(stripe));
    ctxNow += 7 * 3_600_000;
    await reconcileRefundSubmissions(env, ctx(stripe));
    expect(JSON.parse((await openStuck())!.detail).opIds).toEqual(["fw-a", "fw-b"]);
    gone.delete("re_fa"); // Stripe shows A again: it failed
    return Object.assign(stripe, { gone });
  }
  const openStuck = () => env.DB.prepare("SELECT detail,resolved_at,delivered_at FROM cloud_alerts WHERE kind='refund.reconcile_stuck'")
    .first<{ detail: string; resolved_at: number | null; delivered_at: number | null }>();

  it("refund.failed webhook: A is reopened and leaves the alert, which names B only and is delivered again", async () => {
    const stripe = await twoStuck();
    const lease = (await acquireHomeLease(env, HOME, "fw-hook"))!;
    expect(await applyRefundEvent(env, { ...ctx(stripe), lease }, { id: "re_fa", status: "failed", opId: "fw-a", submission: "1", paymentIntent: "pi_1" }))
      .toBe("refund_reopened");
    await releaseHomeLease(env, lease);
    expect(await row("fw-a")).toMatchObject({ submission_reconcile: 0, stripe_refund_id: null, refund_status: "failed" });
    const a = (await openStuck())!;
    expect(a.resolved_at).toBeNull();
    expect(a.delivered_at).toBeNull();
    expect(JSON.parse(a.detail)).toMatchObject({ opIds: ["fw-b"], opId: "fw-b" });
  });

  it("when the last member's refund fails too, the alert resolves", async () => {
    const stripe = await twoStuck();
    refunds[1].status = "failed"; stripe.gone.delete("re_fb");
    const lease = (await acquireHomeLease(env, HOME, "fw-hook2"))!;
    for (const [id, opId] of [["re_fa", "fw-a"], ["re_fb", "fw-b"]]) {
      expect(await applyRefundEvent(env, { ...ctx(stripe), lease }, { id, status: "failed", opId, submission: "1", paymentIntent: "pi_1" })).toBe("refund_reopened");
    }
    await releaseHomeLease(env, lease);
    expect((await openStuck())!.resolved_at).toBe(ctxNow);
  });

  it("the operation's own pass finding the Managed Payments refund failed clears the mark and the membership together", async () => {
    const stripe = await twoStuck();
    const op = (await advanceRefundOp(env, ctx(stripe), "fw-a"))!;
    expect(op).toMatchObject({ submission_reconcile: 0, stripe_refund_id: null, done_at: null, last_error: "refund_failed" });
    expect(JSON.parse((await openStuck())!.detail)).toMatchObject({ opIds: ["fw-b"], opId: "fw-b" });
  });
});

// ---- Astra WP3-5 (round 5) -------------------------------------------------------------------------------------------------------------------
/** Migration 0070's data statements (every INSERT and UPDATE in it), run against rows written as the round-4 code wrote them. */
async function upgrade0070() {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0070"))!;
  const sqls = m.queries.filter((x) => /^\s*(INSERT|UPDATE)\b/i.test(x.replace(/^(\s*--[^\n]*\n)*/, "")));
  expect(sqls.length).toBeGreaterThan(4);
  for (const sql of sqls) await env.DB.prepare(sql).run();
}
const quarantined = (id: string) => env.DB.prepare("SELECT * FROM refund_attribution_quarantine WHERE op_id=?").bind(id).first<Record<string, unknown>>();
const attributionAlert = () => env.DB.prepare("SELECT detail,delivered_at,resolved_at FROM cloud_alerts WHERE kind='refund.attribution_unresolved' AND resolved_at IS NULL")
  .first<{ detail: string; delivered_at: number | null; resolved_at: number | null }>();
const refundedTotal = async () => (await env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE refunded_at IS NOT NULL").first<{ n: number }>())!.n;

describe("Astra WP3-5 #1: a duplicate completed before migration 0070 is quarantined, never honoured", () => {
  /** The round-4 duplicate pair: B (1,225¢) finished on its own note cn_1 / refund re_1; A, opened later, adopted the same note before claims
   *  existed and finished on it too (a double-counted payout), with its withdrawal completed. Nothing is claimed yet. */
  async function r4Duplicate(o: { aDone: boolean }) {
    const stripe = fakeStripe();
    await open("op-dup-b", "extraordinary", { path: "direct", frozen: quarter });
    expect(await advanceRefundOp(env, ctx(stripe), "op-dup-b")).toMatchObject({ amount_cents: 1225, credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    await open("op-dup-a", "extraordinary", { path: "direct", frozen: half });
    await env.DB.prepare(`UPDATE refund_ops SET created_at=?,invoice_id='in_1',payment_intent='pi_1',paid_cents=4900,amount_cents=1225,decided_at=?,canceled_at=?,submission=1,
        credit_note_id='cn_1',stripe_refund_id='re_1',refund_status='succeeded',stripe_refund_status='succeeded',refund_submitted_at=?,refunded_at=?,notified_at=?,done_at=?
      WHERE id='op-dup-a'`).bind(NOW + DAY, NOW + DAY, NOW + DAY, NOW + 2 * DAY, NOW + 2 * DAY, NOW + 2 * DAY, o.aDone ? NOW + 2 * DAY : null).run();
    await env.DB.prepare(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status,stripe_refund_id,refund_op_id)
      VALUES ('wd-dup',?,?,'c-dup',?,0,0,0,1225,'full','completed','re_1','op-dup-a')`).bind(HOME, OWNER, NOW).run();
    expect(await refundedTotal()).toBe(2450); // the double count the round-4 code left behind
    return stripe;
  }

  it("upgraded through 0070: EVERY claimant of the shared note is quarantined and held; creation order never decides (Astra WP3-6 #1)", async () => {
    const stripe = await r4Duplicate({ aDone: true });
    await env.DB.prepare("DELETE FROM refund_object_claims").run(); // the database before migration 0070
    await upgrade0070();
    // Neither the older (B) nor the newer (A) operation keeps the object: nothing in the database proves whose it is.
    expect(await claimOf("cn_1")).toBeNull();
    expect(await claimOf("re_1")).toBeNull();
    for (const id of ["op-dup-a", "op-dup-b"]) {
      expect(await row(id)).toMatchObject({ done_at: null, refunded_at: null, credit_note_id: null, stripe_refund_id: null, refund_submitted_at: null,
        attribution_hold: 1, last_error: "attribution_unresolved" });
      expect(await quarantined(id)).toMatchObject({ reason: "duplicate_object", credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    }
    expect(await quarantined("op-dup-a")).toMatchObject({ done_at: NOW + 2 * DAY });
    expect(await env.DB.prepare("SELECT status,stripe_refund_id FROM withdrawals WHERE id='wd-dup'").first()).toEqual({ status: "processing", stripe_refund_id: null });
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    expect(JSON.parse((await attributionAlert())!.detail).opIds).toEqual(expect.arrayContaining(["op-dup-a", "op-dup-b"]));
    expect(await refundedTotal()).toBe(0);
    // A held operation is never resubmitted or completed by the ledger itself.
    for (let i = 0; i < 2; i++) {
      for (const id of ["op-dup-a", "op-dup-b"]) {
        await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id=?").bind(id).run();
        expect(await advanceRefundOp(env, ctx(stripe), id)).toMatchObject({ done_at: null, refunded_at: null, attribution_hold: 1, last_error: "attribution_unresolved" });
      }
    }
    expect(notes).toHaveLength(1);
    expect(paidOut()).toBe(1225);
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
  });

  it("the leased reconciliation proves the owner by its own creation record, restores it; the other stays held for a person (Astra WP3-6 #4, WP3-7)", async () => {
    const stripe = await r4Duplicate({ aDone: true });
    await env.DB.prepare("DELETE FROM refund_object_claims").run();
    await upgrade0070();
    // B's own create call returned cn_1 for its submission 1 (refund_submission_journal) and the note carries exactly its 1,225¢ in one
    // refund: proven. A recorded a submission 1 that no journal of ours backs: whether it paid anything cannot be shown affirmatively, so it is
    // never released as "nothing" by absence (Astra WP3-7 #2) and stays held for a person.
    expect(await reconcileAttributionHolds(env, ctx(stripe))).toBe(1);
    expect(await row("op-dup-b")).toMatchObject({ attribution_hold: 0, credit_note_id: "cn_1", stripe_refund_id: "re_1", refunded_at: null, done_at: null });
    expect(await row("op-dup-a")).toMatchObject({ attribution_hold: 1, credit_note_id: null, stripe_refund_id: null });
    expect(await claimOf("cn_1")).toBe("op-dup-b");
    expect(await claimOf("re_1")).toBe("op-dup-b");
    expect((await quarantined("op-dup-b"))!.released_at).toBe(ctxNow);
    expect(JSON.parse((await attributionAlert())!.detail).opIds).toEqual(["op-dup-a"]); // B left the home's alert; A is still named
    await sweepRefundOps(env, ctx(stripe));
    expect((await row("op-dup-b"))!.done_at).not.toBeNull(); // completed on its validated own note, no second note for it
    expect(await row("op-dup-a")).toMatchObject({ attribution_hold: 1, credit_note_id: null, done_at: null });
    expect(notes).toHaveLength(1); // B's payout is never counted for A, and A is never paid again on a guess
    expect(await refundedTotal()).toBe(1225);
  });

  it("the OLDER operation that adopted a newer one's payout is quarantined with it, not preserved as owner (Astra WP3-6 #1)", async () => {
    const stripe = fakeStripe();
    // A (older, stalled) and B (newer): B made cn_1 / re_1 for itself; A recorded B's objects as its own and completed on them.
    await open("op-old-a", "extraordinary", { path: "direct", frozen: quarter });
    await env.DB.prepare("UPDATE refund_ops SET created_at=? WHERE id='op-old-a'").bind(NOW - DAY).run();
    await open("op-new-b", "extraordinary", { path: "direct", frozen: quarter });
    expect(await advanceRefundOp(env, ctx(stripe), "op-new-b")).toMatchObject({ credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    await env.DB.prepare(`UPDATE refund_ops SET invoice_id='in_1',payment_intent='pi_1',amount_cents=1225,decided_at=?,canceled_at=?,submission=1,credit_note_id='cn_1',
      stripe_refund_id='re_1',refund_status='succeeded',stripe_refund_status='succeeded',refunded_at=?,notified_at=?,done_at=? WHERE id='op-old-a'`)
      .bind(NOW, NOW, NOW + DAY, NOW + DAY, NOW + DAY).run();
    await env.DB.prepare("DELETE FROM refund_object_claims").run();
    await upgrade0070();
    expect(await row("op-old-a")).toMatchObject({ done_at: null, credit_note_id: null, attribution_hold: 1 });
    expect(await row("op-new-b")).toMatchObject({ done_at: null, credit_note_id: null, attribution_hold: 1 });
    expect(await claimOf("cn_1")).toBeNull();
    expect(notes).toHaveLength(1);
  });

  for (const aDone of [true, false]) {
    it(`at run time: a saved ${aDone ? "completion" : "success"} on an object another operation holds is quarantined, not honoured`, async () => {
      const stripe = await r4Duplicate({ aDone }); // B holds its claims (made by its own pass); A recorded the same objects without one
      const a = (await advanceRefundOp(env, ctx(stripe), "op-dup-a"))!;
      expect(a).toMatchObject({ done_at: null, refunded_at: null, credit_note_id: null, stripe_refund_id: null, attribution_hold: 1, last_error: "attribution_unresolved" });
      expect(await quarantined("op-dup-a")).toMatchObject({ reason: "claimed_elsewhere", stripe_refund_id: "re_1" });
      expect(await env.DB.prepare("SELECT status FROM withdrawals WHERE id='wd-dup'").first()).toEqual({ status: "processing" });
      expect(await claimOf("re_1")).toBe("op-dup-b");
      expect(await alerts("refund.attribution_unresolved")).toBe(1);
      expect(await refundedTotal()).toBe(1225);
      expect(notes).toHaveLength(1);
    });
  }
});

describe("Astra WP3-5 #2: a checkpointed split note never settles the operation", () => {
  /** The round-4 checkpoint of a 2,450¢ operation on a split note: cn_split and its first refund re_ok (500¢, pending) recorded on the row, its
   *  second refund re_bad (1,950¢) failed. */
  async function r4SplitCheckpoint() {
    const stripe = fakeStripe();
    await open("op-r4split", "extraordinary", { path: "direct", frozen: half });
    beforeNote = async () => { throw new Error("connection reset"); };
    expect(await advanceRefundOp(env, ctx(stripe), "op-r4split")).toMatchObject({ amount_cents: 2450, submission: 1, credit_note_id: null, done_at: null });
    refunds.push({ id: "re_ok", amount: 500, status: "pending", payment_intent: "pi_1", metadata: {} },
      { id: "re_bad", amount: 1950, status: "failed", payment_intent: "pi_1", metadata: {} });
    notes.push({ id: "cn_split", status: "issued", invoice: "in_1", amount: 2450, refund: "re_ok", refunds: ["re_ok", "re_bad"], refundTotal: 2450,
      metadata: { op_id: "op-r4split", submission: "1" }, created: Math.floor(ctxNow / 1000) });
    await env.DB.prepare(`UPDATE refund_ops SET credit_note_id='cn_split',stripe_refund_id='re_ok',refund_status='pending',stripe_refund_status='pending',refund_submitted_at=?,
      payment_intent='pi_1',last_error='refund_pending',next_attempt_at=NULL WHERE id='op-r4split'`).bind(ctxNow).run();
    await env.DB.prepare("DELETE FROM refund_object_claims").run();
    return stripe;
  }

  it("after the upgrade the 500¢ refund succeeds: the 2,450¢ operation does not complete, it is held and ops is alerted", async () => {
    const stripe = await r4SplitCheckpoint();
    await upgrade0070();
    expect(await claimOf("cn_split")).toBe("op-r4split"); // nothing conflicted: the checkpoint is its claim
    refunds.find((r) => r.id === "re_ok")!.status = "succeeded";
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-r4split'").run();
      expect(await advanceRefundOp(env, ctx(stripe), "op-r4split")).toMatchObject({ done_at: null, refunded_at: null, attribution_hold: 1,
        last_error: "attribution_unresolved" });
    }
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(0);
    expect(await refundedTotal()).toBe(0);
  });

  for (const saved of ["done_at", "refunded_at"] as const) {
    it(`a legacy ${saved} on a split note (500¢ succeeded + 1,950¢ failed of 2,450¢) never completes and sends no $24.50 notice (Astra WP3-6 #2)`, async () => {
      const stripe = await r4SplitCheckpoint();
      refunds.find((r) => r.id === "re_ok")!.status = "succeeded";
      // The round-4 code recorded the 500¢ success as the whole operation's success (and, in one variant, completed it).
      await env.DB.prepare(`UPDATE refund_ops SET refund_status='succeeded',stripe_refund_status='succeeded',refunded_at=?,submitted_at=NULL,done_at=?,notified_at=NULL
        WHERE id='op-r4split'`).bind(ctxNow, saved === "done_at" ? ctxNow : null).run();
      await upgrade0070();
      expect(await row("op-r4split")).toMatchObject({ note_reconcile: 1 });
      for (let i = 0; i < 3; i++) {
        await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-r4split'").run();
        expect(await advanceRefundOp(env, ctx(stripe), "op-r4split")).toMatchObject({ done_at: null, refunded_at: null, credit_note_id: null, attribution_hold: 1,
          note_reconcile: 0, last_error: "attribution_unresolved" });
        await sweepRefundOps(env, ctx(stripe));
      }
      expect(await quarantined("op-r4split")).toMatchObject({ reason: "note_invalid", credit_note_id: "cn_split", stripe_refund_id: "re_ok",
        refunded_at: ctxNow, done_at: saved === "done_at" ? ctxNow : null });
      expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(0);
      expect(await alerts("refund.attribution_unresolved")).toBe(1);
      expect(notes).toHaveLength(1);
      expect(await refundedTotal()).toBe(0);
      expect((await row("op-r4split"))!.attribution_hold).toBe(1); // the reconciliation cannot prove a split note either
    });
  }

  it("a legacy success on a VALID whole note is honoured once validated, and its mark is cleared", async () => {
    const stripe = fakeStripe();
    await open("op-r4ok", "extraordinary", { path: "direct", frozen: half });
    expect(await advanceRefundOp(env, ctx(stripe), "op-r4ok")).toMatchObject({ amount_cents: 2450, credit_note_id: "cn_1" });
    const done = (await row("op-r4ok"))!.done_at;
    expect(done).not.toBeNull();
    await upgrade0070();
    expect(await row("op-r4ok")).toMatchObject({ note_reconcile: 1 });
    expect(await advanceRefundOp(env, ctx(stripe), "op-r4ok")).toMatchObject({ note_reconcile: 0, done_at: done, attribution_hold: 0 });
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
  });

  it("a fresh note that does not carry the decided amount in one refund is never followed", async () => {
    const stripe = fakeStripe();
    const make = stripe.createCreditNote;
    stripe.createCreditNote = async (i, key) => ({ ...(await make(i, key)), refundTotal: 1000 });
    await open("op-short", "extraordinary", { path: "direct", frozen: half });
    expect(await advanceRefundOp(env, ctx(stripe), "op-short")).toMatchObject({ done_at: null, refunded_at: null, credit_note_id: null, attribution_hold: 1,
      last_error: "attribution_unresolved" });
    expect(notes).toHaveLength(1);
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
  });

  it("an operation the round-4 importer left attribution_unresolved is held by the upgrade and never completes", async () => {
    await legacyRow("op-r4held", { amount_cents: 100, decided_at: NOW, submission: 1, last_error: "attribution_unresolved" });
    await upgrade0070();
    expect(await row("op-r4held")).toMatchObject({ attribution_hold: 1, done_at: null });
    expect(await quarantined("op-r4held")).toMatchObject({ reason: "unresolved_before_0070" });
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-r4held'").run();
    expect(await advanceRefundOp(env, ctx(fakeStripe()), "op-r4held")).toMatchObject({ done_at: null, refunded_at: null, attribution_hold: 1 });
    expect(refunds).toHaveLength(0);
  });
});

describe("Astra WP3-5 #3: the home's attribution alert names every held operation", () => {
  it("B joins A's open alert and it is delivered again; a repeat changes nothing; A finishing leaves only B", async () => {
    await open("op-al-a", "mismatch");
    await open("op-al-b", "mismatch");
    const mark = async (id: string) => {
      const lease = (await acquireHomeLease(env, HOME, `mark-${crypto.randomUUID()}`))!;
      try { await markAttributionUnresolved(env, lease, (await getRefundOp(env, id))!, { by: "test" }, ctxNow); }
      finally { await releaseHomeLease(env, lease); }
    };
    await mark("op-al-a");
    expect(JSON.parse((await attributionAlert())!.detail)).toMatchObject({ opId: "op-al-a", opIds: ["op-al-a"] });
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=?,delivery_attempts=1 WHERE kind='refund.attribution_unresolved'").bind(ctxNow).run(); // ops was told
    ctxNow += 1000;
    await mark("op-al-b");
    let a = (await attributionAlert())!;
    expect(a.delivered_at).toBeNull(); // the new member is delivered, never suppressed by the open alert
    expect(JSON.parse(a.detail)).toMatchObject({ opId: "op-al-a", opIds: ["op-al-a", "op-al-b"] });
    expect(await alerts("refund.attribution_unresolved")).toBe(1);
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE kind='refund.attribution_unresolved'").bind(ctxNow).run();
    ctxNow += 1000;
    await mark("op-al-a"); // still the same set: no repeat delivery
    expect((await attributionAlert())!.delivered_at).not.toBeNull();
    // A person resolves A and clears its hold: A finishes and leaves the alert; B is still named.
    await env.DB.prepare("UPDATE refund_ops SET attribution_hold=0,last_error=NULL,next_attempt_at=NULL WHERE id='op-al-a'").run();
    expect((await advanceRefundOp(env, ctx(fakeStripe()), "op-al-a"))!.done_at).not.toBeNull();
    a = (await attributionAlert())!;
    expect(a.delivered_at).toBeNull();
    expect(JSON.parse(a.detail)).toMatchObject({ opId: "op-al-b", opIds: ["op-al-b"] });
    expect((await advanceRefundOp(env, ctx(fakeStripe()), "op-al-b"))!.done_at).toBeNull(); // B stays held
  });
});

describe("Astra WP3-6 #4: a held statutory refund is escalated as its legal deadline approaches, and released once provable", () => {
  it("no alert 10 days out; high at 6 days; critical at 1 day; critical and repeated when overdue; the hold clears once Stripe proves it", async () => {
    const stripe = fakeStripe();
    // A withdrawal (statutory; deadline = opened + 14 days) held because the refund naming it does not carry its amount.
    await legacyRow("op-dl", { payment_intent: "pi_1", amount_cents: 4900, decided_at: NOW, submission: 1, attribution_hold: 1, last_error: "attribution_unresolved" });
    refunds.push({ id: "re_dl", amount: 999, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: "op-dl", submission: "1" } });
    // Our own create call returned re_dl for submission 1 (Astra WP3-7 #1: the retained provenance that alone can prove it).
    await env.DB.prepare(`INSERT INTO refund_submission_journal (op_id,submission,object_kind,payment_intent,amount_cents,intent_at,intent_journaled,object_id,returned_at)
      VALUES ('op-dl',1,'refund','pi_1',4900,?,1,'re_dl',?)`).bind(NOW, NOW).run();
    const deadlineAlert = () => env.DB.prepare("SELECT severity,detail,delivered_at FROM cloud_alerts WHERE kind='refund.statutory_deadline' AND resolved_at IS NULL")
      .first<{ severity: string; detail: string; delivered_at: number | null }>();
    const at = async (t: number) => { ctxNow = t; return reconcileAttributionHolds(env, ctx(stripe)); };
    const delivered = () => env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE kind='refund.statutory_deadline'").bind(ctxNow).run();

    expect(await at(NOW + 4 * DAY)).toBe(0);
    expect(await deadlineAlert()).toBeNull();
    expect(await row("op-dl")).toMatchObject({ attribution_hold: 1, attribution_next_at: NOW + 4 * DAY + 3_600_000 });

    await at(NOW + 8 * DAY);
    let al = (await deadlineAlert())!;
    expect(al.severity).toBe("high");
    expect(JSON.parse(al.detail)).toMatchObject({ stage: "approaching", opIds: ["op-dl"], canPay: false, deadline: NOW + 14 * DAY });
    expect(JSON.parse(al.detail).message).toMatch(/CANNOT be paid until ownership is proven/);
    await delivered();
    await at(NOW + 8 * DAY + 2 * 3_600_000); // same stage: not delivered again
    expect((await deadlineAlert())!.delivered_at).not.toBeNull();

    await at(NOW + 13 * DAY);
    al = (await deadlineAlert())!;
    expect(al).toMatchObject({ severity: "critical", delivered_at: null });
    expect(JSON.parse(al.detail).stage).toBe("imminent");
    await delivered();

    await at(NOW + 15 * DAY);
    al = (await deadlineAlert())!;
    expect(al).toMatchObject({ severity: "critical", delivered_at: null });
    expect(JSON.parse(al.detail).stage).toBe("overdue");
    await delivered();
    await at(NOW + 15 * DAY + 2 * 3_600_000);
    expect((await deadlineAlert())!.delivered_at).not.toBeNull();
    await at(NOW + 16 * DAY + 3 * 3_600_000); // overdue: told again every day
    expect((await deadlineAlert())!.delivered_at).toBeNull();
    expect(await alerts("refund.statutory_deadline")).toBe(1);
    expect(refunds.filter((r) => r.payment_intent === "pi_1")).toHaveLength(1); // it never paid while unproven

    // Stripe now shows the refund naming the operation, its submission and its exact amount: proven, released, the alert resolves.
    refunds.find((r) => r.id === "re_dl")!.amount = 4900;
    expect(await at(NOW + 17 * DAY)).toBe(1);
    expect(await deadlineAlert()).toBeNull();
    expect(await row("op-dl")).toMatchObject({ attribution_hold: 0, stripe_refund_id: "re_dl", refunded_at: null });
    expect(await claimOf("re_dl")).toBe("op-dl");
    await sweepRefundOps(env, ctx(stripe));
    expect((await row("op-dl"))!.done_at).not.toBeNull();
    expect(refunds.filter((r) => r.payment_intent === "pi_1")).toHaveLength(1); // completed on the proven refund, never a second one
  });

  it("a held refund that is not statutory raises no deadline alert", async () => {
    await legacyRow("op-nd", { payment_intent: "pi_1", amount_cents: 4900, decided_at: NOW, submission: 1, attribution_hold: 1, last_error: "attribution_unresolved" });
    await env.DB.prepare("UPDATE refund_ops SET kind='region_hold' WHERE id='op-nd'").run();
    refunds.push({ id: "re_nd", amount: 999, status: "succeeded", payment_intent: "pi_1", metadata: { op_id: "op-nd", submission: "1" } });
    ctxNow = NOW + 15 * DAY;
    expect(await reconcileAttributionHolds(env, ctx(fakeStripe()))).toBe(0);
    expect(await alerts("refund.statutory_deadline")).toBe(0);
    expect((await row("op-nd"))!.attribution_hold).toBe(1);
  });
});

// ---- Astra WP3-7 (round 7) -------------------------------------------------------------------------------------------------------------------
const journalRows = (opId: string) => env.DB.prepare("SELECT submission,object_kind,object_id,intent_journaled FROM refund_submission_journal WHERE op_id=? ORDER BY submission")
  .bind(opId).all<{ submission: number; object_kind: string; object_id: string | null; intent_journaled: number }>().then((r) => r.results);
/** A held direct-path operation (1,225¢ on in_1 / pi_1, submission 1) that never had an object of its own. */
async function heldOp(id: string) {
  await open(id, "extraordinary", { path: "direct", frozen: quarter });
  await env.DB.prepare(`UPDATE refund_ops SET invoice_id='in_1',payment_intent='pi_1',paid_cents=4900,amount_cents=1225,decided_at=?,canceled_at=?,submission=1,submitted_at=?,
    attribution_hold=1,last_error='attribution_unresolved' WHERE id=?`).bind(NOW, NOW, NOW + DAY, id).run();
}

describe("Astra WP3-7 #1: ownership is proven only by our retained creation provenance, never by Stripe metadata", () => {
  it("B's note retagged with A's op id and submission: A stays held, B keeps its claims and its checkpoint", async () => {
    const stripe = fakeStripe();
    await open("op-own-b", "extraordinary", { path: "direct", frozen: quarter });
    expect(await advanceRefundOp(env, ctx(stripe), "op-own-b")).toMatchObject({ amount_cents: 1225, credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    expect(await journalRows("op-own-b")).toEqual([{ submission: 1, object_kind: "credit_note", object_id: "cn_1", intent_journaled: 1 }]);
    await heldOp("op-own-a");
    notes[0].metadata = { op_id: "op-own-a", submission: "1" }; // anyone with Dashboard access can do this
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("UPDATE refund_ops SET attribution_next_at=NULL").run();
      expect(await reconcileAttributionHolds(env, ctx(stripe))).toBe(0);
    }
    expect(await row("op-own-a")).toMatchObject({ attribution_hold: 1, credit_note_id: null, stripe_refund_id: null, done_at: null });
    expect(await claimOf("cn_1")).toBe("op-own-b");
    expect(await claimOf("re_1")).toBe("op-own-b");
    expect(await row("op-own-b")).toMatchObject({ attribution_hold: 0, credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    expect(notes).toHaveLength(1);
  });

  it("our own note still proves its operation after its metadata is stripped (the journal, not metadata, binds it)", async () => {
    const stripe = fakeStripe();
    await open("op-own-c", "extraordinary", { path: "direct", frozen: quarter });
    expect(await advanceRefundOp(env, ctx(stripe), "op-own-c")).toMatchObject({ credit_note_id: "cn_1" });
    await env.DB.prepare(`UPDATE refund_ops SET credit_note_id=NULL,stripe_refund_id=NULL,refunded_at=NULL,done_at=NULL,attribution_hold=1,
      last_error='attribution_unresolved' WHERE id='op-own-c'`).run();
    await env.DB.prepare("DELETE FROM refund_object_claims").run();
    notes[0].metadata = {};
    expect(await reconcileAttributionHolds(env, ctx(stripe))).toBe(1);
    expect(await row("op-own-c")).toMatchObject({ attribution_hold: 0, credit_note_id: "cn_1", stripe_refund_id: "re_1" });
    expect(await claimOf("cn_1")).toBe("op-own-c");
  });
});

describe("Astra WP3-7 #2: an ambiguous submission is never released as unpaid by absence", () => {
  it("a held, uncheckpointed partial refund whose metadata disappears stays held; no second note after the key expires", async () => {
    await open("op-amb", "extraordinary", { path: "direct", frozen: half });
    afterNote = async () => { throw new Error("connection reset"); }; // Stripe made the note; our call never got the answer
    await advanceRefundOp(env, ctx(fakeStripe()), "op-amb");
    expect(notes).toHaveLength(1);
    expect(await journalRows("op-amb")).toEqual([{ submission: 1, object_kind: "credit_note", object_id: null, intent_journaled: 1 }]);
    expect(await row("op-amb")).toMatchObject({ submission: 1, credit_note_id: null });
    await env.DB.prepare("UPDATE refund_ops SET attribution_hold=1,last_error='attribution_unresolved' WHERE id='op-amb'").run();
    notes[0].metadata = {}; // the note no longer names the operation
    ctxNow = NOW + 7 * DAY; // the idempotency key has expired: a fresh client remembers no key
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("UPDATE refund_ops SET attribution_next_at=NULL,next_attempt_at=NULL").run();
      expect(await reconcileAttributionHolds(env, ctx(fakeStripe()))).toBe(0);
      await sweepRefundOps(env, ctx(fakeStripe()));
    }
    expect(await row("op-amb")).toMatchObject({ attribution_hold: 1, done_at: null, refunded_at: null });
    expect(notes).toHaveLength(1);
    expect(calls.filter((c) => c.op === "POST /v1/credit_notes")).toHaveLength(1);
  });

  it("an unheld retry never re-makes a note whose answer was lost and whose metadata is gone: it is held instead", async () => {
    await open("op-amb2", "extraordinary", { path: "direct", frozen: half });
    afterNote = async () => { throw new Error("connection reset"); };
    await advanceRefundOp(env, ctx(fakeStripe()), "op-amb2");
    notes[0].metadata = {};
    ctxNow = NOW + 7 * DAY;
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-amb2'").run();
    expect(await advanceRefundOp(env, ctx(fakeStripe()), "op-amb2")).toMatchObject({ attribution_hold: 1, last_error: "attribution_unresolved", done_at: null });
    expect(notes).toHaveLength(1);
  });

  // Astra WP3-8 #1: an UNHELD operation whose submission was made before the journal existed (no journal row) never creates on a retry.
  for (const [label, submission] of [["submission 1", 1], ["a legacy zero-number intent", 0]] as const) {
    it(`an unheld pre-journal operation (${label}, no journal row) whose note's metadata is gone is held, never paid twice`, async () => {
      const id = `op-prej-${submission}`;
      await open(id, "extraordinary", { path: "direct", frozen: half });
      afterNote = async () => { throw new Error("connection reset"); }; // Stripe made the note; the answer was lost
      await advanceRefundOp(env, ctx(fakeStripe()), id);
      expect(notes).toHaveLength(1);
      // As it looked before migration 0072: the intent is on the row, no journal row exists.
      await env.DB.prepare("DELETE FROM refund_submission_journal WHERE op_id=?").bind(id).run();
      await env.DB.prepare("UPDATE refund_ops SET submission=?,attribution_hold=0,last_error=NULL,next_attempt_at=NULL WHERE id=?").bind(submission, id).run();
      expect(await row(id)).toMatchObject({ attribution_hold: 0, credit_note_id: null });
      expect((await row(id))!.submitted_at).not.toBeNull();
      notes[0].metadata = {};
      ctxNow = NOW + 7 * DAY; // the idempotency key has expired
      for (let i = 0; i < 2; i++) {
        await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL,attribution_next_at=NULL").run();
        await advanceRefundOp(env, ctx(fakeStripe()), id);
        await sweepRefundOps(env, ctx(fakeStripe()));
      }
      expect(await row(id)).toMatchObject({ attribution_hold: 1, last_error: "attribution_unresolved", done_at: null, refunded_at: null });
      expect(notes).toHaveLength(1);
      expect(calls.filter((c) => c.op === "POST /v1/credit_notes")).toHaveLength(1);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.attribution_unresolved' AND resolved_at IS NULL").first<{ n: number }>())
        .toEqual({ n: 1 });
    });
  }

  it("a submission whose call truly made nothing (journaled intent, complete listing empty) is released and submitted once", async () => {
    await open("op-none", "extraordinary", { path: "direct", frozen: half });
    beforeNote = async () => { throw new Error("connection reset"); }; // the call failed before Stripe made anything
    await advanceRefundOp(env, ctx(fakeStripe()), "op-none");
    expect(notes).toHaveLength(0);
    await env.DB.prepare("UPDATE refund_ops SET attribution_hold=1,last_error='attribution_unresolved' WHERE id='op-none'").run();
    expect(await reconcileAttributionHolds(env, ctx(fakeStripe()))).toBe(1);
    await sweepRefundOps(env, ctx(fakeStripe()));
    expect(notes).toHaveLength(1);
    expect((await row("op-none"))!.done_at).not.toBeNull();
  });

  it("a held operation with a submission made before the journal existed stays held (no provenance, no inference)", async () => {
    await heldOp("op-legacy");
    expect(await reconcileAttributionHolds(env, ctx(fakeStripe()))).toBe(0);
    expect(await row("op-legacy")).toMatchObject({ attribution_hold: 1 });
  });
});

describe("Astra WP3-7 #3: quarantine clears the identity's success timestamp in the same transaction, keeping the reservation", () => {
  it("refund_identity_claims.refunded_at is cleared; the reservation row and its key stay", async () => {
    const stripe = fakeStripe();
    await open("op-id-b", "extraordinary", { path: "direct", frozen: quarter });
    await advanceRefundOp(env, ctx(stripe), "op-id-b");
    await open("op-id-a", "extraordinary", { path: "direct", frozen: quarter });
    await env.DB.prepare(`UPDATE refund_ops SET invoice_id='in_1',payment_intent='pi_1',amount_cents=1225,decided_at=?,canceled_at=?,submission=1,credit_note_id='cn_1',
      stripe_refund_id='re_1',refund_status='succeeded',stripe_refund_status='succeeded',refunded_at=?,notified_at=? WHERE id='op-id-a'`).bind(NOW, NOW, NOW + DAY, NOW + DAY).run();
    await env.DB.prepare("INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at,refunded_at) VALUES ('card','kh-a','in_1',?,'op-id-a',?,?)")
      .bind(OWNER, NOW, NOW + DAY).run();
    expect(await advanceRefundOp(env, ctx(stripe), "op-id-a")).toMatchObject({ attribution_hold: 1, refunded_at: null });
    expect(await env.DB.prepare("SELECT key_hash,op_id,refunded_at FROM refund_identity_claims WHERE op_id='op-id-a'").all().then((r) => r.results))
      .toEqual([{ key_hash: "kh-a", op_id: "op-id-a", refunded_at: null }]);
  });
});

describe("Astra INTEGRATED-13 P1-1 (reachable with Flux off): an unresolved dispute hold's lifetime is bounded by people", () => {
  const openAlert = (kind: string, subject: string) => env.DB.prepare("SELECT severity,detail,delivered_at FROM cloud_alerts WHERE kind=? AND subject=? AND resolved_at IS NULL")
    .bind(kind, subject).first<{ severity: string; detail: string; delivered_at: number | null }>();
  const H = 3_600_000;

  it("INTEGRATED-13 P1-1 escalation ladder: paged at 15 minutes, escalated (critical) at 2 hours and again at 6 hours (re-delivered); the operator's evidenced close resolves every page", async () => {
    const { sweepDisputeHolds, closeDisputeHold } = await import("../src/b5-billing");
    await env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,held_at,scope_pending)
      VALUES ('evt_l13','ch_l13','dp_l13','charge.dispute.created',?,1)`).bind(NOW).run();
    await sweepDisputeHolds(env, NOW + 10 * 60_000);
    expect(await openAlert("dispute.hold_unattributed", "evt_l13")).toBeNull();
    await sweepDisputeHolds(env, NOW + 16 * 60_000);
    expect(await openAlert("dispute.hold_unattributed", "evt_l13")).not.toBeNull();
    expect(await openAlert("dispute.hold_escalated", "evt_l13")).toBeNull();
    // Before the fix: nothing beyond the first page, however long the hold stood.
    await sweepDisputeHolds(env, NOW + 2 * H + 1);
    let esc = (await openAlert("dispute.hold_escalated", "evt_l13"))!;
    expect(esc.severity).toBe("critical");
    expect(JSON.parse(esc.detail)).toMatchObject({ level: "2h", eventId: "evt_l13", scopePending: 1, action: expect.stringContaining("/v1/admin/dispute-holds/evt_l13/close") });
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE kind='dispute.hold_escalated'").bind(NOW + 2 * H + 2).run();
    await sweepDisputeHolds(env, NOW + 3 * H);
    expect((await openAlert("dispute.hold_escalated", "evt_l13"))!.delivered_at).not.toBeNull(); // the same level: not re-delivered
    await sweepDisputeHolds(env, NOW + 6 * H + 1);
    esc = (await openAlert("dispute.hold_escalated", "evt_l13"))!;
    expect([JSON.parse(esc.detail).level, esc.severity, esc.delivered_at]).toEqual(["6h", "critical", null]);
    await sweepDisputeHolds(env, NOW + 7 * H);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='dispute.hold_escalated' AND subject='evt_l13'").first<{ n: number }>())!.n).toBe(1);
    expect(await closeDisputeHold(env, { eventId: "evt_l13", by: "ops-sean", evidence: "Stripe dashboard: the charge is on another account" }, NOW + 7 * H + 1)).toBe(true);
    expect(await openAlert("dispute.hold_unattributed", "evt_l13")).toBeNull();
    expect(await openAlert("dispute.hold_escalated", "evt_l13")).toBeNull();
    await sweepDisputeHolds(env, NOW + 8 * H);
    expect(await openAlert("dispute.hold_escalated", "evt_l13")).toBeNull();
  });

  it("INTEGRATED-13 P1-1 a six-hour hold outage: a statutory refund held by the dispute hold (its own next pass six hours away) raises the statutory-deadline alert as its deadline approaches, naming the dispute; nothing is paid; resolved once it is no longer held", async () => {
    // A withdrawal (statutory: opened + 14 days) decided, held by an attribution-pending dispute hold standing for six hours.
    const at = NOW + 8 * DAY;
    await env.DB.prepare(`INSERT INTO dispute_holds (event_id,charge_id,dispute_id,event_type,held_at,scope_pending)
      VALUES ('evt_d13','ch_d13','dp_d13','charge.dispute.created',?,1)`).bind(at - 6 * H).run();
    await legacyRow("op-d13", { payment_intent: "pi_1", amount_cents: 4900, decided_at: NOW, last_error: "payment_dispute_hold", attempts: 12, next_attempt_at: at + 6 * H });
    const deadlineAlert = () => env.DB.prepare("SELECT severity,detail FROM cloud_alerts WHERE kind='refund.statutory_deadline' AND resolved_at IS NULL")
      .first<{ severity: string; detail: string }>();
    ctxNow = NOW + 4 * DAY; await reconcileAttributionHolds(env, ctx(fakeStripe()));
    expect(await deadlineAlert()).toBeNull(); // ten days out: nothing yet
    ctxNow = at; await reconcileAttributionHolds(env, ctx(fakeStripe()));
    // Before the fix: only attribution holds were selected; a dispute-held refund never showed as a deadline risk.
    const al = (await deadlineAlert())!;
    expect(al.severity).toBe("high");
    const d = JSON.parse(al.detail);
    expect(d).toMatchObject({ stage: "approaching", opIds: ["op-d13"], deadline: NOW + 14 * DAY, canPay: false, rows: { "op-d13": { heldBy: "dispute" } } });
    expect(d.message).toMatch(/held by a payment dispute/);
    expect(await row("op-d13")).toMatchObject({ attribution_hold: 0, next_attempt_at: at + 6 * H, done_at: null });
    expect(refunds).toHaveLength(0);
    ctxNow = NOW + 13 * DAY; await reconcileAttributionHolds(env, ctx(fakeStripe()));
    expect(await deadlineAlert()).toMatchObject({ severity: "critical" });
    // No longer held by the dispute (its hold released, its next pass ran): the alert resolves.
    await env.DB.prepare("UPDATE refund_ops SET last_error=NULL WHERE id='op-d13'").run();
    ctxNow = NOW + 13 * DAY + H; await reconcileAttributionHolds(env, ctx(fakeStripe()));
    expect(await deadlineAlert()).toBeNull();
  });
});

describe("Astra INTEGRATED-14 P2 (reachable with Flux off): the statutory-deadline monitor rotates fairly over every dispute-held home", () => {
  const H = 3_600_000;
  it("INTEGRATED-14 P2 60 dispute-held homes: all 60 are alerted within two passes (before: the 50 with open alerts monopolised every pass, home 51 never selected); rechecks rotate by a durable per-home stamp; nothing is paid, no Flux hook is called", async () => {
    // Every Flux hook fails the test if called (Flux is off: no router call, no grant or revoke; prepaid and spent balances never read).
    const fluxCalls: string[] = [];
    const flux = new Proxy(stubFluxHooks, { get: (t, p) => {
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (...a: unknown[]) => { fluxCalls.push(String(p)); return (v as (...x: unknown[]) => unknown)(...a); } : v;
    } });
    const at = NOW + 8 * DAY;
    const homes = Array.from({ length: 60 }, (_, i) => `home-f14-${String(i).padStart(2, "0")}`);
    await env.DB.batch(homes.map((h, i) => env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,created_at,updated_at,payment_intent,amount_cents,
        decided_at,last_error,attempts,next_attempt_at) VALUES (?,'withdrawal',?,?,?,0,?,?,?,4900,?,'payment_dispute_hold',12,?)`)
      .bind(`op-f14-${i}`, h, `user-f14-${i}`, `in_f14_${i}`, NOW, NOW, `pi_f14_${i}`, NOW, at + 6 * H)));
    const alerted = async () => (await env.DB.prepare(`SELECT COUNT(DISTINCT home_id) AS n FROM cloud_alerts WHERE kind='refund.statutory_deadline'
      AND resolved_at IS NULL AND home_id LIKE 'home-f14-%'`).first<{ n: number }>())!.n;
    const stamps = async () => Object.fromEntries((await env.DB.prepare(`SELECT value,COUNT(*) AS n FROM cloud_ops_state WHERE key LIKE 'deadline_check:home-f14-%'
      GROUP BY value`).all<{ value: string; n: number }>()).results.map((r) => [r.value, r.n]));
    const pass = async (t: number) => { ctxNow = t; await reconcileAttributionHolds(env, { ...ctx(fakeStripe()), flux }); };
    await pass(at);
    expect(await alerted()).toBe(50);
    expect(await stamps()).toEqual({ [String(at)]: 50 });
    await pass(at + H);
    expect(await alerted()).toBe(60);
    // The 10 never looked at came first, then the 40 looked at longest ago.
    expect(await stamps()).toEqual({ [String(at)]: 10, [String(at + H)]: 50 });
    await pass(at + 2 * H);
    expect(await stamps()).toEqual({ [String(at + H)]: 10, [String(at + 2 * H)]: 50 }); // the 10 skipped last pass were looked at
    await pass(at + 3 * H);
    expect(await stamps()).toEqual({ [String(at + 2 * H)]: 10, [String(at + 3 * H)]: 50 });
    expect(await alerted()).toBe(60);
    // Nothing paid, nothing re-scheduled: every refund still waits on its own (six-hour) pass; no Flux hook was touched.
    expect(refunds).toHaveLength(0);
    expect(calls).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops WHERE id LIKE 'op-f14-%' AND next_attempt_at=? AND done_at IS NULL AND decided_at=?")
      .bind(at + 6 * H, NOW).first<{ n: number }>())!.n).toBe(60);
    expect(fluxCalls).toEqual([]);
  });
});

describe("Astra INTEGRATED-15 (reachable with Flux off): the statutory-deadline monitor's cursor moves past busy homes; its stamps never accumulate", () => {
  const H = 3_600_000;
  // Every Flux hook fails the test if called (Flux is off: no router call, no grant or revoke; prepaid and spent balances never read).
  const watched = (fluxCalls: string[]) => new Proxy(stubFluxHooks, { get: (t, p) => {
    const v = (t as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === "function" ? (...a: unknown[]) => { fluxCalls.push(String(p)); return (v as (...x: unknown[]) => unknown)(...a); } : v;
  } });
  const heldHomes = async (prefix: string, n: number, at: number) => {
    const homes = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
    const st = homes.map((h, i) => env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,created_at,updated_at,payment_intent,amount_cents,
        decided_at,last_error,attempts,next_attempt_at) VALUES (?,'withdrawal',?,?,?,0,?,?,?,4900,?,'payment_dispute_hold',12,?)`)
      .bind(`op-${h}`, h, `user-${h}`, `in_${h}_${i}`, NOW, NOW, `pi_${h}_${i}`, NOW, at + 6 * H));
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
    return homes;
  };
  const openAlerts = async (prefix: string) => (await env.DB.prepare(`SELECT home_id,COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.statutory_deadline'
      AND resolved_at IS NULL AND home_id LIKE ? GROUP BY home_id`).bind(`${prefix}%`).all<{ home_id: string; n: number }>()).results;
  const stampCount = async (like: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_ops_state WHERE key LIKE ?").bind(`deadline_check:${like}`)
    .first<{ n: number }>())!.n;

  it("INTEGRATED-15 P2 151 dispute-held homes, the first 50 leases held throughout: all 101 others are alerted within 4 passes (before: ten passes visited none of them); one open alert per home, never two; the busy 50 are reached once their leases are free; nothing paid, no Flux hook called", async () => {
    const fluxCalls: string[] = []; const flux = watched(fluxCalls);
    const at = NOW + 8 * DAY;
    const homes = await heldHomes("home-r15-", 151, at);
    const leases = [] as NonNullable<Awaited<ReturnType<typeof acquireHomeLease>>>[];
    for (const h of homes.slice(0, 50)) leases.push((await acquireHomeLease(env, h, `holder-${h}`))!);
    expect(leases.every(Boolean)).toBe(true);
    const pass = async (t: number) => { ctxNow = t; await reconcileAttributionHolds(env, { ...ctx(fakeStripe()), flux }); };
    await pass(at);
    // The 50 busy homes were reached: no look (their lease is held), but each is stamped, so the cursor moves past it.
    expect(await openAlerts("home-r15-")).toEqual([]);
    expect(await stampCount("home-r15-%")).toBe(50);
    for (let i = 1; i < 4; i++) await pass(at + i * H);
    const others = await openAlerts("home-r15-");
    expect(others.map((a) => a.home_id).sort()).toEqual(homes.slice(50));
    expect(others.every((a) => a.n === 1)).toBe(true);
    // Contention persists for six more passes: still exactly one open alert per home, none for the busy 50.
    for (let i = 4; i < 10; i++) await pass(at + i * H);
    const still = await openAlerts("home-r15-");
    expect(still).toHaveLength(101);
    expect(still.every((a) => a.n === 1)).toBe(true);
    // The leases are freed: the busy 50 are looked at within ceil(151 / 50) = 4 passes.
    for (const l of leases) await releaseHomeLease(env, l);
    for (let i = 10; i < 14; i++) await pass(at + i * H);
    const all = await openAlerts("home-r15-");
    expect(all).toHaveLength(151);
    expect(all.every((a) => a.n === 1)).toBe(true);
    expect(refunds).toHaveLength(0);
    expect(calls).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops WHERE id LIKE 'op-home-r15-%' AND next_attempt_at=? AND done_at IS NULL AND decided_at=?")
      .bind(at + 6 * H, NOW).first<{ n: number }>())!.n).toBe(151);
    expect(fluxCalls).toEqual([]);
  });

  it("INTEGRATED-15 P3 a home's stamp is removed once it has neither a monitored obligation nor an open deadline alert (at most 50 per pass); live homes keep theirs; nothing paid, no Flux hook called", async () => {
    const fluxCalls: string[] = []; const flux = watched(fluxCalls);
    const at = NOW + 8 * DAY;
    const homes = await heldHomes("home-p15-", 3, at);
    const pass = async (t: number) => { ctxNow = t; await reconcileAttributionHolds(env, { ...ctx(fakeStripe()), flux }); };
    await pass(at);
    expect(await openAlerts("home-p15-")).toHaveLength(3);
    expect(await stampCount("home-p15-%")).toBe(3);
    // 120 stamps left behind by homes long finished (nothing outstanding, no alert).
    const dead = Array.from({ length: 120 }, (_, i) => env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)")
      .bind(`deadline_check:home-z15-${String(i).padStart(3, "0")}`, String(at)));
    for (let i = 0; i < dead.length; i += 60) await env.DB.batch(dead.slice(i, i + 60));
    // home-p15-000's obligation closes: its alert is resolved by its next look, then its stamp goes; the two still held keep theirs.
    await env.DB.prepare("UPDATE refund_ops SET done_at=? WHERE id=?").bind(at, `op-${homes[0]}`).run();
    await pass(at + H);
    expect((await openAlerts("home-p15-")).map((a) => a.home_id).sort()).toEqual(homes.slice(1));
    expect(await stampCount("home-p15-%")).toBe(2);
    expect(await stampCount(`${homes[0]}`)).toBe(0);
    expect(await stampCount("home-z15-%")).toBe(71); // bounded: 50 per pass (home-p15-000 and 49 others)
    await pass(at + 2 * H);
    expect(await stampCount("home-z15-%")).toBe(21);
    await pass(at + 3 * H);
    expect(await stampCount("home-z15-%")).toBe(0);
    expect(await stampCount("home-p15-%")).toBe(2);
    expect(await openAlerts("home-p15-")).toHaveLength(2);
    expect(refunds).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(fluxCalls).toEqual([]);
  });
});
