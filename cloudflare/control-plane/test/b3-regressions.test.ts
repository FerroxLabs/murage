// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type CreateHomeInput } from "../src/b3-provider";
import { LEASE_TTL_MS, LEASE_SKEW_MS, RECOVERY_HOLD_MS, RESUME_DEADLINE_MS, RETAINED_BACKOFF_BASE_MS, RETAINED_PAGE_MS, type Home, type B3Dependencies } from "../src/b3-control";
import { sha256 } from "../src/installations";

const ADMIN = "test-only-regression-admin-no-real-access";
const IMAGE = `sha256:${"a".repeat(64)}`;
const NOW = 1_800_000_000_000;
const INSTALL = "12345678-1234-4123-8123-123456789012";
const INSTALL2 = "12345678-1234-4123-8123-123456789013";
const OWNER = "regression-owner";
const INSTALL_CRED = `murage_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const checks = { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true };
let signer: JsonWebKey;
const config = { reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE,
  quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [0, 1].map((n) => ({ id: `slot-${n}`, projectId: "test-project", location: "fsn1", serverType: "cpx32", outcome: "available" })),
};
const fixtureEnv = (): Env => ({ ...env, CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(config),
  CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_SIGNING_JWK: JSON.stringify(signer), CLOUD_CP0_STAGING: "1" } as Env);
const noNetwork = async () => { throw new Error("unexpected fixture network transport"); };
async function call(path: string, input: unknown = {}, token = ADMIN, deps: B3Dependencies = {}) {
  const ctx = createExecutionContext();
  const response = await createWorker(noNetwork, noNetwork, deps).fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "CF-Connecting-IP": "203.0.113.10" },
    body: JSON.stringify(input),
  }), fixtureEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const home = async (id = "home-a") => (await env.DB.prepare("SELECT * FROM cloud_homes WHERE id=?").bind(id).first<Home>())!;
const reconcile = (deps: B3Dependencies = {}) => call("/v1/fake-b3/reconcile", {}, ADMIN, deps);
async function reserve(id = "home-a", installationId = INSTALL) {
  expect((await call("/v1/fake-b3/reserve", { homeId: id, installationId, ownerId: OWNER,
    publicOrigin: `https://${id}.murage.test`, idempotencyKey: `reserve-${id}-fixture` })).status).toBe(201);
}
async function pay(id = "home-a", status = "paid", version = 1) {
  expect((await call("/v1/fake-b3/payments", { homeId: id, status, version, eventId: `${id}-event-${version}`, paymentId: `${id}-payment` })).status).toBe(202);
}
async function checking(id = "home-a", installationId = INSTALL) {
  await reserve(id, installationId); await pay(id); expect((await reconcile()).status).toBe(200);
  expect((await home(id)).desired_state).toBe("checking");
}
async function enrolled(id = "home-a") {
  const rotated = await call(`/v1/machines/${id}/rotate`);
  expect(rotated.status).toBe(200);
  const r = await rotated.json<{ enrollmentToken: string; generation: number }>();
  const response = await call(`/v1/machines/${id}/enroll`, { token: r.enrollmentToken }, "");
  expect(response.status).toBe(200);
  return response.json<{ machineCredential: string; generation: number }>();
}
async function ready(id = "home-a", installationId = INSTALL) {
  await checking(id, installationId);
  const c = await enrolled(id);
  expect((await call(`/v1/fake-b3/homes/${id}/canary`, { generation: c.generation, imageDigest: IMAGE, checks })).status).toBe(200);
  return c;
}
async function stop(id = "home-a") {
  const h = await home(id);
  expect((await call(`/v1/fake-b3/homes/${id}/action`, { generation: h.generation, action: "quarantine", idempotencyKey: `quarantine-${id}-fixture` })).status).toBe(202);
}
async function deleteHold(id = "home-a", beforeCompletion?: () => Promise<void>) {
  const h = await home(id);
  const r = await call(`/v1/fake-b3/homes/${id}/action`, { generation: h.generation, action: "delete", idempotencyKey: `delete-${id}-fixture` });
  expect(r.status).toBe(202);
  const hold = await r.json<{ holdId: string }>();
  vi.mocked(Date.now).mockReturnValue(Date.now() + RECOVERY_HOLD_MS);
  await beforeCompletion?.();
  expect((await call(`/v1/fake-b3/homes/${id}/recovery/complete`, { holdId: hold.holdId })).status).toBe(200);
}
function barrier() {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, async pause() { enter(); await released; } };
}
// Intercept one genuine statement result, preserving every real D1 operation.
// No substitute database, result row, or delay-by-sleep is used.
function pauseFirstRead(sql: string | ((query: string) => boolean), gate: ReturnType<typeof barrier>) {
  const prepare = env.DB.prepare.bind(env.DB);
  let armed = true;
  return vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    if (typeof sql === "string" ? query !== sql : !sql(query)) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async <T = Record<string, unknown>>(): Promise<T | null> => {
        const row = await first<T>();
        if (armed) { armed = false; await gate.pause(); }
        return row;
      });
      return bound;
    });
    return statement;
  });
}
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  signer = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Regression owner','regression@example.test',1,?,?)`)
    .bind(OWNER, NOW, NOW).run();
  for (const id of [INSTALL, INSTALL2]) await env.DB.prepare(`INSERT INTO installations
    (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at) VALUES (?,?,?,'Regression','linux',?,?)`)
    .bind(id, OWNER, id, NOW, NOW).run();
  await env.DB.prepare(`INSERT INTO installation_credentials (id,installation_id,lookup_id,secret_hash,created_at,expires_at)
    VALUES ('regression-install-credential',?,?,?,?,?)`).bind(INSTALL, "a".repeat(22), await sha256(INSTALL_CRED), NOW, NOW + 100 * RECOVERY_HOLD_MS).run();
});
afterEach(() => vi.restoreAllMocks());

describe("B3 independent audit regression protocols", () => {
  it("F4 completes home-desktop-home handover with original credential and rejects delayed renewals and ACK replays", async () => {
    await checking();
    const rotated = await call("/v1/machines/home-a/rotate");
    expect(rotated.status).toBe(200);
    const enrollment = await rotated.json<{ enrollmentToken: string; generation: number }>();
    expect((await call("/v1/fake-b3/homes/home-a/canary", {
      generation: enrollment.generation, imageDigest: IMAGE, checks,
    })).status).toBe(200);
    const enrolled = await call("/v1/machines/home-a/enroll", { token: enrollment.enrollmentToken }, "");
    expect(enrolled.status).toBe(200);
    const credential = await enrolled.json<{ machineCredential: string; generation: number }>();
    const n = credential.generation;
    expect(n).toBe(enrollment.generation);
    // Initialization ends here: no admin calls or fixture table writes below.
    const machineIdentity = () => env.DB.prepare(`SELECT credential_hash,server_id,bound_ips,state,generation
      FROM cloud_machines WHERE id='home-a'`).first<{
        credential_hash: string | null; server_id: string; bound_ips: string; state: string; generation: number;
      }>();
    const originalIdentity = (await machineIdentity())!;
    expect(originalIdentity.credential_hash).toBe(await sha256(credential.machineCredential));
    const soleLease = async () => {
      const rows = await env.DB.prepare("SELECT * FROM cloud_leases WHERE installation_id=?").bind(INSTALL).all();
      expect(rows.results).toHaveLength(1);
      return rows.results[0];
    };
    const ackReceipts = async () => (await env.DB.prepare(`SELECT COUNT(*) AS total FROM cloud_outbox
      WHERE home_id='home-a' AND kind='lease_acknowledged'`).first<{ total: number }>())!.total;
    const acquire = (holder: string, generation: number, token: string) =>
      call("/v1/machines/home-a/lease", { holder, generation }, token);
    const ack = (holder: string, generation: number, token: string) =>
      call("/v1/fake-b3/homes/home-a/lease/ack", { holder, generation }, token);
    const executionAllowed = async () => {
      const ctx = createExecutionContext();
      const response = await createWorker(noNetwork, noNetwork).fetch(new Request("https://admin.murage.test/v1/machines/home-a/desired", {
        headers: { authorization: `Bearer ${credential.machineCredential}`, "CF-Connecting-IP": "203.0.113.10" },
      }), fixtureEnv(), ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      return (await response.json<{ executionAllowed: boolean }>()).executionAllowed;
    };
    const rejectAckWithoutEffects = async (holder: string, generation: number, token: string) => {
      const before = { home: await home(), machine: await machineIdentity(), lease: await soleLease(), receipts: await ackReceipts() };
      expect((await ack(holder, generation, token)).status).not.toBe(200);
      expect({ home: await home(), machine: await machineIdentity(), lease: await soleLease(), receipts: await ackReceipts() }).toEqual(before);
    };

    expect((await acquire("home-a", n, credential.machineCredential)).status).toBe(200);
    expect(await soleLease()).toMatchObject({ holder: "home-a", generation: n, acknowledged: 0 });
    expect(await executionAllowed()).toBe(true);
    const gate = barrier();
    const spy = pauseFirstRead("SELECT credential_hash,bound_ips,generation,state FROM cloud_machines WHERE id=?", gate);
    const delayedRenewal = acquire("home-a", n, credential.machineCredential);
    await gate.entered;
    try {
      expect((await ack("home-a", n, credential.machineCredential)).status).toBe(200);
      expect((await home()).generation).toBe(n + 1);
      expect(await machineIdentity()).toEqual({ ...originalIdentity, generation: n + 1 });
      expect(await soleLease()).toMatchObject({ holder: "home-a", generation: n, acknowledged: 1 });
      expect(await ackReceipts()).toBe(1);
      expect((await acquire("home-a", n + 1, credential.machineCredential)).status).toBe(409);
      expect((await acquire(INSTALL, n + 1, INSTALL_CRED)).status).toBe(200);
    } finally {
      gate.release();
      const delayed = await delayedRenewal;
      spy.mockRestore();
      expect(delayed.status).not.toBe(200);
    }
    expect(await soleLease()).toMatchObject({ holder: INSTALL, generation: n + 1, acknowledged: 0 });
    expect((await acquire("home-a", n, credential.machineCredential)).status).toBe(409);
    expect((await acquire("home-a", n + 1, credential.machineCredential)).status).toBe(409);
    expect(await executionAllowed()).toBe(false);

    expect((await ack(INSTALL, n + 1, INSTALL_CRED)).status).toBe(200);
    expect((await home()).generation).toBe(n + 2);
    expect(await machineIdentity()).toEqual({ ...originalIdentity, generation: n + 2 });
    expect(await ackReceipts()).toBe(2);
    await rejectAckWithoutEffects(INSTALL, n + 1, INSTALL_CRED);
    expect((await acquire(INSTALL, n + 1, INSTALL_CRED)).status).toBe(409);
    expect((await acquire(INSTALL, n + 2, INSTALL_CRED)).status).toBe(409);
    expect((await acquire("home-a", n + 2, credential.machineCredential)).status).toBe(200);
    expect(await soleLease()).toMatchObject({ holder: "home-a", generation: n + 2, acknowledged: 0, fenced: 0 });
    expect(await machineIdentity()).toEqual({ ...originalIdentity, generation: n + 2 });
    expect(await executionAllowed()).toBe(true);
    expect((await acquire(INSTALL, n + 2, INSTALL_CRED)).status).toBe(409);
    expect((await acquire("home-a", n, credential.machineCredential)).status).toBe(409);
    expect((await acquire(INSTALL, n + 1, INSTALL_CRED)).status).toBe(409);
    await rejectAckWithoutEffects("home-a", n, credential.machineCredential);
    await rejectAckWithoutEffects(INSTALL, n + 1, INSTALL_CRED);
    expect(await soleLease()).toMatchObject({ holder: "home-a", generation: n + 2 });
    expect(Date.now()).toBe(NOW); // ACK enables transfers before TTL or skew elapses.
  });
  it("A1 acknowledges a payment only after application or conclusive supersession across a canary race", async () => {
    await checking(); await pay("home-a", "payment_problem", 2);
    const gate = barrier(); const spy = pauseFirstRead("SELECT * FROM cloud_homes WHERE id=?", gate);
    const running = reconcile(); await gate.entered;
    try { expect((await call("/v1/fake-b3/homes/home-a/canary", { generation: 1, imageDigest: IMAGE, checks })).status).toBe(200); }
    finally { gate.release(); }
    await running; spy.mockRestore();
    const h = await home();
    const event = await env.DB.prepare("SELECT processed_at FROM cloud_payment_inbox WHERE id='home-a-event-2'").first<{ processed_at: number | null }>();
    expect(h.entitlement === "payment_problem" || event?.processed_at === null).toBe(true);
    await reconcile(); expect((await home()).entitlement).toBe("payment_problem");
  });
  it("A2 paused provisioning cannot publish DNS/bindings after delete removes DNS", async () => {
    await reserve(); await pay(); const gate = barrier();
    const deps = { provider: (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async attach_volume(id: string, serverId: string) { const volume = await p.attach_volume(id, serverId); await gate.pause(); return volume; },
    }; } };
    const running = reconcile(deps); await gate.entered;
    try { await deleteHold(); await reconcile(); }
    finally { gate.release(); }
    await running;
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns WHERE home_id='home-a'").first()).toBeNull();
    expect((await env.DB.prepare("SELECT bound_ips FROM cloud_machines WHERE id='home-a'").first())?.bound_ips).toBeNull();
    const removedAt = (await home()).dns_removed_at!;
    vi.mocked(Date.now).mockReturnValue(removedAt + 59_999); await reconcile();
    expect((await env.DB.prepare("SELECT state FROM cloud_fake_resources WHERE role='home'").first())?.state).not.toBe("destroyed");
    vi.mocked(Date.now).mockReturnValue(removedAt + 60_000); await reconcile();
    expect((await env.DB.prepare("SELECT state FROM cloud_fake_resources WHERE role='home'").first())?.state).toBe("destroyed");
  });
  it("A2 late provider create after deletion completion is cleaned without republishing DNS", async () => {
    await reserve(); await pay(); const gate = barrier();
    const deps = { provider: (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) { await gate.pause(); return p.create(input); },
    }; } };
    const running = reconcile(deps); await gate.entered;
    try { await deleteHold(); await reconcile(); vi.mocked(Date.now).mockReturnValue(Date.now() + 60_000); await reconcile(); }
    finally { gate.release(); }
    await running;
    expect((await home()).desired_state).toBe("deleted");
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns WHERE home_id='home-a'").first()).toBeNull();
    expect((await env.DB.prepare("SELECT state FROM cloud_fake_resources WHERE role='home'").first())?.state).toBe("destroyed");
  });
  it("A3 unprovisioned problem-to-paid recovery creates resources rather than skipping to checking", async () => {
    await reserve(); await pay("home-a", "payment_problem", 1); await reconcile(); await pay("home-a", "paid", 2); await reconcile();
    expect((await home()).entitlement).toBe("paid");
    expect(await env.DB.prepare("SELECT id FROM cloud_machines WHERE id='home-a'").first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM cloud_fake_resources WHERE home_id='home-a' AND role='home'").first()).not.toBeNull();
  });
  it("A3 problem/canceled snapshots update billing but preserve explicit quarantine", async () => {
    await ready(); await stop();
    for (const [version, status] of [[2, "payment_problem"], [3, "canceled"], [4, "paid"]] as const) {
      await pay("home-a", status, version); await reconcile();
      expect((await home()).desired_state).toBe("stopped"); expect((await home()).payment_version).toBe(version);
    }
  });
  it("A3 new problem snapshots preserve suspended retention and notice receipts", async () => {
    await ready(); await pay("home-a", "payment_problem", 2); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs); await reconcile();
    const suspended = await home();
    expect((await call("/v1/fake-b3/homes/home-a/notice", { generation: suspended.generation, noticeId: "retained-notice-receipt" })).status).toBe(200);
    await pay("home-a", "canceled", 3); await reconcile();
    expect((await home()).desired_state).toBe("suspended");
    expect((await home()).delete_after).toBe(suspended.delete_after);
    expect((await home()).suspension_notices).toBe(1);
  });
  it("A4 a first lease authenticated before Stop cannot commit after the generation is revoked", async () => {
    const c = await ready(); const gate = barrier();
    const spy = pauseFirstRead("SELECT credential_hash,bound_ips,generation,state FROM cloud_machines WHERE id=?", gate);
    const running = call("/v1/machines/home-a/lease", { holder: "home-a", generation: c.generation }, c.machineCredential);
    await gate.entered;
    try { await stop(); } finally { gate.release(); }
    const response = await running; spy.mockRestore();
    expect(response.status).not.toBe(200);
    expect(await env.DB.prepare("SELECT * FROM cloud_leases WHERE installation_id=?").bind(INSTALL).first()).toBeNull();
  });
  it("A5 deleting a home-held lease permits a fenced replacement for the same installation", async () => {
    const c = await ready();
    expect((await call("/v1/machines/home-a/lease", { holder: "home-a", generation: c.generation }, c.machineCredential)).status).toBe(200);
    await deleteHold(); await reconcile(); vi.mocked(Date.now).mockReturnValue(Date.now() + 60_000); await reconcile();
    const b = await ready("home-b");
    expect((await call("/v1/machines/home-b/lease", { holder: "home-b", generation: b.generation }, b.machineCredential)).status).toBe(200);
    expect((await env.DB.prepare("SELECT home_id FROM cloud_leases WHERE installation_id=?").bind(INSTALL).first())?.home_id).toBe("home-b");
  });
  it("A5 fencing a home never marks its desktop holder fenced; replacement waits actual TTL plus skew", async () => {
    await ready(); const h = await home();
    expect((await call("/v1/machines/home-a/lease", { holder: INSTALL, generation: h.generation }, INSTALL_CRED)).status).toBe(200);
    let expires = 0;
    await deleteHold("home-a", async () => {
      // The real desktop renews just before the hold completes, then partitions.
      const renewed = await call("/v1/machines/home-a/lease", { holder: INSTALL, generation: h.generation }, INSTALL_CRED);
      expect(renewed.status).toBe(200); expires = (await renewed.json<{ expiresAt: number }>()).expiresAt;
    });
    await reconcile(); vi.mocked(Date.now).mockReturnValue(Date.now() + 60_000); await reconcile();
    expect((await env.DB.prepare("SELECT fenced FROM cloud_leases WHERE installation_id=?").bind(INSTALL).first())?.fenced).toBe(0);
    const b = await ready("home-b");
    expect((await call("/v1/machines/home-b/lease", { holder: "home-b", generation: b.generation }, b.machineCredential)).status).toBe(409);
    vi.mocked(Date.now).mockReturnValue(expires + LEASE_SKEW_MS - 1);
    expect((await call("/v1/machines/home-b/lease", { holder: "home-b", generation: b.generation }, b.machineCredential)).status).toBe(409);
    vi.mocked(Date.now).mockReturnValue(expires + LEASE_SKEW_MS);
    expect((await call("/v1/machines/home-b/lease", { holder: "home-b", generation: b.generation }, b.machineCredential)).status).toBe(200);
  });
  it("A6 fair bounded reconciliation reaches a paid home beyond100 expired reservations", async () => {
    // Build all101 earlier expired reservations through the actual reserve API.
    // Rotate100-install owners to respect existing per-account installation cap.
    for (let n = 0; n < 101; n++) {
      const owner = `expired-owner-${n}`; const installation = `expired-install-${n}`;
      await env.DB.prepare(`INSERT INTO "user" VALUES (?,? ,?,1,NULL,?,?)`).bind(owner, owner, `${owner}@example.test`, NOW, NOW).run();
      await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
        VALUES (?,?,?,'Expired','linux',?,?)`).bind(installation, owner, installation, NOW, NOW).run();
      const id = `a-expired-${String(n).padStart(3, "0")}`;
      expect((await call("/v1/fake-b3/reserve", { homeId: id, installationId: installation, ownerId: owner,
        publicOrigin: `https://${id}.murage.test`, idempotencyKey: `expired-reserve-${n}-key` })).status).toBe(201);
      vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
    }
    await reserve("z-paid"); await pay("z-paid");
    for (let n = 0; n < 3; n++) await reconcile();
    expect((await home("z-paid")).desired_state).toBe("checking");
    expect(await env.DB.prepare("SELECT id FROM cloud_machines WHERE id='z-paid'").first()).not.toBeNull();
  }, 30_000);
  it("F1 one provider failure records a redacted error and does not stop another home's fencing", async () => {
    await ready("home-b", INSTALL2); await stop("home-b"); await reserve(); await pay();
    const deps = { provider: (db: D1Database) => { const p = fakeProvider(db); return { ...p,
      async create(input: CreateHomeInput) {
        if (input.homeId === "home-a") throw new Error("fixture-provider-failure-with-sensitive-detail");
        return p.create(input);
      },
    }; } };
    await reconcile(deps);
    const b = await env.DB.prepare("SELECT state,quarantined FROM cloud_fake_resources WHERE home_id='home-b' AND role='home'").first();
    expect(b).toMatchObject({ state: "powered_off", quarantined: 1 });
    const receipt = await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE home_id='home-a' AND kind='reconcile_failed'").first();
    expect(receipt).not.toBeNull(); expect(JSON.stringify(receipt)).not.toContain("sensitive-detail");
  });
  it("F4 the matching desktop holder can acknowledge and hand over the next generation without admin rotation", async () => {
    const c = await ready();
    expect((await call("/v1/machines/home-a/lease", { holder: INSTALL, generation: c.generation }, INSTALL_CRED)).status).toBe(200);
    const ack = await call("/v1/fake-b3/homes/home-a/lease/ack", { holder: INSTALL, generation: c.generation }, INSTALL_CRED);
    expect(ack.status).toBe(200);
    const current = await home(); expect(current.generation).toBe(c.generation + 1);
    expect((await call("/v1/machines/home-a/lease", { holder: "home-a", generation: current.generation }, c.machineCredential)).status).toBe(200);
    expect((await call("/v1/machines/home-a/lease", { holder: INSTALL, generation: current.generation }, INSTALL_CRED)).status).toBe(409);
  });
  it("F4 the matching home holder acknowledges next-generation desktop takeover while another actor cannot ack", async () => {
    const c = await ready();
    expect((await call("/v1/machines/home-a/lease", { holder: "home-a", generation: c.generation }, c.machineCredential)).status).toBe(200);
    expect((await call("/v1/fake-b3/homes/home-a/lease/ack", { holder: "home-a", generation: c.generation }, INSTALL_CRED)).status).toBe(401);
    const ack = await call("/v1/fake-b3/homes/home-a/lease/ack", { holder: "home-a", generation: c.generation }, c.machineCredential);
    expect(ack.status).toBe(200); const h = await home(); expect(h.generation).toBe(c.generation + 1);
    expect((await call("/v1/machines/home-a/lease", { holder: INSTALL, generation: h.generation }, INSTALL_CRED)).status).toBe(200);
  });
});

// Astra TAXCOUNTRY-8: ONE payment authority (C1's currentPaymentId) across subscription lines.
describe("TAXCOUNTRY-8 payment authority across subscription lines", () => {
  const A = "sub_a", B = "sub_b";
  async function payLine(sub: string, status: string, version: number, paymentId: string, id = "home-a") {
    expect((await call("/v1/fake-b3/payments", { homeId: id, status, version, eventId: `${id}-${sub}-${version}`, paymentId, subscriptionId: sub })).status).toBe(202);
  }
  const lines = async () => (await env.DB.prepare("SELECT subscription_id AS s,closed FROM cloud_subscription_lines WHERE home_id='home-a' ORDER BY subscription_id").all()).results;
  const outboxIds = async (kind: string) => (await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id='home-a' AND kind=? ORDER BY id").bind(kind).all<{ id: string }>()).results.map((r) => r.id);
  async function readyOnA() {
    await reserve(); await payLine(A, "paid", 100, "pi_a"); expect((await reconcile()).status).toBe(200);
    const c = await enrolled();
    expect((await call("/v1/fake-b3/homes/home-a/canary", { generation: c.generation, imageDigest: IMAGE, checks })).status).toBe(200);
    expect(await home()).toMatchObject({ desired_state: "ready", entitlement: "paid", payment_line: A, payment_version: 100 });
  }

  it("P1-1 delayed activation (A's problem first): B's paid v200 beats A's last PAID version (v100), not A's later payment_version (v300)", async () => {
    await readyOnA();
    await payLine(A, "payment_problem", 300, "pi_a"); await reconcile();
    expect(await home()).toMatchObject({ entitlement: "payment_problem", payment_version: 300 });
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    expect(await home()).toMatchObject({ entitlement: "paid", payment_line: B, payment_version: 200, desired_state: "ready" });
    expect(await lines()).toEqual([{ s: A, closed: 1 }, { s: B, closed: 0 }]);
    expect(await outboxIds("refund_required")).toEqual([]);
  });
  it("P1-1 delayed activation (B's paid first): A's later problem on the line B left never touches the home", async () => {
    await readyOnA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    await payLine(A, "payment_problem", 300, "pi_a"); await reconcile();
    expect(await home()).toMatchObject({ entitlement: "paid", payment_line: B, payment_version: 200, desired_state: "ready" });
    expect(await lines()).toEqual([{ s: A, closed: 1 }, { s: B, closed: 0 }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first()).toEqual({ n: 0 });
  });
  it("P1-4 F-vs-C1 selection: A paid v250 closes at v300; delayed B paid v200: A stays current, B is refunded as superseded (its own subscription)", async () => {
    await reserve(); await payLine(A, "paid", 250, "pi_a"); await reconcile();
    await payLine(A, "canceled", 300, "pi_a"); await reconcile();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    const h = await home();
    expect(h).toMatchObject({ payment_line: A, payment_version: 300, entitlement: "canceled" });
    expect(await outboxIds("refund_required")).toEqual(["refund:superseded:pi_b"]);
    const ob = JSON.parse((await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE id='refund:superseded:pi_b'").first<{ payload: string }>())!.payload);
    expect(ob).toMatchObject({ paymentId: "pi_b", subscriptionId: B, status: "paid" });
    expect(await env.DB.prepare("SELECT payment_id AS p FROM cloud_fake_refunds").all().then((r) => r.results)).toEqual([{ p: "pi_b" }]);
    // The current payment is still A's (the one payment authority); B's paid event is acknowledged only with its obligation.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_outbox WHERE kind='payment_paid' AND json_extract(payload,'$.paymentId')='pi_b'").first()).toEqual({ n: 0 });
    // A replay of B's paid event adds nothing.
    await env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=NULL WHERE id='home-a-sub_b-200'").run(); await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:superseded:pi_b"]);
  });
  it("P1-3 a stale pass never applies line A's cancellation to the line B that took the home since its read", async () => {
    await reserve(); await payLine(A, "paid", 100, "pi_a"); await reconcile();
    await payLine(A, "canceled", 150, "pi_a");
    const gate = barrier(); const spy = pauseFirstRead("SELECT * FROM cloud_homes WHERE id=?", gate);
    const running = reconcile(); await gate.entered;
    try {
      // Another pass took the home for B (paid v120, above A's paid v100) after this pass read it on line A at v100.
      await env.DB.batch([
        env.DB.prepare("UPDATE cloud_homes SET payment_line=?,payment_version=120,entitlement='paid',updated_at=? WHERE id='home-a'").bind(B, NOW),
        env.DB.prepare("INSERT INTO cloud_subscription_lines (home_id,subscription_id,version,closed,updated_at) VALUES ('home-a',?,100,1,?),('home-a',?,120,0,?) ON CONFLICT(home_id,subscription_id) DO UPDATE SET version=excluded.version,closed=excluded.closed").bind(A, NOW, B, NOW),
      ]);
    } finally { gate.release(); }
    await running; spy.mockRestore();
    expect(await home()).toMatchObject({ entitlement: "paid", payment_line: B, payment_version: 120 });
    await reconcile(); // classified again against the line as it is now: A's closed line, recorded only
    expect(await home()).toMatchObject({ entitlement: "paid", payment_line: B, payment_version: 120 });
    expect(await env.DB.prepare("SELECT processed_at IS NOT NULL AS p FROM cloud_payment_inbox WHERE id='home-a-sub_a-150'").first()).toEqual({ p: 1 });
  });
  it("P1-2 suspended takeover: B's payment after A's suspension marks it paid, cancels the deletion, asks for a resume by hand (outbox + HIGH alert)", async () => {
    await readyOnA();
    await payLine(A, "payment_problem", 300, "pi_a"); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs); await reconcile();
    expect(await home()).toMatchObject({ desired_state: "suspended" });
    expect((await home()).delete_after).not.toBeNull();
    const revoke = await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE home_id='home-a' AND kind='external_revoke_required'").first<{ payload: string }>();
    expect(JSON.parse(revoke!.payload)).toMatchObject({ paymentLine: A });
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    expect(await home()).toMatchObject({ desired_state: "suspended", entitlement: "paid", payment_line: B, payment_version: 200, delete_after: null });
    expect(await outboxIds("resume_required")).toEqual(["resume_required:home-a-sub_b-200"]);
    expect(await env.DB.prepare("SELECT severity FROM cloud_alerts WHERE home_id='home-a' AND kind='billing.resume_required' AND resolved_at IS NULL").first())
      .toEqual({ severity: "high" });
    // Round 10 (P1-5): the resume has a deadline; within it the paid home is never deleted.
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + RESUME_DEADLINE_MS - 1); await reconcile();
    expect(await home()).toMatchObject({ desired_state: "suspended", entitlement: "paid", delete_after: null });
  });
  const suspendA = async () => {
    await readyOnA();
    await payLine(A, "payment_problem", 300, "pi_a"); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs); await reconcile();
    expect(await home()).toMatchObject({ desired_state: "suspended", suspension_cause: "billing" });
  };
  const alertsOpen = async (kind: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id='home-a' AND kind=? AND resolved_at IS NULL").bind(kind).first<{ n: number }>())!.n;
  const receipt = async (id: string) => JSON.parse((await env.DB.prepare("SELECT receipt FROM cloud_outbox WHERE id=?").bind(id).first<{ receipt: string | null }>())?.receipt ?? "null");

  it("Astra TAXCOUNTRY-9 P1-5 (round 10): billing-suspended + paid: the operator's resume route moves it back to checking (fresh budget); the sweep completes the obligation and resolves its alert", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    expect(await outboxIds("resume_required")).toEqual(["resume_required:home-a-sub_b-200"]);
    expect(JSON.parse((await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE id='resume_required:home-a-sub_b-200'").first<{ payload: string }>())!.payload))
      .toMatchObject({ paymentId: "pi_b", resumeBy: NOW + config.graceMs + RESUME_DEADLINE_MS });
    expect((await call("/v1/machines/home-a/resume", {})).status).toBe(200);
    expect(await home()).toMatchObject({ desired_state: "checking", entitlement: "paid", delete_after: null, suspension_cause: null });
    await reconcile();
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "resumed" });
    expect(await alertsOpen("billing.resume_required")).toBe(0);
    expect(await outboxIds("refund_required")).toEqual([]);
  });

  it("Astra TAXCOUNTRY-9 P1-5 (round 10): billing-suspended + paid, never resumed by the deadline: the payment becomes a refund obligation with a HIGH alert, the deletion clock restarts; a late resume is refused", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + RESUME_DEADLINE_MS); await reconcile();
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "refunded", obligation: "refund:resume_lapsed:pi_b" });
    expect(await outboxIds("refund_required")).toEqual(["refund:resume_lapsed:pi_b"]);
    const h = await home();
    expect(h).toMatchObject({ desired_state: "suspended", suspension_notices: 0 });
    expect(h.delete_after).toBe(NOW + config.graceMs + RESUME_DEADLINE_MS + config.retentionMs);
    expect(await alertsOpen("billing.resume_lapsed")).toBe(1);
    expect(await alertsOpen("billing.resume_required")).toBe(0);
    expect((await call("/v1/machines/home-a/resume", {})).status).toBe(409);
  });

  it("INTEGRATED-7 P1 deletion drops the resume refund: a paid, billing-suspended home deleted before its resume: the unserved payment is refunded with the resume record, never completed as home_deleted with the money kept", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    expect(await outboxIds("resume_required")).toEqual(["resume_required:home-a-sub_b-200"]);
    await deleteHold();
    await reconcile();
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "home_deleted", obligation: "refund:resume_lapsed:pi_b" });
    expect(await outboxIds("refund_required")).toEqual(["refund:resume_lapsed:pi_b"]);
    expect(await alertsOpen("billing.resume_required")).toBe(0);
    expect(await alertsOpen("billing.resume_lapsed")).toBe(1);
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:resume_lapsed:pi_b"]); // once
  });

  it("INTEGRATED-7 P1 old resume deadline damages the replacement contract: B awaits resume, C pays and takes the home, B lapses: B refunded on its own, C's resume stays valid", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + 10 * 3_600_000);
    await payLine("sub_c", "paid", 250, "pi_c"); await reconcile();
    expect(await home()).toMatchObject({ desired_state: "suspended", entitlement: "paid", payment_line: "sub_c", delete_after: null });
    expect(await outboxIds("resume_required")).toEqual(["resume_required:home-a-sub_b-200", "resume_required:home-a-sub_c-250"]);
    // B's deadline passes (C's has 10 hours left).
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + RESUME_DEADLINE_MS); await reconcile();
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "superseded", obligation: "refund:resume_lapsed:pi_b" });
    expect(await outboxIds("refund_required")).toEqual(["refund:resume_lapsed:pi_b"]);
    // Before the fix: the home became refund_pending with a fresh deletion clock, and C's resume was refused.
    expect(await home()).toMatchObject({ desired_state: "suspended", entitlement: "paid", payment_line: "sub_c", delete_after: null });
    expect(await receipt("resume_required:home-a-sub_c-250")).toBeNull();
    expect(await alertsOpen("billing.resume_required")).toBe(1);
    expect((await call("/v1/machines/home-a/resume", {})).status).toBe(200);
    await reconcile();
    expect(await receipt("resume_required:home-a-sub_c-250")).toMatchObject({ outcome: "resumed" });
    expect(await outboxIds("refund_required")).toEqual(["refund:resume_lapsed:pi_b"]);
  });

  const refundsOf = async (paymentId: string) => (await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id='home-a' AND kind='refund_required' AND json_extract(payload,'$.paymentId')=? ORDER BY id")
    .bind(paymentId).all<{ id: string }>()).results.map((r) => r.id);
  it("INTEGRATED-8 P1 resume -> service -> replacement: B is resumed and served; C takes the home before any sweep consumed B's record: B is never refunded as unserved", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    expect((await call("/v1/machines/home-a/resume", {})).status).toBe(200);
    // The resume itself records B served (atomically with the resume), before any sweep runs.
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "resumed", by: "resume_route" });
    // C pays on another subscription and takes the home in the next pass (payments run before the resume sweep).
    await payLine("sub_c", "paid", 300, "pi_c"); await reconcile();
    expect(await home()).toMatchObject({ payment_line: "sub_c" });
    // Before the fix: mine=false classified B as superseded and wrote refund:resume_lapsed:pi_b for usage already served.
    expect(await refundsOf("pi_b")).toEqual([]);
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + RESUME_DEADLINE_MS + 1); await reconcile();
    expect((await outboxIds("refund_required")).filter((id) => id.startsWith("refund:resume_lapsed:"))).toEqual([]);
    expect(await alertsOpen("billing.resume_lapsed")).toBe(0);
  });

  it("INTEGRATED-8 P1 duplicate resume batches: two resume records of the same payment, one resume completes both; a second resume is refused; nothing is refunded after the deadline", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    await payLine(B, "paid", 201, "pi_b"); await reconcile();
    expect(await outboxIds("resume_required")).toEqual(["resume_required:home-a-sub_b-200", "resume_required:home-a-sub_b-201"]);
    const [first, second] = await Promise.all([call("/v1/machines/home-a/resume", {}), call("/v1/machines/home-a/resume", {})]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "resumed" });
    expect(await receipt("resume_required:home-a-sub_b-201")).toMatchObject({ outcome: "resumed" });
    expect(await alertsOpen("billing.resume_required")).toBe(0);
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + RESUME_DEADLINE_MS + 1); await reconcile();
    expect((await outboxIds("refund_required")).filter((id) => id.startsWith("refund:resume_lapsed:"))).toEqual([]);
    expect(await alertsOpen("billing.resume_lapsed")).toBe(0);
  });

  it("INTEGRATED-8 P1 service history: a resume whose record was left open (legacy) is still recognised as served; a never-resumed superseded payment is still refunded", async () => {
    await suspendA();
    await payLine(B, "paid", 200, "pi_b"); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + 1_000);
    expect((await call("/v1/machines/home-a/resume", {})).status).toBe(200);
    // Simulate a resume made before this fix: its record left open.
    await env.DB.prepare("UPDATE cloud_outbox SET completed_at=NULL,receipt=NULL WHERE id='resume_required:home-a-sub_b-200'").run();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs + 2_000);
    await payLine("sub_c", "paid", 300, "pi_c"); await reconcile();
    expect(await receipt("resume_required:home-a-sub_b-200")).toMatchObject({ outcome: "resumed", by: "service_history" });
    expect(await refundsOf("pi_b")).toEqual([]);
  });

  it("Astra TAXCOUNTRY-9 P1-5 (round 10): an ABUSE-suspended home is never resumed or kept from deletion by a payment (a same-line renewal included): refunded + HIGH alert", async () => {
    await suspendA();
    const deleteAfter = (await home()).delete_after;
    await env.DB.prepare("INSERT INTO abuse_closures (home_id,user_id,evidence,closed_at) VALUES ('home-a',(SELECT owner_id FROM cloud_homes WHERE id='home-a'),'evidenced abuse for this test',?)").bind(NOW).run();
    await payLine(A, "paid", 400, "pi_a2"); await reconcile();
    expect(await home()).toMatchObject({ desired_state: "suspended", entitlement: "payment_problem", delete_after: deleteAfter, payment_version: 400 });
    expect(await outboxIds("resume_required")).toEqual([]);
    expect(await outboxIds("refund_required")).toEqual(["refund:suspended:pi_a2"]);
    expect(await alertsOpen("billing.suspended_payment_refunded")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first()).toEqual({ n: 0 });
    expect((await call("/v1/machines/home-a/resume", {})).status).toBe(409);
  });

  it("Astra TAXCOUNTRY-9 P1-4 (round 10): a paid invoice on a CLOSED line is refunded (per payment), the plan stays closed: another line's, and the home's own line after its cancellation", async () => {
    await readyOnA();
    await payLine(B, "canceled", 300, "pi_b"); await reconcile(); // B's line closes without ever taking the home
    await payLine(B, "paid", 200, "pi_b2"); await reconcile(); // B's queued, distinct paid invoice lands after
    expect(await home()).toMatchObject({ payment_line: A, entitlement: "paid", payment_version: 100 });
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_b2"]);
    await payLine(A, "canceled", 500, "pi_a"); await reconcile();
    await payLine(A, "paid", 600, "pi_a3"); await reconcile(); // a late payment on the home's own, closed line
    expect(await home()).toMatchObject({ payment_line: A, entitlement: "canceled", payment_version: 500 });
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_a3", "refund:closed_line:pi_b2"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first()).toEqual({ n: 0 });
    // A payment that WAS served (its hand-off exists) is never refunded by a replay of its event.
    await env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=NULL WHERE id='home-a-sub_a-100'").run(); await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_a3", "refund:closed_line:pi_b2"]);
  });

  it("Astra TAXCOUNTRY-9 P1-3 (round 10): target-line closure race, close first: B's line closes between the takeover's read and its write: the takeover fails; B's payment is refunded, the home never sits paid on a closed line", async () => {
    await readyOnA();
    await payLine(B, "paid", 200, "pi_b");
    const gate = barrier(); const spy = pauseFirstRead("SELECT version,closed FROM cloud_subscription_lines WHERE home_id=? AND subscription_id=?", gate);
    const running = reconcile(); await gate.entered;
    try {
      // Another pass records B's cancellation (v300) on B's own line meanwhile (the home is still on A: nothing else changes).
      await env.DB.prepare("INSERT INTO cloud_subscription_lines (home_id,subscription_id,version,closed,updated_at) VALUES ('home-a',?,300,1,?)").bind(B, NOW).run();
    } finally { gate.release(); }
    await running; spy.mockRestore();
    expect(await home()).toMatchObject({ payment_line: A, payment_version: 100, entitlement: "paid" });
    await reconcile();
    expect(await home()).toMatchObject({ payment_line: A, payment_version: 100, entitlement: "paid" });
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_b"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_outbox WHERE kind='payment_paid' AND json_extract(payload,'$.paymentId')='pi_b'").first()).toEqual({ n: 0 });
  });

  it("Astra TAXCOUNTRY-9 P1-3 (round 10): target-line closure race, takeover first: a stale pass's close of B (read while the home was on A) writes nothing; re-classified, it ends the home's service on B", async () => {
    await readyOnA();
    await payLine(B, "canceled", 300, "pi_b");
    const gate = barrier(); const spy = pauseFirstRead("SELECT * FROM cloud_homes WHERE id=?", gate);
    const running = reconcile(); await gate.entered;
    try {
      // B's paid v200 took the home in another pass after this pass read it on line A.
      await env.DB.batch([
        env.DB.prepare("UPDATE cloud_homes SET payment_line=?,payment_version=200,entitlement='paid',updated_at=? WHERE id='home-a'").bind(B, NOW),
        env.DB.prepare("INSERT INTO cloud_subscription_lines (home_id,subscription_id,version,closed,updated_at) VALUES ('home-a',?,100,1,?),('home-a',?,200,0,?) ON CONFLICT(home_id,subscription_id) DO UPDATE SET version=excluded.version,closed=excluded.closed").bind(A, NOW, B, NOW),
      ]);
    } finally { gate.release(); }
    await running; spy.mockRestore();
    // The stale close wrote nothing: not acknowledged, B's line still open under the home.
    expect(await lines()).toEqual([{ s: A, closed: 1 }, { s: B, closed: 0 }]);
    expect(await env.DB.prepare("SELECT processed_at IS NULL AS pending FROM cloud_payment_inbox WHERE id='home-a-sub_b-300'").first()).toEqual({ pending: 1 });
    await reconcile();
    const h = await home();
    expect(h).toMatchObject({ payment_line: B, payment_version: 300, entitlement: "canceled" });
    expect(await lines()).toEqual([{ s: A, closed: 1 }, { s: B, closed: 1 }]);
  });

  it("INTEGRATED-7 P1 failed takeover CAS still acknowledges the payment: A at v300 (a later event of A), B's line closes mid-takeover: B is never acknowledged unrefunded", async () => {
    await readyOnA();
    await payLine(A, "payment_problem", 300, "pi_a"); await reconcile();
    expect(await home()).toMatchObject({ payment_line: A, payment_version: 300 });
    await payLine(B, "paid", 200, "pi_b");
    const gate = barrier(); const spy = pauseFirstRead("SELECT version,closed FROM cloud_subscription_lines WHERE home_id=? AND subscription_id=?", gate);
    const running = reconcile(); await gate.entered;
    try {
      await env.DB.prepare("INSERT INTO cloud_subscription_lines (home_id,subscription_id,version,closed,updated_at) VALUES ('home-a',?,400,1,?)").bind(B, NOW).run();
    } finally { gate.release(); }
    await running; spy.mockRestore();
    // Before the fix: payment_version 300 >= 200 acknowledged B with no effect and no refund.
    expect(await env.DB.prepare("SELECT processed_at IS NULL AS pending FROM cloud_payment_inbox WHERE id='home-a-sub_b-200'").first()).toEqual({ pending: 1 });
    expect(await home()).toMatchObject({ payment_line: A, payment_version: 300 });
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_b"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first()).toEqual({ n: 0 });
  });

  it("INTEGRATED-7 P1: a concurrent takeover by C fails B's takeover CAS: B is never acknowledged unapplied; next pass it is superseded and refunded", async () => {
    await readyOnA();
    await payLine(B, "paid", 200, "pi_b");
    // Paused right after B's pass read the home's current payment (A, v100): B is judged to take the home.
    const gate = barrier(); const spy = pauseFirstRead((q) => q.includes(" AS payment, ") && q.trimEnd().endsWith("AS version"), gate);
    const running = reconcile(); await gate.entered;
    try {
      // C's paid v250 takes the home in another pass after this pass read it on line A.
      await env.DB.batch([
        env.DB.prepare("UPDATE cloud_homes SET payment_line='sub_c',payment_version=250,entitlement='paid',updated_at=? WHERE id='home-a'").bind(NOW),
        env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) SELECT 'payment:home-a-sub_c-250',id,generation,owner_id,'payment_paid',?,?
          FROM cloud_homes WHERE id='home-a'`).bind(JSON.stringify({ homeId: "home-a", status: "paid", version: 250, eventId: "home-a-sub_c-250", paymentId: "pi_c", subscriptionId: "sub_c" }), NOW),
        env.DB.prepare("INSERT INTO cloud_subscription_lines (home_id,subscription_id,version,closed,updated_at) VALUES ('home-a',?,100,1,?),('home-a','sub_c',250,0,?) ON CONFLICT(home_id,subscription_id) DO UPDATE SET version=excluded.version,closed=excluded.closed").bind(A, NOW, NOW),
      ]);
    } finally { gate.release(); }
    await running; spy.mockRestore();
    // Before the fix: payment_version 250 >= 200 acknowledged B, unapplied and unrefunded.
    expect(await env.DB.prepare("SELECT processed_at IS NULL AS pending FROM cloud_payment_inbox WHERE id='home-a-sub_b-200'").first()).toEqual({ pending: 1 });
    expect(await home()).toMatchObject({ payment_line: "sub_c", payment_version: 250 });
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:superseded:pi_b"]);
    expect(await home()).toMatchObject({ payment_line: "sub_c", payment_version: 250, entitlement: "paid" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first()).toEqual({ n: 0 });
  });

  const pendingEntry = (id: string) => env.DB.prepare("SELECT processed_at IS NULL AS pending FROM cloud_payment_inbox WHERE id=?").bind(id).first();
  const unprocessed = () => env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE processed_at IS NULL").first();
  /** Runs one reconcile pass paused right after it read the home; `meanwhile` commits in that window. */
  const duringApplication = async (meanwhile: () => Promise<unknown>, read = "SELECT * FROM cloud_homes WHERE id=?") => {
    const gate = barrier(); const spy = pauseFirstRead(read, gate);
    const running = reconcile(); await gate.entered;
    try { await meanwhile(); } finally { gate.release(); }
    await running; spy.mockRestore();
  };

  it("INTEGRATED-8 P1 deletion during application: A's renewal (paid v200) is classified, the customer deletes the home before its batch: never acknowledged unapplied; refunded whatever the entitlement", async () => {
    await readyOnA();
    await payLine(A, "paid", 200, "pi_a2");
    await duringApplication(() => env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',updated_at=? WHERE id='home-a'").bind(NOW).run());
    // Before the fix: the deletion arm acknowledged the entry with no application and no refund (the home still reads entitlement 'paid').
    expect(await pendingEntry("home-a-sub_a-200")).toEqual({ pending: 1 });
    expect(await home()).toMatchObject({ entitlement: "paid", desired_state: "deleting" });
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:retired:pi_a2"]);
    expect(await unprocessed()).toEqual({ n: 0 });
    // A's own served payment replayed on the deleted home is never refunded; the refund is recorded once.
    await env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=NULL").run(); await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:retired:pi_a2"]);
    expect(await unprocessed()).toEqual({ n: 0 });
  });

  it("INTEGRATED-8 P1 same-line cancellation during application: A paid v200 is classified; A's cancellation v300 commits first: never acknowledged unapplied; refunded on its closed line next pass", async () => {
    await readyOnA();
    await payLine(A, "paid", 200, "pi_a2");
    // Paused right after this pass read A's own line (still open): the cancellation commits between that read and the application.
    await duringApplication(() => env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET payment_version=300,entitlement='canceled',updated_at=? WHERE id='home-a'").bind(NOW),
      env.DB.prepare(`INSERT INTO cloud_subscription_lines (home_id,subscription_id,version,closed,updated_at) VALUES ('home-a',?,300,1,?)
        ON CONFLICT(home_id,subscription_id) DO UPDATE SET version=excluded.version,closed=excluded.closed`).bind(A, NOW),
    ]), "SELECT version,closed FROM cloud_subscription_lines WHERE home_id=? AND subscription_id=?");
    // Before the fix: payment_version 300 >= 200 on line A acknowledged pi_a2 unapplied and unrefunded.
    expect(await pendingEntry("home-a-sub_a-200")).toEqual({ pending: 1 });
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_a2"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_outbox WHERE kind='payment_paid' AND json_extract(payload,'$.paymentId')='pi_a2'").first()).toEqual({ n: 0 });
    expect(await unprocessed()).toEqual({ n: 0 });
  });

  it("INTEGRATED-8 P1 legacy null line: a cancellation v300 commits while a paid v200 (no subscription) is being applied: refunded, never acknowledged away", async () => {
    await reserve();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 100, eventId: "legacy-100", paymentId: "pi_l1" })).status).toBe(202);
    await reconcile();
    expect(await home()).toMatchObject({ entitlement: "paid", payment_version: 100 });
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 200, eventId: "legacy-200", paymentId: "pi_l2" })).status).toBe(202);
    await duringApplication(() => env.DB.prepare("UPDATE cloud_homes SET payment_version=300,entitlement='canceled',updated_at=? WHERE id='home-a'").bind(NOW).run());
    expect(await pendingEntry("legacy-200")).toEqual({ pending: 1 });
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_l2"]);
    expect(await unprocessed()).toEqual({ n: 0 });
  });

  it("INTEGRATED-9 P1 legacy v200/v300/v400: paid v200 loses its application to a cancellation v300, then a payment_problem v400 replaces 'canceled' before the retry: v200 is still owed back (cancellation history), never acknowledged away", async () => {
    await reserve();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 100, eventId: "legacy-100", paymentId: "pi_l1" })).status).toBe(202);
    await reconcile();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 200, eventId: "legacy-200", paymentId: "pi_l2" })).status).toBe(202);
    // Another pass applies the legacy cancellation v300 while this pass applies v200: that pass's batch (home, its entry, its history row).
    await duringApplication(() => env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET payment_version=300,entitlement='canceled',updated_at=? WHERE id='home-a'").bind(NOW),
      env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES ('legacy-300','home-a',300,?,?,?)")
        .bind(JSON.stringify({ homeId: "home-a", status: "canceled", version: 300, eventId: "legacy-300", paymentId: "pi_l1" }), NOW, NOW),
      env.DB.prepare("INSERT INTO cloud_payment_cancellations (home_id,event_id,line,version,recorded_at) VALUES ('home-a','legacy-300','',300,?)").bind(NOW),
    ]));
    expect(await pendingEntry("legacy-200")).toEqual({ pending: 1 });
    // Before the retry, a payment problem v400 replaces 'canceled' as the home's entitlement.
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "payment_problem", version: 400, eventId: "legacy-400", paymentId: "pi_l3" })).status).toBe(202);
    await reconcile();
    expect(await home()).toMatchObject({ entitlement: "payment_problem", payment_version: 400 });
    // Before the fix: the generic acknowledgement took v200 (version 400 >= 200) with no application, no refund and no void.
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_l2"]);
    expect(await unprocessed()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_outbox WHERE kind='payment_paid' AND json_extract(payload,'$.paymentId')='pi_l2'").first()).toEqual({ n: 0 });
  });

  it("INTEGRATED-9 P1 cancellation history is recorded by the pass that acknowledges a cancellation, and outlives the entitlement it set", async () => {
    await reserve();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 100, eventId: "legacy-100", paymentId: "pi_l1" })).status).toBe(202);
    await reconcile();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "canceled", version: 300, eventId: "legacy-300", paymentId: "pi_l1" })).status).toBe(202);
    await reconcile();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "payment_problem", version: 400, eventId: "legacy-400", paymentId: "pi_l3" })).status).toBe(202);
    await reconcile();
    expect(await env.DB.prepare("SELECT event_id,line,version FROM cloud_payment_cancellations WHERE home_id='home-a'").all().then((r) => r.results))
      .toEqual([{ event_id: "legacy-300", line: "", version: 300 }]);
    // A stale paid v200 of that line arriving now is owed back on the history alone (the entitlement reads payment_problem).
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 200, eventId: "legacy-200", paymentId: "pi_l2" })).status).toBe(202);
    await reconcile();
    expect(await outboxIds("refund_required")).toEqual(["refund:closed_line:pi_l2"]);
    expect(await unprocessed()).toEqual({ n: 0 });
  });

  it("INTEGRATED-9 P2 a retained paid entry: persisted retry age and backoff, ONE overdue page, resolved once its payment is handled (voided)", async () => {
    await reserve();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 100, eventId: "legacy-100", paymentId: "pi_l1" })).status).toBe(202);
    await reconcile();
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "payment_problem", version: 300, eventId: "legacy-300", paymentId: "pi_l3" })).status).toBe(202);
    await reconcile();
    // A stale paid entry no cancellation overtook: it can be neither applied nor refunded automatically: RETAINED, never acknowledged away.
    expect((await call("/v1/fake-b3/payments", { homeId: "home-a", status: "paid", version: 200, eventId: "legacy-200", paymentId: "pi_l2" })).status).toBe(202);
    const retention = () => env.DB.prepare("SELECT attempts,first_retained_at,next_attempt_at,paged_at FROM cloud_payment_retention WHERE entry_id='legacy-200'").first();
    const pages = () => env.DB.prepare("SELECT COUNT(*) AS n, SUM(resolved_at IS NULL) AS open FROM cloud_alerts WHERE kind='billing.payment_retained'").first();
    for (let i = 0; i < 3; i++) await reconcile(); // the first retries are immediate (a moved fence is classified again at once)
    expect(await retention()).toEqual({ attempts: 3, first_retained_at: NOW, next_attempt_at: NOW, paged_at: null });
    await reconcile(); // then it backs off: persisted, doubling
    expect(await retention()).toMatchObject({ attempts: 4, next_attempt_at: NOW + 2 * RETAINED_BACKOFF_BASE_MS });
    await reconcile(); // inside its backoff: not tried
    expect(await retention()).toMatchObject({ attempts: 4 });
    expect(await pages()).toEqual({ n: 0, open: null });
    vi.mocked(Date.now).mockReturnValue(NOW + RETAINED_PAGE_MS);
    await reconcile(); // overdue: paged once
    expect(await retention()).toMatchObject({ attempts: 5, paged_at: NOW + RETAINED_PAGE_MS });
    expect(await pages()).toEqual({ n: 1, open: 1 });
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * RETAINED_PAGE_MS);
    await reconcile();
    expect(await pages()).toEqual({ n: 1, open: 1 }); // never a second page for the same entry
    expect(await pendingEntry("legacy-200")).toEqual({ pending: 1 });
    // Billing turns the payment away (a void): its handling exists, the entry is acknowledged, the page resolved, the retention row gone.
    await env.DB.prepare("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES ('home-a','pi_l2','ops_void','test',?)").bind(NOW).run();
    vi.mocked(Date.now).mockReturnValue(NOW + 6 * RETAINED_PAGE_MS);
    await reconcile(); await reconcile();
    expect(await pendingEntry("legacy-200")).toEqual({ pending: 0 });
    expect(await pages()).toEqual({ n: 1, open: 0 });
    expect(await retention()).toBeNull();
  });

  it("INTEGRATED-9 P2 fairness: 120 retained entries of other homes never monopolize a pass; a new entry is processed at once", async () => {
    await reserve();
    const stmts: D1PreparedStatement[] = [];
    for (let n = 0; n < 120; n++) {
      const id = `home-r${String(n).padStart(3, "0")}`;
      stmts.push(
        env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
          VALUES (?,?,?,'stopped','stopped',?,'k',500,?,?)`).bind(id, `inst-${id}`, OWNER, IMAGE, NOW, NOW),
        env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,150,?,?,NULL)")
          .bind(`stale-${id}`, id, JSON.stringify({ homeId: id, status: "paid", version: 150, eventId: `stale-${id}`, paymentId: `pi_${id}` }), NOW - 10_000, ),
        // Already retained by earlier passes (tried, due again now).
        env.DB.prepare("INSERT INTO cloud_payment_retention (entry_id,home_id,attempts,first_retained_at,last_attempt_at,next_attempt_at) VALUES (?,?,1,?,?,?)")
          .bind(`stale-${id}`, id, NOW - 5_000, NOW - 5_000, NOW - 5_000),
      );
    }
    await env.DB.batch(stmts);
    // Before the fix: ORDER BY version DESC LIMIT 100 took 100 of the v150 entries every pass; this v100 entry never came up.
    await pay("home-a", "paid", 100);
    await reconcile();
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 0 });
    expect(await home()).toMatchObject({ entitlement: "paid", payment_version: 100 });
    // The retained ones stay retained (never acknowledged away), each still tried in turn.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id LIKE 'stale-%' AND processed_at IS NULL").first()).toEqual({ n: 120 });
  });

  it("INTEGRATED-10 P2 fair slots: one hot home's 110 retained high-version entries never take the whole page from another selected home", async () => {
    await reserve();
    const id = "home-hot";
    const stmts: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
      VALUES (?,?,?,'stopped','stopped',?,'k',500,?,?)`).bind(id, `inst-${id}`, OWNER, IMAGE, NOW, NOW)];
    for (let n = 0; n < 110; n++) {
      stmts.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
        .bind(`hot-${n}`, id, 150 + n, JSON.stringify({ homeId: id, status: "paid", version: 150 + n, eventId: `hot-${n}`, paymentId: `pi_hot_${n}` }), NOW - 1_000));
    }
    await env.DB.batch(stmts);
    // Before the fix: ORDER BY version DESC LIMIT 100 over both selected homes took 100 of the hot home's v150..v259 every pass.
    await pay("home-a", "paid", 100);
    await reconcile();
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 0 });
    expect(await home()).toMatchObject({ entitlement: "paid", payment_version: 100 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id LIKE 'hot-%' AND processed_at IS NULL").first()).toEqual({ n: 110 });
  });

  it("INTEGRATED-10 P2 an entry ages from its durable receipt time: one no pass has reached yet is paged once it is overdue, never left without an age", async () => {
    await reserve();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
        VALUES ('home-unseen','inst-home-unseen',?,'stopped','stopped',?,'k',500,?,?)`).bind(OWNER, IMAGE, NOW, NOW),
      env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES ('unseen-1','home-unseen',150,?,?,NULL)")
        .bind(JSON.stringify({ homeId: "home-unseen", status: "paid", version: 150, eventId: "unseen-1", paymentId: "pi_unseen" }), NOW - 2 * RETAINED_PAGE_MS),
    ]);
    await reconcile();
    const page = await env.DB.prepare("SELECT kind,subject,detail,resolved_at FROM cloud_alerts WHERE id='alert:payment_retained:unseen-1'").first<{ kind: string; detail: string; resolved_at: number | null }>();
    expect(page).toMatchObject({ kind: "billing.payment_retained", subject: "unseen-1", resolved_at: null });
    expect(JSON.parse(page!.detail)).toMatchObject({ retainedSince: NOW - 2 * RETAINED_PAGE_MS });
    // Retained from now on, its age is the receipt's, not the pass's.
    expect(await env.DB.prepare("SELECT first_retained_at AS f FROM cloud_payment_retention WHERE entry_id='unseen-1'").first()).toEqual({ f: NOW - 2 * RETAINED_PAGE_MS });
    await reconcile();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.payment_retained'").first()).toEqual({ n: 1 });
  });

  it("INTEGRATED-11 P2 aged slots: 100 continuously active homes each winning a fair slot never starve an older paid obligation behind them; it runs within one pass", async () => {
    await reserve();
    // The older paid obligation: tried once before (retained, due again), so its home sorts behind every never-tried home.
    await pay("home-a", "paid", 100);
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_payment_inbox SET received_at=? WHERE id='home-a-event-100'").bind(NOW - 10_000),
      env.DB.prepare("INSERT INTO cloud_payment_retention (entry_id,home_id,attempts,first_retained_at,last_attempt_at,next_attempt_at) VALUES ('home-a-event-100','home-a',1,?,?,?)")
        .bind(NOW - 10_000, NOW - 1, NOW - 1),
    ]);
    const hot: D1PreparedStatement[] = [];
    for (let n = 0; n < 100; n++) {
      hot.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
        VALUES (?,?,?,'stopped','stopped',?,'k',500,?,?)`).bind(`home-h${n}`, `inst-h${n}`, OWNER, IMAGE, NOW, NOW));
    }
    await env.DB.batch(hot);
    /** Every hot home receives a fresh entry before each pass; the pass's handling of it is simulated as acknowledged afterwards (active homes). */
    const freshEntries = async (round: number) => {
      const s: D1PreparedStatement[] = [];
      for (let n = 0; n < 100; n++) {
        s.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind(`h${n}-r${round}`, `home-h${n}`, 600 + round,
          JSON.stringify({ homeId: `home-h${n}`, status: "canceled", version: 600 + round, eventId: `h${n}-r${round}`, paymentId: `pi_h${n}` }), NOW - 5));
      }
      await env.DB.batch(s);
    };
    const settleHot = () => env.DB.batch([
      env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=? WHERE home_id LIKE 'home-h%' AND processed_at IS NULL").bind(NOW),
      env.DB.prepare("DELETE FROM cloud_payment_retention WHERE home_id LIKE 'home-h%'"),
    ]);
    // Before the fix: the 100 never-tried hot homes filled the 100 home slots every pass; home-a's entry never came up.
    await freshEntries(1);
    await reconcile();
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 0 });
    expect(await home()).toMatchObject({ entitlement: "paid", payment_version: 100 });
    await settleHot();
    await freshEntries(2);
    await reconcile();
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 0 });
  });

  it("INTEGRATED-12 P2 drainage frontier: ONE hot home that adds 30 newer entries before every pass (more than all reserved slots) never starves its own oldest obligation behind 100 other active homes: it runs within one pass, in order (the newest decides first); the persisted frontier then drains that home's history at most 5 slots per pass", async () => {
    await reserve();
    await pay("home-a", "paid", 100); // the oldest obligation of home-a
    await env.DB.prepare("UPDATE cloud_payment_inbox SET received_at=? WHERE id='home-a-event-100'").bind(NOW - 10_000).run();
    const hot: D1PreparedStatement[] = [];
    for (let n = 0; n < 100; n++) {
      hot.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
        VALUES (?,?,?,'stopped','stopped',?,'k',500,?,?)`).bind(`home-h${n}`, `inst-h${n}`, OWNER, IMAGE, NOW, NOW));
    }
    await env.DB.batch(hot);
    let v = 1000;
    /** Before each pass: 30 newer paid entries of home-a (same payment), and one fresh entry for each of the 100 other homes. */
    const replenish = async (round: number) => {
      const s: D1PreparedStatement[] = [];
      for (let k = 0; k < 30; k++) {
        v++;
        s.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind(`home-a-r${round}-${k}`, "home-a", v,
          JSON.stringify({ homeId: "home-a", status: "paid", version: v, eventId: `home-a-r${round}-${k}`, paymentId: "home-a-payment" }), NOW + round * 100 + 1 + k));
      }
      for (let n = 0; n < 100; n++) {
        s.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind(`h${n}-r${round}`, `home-h${n}`, 600 + round,
          JSON.stringify({ homeId: `home-h${n}`, status: "canceled", version: 600 + round, eventId: `h${n}-r${round}`, paymentId: `pi_h${n}` }), NOW + round * 100));
      }
      await env.DB.batch(s);
    };
    const settleHot = () => env.DB.batch([
      env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=? WHERE home_id LIKE 'home-h%' AND processed_at IS NULL").bind(NOW),
      env.DB.prepare("DELETE FROM cloud_payment_retention WHERE home_id LIKE 'home-h%'"),
    ]);
    await replenish(1);
    await reconcile();
    // Before the fix: the 25 reserved slots went to home-a's 25 NEWEST entries; its oldest (31st) never came up while it kept replenishing.
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 0 });
    expect((await home()).payment_version).toBe(1030); // the newest decided first; the old entry was stale behind it
    const frontier = () => env.DB.prepare("SELECT entry_id AS id FROM cloud_payment_frontier WHERE name='payments'").first<{ id: string }>();
    expect((await frontier())?.id).toMatch(/^h\d+-r1$/); // past the reserved entries this pass took
    // Next pass: home-a adds 30 more. The frontier reaches home-a's history: its newest (deciding first) and 4 oldest, never more than 5.
    await settleHot(); await replenish(2); await reconcile();
    expect((await home()).payment_version).toBe(1060);
    for (let k = 0; k < 4; k++) expect([k, await pendingEntry(`home-a-r1-${k}`)]).toEqual([k, { pending: 0 }]);
    expect(await pendingEntry("home-a-r1-4")).toEqual({ pending: 1 });
    expect(await frontier()).toEqual({ id: "home-a-r1-3" });
  });

  // ── Astra INTEGRATED-13 P2 (reachable with Flux off): the drainage frontier's cursor and laps.
  const hotHomes = async () => {
    const hot: D1PreparedStatement[] = [];
    for (let n = 0; n < 100; n++) {
      hot.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
        VALUES (?,?,?,'stopped','stopped',?,'k',500,?,?)`).bind(`home-h${n}`, `inst-h${n}`, OWNER, IMAGE, NOW, NOW));
    }
    await env.DB.batch(hot);
  };
  /** Before each pass: `perPass` newer paid entries of home-a (same payment) and one fresh entry for each of the 100 other homes. */
  const replenishing = (perPass: number) => {
    let v = 1000;
    return async (round: number) => {
      const s: D1PreparedStatement[] = [];
      for (let k = 0; k < perPass; k++) {
        v++;
        s.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind(`home-a-r${round}-${k}`, "home-a", v,
          JSON.stringify({ homeId: "home-a", status: "paid", version: v, eventId: `home-a-r${round}-${k}`, paymentId: "home-a-payment" }), NOW + round * 100 + 1 + k));
      }
      for (let n = 0; n < 100; n++) {
        s.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind(`h${n}-r${round}`, `home-h${n}`, 600 + round,
          JSON.stringify({ homeId: `home-h${n}`, status: "canceled", version: 600 + round, eventId: `h${n}-r${round}`, paymentId: `pi_h${n}` }), NOW + round * 100));
      }
      await env.DB.batch(s);
    };
  };
  const settleOthers = () => env.DB.batch([
    env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=? WHERE home_id LIKE 'home-h%' AND processed_at IS NULL").bind(NOW),
    env.DB.prepare("DELETE FROM cloud_payment_retention WHERE home_id LIKE 'home-h%'"),
  ]);
  const frontierRow = () => env.DB.prepare("SELECT entry_id AS id,lap_horizon AS h FROM cloud_payment_frontier WHERE name='payments'").first<{ id: string; h: number | null }>();

  it("INTEGRATED-13 P2 the frontier cursor moves only after the page's work is recorded: a pass that crashes while applying its page (the worker dies, nothing more is written) leaves the cursor where it was; the oldest obligation it had taken is handled on the next pass while home-a keeps adding entries and 100 other homes keep the fair slots busy", async () => {
    await reserve();
    await pay("home-a", "paid", 100); // the oldest obligation of home-a
    await env.DB.prepare("UPDATE cloud_payment_inbox SET received_at=? WHERE id='home-a-event-100'").bind(NOW - 10_000).run();
    await hotHomes();
    const replenish = replenishing(30);
    await replenish(1);
    const prepare = env.DB.prepare.bind(env.DB);
    let dead = false;
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.startsWith("SELECT 1 AS x FROM cloud_payment_voids")) dead = true; // the first payment applied: the worker dies here
      if (dead) throw new Error("worker_died");
      return prepare(query);
    });
    try { await reconcile(); } finally { spy.mockRestore(); }
    expect(dead).toBe(true);
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 1 });
    // Before the fix: the cursor was committed BEFORE the page was processed, so it had already moved past this entry; with arrivals
    // continuing the lap never wrapped and the fair slots took newer entries: it was never handled.
    expect(await frontierRow()).toBeNull();
    await settleOthers(); await replenish(2); await reconcile();
    expect(await pendingEntry("home-a-event-100")).toEqual({ pending: 0 });
    expect((await home()).payment_version).toBe(1060); // the newest decided first; the old entry was stale behind it
    // A lap is bounded by its horizon (the newest receipt when it began): what arrives later waits for the next lap.
    expect((await frontierRow())?.h).toBe(NOW + 230);
  });

  it("INTEGRATED-13 P2 backlog yields the per-home share: a hot home with 60 entries pending past the backlog age, adding 10 newer ones before every pass behind 100 other active homes, has its whole history handled within 3 passes (before: 4 per pass, a home adding more than that grew its backlog without bound)", async () => {
    await reserve();
    await hotHomes();
    const hist: D1PreparedStatement[] = [];
    for (let k = 0; k < 60; k++) {
      hist.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)").bind(`home-a-h${k}`, "home-a", 101 + k,
        JSON.stringify({ homeId: "home-a", status: "paid", version: 101 + k, eventId: `home-a-h${k}`, paymentId: "home-a-payment" }), NOW - 2 * 3_600_000 + k));
    }
    await env.DB.batch(hist);
    const history = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id LIKE 'home-a-h%' AND processed_at IS NULL").first<{ n: number }>())!.n;
    const replenish = replenishing(10);
    const left: number[] = [];
    for (let round = 1; round <= 3; round++) { await settleOthers(); await replenish(round); await reconcile(); left.push(await history()); }
    expect(left).toEqual([36, 12, 0]); // 24 reserved slots of history per pass (its newest entry takes the 25th), oldest first
    expect((await home()).payment_version).toBe(1030); // the newest still decides first
  });

  it("INTEGRATED-11 P2 overdue paging advances: entries already paged are excluded before the limit, so 60 overdue entries all page (50 earlier + the 10 behind them now)", async () => {
    await reserve();
    const s: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,payment_version,created_at,updated_at)
      VALUES ('home-od','inst-home-od',?,'stopped','stopped',?,'k',500,?,?)`).bind(OWNER, IMAGE, NOW, NOW)];
    for (let n = 0; n < 60; n++) {
      const id = `od-${String(n).padStart(2, "0")}`;
      s.push(env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,'home-od',?,?,?,NULL)")
        .bind(id, 150 + n, JSON.stringify({ homeId: "home-od", status: "paid", version: 150 + n, eventId: id, paymentId: `pi_od_${n}` }), NOW - 2 * RETAINED_PAGE_MS + n));
      // The 50 oldest were paged by an earlier pass that never selected them (the page was full).
      if (n < 50) s.push(env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,'home-od','billing.payment_retained','high','{}',?,?)`)
        .bind(`alert:payment_retained:${id}`, NOW - RETAINED_PAGE_MS, id));
    }
    await env.DB.batch(s);
    await reconcile();
    // Before the fix: LIMIT 50 took the same 50 already-paged entries (ON CONFLICT DO NOTHING): the other 10 never paged.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.payment_retained' AND subject LIKE 'od-%'").first()).toEqual({ n: 60 });
    await reconcile();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='billing.payment_retained' AND subject LIKE 'od-%'").first()).toEqual({ n: 60 });
  });

  it("P1-2 the other order: B's payment applied before the grace ran out: the home is never suspended, no resume is needed", async () => {
    await readyOnA();
    await payLine(A, "payment_problem", 300, "pi_a"); await reconcile();
    vi.mocked(Date.now).mockReturnValue(NOW + config.graceMs);
    await payLine(B, "paid", 200, "pi_b"); await reconcile(); // payments run before the grace sweep
    expect(await home()).toMatchObject({ desired_state: "ready", entitlement: "paid", payment_line: B, grace_until: null });
    expect(await outboxIds("resume_required")).toEqual([]);
    expect(await outboxIds("external_revoke_required")).toEqual([]);
  });
});
