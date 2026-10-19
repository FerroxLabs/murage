// SPDX-License-Identifier: AGPL-3.0-or-later
// Provisioning retries: a transient failure at any step must recover with no second server or volume and the same
// enrollment token; past the budget the home is given up on (resources released, full refund, email, ops alert).
// Real workerd + D1 with the fake provider; the live refund route is exercised with a Stripe fixture.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type CreateHomeInput, type ProviderAdapter } from "../src/b3-provider";
import { sweepBilling, defaultNotifier, provisionFailedEmail, type BillingNotifier } from "../src/b5-billing";
import { acquireHomeLease } from "../src/billing-lease";
import { PROVISION_MAX_ATTEMPTS, PROVISION_MAX_MS } from "../src/b3-control";
import { sweepMonitoring } from "../src/ops-monitor";
import { sha256 } from "../src/installations";
import { HostError, markNotAnAnswer, sanitizeProviderMessage } from "../src/b5-provisioner";
import { confirmDispatchCall, settleCall } from "../src/dispatch-ledger";
import { prepareBackup, purgeBackup } from "../src/b5-backup";
import { deriveBackupPassword } from "../src/cloud-machines";
import { planEndOf } from "../src/plan-end-reason";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ADMIN = "test-only-provision-retry-admin-no-real-access";
const IMAGE = `sha256:${"a".repeat(64)}`;
const HOME = "retry-home";
const config = { reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "retry-slot", projectId: "test-project", location: "fsn1", serverType: "cpx32", outcome: "available" }] };
const fixtureEnv = (extra: Record<string, string> = {}): Env => ({ ...env, CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(config),
  CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), ...extra } as Env);
const noNetwork = async () => { throw new Error("unexpected fixture network"); };
type Make = (db: D1Database) => ProviderAdapter;

async function reconcile(provider: Make, extra: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await createWorker(noNetwork, noNetwork, { provider }).fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, "CF-Connecting-IP": "203.0.113.10" }, body: "{}",
  }), fixtureEnv(extra), ctx);
  await waitOnExecutionContext(ctx); return response;
}
/** reconcile() with shortened provider-call bounds (round 11). */
async function reconcileBound(provider: Make, callBoundMs: { dispatch?: number; cleanup?: number }) {
  const ctx = createExecutionContext();
  const response = await createWorker(noNetwork, noNetwork, { provider, callBoundMs }).fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, "CF-Connecting-IP": "203.0.113.10" }, body: "{}",
  }), fixtureEnv(), ctx);
  await waitOnExecutionContext(ctx); return response;
}
/** A provider call that never answers: it ends only when its bound aborts it (an unbounded call fails the test at once). */
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  if (!signal) { reject(new Error("unbounded provider call")); return; }
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const at = (minutes: number) => vi.mocked(Date.now).mockReturnValue(NOW + minutes * MIN);
const row = <T = Record<string, unknown>>(table: string) => env.DB.prepare(`SELECT * FROM ${table} WHERE ${table === "cloud_homes" || table === "cloud_machines" ? "id" : "home_id"}=?`).bind(HOME).first<T>();
const live = async (role: "home" | "volume") => (await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role=? AND state<>'destroyed'").bind(role).all()).results;
const PAYMENT = { eventId: "evt-retry", homeId: HOME, version: 1, status: "paid", paymentId: "in_retry_1" };

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await env.DB.prepare(`INSERT INTO cloud_homes
    (id,installation_id,owner_id,desired_state,observed_state,entitlement,payment_version,generation,resource_generation,image_digest,home_key,created_at,updated_at)
    VALUES (?,'retry-installation','retry-owner','provisioning','reserved','paid',1,1,1,?,'synthetic-home-key',?,?)`).bind(HOME, IMAGE, NOW, NOW).run();
  await env.DB.prepare("INSERT INTO cloud_capacity (id,project_id,location,server_type,home_id,outcome) VALUES ('retry-slot','test-project','fsn1','cpx32',?,'available')").bind(HOME).run();
  await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
    VALUES ('retry-reserved',?,1,'retry-owner','reserved','{"publicOrigin":"https://retry-home.murage.test"}',?)`).bind(HOME, NOW).run();
  await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
    VALUES ('payment:evt-retry',?,1,'retry-owner','payment_paid',?,?)`).bind(HOME, JSON.stringify(PAYMENT), NOW).run();
});
afterEach(() => vi.restoreAllMocks());

/** A provider that fails `step` on its first `times` calls, either before the provider acts or after it already did
 *  (a lost response), and records every enrollment token a server was created with. */
function flaky(step: "create_volume" | "create" | "attach_volume" | "public_ips", times: number, when: "before" | "after", tokens: string[] = []): Make {
  let n = 0;
  return (db) => {
    const p = fakeProvider(db);
    const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, name: string) => async (...a: A): Promise<R> => {
      if (name === "create") tokens.push((a[0] as CreateHomeInput).userData.enrollmentToken);
      const fails = name === step && n < times;
      if (fails && when === "before") { n++; throw new Error("synthetic transient failure"); }
      const result = await fn(...a);
      if (fails) { n++; throw new Error("synthetic lost response"); }
      return result;
    };
    return { ...p, create_volume: wrap(p.create_volume.bind(p), "create_volume"), create: wrap(p.create.bind(p), "create"),
      attach_volume: wrap(p.attach_volume.bind(p), "attach_volume"), public_ips: wrap(p.public_ips.bind(p), "public_ips") };
  };
}

describe("provisioning retries recover from a transient failure at every step", () => {
  for (const step of ["create_volume", "create", "attach_volume", "public_ips"] as const) {
    for (const when of ["before", "after"] as const) {
      it(`${step} fails twice (${when} the provider acts): backs off, retries, ends with one server, one volume and a redeemable token`, async () => {
        const tokens: string[] = []; const make = flaky(step, 2, when, tokens);
        for (const minute of [0, 1, 5, 10, 15, 20]) { at(minute); await reconcile(make).catch(() => undefined); }
        expect((await row<{ desired_state: string }>("cloud_homes"))?.desired_state).toBe("checking");
        expect(await live("home")).toHaveLength(1); expect(await live("volume")).toHaveLength(1);
        expect((await row<{ state: string }>("cloud_provision_intents"))?.state).toBe("bound");
        // Every create carried the same token; the home can enrol with it.
        expect(new Set(tokens).size).toBe(1);
        const ctx = createExecutionContext();
        const enrolled = await createWorker(noNetwork, noNetwork, { provider: make }).fetch(new Request(`https://admin.murage.test/v1/machines/${HOME}/enroll`, {
          method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" }, body: JSON.stringify({ token: tokens[0] }) }), fixtureEnv(), ctx);
        await waitOnExecutionContext(ctx); expect(enrolled.status).toBe(200);
        expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null });
      });
    }
  }

  it("the stored token is wrapped, never plain, and a retry after the first attempt re-delivers it", async () => {
    const tokens: string[] = []; const make = flaky("create", 1, "before", tokens);
    at(0); await reconcile(make);
    const intent = (await row<{ token_hash: string; token_wrapped: string }>("cloud_provision_intents"))!;
    expect(intent.token_wrapped).toMatch(/^v1\./);
    at(5); await reconcile(make);
    expect(tokens).toHaveLength(2); expect(tokens[0]).toBe(tokens[1]);
    expect(await sha256(tokens[0])).toBe(intent.token_hash);
    for (const table of ["cloud_provision_intents", "cloud_enrollment_tokens", "provision_attempts", "cloud_outbox"]) {
      expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)).not.toContain(tokens[0]);
    }
  });

  it("an expired or missing token is replaced by a fresh one (old revoked) when no server exists yet", async () => {
    const tokens: string[] = []; const make = flaky("create", 1, "before", tokens);
    at(0); await reconcile(make);
    const before = (await row<{ token_hash: string }>("cloud_provision_intents"))!.token_hash;
    await env.DB.prepare("UPDATE cloud_provision_intents SET token_wrapped=NULL WHERE home_id=?").bind(HOME).run(); // e.g. an intent from before this fix
    at(5); await reconcile(make);
    expect(tokens).toHaveLength(2); expect(tokens[1]).not.toBe(tokens[0]);
    const old = await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE hash=?").bind(before).first<{ used_at: number | null }>();
    expect(old?.used_at).not.toBeNull();
    expect((await row<{ desired_state: string }>("cloud_homes"))?.desired_state).toBe("checking");
  });

  it("the staging-only fault flag fails the named step once and is inert outside staging", async () => {
    const stg = { CLOUD_CP0_STAGING: "1", CLOUD_STAGING_FAULT: "create_server:1" };
    at(10); await reconcile(fakeProvider, stg).catch(() => undefined);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning" });
    expect(await row("provision_attempts")).toMatchObject({ attempts: 1, last_error: "injected_fault" });
    at(20); await reconcile(fakeProvider, stg);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    expect(await live("home")).toHaveLength(1);
  });

  it("the fault flag is ignored when the Worker is not staging", async () => {
    at(0); await reconcile(fakeProvider, { CLOUD_STAGING_FAULT: "create_server:3" });
    expect((await row<{ desired_state: string }>("cloud_homes"))?.desired_state).toBe("checking");
  });
});

describe("giving up after the budget", () => {
  const failingForever = (step: "create" | "attach_volume"): Make => (db) => { const p = fakeProvider(db);
    return { ...p, [step]: async () => { throw new Error("synthetic provider outage"); } } as ProviderAdapter; };

  it.each(["create", "attach_volume"] as const)("%s never recovers: after the attempt limit the home fails, resources are released and the full payment is refunded", async (step) => {
    const make = failingForever(step);
    for (let i = 0; i < PROVISION_MAX_ATTEMPTS + 2; i++) { at(i * 10); await reconcile(make).catch(() => undefined); }
    // The fake ledger settled the refund; journey A6 then retires the failed home (deleted), which frees its owner's slot for a new reservation.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "deleted", entitlement: "refunded" });
    expect(await row("provision_attempts")).toMatchObject({ attempts: PROVISION_MAX_ATTEMPTS, give_up_code: "provider_error" });
    expect(await row("provision_attempts")).toMatchObject({ cleaned_at: expect.any(Number) });
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0); // no server or volume left behind
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_refunds").all()).results).toHaveLength(1);
    const refunds = (await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE kind='refund_required'").all<{ payload: string }>()).results;
    expect(refunds).toHaveLength(1); expect(JSON.parse(refunds[0].payload)).toMatchObject({ paymentId: PAYMENT.paymentId });
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "failed" });
    expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE machine_id=?").bind(HOME).first<{ used_at: number | null }>())?.used_at).not.toBeNull();
    const alert = await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE home_id=?").bind(HOME).first();
    expect(alert).toMatchObject({ kind: "provision.failed", severity: "high" });
    // A further sweep changes nothing (idempotent).
    at(80); await reconcile(make);
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_refunds").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM cloud_alerts").all()).results).toHaveLength(1);
  });

  it("follow-up 1 #3: a provider refusal keeps its own message, sanitized, in last_error_detail and the provision.failed alert, never the customer notice", async () => {
    const said = "Server limit exceeded for project 1234567 (ops-owner@example.com, token=hzTok3nAbCdEf123456789xyz) from 203.0.113.9";
    const make = (db: D1Database): ProviderAdapter => ({ ...fakeProvider(db), async create() { throw new HostError(403, "resource_limit_exceeded", said); } });
    at(0); await reconcile(make).catch(() => undefined);
    const clean = "Server limit exceeded for project [id] ([email], token=[redacted]) from [ip]";
    expect(await row("provision_attempts")).toMatchObject({ attempts: 1, last_error: "host_403_resource_limit_exceeded", last_error_detail: clean });
    for (let i = 1; i < PROVISION_MAX_ATTEMPTS + 1; i++) { at(i * 10); await reconcile(make).catch(() => undefined); }
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "host_403_resource_limit_exceeded", last_error_detail: clean });
    const alert = (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind='provision.failed'").bind(HOME).first<{ detail: string }>())!;
    expect(alert.detail).toContain(`(host_403_resource_limit_exceeded; provider said: ${clean})`);
    for (const leak of ["1234567", "ops-owner@example.com", "hzTok3nAbCdEf123456789xyz", "203.0.113.9"]) expect(alert.detail).not.toContain(leak);
    // The customer-facing notice carries the code only, never the provider's words.
    const notice = (await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE kind='provision_failed'").first<{ payload: string }>())!;
    expect(notice.payload).not.toContain("provider said"); expect(notice.payload).not.toContain("Server limit");
  });

  it("a home that only ever waits (no error) is given up on at the time limit", async () => {
    const pending = (db: D1Database): ProviderAdapter => { const p = fakeProvider(db);
      return { ...p, async attach_volume(volumeId: string, serverId: string) { const v = await p.attach_volume(volumeId, serverId);
        return { ...v, attachment: { serverId, state: "attaching" as const } }; } }; };
    at(0); await reconcile(pending);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning" });
    at(PROVISION_MAX_MS / MIN - 1); await reconcile(pending);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning" });
    at(PROVISION_MAX_MS / MIN); await reconcile(pending);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "provision_timeout" });
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  it("a server that boots but never becomes healthy is given up on and refunded at the same limit", async () => {
    at(0); await reconcile(fakeProvider);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    at(PROVISION_MAX_MS / MIN - 1); await reconcile(fakeProvider);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    at(PROVISION_MAX_MS / MIN); await reconcile(fakeProvider);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready" });
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
    expect(await row("cloud_machines")).toMatchObject({ state: "fenced", credential_hash: null });
  });

  it("cleanup that fails is retried by later sweeps until the provider shows nothing left", async () => {
    let failDestroy = true;
    const make = (db: D1Database): ProviderAdapter => { const p = fakeProvider(db);
      return { ...p, async create() { throw new Error("synthetic provider outage"); },
        async destroy(id: string) { if (failDestroy) throw new Error("synthetic destroy outage"); return p.destroy(id); } }; };
    for (let i = 0; i < PROVISION_MAX_ATTEMPTS; i++) { at(i * 10); await reconcile(make).catch(() => undefined); }
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed" });
    expect(await row("provision_attempts")).toMatchObject({ cleaned_at: null });
    expect(await live("volume")).toHaveLength(1);
    failDestroy = false; at(40); await reconcile(make);
    expect(await live("volume")).toHaveLength(0);
    expect(await row("provision_attempts")).toMatchObject({ cleaned_at: expect.any(Number) });
  });
});

describe("the customer notice and the Stripe refund (live sweep)", () => {
  it("refunds the payment in full once and sends the plain provision_failed notice", async () => {
    const calls: { path: string; key: string | null; method?: string }[] = [];
    const created: number[] = [];
    const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ path: url.pathname, method: init?.method, key: new Headers(init?.headers).get("idempotency-key") });
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      // The payment names its subscription (Astra MAILRETRY-14 P2-a: without one the plan's end stays open); ending it is confirmed.
      if (url.pathname.startsWith("/v1/invoices/")) return j({ id: "in_retry_1", payment_intent: "pi_retry", charge: "ch_retry", amount_paid: 1900, subscription: "sub_retry" });
      if (url.pathname.startsWith("/v1/subscriptions/")) return j({ id: "sub_retry", status: "canceled" });
      if (url.pathname === "/v1/refunds") return init?.method === "POST" ? (created.push(1), j({ id: "re_retry", status: "succeeded" })) : j({ data: created.length ? [{ id: "re_retry", status: "succeeded", payment_intent: "pi_retry", metadata: { op_id: `no_capacity:${PAYMENT.paymentId}`, submission: "1" } }] : [] });
      return j({ id: "x" });
    };
    const notices: { id: string; kind: string; homeId: string }[] = [];
    const notifier: BillingNotifier = { async notify(_e, n) { notices.push({ id: n.id, kind: n.kind, homeId: n.homeId }); } };
    // Fail the home in fake mode first, but leave its refund to the live sweep: keep the fake ledger from settling it.
    const make = (db: D1Database): ProviderAdapter => ({ ...fakeProvider(db), async create() { throw new Error("synthetic provider outage"); } });
    for (let i = 0; i < PROVISION_MAX_ATTEMPTS; i++) { at(i * 10); await reconcile(make).catch(() => undefined); }
    await env.DB.prepare("UPDATE cloud_outbox SET completed_at=NULL,receipt=NULL WHERE kind='refund_required'").run();
    await env.DB.prepare("UPDATE cloud_homes SET entitlement='refund_pending' WHERE id=?").bind(HOME).run();
    const liveEnv = { ...fixtureEnv(), CLOUD_B3_MODE: "live", STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789",
      BILLING_RETURN_ORIGIN: "https://cloud.murage.test", STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as Env;
    await sweepBilling(liveEnv, { stripeFetch, notifier });
    await sweepBilling(liveEnv, { stripeFetch, notifier });
    expect(calls.filter((c) => c.path === "/v1/refunds" && c.method === "POST")).toEqual([{ path: "/v1/refunds", method: "POST", key: `refundop:no_capacity:${PAYMENT.paymentId}:1` }]);
    // The notice id is stable per payment (Astra MAILRETRY-11), so the real notifier (which records it) sends exactly one email for it.
    expect([...new Set(notices.filter((n) => n.kind === "provision_failed").map((n) => n.id))]).toEqual([`provision_failed:${HOME}:final:${PAYMENT.paymentId}`]);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
  });

  it("the email says plainly what happened and what happens next", async () => {
    await env.DB.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .bind("retry-owner", "Retry", "customer@example.test", 1, NOW, NOW).run();
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailEnv = { ...fixtureEnv(), EMAIL: { async send(m: { to: string; subject: string; text: string }) { sent.push(m); } } } as unknown as Env;
    await defaultNotifier.notify(mailEnv, { id: `provision_failed:${HOME}:final`, homeId: HOME, ownerId: "retry-owner", kind: "provision_failed", data: {} },
      (await acquireHomeLease(env, HOME, "notice-test"))!);
    expect(sent).toHaveLength(1); expect(sent[0].to).toBe("customer@example.test");
    expect(sent[0].subject).toMatch(/could not set up your home.*refunded/);
    // With no evidence read (the bare notice), nothing unconfirmed is promised (Astra JOURNEY-A-10 #5).
    expect(sent[0].text).toMatch(/refund is being processed/); expect(sent[0].text).toMatch(/once this is finished/);
    expect(sent[0].text).not.toMatch(/will not be billed again|we have removed it|whenever you like|has been cancelled/);
  });
  it("Astra JOURNEY-A-10 #5: the failed-setup email is worded from confirmed evidence; anything unresolved is said plainly as in progress", async () => {
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,1,'retry-owner','provision_failed','{"refunded":true}',?)`)
      .bind(`provision_failed:${HOME}`, HOME, NOW).run();
    await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,'cus_r','sub_r','starter','active',1,1)")
      .bind(HOME).run();
    // The probe: refund queued, subscription still active at Stripe, home not yet removed. The old email said all three were done.
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='failed',entitlement='refund_pending' WHERE id=?").bind(HOME).run();
    const early = await provisionFailedEmail(env, HOME);
    expect(early.emailText).toMatch(/Your refund is being processed\./);
    expect(early.emailText).toMatch(/We are cancelling your subscription now\./);
    expect(early.emailText).toMatch(/We are removing it now\./);
    expect(early.emailText).toMatch(/You can start again from your Murage Cloud account once this is finished\./);
    expect(early.emailText).not.toMatch(/will not be billed again|we have removed it|whenever you like|has been refunded/);
    // Everything confirmed: refunded (no refund operation open), cancelled at Stripe, the home retired (released and settled).
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted',entitlement='refunded' WHERE id=?").bind(HOME).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    // INTEGRATED-2 RULE A: a local canceled alone is not Stripe's end: still "cancelling now".
    expect((await provisionFailedEmail(env, HOME)).emailText).toMatch(/We are cancelling your subscription now\./);
    await env.DB.prepare("UPDATE billing_subscriptions SET stripe_end_confirmed=subscription_id WHERE home_id=?").bind(HOME).run();
    const done = await provisionFailedEmail(env, HOME);
    expect(done.emailSubject).toMatch(/your payment was refunded$/);
    expect(done.emailText).toMatch(/Your payment has been refunded in full/);
    expect(done.emailText).toMatch(/Your subscription is cancelled, so you will not be billed again\./);
    expect(done.emailText).toMatch(/we have removed it\./);
    expect(done.emailText).toMatch(/try again from your Murage Cloud account whenever you like/);
    // A refund operation still open is never "refunded".
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at) VALUES ('op_r','no_capacity',?,'retry-owner','in_r',1,'{}',1,1)`)
      .bind(HOME).run();
    expect((await provisionFailedEmail(env, HOME)).emailText).toMatch(/Your refund is being processed\./);
  });
});

describe("Astra INTEGRATED-5 #4: quoted credentials never survive sanitizing, whatever their length", () => {
  it("redacts the value of a credential key in every quoting form, and any Bearer/Basic credential", () => {
    const cases: [string, string][] = [
      ['api_key: "short-secret" was rejected', 'api_key: [redacted] was rejected'],
      ['bad request {"token":"short-secret"}', 'bad request {"token":[redacted]}'],
      ["login failed password='short-secret'", "login failed password=[redacted]"],
      ['{"password":"a\\"b c"} refused', '{"password":[redacted]} refused'],
      ["x-api-key=abc; apikey: 'k1' passwd=pw cookie: sid=1 secret=s", "x-api-key=[redacted]; apikey: [redacted] passwd=[redacted] cookie: [redacted] secret=[redacted]"],
      ["Authorization: Bearer abc", "Authorization: [redacted] [redacted]"],
      ['header "Bearer short" refused', 'header "Bearer [redacted]" refused'],
      ["Basic dXNlcjpwYXNz denied", "Basic [redacted] denied"],
      ['{"key":"k"}', '{"key":[redacted]}'],
    ];
    for (const [raw, clean] of cases) {
      const out = sanitizeProviderMessage(raw);
      expect(out).toBe(clean);
      for (const leak of ["short-secret", "abc", "dXNlcjpwYXNz", "pw ", "a\\\"b"]) if (!clean.includes(leak)) expect(out).not.toContain(leak);
    }
  });
  it("keeps the id, email, IP and long-token rules, and leaves a benign message intact", () => {
    expect(sanitizeProviderMessage("Server type cx22 is unavailable in location fsn1, try again later"))
      .toBe("Server type cx22 is unavailable in location fsn1, try again later");
    expect(sanitizeProviderMessage("project 1234567 owner ops@example.com from 203.0.113.9 ref hzTok3nAbCdEf123456789xyz"))
      .toBe("project [id] owner [email] from [ip] ref [token]");
  });
});

const liveEnv = () => ({ ...fixtureEnv(), CLOUD_B3_MODE: "live", STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789",
  BILLING_RETURN_ORIGIN: "https://cloud.murage.test", STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as Env);

describe("Astra MAILRETRY-8: the overdue give-up pass runs before the per-home work order", () => {
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(HOME).first<{ n: number }>())!.n;
  const refunds = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='refund_required'");
  const failedNotices = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='provision_failed'");
  const alerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=? AND kind='provision.failed'");
  const reconcileFailures = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='reconcile_failed'");
  /** The fake provider, recording every give-up's cleanup (releaseFailedResources lists the home's servers) of HOME. */
  function recording(cleanups: number[]): Make {
    return (db) => { const p = fakeProvider(db);
      return { ...p, async list_by_tag(homeId, generation, role) {
        if (homeId === HOME && role === "home") cleanups.push(Date.now());
        return p.list_by_tag(homeId, generation, role);
      } };
    };
  }
  async function checking() {
    at(0); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
  }

  it("idempotent: two overlapping runs and a third later give the overdue home up once: one refund obligation, one email, one alert", async () => {
    await checking();
    at(PROVISION_MAX_MS / MIN);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await Promise.all([reconcile(fakeProvider), reconcile(fakeProvider)]);
    at(PROVISION_MAX_MS / MIN + 5); await reconcile(fakeProvider);
    // Refunded (the fake ledger), and possibly already retired (deleted) by the later run: never given up a second time.
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready", gave_up_at: NOW + PROVISION_MAX_MS });
    expect(await refunds()).toBe(1);
    expect(await failedNotices()).toBe(1);
    expect(await alerts()).toBe(1);
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
    // Astra MAILRETRY-9 (e): what reaches the customer and ops, not only the obligation rows. The refund was paid out once (the fake ledger:
    // one refund for the payment, and the live sweep finds nothing left to refund), one email, one webhook delivery of the alert.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_fake_refunds WHERE payment_id=?").bind(PAYMENT.paymentId).first<{ n: number }>())!.n).toBe(1);
    const posts: string[] = [];
    const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ id: "x", data: [] }), { status: 200 });
    };
    // The real notifier (claims under the home's lease), sending through a recording mail binding: two overlapping sweeps and a third.
    await env.DB.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .bind("retry-owner", "Retry", "customer@example.test", 1, NOW, NOW).run();
    const sent: string[] = [];
    const mailEnv = () => ({ ...liveEnv(), EMAIL: { async send(m: { subject: string }) { sent.push(m.subject); } } } as unknown as Env);
    await Promise.all([sweepBilling(mailEnv(), { stripeFetch }).catch(() => undefined), sweepBilling(mailEnv(), { stripeFetch }).catch(() => undefined)]);
    await sweepBilling(mailEnv(), { stripeFetch }).catch(() => undefined);
    expect(posts.filter((x) => x === "/v1/refunds")).toEqual([]);
    expect(sent.filter((x) => /could not set up your home/.test(x))).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM billing_notices WHERE home_id=? AND kind='provision_failed' AND sent_at IS NOT NULL")).toBe(1);
    const hooks: string[] = [];
    const hook = (async (_url: string, init?: RequestInit) => { hooks.push((JSON.parse(String(init?.body)) as { kind: string }).kind); return new Response("ok"); }) as unknown as typeof fetch;
    for (const minute of [1, 2]) await sweepMonitoring(fixtureEnv({ ALERT_WEBHOOK_URL: "https://ops.murage.test/hook" }), NOW + PROVISION_MAX_MS + (5 + minute) * MIN, hook);
    expect(hooks.filter((k) => k === "provision.failed")).toHaveLength(1);
  });

  it("a home given up by the pass is not reprocessed as checking by the same run's page: one give-up, one cleanup, no failure", async () => {
    await checking();
    const cleanups: number[] = [];
    at(PROVISION_MAX_MS / MIN);
    const r = await reconcile(recording(cleanups));
    expect(r.status).toBe(200); // a second giveUp of the page (its fenced batch matching nothing) would fail the run
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready", cleaned_at: NOW + PROVISION_MAX_MS });
    // The pass released the resources once; the page saw a failed, clean home (no second release).
    expect(cleanups).toEqual([NOW + PROVISION_MAX_MS, NOW + PROVISION_MAX_MS]);
    expect(await refunds()).toBe(1);
    expect(await alerts()).toBe(1);
    expect(await reconcileFailures()).toBe(0);
  });
});

describe("Astra MAILRETRY-9: give-ups commit atomically with their alert; never-attempted paid homes; failures after the commit are not silent", () => {
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(HOME).first<{ n: number }>())!.n;
  const refunds = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='refund_required'");
  const failedNotices = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='provision_failed'");
  const alerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=? AND kind='provision.failed'");
  const logged = (spy: { mock: { calls: unknown[][] } }, message: string) =>
    spy.mock.calls.map((c) => JSON.parse(String(c[0])) as { message: string; homeId?: string; errorCode?: string }).filter((x) => x.message === message);
  /** The fake provider, counting provision() attempts (create_volume is its first provider step). */
  function counting(n: { creates: number }): Make { return (db) => { const p = fakeProvider(db);
    return { ...p, async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { n.creates++; return p.create_volume(...a); } }; }; }

  it("(c) a paid home never attempted for 60 minutes is given up with provision_never_attempted: refund obligation, email and alert in one batch; provision() never runs for it", async () => {
    const n = { creates: 0 };
    const batches: number[] = [];
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation(async (stmts) => { batches.push(stmts.length); return batch(stmts); });
    at(PROVISION_MAX_MS / MIN);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect(await row("provision_attempts")).toMatchObject({ attempts: 0, give_up_code: "provision_never_attempted", gave_up_at: NOW + PROVISION_MAX_MS,
      cleaned_at: NOW + PROVISION_MAX_MS });
    expect(n.creates).toBe(0); // the same run's page saw a failed home: no provisioning for a home whose payment is being refunded
    expect(await refunds()).toBe(1); expect(await failedNotices()).toBe(1); expect(await alerts()).toBe(1);
    const alert = (await env.DB.prepare("SELECT detail,delivered_at FROM cloud_alerts WHERE home_id=?").bind(HOME).first<{ detail: string; delivered_at: number | null }>())!;
    expect(alert.detail).toContain("provision_never_attempted"); expect(alert.delivered_at).toBeNull(); // persisted; the monitoring sweep delivers it
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  it("(c) younger than 60 minutes: untouched by the pass; provision() handles it in the same run, and its own budget starts then", async () => {
    const n = { creates: 0 };
    at(PROVISION_MAX_MS / MIN - 1);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(n.creates).toBe(1);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid" });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null, first_at: NOW + PROVISION_MAX_MS - MIN });
    at(PROVISION_MAX_MS / MIN + 1); // past 60 minutes from the payment, but the budget opened at minute 59: not overdue
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    expect(await refunds()).toBe(0); expect(await alerts()).toBe(0);
  });

  it("(c) overlapping runs over a never-attempted overdue home: given up once, never provisioned, budget not re-opened", async () => {
    const n = { creates: 0 };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    at(PROVISION_MAX_MS / MIN);
    await Promise.all([reconcile(counting(n)), reconcile(counting(n))]);
    at(PROVISION_MAX_MS / MIN + 5); await reconcile(counting(n));
    expect(n.creates).toBe(0);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "provision_never_attempted", gave_up_at: NOW + PROVISION_MAX_MS });
    expect(await refunds()).toBe(1); expect(await failedNotices()).toBe(1); expect(await alerts()).toBe(1);
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  it("(d) the pass's cleanup fails after the commit: logged with its errorCode, and the failed-home branch cleans the home", async () => {
    at(0); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking" });
    let failNext = true;
    const make: Make = (db) => { const p = fakeProvider(db);
      return { ...p, async destroy(id: string) { if (failNext) { failNext = false; throw new Error("synthetic destroy outage"); } return p.destroy(id); } }; };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    at(PROVISION_MAX_MS / MIN);
    expect((await reconcile(make)).status).toBe(200);
    expect(logged(errors, "b3 overdue cleanup failed")).toEqual([{ message: "b3 overdue cleanup failed", homeId: HOME, errorCode: "synthetic destroy outage" }]);
    // The obligations were already committed; the same run's page (failed-home branch) released the resources.
    expect(await refunds()).toBe(1); expect(await alerts()).toBe(1);
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready", cleaned_at: NOW + PROVISION_MAX_MS });
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  it("(d) the give-up batch commits but its answer is lost: reported, not a stale fence; every obligation and the alert are there and the home is cleaned", async () => {
    at(0); expect((await reconcile(fakeProvider)).status).toBe(200);
    const refundStatements = new WeakSet<object>();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const st = prepare(sql);
      if (!sql.includes("'refund_required'") || !sql.startsWith("INSERT INTO cloud_outbox")) return st;
      const bind = st.bind.bind(st);
      st.bind = (...v: unknown[]) => { const b = bind(...v); refundStatements.add(b); return b; };
      return st;
    });
    let lose = true;
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation(async (stmts) => {
      const res = await batch(stmts);
      if (lose && stmts.some((x) => refundStatements.has(x))) { lose = false; throw new Error("d1_response_lost"); }
      return res;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    at(PROVISION_MAX_MS / MIN);
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(lose).toBe(false);
    expect(logged(errors, "b3 overdue give-up outcome unconfirmed")).toEqual([{ message: "b3 overdue give-up outcome unconfirmed", homeId: HOME, state: "checking", errorCode: "d1_response_lost" }]);
    expect(await refunds()).toBe(1); expect(await failedNotices()).toBe(1); expect(await alerts()).toBe(1);
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready", cleaned_at: NOW + PROVISION_MAX_MS });
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });
});

describe("Astra MAILRETRY-10: payment identity fences the overdue give-up, re-provisioning and the per-payment refund obligation", () => {
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(HOME).first<{ n: number }>())!.n;
  const refunds = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='refund_required'");
  const failedNotices = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='provision_failed'");
  const alerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=? AND kind='provision.failed'");
  const reconcileFailures = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='reconcile_failed'");
  const handOffs = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='payment_paid'");
  const unprocessed = () => count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id=? AND processed_at IS NULL");
  const obligations = async () => (await env.DB.prepare(`SELECT id,completed_at,json_extract(payload,'$.paymentId') AS paymentId FROM cloud_outbox
    WHERE home_id=? AND kind='refund_required' ORDER BY rowid`).bind(HOME).all<{ id: string; completed_at: number | null; paymentId: string }>()).results;
  const paidOut = async () => (await env.DB.prepare("SELECT payment_id FROM cloud_fake_refunds ORDER BY payment_id").all<{ payment_id: string }>()).results.map((r) => r.payment_id);
  const key = (paymentId: string) => `refund:provision_failed:${HOME}:${paymentId}`;
  function counting(n: { creates: number }): Make { return (db) => { const p = fakeProvider(db);
    return { ...p, async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { n.creates++; return p.create_volume(...a); } }; }; }
  /** A lifecycle payment event journaled in the inbox (processPayments' input), received now. */
  const journal = (p: typeof PAYMENT) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify(p), Date.now()).run();
  /** The state code before this change could leave: a later event of the SAME invoice restored paid/provisioning after the give-up. */
  async function oldCodeReopen(version: number) {
    const p = { ...PAYMENT, eventId: `evt-retry-v${version}`, version };
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET desired_state='provisioning',observed_state='reserved',entitlement='paid',payment_version=? WHERE id=?").bind(version, HOME),
      env.DB.prepare("UPDATE cloud_capacity SET home_id=?,expires_at=NULL WHERE id='retry-slot'").bind(HOME),
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,1,'retry-owner','payment_paid',?,?)")
        .bind(`payment:${p.eventId}`, HOME, JSON.stringify(p), Date.now()),
    ]);
  }
  /** Hold the home's billing lease, so journey A6 cannot retire the failed home (the customer is mid-checkout, say). */
  const holdRetirement = async () => expect(await acquireHomeLease(env, HOME, "mailretry-10-hold")).not.toBeNull();

  it("P1-1: the pass selects a never-attempted home, then an overlapping run opens its budget and takes its lease: the pass's give-up batch matches nothing", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    const upserts = new WeakSet<object>();
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const st = prepare(sql);
      if (!sql.startsWith("INSERT INTO provision_attempts (home_id,resource_generation,first_at,gave_up_at")) return st;
      const bind = st.bind.bind(st);
      st.bind = (...v: unknown[]) => { const b = bind(...v); upserts.add(b); return b; };
      return st;
    });
    let interleaved = false;
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation(async (stmts) => {
      if (!interleaved && stmts.some((x) => upserts.has(x))) {
        interleaved = true; // invocation A, between the pass's SELECT and its batch: a one-minute-old budget and an unexpired lease
        await prepare("INSERT INTO provision_attempts (home_id,resource_generation,first_at,next_at) VALUES (?,1,?,?)").bind(HOME, Date.now() - MIN, Date.now() + MIN).run();
      }
      return batch(stmts);
    });
    const n = { creates: 0 };
    at(PROVISION_MAX_MS / MIN);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(interleaved).toBe(true);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning", entitlement: "paid" });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null, give_up_code: null, first_at: NOW + PROVISION_MAX_MS - MIN });
    expect(await refunds()).toBe(0); expect(await failedNotices()).toBe(0); expect(await alerts()).toBe(0);
    expect(n.creates).toBe(0); // the page's provision() found A's lease held
    expect(await reconcileFailures()).toBe(0);
  });

  it("P1-2: after a never-attempted give-up, a journaled higher-version event of the SAME invoice restores nothing, and an exact replay is harmless", async () => {
    const n = { creates: 0 };
    at(PROVISION_MAX_MS / MIN);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 1 });
    await journal({ ...PAYMENT, eventId: "evt-retry-v2", version: 2 });
    await journal(PAYMENT);
    at(PROVISION_MAX_MS / MIN + 1);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(n.creates).toBe(0);
    expect(await unprocessed()).toBe(0); expect(await handOffs()).toBe(1);
    const h = (await row<{ desired_state: string; entitlement: string; payment_version: number }>("cloud_homes"))!;
    // MAILRETRY-11 P1-B: the later event's version is recorded (payment_version 2), with no other effect; the refund still completes.
    expect(h).toMatchObject({ entitlement: "refunded", payment_version: 2 });
    expect(["failed", "deleted"]).toContain(h.desired_state);
    expect(await obligations()).toEqual([{ id: key(PAYMENT.paymentId), completed_at: NOW + PROVISION_MAX_MS + MIN, paymentId: PAYMENT.paymentId }]);
    expect(await paidOut()).toEqual([PAYMENT.paymentId]);
  });

  it("P1-2: provision() refuses to re-open the budget for a payment whose refund is outstanding (state an earlier build could leave)", async () => {
    const failing: Make = (db) => { const p = fakeProvider(db); return { ...p, async create() { throw new Error("synthetic provider outage"); } } as ProviderAdapter; };
    for (let i = 0; i < PROVISION_MAX_ATTEMPTS; i++) { at(i * 10); await reconcile(failing).catch(() => undefined); }
    expect(await row("provision_attempts")).toMatchObject({ attempts: PROVISION_MAX_ATTEMPTS, gave_up_at: NOW + 40 * MIN });
    await holdRetirement();
    at(41); await oldCodeReopen(2);
    const n = { creates: 0 };
    at(42); // 42 minutes after the payment was accepted: not overdue, so only provision() decides
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(n.creates).toBe(0);
    expect(await row("provision_attempts")).toMatchObject({ attempts: PROVISION_MAX_ATTEMPTS, gave_up_at: NOW + 40 * MIN });
    expect(await obligations()).toHaveLength(1);
    expect(await paidOut()).toEqual([PAYMENT.paymentId]);
  });

  it("P1-3 and repeated cycles: pay, give up, refund, pay again (a new invoice) and provision; that payment times out too and gets its OWN obligation; the first is untouched", async () => {
    const n = { creates: 0 };
    at(PROVISION_MAX_MS / MIN); expect((await reconcile(counting(n))).status).toBe(200);
    await holdRetirement();
    at(PROVISION_MAX_MS / MIN + 1); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded" });
    expect(await row("provision_attempts")).toMatchObject({ cleaned_at: expect.any(Number) });
    const first = await obligations();
    expect(first).toEqual([{ id: key(PAYMENT.paymentId), completed_at: NOW + PROVISION_MAX_MS + MIN, paymentId: PAYMENT.paymentId }]);
    // A genuinely new payment (another invoice), before retirement: provisioning is allowed, with a fresh budget.
    const second = { eventId: "evt-retry-q", homeId: HOME, version: 2, status: "paid", paymentId: "in_retry_2" };
    at(PROVISION_MAX_MS / MIN + 2); await journal(second);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(n.creates).toBe(1);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null, first_at: NOW + PROVISION_MAX_MS + 2 * MIN, cleaned_at: null });
    expect(await live("home")).toHaveLength(1); expect(await live("volume")).toHaveLength(1);
    // The second payment's home never becomes ready: given up at its own deadline, with its own obligation.
    at(2 * PROVISION_MAX_MS / MIN + 2); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready", gave_up_at: NOW + 2 * PROVISION_MAX_MS + 2 * MIN });
    expect(await obligations()).toEqual([first[0], { id: key("in_retry_2"), completed_at: null, paymentId: "in_retry_2" }]);
    at(2 * PROVISION_MAX_MS / MIN + 3); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    expect(await paidOut()).toEqual([PAYMENT.paymentId, "in_retry_2"]);
    expect((await obligations())[0]).toEqual(first[0]);
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  it("deploy boundary: a give-up committed under the old home-scoped key is never given up (refunded) again under the per-payment key, by the pass or by a later event", async () => {
    const n = { creates: 0 };
    at(PROVISION_MAX_MS / MIN); expect((await reconcile(counting(n))).status).toBe(200);
    // As committed before this change: the same obligation, keyed refund:provision_failed:<home>.
    await env.DB.prepare("UPDATE cloud_outbox SET id=? WHERE id=?").bind(`refund:provision_failed:${HOME}`, key(PAYMENT.paymentId)).run();
    await holdRetirement();
    at(PROVISION_MAX_MS / MIN + 1); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded" });
    // An earlier build let a later event of the same invoice restore paid/provisioning; the pass finds it overdue (its payment's own clock).
    at(PROVISION_MAX_MS / MIN + 2); await oldCodeReopen(2);
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 2 });
    expect(await obligations()).toEqual([{ id: `refund:provision_failed:${HOME}`, completed_at: NOW + PROVISION_MAX_MS + MIN, paymentId: PAYMENT.paymentId }]);
    // And a still later event of the same invoice through the lifecycle inbox: handled with no effect.
    at(PROVISION_MAX_MS / MIN + 3); await journal({ ...PAYMENT, eventId: "evt-retry-v3", version: 3 });
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await unprocessed()).toBe(0);
    // MAILRETRY-11 P1-B: handled with no effect but its version (3), so nothing older can apply after it.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 3 });
    expect(await obligations()).toHaveLength(1);
    expect(await paidOut()).toEqual([PAYMENT.paymentId]);
    expect(n.creates).toBe(0);
  });
});

describe("Astra MAILRETRY-11: each payment given up gets its own email, notice and alert; a non-paid event never overwrites a given-up payment's refund", () => {
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(HOME).first<{ n: number }>())!.n;
  const unprocessed = () => count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id=? AND processed_at IS NULL");
  const emails = async () => (await env.DB.prepare("SELECT id,created_at,payload FROM cloud_outbox WHERE home_id=? AND kind='provision_failed' ORDER BY rowid")
    .bind(HOME).all<{ id: string; created_at: number; payload: string }>()).results;
  const alertRows = async () => (await env.DB.prepare(`SELECT id,subject,detail,raised_at,resolved_at,delivered_at,delivery_attempts FROM cloud_alerts
    WHERE home_id=? AND kind='provision.failed' ORDER BY raised_at,rowid`).bind(HOME)
    .all<{ id: string; subject: string; detail: string; raised_at: number; resolved_at: number | null; delivered_at: number | null; delivery_attempts: number }>()).results;
  const obligations = async () => (await env.DB.prepare(`SELECT id,completed_at,json_extract(payload,'$.paymentId') AS paymentId FROM cloud_outbox
    WHERE home_id=? AND kind='refund_required' ORDER BY rowid`).bind(HOME).all<{ id: string; completed_at: number | null; paymentId: string }>()).results;
  const paidOut = async () => (await env.DB.prepare("SELECT payment_id FROM cloud_fake_refunds ORDER BY payment_id").all<{ payment_id: string }>()).results.map((r) => r.payment_id);
  const journal = (p: { eventId: string; version: number; status: string; paymentId: string }) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify({ ...p, homeId: HOME }), Date.now()).run();
  const holdRetirement = async () => expect(await acquireHomeLease(env, HOME, "mailretry-11-hold")).not.toBeNull();
  const SECOND = { eventId: "evt-retry-q", homeId: HOME, version: 2, status: "paid", paymentId: "in_retry_2" };
  const T = PROVISION_MAX_MS / MIN;
  /** Every provision_failed notice the billing sweep sends now (a recording notifier; nothing else is sent anywhere). */
  async function sweepNotices() {
    const sent: string[] = [];
    const notifier: BillingNotifier = { async notify(_e, n) { if (n.kind === "provision_failed") sent.push(n.id); } };
    // The retirement hold is the home's billing lease, which the notice itself needs: released for the sweep, held again after it.
    await env.DB.prepare("DELETE FROM billing_home_leases WHERE home_id=?").bind(HOME).run();
    await sweepBilling(liveEnv(), { stripeFetch: async () => new Response(JSON.stringify({ id: "x", data: [] }), { status: 200 }), notifier });
    await holdRetirement();
    return sent.sort();
  }
  /** Payment A given up (never attempted) and refunded; the home kept from retirement. */
  async function firstGivenUpAndRefunded() {
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    await holdRetirement();
    at(T + 1); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded" });
  }

  it("payment B given up after payment A: B gets its own email row, notice, alert and refund; A's rows are untouched", async () => {
    await firstGivenUpAndRefunded();
    const a = { emails: await emails(), alerts: await alertRows(), obligations: await obligations() };
    expect(a.emails.map((e) => e.id)).toEqual([`provision_failed:${HOME}:${PAYMENT.paymentId}`]);
    expect(JSON.parse(a.emails[0].payload)).toMatchObject({ paymentId: PAYMENT.paymentId, refunded: true });
    expect(a.alerts).toHaveLength(1); expect(a.alerts[0].detail).toContain(`[payment ${PAYMENT.paymentId}]`);
    at(T + 2); await journal(SECOND);
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    at(2 * T + 2); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    const e = await emails();
    expect(e.map((x) => x.id)).toEqual([`provision_failed:${HOME}:${PAYMENT.paymentId}`, `provision_failed:${HOME}:in_retry_2`]);
    expect(e[0]).toEqual(a.emails[0]);
    expect(JSON.parse(e[1].payload)).toMatchObject({ paymentId: "in_retry_2", refunded: true, code: "home_never_ready" });
    // One alert per payment (MAILRETRY-11 P2-B): A's stays exactly as it was (open, never resolved, its text not copied); B's own row only
    // references it by id.
    const al = await alertRows();
    expect(al).toHaveLength(2);
    expect(al[0]).toEqual(a.alerts[0]);
    expect(al[0]).toMatchObject({ subject: PAYMENT.paymentId, resolved_at: null });
    expect(al[1]).toMatchObject({ subject: "in_retry_2", resolved_at: null, delivered_at: null, delivery_attempts: 0, raised_at: NOW + 2 * PROVISION_MAX_MS + 2 * MIN });
    expect(al[1].detail).toBe(`${al[1].detail.split(" | ")[0]} | earlier payment ${PAYMENT.paymentId} also failed; see alert ${al[0].id}`);
    expect(al[1].detail.split(" | ")[0]).toMatch(/^home given up .*\[payment in_retry_2\]$/);
    expect((await obligations()).map((o) => o.id)).toEqual([...a.obligations.map((o) => o.id), `refund:provision_failed:${HOME}:in_retry_2`]);
    expect((await obligations())[0]).toEqual(a.obligations[0]);
    at(2 * T + 3); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    expect(await paidOut()).toEqual([PAYMENT.paymentId, "in_retry_2"]);
    expect(await emails()).toHaveLength(2); expect(await alertRows()).toHaveLength(2);
    expect(await sweepNotices()).toEqual([`provision_failed:${HOME}:final:${PAYMENT.paymentId}`, `provision_failed:${HOME}:final:in_retry_2`]);
  });

  it("deploy boundary: an old home-scoped email row stands for its own payment only; a delivered alert of A is closed, B's is raised alone", async () => {
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    // As committed before this change (56a15e901 giveUp): the email row keyed provision_failed:<home> (no payment in it) and the refund keyed
    // refund:provision_failed:<home> (MAILRETRY-11 P2-A: the legacy email belongs to the payment of the legacy refund key), its notice sent,
    // its alert delivered.
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_outbox SET id=?,payload=? WHERE id=?").bind(`provision_failed:${HOME}`, JSON.stringify({ code: "provision_never_attempted", attempts: 0, refunded: true }),
        `provision_failed:${HOME}:${PAYMENT.paymentId}`),
      env.DB.prepare("UPDATE cloud_outbox SET id=? WHERE id=?").bind(`refund:provision_failed:${HOME}`, `refund:provision_failed:${HOME}:${PAYMENT.paymentId}`),
      env.DB.prepare("UPDATE cloud_alerts SET subject='',detail='home given up after 0 failed attempts (provision_never_attempted); full refund queued',delivered_at=?,delivery_attempts=1 WHERE home_id=?")
        .bind(NOW + PROVISION_MAX_MS, HOME),
      env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,sent_at) VALUES (?,?,'provision_failed','{}',?,?)")
        .bind(`provision_failed:${HOME}:final`, HOME, NOW + PROVISION_MAX_MS, NOW + PROVISION_MAX_MS),
    ]);
    await holdRetirement();
    at(T + 1); expect((await reconcile(fakeProvider)).status).toBe(200);
    // An earlier build let a later event of the SAME invoice restore paid/provisioning; the pass gives A up again: no second email, no alert.
    at(T + 2);
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET desired_state='provisioning',observed_state='reserved',entitlement='paid',payment_version=2 WHERE id=?").bind(HOME),
      env.DB.prepare("UPDATE cloud_capacity SET home_id=?,expires_at=NULL WHERE id='retry-slot'").bind(HOME),
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('payment:evt-retry-v2',?,1,'retry-owner','payment_paid',?,?)")
        .bind(HOME, JSON.stringify({ ...PAYMENT, eventId: "evt-retry-v2", version: 2 }), Date.now()),
    ]);
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 2 });
    expect((await emails()).map((e) => e.id)).toEqual([`provision_failed:${HOME}`]);
    expect(await alertRows()).toHaveLength(1);
    expect(await sweepNotices()).toEqual([]);
    // A new payment B (another invoice) given up: its own email and notice; A's delivered alert is closed and B's raised alone.
    const third = { ...SECOND, eventId: "evt-retry-b", version: 3 };
    at(T + 3); await journal(third); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 3 });
    at(2 * T + 3); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect((await emails()).map((e) => e.id)).toEqual([`provision_failed:${HOME}`, `provision_failed:${HOME}:in_retry_2`]);
    const al = await alertRows();
    expect(al).toHaveLength(2);
    // MAILRETRY-11 P2-B: A's delivered (pre-change, subject '') alert is left open, never closed as if resolved; B's references it by id.
    expect(al[0]).toMatchObject({ subject: "", delivered_at: NOW + PROVISION_MAX_MS, resolved_at: null });
    expect(al[1]).toMatchObject({ subject: "in_retry_2", resolved_at: null, delivered_at: null, delivery_attempts: 0 });
    expect(al[1].detail).toContain("[payment in_retry_2]");
    expect(al[1].detail).toContain(`earlier payment (unrecorded) also failed; see alert ${al[0].id}`);
    expect(al[1].detail).not.toContain(al[0].detail);
    expect(await sweepNotices()).toEqual([`provision_failed:${HOME}:final:in_retry_2`]);
    expect((await obligations()).map((o) => o.paymentId)).toEqual([PAYMENT.paymentId, "in_retry_2"]);
  });

  it("a payment_problem or cancellation for a given-up payment, and a customer cancel while the home rests on it: handled, refund_pending kept, no second refund", async () => {
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 1 });
    await holdRetirement();
    at(T + 1);
    await journal({ eventId: "evt-retry-pp", version: 2, status: "payment_problem", paymentId: PAYMENT.paymentId });
    await journal({ eventId: "evt-retry-rj", version: 3, status: "canceled", paymentId: PAYMENT.paymentId });
    await journal({ eventId: "evt-retry-sub", version: 4, status: "canceled", paymentId: "sub_retry" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await unprocessed()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='payment_problem'")).toBe(0);
    // MAILRETRY-11 P1-B: each event's version is recorded (payment_version 4), nothing else; the refund's completion still marks the home
    // 'refunded' (no other refund obligation open): refunded once, nothing overwritten.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 4 });
    expect((await obligations()).map((o) => o.id)).toEqual([`refund:provision_failed:${HOME}:${PAYMENT.paymentId}`]);
    expect(await paidOut()).toEqual([PAYMENT.paymentId]);
    // A replay later changes nothing either.
    at(T + 2); await journal({ eventId: "evt-retry-sub2", version: 5, status: "canceled", paymentId: "sub_retry" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await unprocessed()).toBe(0);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded", payment_version: 5 });
    expect(await obligations()).toHaveLength(1); expect(await paidOut()).toEqual([PAYMENT.paymentId]);
  });

  it("a newer invoice's non-paid event is handled normally; a late one for the given-up payment still changes nothing", async () => {
    await firstGivenUpAndRefunded();
    at(T + 2); await journal(SECOND); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    at(T + 3); await journal({ eventId: "evt-retry-pp2", version: 3, status: "payment_problem", paymentId: "in_retry_2" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "payment_problem", entitlement: "payment_problem", payment_version: 3 });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='payment_problem'")).toBe(1);
    at(T + 4); await journal({ eventId: "evt-retry-pp1", version: 4, status: "payment_problem", paymentId: PAYMENT.paymentId });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await unprocessed()).toBe(0);
    // MAILRETRY-12 P1: an event of a given-up payment that is not the current one (B is) touches nothing of the home, not even its version
    // (it stays B's 3; was 4 in round 7, which let it make B's own later events stale); it goes to A's own high-water mark only.
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "payment_problem", payment_version: 3 });
    expect(await env.DB.prepare("SELECT payment_id,version FROM cloud_payment_lines WHERE home_id=?").bind(HOME).all()).toMatchObject({ results: [{ payment_id: PAYMENT.paymentId, version: 4 }] });
    expect(await obligations()).toHaveLength(1); expect(await paidOut()).toEqual([PAYMENT.paymentId]);
  });
});

describe("Astra MAILRETRY-11 round 7: payment version orders everything; legacy email by legacy key; alerts per payment", () => {
  const T = PROVISION_MAX_MS / MIN;
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(HOME).first<{ n: number }>())!.n;
  const unprocessed = () => count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id=? AND processed_at IS NULL");
  const handOffs = async () => (await env.DB.prepare("SELECT json_extract(payload,'$.paymentId') AS p FROM cloud_outbox WHERE home_id=? AND kind='payment_paid' ORDER BY rowid")
    .bind(HOME).all<{ p: string }>()).results.map((r) => r.p);
  const obligations = async () => (await env.DB.prepare(`SELECT id,completed_at,json_extract(payload,'$.paymentId') AS paymentId FROM cloud_outbox
    WHERE home_id=? AND kind='refund_required' ORDER BY rowid`).bind(HOME).all<{ id: string; completed_at: number | null; paymentId: string }>()).results;
  const paidOut = async () => (await env.DB.prepare("SELECT payment_id FROM cloud_fake_refunds ORDER BY payment_id").all<{ payment_id: string }>()).results.map((r) => r.payment_id);
  const emails = async () => (await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='provision_failed' ORDER BY rowid").bind(HOME)
    .all<{ id: string }>()).results.map((r) => r.id);
  const alertRows = async () => (await env.DB.prepare(`SELECT id,subject,detail,resolved_at,delivered_at FROM cloud_alerts
    WHERE home_id=? AND kind='provision.failed' ORDER BY raised_at,rowid`).bind(HOME)
    .all<{ id: string; subject: string; detail: string; resolved_at: number | null; delivered_at: number | null }>()).results;
  const journal = (p: { eventId: string; version: number; status: string; paymentId: string }) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify({ ...p, homeId: HOME }), Date.now()).run();
  const holdRetirement = async () => expect(await acquireHomeLease(env, HOME, "mailretry-11-r7-hold")).not.toBeNull();
  const key = (paymentId: string) => `refund:provision_failed:${HOME}:${paymentId}`;
  function counting(n: { creates: number }): Make { return (db) => { const p = fakeProvider(db);
    return { ...p, async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { n.creates++; return p.create_volume(...a); } }; }; }

  it("P1-A: sweep X paused, sweep Y records A's hand-off and gives A up, X accepts invoice B with its earlier now: B is the current payment, keeps its own obligation, A's refund untouched, B not immediately overdue", async () => {
    const n = { creates: 0 };
    // Sweep Y (at T): a higher-version event of the SAME invoice A is accepted (another hand-off for A, created at T), then A is overdue
    // on its own clock (accepted at NOW) and given up.
    await journal({ eventId: "evt-retry-a2", version: 2, status: "paid", paymentId: PAYMENT.paymentId });
    at(T); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await handOffs()).toEqual([PAYMENT.paymentId, PAYMENT.paymentId]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 2 });
    const a = await obligations();
    expect(a).toEqual([{ id: key(PAYMENT.paymentId), completed_at: null, paymentId: PAYMENT.paymentId }]);
    // Sweep X started a minute before Y and was paused: it now accepts the newer invoice B (version 3) with its EARLIER now (T - 1), so
    // B's hand-off is older by time than A's latest one.
    await journal({ eventId: "evt-retry-b3", version: 3, status: "paid", paymentId: "in_retry_b" });
    at(T - 1); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await handOffs()).toEqual([PAYMENT.paymentId, PAYMENT.paymentId, "in_retry_b"]);
    // B is the current payment (highest version): provisioned with a fresh budget, never given up on A's old acceptance time.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 3 });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null, first_at: NOW + (T - 1) * MIN });
    expect(n.creates).toBe(1);
    // A's refund untouched: its one obligation, completed once by the fake ledger; nothing for B.
    expect(await obligations()).toEqual([{ id: key(PAYMENT.paymentId), completed_at: NOW + (T - 1) * MIN, paymentId: PAYMENT.paymentId }]);
    // Half an hour later: still B's, not overdue.
    at(T + 30); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 3 });
    // B never becomes ready: given up at ITS own deadline, with ITS own obligation, refunded; A's untouched.
    at(2 * T - 1); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect((await obligations()).map((o) => o.id)).toEqual([key(PAYMENT.paymentId), key("in_retry_b")]);
    expect((await emails())).toEqual([`provision_failed:${HOME}:${PAYMENT.paymentId}`, `provision_failed:${HOME}:in_retry_b`]);
    await holdRetirement();
    at(2 * T); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    expect(await paidOut()).toEqual(["in_retry_b", PAYMENT.paymentId].sort());
  });

  it("P1-B / INTEGRATED-9: v1 given up, v2 paid queued, v3 cancellation arrives: the cancellation is applied (version 3), v2 is stale and owed back, the home stays given up; a v4 payment after it provisions", async () => {
    const n = { creates: 0 };
    at(T); expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 1 });
    await holdRetirement();
    at(T + 1);
    await journal({ eventId: "evt-retry-b2", version: 2, status: "paid", paymentId: "in_retry_2" });
    await journal({ eventId: "evt-retry-c3", version: 3, status: "canceled", paymentId: "sub_retry" });
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await unprocessed()).toBe(0);
    // The cancellation is the fence: version 3 recorded; the older paid event is stale: no hand-off, no capacity, no provisioning.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 3 });
    expect(await handOffs()).toEqual([PAYMENT.paymentId]);
    expect(n.creates).toBe(0);
    expect((await env.DB.prepare("SELECT home_id FROM cloud_capacity WHERE id='retry-slot'").first<{ home_id: string | null }>())?.home_id).toBeNull();
    // Astra INTEGRATED-9 P1: v2's money was never served and a cancellation (v3) overtook it: owed back on its own (refund:closed_line), never
    // acknowledged away (before: acknowledged with no effect and no refund).
    expect((await obligations()).map((o) => o.id)).toEqual([key(PAYMENT.paymentId), "refund:closed_line:in_retry_2"]);
    expect(await paidOut()).toEqual([PAYMENT.paymentId, "in_retry_2"]);
    // A legitimately newer invoice (version 4, after the cancellation) is paid: it provisions normally.
    at(T + 2); await journal({ eventId: "evt-retry-b4", version: 4, status: "paid", paymentId: "in_retry_4" });
    expect((await reconcile(counting(n))).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 4 });
    expect(await handOffs()).toEqual([PAYMENT.paymentId, "in_retry_4"]);
    expect(n.creates).toBe(1);
    expect(await obligations()).toHaveLength(2);
  });

  it("P2-A: a legacy (home-scoped) email at the same instant as payment B's give-up is A's (its refund carries the legacy key), never B's: B gets its email and alert", async () => {
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    await holdRetirement();
    const bGiveUpAt = NOW + 2 * PROVISION_MAX_MS + 2 * MIN;
    // As committed before the per-payment keys: A's email and refund home-scoped. The email row's time is set to the instant B is given up.
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_outbox SET id=?,payload=?,created_at=? WHERE id=?").bind(`provision_failed:${HOME}`,
        JSON.stringify({ code: "provision_never_attempted", attempts: 0, refunded: true }), bGiveUpAt, `provision_failed:${HOME}:${PAYMENT.paymentId}`),
      env.DB.prepare("UPDATE cloud_outbox SET id=? WHERE id=?").bind(`refund:provision_failed:${HOME}`, key(PAYMENT.paymentId)),
    ]);
    at(T + 1); expect((await reconcile(fakeProvider)).status).toBe(200);
    at(T + 2); await journal({ eventId: "evt-retry-q", version: 2, status: "paid", paymentId: "in_retry_2" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    at(2 * T + 2); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect(await emails()).toEqual([`provision_failed:${HOME}`, `provision_failed:${HOME}:in_retry_2`]);
    const al = await alertRows();
    expect(al.map((x) => x.subject)).toEqual([PAYMENT.paymentId, "in_retry_2"]);
    expect(al[1].detail).toContain("[payment in_retry_2]");
    expect((await obligations()).map((o) => o.id)).toEqual([`refund:provision_failed:${HOME}`, key("in_retry_2")]);
  });

  it("P2-B: A's alert POST in flight while B is given up: A delivered exactly once and never resolved; B's own alert delivered once, referencing A by id", async () => {
    const HOOK = "https://hooks.example.test/alerts";
    const posts: string[] = [];
    const gate: { release?: () => void } = {};
    const fetcher = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { kind: string; text: string };
      if (body.kind !== "provision.failed") return new Response("ok");
      posts.push(body.text);
      if (posts.length === 1) await new Promise<void>((resolve) => { gate.release = resolve; });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const hookEnv = { ...env, ALERT_WEBHOOK_URL: HOOK } as Env;
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    await holdRetirement();
    // A's delivery starts and hangs (in flight).
    const first = sweepMonitoring(hookEnv, NOW + (T + 1) * MIN, fetcher);
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    // Meanwhile B is paid, then given up.
    at(T + 2); await journal({ eventId: "evt-retry-q", version: 2, status: "paid", paymentId: "in_retry_2" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    at(2 * T + 2); expect((await reconcile(fakeProvider)).status).toBe(200);
    let al = await alertRows();
    expect(al.map((x) => [x.subject, x.resolved_at, x.delivered_at])).toEqual([[PAYMENT.paymentId, null, null], ["in_retry_2", null, null]]);
    // A's POST succeeds now.
    gate.release!(); await first;
    await sweepMonitoring(hookEnv, NOW + (2 * T + 3) * MIN, fetcher);
    await sweepMonitoring(hookEnv, NOW + (2 * T + 4) * MIN, fetcher);
    al = await alertRows();
    expect(al.map((x) => x.resolved_at)).toEqual([null, null]);
    expect(al.every((x) => x.delivered_at !== null)).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts.filter((t) => t.includes(`[payment ${PAYMENT.paymentId}]`))).toHaveLength(1);
    expect(posts.filter((t) => t.includes("[payment in_retry_2]"))).toHaveLength(1);
    expect(posts[1]).toContain(`earlier payment ${PAYMENT.paymentId} also failed; see alert ${al[0].id}`);
  });
});

describe("Astra MAILRETRY-12: versions per payment line; a refund completion marks the home only when no other obligation is open", () => {
  const T = PROVISION_MAX_MS / MIN;
  const B = "in_retry_b";
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(HOME).first<{ n: number }>())!.n;
  const unprocessed = () => count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id=? AND processed_at IS NULL");
  const problems = () => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='payment_problem'");
  const handOffs = async () => (await env.DB.prepare("SELECT json_extract(payload,'$.paymentId') AS p FROM cloud_outbox WHERE home_id=? AND kind='payment_paid' ORDER BY rowid")
    .bind(HOME).all<{ p: string }>()).results.map((r) => r.p);
  const obligations = async () => (await env.DB.prepare(`SELECT id,completed_at,json_extract(payload,'$.paymentId') AS paymentId FROM cloud_outbox
    WHERE home_id=? AND kind='refund_required' ORDER BY rowid`).bind(HOME).all<{ id: string; completed_at: number | null; paymentId: string }>()).results;
  const lines = async () => (await env.DB.prepare("SELECT payment_id,version FROM cloud_payment_lines WHERE home_id=? ORDER BY payment_id").bind(HOME)
    .all<{ payment_id: string; version: number }>()).results;
  const journal = (p: { eventId: string; version: number; status: string; paymentId: string }) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify({ ...p, homeId: HOME }), Date.now()).run();
  const holdRetirement = async () => expect(await acquireHomeLease(env, HOME, "mailretry-12-hold")).not.toBeNull();
  const releaseHold = () => env.DB.prepare("DELETE FROM billing_home_leases WHERE home_id=?").bind(HOME).run();
  const key = (paymentId: string) => `refund:provision_failed:${HOME}:${paymentId}`;

  /** A given up and refunded; B (version 2, a new invoice) paid and checking: the home's current payment is B. */
  async function aRefundedBChecking() {
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    await holdRetirement();
    at(T + 1); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded" });
    at(T + 2); await journal({ eventId: "evt-b2", version: 2, status: "paid", paymentId: B });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    expect(await handOffs()).toEqual([PAYMENT.paymentId, B]);
  }
  /** B's cancellation is applied as B's own transition (payment trouble), whatever A's late event did; A's refund is untouched. */
  async function bCanceled(version: number) {
    expect(await unprocessed()).toBe(0);
    // A cancellation ends the grace at once (grace_until = now), so the same pass may already suspend the home: B's transition either way.
    const h = (await row<{ desired_state: string; entitlement: string; payment_version: number }>("cloud_homes"))!;
    expect(h).toMatchObject({ entitlement: "canceled", payment_version: version });
    expect(["payment_problem", "suspended"]).toContain(h.desired_state);
    expect(await problems()).toBe(1);
    expect(await obligations()).toEqual([{ id: key(PAYMENT.paymentId), completed_at: NOW + (T + 1) * MIN, paymentId: PAYMENT.paymentId }]);
    expect(await handOffs()).toEqual([PAYMENT.paymentId, B]);
  }

  it("P1: B's cancellation v3 and A's late payment_problem v4 queued together: A's is handled on A's line only; B's cancellation applies", async () => {
    await aRefundedBChecking();
    at(T + 3);
    await journal({ eventId: "evt-b-cancel3", version: 3, status: "canceled", paymentId: "sub_retry" });
    await journal({ eventId: "evt-a-problem4", version: 4, status: "payment_problem", paymentId: PAYMENT.paymentId });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    await bCanceled(3);
    expect(await lines()).toEqual([{ payment_id: PAYMENT.paymentId, version: 4 }]);
    // A stale event of the CURRENT payment (B's v2 paid again, a new event id) is still rejected: no hand-off, no state change.
    at(T + 4); await journal({ eventId: "evt-b2-replay", version: 2, status: "paid", paymentId: B });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    await bCanceled(3);
  });

  it("P1, the other order: A's late payment_problem v3 and B's cancellation v4 queued together: the same outcome", async () => {
    await aRefundedBChecking();
    at(T + 3);
    await journal({ eventId: "evt-a-problem3", version: 3, status: "payment_problem", paymentId: PAYMENT.paymentId });
    await journal({ eventId: "evt-b-cancel4", version: 4, status: "canceled", paymentId: "sub_retry" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    await bCanceled(4);
    expect(await lines()).toEqual([{ payment_id: PAYMENT.paymentId, version: 3 }]);
  });

  it("P1, separate passes in both orders, and A's late PAID replay: never moves the home's version or B's state", async () => {
    await aRefundedBChecking();
    // A's late paid replay (v5) first: no grant, no version; B's cancellation v3 after it still applies.
    at(T + 3); await journal({ eventId: "evt-a-paid5", version: 5, status: "paid", paymentId: PAYMENT.paymentId });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    at(T + 4); await journal({ eventId: "evt-b-cancel3", version: 3, status: "canceled", paymentId: "sub_retry" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    await bCanceled(3);
    // Then A's late payment_problem v4 in its own pass: B's cancellation stays as it was.
    at(T + 5); await journal({ eventId: "evt-a-problem4", version: 4, status: "payment_problem", paymentId: PAYMENT.paymentId });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    await bCanceled(3);
    expect(await lines()).toEqual([{ payment_id: PAYMENT.paymentId, version: 5 }]);
  });

  /** A Stripe fixture for live refunds of several payments: each invoice has its own payment intent; an invoice in `blocked` fails. */
  function stripeFor(blocked: Set<string>) {
    const created: { pi: string; opId: string; submission: string }[] = [];
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/invoices/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/invoices/".length));
        if (blocked.has(id)) return new Response(JSON.stringify({ error: { message: "x" } }), { status: 500 });
        // Each payment names its own subscription (Astra MAILRETRY-14 P2-a: a refund with no subscription identity leaves its plan's end open).
        return j({ id, payment_intent: `pi_${id}`, charge: `ch_${id}`, amount_paid: 1900, subscription: `sub_${id}` });
      }
      if (url.pathname.startsWith("/v1/subscriptions/")) return j({ id: url.pathname.split("/")[3], status: "canceled" });
      if (url.pathname === "/v1/refunds" && init?.method === "POST") {
        const f = new URLSearchParams(String(init.body));
        created.push({ pi: f.get("payment_intent")!, opId: f.get("metadata[op_id]")!, submission: f.get("metadata[submission]")! });
        return j({ id: `re_${f.get("payment_intent")}`, status: "succeeded" });
      }
      if (url.pathname === "/v1/refunds") {
        const pi = url.searchParams.get("payment_intent");
        return j({ data: created.filter((c) => c.pi === pi).map((c) => ({ id: `re_${c.pi}`, status: "succeeded", payment_intent: c.pi, metadata: { op_id: c.opId, submission: c.submission } })) });
      }
      return j({ id: "x", data: [] });
    };
    return { stripeFetch, created };
  }
  const liveEnv = () => ({ ...fixtureEnv(), CLOUD_B3_MODE: "live", STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789",
    BILLING_RETURN_ORIGIN: "https://cloud.murage.test", STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as Env);
  const quiet: BillingNotifier = { async notify() { /* notices are not under test here */ } };
  async function liveSweep(stripeFetch: typeof fetch) {
    await releaseHold();
    await sweepBilling(liveEnv(), { stripeFetch, notifier: quiet }).catch((e: unknown) => { if (!(e instanceof Error && e.message === "billing_sweep_incomplete")) throw e; });
  }
  /** A's and B's refunds both open (live mode: Stripe not done yet) with the home resting on B (its version), 'refund_pending'. */
  async function bothRefundsOpen() {
    await aRefundedBChecking();
    at(2 * T + 2); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 2 });
    // As live mode leaves them until Stripe answers: neither refund is done (the fake ledger's settlement undone).
    await env.DB.prepare("UPDATE cloud_outbox SET completed_at=NULL,receipt=NULL WHERE kind='refund_required'").run();
    await env.DB.prepare("DELETE FROM cloud_fake_refunds").run();
    expect((await obligations()).map((o) => [o.id, o.completed_at])).toEqual([[key(PAYMENT.paymentId), null], [key(B), null]]);
  }
  async function newPaymentAfterBoth(created: { opId: string }[]) {
    await holdRetirement();
    // B's setup attempt was real (a server and a volume at resource generation 2: A's give-up, never attempted, was generation 1), its
    // intent now 'failed', and its resources are released.
    const oldIntent = await row<Record<string, unknown>>("cloud_provision_intents");
    expect(oldIntent).toMatchObject({ state: "failed", resource_generation: 2 });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: expect.any(Number), cleaned_at: expect.any(Number) });
    const n = { volumes: 0, servers: 0, destroys: 0 };
    const counted: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { n.volumes++; return p.create_volume(...a); },
      async create(...a: Parameters<ProviderAdapter["create"]>) { n.servers++; return p.create(...a); },
      async destroy(id: string) { n.destroys++; return p.destroy(id); } }; };
    at(2 * T + 10); await journal({ eventId: "evt-c3", version: 3, status: "paid", paymentId: "in_retry_c" });
    // Round 8b: the new payment is the home's current payment AND its home is actually set up, at a new resource generation with a fresh
    // intent: budget opened, lease taken, the provider asked to create, no provision_intent_conflict.
    expect((await reconcile(counted)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 3, resource_generation: 3 });
    expect(await row("provision_attempts")).toMatchObject({ resource_generation: 3, attempts: 0, last_error: null, gave_up_at: null,
      give_up_code: null, cleaned_at: null, first_at: NOW + (2 * T + 10) * MIN, next_at: 0 });
    expect(n).toEqual({ volumes: 1, servers: 1, destroys: 0 }); // the old generation was already clean: nothing released twice
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "bound", resource_generation: 3, cp_generation: 1 });
    const { token_wrapped: _w, ...kept } = oldIntent!;
    expect(await env.DB.prepare("SELECT * FROM cloud_provision_intents_superseded WHERE home_id=?").bind(HOME).all()).toMatchObject({
      results: [{ ...kept, superseded_by_payment: "in_retry_c", superseded_at: NOW + (2 * T + 10) * MIN }] });
    expect((await live("home")).map((r) => r.generation)).toEqual([3]); expect((await live("volume")).map((r) => r.generation)).toEqual([3]);
    expect(await handOffs()).toEqual([PAYMENT.paymentId, B, "in_retry_c"]);
    expect((await obligations()).every((o) => o.completed_at !== null)).toBe(true);
    expect(await obligations()).toHaveLength(2);
    expect(created.map((c) => c.opId).sort()).toEqual([`no_capacity:${PAYMENT.paymentId}`, `no_capacity:${B}`]);
  }

  it("P2: live completions B (current) then A: the home stays 'refund_pending' until A is done too; a new payment after both provisions", async () => {
    await bothRefundsOpen();
    const blocked = new Set([PAYMENT.paymentId]);
    const s = stripeFor(blocked);
    await liveSweep(s.stripeFetch);
    expect((await obligations()).map((o) => o.completed_at !== null)).toEqual([false, true]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 2 });
    blocked.clear();
    await liveSweep(s.stripeFetch);
    expect((await obligations()).map((o) => o.completed_at !== null)).toEqual([true, true]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 2 });
    await liveSweep(s.stripeFetch);
    expect(s.created).toHaveLength(2);
    await newPaymentAfterBoth(s.created);
  });

  it("P2: live completions A then B (current): A's leaves B's open refund and the home alone; B's, the last, marks it refunded", async () => {
    await bothRefundsOpen();
    const blocked = new Set([B]);
    const s = stripeFor(blocked);
    await liveSweep(s.stripeFetch);
    expect((await obligations()).map((o) => o.completed_at !== null)).toEqual([true, false]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", payment_version: 2 });
    blocked.clear();
    await liveSweep(s.stripeFetch);
    expect((await obligations()).map((o) => o.completed_at !== null)).toEqual([true, true]);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    await liveSweep(s.stripeFetch);
    expect(s.created).toHaveLength(2);
    await newPaymentAfterBoth(s.created);
  });

  it("P2: A's live completion while B is paid and checking never overwrites B's entitlement or state", async () => {
    await aRefundedBChecking();
    // A's refund still open in live mode (the fake ledger's settlement undone); B paid and checking.
    await env.DB.prepare("UPDATE cloud_outbox SET completed_at=NULL,receipt=NULL WHERE kind='refund_required'").run();
    const s = stripeFor(new Set());
    await liveSweep(s.stripeFetch);
    expect(await obligations()).toEqual([{ id: key(PAYMENT.paymentId), completed_at: expect.any(Number), paymentId: PAYMENT.paymentId }]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2 });
    expect(s.created.map((c) => c.opId)).toEqual([`no_capacity:${PAYMENT.paymentId}`]);
  });
});

describe("round 8b: a new payment after a REAL failed setup attempt is set up at a new resource generation", () => {
  const T = PROVISION_MAX_MS / MIN;
  const A = PAYMENT.paymentId;
  const C = "in_retry_c";
  const key = (paymentId: string) => `refund:provision_failed:${HOME}:${paymentId}`;
  const obligations = async () => (await env.DB.prepare(`SELECT id,completed_at,json_extract(payload,'$.paymentId') AS paymentId FROM cloud_outbox
    WHERE home_id=? AND kind='refund_required' ORDER BY rowid`).bind(HOME).all<{ id: string; completed_at: number | null; paymentId: string }>()).results;
  const handOffs = async () => (await env.DB.prepare("SELECT json_extract(payload,'$.paymentId') AS p FROM cloud_outbox WHERE home_id=? AND kind='payment_paid' ORDER BY rowid")
    .bind(HOME).all<{ p: string }>()).results.map((r) => r.p);
  const paidOut = async () => (await env.DB.prepare("SELECT payment_id FROM cloud_fake_refunds ORDER BY payment_id").all<{ payment_id: string }>()).results.map((r) => r.payment_id);
  const journal = (p: { eventId: string; version: number; status: string; paymentId: string }) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify({ ...p, homeId: HOME }), Date.now()).run();
  const superseded = async () => (await env.DB.prepare("SELECT * FROM cloud_provision_intents_superseded WHERE home_id=?").bind(HOME).all()).results;

  it("A's attempt fails with its cleanup outstanding; C pays while A's refund is open: A's replay refused, A's resources released once, C provisions; C's give-up is its own", async () => {
    let failDestroy = true;
    const destroyed: string[] = [];
    const n = { volumes: 0, servers: 0 };
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { n.volumes++; return p.create_volume(...a); },
      async create(...a: Parameters<ProviderAdapter["create"]>) { n.servers++; return p.create(...a); },
      async destroy(id: string) { if (failDestroy) throw new Error("synthetic destroy outage"); destroyed.push(id); return p.destroy(id); } }; };
    // A's real attempt: a server and a volume at resource generation 1; the home boots but never becomes ready.
    at(0); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", resource_generation: 1 });
    expect(n).toEqual({ volumes: 1, servers: 1 });
    // Given up at its deadline; its cleanup fails (left for later), its refund obligation is open.
    at(T); await reconcile(make).catch(() => undefined);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    expect(await row("provision_attempts")).toMatchObject({ give_up_code: "home_never_ready", cleaned_at: null });
    expect(await obligations()).toEqual([{ id: key(A), completed_at: null, paymentId: A }]);
    const oldIntent = (await row<Record<string, unknown>>("cloud_provision_intents"))!;
    expect(oldIntent).toMatchObject({ state: "failed", resource_generation: 1 });
    expect(await live("home")).toHaveLength(1); expect(await live("volume")).toHaveLength(1);
    // While A's refund is still open: a replay of A's invoice (a higher version) and a genuinely new payment C arrive together.
    at(T + 1); failDestroy = false;
    await journal({ eventId: "evt-a-replay2", version: 2, status: "paid", paymentId: A });
    await journal({ eventId: "evt-c3", version: 3, status: "paid", paymentId: C });
    expect((await reconcile(make)).status).toBe(200);
    // A's replay grants nothing (its own line only); A's refund completes once; C is the current payment and its home is set up.
    expect(await handOffs()).toEqual([A, C]);
    expect((await env.DB.prepare("SELECT payment_id,version FROM cloud_payment_lines WHERE home_id=?").bind(HOME).all()).results)
      .toEqual([{ payment_id: A, version: 2 }]);
    expect(await obligations()).toEqual([{ id: key(A), completed_at: NOW + (T + 1) * MIN, paymentId: A }]);
    expect(await paidOut()).toEqual([A]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 3, resource_generation: 2 });
    expect(await row("provision_attempts")).toMatchObject({ resource_generation: 2, attempts: 0, last_error: null, gave_up_at: null,
      first_at: NOW + (T + 1) * MIN });
    // A's resources released first (each once, generation 1 only), then C's created at generation 2 with a fresh intent; A's intent kept.
    expect([...destroyed].sort()).toEqual([`fake-home-${HOME}-1`, `fake-volume-${HOME}-1`]);
    expect(n).toEqual({ volumes: 2, servers: 2 });
    expect((await live("home")).map((r) => r.generation)).toEqual([2]); expect((await live("volume")).map((r) => r.generation)).toEqual([2]);
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "bound", resource_generation: 2 });
    const { token_wrapped: _w, ...kept } = oldIntent;
    expect(await superseded()).toEqual([{ ...kept, superseded_by_payment: C, superseded_at: NOW + (T + 1) * MIN }]);
    // Later sweeps release nothing again.
    at(T + 2); expect((await reconcile(make)).status).toBe(200);
    expect(destroyed).toHaveLength(2);
    // C's home never becomes ready either: given up with its OWN obligation; A's is untouched; only generation 2 is released.
    at(2 * T + 1); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", resource_generation: 2 });
    expect(await obligations()).toEqual([{ id: key(A), completed_at: NOW + (T + 1) * MIN, paymentId: A }, { id: key(C), completed_at: null, paymentId: C }]);
    expect([...destroyed].sort()).toEqual([`fake-home-${HOME}-1`, `fake-home-${HOME}-2`, `fake-volume-${HOME}-1`, `fake-volume-${HOME}-2`]);
    at(2 * T + 2); await reconcile(make);
    expect(await paidOut()).toEqual([A, C]);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "refunded" });
    expect(destroyed).toHaveLength(4);
    expect(await superseded()).toHaveLength(1);
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  it("C pays while A's intent is NOT the failed attempt's (an intent still pending): nothing is superseded, no budget re-opened, no create", async () => {
    let failDestroy = true;
    const n = { volumes: 0 };
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { n.volumes++; return p.create_volume(...a); },
      async destroy(id: string) { if (failDestroy) throw new Error("synthetic destroy outage"); return p.destroy(id); } }; };
    at(0); expect((await reconcile(make)).status).toBe(200);
    at(T); await reconcile(make).catch(() => undefined);
    failDestroy = false;
    // A state no build writes, but the fence must hold: the attempt's intent is not 'failed'.
    await env.DB.prepare("UPDATE cloud_provision_intents SET state='pending' WHERE home_id=?").bind(HOME).run();
    at(T + 1); await journal({ eventId: "evt-c3", version: 3, status: "paid", paymentId: C });
    await reconcile(make).catch(() => undefined);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning", entitlement: "paid", resource_generation: 1 });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: expect.any(Number) });
    expect(await superseded()).toHaveLength(0);
    expect(n.volumes).toBe(1);
  });
});

describe("round 8d: the setup attempt given up is identified by its resource generation, never by the control-plane generation", () => {
  const T = PROVISION_MAX_MS / MIN;
  const A = PAYMENT.paymentId;
  const C = "in_retry_c";
  const key = (paymentId: string) => `refund:provision_failed:${HOME}:${paymentId}`;
  const obligations = async () => (await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='refund_required' ORDER BY rowid")
    .bind(HOME).all<{ id: string }>()).results.map((r) => r.id);
  const journal = (p: { eventId: string; version: number; status: string; paymentId: string }) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify({ ...p, homeId: HOME }), Date.now()).run();
  const superseded = async () => (await env.DB.prepare("SELECT * FROM cloud_provision_intents_superseded WHERE home_id=?").bind(HOME).all()).results;
  /** The staging /rotate (CP0 enrollment issuance): bumps the machine's and the home's control-plane generation. */
  async function rotate() {
    const ctx = createExecutionContext();
    const response = await createWorker(noNetwork, noNetwork, { provider: fakeProvider }).fetch(new Request(`https://admin.murage.test/v1/machines/${HOME}/rotate`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, "CF-Connecting-IP": "203.0.113.10" }, body: "{}",
    }), fixtureEnv({ CLOUD_CP0_STAGING: "1" }), ctx);
    await waitOnExecutionContext(ctx); return response;
  }

  it("an attempt rotated after it began is still marked failed at its give-up; a new payment re-opens the home at resource generation 2 and sets it up", async () => {
    const make: Make = (db) => fakeProvider(db);
    at(0); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", generation: 1, resource_generation: 1 });
    // The control-plane generation moves while the attempt is still being set up; the attempt's own identity (resource generation 1) does not.
    expect((await rotate()).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", generation: 2, resource_generation: 1 });
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "bound", cp_generation: 1, resource_generation: 1 });
    // Given up at its deadline: the attempt of resource generation 1 is marked failed and its machine fenced, whatever the rotation did.
    at(T); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", generation: 2, resource_generation: 1 });
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "failed", failure_code: "home_never_ready", cp_generation: 1, resource_generation: 1 });
    expect(await row("cloud_machines")).toMatchObject({ state: "fenced", credential_hash: null });
    expect(await obligations()).toEqual([key(A)]);
    // A genuinely new payment re-opens the home at the next resource generation and sets it up; it is never refunded.
    at(T + 1); await journal({ eventId: "evt-c2", version: 2, status: "paid", paymentId: C });
    expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", payment_version: 2, generation: 2, resource_generation: 2 });
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "bound", cp_generation: 2, resource_generation: 2 });
    expect(await row("provision_attempts")).toMatchObject({ resource_generation: 2, attempts: 0, gave_up_at: null });
    expect(await superseded()).toEqual([expect.objectContaining({ resource_generation: 1, cp_generation: 1, state: "failed", superseded_by_payment: C })]);
    expect(await obligations()).toEqual([key(A)]);
    expect((await live("home")).map((r) => r.generation)).toEqual([2]); expect((await live("volume")).map((r) => r.generation)).toEqual([2]);
  });

  it("a give-up racing a reopen (the home moved to a newer resource generation since the pass read it) never marks the new attempt failed", async () => {
    // The pass reads the home at resource generation 1 with one failure left in its budget.
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,?,?)")
      .bind(HOME, PROVISION_MAX_ATTEMPTS - 1, NOW).run();
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume() {
        // While this stale pass runs, a reopen commits: the home and its setup attempt move to resource generation 2 (a fresh pending intent).
        await db.batch([
          db.prepare("UPDATE cloud_homes SET resource_generation=2 WHERE id=?").bind(HOME),
          db.prepare("UPDATE cloud_provision_intents SET resource_generation=2 WHERE home_id=?").bind(HOME),
          db.prepare("UPDATE provision_attempts SET resource_generation=2 WHERE home_id=?").bind(HOME),
        ]);
        throw new Error("synthetic transient failure");
      } }; };
    at(0); await reconcile(make).catch(() => undefined);
    // The stale give-up (resource generation 1, its last attempt spent) wrote nothing: the newer attempt is not failed, nothing refunded.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning", entitlement: "paid", resource_generation: 2 });
    expect(await row("cloud_provision_intents")).toMatchObject({ state: "pending", resource_generation: 2, failure_code: null });
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: null });
    expect(await obligations()).toEqual([]);
  });
});

/** Wrap a D1 binding so a test can act just before, and just after, the FIRST statement or batch whose SQL matches (one-shot). The
 *  interleavings below run the real functions; this only chooses the moment another pass runs. */
function hookDb(db: D1Database, match: RegExp, hooks: { before?: () => Promise<void>; after?: () => Promise<void> }): D1Database {
  type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
  let fired = false;
  const around = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    if (fired || !match.test(sql)) return run();
    fired = true;
    await hooks.before?.();
    try { return await run(); } finally { await hooks.after?.(); }
  };
  const wrap = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, {
    get(target, prop) {
      if (prop === "__real") return target;
      if (prop === "__sql") return sql;
      if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return (...args: unknown[]) => around(sql, async () => (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args));
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return (statements: Stmt[]) => around(statements.map((s) => s.__sql ?? "").join(";\n"), () => target.batch(statements.map((s) => s.__real ?? s)));
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("round 9 (Astra MAILRETRY-13): the old attempt or payment never reaches into its replacement", () => {
  const T = PROVISION_MAX_MS / MIN;
  const A = PAYMENT.paymentId;
  const B = "in_retry_b";
  const key = (paymentId: string) => `refund:provision_failed:${HOME}:${paymentId}`;
  const obligations = async () => (await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='refund_required' ORDER BY rowid")
    .bind(HOME).all<{ id: string }>()).results.map((r) => r.id);
  const handOffs = async () => (await env.DB.prepare("SELECT json_extract(payload,'$.paymentId') AS p FROM cloud_outbox WHERE home_id=? AND kind='payment_paid' ORDER BY rowid")
    .bind(HOME).all<{ p: string }>()).results.map((r) => r.p);
  const lines = async () => (await env.DB.prepare("SELECT payment_id,version FROM cloud_payment_lines WHERE home_id=? ORDER BY payment_id").bind(HOME)
    .all<{ payment_id: string; version: number }>()).results;
  const journal = (p: { eventId: string; version: number; status: string; paymentId: string }) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(p.eventId, HOME, p.version, JSON.stringify({ ...p, homeId: HOME }), Date.now()).run();
  const holdRetirement = async () => expect(await acquireHomeLease(env, HOME, "mailretry-13-hold")).not.toBeNull();
  /** One reconcile pass on `db` (a hooked binding) instead of the test's own. */
  async function reconcileOn(provider: Make, db: D1Database) {
    const ctx = createExecutionContext();
    const response = await createWorker(noNetwork, noNetwork, { provider }).fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, "CF-Connecting-IP": "203.0.113.10" }, body: "{}",
    }), { ...fixtureEnv(), DB: db } as Env, ctx);
    await waitOnExecutionContext(ctx); return response;
  }
  /** A machine call (enroll, unwrap) from the home's bound address, on `db` when given. */
  async function machine(path: string, body: unknown, token?: string, db?: D1Database) {
    const ctx = createExecutionContext();
    const headers: Record<string, string> = { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await createWorker(noNetwork, noNetwork, { provider: fakeProvider }).fetch(new Request(`https://admin.murage.test${path}`, {
      method: "POST", headers, body: JSON.stringify(body) }), { ...fixtureEnv(), ...(db ? { DB: db } : {}) } as Env, ctx);
    await waitOnExecutionContext(ctx); return response;
  }

  it("P1-1: A's late event is classified while A is current, another pass accepts B, then A's no-effect write lands: it writes nothing; B's cancellation applies", async () => {
    // A given up and refunded (the home rests on it: failed, 'refunded', version 1).
    at(T); expect((await reconcile(fakeProvider)).status).toBe(200);
    await holdRetirement();
    at(T + 1); expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refunded", payment_version: 1 });
    at(T + 2);
    await journal({ eventId: "evt-b2", version: 2, status: "paid", paymentId: B });
    let arrived!: () => void; const xArrived = new Promise<void>((r) => { arrived = r; });
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    let x: Promise<Response> | null = null;
    // Pass X: classifies A's late v4 against A's line (A is still current), then pauses just before its no-effect version write.
    const dbX = hookDb(env.DB, /UPDATE cloud_homes SET payment_version=\?,updated_at=\?/, { before: async () => { arrived(); await gate; } });
    // Pass Y: about to accept B (v2). A's late event arrives and X runs up to its write; Y commits B; then X resumes.
    const dbY = hookDb(env.DB, /UPDATE cloud_capacity SET home_id=\?,expires_at=NULL/, {
      before: async () => {
        await journal({ eventId: "evt-a-problem4", version: 4, status: "payment_problem", paymentId: A });
        x = reconcileOn(fakeProvider, dbX); await xArrived;
      },
      after: async () => { open(); },
    });
    expect((await reconcileOn(fakeProvider, dbY)).status).toBe(200);
    expect((await x!).status).toBe(200);
    // B is current at ITS version: A's write was a compare-and-set on A's line as read, so it wrote nothing (before the fix: version 4).
    expect(await handOffs()).toEqual([A, B]);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "paid", payment_version: 2 });
    // B's cancellation v3 is applied; A's late v4 is classified again, now on A's own line only.
    at(T + 3); await journal({ eventId: "evt-b-cancel3", version: 3, status: "canceled", paymentId: "sub_retry" });
    expect((await reconcile(fakeProvider)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ entitlement: "canceled", payment_version: 3 });
    expect(await lines()).toEqual([{ payment_id: A, version: 4 }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first<{ n: number }>())!.n).toBe(0);
    expect(await obligations()).toEqual([key(A)]);
  });

  it("P1-3: A's fifth attempt is in flight; the overdue pass gives A up; B re-opens at generation 2 and fails once; A's late failure never counts against B", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,?,?)")
      .bind(HOME, PROVISION_MAX_ATTEMPTS - 1, NOW).run();
    await holdRetirement();
    let fired = false;
    let failB = 1;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        const generation = a[0].resourceGeneration;
        if (generation === 1 && !fired) {
          fired = true;
          // While A's last attempt runs: the overdue pass gives A up (refund obligation), and a new payment B re-opens the home.
          at(T); await reconcile(make).catch(() => undefined);
          expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", resource_generation: 1 });
          await journal({ eventId: "evt-b2", version: 2, status: "paid", paymentId: B });
          at(T + 1); await reconcile(make).catch(() => undefined);
          expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning", entitlement: "paid", resource_generation: 2 });
          expect(await row("provision_attempts")).toMatchObject({ resource_generation: 2, attempts: 1, gave_up_at: null });
          throw new Error("synthetic transient failure"); // A's late failure
        }
        if (generation === 2 && failB > 0) { failB--; throw new Error("synthetic transient failure"); }
        return p.create_volume(...a);
      } }; };
    at(50); await reconcile(make).catch(() => undefined);
    // A's failure was for generation 1, superseded: dropped. B's budget still shows its own single failure (before the fix: 5).
    expect(await row("provision_attempts")).toMatchObject({ resource_generation: 2, attempts: 1, gave_up_at: null });
    expect(await obligations()).toEqual([key(A)]);
    // B's next attempt sets the home up; B is never refunded.
    at(T + 3); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
    expect(await obligations()).toEqual([key(A)]);
  });

  it("P1-4 SECURITY: an unwrap authenticated as A's machine, resumed after the give-up and B's reopen, gets 401 and never B's secrets", async () => {
    const tokens: string[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create(...a: Parameters<ProviderAdapter["create"]>) { tokens.push(a[0].userData.enrollmentToken); return p.create(...a); } }; };
    at(0); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", generation: 1, resource_generation: 1 });
    const enrolledA = await machine(`/v1/machines/${HOME}/enroll`, { token: tokens[0] });
    expect(enrolledA.status).toBe(200);
    const a = await enrolledA.json<{ machineCredential: string; generation: number }>();
    const fresh = await machine(`/v1/machines/${HOME}/unwrap`, { generation: a.generation }, a.machineCredential);
    expect(fresh.status).toBe(200);
    const keysA = await fresh.json<{ dataKey: string; bootstrapSecret: string; volumeKey: string }>();
    await holdRetirement();
    let b: { machineCredential: string; generation: number } | null = null;
    // A's unwrap has authenticated A's machine row; before it reads key material, A is given up and B re-opens the home (same control-plane
    // generation) with its own machine, credential and keys, and B's machine enrols.
    const db = hookDb(env.DB, /cloud_home_keys/, { before: async () => {
      at(T); expect((await reconcile(make)).status).toBe(200);
      expect(await row("cloud_machines")).toMatchObject({ state: "fenced", credential_hash: null });
      await journal({ eventId: "evt-b2", version: 2, status: "paid", paymentId: B });
      at(T + 1); expect((await reconcile(make)).status).toBe(200);
      expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", generation: 1, resource_generation: 2 });
      const enrolledB = await machine(`/v1/machines/${HOME}/enroll`, { token: tokens[1] });
      expect(enrolledB.status).toBe(200);
      b = await enrolledB.json<{ machineCredential: string; generation: number }>();
    } });
    const stale = await machine(`/v1/machines/${HOME}/unwrap`, { generation: a.generation }, a.machineCredential, db);
    const staleBody = await stale.text();
    expect(stale.status).toBe(401);
    // B's own unwrap works and returns B's secrets, none of which reached the old request (before the fix: all three did).
    expect(b).not.toBeNull();
    const own = await machine(`/v1/machines/${HOME}/unwrap`, { generation: b!.generation }, b!.machineCredential);
    expect(own.status).toBe(200);
    const keysB = await own.json<{ dataKey: string; bootstrapSecret: string; volumeKey: string }>();
    for (const secret of [keysB.dataKey, keysB.bootstrapSecret, keysB.volumeKey]) {
      expect(secret).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
      expect(staleBody).not.toContain(secret);
      expect([keysA.dataKey, keysA.bootstrapSecret, keysA.volumeKey]).not.toContain(secret);
    }
    // And A's credential stays refused.
    expect((await machine(`/v1/machines/${HOME}/unwrap`, { generation: a.generation }, a.machineCredential)).status).toBe(401);
  });

  it("P3: the failed-home branch's cleanup and a reopen's cleanup overlap: one pass holds the claim, every resource is destroyed once", async () => {
    let failDestroy = true;
    let fired = false;
    const destroyed: string[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async destroy(id: string) {
        if (failDestroy) throw new Error("synthetic destroy outage");
        if (!fired) {
          fired = true;
          // Pass X (the failed-home branch) is releasing A's resources; pass Y, with a new payment C, reaches the reopen meanwhile.
          await journal({ eventId: "evt-c2", version: 2, status: "paid", paymentId: "in_retry_c" });
          expect((await reconcile(make)).status).toBe(200);
          expect(await row("cloud_homes")).toMatchObject({ desired_state: "provisioning", entitlement: "paid", resource_generation: 1 });
        }
        destroyed.push(id); return p.destroy(id);
      } }; };
    at(0); expect((await reconcile(make)).status).toBe(200);
    expect(await live("home")).toHaveLength(1); expect(await live("volume")).toHaveLength(1);
    at(T); await reconcile(make).catch(() => undefined);
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: expect.any(Number), cleaned_at: null, cleanup_claim: null });
    await holdRetirement();
    failDestroy = false;
    at(T + 1); expect((await reconcile(make)).status).toBe(200);
    // Each of A's resources destroyed exactly once (before the fix: the reopen destroyed them too).
    expect([...destroyed].sort()).toEqual([`fake-home-${HOME}-1`, `fake-volume-${HOME}-1`]);
    expect(await row("provision_attempts")).toMatchObject({ resource_generation: 1, cleaned_at: NOW + (T + 1) * MIN, cleanup_claim: null });
    // The next pass re-opens the home and sets C up at generation 2; nothing of generation 1 is destroyed again.
    at(T + 2); expect((await reconcile(make)).status).toBe(200);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
    expect(destroyed).toHaveLength(2);
  });

  // ---- round 10 (Astra MAILRETRY-14) ----
  const resourcesOf = async (generation: number, role: "home" | "volume", alive = true) => (await env.DB.prepare(`SELECT id FROM cloud_fake_resources
    WHERE home_id=? AND generation=? AND role=? ${alive ? "AND state<>'destroyed'" : ""}`).bind(HOME, generation, role).all<{ id: string }>()).results.map((r) => r.id);
  /** A's budget opened at minute 0; A's own attempt runs at T-5 (inside one invocation's wall of the give-up and B's reopen). Inside `pause`,
   *  the overdue pass gives A up (T) and payment B re-opens the home at resource generation 2 and sets it up (T+1). */
  const giveUpAThenReopenB = async (make: Make) => {
    at(T); await reconcile(make).catch(() => undefined);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed", entitlement: "refund_pending", resource_generation: 1 });
    await journal({ eventId: "evt-b2", version: 2, status: "paid", paymentId: B });
    at(T + 1); await reconcile(make).catch(() => undefined);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
  };

  it("MAILRETRY-14 P1: A paused before its server create; give-up, B re-opens and prepares its token; A resumes and dispatches NOTHING, never with B's token", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
    const creates: { generation: number; token: string }[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) { creates.push({ generation: input.resourceGeneration, token: input.userData.enrollmentToken }); return p.create(input); } }; };
    // A's pass: its volume is created, its server step claimed; it pauses just before reading its enrollment token.
    const dbA = hookDb(env.DB, /SELECT token_hash,token_wrapped FROM cloud_provision_intents/, { before: () => giveUpAThenReopenB(make) });
    at(T - 5); await reconcileOn(make, dbA).catch(() => undefined);
    // Only B's server was ever created, with B's own token; generation 1 never got a server (before the fix: A's create with B's token).
    expect(creates.map((c) => c.generation)).toEqual([2]);
    const bIntent = await row<{ resource_generation: number; token_hash: string; state: string }>("cloud_provision_intents");
    expect(bIntent).toMatchObject({ resource_generation: 2, state: "bound" });
    expect(await sha256(creates[0].token)).toBe(bIntent!.token_hash);
    expect(await resourcesOf(1, "home", false)).toEqual([]);
    expect(await resourcesOf(1, "volume")).toEqual([]); // A's volume released by the give-up
    // B unaffected: still checking at generation 2, its token not revoked, its resources alive.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
    expect((await env.DB.prepare("SELECT used_at FROM cloud_enrollment_tokens WHERE hash=?").bind(bIntent!.token_hash).first<{ used_at: number | null }>())!.used_at).toBeNull();
    expect(await resourcesOf(2, "home")).toHaveLength(1); expect(await resourcesOf(2, "volume")).toHaveLength(1);
    expect(await obligations()).toEqual([key(A)]);
  });

  it("MAILRETRY-14 P1: A's volume create dispatched, then paused; give-up and B's reopen; A's create lands late: it is on the ledger and reclaimed once settled, B untouched", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
    let fired = false;
    const destroyed: string[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        if (a[0].resourceGeneration === 1 && !fired) { fired = true; await giveUpAThenReopenB(make); at(T + 2); }
        return p.create_volume(...a);
      },
      async destroy(id: string) { destroyed.push(id); return p.destroy(id); } }; };
    at(T - 5); await reconcile(make).catch(() => undefined);
    // The late volume of generation 1 was created (its recording was refused: the attempt is no longer current); it is on the ledger, so the
    // sweep found and destroyed it (A's own pass already). Its dispatch has not settled yet, so generation 1 stays open.
    const late = await resourcesOf(1, "volume", false);
    expect(late).toHaveLength(1);
    expect(await resourcesOf(1, "volume")).toEqual([]);
    const ledger = () => env.DB.prepare("SELECT resource_generation,reclaimed_at FROM cloud_resource_dispatches WHERE home_id=? ORDER BY resource_generation").bind(HOME).all()
      .then((r) => r.results);
    expect(await ledger()).toEqual([{ resource_generation: 1, reclaimed_at: null }, { resource_generation: 2, reclaimed_at: null }]);
    at(T + 3); await reconcile(make);
    expect(await ledger()).toEqual([{ resource_generation: 1, reclaimed_at: null }, { resource_generation: 2, reclaimed_at: null }]);
    // Once A's dispatch has settled, a listing closes generation 1.
    at(T + 12); expect((await reconcile(make)).status).toBe(200);
    expect(await ledger()).toEqual([{ resource_generation: 1, reclaimed_at: NOW + (T + 12) * MIN }, { resource_generation: 2, reclaimed_at: null }]);
    expect(destroyed).toEqual(late);
    // B is untouched, and nothing more is destroyed by later passes.
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
    expect(await resourcesOf(2, "home")).toHaveLength(1); expect(await resourcesOf(2, "volume")).toHaveLength(1);
    at(T + 40); await reconcile(make);
    expect(destroyed).toEqual(late);
    expect(await obligations()).toEqual([key(A)]);
  });

  it("MAILRETRY-14 P3: X's claim expires while X is inside a slow destroy; Y takes over; X's ownership check stops it: each resource destroyed once, one purge", async () => {
    let failDestroy = true;
    let fired = false;
    let purges = 0;
    const destroyed: string[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async purge_snapshots() { purges++; },
      async destroy(id: string) {
        if (failDestroy) throw new Error("synthetic destroy outage");
        await p.destroy(id); destroyed.push(id);
        if (!fired) { fired = true; at(T + 1 + 17); expect((await reconcile(make)).status).toBe(200); } // X returns only after its claim expired
      } }; };
    at(0); expect((await reconcile(make)).status).toBe(200);
    at(T); await reconcile(make).catch(() => undefined);
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: expect.any(Number), cleaned_at: null, cleanup_claim: null });
    failDestroy = false;
    at(T + 1); await reconcile(make).catch(() => undefined);
    expect([...destroyed].sort()).toEqual([`fake-home-${HOME}-1`, `fake-volume-${HOME}-1`]);
    expect(purges).toBe(1);
    expect(await row("provision_attempts")).toMatchObject({ cleaned_at: NOW + (T + 18) * MIN, cleanup_claim: null });
    expect(await live("home")).toHaveLength(0); expect(await live("volume")).toHaveLength(0);
  });

  // ---- round 11 (Astra MAILRETRY-15) ----
  const ledgerOf = (generation: number) => env.DB.prepare("SELECT reclaimed_at,purged_at FROM cloud_resource_dispatches WHERE home_id=? AND resource_generation=?")
    .bind(HOME, generation).first<{ reclaimed_at: number | null; purged_at: number | null }>();
  const callsOf = (generation: number) => env.DB.prepare("SELECT role,settled_at,outcome FROM cloud_resource_dispatch_calls WHERE home_id=? AND resource_generation=? ORDER BY dispatched_at")
    .bind(HOME, generation).all<{ role: string; settled_at: number | null; outcome: string | null }>().then((r) => r.results);

  it("MAILRETRY-15 P1-1: A's admin-HTTP volume create stalls past its bound and past the minute-17 sweep: never closed by 'found nothing'; the late volume is destroyed; alerted after hours", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
    let fired = false;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        if (a[0].resourceGeneration === 1 && !fired) { fired = true; await giveUpAThenReopenB(make); return untilAborted(a[0].signal); }
        return p.create_volume(...a);
      } }; };
    at(T - 5); await reconcileBound(make, { dispatch: 50 }).catch(() => undefined);
    expect(fired).toBe(true);
    // The aborted call is recorded as unsettled: no provider answer.
    expect(await callsOf(1)).toEqual([{ role: "volume", settled_at: null, outcome: null }]);
    // Minute 17 and later: the sweep finds nothing at generation 1, and still never closes it (before the fix: closed at T+12).
    at(T + 17); expect((await reconcile(make)).status).toBe(200);
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    // A's volume arrives afterwards: the next due pass destroys it.
    await fakeProvider(env.DB).create_volume({ homeId: HOME, resourceGeneration: 1, idempotencyKey: `volume:${HOME}:1`, provider: "hetzner" });
    expect(await resourcesOf(1, "volume")).toHaveLength(1);
    at(T + 30); expect((await reconcile(make)).status).toBe(200);
    expect(await resourcesOf(1, "volume")).toEqual([]);
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    // B untouched by generation 1's reclaim (later, B's own setup times out on its own clock: not this case's subject).
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
    expect(await resourcesOf(2, "home")).toHaveLength(1); expect(await resourcesOf(2, "volume")).toHaveLength(1);
    // Astra INTEGRATED-7 P1 (replaces MAILRETRY-16 rule b): elapsed time alone never settles the unanswered create: empty listings long
    // after the assumed 70-minute lifetime still leave the call unsettled and the generation open.
    for (const m of [64, 75, 200]) { at(T + m); expect((await reconcile(make)).status).toBe(200); }
    expect(await callsOf(1)).toEqual([{ role: "volume", settled_at: null, outcome: null }]);
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
  });

  it("INTEGRATED-7 P1 70-minute rule: an unanswered create is never closed by elapsed time; a resource appearing days later is still listed and destroyed; listing decays to daily after 24 h", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
    let fired = false;
    const lists: number[] = [];
    let clock = 0;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        if (a[0].resourceGeneration === 1 && !fired) { fired = true; await giveUpAThenReopenB(make); return untilAborted(a[0].signal); }
        return p.create_volume(...a);
      },
      async list_by_tag(homeId: string, generation: number, role: "home" | "volume") {
        if (generation === 1 && role === "home") lists.push(clock);
        return p.list_by_tag(homeId, generation, role);
      } }; };
    const tick = async (m: number) => { clock = m; at(T + m); expect((await reconcile(make)).status).toBe(200); };
    clock = -5; at(T - 5); await reconcileBound(make, { dispatch: 50 }).catch(() => undefined);
    expect(fired).toBe(true);
    // Empty listings at 17 min, 75 min, 3 h, 23 h: before the fix the 75-minute listing settled the call and closed the generation.
    for (const m of [17, 75, 180, 23 * 60]) await tick(m);
    expect(await callsOf(1)).toEqual([{ role: "volume", settled_at: null, outcome: null }]);
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    // Past 24 h the cadence decays to once a day: a pass at 25 h lists, the passes 2 h and 20 h later do not, the one a day later does.
    await tick(25 * 60);
    await tick(27 * 60); await tick(45 * 60);
    expect(lists).toContain(25 * 60);
    expect(lists).not.toContain(27 * 60); expect(lists).not.toContain(45 * 60);
    // A's volume lands two days after the dispatch: the next daily listing still finds and destroys it (and settles the call by its key).
    const [{ id }] = (await env.DB.prepare("SELECT id FROM cloud_resource_dispatch_calls WHERE home_id=? AND resource_generation=1").bind(HOME).all<{ id: string }>()).results;
    await fakeProvider(env.DB).create_volume({ homeId: HOME, resourceGeneration: 1, idempotencyKey: id, provider: "hetzner" });
    await tick(49 * 60 + 1);
    expect(lists).toContain(49 * 60 + 1);
    expect(await resourcesOf(1, "volume")).toEqual([]);
    expect(await callsOf(1)).toEqual([{ role: "volume", settled_at: NOW + (T + 49 * 60 + 1) * MIN, outcome: "created" }]);
    expect((await ledgerOf(1))!.reclaimed_at).toBe(NOW + (T + 49 * 60 + 1) * MIN);
  });

  it("MAILRETRY-15 P1-2 SECURITY: A passes its server fence and pauses inside create; B re-opens with fresh keys; A's user-data never carries B's backup secret", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
    const passwords = new Map<number, string>();
    let aKeysPassword: string | null = null;
    let fired = false;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      wants_backup_password: () => true,
      async create(input: CreateHomeInput) {
        if (input.resourceGeneration === 1 && !fired) {
          fired = true;
          aKeysPassword = await deriveBackupPassword(fixtureEnv(), HOME); // A's own key material, still live here
          await giveUpAThenReopenB(make);
        }
        if (!input.backup?.resticPassword) throw new Error("no backup password given");
        passwords.set(input.resourceGeneration, input.backup.resticPassword);
        return p.create(input);
      } }; };
    at(T - 5); await reconcile(make).catch(() => undefined);
    expect(fired).toBe(true);
    const bLive = await deriveBackupPassword(fixtureEnv(), HOME); // B's keys, live now
    expect(passwords.get(2)).toBe(bLive);
    // A's payload was fixed before its fence from A's own keys: never B's secret (before the fix: read inside create, after the reopen).
    expect(passwords.get(1)).toBe(aKeysPassword);
    expect(passwords.get(1)).not.toBe(bLive);
    // A's late server is reclaimed; B is untouched.
    at(T + 30); await reconcile(make);
    expect(await resourcesOf(1, "home")).toEqual([]);
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
  });

  it("MAILRETRY-15 P2-b: the reclaim destroys A's late volume, then the purge fails: the next pass (finding nothing) still purges, and the generation closes only after that", async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
    let fired = false; let failPurge = false;
    const purges: number[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        if (a[0].resourceGeneration === 1 && !fired) { fired = true; await giveUpAThenReopenB(make); failPurge = true; at(T + 2); }
        return p.create_volume(...a);
      },
      async purge_snapshots(_home: string, generation: number) {
        if (generation !== 1) return;
        purges.push(Date.now());
        if (failPurge) throw new Error("synthetic purge outage");
      } }; };
    at(T - 5); await reconcile(make).catch(() => undefined);
    expect(await resourcesOf(1, "volume", false)).toHaveLength(1);
    expect(await resourcesOf(1, "volume")).toEqual([]); // destroyed
    expect(await ledgerOf(1)).toEqual({ reclaimed_at: null, purged_at: null });
    // Settled and past the window, nothing left to destroy, but the purge is still owed: it runs again, fails again, the ledger stays open.
    const before = purges.length;
    at(T + 12); await reconcile(make).catch(() => undefined);
    expect(purges.length).toBe(before + 1);
    expect(await ledgerOf(1)).toEqual({ reclaimed_at: null, purged_at: null });
    failPurge = false;
    at(T + 13); expect((await reconcile(make)).status).toBe(200);
    expect(await ledgerOf(1)).toEqual({ reclaimed_at: NOW + (T + 13) * MIN, purged_at: NOW + (T + 13) * MIN });
    const settledCount = purges.length;
    at(T + 40); await reconcile(make);
    expect(purges.length).toBe(settledCount); // closed: never purged again
  });

  it("MAILRETRY-15 P3-a: a destroy that stalls is aborted inside the claim's lease (released at once), never completing after another pass took over; each resource destroyed once", async () => {
    let stall = true;
    const destroyed: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async purge_snapshots() { /* nothing to purge */ },
      async destroy(id: string, signal?: AbortSignal) {
        signals.push(signal);
        if (stall) await untilAborted(signal);
        await p.destroy(id); destroyed.push(id);
      } }; };
    at(0); expect((await reconcile(make)).status).toBe(200);
    at(T); await reconcileBound(make, { cleanup: 50 }).catch(() => undefined);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s?.aborted)).toBe(true);
    expect(destroyed).toEqual([]); // the aborted call never completes
    expect(await row("provision_attempts")).toMatchObject({ gave_up_at: expect.any(Number), cleaned_at: null, cleanup_claim: null });
    stall = false;
    at(T + 1); await reconcile(make).catch(() => undefined);
    expect([...destroyed].sort()).toEqual([`fake-home-${HOME}-1`, `fake-volume-${HOME}-1`]);
    expect(await row("provision_attempts")).toMatchObject({ cleaned_at: NOW + (T + 1) * MIN, cleanup_claim: null });
  });

  // ---- round 12 (Astra MAILRETRY-16) ----
  const callRows = (generation: number) => env.DB.prepare(`SELECT id,role,settled_at,outcome,evidence,evidence_kind FROM cloud_resource_dispatch_calls
    WHERE home_id=? AND resource_generation=? ORDER BY role`).bind(HOME, generation)
    .all<{ id: string; role: string; settled_at: number | null; outcome: string | null; evidence: string | null; evidence_kind: string | null }>().then((r) => r.results);
  /** A's volume create for generation 1 dispatched; inside it, A is given up and B re-opens; then the create's answer is lost. */
  const lostVolumeCreate = (onCreate?: (input: Parameters<ProviderAdapter["create_volume"]>[0]) => Promise<void>): { make: Make; state: { fired: boolean; failList: number } } => {
    const state = { fired: false, failList: 0 };
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        if (a[0].resourceGeneration === 1 && !state.fired) {
          state.fired = true; await giveUpAThenReopenB(make); await onCreate?.(a[0]); throw new Error("synthetic lost response");
        }
        return p.create_volume(...a);
      },
      async list_by_tag(homeId: string, generation: number, role: "home" | "volume") {
        // A rate-limited listing, as the live adapter raises it (a GET error: never the create's answer).
        if (generation === 1 && state.failList > 0) { state.failList--; throw markNotAnAnswer(new HostError(429, "rate_limit_exceeded")); }
        return p.list_by_tag(homeId, generation, role);
      } }; };
    return { make, state };
  };
  const prepareA = async () => {
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at) VALUES (?,1,0,?)").bind(HOME, NOW).run();
    await holdRetirement();
  };

  it("MAILRETRY-16 P1 / INTEGRATED-7 P1: the recovery listing after a lost create answers 429: nothing settles; empty listings never close it, before or after the assumed lifetime", async () => {
    await prepareA();
    const { make, state } = lostVolumeCreate(async () => { state.failList = 1; });
    at(T - 5); await reconcile(make).catch(() => undefined);
    expect(state.fired).toBe(true);
    // The 429 of the recovery listing settled nothing (before the fix the listing's error could stand in for the create's refusal).
    expect((await callRows(1)).map((c) => [c.role, c.outcome])).toEqual([["volume", null]]);
    // Past the 16-minute window, empty listings: still open (the provider may still act on the request).
    for (const m of [17, 30, 50, 64]) { at(T + m); expect((await reconcile(make)).status).toBe(200); expect((await ledgerOf(1))!.reclaimed_at).toBeNull(); }
    // A listing that fails after the lifetime settles nothing either.
    state.failList = 10;
    at(T + 75); await reconcile(make).catch(() => undefined);
    expect((await callRows(1))[0].outcome).toBeNull();
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    state.failList = 0;
    at(T + 85); expect((await reconcile(make)).status).toBe(200);
    // Astra INTEGRATED-7 P1: a complete empty listing after the assumed lifetime settles nothing either (before: 'absent_after_lifetime').
    const [call] = await callRows(1);
    expect(call).toMatchObject({ outcome: null, settled_at: null });
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    // Only evidence closes it: an operator's provider-log confirmation, then the next pass.
    expect(await confirmDispatchCall(env.DB, call.id, { kind: "provider_log", reference: "hetzner action 77: create_volume failed" }, NOW + (T + 86) * MIN)).toBe(true);
    at(T + 100); expect((await reconcile(make)).status).toBe(200);
    expect((await ledgerOf(1))!.reclaimed_at).toBe(NOW + (T + 100) * MIN);
  });

  it("MAILRETRY-16 P1: a late create of an aborted call lands with ITS key: found, destroyed, the call settled by its own key, then closed", async () => {
    await prepareA();
    const { make } = lostVolumeCreate();
    at(T - 5); await reconcile(make).catch(() => undefined);
    const [call] = await callRows(1);
    expect(call.outcome).toBeNull();
    at(T + 17); expect((await reconcile(make)).status).toBe(200);
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    // The provider executes A's request late: the volume carries the call's own key.
    await fakeProvider(env.DB).create_volume({ homeId: HOME, resourceGeneration: 1, idempotencyKey: call.id, provider: "hetzner" });
    at(T + 30); expect((await reconcile(make)).status).toBe(200);
    expect(await resourcesOf(1, "volume")).toEqual([]);
    expect((await callRows(1))[0]).toMatchObject({ outcome: "created", evidence: `resource:fake-volume-${HOME}-1` });
    expect((await ledgerOf(1))!.reclaimed_at).toBe(NOW + (T + 30) * MIN);
    expect(await resourcesOf(2, "volume")).toHaveLength(1); // B untouched
  });

  it("MAILRETRY-16 P1: recovery adopts only the resource labelled with the call's own key, never another same-generation resource", async () => {
    let n = 0;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) {
        if (n++ === 0) {
          // Another call's volume of the same generation appears; this call's own request is lost.
          await p.create_volume({ ...a[0], idempotencyKey: "another-call-of-generation-1" });
          throw new Error("synthetic lost response");
        }
        return p.create_volume(...a);
      } }; };
    at(0); await reconcile(make).catch(() => undefined);
    // Not adopted by the recovery, and the call is NOT settled by it (before the fix: settled 'created' by a stranger's volume).
    expect((await callRows(1)).map((c) => c.outcome)).toEqual([null]);
    expect(await row("cloud_provision_intents")).toMatchObject({ volume_phase: "claimed", volume_id: null });
    // A lost response of the call's OWN request is adopted and settles it.
    await env.DB.prepare("DELETE FROM cloud_fake_resources").run();
    await env.DB.prepare("DELETE FROM cloud_resource_dispatch_calls").run();
    const own: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create_volume(...a: Parameters<ProviderAdapter["create_volume"]>) { await p.create_volume(...a); throw new Error("synthetic lost response"); } }; };
    at(10); await reconcile(own).catch(() => undefined);
    expect((await callRows(1)).filter((c) => c.role === "volume").map((c) => [c.outcome, c.evidence])).toEqual([["created", `resource:fake-volume-${HOME}-1`]]);
    expect(await row("cloud_provision_intents")).toMatchObject({ volume_phase: "created", volume_id: `fake-volume-${HOME}-1` });
  });

  it("MAILRETRY-16 P2-a: A's backup sub-account is created after the cleanup purged; A's server create is refused: re-purged by its own existence (no record needed), the ledger open until it is gone", async () => {
    await prepareA();
    const subs = new Map<string, { directory: string; generation: number }>();
    let silentDeletes = 1;
    const box = {
      async createSubaccount(i: { homeId: string; generation: number; password: string; call?: string }) {
        const id = `sub-${subs.size + 1}`; const directory = `murage/${i.homeId}-g${i.generation}`;
        subs.set(id, { directory, generation: i.generation });
        return { id, username: `u-${id}`, server: "box.test", directory };
      },
      async purgeDirectory() { /* empty */ }, async directoryExists() { return false; },
      async deleteSubaccount(id: string) { if (silentDeletes > 0) { silentDeletes--; return; } subs.delete(id); },
      async countSubaccounts() { return subs.size; },
      async findSubaccounts(homeId: string, generation: number) {
        return [...subs].filter(([, s]) => s.directory === `murage/${homeId}-g${generation}`).map(([id, s]) => ({ id, directory: s.directory }));
      },
    };
    const config = { id: 4242, host: "box.test", mainUser: "u", knownHosts: "box.test ssh-ed25519 AAAA", baseDir: "murage" };
    let fired = false;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) {
        if (input.resourceGeneration === 1 && !fired) {
          fired = true;
          await giveUpAThenReopenB(make);
          expect((await ledgerOf(1))!.purged_at).not.toBeNull(); // the cleanup purged generation 1 already
          await prepareBackup(env.DB, { box, config, backupPassword: async () => "pw" }, HOME, 1, Date.now());
          await env.DB.prepare("DELETE FROM backup_subaccounts WHERE home_id=? AND resource_generation=1").bind(HOME).run(); // its record is lost
          throw new HostError(422, "invalid_input"); // the server create is refused
        }
        return p.create(input);
      },
      async purge_snapshots(homeId: string, generation: number, signal?: AbortSignal) {
        await purgeBackup(db, () => box, homeId, generation, Date.now(), { signal, boxes: [{ id: 4242, box }] });
      } }; };
    at(T - 5); await reconcile(make).catch(() => undefined);
    expect(fired).toBe(true);
    expect((await callRows(1)).map((c) => [c.role, c.outcome])).toEqual([["server", "failed"], ["subaccount", "created"], ["volume", "created"]]);
    expect((await ledgerOf(1))!.purged_at).toBeNull(); // re-armed by the sub-account create
    // Every pass while the sub-account exists leaves the ledger open; the first delete does nothing, the re-listing sees it: retried.
    for (const m of [17, 18, 19]) {
      at(T + m); await reconcile(make).catch(() => undefined);
      if (subs.size) expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    }
    expect(subs.size).toBe(0);
    expect((await ledgerOf(1))!.reclaimed_at).not.toBeNull();
    expect(await row("cloud_homes")).toMatchObject({ desired_state: "checking", entitlement: "paid", resource_generation: 2 });
  });

  it("INTEGRATED-8 P2: a backup sub-account whose create answer was lost lands on day 3, after the first empty purge: still found by the daily pass, its call settled with that evidence, purged, the ledger then closed", async () => {
    await prepareA();
    const subs = new Map<string, { directory: string; call: string | null }>();
    let lateCall: string | null = null;
    const box = {
      async createSubaccount(i: { homeId: string; generation: number; password: string; call?: string }) {
        lateCall = i.call ?? null;
        throw new Error("network_lost"); // no answer: the box may still create it later
      },
      async purgeDirectory() { /* empty */ }, async directoryExists() { return false; },
      async deleteSubaccount(id: string) { subs.delete(id); },
      async countSubaccounts() { return subs.size; },
      async findSubaccounts(homeId: string, generation: number) {
        return [...subs].filter(([, s]) => s.directory === `murage/${homeId}-g${generation}`).map(([id, s]) => ({ id, directory: s.directory, callKey: s.call }));
      },
    };
    const config = { id: 4242, host: "box.test", mainUser: "u", knownHosts: "box.test ssh-ed25519 AAAA", baseDir: "murage" };
    let fired = false; let boxLists = 0;
    const make: Make = (db) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) {
        if (input.resourceGeneration === 1 && !fired) {
          fired = true;
          await giveUpAThenReopenB(make);
          await prepareBackup(env.DB, { box, config, backupPassword: async () => "pw" }, HOME, 1, Date.now()).catch(() => undefined);
          throw new HostError(422, "invalid_input");
        }
        return p.create(input);
      },
      async purge_snapshots(homeId: string, generation: number, signal?: AbortSignal) {
        if (generation === 1) boxLists++;
        await purgeBackup(db, () => box, homeId, generation, Date.now(), { signal, boxes: [{ id: 4242, box }] });
      } }; };
    at(T - 5); await reconcile(make).catch(() => undefined);
    expect(fired).toBe(true);
    expect(lateCall).not.toBeNull();
    // The first passes purge (nothing found) and record the purge done; the sub-account call stays unanswered.
    for (const m of [17, 75, 25 * 60, 49 * 60]) { at(T + m); await reconcile(make).catch(() => undefined); }
    expect((await ledgerOf(1))!.purged_at).not.toBeNull();
    expect((await callRows(1)).find((c) => c.role === "subaccount")).toMatchObject({ settled_at: null });
    const listsBefore = boxLists;
    // Day 3: the box creates it (labelled with the call's key). Servers/volumes stay empty; the box is still listed while the call is open.
    subs.set("sub-late", { directory: `murage/${HOME}-g1`, call: lateCall });
    at(T + 73 * 60 + 1); await reconcile(make).catch(() => undefined);
    expect(boxLists).toBeGreaterThan(listsBefore);
    expect(subs.size).toBe(0);
    expect((await callRows(1)).find((c) => c.role === "subaccount")).toMatchObject({ outcome: "created", evidence: "subaccount:4242:sub-late" });
    at(T + 73 * 60 + 2); await reconcile(make).catch(() => undefined);
    expect((await ledgerOf(1))!.reclaimed_at).not.toBeNull();
  });

  it("MAILRETRY-16 P2-b: operator_confirmed is refused without evidence (raw SQL and the function), accepted with a reference; the alert and the ledger then resolve", async () => {
    await prepareA();
    const { make, state } = lostVolumeCreate(async () => { state.failList = 1_000_000; }); // the listing keeps failing: rule (b) cannot apply
    at(T - 5); await reconcile(make).catch(() => undefined);
    at(T + 6 * 60 + 10); await reconcile(make).catch(() => undefined);
    const alert = () => env.DB.prepare("SELECT resolved_at,detail FROM cloud_alerts WHERE home_id=? AND kind='provision.dispatch_unsettled'").bind(HOME).first<{ resolved_at: number | null; detail: string }>();
    expect(await alert()).toMatchObject({ resolved_at: null, detail: expect.stringContaining("WITH that evidence") });
    const [call] = await callRows(1);
    // Raw SQL without evidence: refused by the table's CHECK constraint.
    await expect(env.DB.prepare("UPDATE cloud_resource_dispatch_calls SET settled_at=?,outcome='operator_confirmed' WHERE id=?").bind(NOW, call.id).run()).rejects.toThrow(/CHECK/i);
    await expect(env.DB.prepare("UPDATE cloud_resource_dispatch_calls SET settled_at=?,outcome='operator_confirmed',evidence_kind='provider_log',evidence='  ' WHERE id=?").bind(NOW, call.id).run()).rejects.toThrow(/CHECK/i);
    const at6h = NOW + (T + 6 * 60 + 11) * MIN;
    expect(await confirmDispatchCall(env.DB, call.id, { kind: "provider_log", reference: "" }, at6h)).toBe(false);
    // Astra INTEGRATED-7 P2: a NULL evidence kind (or a NULL settled_at) never passes the CHECK (SQLite passes a NULL CHECK result).
    await expect(env.DB.prepare("UPDATE cloud_resource_dispatch_calls SET settled_at=?,outcome='operator_confirmed',evidence_kind=NULL,evidence='ticket 9' WHERE id=?").bind(NOW, call.id).run()).rejects.toThrow(/CHECK/i);
    await expect(env.DB.prepare("UPDATE cloud_resource_dispatch_calls SET settled_at=NULL,outcome='operator_confirmed',evidence_kind='recheck',evidence='ticket 9' WHERE id=?").bind(call.id).run()).rejects.toThrow(/CHECK/i);
    // A 're-check' needs the provider lifetime to have elapsed since the dispatch.
    expect(await confirmDispatchCall(env.DB, call.id, { kind: "recheck", reference: "console checked by ops" }, NOW + (T + 30) * MIN)).toBe(false);
    expect((await callRows(1))[0].outcome).toBeNull();
    expect(await confirmDispatchCall(env.DB, call.id, { kind: "provider_log", reference: "hetzner action 4242: create_volume error" }, at6h)).toBe(true);
    expect((await callRows(1))[0]).toMatchObject({ outcome: "operator_confirmed", evidence_kind: "provider_log", evidence: "hetzner action 4242: create_volume error", settled_at: at6h });
    expect(await confirmDispatchCall(env.DB, call.id, { kind: "provider_log", reference: "again" }, at6h)).toBe(false); // settled once
    state.failList = 0;
    at(T + 6 * 60 + 30); expect((await reconcile(make)).status).toBe(200);
    expect((await ledgerOf(1))!.reclaimed_at).toBe(NOW + (T + 6 * 60 + 30) * MIN);
    expect((await alert())!.resolved_at).toBe(NOW + (T + 6 * 60 + 30) * MIN);
  });

  it("MAILRETRY-16 P3: the cleanup's purge gets the claim-bound signal; a stalled purge is aborted and stays unsettled (the ledger open), the next pass purges", async () => {
    await prepareA();
    let stall = true;
    const signals: (AbortSignal | undefined)[] = [];
    const { make: base } = lostVolumeCreate();
    const make: Make = (db) => { const p = base(db); return { ...p,
      async purge_snapshots(_h: string, generation: number, signal?: AbortSignal) {
        if (generation !== 1) return;
        signals.push(signal);
        if (stall) await untilAborted(signal);
      } }; };
    at(T - 5); await reconcile(make).catch(() => undefined);
    // Make the ledger's purge owed again and run the reclaim with a short cleanup bound: the purge is aborted.
    await env.DB.prepare("UPDATE cloud_resource_dispatches SET purged_at=NULL WHERE home_id=? AND resource_generation=1").bind(HOME).run();
    signals.length = 0;
    at(T + 80); await reconcileBound(make, { cleanup: 50 }).catch(() => undefined);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s?.aborted)).toBe(true);
    expect(await ledgerOf(1)).toEqual({ reclaimed_at: null, purged_at: null });
    stall = false;
    at(T + 81); expect((await reconcile(make)).status).toBe(200);
    // The purge is done; the generation stays open while A's create is unanswered (Astra INTEGRATED-7 P1: never closed by elapsed time).
    expect(await ledgerOf(1)).toEqual({ reclaimed_at: null, purged_at: NOW + (T + 81) * MIN });
  });

  it("MAILRETRY-16: cross-worker ordering is the database's: an answer recorded after the listing's anchor by a worker whose clock is an hour behind never closes the generation", async () => {
    await prepareA();
    const { make } = lostVolumeCreate();
    at(T - 5); await reconcile(make).catch(() => undefined);
    const [call] = await callRows(1);
    // Pass X lists generation 1 at T+17 (nothing there, before the lifetime). Right after X's anchor, worker W (clock one hour behind)
    // records the provider's late answer for the call: the resource it made was not in X's listing.
    const dbX = hookDb(env.DB, /SELECT CAST\(\(julianday\('now'\)-2440587\.5\)\*86400000 AS INTEGER\) AS t/, {
      after: async () => { await settleCall(env.DB, call.id, "created", NOW + (T + 17 - 60) * MIN, "resource:late"); },
    });
    at(T + 17); expect((await reconcileOn(make, dbX)).status).toBe(200);
    expect((await callRows(1))[0]).toMatchObject({ outcome: "created", settled_at: NOW + (T + 17 - 60) * MIN });
    // Before the fix (worker clocks): settled "before" X's start, so X closed the generation while the resource could exist.
    expect((await ledgerOf(1))!.reclaimed_at).toBeNull();
    // The next pass's listing follows the answer: it closes.
    at(T + 18); expect((await reconcile(make)).status).toBe(200);
    expect((await ledgerOf(1))!.reclaimed_at).toBe(NOW + (T + 18) * MIN);
  });

  describe("P1-5: a refund operation opened after the home moved to another subscription ends the given-up payment's own", () => {
    const calls: { path: string; method?: string }[] = [];
    let invoiceSubscription: string | undefined;
    const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ path: url.pathname, method: init?.method });
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (url.pathname.startsWith("/v1/invoices/")) {
        return j({ id: A, payment_intent: "pi_retry", charge: "ch_retry", amount_paid: 1900, ...(invoiceSubscription ? { subscription: invoiceSubscription } : {}) });
      }
      if (url.pathname === "/v1/refunds") return init?.method === "POST" ? j({ id: "re_retry", status: "succeeded" }) : j({ data: [] });
      if (url.pathname.startsWith("/v1/subscriptions/")) return j({ id: url.pathname.split("/")[3], status: "canceled" });
      return j({ id: "x" });
    };
    const liveEnv = () => ({ ...fixtureEnv(), CLOUD_B3_MODE: "live", STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789",
      BILLING_RETURN_ORIGIN: "https://cloud.murage.test", STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as Env);
    /** A's subscription (its first invoice is A's payment) is the home's when A is given up; the obligation is left for the live sweep; then
     *  B's checkout takes the home's subscription slot (sub_b) before A's refund operation is opened. */
    async function aGivenUpThenB() {
      calls.length = 0; invoiceSubscription = undefined;
      await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,first_invoice_id,created_at,updated_at)
        VALUES (?,'cus_r','sub_a','starter','active',?,1,1)`).bind(HOME, A).run();
      const failing = (db: D1Database): ProviderAdapter => ({ ...fakeProvider(db), async create() { throw new Error("synthetic provider outage"); } });
      for (let i = 0; i < PROVISION_MAX_ATTEMPTS; i++) { at(i * 10); await reconcile(failing).catch(() => undefined); }
      expect(await row("cloud_homes")).toMatchObject({ desired_state: "failed" });
      expect(await obligations()).toEqual([key(A)]);
      await env.DB.prepare("UPDATE cloud_outbox SET completed_at=NULL,receipt=NULL WHERE kind='refund_required'").run();
      await env.DB.prepare("UPDATE cloud_homes SET entitlement='refund_pending' WHERE id=?").bind(HOME).run();
      await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_b',first_invoice_id='in_retry_b' WHERE home_id=?").bind(HOME).run();
    }
    const notifier: BillingNotifier = { async notify() { /* the customer notice is not what these cases are about */ } };
    const op = () => env.DB.prepare("SELECT subscription_id,end_plan,invoice_id FROM refund_ops WHERE id=?").bind(`no_capacity:${A}`)
      .first<{ subscription_id: string | null; end_plan: number; invoice_id: string | null }>();
    /** Anything that would end or change B's subscription at Stripe (reads are not), plus its local record. */
    const touchedB = async () => [...calls.filter((c) => c.path.includes("sub_b") && c.method !== undefined && c.method !== "GET"),
      ...((await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE subscription_id='sub_b'").first<{ status: string }>())?.status === "active" ? [] : ["sub_b not active"])];
    const refundPosts = () => calls.filter((c) => c.path === "/v1/refunds" && c.method === "POST");

    it("the identity captured at the give-up (the invoice has no subscription field): sub_a, never sub_b", async () => {
      await aGivenUpThenB();
      expect(await env.DB.prepare("SELECT payment_id,subscription_id FROM cloud_refund_identities WHERE obligation_id=?").bind(key(A)).first())
        .toEqual({ payment_id: A, subscription_id: "sub_a" });
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(await op()).toMatchObject({ subscription_id: "sub_a", end_plan: 1, invoice_id: A });
      expect(refundPosts()).toHaveLength(1);
      expect(await touchedB()).toEqual([]);
    });
    it("a legacy obligation without a captured identity: resolved from its payment's invoice, never the home's current subscription", async () => {
      await aGivenUpThenB();
      await env.DB.prepare("DELETE FROM cloud_refund_identities").run();
      invoiceSubscription = "sub_a";
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(await op()).toMatchObject({ subscription_id: "sub_a", end_plan: 1 });
      expect(await touchedB()).toEqual([]);
    });
    it("MAILRETRY-14 P2-a: no identity: money refunded once, the plan's end stays OPEN (never recorded as done); resolved later, it is ended once", async () => {
      await aGivenUpThenB();
      await env.DB.prepare("DELETE FROM cloud_refund_identities").run();
      const state = () => env.DB.prepare(`SELECT o.canceled_at,o.done_at,o.refunded_at,o.subscription_id,(SELECT completed_at FROM cloud_outbox WHERE id=?) AS obligation_done,
        (SELECT resolved_at FROM cloud_alerts WHERE kind='refund.plan_unresolved') AS alert_resolved FROM refund_ops o WHERE o.id=?`).bind(key(A), `no_capacity:${A}`)
        .first<Record<string, number | string | null>>();
      const subACalls = () => calls.filter((c) => c.path.includes("sub_a") && c.method !== undefined && c.method !== "GET");
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(refundPosts()).toHaveLength(1);
      expect(await state()).toMatchObject({ canceled_at: null, done_at: null, refunded_at: expect.any(Number), subscription_id: null, obligation_done: null, alert_resolved: null });
      expect(await row("cloud_homes")).toMatchObject({ entitlement: "refund_pending" });
      // Re-evaluated on the next pass: still nothing names the subscription, so it stays open; nothing is refunded or ended again.
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(refundPosts()).toHaveLength(1); expect(subACalls()).toEqual([]);
      expect(await state()).toMatchObject({ canceled_at: null, done_at: null, obligation_done: null });
      // The owner records the payment's subscription (the operational step for an unresolved plan): the next pass ends it, once.
      await env.DB.prepare("INSERT INTO cloud_refund_identities (obligation_id,home_id,payment_id,subscription_id,captured_at) VALUES (?,?,?,?,?)")
        .bind(key(A), HOME, A, "sub_a", Date.now()).run();
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(await state()).toMatchObject({ canceled_at: expect.any(Number), done_at: expect.any(Number), subscription_id: "sub_a",
        obligation_done: expect.any(Number), alert_resolved: expect.any(Number) });
      const ended = subACalls().length;
      expect(ended).toBeGreaterThan(0);
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(subACalls()).toHaveLength(ended); expect(refundPosts()).toHaveLength(1);
      expect(await touchedB()).toEqual([]);
    });
    it("no identity anywhere: the money is still refunded, nothing is ended, the operator is alerted", async () => {
      await aGivenUpThenB();
      await env.DB.prepare("DELETE FROM cloud_refund_identities").run();
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(await op()).toMatchObject({ subscription_id: null, end_plan: 1 });
      expect(refundPosts()).toHaveLength(1);
      expect(await touchedB()).toEqual([]);
      expect(await env.DB.prepare("SELECT kind,subject FROM cloud_alerts WHERE home_id=? AND kind='refund.plan_unresolved'").bind(HOME).first())
        .toEqual({ kind: "refund.plan_unresolved", subject: `no_capacity:${A}` });
    });

    it("MAILRETRY-15 P3-b: the plan_unresolved alert is written after the refund step and says 'refund submitted', never 'money refunded' ahead of it", async () => {
      await aGivenUpThenB();
      await env.DB.prepare("DELETE FROM cloud_refund_identities").run();
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      const detail = JSON.parse((await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind='refund.plan_unresolved'").bind(HOME)
        .first<{ detail: string }>())!.detail) as { action: string };
      expect(detail.action).toMatch(/^refund submitted to Stripe; /);
      expect(detail.action).not.toContain("money refunded");
    });

    it("MAILRETRY-15 P3-b: a refund that could not be submitted yet: the alert says 'refund pending'", async () => {
      await aGivenUpThenB();
      await env.DB.prepare("DELETE FROM cloud_refund_identities").run();
      const refusing = async (input: string | URL | Request, init?: RequestInit) => new URL(String(input)).pathname === "/v1/refunds" && init?.method === "POST"
        ? new Response(JSON.stringify({ error: { type: "api_error", message: "synthetic outage" } }), { status: 500 }) : stripeFetch(input, init);
      await sweepBilling(liveEnv(), { stripeFetch: refusing, notifier }).catch(() => undefined);
      expect(refundPosts()).toEqual([]);
      const detail = JSON.parse((await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind='refund.plan_unresolved'").bind(HOME)
        .first<{ detail: string }>())!.detail) as { action: string };
      expect(detail.action).toMatch(/^refund pending \(not yet submitted to Stripe\); /);
    });

    it("MAILRETRY-15 P2-a: A's refund operation with no subscription is never attributed to B's contract; it counts for A's own once its identity is known", async () => {
      await aGivenUpThenB();
      await env.DB.prepare("DELETE FROM cloud_refund_identities").run();
      await sweepBilling(liveEnv(), { stripeFetch, notifier });
      expect(await op()).toMatchObject({ subscription_id: null });
      expect((await planEndOf(env as Env, HOME, { subscription_id: "sub_b", status: "canceled" })).refundState).toBeNull();
      await env.DB.prepare("INSERT INTO cloud_refund_identities (obligation_id,home_id,payment_id,subscription_id,captured_at) VALUES (?,?,?,?,?)")
        .bind(key(A), HOME, A, "sub_a", NOW).run();
      expect((await planEndOf(env as Env, HOME, { subscription_id: "sub_a", status: "canceled" })).refundState).toBe("sent");
      expect((await planEndOf(env as Env, HOME, { subscription_id: "sub_b", status: "canceled" })).refundState).toBeNull();
    });
  });
});
