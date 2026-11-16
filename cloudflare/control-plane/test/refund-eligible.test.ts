// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /v1/account/cloud subscription.refundEligible: the D1-only hint behind the "Get my first month back" button.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { firstMonthOfferHint } from "../src/legal-flows";
import { LEGAL_DOCS } from "../src/legal-docs.generated";
import { keyring } from "../src/refund-identity";

const SECRET = "test-only-refund-identity-hmac-secret-0123456789"; // secret-scan: fixture
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const USER = "user-1";
const OTHER = "user-2";
const e = (extra: Record<string, unknown> = {}) => ({ ...env, REFUND_KEY_SECRET: SECRET, REFUND_LIMIT_TERMS_VERSIONS: LEGAL_DOCS.cloudTerms.versionId, ...extra }) as unknown as Env;
const ids = { homeId: "home-1", userId: USER };
/** Seeds the home and its subscription (the primary's truth) and runs the hint, which now reads both itself. */
async function seed(over: Record<string, unknown> = {}, o: { noSub?: boolean; ready?: number } = {}) {
  const f = { first_invoice_id: "in_1", first_paid_at: NOW - DAY, first_invoice_cents: 4900, abuse_closed_at: null, consent_id: null, ...over };
  await env.DB.batch([env.DB.prepare("DELETE FROM billing_subscriptions"), env.DB.prepare("DELETE FROM cloud_homes"),
    env.DB.prepare("INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at,ready_at) VALUES ('home-1','inst-1',?,'ready','ready','img','k',?,?,?)")
      .bind(USER, NOW, NOW, o.ready ?? NOW - DAY)]);
  if (!o.noSub) await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at,
    consent_id,first_invoice_id,first_paid_at,first_invoice_cents,abuse_closed_at) VALUES ('home-1','cus','sub','pro','active',?,?,?,?,?,?,?,?,?)`)
    .bind(NOW - DAY, NOW + 29 * DAY, NOW, NOW, f.consent_id, f.first_invoice_id, f.first_paid_at, f.first_invoice_cents, f.abuse_closed_at).run();
}
const run = async (envv: Env, over: Record<string, unknown> = {}, o: { noSub?: boolean; ready?: number } = {}) => { await seed(over, o); return firstMonthOfferHint(envv, ids, NOW); };

async function keys(invoice: string, user: string, paidAt: number, hashes: [string, string][], settled = true, version = 1) {
  const b = [env.DB.prepare("INSERT INTO refund_identity_captures (invoice_id,home_id,user_id,paid_at,source,fingerprint,captured_at) VALUES (?,?,?,?,?,?,?)").bind(invoice, "h", user, paidAt, "card", 1, paidAt)];
  if (settled) b.push(env.DB.prepare("INSERT INTO refund_identity_settled (invoice_id,paid_at,settled_at) VALUES (?,?,?)").bind(invoice, paidAt, paidAt));
  for (const [kind, hash] of hashes) {
    b.push(env.DB.prepare("INSERT INTO refund_identity_keys (kind,key_hash,user_id,home_id,invoice_id,paid_at,created_at,key_version,norm) VALUES (?,?,?,?,?,?,?,?,0)").bind(kind, hash, user, "h", invoice, paidAt, paidAt, version));
  }
  await env.DB.batch(b);
}
const hashA = "a".repeat(64);

beforeEach(async () => {
  await env.DB.batch(["refund_identity_keys", "refund_identity_captures", "refund_identity_settled", "refund_identity_claims", "refund_identity_restrictions",
    "first_month_refunds", "terms_acceptances", "abuse_closures", "refund_ops", "refund_identity_keyring"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
    VALUES ('t1',?,?,'v','v','reaccept',NULL,'w',?,'{}')`).bind(USER, LEGAL_DOCS.cloudTerms.versionId, NOW - 10 * DAY).run();
});

describe("firstMonthOfferHint", () => {
  it("an eligible first payment is true", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(e())).toBe(true);
  });
  it("a payment sharing a card key with an earlier one is false", async () => {
    await keys("in_0", OTHER, NOW - 30 * DAY, [["card", hashA]]);
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(e())).toBe(false);
  });
  it("an already refunded customer is false", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    await env.DB.prepare("INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,stripe_refund_id,created_at) VALUES (?,?,?,?,0,'re_1',?)")
      .bind(USER, "home-1", "in_1", 4900, NOW).run();
    expect(await run(e())).toBe(false);
  });
  it("an expired window is false", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(e(), { first_paid_at: NOW - 30 * DAY }, { ready: NOW - 30 * DAY })).toBe(false);
  });
  it("an abuse closure and a missing first payment are false", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(e(), { abuse_closed_at: NOW })).toBe(false);
    expect(await run(e(), { first_invoice_id: null })).toBe(false);
  });
  it("an open objection never hides the button (omitted)", async () => {
    await keys("in_0", OTHER, NOW - 30 * DAY, [["card", hashA]]);
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    await env.DB.prepare("INSERT INTO refund_identity_restrictions (user_id,objected_at) VALUES (?,?)").bind(USER, NOW - DAY).run();
    expect(await run(e())).toBeUndefined();
  });
  it("no stored keys, an unset secret, no subscription or terms without the limit are not false", async () => {
    expect(await run(e())).toBeUndefined(); // no keys
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(e({ REFUND_KEY_SECRET: undefined }))).toBeUndefined();
    expect(await run(e(), {}, { noSub: true })).toBeUndefined();
    await env.DB.prepare("DELETE FROM terms_acceptances").run();
    expect(await run(e())).toBe(true); // the offer as those terms gave it
  });
  it("an unsettled capture with no match is omitted", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]], false);
    expect(await run(e())).toBeUndefined();
  });

  it("a keyring recorded for the same secret still decides (true)", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await keyring(e(), NOW)).not.toBeNull(); // records the check-hash as the quote would
    expect(await run(e())).toBe(true);
  });
  it("the secret replaced under the same version (check-hash mismatch) is omitted, as the quote is pending", async () => {
    await keys("in_0", OTHER, NOW - 30 * DAY, [["card", hashA]]);
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]); // would be false with a sound keyring
    await env.DB.prepare("INSERT INTO refund_identity_keyring (version,check_hash,first_used_at) VALUES (1,?,?)").bind("0".repeat(64), NOW - 9 * DAY).run();
    expect(await run(e())).toBeUndefined();
    expect(await keyring(e(), NOW)).toBeNull(); // the quote's side of the same fault
  });
  it("a key version no configured key can read, on ANOTHER invoice, is omitted", async () => {
    await keys("in_0", OTHER, NOW - 30 * DAY, [["card", hashA]], true, 7);
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(e())).toBeUndefined();
    expect(await keyring(e(), NOW)).toBeNull();
  });
  it("reads only on a first-primary session in one batch; never the replica binding (stale replica cannot make it false)", async () => {
    const real = env.DB;
    const constraints: string[] = [];
    let batches = 0;
    const replicaRead = () => { throw new Error("replica read"); };
    const staleDb = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare" || prop === "batch") return replicaRead; // the stale replica: any direct read would be a bug
        if (prop === "withSession") return (c: string) => {
          constraints.push(c);
          const session = target.withSession(c as never);
          return new Proxy(session, { get(t, p) { if (p === "batch") batches++; const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } });
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const stale = { ...e(), DB: staleDb } as unknown as Env;
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    expect(await run(stale)).toBe(true); // decided from the primary session
    expect(constraints).toEqual(["first-primary"]);
    expect(batches).toBe(1);
    // The objection exists only on the primary: the hint sees it and omits (a replica without it would have said false).
    await keys("in_0", OTHER, NOW - 30 * DAY, [["card", hashA]]);
    await env.DB.prepare("INSERT INTO refund_identity_restrictions (user_id,objected_at) VALUES (?,?)").bind(USER, NOW - DAY).run();
    expect(await run(stale)).toBeUndefined();
    // No primary session obtainable: omitted.
    const broken = { ...e(), DB: new Proxy(real, { get(t, p) { if (p === "withSession") return () => { throw new Error("no session"); }; const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } }) } as unknown as Env;
    expect(await run(broken)).toBeUndefined();
  });

  it("stale replica-style inputs cannot make it false: only identifiers are taken, the payment and the deadline are read on the primary", async () => {
    await keys("in_1", USER, NOW - DAY, [["card", hashA]]);
    await seed(); // the primary has the fresh payment and an open window
    // The hint's signature is (env, {homeId, userId}, now): a replica's null first_invoice_id or expired deadline cannot be passed in.
    expect(firstMonthOfferHint.length).toBe(3);
    expect(await firstMonthOfferHint(e(), ids, NOW)).toBe(true);
    // The deadline and the payment come from the primary's rows: expired there is false, no first payment there is false.
    expect(await run(e(), { first_paid_at: NOW - 30 * DAY }, { ready: NOW - 30 * DAY })).toBe(false);
    expect(await run(e(), { first_invoice_id: null })).toBe(false);
    // A home not ready yet (the clock has not started) keeps the window open even with an old payment.
    await seed({ first_paid_at: NOW - 30 * DAY });
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=NULL").run();
    expect(await firstMonthOfferHint(e(), ids, NOW)).not.toBe(false);
  });
});
