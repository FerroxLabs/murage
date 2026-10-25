// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type CreateHomeInput } from "../src/b3-provider";
import { AUTO_CANARY_FRESH_MS, AUTO_CANARY_PROBE_BUDGET_PER_PASS, AUTO_CANARY_PROBE_CONCURRENCY, AUTO_CANARY_RENDER_MAX_AGE_MS, AUTO_CANARY_STAGE_MS, AUTO_CANARY_DB_ANCHOR_SQL, UI_RENDER_MISSING_ALERT, UI_RENDER_MISSING_ALERT_MS, autoCanaryPass, LEASE_TTL_MS, PROVISION_MAX_MS, RECOVERY_HOLD_MS, type B3Dependencies, type Home } from "../src/b3-control";
import { encodePayload, signPayload, verifyPayload, verifyRecoveryProof, verifyHomeKey, type SignedEnvelope } from "../src/b3-signatures";
import { sha256 } from "../src/installations";
import { ALERT_POST_TIMEOUT_MS, ALERT_STAGE_MS, healthSchema, recordHealth, sweepMonitoring } from "../src/ops-monitor";

const ADMIN = "test-only-b3-admin-no-real-access";
const KEK = btoa("x".repeat(32));
const IMAGE = `sha256:${"a".repeat(64)}`;
const NOW = 1_800_000_000_000;
const OWNER = "b3-owner";
const INSTALL = "12345678-1234-4123-8123-123456789012";
const INSTALL2 = "12345678-1234-4123-8123-123456789013";
const INSTALL_CRED = `murage_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const CONFIG = {
  reservationMs: 60_000, graceMs: 60_000, retentionMs: 120_000, imageDigest: IMAGE,
  quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [
    { id: "fsn-unavailable", projectId: "project-1", location: "fsn1", serverType: "cx33", outcome: "412" },
    { id: "nbg-unavailable", projectId: "project-1", location: "nbg1", serverType: "cx33", outcome: "503" },
    { id: "hel-available", projectId: "project-2", location: "hel1", serverType: "cpx32", outcome: "available" },
  ],
};
let signingJwk: JsonWebKey;
let publicJwk: JsonWebKey;
let deviceJwk: JsonWebKey;
let devicePublicJwk: JsonWebKey;
const noNetwork = async () => { throw new Error("B3 attempted network transport"); };
function testEnv(config: unknown = CONFIG): Env {
  return { ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK, CLOUD_CP0_STAGING: "1", CLOUD_B3_MODE: "fake",
    CLOUD_B3_CONFIG: JSON.stringify(config), CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk) } as Env;
}
async function call(path: string, input?: unknown, token = ADMIN, options: {
  dependencies?: B3Dependencies; ip?: string; mode?: string; config?: unknown; env?: Record<string, string>; headers?: Record<string, string>;
} = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${token}`, ...options.headers });
  headers.set("CF-Connecting-IP", options.ip ?? "203.0.113.10");
  const response = await createWorker(noNetwork, noNetwork, options.dependencies).fetch(new Request(`https://admin.murage.test${path}`, {
    method: input === undefined ? "GET" : "POST", headers, body: input === undefined ? undefined : JSON.stringify(input),
  }), { ...testEnv(options.config), CLOUD_B3_MODE: options.mode ?? "fake", ...options.env }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function seedInstallation(installationId = INSTALL) {
  await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
    VALUES (?,?,?,'B3 test','linux',?,?)`).bind(installationId, OWNER, installationId, NOW, NOW).run();
}
async function reserve(homeId = "home-1", installationId = INSTALL, options: Parameters<typeof call>[3] = {}) {
  return call("/v1/fake-b3/reserve", { homeId, installationId, ownerId: OWNER,
    publicOrigin: `https://${homeId}.murage.test`, idempotencyKey: `reserve-key-${homeId}-0001` }, ADMIN, options);
}
async function pay(homeId = "home-1", status = "paid", version = 1, eventId = `evt-${version}`) {
  const r = await call("/v1/fake-b3/payments", { eventId, homeId, version, status, paymentId: `payment-${homeId}` });
  expect(r.status).toBe(202);
}
async function reconcile(dependencies?: B3Dependencies) {
  return call("/v1/fake-b3/reconcile", {}, ADMIN, { dependencies });
}
async function getHome(id = "home-1") { return (await env.DB.prepare("SELECT * FROM cloud_homes WHERE id=?").bind(id).first<Home>())!; }
async function ready() {
  expect((await reserve()).status).toBe(201);
  await pay();
  expect((await reconcile()).status).toBe(200);
  expect((await getHome()).desired_state).toBe("checking");
  // Actual CP0 rotate is the supported enrollment issuance surface. The
  // provisioning token is never persisted in a plaintext receipt.
  const rotated = await (await call("/v1/machines/home-1/rotate", {})).json<{ enrollmentToken: string; generation: number }>();
  const enrolled = await call("/v1/machines/home-1/enroll", { token: rotated.enrollmentToken }, "");
  expect(enrolled.status).toBe(200);
  const credential = await enrolled.json<{ machineCredential: string; generation: number }>();
  const canary = await call("/v1/fake-b3/homes/home-1/canary", { generation: credential.generation, imageDigest: IMAGE,
    checks: { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true } });
  expect(canary.status).toBe(200);
  return credential;
}
async function registerDevice(homeId = "home-1") {
  await env.DB.prepare("INSERT INTO cloud_devices VALUES ('device-1',?,?,NULL)").bind(homeId, JSON.stringify(devicePublicJwk)).run();
}
async function deviceProof(action: string, generation: number, nonce = crypto.randomUUID()) {
  return signPayload({ ...testEnv(), CLOUD_B3_SIGNING_JWK: JSON.stringify(deviceJwk) }, {
    type: "murage-device-stepup-v1", deviceId: "device-1", homeId: "home-1", generation,
    action, nonce, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
}
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  signingJwk = await crypto.subtle.exportKey("jwk", signer.privateKey);
  publicJwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
  const device = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  deviceJwk = await crypto.subtle.exportKey("jwk", device.privateKey);
  devicePublicJwk = await crypto.subtle.exportKey("jwk", device.publicKey);
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt)
    VALUES (?, 'B3 owner','b3@example.test',1,?,?)`).bind(OWNER, NOW, NOW).run();
  await seedInstallation();
});
afterEach(() => vi.restoreAllMocks());

describe("B3 inert fake Worker/D1 construction", () => {
  it("default and unknown modes leave B3 routes unavailable and create no rows", async () => {
    expect((await reserve("home-1", INSTALL, { mode: "off" })).status).toBe(404);
    expect((await reserve("home-1", INSTALL, { mode: "real" })).status).toBe(404);
    expect(await env.DB.prepare("SELECT id FROM cloud_homes").first()).toBeNull();
  });
  it("rejects missing admin, invalid config, unknown owner and unowned installation", async () => {
    expect((await call("/v1/fake-b3/reconcile", {}, "wrong")).status).toBe(401);
    expect((await reserve("home-1", INSTALL, { config: { ...CONFIG, quarantineRelayIP: "bad" } })).status).toBe(500);
    expect((await reserve("home-1", INSTALL2)).status).toBe(403);
  });
  it("skips recorded 412/503 choices, reserves before checkout, and waitlists before payment", async () => {
    expect((await reserve()).status).toBe(201);
    const slot = await env.DB.prepare("SELECT * FROM cloud_capacity WHERE home_id='home-1'").first();
    expect(slot?.id).toBe("hel-available");
    expect((await getHome()).entitlement).toBe("pending");
    expect(await env.DB.prepare("SELECT id FROM cloud_fake_resources").first()).toBeNull();
    await seedInstallation(INSTALL2);
    const wait = await reserve("home-2", INSTALL2);
    expect(wait.status).toBe(202);
    expect(await wait.json()).toEqual({ fakeOnly: true, state: "waitlisted", checkoutAllowed: false });
    expect(await env.DB.prepare("SELECT installation_id FROM cloud_waitlist").first()).not.toBeNull();
  });
  it("reservation replay is stable and a second home for one installation is refused", async () => {
    const first = await reserve();
    const payload = await first.json();
    expect(await (await reserve()).json()).toEqual(payload);
    expect((await reserve("home-other")).status).toBe(409);
    const conflict = await call("/v1/fake-b3/reserve", { homeId: "home-1", installationId: INSTALL, ownerId: OWNER,
      publicOrigin: "https://changed.test", idempotencyKey: "reserve-key-home-1-0001" });
    expect(conflict.status).toBe(409);
  });
  it("concurrent reservations cannot duplicate installation or oversell capacity", async () => {
    const responses = await Promise.all([reserve("home-a"), reserve("home-b")]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare("SELECT * FROM cloud_homes").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM cloud_capacity WHERE home_id IS NOT NULL").all()).results).toHaveLength(1);
  });
  it("deduplicates payment IDs, rejects payload reuse, and ignores reordered/delayed snapshots", async () => {
    await reserve();
    await pay("home-1", "paid", 3);
    await pay("home-1", "payment_problem", 2);
    await pay("home-1", "paid", 3);
    expect((await reconcile()).status).toBe(200);
    expect((await getHome()).entitlement).toBe("paid");
    await pay("home-1", "canceled", 1);
    await reconcile();
    expect((await getHome()).payment_version).toBe(3);
    expect((await getHome()).desired_state).toBe("checking");
    expect((await call("/v1/fake-b3/payments", { eventId: "evt-3", homeId: "home-1", version: 3,
      status: "canceled", paymentId: "payment-home-1" })).status).toBe(409);
    expect((await env.DB.prepare("SELECT * FROM cloud_payment_inbox").all()).results).toHaveLength(3);
  });
  it("payment after expiry reacquires capacity, otherwise records an idempotent fake refund without provisioning", async () => {
    await reserve();
    vi.mocked(Date.now).mockReturnValue(NOW + 60_001);
    await pay();
    await reconcile();
    expect((await getHome()).entitlement).toBe("paid");
    // A separate expired reservation loses its slot to the first paid home.
    await seedInstallation(INSTALL2);
    await env.DB.prepare(`INSERT INTO cloud_homes
      (id,installation_id,owner_id,desired_state,observed_state,reservation_expires_at,image_digest,home_key,created_at,updated_at)
      VALUES ('home-2',?,?,'payment_pending','reserved',?,?, 'identity-2',?,?)`)
      .bind(INSTALL2, OWNER, NOW, IMAGE, NOW, NOW).run();
    await pay("home-2", "paid", 1, "home2-payment");
    await reconcile();
    expect((await getHome("home-2")).entitlement).toBe("refunded");
    // Journey A6: once the refund is recorded and the resources are released, a failed home is retired (it no longer holds its owner's slot).
    expect((await getHome("home-2")).desired_state).toBe("deleted");
    const refund = await env.DB.prepare("SELECT * FROM cloud_outbox WHERE home_id='home-2' AND kind='refund_required'").first();
    expect(refund?.completed_at).toBe(Date.now());
    expect(JSON.parse(String(refund?.receipt))).toMatchObject({ fakeOnly: true, outcome: "refunded" });
    await reconcile();
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_refunds").all()).results).toHaveLength(1);
    expect(await env.DB.prepare("SELECT id FROM cloud_fake_resources WHERE home_id='home-2'").first()).toBeNull();
  });
  it("adopts a persisted matching resource after a controller crash without a second create", async () => {
    await reserve(); await pay();
    const create = vi.fn(async (input: CreateHomeInput) => {
      await fakeProvider(env.DB).create(input);
      throw new Error("synthetic crash after provider create");
    });
    const dependencies = { provider: (db: D1Database) => ({ ...fakeProvider(db), create }) };
    expect((await reconcile(dependencies)).status).toBe(500);
    expect((await getHome()).desired_state).toBe("provisioning");
    vi.mocked(Date.now).mockReturnValue(Date.now() + 5 * 60_000); // the failed attempt backs off before the retry
    expect((await reconcile(dependencies)).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare("SELECT * FROM cloud_fake_resources WHERE role='home'").all()).results).toHaveLength(1);
    expect((await getHome()).desired_state).toBe("checking");
    const m = await env.DB.prepare("SELECT * FROM cloud_machines WHERE id='home-1'").first();
    expect(m?.server_id).toBe("fake-home-home-1-1");
    expect(JSON.parse(String(m?.bound_ips))).toEqual(["203.0.113.10", "2001:db8::10"]);
  });
  it("never adopts another home/generation; refuses an ambiguous adapter response", async () => {
    await reserve(); await pay();
    const dependencies = { provider: (db: D1Database) => ({ ...fakeProvider(db),
      list_by_tag: async () => [{ id: "hostile", home_id: "other", generation: 9, role: "home", state: "running", public_ips: "[]", quarantined: 0 }],
    }) };
    expect((await reconcile(dependencies)).status).toBe(500);
    expect(await env.DB.prepare("SELECT id FROM cloud_machines").first()).toBeNull();
  });
  it("actual CP0 rotate preserves fake provider bindings and wrong IP cannot redeem or unwrap", async () => {
    const c = await ready();
    const rotation = await (await call("/v1/machines/home-1/rotate", {})).json<{ enrollmentToken: string; generation: number }>();
    expect((await call("/v1/machines/home-1/enroll", { token: rotation.enrollmentToken }, "", { ip: "203.0.113.99" })).status).toBe(401);
    expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).toBe(401);
    const e = await (await call("/v1/machines/home-1/enroll", { token: rotation.enrollmentToken }, "")).json<{ machineCredential: string }>();
    expect((await call("/v1/machines/home-1/unwrap", { generation: rotation.generation }, e.machineCredential, { ip: "203.0.113.99" })).status).toBe(403);
    const valid = await call("/v1/machines/home-1/unwrap", { generation: rotation.generation }, e.machineCredential);
    expect(valid.status).toBe(200);
    const keys = await valid.json<{ dataKey: string; bootstrapSecret: string; volumeKey: string }>();
    for (const value of [keys.dataKey, keys.bootstrapSecret, keys.volumeKey]) expect(atob(value)).toHaveLength(32);
  });
  it("requires all image canaries and keeps a failed canary out of ready", async () => {
    await reserve(); await pay(); await reconcile();
    const fail = await call("/v1/fake-b3/homes/home-1/canary", { generation: 1, imageDigest: IMAGE,
      checks: { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: false, writableState: true, schedulerHeartbeat: true } });
    expect(await fail.json()).toEqual({ fakeOnly: true, state: "failed" });
    expect((await getHome()).observed_state).toBe("failed");
  });
  it("leases last60min, heartbeat freshness is60s and desired carries signed homeKey/gates", async () => {
    const c = await ready();
    const lease = await call("/v1/machines/home-1/lease", { generation: c.generation, holder: "home-1" }, c.machineCredential);
    expect(lease.status).toBe(200);
    expect((await lease.json<{ expiresAt: number }>()).expiresAt).toBe(NOW + LEASE_TTL_MS);
    await call("/v1/machines/home-1/heartbeat", { generation: c.generation }, c.machineCredential);
    const d = await (await call("/v1/machines/home-1/desired", undefined, c.machineCredential)).json<{
      homeKey: SignedEnvelope; engineSubscriptionGates: unknown; executionAllowed: boolean; heartbeatFresh: boolean }>();
    expect(d.engineSubscriptionGates).toEqual(CONFIG.engineSubscriptionGates);
    expect(d.executionAllowed).toBe(true); expect(d.heartbeatFresh).toBe(true);
    const identity = await verifyPayload(d.homeKey, publicJwk) as { homeId: string; generation: number; publicOrigin: string };
    expect(identity).toMatchObject({ homeId: "home-1", generation: c.generation, publicOrigin: "https://home-1.murage.test" });
    await expect(verifyHomeKey(d.homeKey, publicJwk, "other", c.generation, "https://home-1.murage.test", NOW)).rejects.toThrow();
    await expect(verifyHomeKey(d.homeKey, publicJwk, "home-1", c.generation, "https://hostile.test", NOW)).rejects.toThrow();
    expect((await verifyHomeKey(d.homeKey, publicJwk, "home-1", c.generation, "https://home-1.murage.test", NOW)).homeKey).toBe((await getHome()).home_key);
    // B4 wiring step 3: flux_renewal_due is behind the Flux switch. Off (default): absent. On: present (no Flux key yet: false).
    expect("flux_renewal_due" in d).toBe(false);
    const on = await (await call("/v1/machines/home-1/desired", undefined, c.machineCredential, { env: { CLOUD_FLUX_ROUTES_ENABLED: "1" } })).json<Record<string, unknown>>();
    expect(on.flux_renewal_due).toBe(false);
    vi.mocked(Date.now).mockReturnValue(NOW + 60_001);
    expect((await (await call("/v1/machines/home-1/desired", undefined, c.machineCredential)).json<{ heartbeatFresh: boolean }>()).heartbeatFresh).toBe(false);
    // Source service expiry only; runtime quiescence and sleep are home/B7 tests.
    vi.mocked(Date.now).mockReturnValue(NOW + LEASE_TTL_MS);
    expect((await (await call("/v1/machines/home-1/desired", undefined, c.machineCredential)).json<{ executionAllowed: boolean }>()).executionAllowed).toBe(false);
  });
  it("same-generation competing holder cannot take lease; newer generation waits expiry+2min", async () => {
    const c = await ready();
    await env.DB.prepare(`INSERT INTO installation_credentials
      (id,installation_id,lookup_id,secret_hash,created_at,expires_at) VALUES ('cred-1',?,?,?,?,?)`)
      .bind(INSTALL, "a".repeat(22), await sha256(INSTALL_CRED), NOW, NOW + 10 * LEASE_TTL_MS).run();
    expect((await call("/v1/machines/home-1/lease", { generation: c.generation, holder: "home-1" }, c.machineCredential)).status).toBe(200);
    expect((await call("/v1/machines/home-1/lease", { generation: c.generation, holder: INSTALL }, INSTALL_CRED)).status).toBe(409);
    await call("/v1/machines/home-1/rotate", {});
    expect((await call("/v1/machines/home-1/lease", { generation: c.generation + 1, holder: INSTALL }, INSTALL_CRED)).status).toBe(409);
    vi.mocked(Date.now).mockReturnValue(NOW + LEASE_TTL_MS + 119_999);
    expect((await call("/v1/machines/home-1/lease", { generation: c.generation + 1, holder: INSTALL }, INSTALL_CRED)).status).toBe(409);
    vi.mocked(Date.now).mockReturnValue(NOW + LEASE_TTL_MS + 120_000);
    expect((await call("/v1/machines/home-1/lease", { generation: c.generation + 1, holder: INSTALL }, INSTALL_CRED)).status).toBe(200);
  });
  it("generation is revoked before quarantine/power-off, old credential never unwraps again", async () => {
    const c = await ready();
    const stopped = await call("/v1/fake-b3/homes/home-1/action", { generation: c.generation,
      idempotencyKey: "stop-idempotent-key-1", action: "quarantine" });
    expect(stopped.status).toBe(202);
    const order: string[] = [];
    const dependencies = { provider: (db: D1Database) => {
      const p = fakeProvider(db);
      return { ...p,
        async fence_network(resourceId: string, relayIP: string) {
          expect((await getHome()).generation).toBe(c.generation + 1);
          expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).toBe(401);
          order.push("label"); await p.fence_network(resourceId, relayIP);
        },
        async power_off(resourceId: string) { order.push("power_off"); await p.power_off(resourceId); },
      };
    } };
    await reconcile(dependencies);
    expect(order).toEqual(["label", "power_off"]);
    const r = await env.DB.prepare("SELECT state,quarantined,quarantine_relay_ip FROM cloud_fake_resources WHERE role='home'").first();
    expect(r).toMatchObject({ state: "powered_off", quarantined: 1, quarantine_relay_ip: CONFIG.quarantineRelayIP });
    await fakeProvider(env.DB).start("fake-home-home-1-1");
    expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).toBe(401);
  });
  it("payment_problem runs during grace, then suspended, two notices, deleting and TTL-before-IP", async () => {
    const c = await ready();
    await pay("home-1", "payment_problem", 4);
    await reconcile();
    expect((await getHome()).desired_state).toBe("payment_problem");
    expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(NOW + CONFIG.graceMs);
    await reconcile();
    const suspended = await getHome();
    expect(suspended.desired_state).toBe("suspended");
    expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).toBe(401);
    vi.mocked(Date.now).mockReturnValue(NOW + CONFIG.graceMs + CONFIG.retentionMs);
    await reconcile(); expect((await getHome()).desired_state).toBe("suspended");
    for (const noticeId of ["first-notice-test-key", "second-notice-test-key"]) {
      expect((await call("/v1/fake-b3/homes/home-1/notice", { generation: suspended.generation, noticeId })).status).toBe(200);
    }
    await reconcile();
    const deleting = await getHome();
    expect(deleting.desired_state).toBe("deleting");
    expect(await env.DB.prepare("SELECT * FROM cloud_fake_dns").first()).toBeNull();
    expect((await env.DB.prepare("SELECT state FROM cloud_fake_resources WHERE role='home'").first())?.state).not.toBe("destroyed");
    vi.mocked(Date.now).mockReturnValue(deleting.dns_removed_at! + 59_999);
    await reconcile(); expect((await getHome()).desired_state).toBe("deleting");
    vi.mocked(Date.now).mockReturnValue(deleting.dns_removed_at! + 60_000);
    await reconcile(); expect((await getHome()).desired_state).toBe("deleted");
    expect((await env.DB.prepare("SELECT state FROM cloud_fake_resources WHERE role='home'").first())?.state).toBe("destroyed");
    const receipts = await env.DB.prepare("SELECT kind,generation,owner_id,receipt FROM cloud_outbox WHERE home_id='home-1'").all();
    expect(receipts.results.map((r) => r.kind)).toEqual(expect.arrayContaining(["payment_problem", "suspended", "retention_ended", "dns_removed", "deleted"]));
    expect(receipts.results.every((r) => r.owner_id === OWNER && Number(r.generation) > 0)).toBe(true);
  });
  it("portal delete without device proof enters72h hold; a paired-device cancel prevents completion", async () => {
    const c = await ready(); await registerDevice();
    const input = { generation: c.generation, idempotencyKey: "delete-hold-test-key", action: "delete" };
    const response = await call("/v1/fake-b3/homes/home-1/action", input);
    expect(response.status).toBe(202);
    const held = await response.json<{ holdId: string; completesAt: number }>();
    expect(held.completesAt).toBe(NOW + RECOVERY_HOLD_MS);
    expect((await getHome()).desired_state).toBe("ready");
    expect((await call("/v1/fake-b3/homes/home-1/recovery/complete", { holdId: held.holdId })).status).toBe(409);
    expect((await call("/v1/fake-b3/homes/home-1/recovery/cancel", { holdId: held.holdId })).status).toBe(403);
    const proof = await deviceProof(`cancel_hold:${held.holdId}`, c.generation);
    expect((await call("/v1/fake-b3/homes/home-1/recovery/cancel", { holdId: held.holdId, deviceProof: proof }, "")).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(NOW + RECOVERY_HOLD_MS);
    expect((await call("/v1/fake-b3/homes/home-1/recovery/complete", { holdId: held.holdId })).status).toBe(409);
  });
  it("recovery proof is CP-signed, home/generation/time-bound and completion enqueues sign-in wipe", async () => {
    const c = await ready();
    const held = await (await call("/v1/fake-b3/homes/home-1/action", { generation: c.generation,
      idempotencyKey: "pair-recovery-test-key", action: "pair" })).json<{ holdId: string }>();
    vi.mocked(Date.now).mockReturnValue(NOW + RECOVERY_HOLD_MS);
    const completed = await call("/v1/fake-b3/homes/home-1/recovery/complete", { holdId: held.holdId });
    expect(completed.status).toBe(200);
    const { proof } = await completed.json<{ proof: SignedEnvelope }>();
    expect((await verifyRecoveryProof(proof, publicJwk, "home-1", c.generation, Date.now())).holdId).toBe(held.holdId);
    await expect(verifyRecoveryProof(proof, publicJwk, "other", c.generation, Date.now())).rejects.toThrow();
    await expect(verifyRecoveryProof(proof, publicJwk, "home-1", c.generation + 1, Date.now())).rejects.toThrow();
    await expect(verifyRecoveryProof(proof, publicJwk, "home-1", c.generation, Date.now(), "restore")).rejects.toThrow();
    await expect(verifyRecoveryProof({ ...proof, payload: encodePayload({ homeId: "other" }) }, publicJwk, "home-1", c.generation, Date.now())).rejects.toThrow();
    await expect(verifyRecoveryProof(proof, publicJwk, "home-1", c.generation, Date.now() + 300_000)).rejects.toThrow();
    const wipe = await env.DB.prepare("SELECT * FROM cloud_outbox WHERE kind='recovery_wipe_required'").first();
    expect(wipe?.completed_at).toBeNull();
    expect(JSON.parse(String(wipe?.payload))).toMatchObject({ engineSignins: true, pauseChannels: true });
    expect(await (await call("/v1/fake-b3/homes/home-1/recovery/complete", { holdId: held.holdId })).json()).toEqual({ fakeOnly: true, proof });
  });
  it("REGRESSION: a valid device proof never skips the 72-hour hold for delete, start_fresh, restore, cancel_renewal or pair", async () => {
    const c = await ready(); await registerDevice();
    for (const action of ["delete", "start_fresh", "restore", "cancel_renewal", "pair"]) {
      // A stolen, unlocked laptop signs a perfectly valid proof for exactly this action and generation.
      const proof = await deviceProof(action, c.generation);
      const response = await call("/v1/fake-b3/homes/home-1/action", { generation: c.generation,
        idempotencyKey: `stolen-device-${action}-key`, action, deviceProof: proof });
      expect([action, response.status]).toEqual([action, 202]);
      const body = await response.json<{ state: string; holdId: string; completesAt: number }>();
      expect([action, body.state, body.completesAt]).toEqual([action, "recovery_hold", NOW + RECOVERY_HOLD_MS]);
    }
    // Nothing happened at once: the home is untouched, no device was added, nothing was wiped, and every device was told.
    expect((await getHome()).desired_state).toBe("ready");
    expect((await getHome()).generation).toBe(c.generation);
    const kinds = (await env.DB.prepare("SELECT kind,payload FROM cloud_outbox WHERE home_id='home-1'").all<{ kind: string; payload: string }>()).results;
    for (const k of ["pair_required", "start_fresh_required", "restore_required", "cancel_renewal_required", "delete_hold_completed", "recovery_wipe_required", "external_revoke_required"]) {
      expect(kinds.map((x) => x.kind)).not.toContain(k);
    }
    const notices = kinds.filter((x) => x.kind === "notice_required").map((x) => JSON.parse(x.payload) as { audience: string; event: string });
    expect(notices).toHaveLength(5);
    expect(notices.every((n) => n.audience === "all_registered_devices" && n.event === "hold_started")).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds WHERE home_id='home-1' AND completed_at IS NULL").first<{ n: number }>())?.n).toBe(5);
    // The machine credential still works (nothing was revoked at once).
    expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).not.toBe(401);
    // Any registered device can still cancel one of them, and every device is told.
    const hold = await env.DB.prepare("SELECT id FROM cloud_recovery_holds WHERE action='delete'").first<{ id: string }>();
    const cancel = await deviceProof(`cancel_hold:${hold!.id}`, c.generation);
    expect((await call("/v1/fake-b3/homes/home-1/recovery/cancel", { holdId: hold!.id, deviceProof: cancel }, "")).status).toBe(200);
    expect(await env.DB.prepare("SELECT canceled_by FROM cloud_recovery_holds WHERE id=?").bind(hold!.id).first()).toEqual({ canceled_by: "device" });
    // A replayed cancel proof is refused.
    expect((await call("/v1/fake-b3/homes/home-1/recovery/cancel", { holdId: hold!.id, deviceProof: cancel }, "")).status).toBe(409);
  });
  it("scheduled runs both B3 reconcile and the legacy endpoint cleanup sweep, each isolated", async () => {
    await reserve(); await pay();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO installation_endpoints
      (installation_id,hostname,tunnel_name,tunnel_id,status,delete_requested_at,created_at,updated_at)
      VALUES ('orphan-sweep','c-orphan.murage.test','tunnel-orphan','tunnel-id-orphan','deleting',?,?,?)`).bind(now, now, now).run();
    const cloudflare = vi.fn(async () => { throw new Error("cloudflare unreachable"); });
    const ctx = createExecutionContext();
    createWorker(cloudflare as unknown as typeof fetch, noNetwork).scheduled({ scheduledTime: NOW, cron: "*/5 * * * *", noRetry() {} }, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect((await getHome()).desired_state).toBe("checking"); // reconcileB3 ran
    expect(cloudflare).toHaveBeenCalled(); // sweepManagedEndpointCleanup ran
  });
  it("a failing B3 reconcile does not stop the endpoint cleanup sweep", async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO installation_endpoints
      (installation_id,hostname,tunnel_name,tunnel_id,status,delete_requested_at,created_at,updated_at)
      VALUES ('orphan-sweep-2','c-orphan2.murage.test','tunnel-orphan2','tunnel-id-orphan2','deleting',?,?,?)`).bind(now, now, now).run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cloudflare = vi.fn(async () => { throw new Error("cloudflare unreachable"); });
    const ctx = createExecutionContext();
    createWorker(cloudflare as unknown as typeof fetch, noNetwork).scheduled({ scheduledTime: NOW, cron: "*/5 * * * *", noRetry() {} },
      { ...testEnv(), CLOUD_B3_CONFIG: "{not json" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(cloudflare).toHaveBeenCalled();
  });
  it("records a fake unwrap alert above3/day without leaking plaintext keys into receipts", async () => {
    const c = await ready();
    let key = "";
    for (let i = 0; i < 5; i++) {
      const response = await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential);
      expect(response.status).toBe(200);
      key = (await response.json<{ dataKey: string }>()).dataKey;
    }
    const alerts = await env.DB.prepare("SELECT * FROM cloud_outbox WHERE kind='unwrap_alert_required'").all();
    expect(alerts.results).toHaveLength(1);
    expect(alerts.results[0].completed_at).toBeNull();
    expect(JSON.stringify(alerts.results)).not.toContain(key);
    expect(JSON.stringify(alerts.results)).not.toContain(KEK);
  });
  it("a completed delete hold commits deleting and credential revocation together", async () => {
    const c = await ready();
    const held = await (await call("/v1/fake-b3/homes/home-1/action", { generation: c.generation,
      idempotencyKey: "completed-delete-hold", action: "delete" })).json<{ holdId: string }>();
    vi.mocked(Date.now).mockReturnValue(NOW + RECOVERY_HOLD_MS);
    expect((await call("/v1/fake-b3/homes/home-1/recovery/complete", { holdId: held.holdId })).status).toBe(200);
    expect((await getHome()).desired_state).toBe("deleting");
    expect((await call("/v1/machines/home-1/unwrap", { generation: c.generation }, c.machineCredential)).status).toBe(401);
  });
});

describe("B3 automatic canary: a paid home in checking passes on live evidence", () => {
  const LATER = NOW + 1_000;
  const CHECKS = { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true };
  /** The built UI shell as the home serves it at GET / (vite's output of index.html: an inline script, then the one hashed entry). */
  const SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><script>document.documentElement.dataset.theme="dark"</script>
    <title>Murage</title><script type="module" crossorigin src="/assets/index-B9x_Qe-2.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-Ab12.js"></head><body><div id="root"></div></body></html>`;
  const html = (body: BodyInit | null = SHELL, headers: Record<string, string> = {}, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  const script = (body: BodyInit | null = "import{a as e}from\"./vendor-Ab12.js\";e();", headers: Record<string, string> = {}, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/javascript", ...headers } });
  /** The home's public UI: the shell at /, its entry script under /assets/, a JSON 404 for anything else (server/index.ts). */
  const servedUi = (url: string) => {
    const path = new URL(url).pathname;
    return path === "/" ? html() : path === "/assets/index-B9x_Qe-2.js" ? script() : Response.json({ error: "not_found" }, { status: 404 });
  };
  /** The app process (/api/health "instance", heartbeat checks.uiInstance) and the kernel boot the heartbeats name. */
  const INSTANCE = "AbCdEfGhIjKlMnOpQrSt_-";
  const BOOT = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  /** The home's public /api/health with a render that just finished in INSTANCE (server/index.ts: exactly these four keys). */
  const publicOk = (over: Record<string, unknown> = {}) => Response.json({ app: "murage", ui: "ok", uiAt: Date.now(), instance: INSTANCE, ...over });
  /** The control plane's probe, stubbed: `answer` answers GET /api/health (default: the home's public body) and `ui` everything else
   *  (default: servedUi). `calls` records the /api/health requests (one per probed home), `all` every request. */
  function probe(answer: (url: string) => Response | Promise<Response> = () => publicOk(),
    ui: (url: string) => Response | Promise<Response> = servedUi) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const all: { url: string; init?: RequestInit }[] = [];
    const probeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      all.push({ url, init });
      if (new URL(url).pathname === "/api/health") { calls.push({ url, init }); return answer(url); }
      return ui(url);
    }) as typeof fetch;
    return { calls, all, deps: { probeFetch } satisfies B3Dependencies };
  }
  /** The home's own readiness checks, all passing (murage-control collect_health "checks"). heartbeat() adds uiAt = now (a render that
   *  just finished) to checks carrying uiRenders without one; direct recordHealth calls pass it themselves. */
  const OK_CHECKS = { uiBundle: true, dataWritable: true, uiRenders: true, uiInstance: INSTANCE };
  /** Paid, provisioned and enrolled (checking), then one heartbeat a second later carrying the app's answer and the home's checks. */
  async function enrolled(appResponding = true, checks: Record<string, unknown> | null = OK_CHECKS) {
    expect((await reserve()).status).toBe(201);
    await pay();
    expect((await reconcile()).status).toBe(200);
    expect((await getHome()).desired_state).toBe("checking");
    const c = await enroll();
    vi.mocked(Date.now).mockReturnValue(LATER);
    expect((await heartbeat(c, { appResponding, ...(checks ? { checks } : {}) })).status).toBe(200);
    return c;
  }
  // The machine routes are rate limited per IP across the whole file (edge limiters, real time) and enrolment is bound to the machine's
  // IP: these tests enrol often, so their machine calls run without the edge limiters and never spend the budget of the tests that follow.
  const ip = () => ({ env: { MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined } as unknown as Record<string, string> });
  async function enroll() {
    const rotated = await (await call("/v1/machines/home-1/rotate", {}, ADMIN, ip())).json<{ enrollmentToken: string }>();
    const enrolledRes = await call("/v1/machines/home-1/enroll", { token: rotated.enrollmentToken }, "", ip());
    expect(enrolledRes.status).toBe(200);
    return enrolledRes.json<{ machineCredential: string; generation: number }>();
  }
  /** murage-control's clock sample (Astra AUTOCANARY-6 P1): boot time since the named boot started (BOOT a minute before NOW, any other
   *  boot one second before it is first used) and the wall clock, both at `t`. */
  const bootStarts = new Map<string, number>();
  /** murage-control's evidence epoch (Astra AUTOCANARY-10): the epoch of the last heartbeat ack, per generation (each generation is its
   *  own daemon binding), echoed on the next heartbeat. */
  const acked = new Map<number, number>();
  beforeEach(() => { bootStarts.clear(); acked.clear(); });
  /** The home's current evidence epoch as stored (for reports sent straight to recordHealth). */
  const epochNow = async (id = "home-1") => (await env.DB.prepare("SELECT evidence_epoch FROM cloud_home_health WHERE home_id=?").bind(id)
    .first<{ evidence_epoch: number }>())?.evidence_epoch ?? null;
  const clockAt = (t: number, bootId = BOOT) => {
    if (!bootStarts.has(bootId)) bootStarts.set(bootId, bootId === BOOT ? NOW - 60_000 : t - 1_000);
    return { bootMs: t - bootStarts.get(bootId)!, wallMs: t };
  };
  /** murage-control's heartbeat: the boot id always rides (BOOT unless given) with the clock sample of that boot at Date.now() (unless
   *  given), a render result carries its finish time, and the health echoes the epoch of the last ack at this generation (Astra
   *  AUTOCANARY-10). A daemon that holds no epoch yet first sends the same heartbeat once to be acknowledged (it is dropped as no_epoch),
   *  exactly as a running daemon would have; an explicit evidenceEpoch key (null, a number, or undefined for an older daemon) is sent as
   *  given, without that first heartbeat. */
  const heartbeat = async (c: { machineCredential: string; generation: number }, health?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {}): Promise<Response> => {
    const checks = health?.checks as Record<string, unknown> | undefined;
    const withAt = checks && "uiRenders" in checks && !("uiAt" in checks) ? { ...health, checks: { ...checks, uiAt: Date.now() } } : health;
    const bootId = (withAt?.bootId as string | undefined) ?? BOOT;
    const clock = clockAt(Date.now(), bootId);
    // murage-control's render age on its own clock (Astra AUTOCANARY-7 P1): the sample's wall clock minus uiAt, unless given.
    const wall = ((withAt?.clock as { wallMs: number } | undefined) ?? clock).wallMs;
    const wc = withAt?.checks as Record<string, unknown> | undefined;
    const withAge = wc && typeof wc.uiAt === "number" && !("uiAgeMs" in wc) ? { ...withAt, checks: { ...wc, uiAgeMs: wall - wc.uiAt } } : withAt;
    const explicit = !!withAge && Object.prototype.hasOwnProperty.call(withAge, "evidenceEpoch");
    const send = async (epoch: number | null) => {
      const body = withAge ? { bootId: BOOT, clock, ...(explicit ? {} : { evidenceEpoch: epoch }), ...withAge } : undefined;
      if (body && body.evidenceEpoch === undefined) delete (body as Record<string, unknown>).evidenceEpoch;
      const response = await call("/v1/machines/home-1/heartbeat", { generation: c.generation, ...(body ? { health: body } : {}) },
        c.machineCredential, { ...ip(), headers: extraHeaders });
      if (response.ok) {
        const ack = await response.clone().json<{ evidenceEpoch?: number }>();
        if (typeof ack.evidenceEpoch === "number") acked.set(c.generation, ack.evidenceEpoch); else acked.delete(c.generation);
      } else acked.delete(c.generation);
      return response;
    };
    if (withAge && !explicit && !acked.has(c.generation)) await send(null);
    return send(acked.get(c.generation) ?? null);
  };
  /** The daemon's view after reports sent straight to recordHealth (or a control plane bump): it holds the epoch its last ack carried,
   *  which a real daemon gets one heartbeat later. */
  const resync = async (c: { generation: number }) => { acked.set(c.generation, (await epochNow())!); };
  /** The daemon back in step after the control plane bumped the epoch (a failed probe): its next heartbeat is dropped and carries the new
   *  epoch back, the one after is evidence. Both, as one passing report at Date.now(). */
  const inStep = async (c: { machineCredential: string; generation: number }) => {
    await resync(c);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
  };
  /** A D1 binding whose dropHealth statement (the refusal's epoch bump) fails while `failures.left` > 0 (Astra AUTOCANARY-11 P1-1);
   *  every other statement is the real one, untouched. */
  function flakyDrops(failures: { left: number }): D1Database {
    const failing = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => failing(target.bind(...values));
      if (key === "run" && failures.left > 0) return async () => { failures.left--; throw new Error("D1_ERROR: injected write failure"); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return /^UPDATE cloud_home_health SET evidence_epoch=evidence_epoch\+1,report_epoch=NULL,drop_reason=\?2/.test(sql) ? failing(statement) : statement;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  /** One machine request with exactly this body text (the daemons' real shapes, padding included), optionally on a failing D1 or with
   *  murage-control's capability header. */
  async function beat(c: { machineCredential: string }, text: string, options: { db?: D1Database; headers?: Record<string, string>;
    path?: string } = {}) {
    const ctx = createExecutionContext();
    const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${c.machineCredential}`,
      "CF-Connecting-IP": "203.0.113.10", ...options.headers });
    const e = { ...testEnv(), MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...(options.db ? { DB: options.db } : {}) } as unknown as Env;
    const response = await createWorker(noNetwork, noNetwork).fetch(new Request(`https://admin.murage.test${options.path ?? "/v1/machines/home-1/heartbeat"}`,
      { method: "POST", headers, body: text }), e, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function endpoint(status = "ready", tunnel: string | null = "tunnel-1", dns: string | null = "dns-1", updatedAt = NOW) {
    await env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,tunnel_id,dns_record_id,status,created_at,updated_at)
      VALUES ('home-1','home-1.murage.test','tunnel-home-1',?,?,?,?,?)`).bind(tunnel, dns, status, NOW, updatedAt).run();
  }
  const readyRow = (id = "home-1") => env.DB.prepare("SELECT desired_state,observed_state,canary_json,ready_pending_at,ready_at FROM cloud_homes WHERE id=?")
    .bind(id).first<{ desired_state: string; observed_state: string; canary_json: string | null; ready_pending_at: number | null; ready_at: number | null }>();
  const notices = async () => (await env.DB.prepare("SELECT kind FROM billing_notices WHERE home_id='home-1' AND kind='server_ready'").all()).results.length;
  const passedEvents = async () => (await env.DB.prepare("SELECT 1 AS x FROM cloud_outbox WHERE home_id='home-1' AND kind='canary_passed'").all()).results.length;
  /** Copies one row of home-1's to another home (the probe-budget and slow-sweep tests need several eligible homes). */
  async function cloneRow(table: string, key: string, to: string, overrides: Record<string, unknown> = {}) {
    const row = (await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key}='home-1'`).first<Record<string, unknown>>())!;
    const next: Record<string, unknown> = { ...row, [key]: to, ...overrides };
    const cols = Object.keys(next);
    await env.DB.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => next[c] ?? null)).run();
  }
  async function cloneHome(to: string) {
    await cloneRow("cloud_homes", "id", to, { installation_id: `clone-${to}`, home_key: crypto.randomUUID() });
    await cloneRow("cloud_machines", "id", to, { home_id: to, credential_hash: `clone-credential-${to}` });
    await cloneRow("cloud_home_health", "home_id", to);
    await cloneRow("machine_endpoints", "machine_id", to, { hostname: `${to}.murage.test`, tunnel_name: `tunnel-${to}`, tunnel_id: `tunnel-${to}`, dns_record_id: `dns-${to}` });
    await cloneRow("provision_attempts", "home_id", to);
  }

  it("fresh app answer, fresh current-generation heartbeat, a ready endpoint and the control plane's own probe make it ready exactly as a passed canary", async () => {
    const c = await enrolled();
    await endpoint();
    const p = probe();
    expect((await reconcile(p.deps)).status).toBe(200);
    const row = (await readyRow())!;
    expect(row).toMatchObject({ desired_state: "ready", observed_state: "ready", ready_pending_at: LATER, ready_at: LATER });
    expect(JSON.parse(row.canary_json!)).toEqual({ auto: true, generation: c.generation, imageDigest: IMAGE,
      evidence: { appOkAt: LATER, heartbeatAt: LATER, endpoint: "ready", probe: "ok" } });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].url).toBe("https://home-1.murage.test/api/health");
    expect(p.calls[0].init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(p.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(p.calls[0].init?.headers).get("authorization")).toBeNull();
    // Then the public UI shell and its one entry script, same host, no redirects, under the same probe timeout (Astra AUTOCANARY-3 P1).
    expect(p.all.map((c) => c.url)).toEqual(["https://home-1.murage.test/api/health", "https://home-1.murage.test/",
      "https://home-1.murage.test/assets/index-B9x_Qe-2.js"]);
    for (const c of p.all) {
      expect(c.init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(c.init?.signal).toBe(p.calls[0].init?.signal);
      expect(new Headers(c.init?.headers).get("authorization")).toBeNull();
    }
    expect(await notices()).toBe(1);
    expect(await passedEvents()).toBe(1);
    // The admin canary stays an override for a home still checking; once ready it is refused as before.
    const manual = await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE, checks: CHECKS });
    expect(manual.status).toBe(409);
    expect((await readyRow())!.canary_json).toBe(row.canary_json);
    expect(await notices()).toBe(1);
  });
  const doorOf = async () => (await env.DB.prepare("SELECT door_version FROM cloud_homes WHERE id='home-1'").first<{ door_version: string | null }>())?.door_version ?? null;
  const flagged = { env: { DOOR_V2_REQUIRED: "1" } };
  it("D1 heartbeat: X-Murage-Door v2 stamps door_version v2, the next heartbeat without it clears it, the ack is byte-identical", async () => {
    const c = await enrolled();
    expect(await doorOf()).toBeNull();
    const withHeader = await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" });
    expect(withHeader.status).toBe(200);
    expect(await doorOf()).toBe("v2");
    const ackWith = await withHeader.text();
    const without = await heartbeat(c, { appResponding: true, checks: OK_CHECKS });
    expect(without.status).toBe(200);
    expect(await doorOf()).toBeNull();
    // The same ack shape with and without the header (the epoch moves per report; the keys and everything else do not).
    const strip = (t: string) => { const a = JSON.parse(t) as Record<string, unknown>; delete a.evidenceEpoch; return a; };
    expect(strip(await without.text())).toEqual(strip(ackWith));
    expect(Object.keys(JSON.parse(ackWith))).toEqual(["wire", "accepted", "generation", "evidenceEpoch"]);
    // Any other value is not v2.
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v3" })).status).toBe(200);
    expect(await doorOf()).toBeNull();
  });
  const doorProofOf = async () => (await env.DB.prepare("SELECT door_proof FROM cloud_homes WHERE id='home-1'").first<{ door_proof: number }>())?.door_proof;
  it("D1 heartbeat: X-Murage-Owner-Factor 1 stamps door_proof, any other value clears it, independent of door_version (owner factor r3)", async () => {
    const c = await enrolled();
    expect(await doorProofOf()).toBe(0);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-owner-factor": "1", "x-murage-door": "v2" })).status).toBe(200);
    expect(await doorProofOf()).toBe(1); expect(await doorOf()).toBe("v2");
    for (const value of ["true", "v2", "01"]) {
      expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-owner-factor": value, "x-murage-door": "v2" })).status).toBe(200);
      expect(await doorProofOf()).toBe(0);
    }
    // door_version is independent: v2 with no owner-factor header keeps door_proof 0 and door_version v2.
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" })).status).toBe(200);
    expect(await doorProofOf()).toBe(0); expect(await doorOf()).toBe("v2");
  });
  it("D1 heartbeat: a stale generation changes nothing, header or not", async () => {
    const c = await enrolled();
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" })).status).toBe(200);
    const stale = await call("/v1/machines/home-1/heartbeat", { generation: c.generation + 1 }, c.machineCredential, ip());
    expect(stale.status).toBe(409);
    expect(await doorOf()).toBe("v2");
  });
  it("D1 MurageCloud (a): with DOOR_V2_REQUIRED a home whose heartbeats carry no door header stays checking; one heartbeat with v2 and the usual evidence promotes it", async () => {
    const c = await enrolled();
    await endpoint();
    expect((await call("/v1/fake-b3/reconcile", {}, ADMIN, { dependencies: probe().deps, ...flagged })).status).toBe(200);
    expect((await readyRow())!.desired_state).toBe("checking");
    // The admin canary's pass is refused too.
    const manual = await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE, checks: CHECKS }, ADMIN, flagged);
    expect(manual.status).toBe(409);
    expect(await manual.json()).toEqual({ error: "door_not_advertised" });
    expect((await readyRow())!.desired_state).toBe("checking");
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" })).status).toBe(200);
    expect((await call("/v1/fake-b3/reconcile", {}, ADMIN, { dependencies: probe().deps, ...flagged })).status).toBe(200);
    expect((await readyRow())!.desired_state).toBe("ready");
    // Ready only with the door the CP knows: door.ts mints murage-door-v2 for it (test/door-v2.test.ts "D1 mint ... first press after ready").
    expect(await doorOf()).toBe("v2");
  });
  it("D1 MurageCloud (a): without DOOR_V2_REQUIRED an unstamped home is promoted as before; the admin canary passes too", async () => {
    const c = await enrolled();
    await endpoint();
    expect((await reconcile(probe().deps)).status).toBe(200);
    expect((await readyRow())!.desired_state).toBe("ready");
    expect(await doorOf()).toBeNull();
    void c;
  });
  it("D1 MurageCloud (a): the admin canary on a stamped home passes with the flag on", async () => {
    const c = await enrolled();
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" })).status).toBe(200);
    const manual = await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE, checks: CHECKS }, ADMIN, flagged);
    expect(await manual.json()).toEqual({ fakeOnly: true, state: "ready" });
  });
  it("D2 Astra D1 #4: a headerless heartbeat clearing the door between the admin canary's read and its batch: 409 door_not_advertised, nothing promoted, no ready email owed", async () => {
    const c = await enrolled();
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" })).status).toBe(200);
    const afterDoorCheck = async () => { expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200); };
    const manual = await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE, checks: CHECKS }, ADMIN,
      { ...flagged, dependencies: { afterDoorCheck } });
    expect([manual.status, await manual.json()]).toEqual([409, { error: "door_not_advertised" }]);
    expect(await doorOf()).toBeNull();
    const row = await readyRow();
    expect(row!.desired_state).toBe("checking");
    expect(row!.ready_pending_at).toBeNull();
    expect(await passedEvents()).toBe(0);
    expect(await notices()).toBe(0);
    // Stamped again, the same canary passes.
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS }, { "x-murage-door": "v2" })).status).toBe(200);
    const again = await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE, checks: CHECKS }, ADMIN, flagged);
    expect(await again.json()).toEqual({ fakeOnly: true, state: "ready" });
  });
  it("repeated reconciles after the promotion change nothing and probe nothing", async () => {
    await enrolled();
    await endpoint();
    const p = probe();
    await reconcile(p.deps);
    const row = await readyRow();
    expect(row!.desired_state).toBe("ready");
    vi.mocked(Date.now).mockReturnValue(LATER + 60_000);
    await reconcile(p.deps);
    await reconcile(p.deps);
    expect(await readyRow()).toEqual(row);
    expect(p.calls).toHaveLength(1);
    expect(await notices()).toBe(1);
    expect(await passedEvents()).toBe(1);
  });
  it("an app that did not answer on its latest report keeps the home checking, without a probe", async () => {
    await enrolled(false);
    await endpoint();
    const p = probe();
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    expect(p.calls).toHaveLength(0);
    expect(await notices()).toBe(0);
  });
  it("the probe failing (404, a redirect, a wrong or longer body, not JSON, a network error, a timeout) keeps the home checking", async () => {
    const c = await enrolled();
    await endpoint();
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("not found", { status: 404 }),
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/api/health" } }),
      () => Response.json({ app: "other" }),
      () => Response.json({ app: "murage", pid: 1 }), // the loopback body: not what the public proxy serves an unsigned visitor
      () => Response.json({ app: "murage", ui: "failed" }), // the app's own render failed
      () => Response.json({ app: "murage", ui: "pending" }),
      () => Response.json({ app: "murage", ui: "ok", pid: 1 }),
      () => Response.json({ app: "murage" }), // no "ui": an app restarted into an image without the self-render (Astra AUTOCANARY-5 P2)
      () => Response.json({ app: "murage", ui: "ok" }), // no uiAt or instance
      () => Response.json(["murage"]),
      () => new Response("<html>ok</html>", { status: 200 }),
      () => { throw new TypeError("Network connection lost."); },
      () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
    ];
    for (const [index, answer] of answers.entries()) {
      const p = probe(answer);
      expect((await reconcile(p.deps)).status).toBe(200);
      expect(p.calls, `answer ${index}`).toHaveLength(1);
      expect(await readyRow(), `answer ${index}`).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    }
    expect(await notices()).toBe(0);
    await inStep(c); // every failed probe bumped the epoch
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("an endpoint that is not ready (or lacks its tunnel or DNS record) keeps the home checking, until it is", async () => {
    await enrolled();
    await endpoint("provisioning");
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    await env.DB.prepare("UPDATE machine_endpoints SET status='ready',dns_record_id=NULL WHERE machine_id='home-1'").run();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(0);
    await env.DB.prepare("UPDATE machine_endpoints SET dns_record_id='dns-1' WHERE machine_id='home-1'").run();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("an endpoint row last written before this provisioning budget began is not evidence", async () => {
    await enrolled();
    await endpoint("ready", "tunnel-1", "dns-1", NOW - 1); // retained from before provision_attempts.first_at (NOW)
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(0);
    await env.DB.prepare("UPDATE machine_endpoints SET updated_at=? WHERE machine_id='home-1'").bind(NOW).run();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("stale app health or a stale heartbeat keeps the home checking", async () => {
    await enrolled();
    await endpoint();
    const p = probe();
    const old = LATER - AUTO_CANARY_FRESH_MS - 1;
    await env.DB.prepare("UPDATE cloud_home_health SET app_reported_at=?,app_ok_at=? WHERE home_id='home-1'").bind(old, old).run();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // Fresh app health, stale heartbeat only.
    await env.DB.prepare("UPDATE cloud_home_health SET app_reported_at=?,app_ok_at=? WHERE home_id='home-1'").bind(LATER, LATER).run();
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id='home-1'").bind(old).run();
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", ready_pending_at: null });
    expect(p.calls).toHaveLength(0);
  });
  it("a heartbeat from before the current generation is not evidence", async () => {
    await enrolled();
    await endpoint();
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    expect((await call("/v1/machines/home-1/rotate", {}, ADMIN, ip())).status).toBe(200); // new generation, credential not yet re-enrolled
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("app health recorded at another generation (the generation column) does not promote", async () => {
    await enrolled();
    await endpoint();
    await env.DB.prepare("UPDATE cloud_home_health SET generation=generation-1 WHERE home_id='home-1'").run();
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    await env.DB.prepare("UPDATE cloud_home_health SET generation=NULL WHERE home_id='home-1'").run();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(0);
  });
  it("G2 never reuses G1's app success: a G2 heartbeat without app health, then a delayed G1 health write, keep it checking", async () => {
    const g1 = await enrolled(); // G1 reported the app answering
    await endpoint();
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    const g2 = await enroll(); // rotate + re-enrol: G2
    expect(g2.generation).toBeGreaterThan(g1.generation);
    expect((await heartbeat(g2, { diskUsedPercent: 10 })).status).toBe(200); // a G2 heartbeat with health but no app report
    expect(await env.DB.prepare("SELECT generation,app_reported_at,app_ok_at,disk_used_percent FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ generation: g2.generation, app_reported_at: null, app_ok_at: null, disk_used_percent: 10 });
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // G1's heartbeat committed before the rotation and its health write lands only now: it changes nothing.
    await recordHealth(testEnv(), "home-1", { appResponding: true }, LATER + 1_000, undefined, g1.generation);
    expect(await env.DB.prepare("SELECT generation,app_ok_at FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ generation: g2.generation, app_ok_at: null });
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(0);
    // G2's own app answer, once its daemon is in step again (the late G1 write bumped the epoch), is evidence.
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    await resync(g2);
    expect((await heartbeat(g2, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "ready", ready_pending_at: LATER + 2_000 });
  });
  it("probes at most AUTO_CANARY_PROBE_BUDGET_PER_PASS homes per pass, AUTO_CANARY_PROBE_CONCURRENCY at a time; the rest pass on the next", async () => {
    await enrolled();
    await endpoint();
    const others = Array.from({ length: AUTO_CANARY_PROBE_BUDGET_PER_PASS }, (_, i) => `home-x${String(i).padStart(3, "0")}`);
    for (const id of others) await cloneHome(id);
    let inFlight = 0, most = 0;
    const p = probe(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return publicOk();
    });
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(AUTO_CANARY_PROBE_BUDGET_PER_PASS);
    expect(most).toBeLessThanOrEqual(AUTO_CANARY_PROBE_CONCURRENCY);
    expect(most).toBeGreaterThan(1); // they really ran side by side
    const states = async () => (await env.DB.prepare("SELECT id,desired_state FROM cloud_homes WHERE id='home-1' OR id LIKE 'home-x%' ORDER BY id")
      .all<{ id: string; desired_state: string }>()).results;
    const first = await states();
    expect(first.filter((h) => h.desired_state === "ready")).toHaveLength(AUTO_CANARY_PROBE_BUDGET_PER_PASS);
    const waiting = first.filter((h) => h.desired_state === "checking");
    expect(waiting).toHaveLength(1);
    expect(p.calls.map((c) => c.url)).not.toContain(`https://${waiting[0].id}.murage.test/api/health`);
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(AUTO_CANARY_PROBE_BUDGET_PER_PASS + 1);
    expect(p.calls.at(-1)!.url).toBe(`https://${waiting[0].id}.murage.test/api/health`);
    expect((await states()).every((h) => h.desired_state === "ready")).toBe(true);
  }, 120_000);
  it("five probes at a time, each with its own deadline started at its first request; the budget fits the stage even if all time out (Astra AUTOCANARY-4 P2)", async () => {
    // Workers: six connections may wait for headers at once; a probe holds one at a time, so five in flight never queue.
    expect(AUTO_CANARY_PROBE_CONCURRENCY).toBe(5);
    expect(AUTO_CANARY_PROBE_CONCURRENCY).toBeLessThan(6);
    expect(Math.ceil(AUTO_CANARY_PROBE_BUDGET_PER_PASS / AUTO_CANARY_PROBE_CONCURRENCY) * 5_000).toBeLessThanOrEqual(AUTO_CANARY_STAGE_MS);
    expect(AUTO_CANARY_STAGE_MS).toBeLessThanOrEqual(92_000); // 18 waves x 5 s + 2 s of timer slack
    expect(12 * AUTO_CANARY_PROBE_BUDGET_PER_PASS).toBeGreaterThanOrEqual(1_000); // per hour, at a 5-minute cron
    await enrolled();
    await endpoint();
    for (let i = 0; i < 2 * AUTO_CANARY_PROBE_CONCURRENCY + 1; i++) await cloneHome(`home-d${String(i).padStart(2, "0")}`);
    const events: string[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { events.push(`deadline ${ms}`); return timeout(ms); });
    let inFlight = 0, most = 0;
    const p = probe(async (url) => {
      events.push(`health ${new URL(url).hostname}`);
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return publicOk();
    }, (url) => { events.push(`ui ${new URL(url).pathname}`); return servedUi(url); });
    try { await reconcile(p.deps); } finally { spy.mockRestore(); }
    const homes = 2 * AUTO_CANARY_PROBE_CONCURRENCY + 2;
    expect(p.calls).toHaveLength(homes);
    expect(most).toBe(AUTO_CANARY_PROBE_CONCURRENCY);
    // One deadline per probe, each created as that probe issues its first request (never while it waited for a slot), shared by its
    // later requests (every request of one probe carries the same signal; different probes never share one).
    expect(events.filter((e) => e.startsWith("deadline"))).toEqual(Array(homes).fill("deadline 5000"));
    events.forEach((e, i) => { if (e.startsWith("deadline")) expect(events[i + 1], `event ${i}`).toMatch(/^health /); });
    const signals = new Set(p.calls.map((c) => c.init?.signal));
    expect(signals.size).toBe(homes);
    for (const c of p.all) expect(signals.has(c.init?.signal)).toBe(true);
  }, 120_000);
  it("the probe stage stops starting probes once one could end past AUTO_CANARY_STAGE_MS of wall time", async () => {
    await enrolled();
    await endpoint();
    for (let i = 0; i < 2 * AUTO_CANARY_PROBE_CONCURRENCY; i++) await cloneHome(`home-s${String(i).padStart(2, "0")}`);
    let jumped = false;
    const p = probe(async () => {
      await null; // the whole first wave has started (the stage makes no D1 call before a fetch)
      if (!jumped) { jumped = true; vi.mocked(Date.now).mockReturnValue(LATER + AUTO_CANARY_STAGE_MS); }
      return new Response("down", { status: 503 });
    });
    await reconcile(p.deps);
    // The first wave was already started when the clock passed the stage budget; nothing after it.
    expect(p.calls).toHaveLength(AUTO_CANARY_PROBE_CONCURRENCY);
  }, 60_000);
  it("a 400-home launch fleet is promoted within 30 minutes of becoming eligible (Astra AUTOCANARY-3 P2), at most 5 probes in flight", async () => {
    await enrolled();
    await endpoint();
    const FLEET = 400;
    for (let i = 1; i < FLEET; i++) await cloneHome(`home-f${String(i).padStart(3, "0")}`);
    let inFlight = 0, most = 0;
    const p = probe(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return publicOk();
    });
    const checking = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE desired_state='checking'").first<{ n: number }>())!.n;
    expect(await checking()).toBe(FLEET);
    // Every home became eligible at LATER; the cron passes every 5 minutes and the fleet keeps heartbeating (fresh evidence each pass).
    let t = LATER, passes = 0;
    while (await checking() > 0 && t - LATER <= 30 * 60_000) {
      vi.mocked(Date.now).mockReturnValue(t);
      await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE desired_state='checking'").bind(t).run();
      await env.DB.prepare("UPDATE cloud_home_health SET reported_at=?,app_reported_at=?,app_ok_at=?,ui_rendered_at=?,app_sampled_at=?,ui_age_ms=0,report_at=?")
        .bind(t, t, t, t, t, t).run();
      await reconcile(p.deps);
      passes++;
      t += 5 * 60_000;
    }
    expect(await checking()).toBe(0);
    expect(passes).toBe(Math.ceil(FLEET / AUTO_CANARY_PROBE_BUDGET_PER_PASS)); // 5 passes: the last at 20 minutes after eligibility
    expect(p.calls).toHaveLength(FLEET);
    expect(most).toBeLessThanOrEqual(AUTO_CANARY_PROBE_CONCURRENCY);
  }, 600_000);
  it("freshness is judged when the promotion commits, after the probe, not at the sweep's start (Astra AUTOCANARY-2 P3)", async () => {
    await enrolled();
    await endpoint();
    await cloneHome("home-2");
    // home-1's probe is slow: when it returns, the shared evidence is older than the window. Neither home is promoted on it.
    const p = probe(() => { vi.mocked(Date.now).mockReturnValue(LATER + AUTO_CANARY_FRESH_MS + 1); return publicOk(); });
    await reconcile(p.deps);
    expect(await readyRow("home-1")).toMatchObject({ desired_state: "checking", ready_pending_at: null });
    expect(await readyRow("home-2")).toMatchObject({ desired_state: "checking", ready_pending_at: null });
    expect(await notices()).toBe(0);
  });
  it("ASTRA AUTOCANARY-12 P2-2 five minutes is a hard bound at the promotion batch's execution, on the database's clock: a PASS 299 s old when the promotion read its time, in a batch that runs 10 s later, is refused; the same pass without the delay promotes", async () => {
    await enrolled(); // the PASS: app report and heartbeat at LATER
    await endpoint();
    vi.mocked(Date.now).mockReturnValue(LATER + AUTO_CANARY_FRESH_MS - 1_000); // 299 s old at the promotion's `now`
    // The guard's execution time is `now` plus the time elapsed on D1's own clock since the anchor read just before `now`. A batch that
    // executes `delayMs` after the anchor is the same as an anchor read `delayMs` earlier on the database's clock.
    const delayed = (delayMs: number) => new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => sql !== AUTO_CANARY_DB_ANCHOR_SQL ? target.prepare(sql)
        : { first: async () => ({ dbAt: (await target.prepare(sql).first<{ dbAt: number }>())!.dbAt - delayMs }) };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    // The anchor is the database's clock in milliseconds (julianday('now'), sub-second).
    const dbAt = (await env.DB.prepare(AUTO_CANARY_DB_ANCHOR_SQL).first<{ dbAt: number }>())!.dbAt;
    expect(Number.isInteger(dbAt) && Math.abs(dbAt - new Date().getTime()) < 60_000).toBe(true); // Date.now is mocked; new Date() is not
    const p = probe();
    expect(await autoCanaryPass({ ...testEnv(), DB: delayed(10_000) } as Env, p.deps.probeFetch)).toBe(0);
    expect(p.calls).toHaveLength(1); // probed and passed: only the delayed guard refused it
    expect(await readyRow()).toMatchObject({ desired_state: "checking", ready_pending_at: null, canary_json: null });
    expect(await notices()).toBe(0);
    expect(await autoCanaryPass({ ...testEnv(), DB: delayed(0) } as Env, probe().deps.probeFetch)).toBe(0);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("past the provisioning budget without evidence the home is still given up on (home_never_ready)", async () => {
    await enrolled(false);
    vi.mocked(Date.now).mockReturnValue(NOW + PROVISION_MAX_MS);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("failed");
    expect(await env.DB.prepare("SELECT give_up_code FROM provision_attempts WHERE home_id='home-1'").first()).toMatchObject({ give_up_code: "home_never_ready" });
  });
  it("past the provisioning budget the home is given up on even with passing evidence: the budget is checked first", async () => {
    await enrolled();
    await endpoint();
    const at = NOW + PROVISION_MAX_MS;
    vi.mocked(Date.now).mockReturnValue(at);
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id='home-1'").bind(at).run();
    await env.DB.prepare("UPDATE cloud_home_health SET app_reported_at=?,app_ok_at=? WHERE home_id='home-1'").bind(at, at).run();
    const p = probe();
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "failed", ready_pending_at: null });
    expect(p.calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT give_up_code FROM provision_attempts WHERE home_id='home-1'").first()).toMatchObject({ give_up_code: "home_never_ready" });
    expect(await notices()).toBe(0);
  });
  it("an image that reports no readiness checks is never promoted automatically, even with the probe answering (Astra AUTOCANARY-2 P1)", async () => {
    await enrolled(true, null);
    await endpoint();
    const p = probe();
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    expect(p.calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT app_ok,ui_bundle_ok,data_writable_ok,ui_renders_ok FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ app_ok: 1, ui_bundle_ok: null, data_writable_ok: null, ui_renders_ok: null });
    expect(await notices()).toBe(0);
    // The heartbeat accepts the two image checks and the optional render: no partial block, no extra (e.g. a scheduler) field.
    expect(healthSchema.safeParse({ appResponding: true, checks: { uiBundle: true } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, checks: { uiRenders: true } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, checks: { ...OK_CHECKS, scheduler: true } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, checks: { ...OK_CHECKS, uiRenders: "ok" } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, checks: OK_CHECKS }).success).toBe(true);
    expect(healthSchema.safeParse({ appResponding: true, checks: { uiBundle: true, dataWritable: true } }).success).toBe(true);
  });
  it("uiRenders true/false/missing: only a rendered UI promotes; a later failed or missing render is not evidence (Astra AUTOCANARY-4 P1)", async () => {
    const c = await enrolled(true, { uiBundle: true, dataWritable: true }); // an app without the self-render: no uiRenders
    await endpoint();
    const p = probe();
    const stored = () => env.DB.prepare("SELECT ui_renders_ok FROM cloud_home_health WHERE home_id='home-1'").first<{ ui_renders_ok: number | null }>();
    await reconcile(p.deps);
    expect(await stored()).toEqual({ ui_renders_ok: null });
    expect((await readyRow())!.desired_state).toBe("checking");
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiRenders: false } })).status).toBe(200);
    await reconcile(p.deps);
    expect(await stored()).toEqual({ ui_renders_ok: 0 });
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(2); // probed (it serves), never promoted: its render is the missing evidence
    // Same millisecond, the render passing and failing: merged fail-closed in either order.
    // Two reports composed at the same epoch (Astra AUTOCANARY-10): the failure always bumps it, so in either order nothing passes.
    const report = (uiRenders: boolean, at: number, evidenceEpoch: number | null) => recordHealth(testEnv(), "home-1", { appResponding: true,
      bootId: BOOT, clock: clockAt(at), checks: { ...OK_CHECKS, uiRenders, uiAt: at, uiAgeMs: 0 }, evidenceEpoch }, at, undefined, c.generation);
    let e = await epochNow();
    await report(true, LATER + 2_000, e); await report(false, LATER + 2_000, e);
    expect(await stored()).toEqual({ ui_renders_ok: 0 });
    e = await epochNow();
    await report(false, LATER + 3_000, e); await report(true, LATER + 3_000, e);
    expect(await stored()).toEqual({ ui_renders_ok: 0 });
    await resync(c);
    vi.mocked(Date.now).mockReturnValue(LATER + 3_000);
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(3);
    vi.mocked(Date.now).mockReturnValue(LATER + 4_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    expect(await stored()).toEqual({ ui_renders_ok: 1 });
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "ready", ready_pending_at: LATER + 4_000 });
    expect(p.calls).toHaveLength(4);
  });
  it("cached-success expiry: a render ok at T repeated by a fresh heartbeat at T+16 min (same uiAt) never promotes (Astra AUTOCANARY-5 P1)", async () => {
    const T = LATER;
    const c = await enrolled(true, { ...OK_CHECKS, uiAt: T });
    await endpoint();
    const later = T + AUTO_CANARY_RENDER_MAX_AGE_MS + 60_000; // T+16 min
    vi.mocked(Date.now).mockReturnValue(later);
    // The app's cached answer: the same render, the same uiAt, on a fresh heartbeat and on the public origin.
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiAt: T } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT ui_renders_ok,ui_rendered_at,app_reported_at FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ ui_renders_ok: 1, ui_rendered_at: T, app_reported_at: later });
    const p = probe(() => publicOk({ uiAt: T }));
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    // The stored render alone being young is not enough either: the public answer's own uiAt must be young.
    await env.DB.prepare("UPDATE cloud_home_health SET ui_rendered_at=? WHERE home_id='home-1'").bind(later).run();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // And the other way round: a young public answer does not rescue an old stored render.
    await env.DB.prepare("UPDATE cloud_home_health SET ui_rendered_at=? WHERE home_id='home-1'").bind(T).run();
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // A new render (uiAt now) on both channels promotes.
    vi.mocked(Date.now).mockReturnValue(later + 1_000);
    await inStep(c); // the failed probes bumped the epoch
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
    expect(await notices()).toBe(1);
  });
  it("restart invalidation: a rebooted or restarted daemon holds no epoch, so nothing it reports counts until acknowledged; the probe must name the reported process (Astra AUTOCANARY-5 P1, AUTOCANARY-10)", async () => {
    const c = await enrolled();
    await endpoint();
    const BOOT2 = "2b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const OTHER = "ZyXwVuTsRqPoNmLkJiHg_-";
    const stored = () => env.DB.prepare(`SELECT ui_renders_ok,ui_instance,ui_boot_id,boot_id,report_epoch,evidence_epoch
      FROM cloud_home_health WHERE home_id='home-1'`).first<Record<string, unknown>>();
    const before = (await stored())!;
    expect(before).toMatchObject({ ui_renders_ok: 1, ui_instance: INSTANCE, ui_boot_id: BOOT, boot_id: BOOT, report_epoch: before.evidence_epoch });
    // (1) The home rebooted into BOOT2 and its app is a new process: the new daemon holds no epoch. Its report is dropped and the stored
    // report stops counting (the epoch moved past it).
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    expect((await heartbeat(c, { appResponding: true, bootId: BOOT2, checks: { ...OK_CHECKS, uiInstance: OTHER }, evidenceEpoch: null })).status).toBe(200);
    expect(await stored()).toMatchObject({ ui_instance: INSTANCE, ui_boot_id: BOOT, boot_id: BOOT2, report_epoch: null,
      evidence_epoch: (before.evidence_epoch as number) + 1 });
    await reconcile(probe().deps); // the public answer still names the stored process: the probe passes, the dropped report does not
    expect((await readyRow())!.desired_state).toBe("checking");
    // (2) Its next heartbeat echoes that ack: evidence again, from the new boot and process.
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    expect((await heartbeat(c, { appResponding: true, bootId: BOOT2, checks: { ...OK_CHECKS, uiInstance: OTHER } })).status).toBe(200);
    const now2 = (await stored())!;
    expect(now2).toMatchObject({ ui_renders_ok: 1, ui_instance: OTHER, ui_boot_id: BOOT2, report_epoch: now2.evidence_epoch });
    // (3) The public origin must answer from the process the report names: the old one fails the probe (and the failure bumps the epoch).
    await reconcile(probe(() => publicOk()).deps); // INSTANCE: the old process
    expect((await readyRow())!.desired_state).toBe("checking");
    expect((await stored())!.evidence_epoch).toBe((now2.evidence_epoch as number) + 1);
    // (4) One heartbeat later the daemon is in step again, and a probe of the reported process promotes.
    vi.mocked(Date.now).mockReturnValue(LATER + 3_000);
    expect((await heartbeat(c, { appResponding: true, bootId: BOOT2, checks: { ...OK_CHECKS, uiInstance: OTHER } })).status).toBe(200); // dropped: stale
    expect((await heartbeat(c, { appResponding: true, bootId: BOOT2, checks: { ...OK_CHECKS, uiInstance: OTHER } })).status).toBe(200);
    await reconcile(probe(() => publicOk({ instance: OTHER })).deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("an app restarted while the probe ran (a heartbeat with a new instance) aborts the promotion", async () => {
    const c = await enrolled();
    await endpoint();
    const OTHER = "ZyXwVuTsRqPoNmLkJiHg_-";
    const p = probe(async () => {
      vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
      expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiInstance: OTHER } })).status).toBe(200);
      return publicOk();
    });
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(1);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("retired identities stay retired: a late heartbeat from app process A, composed before B's pending report, is dropped by its epoch (Astra AUTOCANARY-6 P1, AUTOCANARY-10)", async () => {
    const c = await enrolled(); // process A rendered at LATER, boot BOOT
    await endpoint();
    const B = "ZyXwVuTsRqPoNmLkJiHg_-";
    const stored = () => env.DB.prepare(`SELECT ui_renders_ok,ui_instance,report_epoch,drop_reason FROM cloud_home_health WHERE home_id='home-1'`).first();
    const eA = (await epochNow())!;
    // B (the app restarted, same boot) reports its first render still pending: a failing check, the epoch moves on.
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiRenders: false, uiAt: null, uiInstance: B } })).status).toBe(200);
    expect(await stored()).toEqual({ ui_renders_ok: 0, ui_instance: B, report_epoch: eA, drop_reason: "failing_check" });
    expect(await epochNow()).toBe(eA + 1);
    // A's heartbeat, composed before B's (it echoes the epoch A's daemon held then), arrives only now: dropped, A's render never returns.
    vi.mocked(Date.now).mockReturnValue(LATER + 3_000);
    expect((await heartbeat(c, { appResponding: true, clock: clockAt(LATER + 1_000), checks: { ...OK_CHECKS, uiAt: LATER }, evidenceEpoch: eA })).status).toBe(200);
    expect(await stored()).toEqual({ ui_renders_ok: 0, ui_instance: B, report_epoch: null, drop_reason: "stale_epoch" });
    for (const instance of [INSTANCE, B]) {
      await reconcile(probe(() => publicOk({ instance })).deps);
      expect((await readyRow())!.desired_state).toBe("checking");
    }
    // B's own newer render is evidence once the daemon is in step (one dropped heartbeat after the control plane's bumps).
    vi.mocked(Date.now).mockReturnValue(LATER + 62_000);
    await resync(c);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiInstance: B } })).status).toBe(200);
    await reconcile(probe(() => publicOk({ instance: B })).deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("a render dated ahead of our clock is rejected at first sight and stays rejected as our clock catches up (Astra AUTOCANARY-6 P1)", async () => {
    const T = LATER;
    const ahead = T + 30 * 60_000; // the home's clock runs 30 minutes fast
    const c = await enrolled(true, { ...OK_CHECKS, uiAt: ahead });
    await endpoint();
    const stored = () => env.DB.prepare("SELECT ui_renders_ok,ui_rendered_at,ui_rejected_at,ui_rejected_instance FROM cloud_home_health WHERE home_id='home-1'").first();
    expect(await stored()).toEqual({ ui_renders_ok: 0, ui_rendered_at: ahead, ui_rejected_at: ahead, ui_rejected_instance: INSTANCE });
    await reconcile(probe(() => publicOk({ uiAt: ahead })).deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // The refresher stalls: the same cached answer repeats until our clock is within two minutes of it, then past it.
    for (const t of [T + 29 * 60_000, T + 30 * 60_000, T + 31 * 60_000]) {
      vi.mocked(Date.now).mockReturnValue(t);
      expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiAt: ahead } })).status).toBe(200);
      expect(await stored()).toEqual({ ui_renders_ok: 0, ui_rendered_at: ahead, ui_rejected_at: ahead, ui_rejected_instance: INSTANCE });
      await reconcile(probe(() => publicOk({ uiAt: ahead })).deps);
      expect((await readyRow())!.desired_state, String(t)).toBe("checking");
    }
    // Two minutes ahead is the limit: within it a render is judged, beyond it (by 1 ms) rejected.
    vi.mocked(Date.now).mockReturnValue(T + 32 * 60_000);
    const edge = T + 34 * 60_000 + 1;
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiAt: edge } })).status).toBe(200);
    expect(await stored()).toMatchObject({ ui_renders_ok: 0, ui_rejected_at: edge });
    // Only a new render time that is not in the future counts, and its age is that uiAt's own.
    vi.mocked(Date.now).mockReturnValue(T + 33 * 60_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    expect(await stored()).toMatchObject({ ui_renders_ok: 1, ui_rendered_at: T + 33 * 60_000, ui_rejected_at: edge });
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("murage-control's clock_ahead reason rides the heartbeat as a failed render (Astra AUTOCANARY-6 P1)", async () => {
    const checks = { uiBundle: true, dataWritable: true, uiRenders: false, uiReason: "clock_ahead", uiAt: NOW + 30 * 60_000, uiInstance: INSTANCE };
    expect(healthSchema.safeParse({ appResponding: true, bootId: BOOT, clock: { bootMs: 1, wallMs: NOW }, checks }).success).toBe(true);
    expect(healthSchema.safeParse({ appResponding: true, checks: { ...checks, uiReason: "anything else" } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, clock: { bootMs: 1.5, wallMs: NOW } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, clock: { bootMs: 1, wallMs: NOW, monoMs: 1 } }).success).toBe(false);
  });
  // Astra AUTOCANARY-10: ordering is the control plane's evidence epoch alone. Each replay below passes on the epoch design and fails if
  // acceptance falls back to any timestamp ordering (the mutation check in the round-12 report).
  const evidence = () => env.DB.prepare(`SELECT evidence_epoch,report_epoch,probe_epoch,drop_reason,app_ok,ui_bundle_ok,data_writable_ok,
      ui_renders_ok,generation FROM cloud_home_health WHERE home_id='home-1'`).first<Record<string, unknown>>();
  /** murage-control's report sent straight to recordHealth as received at `t` (a worker's own clock), echoing `epoch`: all checks passing
   *  with a render that just finished, unless overridden. Returns the epoch the ack would carry. */
  const direct = (t: number, generation: number, over: Record<string, unknown>, epoch: number | null, e: Env = testEnv()) =>
    recordHealth(e, "home-1", { appResponding: true, bootId: BOOT, clock: clockAt(t, (over.bootId as string | undefined) ?? BOOT),
      checks: { ...OK_CHECKS, uiAt: t, uiAgeMs: 0 }, evidenceEpoch: epoch, ...over } as never, t, undefined, generation);
  const unwritable = (t: number) => ({ checks: { ...OK_CHECKS, dataWritable: false, uiAt: t, uiAgeMs: 0 } });
  it("ASTRA-AUTOCANARY-10 P1 #1 replay: the live boot's failure stands; an unseen old boot's report and a delayed PASS of the live boot are dropped", async () => {
    const c = await enrolled();
    await endpoint();
    const Y = "3b4e28ba-2fa1-41d2-883f-0016d3cca427", X = "4b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const e0 = (await epochNow())!;
    // Live boot Y reports dataWritable=false at the current epoch: accepted, and the failure bumps the epoch.
    expect(await direct(LATER + 2_000, c.generation, { bootId: Y, ...unwritable(LATER + 2_000) }, e0)).toBe(e0 + 1);
    expect(await evidence()).toMatchObject({ report_epoch: e0, data_writable_ok: 0, drop_reason: "failing_check" });
    // An old boot X the control plane never saw, delayed, with whatever epoch its daemon held: dropped. Nothing is "restored".
    expect(await direct(LATER + 2_500, c.generation, { bootId: X }, e0)).toBe(e0 + 2);
    // Y's PASS composed before its failure (sampled at bootMs 1000 < 2000), delivered last: its epoch is stale, so it is dropped and never
    // replaces the failure.
    expect(await direct(LATER + 3_000, c.generation, { bootId: Y, clock: { bootMs: 1_000, wallMs: LATER + 1_000 } }, e0)).toBe(e0 + 3);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 3, report_epoch: null, data_writable_ok: 0, drop_reason: "stale_epoch" });
    vi.mocked(Date.now).mockReturnValue(LATER + 3_000);
    const p = probe();
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null });
    expect(p.calls).toHaveLength(0); // the stored data volume check is failing: not even a candidate
  });
  it("ASTRA-AUTOCANARY-10 P1 #2 replay: worker-clock inversion, an earlier PASS stamped T+2 landing after a later failure stamped T+1 on another worker, is dropped", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    // The failure (composed later, its worker's clock behind) lands first and bumps; the PASS (composed first, stamped T+2) resumes and
    // its compare-and-set on the epoch fails, whatever either clock says.
    expect(await direct(LATER + 1_000, c.generation, unwritable(LATER + 1_000), e0)).toBe(e0 + 1);
    expect(await direct(LATER + 2_000, c.generation, {}, e0)).toBe(e0 + 2);
    expect(await evidence()).toMatchObject({ report_epoch: null, data_writable_ok: 0, drop_reason: "stale_epoch" });
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // Truly concurrent, in either order: one of them is dropped or the failure bumps after the PASS; nothing stays current.
    for (const order of [0, 1]) {
      const e = (await epochNow())!;
      const pass = () => direct(LATER + 4_000, c.generation, {}, e);
      const fail = () => direct(LATER + 3_000, c.generation, unwritable(LATER + 3_000), e);
      await Promise.all(order ? [pass(), fail()] : [fail(), pass()]);
      const row = (await evidence())!;
      expect(row.report_epoch === row.evidence_epoch).toBe(false);
      await reconcile(probe().deps);
      expect((await readyRow())!.desired_state).toBe("checking");
    }
  });
  it("ASTRA-AUTOCANARY-10 P1 #3 replay: an authenticated heartbeat rejected by validation (dataWritable=false, bootSeq=0) bumps the epoch before the 400; the earlier PASS is no longer eligible", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    expect(await evidence()).toMatchObject({ report_epoch: e0 });
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    const rejected = await heartbeat(c, { appResponding: true, bootSeq: 0, checks: { ...OK_CHECKS, dataWritable: false }, evidenceEpoch: e0 });
    expect(rejected.status).toBe(400);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, drop_reason: "rejected" });
    // A heartbeat of another generation is refused (409) and bumps too; unauthenticated junk changes nothing.
    expect((await heartbeat({ ...c, generation: c.generation + 1 }, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: e0 + 1 })).status).toBe(409);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 2, drop_reason: "stale_generation" });
    expect((await call("/v1/machines/home-1/heartbeat", { generation: c.generation, health: { bootSeq: 0 } }, "murage_machine_wrong", ip())).status).toBe(401);
    expect(await epochNow()).toBe(e0 + 2);
    const p = probe();
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null });
  });
  it("ASTRA-AUTOCANARY-10 P2 #1 replay: one delayed old heartbeat is dropped once and never strands the home; the next in-step heartbeat promotes", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    // A heartbeat of an earlier daemon (an older epoch) arrives late: dropped, epoch bumped.
    expect(await direct(LATER + 500, c.generation, { bootId: "4b4e28ba-2fa1-41d2-883f-0016d3cca427" }, e0 - 1 >= 0 ? e0 - 1 : null)).toBe(e0 + 1);
    // The live daemon's next heartbeat still echoes e0: dropped once, its ack carries the new epoch; the one after is evidence.
    vi.mocked(Date.now).mockReturnValue(LATER + 60_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 2, drop_reason: "stale_epoch" });
    vi.mocked(Date.now).mockReturnValue(LATER + 120_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 2, report_epoch: e0 + 2 });
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("a delayed PASS carrying an old epoch after a failure is dropped and never raises the failed check", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, dataWritable: false } })).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: e0 })).status).toBe(200);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 2, report_epoch: null, data_writable_ok: 0, drop_reason: "stale_epoch" });
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("a probe started at epoch e, while a home failure bumps it to e+1, records nothing: its PASS write is dropped and bumps again", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    const p = probe(async () => {
      await direct(Date.now(), c.generation, unwritable(Date.now()), e0); // the home's failure lands while the probe runs
      return publicOk();
    });
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(1);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null });
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 2, probe_epoch: null, drop_reason: "stale_probe" });
  });
  it("cross-worker interleaving: the probe passed and was recorded at e, then a dropped report on another worker bumps to e+1 before the promotion batch: no promotion", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    // Another worker's failing report lands between this worker's probe record and its promotion batch.
    const guarded = new WeakSet<object>();
    let fired = false;
    const DB = new Proxy(env.DB, { get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.includes("INSERT INTO cloud_write_guards VALUES (?,EXISTS(SELECT 1 FROM (SELECT ?+")) return stmt;
        return new Proxy(stmt, { get(t, q) {
          if (q !== "bind") { const v = Reflect.get(t, q); return typeof v === "function" ? v.bind(t) : v; }
          return (...args: unknown[]) => { const bound = t.bind(...args); guarded.add(bound); return bound; };
        } });
      };
      if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!fired && statements.some((st) => guarded.has(st))) {
          fired = true;
          expect(await evidence()).toMatchObject({ probe_epoch: e0, report_epoch: e0, evidence_epoch: e0 });
          // A restarted daemon's passing report (no epoch): every stored value still passes, only the epoch moves.
          await direct(Date.now(), c.generation, {}, null);
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await autoCanaryPass({ ...testEnv(), DB } as Env, probe().deps.probeFetch)).toBe(0);
    expect(fired).toBe(true);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null });
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, data_writable_ok: 1, ui_renders_ok: 1, drop_reason: "no_epoch" });
  });
  it("a generation bump resets the row to epoch 0 with no evidence; nothing of the previous generation, nor an echo of 0 from before, counts", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    // A real generation change (the machine rotated, cloud-machines.ts rotate) is a negative event, bumped explicitly in the same batch
    // (Astra AUTOCANARY-11 P2-1: no trigger): report and probe no longer count.
    const rotated = await call("/v1/machines/home-1/rotate", {}, ADMIN, ip());
    expect(rotated.status).toBe(200);
    const G2 = (await rotated.json<{ generation: number }>()).generation;
    expect(G2).toBe(c.generation + 1);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, probe_epoch: null, drop_reason: "generation_change" });
    // The first G2 report resets the row and is not accepted, even echoing 0.
    expect(await direct(LATER + 1_000, G2, {}, 0)).toBe(0);
    expect(await evidence()).toMatchObject({ generation: G2, evidence_epoch: 0, report_epoch: null, probe_epoch: null, ui_bundle_ok: null,
      data_writable_ok: null, ui_renders_ok: null, drop_reason: "new_generation" });
    // A late G1 report never lands at G2; it only bumps.
    expect(await direct(LATER + 1_100, c.generation, {}, 0)).toBeNull();
    expect(await evidence()).toMatchObject({ generation: G2, evidence_epoch: 1, drop_reason: "generation_mismatch" });
    // A G2 report echoing the current epoch is evidence.
    expect(await direct(LATER + 1_200, G2, {}, 1)).toBe(1);
    expect(await evidence()).toMatchObject({ generation: G2, evidence_epoch: 1, report_epoch: 1, data_writable_ok: 1, ui_renders_ok: 1 });
  });
  it("the home leaving 'checking' (other than by promotion) or entering it bumps the epoch: evidence from before never promotes it", async () => {
    await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    // Real writers (Astra AUTOCANARY-11 P2-1: explicit bumps, no trigger): a payment problem takes the home out of checking, the payment
    // fixed brings it back.
    await pay("home-1", "payment_problem", 2, "evt-problem");
    await reconcile(probe().deps); // applies the payment event
    expect((await readyRow())!.desired_state).toBe("payment_problem");
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, drop_reason: "state_change" });
    await pay("home-1", "paid", 3, "evt-fixed");
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(await epochNow()).toBe(e0 + 2);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("a compromised home echoing a guessed epoch gains nothing beyond what a passing home gets", async () => {
    // The epoch is ordering, not trust: it only says no negative event was recorded since the report was composed. A home that guesses
    // the current epoch and reports PASS is exactly a passing home (its report is self-reported either way); it still needs the control
    // plane's own probe at that epoch to promote. It cannot undo a bump (an old epoch is stale, a future one is stale too and bumps), nor
    // move the epoch anywhere but up.
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    for (const guess of [e0 + 5, e0, e0 + 1]) {
      const before = (await epochNow())!;
      expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: guess })).status).toBe(200);
      expect(await epochNow()).toBe(before + 1);
      expect((await evidence())!.report_epoch).toBeNull();
    }
    // The exact guess is a passing home's report; the public UI not serving still keeps it checking.
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: await epochNow() })).status).toBe(200);
    expect((await evidence())!.report_epoch).toBe(await epochNow());
    await reconcile(probe(() => publicOk(), () => Response.json({ error: "not_found" }, { status: 404 })).deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("an older murage-control without evidenceEpoch never promotes, but its failures count", async () => {
    const c = await enrolled();
    await endpoint();
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    const old = await heartbeat(c, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: undefined });
    expect(await old.json()).toEqual({ wire: 1, accepted: true }); // its old ack
    expect(await evidence()).toMatchObject({ report_epoch: null, drop_reason: "no_epoch" });
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, dataWritable: false }, evidenceEpoch: undefined })).status).toBe(200);
    expect(await evidence()).toMatchObject({ data_writable_ok: 0, report_epoch: null, drop_reason: "no_epoch" });
    vi.mocked(Date.now).mockReturnValue(LATER + 3_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: undefined })).status).toBe(200);
    expect(await evidence()).toMatchObject({ data_writable_ok: 0 }); // a pass never raises it
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  // Astra AUTOCANARY-11 (on d00e9486e): the five sequences, verbatim.
  it("ASTRA AUTOCANARY-11 P1-1 Failed rejection bump leaves PASS eligible: PASS at e, an authenticated malformed heartbeat carrying dataWritable=false whose invalidation write fails is retried, and when every attempt fails answers 503 Retry-After 5; the resend invalidates before a passing probe can promote", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    expect(await evidence()).toMatchObject({ report_epoch: e0, evidence_epoch: e0 });
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    const malformed = (epoch: number) => JSON.stringify({ generation: c.generation,
      health: { appResponding: true, bootSeq: 0, checks: { ...OK_CHECKS, dataWritable: false }, evidenceEpoch: epoch } });
    // Two failed attempts, the third lands: the bump is recorded before the 400.
    const twice = { left: 2 };
    expect((await beat(c, malformed(e0), { db: flakyDrops(twice) })).status).toBe(400);
    expect(twice.left).toBe(0);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, drop_reason: "rejected" });
    // Back to a PASS at the current epoch.
    await resync(c);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    const e1 = (await epochNow())!;
    expect(await evidence()).toMatchObject({ report_epoch: e1, evidence_epoch: e1 });
    // Every attempt fails: nothing could be recorded, so the home is told to resend soon (the residual window, bounded below).
    const always = { left: 3 };
    const refused = await beat(c, malformed(e1), { db: flakyDrops(always) });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toEqual({ error: "heartbeat_unrecorded" });
    expect(always.left).toBe(0);
    expect(await evidence()).toMatchObject({ evidence_epoch: e1, report_epoch: e1 });
    // murage-control resends 5 s later holding no epoch (it forgets it on any failed heartbeat): its oldest shape, dropped as no_epoch.
    vi.mocked(Date.now).mockReturnValue(LATER + 6_000);
    const resent = await beat(c, JSON.stringify({ generation: c.generation, health: { appResponding: true, bootId: BOOT } }),
      { headers: { "x-murage-evidence": "epoch" } });
    expect(await resent.json()).toEqual({ wire: 1, accepted: true, generation: c.generation, evidenceEpoch: e1 + 1 });
    expect(await evidence()).toMatchObject({ evidence_epoch: e1 + 1, report_epoch: null, drop_reason: "no_epoch" });
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("ASTRA AUTOCANARY-11 P1-1 bound: a PASS whose later refusal could not be recorded never promotes past AUTO_CANARY_FRESH_MS, however long D1 refuses the home's writes", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    const always = { left: 3 };
    expect((await beat(c, JSON.stringify({ generation: c.generation, health: { appResponding: true, bootSeq: 0 } }),
      { db: flakyDrops(always) })).status).toBe(503);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0, report_epoch: e0 }); // inside the window: still eligible
    // No heartbeat is recorded since: the stored PASS's app report ages out of the canary's base evidence.
    vi.mocked(Date.now).mockReturnValue(LATER + AUTO_CANARY_FRESH_MS + 1);
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(0);
  });
  it("ASTRA AUTOCANARY-11 P1-2 Outer body rejection bypasses invalidation: a valid-credential failing heartbeat over 16 KiB (trailing JSON whitespace) is authenticated, bumps the epoch and only then answers 413; a passing probe does not promote", async () => {
    const c = await enrolled();
    await endpoint();
    const e0 = (await epochNow())!;
    const t = LATER + 1_000;
    vi.mocked(Date.now).mockReturnValue(t);
    const failing = JSON.stringify({ generation: c.generation, health: { appResponding: true, bootId: BOOT, clock: clockAt(t),
      checks: { ...OK_CHECKS, dataWritable: false, uiAt: t, uiAgeMs: 0 }, evidenceEpoch: e0 } });
    const padded = failing + " ".repeat(16 * 1024 + 1 - failing.length); // valid JSON, one byte over the cap
    expect(new TextEncoder().encode(padded).length).toBe(16 * 1024 + 1);
    const r = await beat(c, padded);
    expect(r.status).toBe(413);
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, drop_reason: "oversized" });
    // Without the credential: 401 before any byte is read, nothing changes.
    expect((await beat({ machineCredential: "murage_machine_wrong" }, padded)).status).toBe(401);
    expect(await epochNow()).toBe(e0 + 1);
    // Every other route keeps the outer cap (413 before authentication).
    expect((await beat(c, padded, { path: "/v1/machines/home-1/lease" })).status).toBe(413);
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("ASTRA AUTOCANARY-11 P1-3 Mixed-version rollout fences homes: every daemon shape in the field is answered 200 with the ack it expects; a legacy field makes a report epoch-less; the new daemon's first heartbeat has the oldest shape and asks for an epoch by header", async () => {
    const c = await enrolled();
    await endpoint();
    const t = LATER + 1_000;
    vi.mocked(Date.now).mockReturnValue(t);
    const clock = clockAt(t);
    const render = { ...OK_CHECKS, uiAt: t, uiAgeMs: 0 };
    const send = (health: Record<string, unknown>, headers?: Record<string, string>) =>
      beat(c, JSON.stringify({ generation: c.generation, health }), { headers });
    const e0 = (await epochNow())!;
    // murage-control 1e5481a7f..1ae30ebf0 (collect_health): the full report with its home-persisted boot sequence and no epoch.
    let r = await send({ appResponding: true, checks: render, bootId: BOOT, bootSeq: 4, clock, diskUsedPercent: 12 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ wire: 1, accepted: true }); // the only ack it accepts (strict_fields)
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, drop_reason: "no_epoch" });
    // Its failures count (fail-closed), its passes never do.
    r = await send({ appResponding: true, checks: { ...render, dataWritable: false }, bootId: BOOT, bootSeq: 4, clock });
    expect(r.status).toBe(200);
    expect(await evidence()).toMatchObject({ data_writable_ok: 0, report_epoch: null, drop_reason: "no_epoch" });
    // A legacy field wins over an echoed epoch: never evidence, old ack.
    const current = (await epochNow())!;
    r = await send({ appResponding: true, checks: render, bootId: BOOT, bootSeq: 4, clock, evidenceEpoch: current });
    expect(await r.json()).toEqual({ wire: 1, accepted: true });
    expect(await evidence()).toMatchObject({ evidence_epoch: current + 1, report_epoch: null, data_writable_ok: 0 });
    // murage-control 56a15e901 (the image the staging homes run): no checks, no clock, no epoch.
    r = await send({ appResponding: true, bootId: BOOT, diskUsedPercent: 12 });
    expect(await r.json()).toEqual({ wire: 1, accepted: true });
    // Strict for everything else.
    expect((await send({ appResponding: true, bootId: BOOT, retired: [] })).status).toBe(400);
    // The new murage-control: its first heartbeat is that oldest shape plus the capability header, and the ack carries the epoch.
    r = await send({ appResponding: true, bootId: BOOT, diskUsedPercent: 12 }, { "x-murage-evidence": "epoch" });
    const ack = await r.json<{ wire: number; accepted: boolean; generation: number; evidenceEpoch: number }>();
    expect(ack).toEqual({ wire: 1, accepted: true, generation: c.generation, evidenceEpoch: await epochNow() });
    // Then the full report echoing it: evidence.
    r = await send({ appResponding: true, checks: render, bootId: BOOT, clock, diskUsedPercent: 12, evidenceEpoch: ack.evidenceEpoch },
      { "x-murage-evidence": "epoch" });
    expect(await r.json()).toEqual({ wire: 1, accepted: true, generation: c.generation, evidenceEpoch: ack.evidenceEpoch });
    expect(await evidence()).toMatchObject({ evidence_epoch: ack.evidenceEpoch, report_epoch: ack.evidenceEpoch, data_writable_ok: 1 });
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("ASTRA AUTOCANARY-11 P2-1 Triggers make committed transitions report failure: with a populated health row, a failed canary and a stop commit, answer success and bump the epoch explicitly", async () => {
    const c = await enrolled();
    await endpoint();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='cloud_homes'").first<{ n: number }>())!.n).toBe(0);
    const e0 = (await epochNow())!;
    expect(await evidence()).toMatchObject({ report_epoch: e0 });
    const failed = await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE,
      checks: { authenticatedUI: true, engineRoundTrip: false, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true } });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ fakeOnly: true, state: "failed" });
    expect((await readyRow())!.desired_state).toBe("failed");
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 1, report_epoch: null, probe_epoch: null, drop_reason: "state_change" });
    const stop = await call("/v1/fake-b3/homes/home-1/action", { generation: c.generation, idempotencyKey: "stop-after-failed-canary-0001", action: "stop" });
    expect(stop.status).toBe(202);
    expect((await getHome()).desired_state).toBe("stopped");
    expect(await evidence()).toMatchObject({ evidence_epoch: e0 + 2, drop_reason: "generation_change" });
  });
  it("ASTRA AUTOCANARY-11 P2-2 Epoch mismatch produces false render alerts: after accepted healthy evidence, repeated no-epoch PASS reports over fifteen minutes neither keep the home a probed canary candidate nor raise home.ui_render_missing; it shows as needing an update", async () => {
    const c = await enrolled();
    await endpoint();
    expect(await evidence()).toMatchObject({ report_epoch: await epochNow() }); // accepted healthy evidence
    const p = probe();
    for (let i = 0; i <= 3; i++) {
      vi.mocked(Date.now).mockReturnValue(LATER + 1_000 + i * 5 * 60_000);
      // An old daemon's PASS: no epoch, its old ack.
      expect(await (await heartbeat(c, { appResponding: true, checks: OK_CHECKS, evidenceEpoch: undefined })).json()).toEqual({ wire: 1, accepted: true });
      await reconcile(p.deps);
    }
    expect(p.calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id='home-1' AND kind=?").bind(UI_RENDER_MISSING_ALERT)
      .first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare("SELECT ui_missing_since FROM provision_attempts WHERE home_id='home-1'").first()).toEqual({ ui_missing_since: null });
    // "Needs update": the app answers (display app_ok), but its reports are never evidence.
    expect(await evidence()).toMatchObject({ app_ok: 1, report_epoch: null, drop_reason: "no_epoch" });
    expect((await readyRow())!.desired_state).toBe("checking");
  });
  it("the T+30m sequence: a clock_ahead refusal is honoured whenever it arrives and its render never promotes; a new render after the correction does (Astra AUTOCANARY-7 P1)", async () => {
    const T = LATER;
    const ahead = T + 30 * 60_000; // the render at T was stamped T+30m (the home's clock ran fast, then was corrected)
    const c = await enrolled(true, { ...OK_CHECKS, uiRenders: false, uiAt: null });
    await endpoint();
    const stored = () => env.DB.prepare("SELECT ui_renders_ok,ui_rendered_at,ui_rejected_at,ui_rejected_instance,ui_age_ms FROM cloud_home_health WHERE home_id='home-1'").first();
    // murage-control refused it (clock_ahead) and keeps refusing it; this heartbeat reaches us at T+29m, within two minutes of uiAt.
    vi.mocked(Date.now).mockReturnValue(T + 29 * 60_000);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiRenders: false, uiReason: "clock_ahead", uiAt: ahead } })).status).toBe(200);
    expect(await stored()).toEqual({ ui_renders_ok: 0, ui_rendered_at: ahead, ui_rejected_at: ahead, ui_rejected_instance: INSTANCE, ui_age_ms: -60_000 });
    // The same render then reported as a success (an older murage-control, or its state lost) stays rejected, whatever the clocks say.
    for (const t of [T + 30 * 60_000, T + 31 * 60_000, T + 33 * 60_000]) {
      vi.mocked(Date.now).mockReturnValue(t);
      expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiAt: ahead } })).status).toBe(200);
      expect(await stored()).toMatchObject({ ui_renders_ok: 0, ui_rendered_at: ahead, ui_rejected_at: ahead });
      await reconcile(probe(() => publicOk({ uiAt: ahead })).deps);
      expect((await readyRow())!.desired_state, String(t)).toBe("checking");
    }
    // A legitimate new render after the correction, young on the home's own clock, promotes.
    vi.mocked(Date.now).mockReturnValue(T + 34 * 60_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    expect(await stored()).toMatchObject({ ui_renders_ok: 1, ui_rendered_at: T + 34 * 60_000, ui_age_ms: 0 });
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("render age is the home's own (uiAgeMs) plus time since receipt, and a report held in transit over two minutes is not evidence (Astra AUTOCANARY-7 P1)", async () => {
    const c = await enrolled(true, { ...OK_CHECKS, uiRenders: false, uiAt: null });
    await endpoint();
    // 14 minutes old on the home's clock when sampled, received now: two minutes later it is 16 minutes old.
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiAt: LATER + 1_000, uiAgeMs: 14 * 60_000 } })).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000 + 2 * 60_000);
    await reconcile(probe(() => publicOk()).deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // A young render on a sample taken three minutes before we received it: transit too long.
    vi.mocked(Date.now).mockReturnValue(LATER + 4 * 60_000);
    expect((await heartbeat(c, { appResponding: true, clock: clockAt(LATER + 60_000), checks: { ...OK_CHECKS, uiAt: LATER + 60_000 } })).status).toBe(200);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    // The same render on a prompt report is evidence.
    vi.mocked(Date.now).mockReturnValue(LATER + 5 * 60_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("the public render's age is judged again at promotion: 14:59 old at the probe, 15:01 at the promotion, never promotes (Astra AUTOCANARY-6 P2)", async () => {
    await enrolled();
    await endpoint();
    let at = LATER;
    vi.mocked(Date.now).mockImplementation(() => at);
    // The shell and its script take two seconds after /api/health answered.
    const slowUi = (url: string) => { at += 1_000; return servedUi(url); };
    await reconcile(probe(() => publicOk({ uiAt: at - AUTO_CANARY_RENDER_MAX_AGE_MS + 1_000 }), slowUi).deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null });
    // The same timing with a public render three seconds younger still is evidence at the promotion's time.
    await reconcile(probe(() => publicOk({ uiAt: at - AUTO_CANARY_RENDER_MAX_AGE_MS + 3_000 }), slowUi).deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("the public body must carry an explicit fresh \"ui\":\"ok\" render from the instance the heartbeat names (Astra AUTOCANARY-5 P2)", async () => {
    const c = await enrolled();
    await endpoint();
    const now = LATER;
    const failing: [string, () => Response][] = [
      ["no ui (an older image)", () => Response.json({ app: "murage" })],
      ["no ui, with uiAt and instance", () => Response.json({ app: "murage", uiAt: now, instance: INSTANCE })],
      ["ui failed", () => publicOk({ ui: "failed" })],
      ["ui pending, uiAt null", () => publicOk({ ui: "pending", uiAt: null })],
      ["ui ok, uiAt null", () => publicOk({ uiAt: null })],
      ["stale uiAt", () => publicOk({ uiAt: now - AUTO_CANARY_RENDER_MAX_AGE_MS - 1 })],
      ["uiAt from the future", () => publicOk({ uiAt: now + 10 * 60_000 })],
      ["uiAt a string", () => publicOk({ uiAt: String(now) })],
      ["mismatched instance", () => publicOk({ instance: "ZyXwVuTsRqPoNmLkJiHg_-" })],
      ["no instance", () => Response.json({ app: "murage", ui: "ok", uiAt: now })],
      ["an extra key", () => publicOk({ pid: 1 })],
      ["a door that is neither v1 nor v2", () => publicOk({ door: "v3" })],
    ];
    for (const [name, answer] of failing) {
      const p = probe(answer);
      expect((await reconcile(p.deps)).status, name).toBe(200);
      expect(p.calls, name).toHaveLength(1);
      expect(await readyRow(), name).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    }
    await inStep(c); // every failed probe bumped the epoch
    // A second inside 15 min: still evidence. (Exactly 15 min old when probed is past it when the promotion batch executes: the guard
    // judges ages at execution on the database's clock, Astra AUTOCANARY-12 P2-2.)
    // A door-v2 home names its door in the same body ("door":"v2"); that is not an extra key.
    await reconcile(probe(() => publicOk({ door: "v2", uiAt: now - AUTO_CANARY_RENDER_MAX_AGE_MS + 1_000 })).deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("render missing for 10 minutes while everything else is green raises home.ui_render_missing once; ready resolves it (Astra AUTOCANARY-5 P2)", async () => {
    const c = await enrolled(true, { ...OK_CHECKS, uiRenders: false });
    await endpoint();
    const p = probe(() => publicOk({ ui: "failed" }));
    const alerts = async () => (await env.DB.prepare("SELECT raised_at,resolved_at FROM cloud_alerts WHERE home_id='home-1' AND kind=?")
      .bind(UI_RENDER_MISSING_ALERT).all<{ raised_at: number; resolved_at: number | null }>()).results;
    const since = () => env.DB.prepare("SELECT ui_missing_since AS s FROM provision_attempts WHERE home_id='home-1'").first<{ s: number | null }>();
    const passAt = async (t: number, checks: Record<string, unknown> = { ...OK_CHECKS, uiRenders: false }, probeWith = p) => {
      vi.mocked(Date.now).mockReturnValue(t);
      await resync(c); // minutes apart: the daemon is in step again after the last pass's failed probe
      expect((await heartbeat(c, { appResponding: true, checks })).status).toBe(200);
      await reconcile(probeWith.deps);
    };
    await passAt(LATER);
    expect(await since()).toEqual({ s: LATER });
    expect(await alerts()).toEqual([]);
    await passAt(LATER + UI_RENDER_MISSING_ALERT_MS - 1);
    expect(await alerts()).toEqual([]);
    await passAt(LATER + UI_RENDER_MISSING_ALERT_MS);
    expect(await alerts()).toEqual([{ raised_at: LATER + UI_RENDER_MISSING_ALERT_MS, resolved_at: null }]);
    await passAt(LATER + UI_RENDER_MISSING_ALERT_MS + 5 * 60_000);
    expect(await alerts()).toHaveLength(1); // deduplicated: one open alert per home
    expect((await readyRow())!.desired_state).toBe("checking");
    // The renderer recovers: the home is promoted and the alert resolved.
    const ready = LATER + UI_RENDER_MISSING_ALERT_MS + 6 * 60_000;
    await passAt(ready, OK_CHECKS, probe());
    expect((await readyRow())!.desired_state).toBe("ready");
    expect(await alerts()).toEqual([{ raised_at: LATER + UI_RENDER_MISSING_ALERT_MS, resolved_at: ready }]);
  });
  it("the render alert waits for every other piece of evidence, restarts its clock when one goes red, and give-up resolves it", async () => {
    const c = await enrolled(true, { ...OK_CHECKS, uiRenders: false });
    await endpoint();
    const alerts = async () => (await env.DB.prepare("SELECT raised_at,resolved_at FROM cloud_alerts WHERE home_id='home-1' AND kind=?")
      .bind(UI_RENDER_MISSING_ALERT).all<{ raised_at: number; resolved_at: number | null }>()).results;
    const since = () => env.DB.prepare("SELECT ui_missing_since AS s FROM provision_attempts WHERE home_id='home-1'").first<{ s: number | null }>();
    const failedRender = { ...OK_CHECKS, uiRenders: false };
    const at = async (t: number, health: Record<string, unknown>, answer: () => Response = () => publicOk({ ui: "failed" })) => {
      vi.mocked(Date.now).mockReturnValue(t);
      expect((await heartbeat(c, health)).status).toBe(200);
      await reconcile(probe(answer).deps);
    };
    // The public UI does not serve: not "everything else green", no clock.
    await at(LATER, { appResponding: true, checks: failedRender }, () => new Response("down", { status: 503 }));
    expect(await since()).toEqual({ s: null });
    await at(LATER + 60_000, { appResponding: true, checks: failedRender });
    expect(await since()).toEqual({ s: LATER + 60_000 });
    // The data volume goes red: no longer a candidate, the clock is dropped (it restarts when everything else is green again).
    await at(LATER + 5 * 60_000, { appResponding: true, checks: { ...failedRender, dataWritable: false } });
    expect(await since()).toEqual({ s: null });
    await at(LATER + 6 * 60_000, { appResponding: true, checks: failedRender });
    expect(await since()).toEqual({ s: LATER + 6 * 60_000 });
    await at(LATER + 15 * 60_000, { appResponding: true, checks: failedRender });
    expect(await alerts()).toEqual([]);
    await at(LATER + 16 * 60_000, { appResponding: true, checks: failedRender });
    expect(await alerts()).toEqual([{ raised_at: LATER + 16 * 60_000, resolved_at: null }]);
    // Past the provisioning budget the home is given up on: provision.failed takes over and the render alert is resolved.
    const end = NOW + PROVISION_MAX_MS;
    vi.mocked(Date.now).mockReturnValue(end);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("failed");
    expect(await alerts()).toEqual([{ raised_at: LATER + 16 * 60_000, resolved_at: end }]);
    expect((await env.DB.prepare("SELECT 1 AS x FROM cloud_alerts WHERE home_id='home-1' AND kind='provision.failed' AND resolved_at IS NULL").all()).results).toHaveLength(1);
  });
  it("a stale render alert never reopens after a concurrent canary made the home ready; terminal homes' alerts are resolved (Astra AUTOCANARY-6 P2)", async () => {
    const c = await enrolled(true, { ...OK_CHECKS, uiRenders: false });
    await endpoint();
    const alerts = async () => (await env.DB.prepare("SELECT raised_at,resolved_at,resolve_notice_due FROM cloud_alerts WHERE home_id='home-1' AND kind=? ORDER BY raised_at")
      .bind(UI_RENDER_MISSING_ALERT).all()).results;
    const failed = () => probe(() => publicOk({ ui: "failed" }));
    await reconcile(failed().deps);
    vi.mocked(Date.now).mockReturnValue(LATER + UI_RENDER_MISSING_ALERT_MS);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiRenders: false } })).status).toBe(200);
    await reconcile(failed().deps);
    expect(await alerts()).toEqual([{ raised_at: LATER + UI_RENDER_MISSING_ALERT_MS, resolved_at: null, resolve_notice_due: null }]);
    // The next pass reads the home as overdue; before its alert insert, the admin canary makes it ready (resolving the open alert).
    const t = LATER + UI_RENDER_MISSING_ALERT_MS + 60_000;
    vi.mocked(Date.now).mockReturnValue(t);
    expect((await heartbeat(c, { appResponding: true, checks: { ...OK_CHECKS, uiRenders: false } })).status).toBe(200);
    let raced = 0;
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("INSERT INTO cloud_alerts")) return statement;
        return new Proxy(statement, { get(s, k) {
          if (k === "bind") return (...args: unknown[]) => { const bound = s.bind(...args); return { run: async () => {
            raced++;
            expect((await call("/v1/fake-b3/homes/home-1/canary", { generation: c.generation, imageDigest: IMAGE, checks: CHECKS })).status).toBe(200);
            return bound.run();
          } }; };
          const value = Reflect.get(s, k, s);
          return typeof value === "function" ? value.bind(s) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await autoCanaryPass({ ...testEnv(), DB: db } as Env, failed().deps.probeFetch)).toBe(0);
    expect(raced).toBe(1);
    expect((await readyRow())!.desired_state).toBe("ready");
    expect(await alerts()).toEqual([{ raised_at: LATER + UI_RENDER_MISSING_ALERT_MS, resolved_at: t, resolve_notice_due: 1 }]);
    // An open render alert left on a home that is no longer checking (ready here; failed and deleted alike) is resolved by the pass.
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('stray','home-1',?,'high','x',?)`)
      .bind(UI_RENDER_MISSING_ALERT, t + 1).run();
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('gone','home-gone',?,'high','x',?)`)
      .bind(UI_RENDER_MISSING_ALERT, t + 1).run();
    vi.mocked(Date.now).mockReturnValue(t + 2);
    await reconcile(failed().deps);
    expect((await env.DB.prepare("SELECT id,resolved_at,resolve_notice_due FROM cloud_alerts WHERE id IN ('stray','gone') ORDER BY id").all()).results)
      .toEqual([{ id: "gone", resolved_at: t + 2, resolve_notice_due: 1 }, { id: "stray", resolved_at: t + 2, resolve_notice_due: 1 }]);
    // The monitoring sweep sends each resolution notice once.
    const sent: { kind: string; homeId: string }[] = [];
    const hook = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response("ok"); }) as unknown as typeof fetch;
    const withHook = { ...testEnv(), ALERT_WEBHOOK_URL: "https://hooks.example.test/x" } as Env;
    await sweepMonitoring(withHook, t + 3, hook);
    await sweepMonitoring(withHook, t + 4, hook);
    expect(sent.filter((m) => m.kind === `${UI_RENDER_MISSING_ALERT}.resolved`).map((m) => m.homeId).sort()).toEqual(["home-1", "home-1", "home-gone"]);
  });
  it("a held alert webhook never delays promotions: alerts are only recorded in the pass and sent by the monitoring sweep (Astra AUTOCANARY-6 P2)", async () => {
    await enrolled();
    await endpoint();
    await cloneHome("home-2");
    // home-2: everything green but its render, for over ten minutes: its alert is due in this pass.
    await env.DB.prepare("UPDATE cloud_home_health SET ui_renders_ok=0 WHERE home_id='home-2'").run();
    await env.DB.prepare("UPDATE provision_attempts SET ui_missing_since=? WHERE home_id='home-2'").bind(LATER - UI_RENDER_MISSING_ALERT_MS - 60_000).run();
    let held = 0;
    const hang = vi.fn(() => { held++; return new Promise<Response>(() => undefined); });
    vi.stubGlobal("fetch", hang);
    try {
      const withHook = { ...testEnv(), ALERT_WEBHOOK_URL: "https://hooks.example.test/x" } as Env;
      const pass = autoCanaryPass(withHook, probe((url) => publicOk(url.includes("home-2") ? { ui: "failed" } : {})).deps.probeFetch);
      const outcome = await Promise.race([pass, new Promise<string>((resolve) => setTimeout(() => resolve("held"), 5_000))]);
      expect(outcome).toBe(0);
      expect(held).toBe(0); // no network delivery inside the pass
      expect((await readyRow())!.desired_state).toBe("ready");
      expect((await readyRow("home-2"))!.desired_state).toBe("checking");
      expect(await env.DB.prepare("SELECT delivered_at,resolved_at FROM cloud_alerts WHERE home_id='home-2' AND kind=?").bind(UI_RENDER_MISSING_ALERT).first())
        .toEqual({ delivered_at: null, resolved_at: null });
    } finally { vi.unstubAllGlobals(); }
    // The sweep delivers it.
    const sent: { kind: string; homeId: string }[] = [];
    await sweepMonitoring({ ...testEnv(), ALERT_WEBHOOK_URL: "https://hooks.example.test/x" } as Env, LATER, (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string)); return new Response("ok"); }) as unknown as typeof fetch);
    expect(sent.filter((m) => m.kind === UI_RENDER_MISSING_ALERT).map((m) => m.homeId)).toEqual(["home-2"]);
  });
  it("mixed fleet through the complete cron with D1 latency and a stalled webhook: old-image, render-missing and green homes, 90 probed, the green promoted, no D1 call in the stage (Astra AUTOCANARY-6/7)", async () => {
    await enrolled();
    await endpoint();
    const ids = Array.from({ length: AUTO_CANARY_PROBE_BUDGET_PER_PASS - 1 }, (_, i) => `home-m${String(i + 1).padStart(3, "0")}`);
    for (const id of ids) await cloneHome(id);
    // A third each: home-1 and every third clone green; old images (no render field at all, and a public body without "ui");
    // render missing (the app reports a failed render) for over ten minutes, so its alert is due in this pass.
    const kind = (id: string) => { const i = id === "home-1" ? 0 : ids.indexOf(id) + 1; return (["green", "old", "missing"] as const)[i % 3]; };
    const all = ["home-1", ...ids];
    const of = (k: string) => all.filter((id) => kind(id) === k);
    await env.DB.prepare(`UPDATE cloud_home_health SET ui_renders_ok=NULL,ui_rendered_at=NULL,ui_instance=NULL,ui_boot_id=NULL
      WHERE home_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(of("old"))).run();
    await env.DB.prepare("UPDATE cloud_home_health SET ui_renders_ok=0 WHERE home_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(of("missing"))).run();
    await env.DB.prepare("UPDATE provision_attempts SET ui_missing_since=? WHERE home_id IN (SELECT value FROM json_each(?))")
      .bind(LATER - UI_RENDER_MISSING_ALERT_MS - 60_000, JSON.stringify(of("missing"))).run();
    let clock = LATER;
    vi.mocked(Date.now).mockImplementation(() => clock);
    const timers: { at: number; resolve: () => void }[] = [];
    let inflight = 0;
    const until = (at: number) => new Promise<void>((resolve) => { timers.push({ at, resolve }); });
    const DB_MS = 200, PROBE_TAKES = 4_990;
    let active = 0, most = 0, probes = 0, dbInStage = 0, firstProbe = Infinity, lastProbeEnd = 0;
    const slow = async <T,>(op: () => Promise<T>): Promise<T> => {
      const start = clock;
      if (active > 0) dbInStage++;
      inflight++;
      let result: T;
      try { result = await op(); } finally { inflight--; }
      await until(start + DB_MS);
      return result;
    };
    const REAL = Symbol("real");
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === REAL) return target;
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
      if (key === "run" || key === "all" || key === "first" || key === "raw") {
        return (...args: unknown[]) => slow(() => (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[key as string](...args));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch") return (statements: D1PreparedStatement[]) =>
        slow(() => target.batch(statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? s)));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const probeFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/health") return servedUi(String(input));
      probes++;
      firstProbe = Math.min(firstProbe, clock);
      most = Math.max(most, ++active);
      await until(clock + PROBE_TAKES);
      active--;
      lastProbeEnd = Math.max(lastProbeEnd, clock);
      const k = kind(url.hostname.split(".")[0]);
      return k === "old" ? Response.json({ app: "murage" }) : publicOk(k === "missing" ? { ui: "failed" } : {});
    }) as typeof fetch;
    // A stalled alert webhook (Astra AUTOCANARY-7): it never answers, so every send ends at its ALERT_POST_TIMEOUT_MS bound (modelled on
    // the virtual clock). The pass must never wait on it, and the sweep's delivery stage must stay bounded (no 40 serial 10 s sends).
    const HOOK = "https://hooks.example.test/x";
    const sends: { start: number; end: number; inStage: boolean }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) !== HOOK) throw new Error("unexpected network");
      const send = { start: clock, end: 0, inStage: active > 0 };
      sends.push(send);
      await until(clock + ALERT_POST_TIMEOUT_MS);
      send.end = clock;
      throw new Error("stalled");
    });
    // The complete cron, exactly as Cloudflare runs it (every sweep, each isolated).
    const t0 = clock;
    const ctx = createExecutionContext();
    createWorker(noNetwork, noNetwork, { probeFetch }).scheduled({ scheduledTime: clock, cron: "*/5 * * * *", noRetry() {} },
      { ...testEnv(), DB: db, ALERT_WEBHOOK_URL: HOOK } as Env, ctx);
    let finished = false;
    waitOnExecutionContext(ctx).then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      if (finished) break;
      if (inflight > 0 || timers.length === 0) { await new Promise((resolve) => setTimeout(resolve, 1)); continue; }
      timers.sort((a, b) => a.at - b.at);
      clock = Math.max(clock, timers[0].at);
      const due = timers.filter((t) => t.at <= clock);
      timers.splice(0, due.length);
      for (const t of due) t.resolve();
    }
    vi.unstubAllGlobals();
    const elapsed = clock - t0;
    console.log(JSON.stringify({ mixed: true, probes, most, stageMs: lastProbeEnd - firstProbe, cronMs: elapsed, dbInStage, webhookSends: sends.length }));
    // The render alerts were sent (and failed) by the sweep, never inside the canary pass, in a bounded stage; each stays owed (claimed,
    // retried by a later sweep).
    expect(sends.length).toBeGreaterThanOrEqual(of("missing").length);
    expect(sends.filter((x) => x.inStage)).toHaveLength(0);
    expect(Math.min(...sends.map((x) => x.start))).toBeGreaterThanOrEqual(lastProbeEnd);
    const hookSpan = Math.max(...sends.map((x) => x.end)) - Math.min(...sends.map((x) => x.start));
    expect(hookSpan).toBeLessThanOrEqual(ALERT_STAGE_MS + ALERT_POST_TIMEOUT_MS + 5_000);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND delivered_at IS NULL AND delivery_attempts=1")
      .bind(UI_RENDER_MISSING_ALERT).first<{ n: number }>())!.n).toBe(of("missing").length);
    expect(probes).toBe(AUTO_CANARY_PROBE_BUDGET_PER_PASS); // every candidate probed in one pass, whatever its kind
    expect(most).toBe(AUTO_CANARY_PROBE_CONCURRENCY);
    expect(dbInStage).toBe(0);
    expect(lastProbeEnd - firstProbe).toBeLessThanOrEqual(AUTO_CANARY_STAGE_MS);
    const states = (await env.DB.prepare("SELECT id,desired_state AS s FROM cloud_homes").all<{ id: string; s: string }>()).results;
    expect(states.filter((r) => r.s === "ready").map((r) => r.id).sort()).toEqual(of("green").sort());
    expect(states.filter((r) => r.s === "checking").map((r) => r.id).sort()).toEqual([...of("old"), ...of("missing")].sort());
    const open = (await env.DB.prepare("SELECT home_id FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL").bind(UI_RENDER_MISSING_ALERT)
      .all<{ home_id: string }>()).results.map((r) => r.home_id).sort();
    expect(open).toEqual(of("missing").sort()); // old images start their ten minutes now; green homes never alert
    expect(elapsed).toBeLessThan(5 * 60_000); // the whole cron, every sweep included, inside one 5-minute interval
  }, 180_000);
  it("throughput with D1 latency: 4.99 s probes and 200 ms for every D1 call still probe and promote 90 a pass; the stage makes no D1 call (Astra AUTOCANARY-5 P2)", async () => {
    await enrolled();
    await endpoint();
    for (let i = 1; i < AUTO_CANARY_PROBE_BUDGET_PER_PASS; i++) await cloneHome(`home-t${String(i).padStart(3, "0")}`);
    // A virtual clock: Date.now reads it, and it moves only when every pending piece of work is waiting on it.
    let clock = LATER;
    vi.mocked(Date.now).mockImplementation(() => clock);
    const timers: { at: number; resolve: () => void }[] = [];
    let inflight = 0;
    const until = (at: number) => new Promise<void>((resolve) => { timers.push({ at, resolve }); });
    const DB_MS = 200, PROBE_TAKES = 4_990;
    let active = 0, most = 0, probes = 0, dbInStage = 0, firstProbe = Infinity, lastProbeEnd = 0;
    const slow = async <T,>(op: () => Promise<T>): Promise<T> => {
      const start = clock;
      if (active > 0) dbInStage++;
      inflight++;
      let result: T;
      try { result = await op(); } finally { inflight--; }
      await until(start + DB_MS);
      return result;
    };
    const REAL = Symbol("real");
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === REAL) return target;
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
      if (key === "run" || key === "all" || key === "first" || key === "raw") {
        return (...args: unknown[]) => slow(() => (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[key as string](...args));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch") return (statements: D1PreparedStatement[]) =>
        slow(() => target.batch(statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? s)));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const probeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (new URL(url).pathname !== "/api/health") return servedUi(url);
      probes++;
      firstProbe = Math.min(firstProbe, clock);
      most = Math.max(most, ++active);
      await until(clock + PROBE_TAKES);
      active--;
      lastProbeEnd = Math.max(lastProbeEnd, clock);
      return publicOk();
    }) as typeof fetch;
    const t0 = clock;
    let finished = false, failures: number | undefined, thrown: unknown;
    autoCanaryPass({ ...testEnv(), DB: db } as Env, probeFetch).then((n) => { failures = n; finished = true; }, (e) => { thrown = e; finished = true; });
    while (!finished) {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      if (finished) break;
      if (inflight > 0 || timers.length === 0) { await new Promise((resolve) => setTimeout(resolve, 1)); continue; }
      timers.sort((a, b) => a.at - b.at);
      clock = Math.max(clock, timers[0].at);
      const due = timers.filter((t) => t.at <= clock);
      timers.splice(0, due.length);
      for (const t of due) t.resolve();
    }
    expect(thrown).toBeUndefined();
    expect(failures).toBe(0);
    const elapsed = clock - t0;
    console.log(JSON.stringify({ probes, most, stageMs: lastProbeEnd - firstProbe, passMs: elapsed, dbInStage }));
    expect(probes).toBe(AUTO_CANARY_PROBE_BUDGET_PER_PASS); // >= 90 per pass with 200 ms D1 calls
    expect(most).toBe(AUTO_CANARY_PROBE_CONCURRENCY);
    expect(dbInStage).toBe(0); // no D1 call while a probe is in flight
    expect(lastProbeEnd - firstProbe).toBeLessThanOrEqual(AUTO_CANARY_STAGE_MS);
    expect(elapsed).toBeLessThan(5 * 60_000); // the whole pass, promotions included, inside one 5-minute cron interval
    const ready = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE desired_state='ready'").first<{ n: number }>();
    expect(ready!.n).toBe(AUTO_CANARY_PROBE_BUDGET_PER_PASS);
  }, 120_000);
  it("a missing UI bundle or an unwritable data volume keeps the home checking; passing checks on a newer report promote it", async () => {
    const c = await enrolled(true, { uiBundle: false, dataWritable: true });
    await endpoint();
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    expect((await heartbeat(c, { appResponding: true, checks: { uiBundle: true, dataWritable: false } })).status).toBe(200);
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", ready_pending_at: null });
    expect(p.calls).toHaveLength(0);
    expect(await notices()).toBe(0);
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200);
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "ready", ready_pending_at: LATER + 2_000 });
    expect(p.calls).toHaveLength(1);
  });
  it("checks from another generation never count: G1's delayed passing checks after G2's report without checks keep it checking", async () => {
    const g1 = await enrolled();
    await endpoint();
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    const g2 = await enroll();
    expect((await heartbeat(g2, { appResponding: true })).status).toBe(200); // G2's app answers; it reports no checks
    await recordHealth(testEnv(), "home-1", { appResponding: true, checks: OK_CHECKS }, LATER + 2_000, undefined, g1.generation);
    expect(await env.DB.prepare("SELECT generation,app_ok,ui_bundle_ok,data_writable_ok FROM cloud_home_health WHERE home_id='home-1'").first())
      .toEqual({ generation: g2.generation, app_ok: 1, ui_bundle_ok: null, data_writable_ok: null }); // never written at G2: G2 reported none
    expect(await env.DB.prepare("SELECT drop_reason FROM cloud_home_health WHERE home_id='home-1'").first()).toEqual({ drop_reason: "generation_mismatch" });
    const p = probe();
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(p.calls).toHaveLength(0);
  });
  it("a full budget of homes whose probes always fail cannot starve one more: it is probed on the second pass, the failed ones wait their turn", async () => {
    await enrolled();
    await endpoint();
    const failing = Array.from({ length: AUTO_CANARY_PROBE_BUDGET_PER_PASS }, (_, i) => `home-0${String(i).padStart(3, "0")}`); // all sort before home-1
    for (const id of failing) await cloneHome(id);
    const url = (id: string) => `https://${id}.murage.test/api/health`;
    const p = probe((u) => u === url("home-1") ? publicOk() : new Response("down", { status: 503 }));
    const sorted = (urls: string[]) => [...urls].sort();
    await reconcile(p.deps);
    expect(sorted(p.calls.map((c) => c.url))).toEqual(failing.map(url));
    expect((await readyRow())!.desired_state).toBe("checking");
    vi.mocked(Date.now).mockReturnValue(LATER + 1_000);
    await reconcile(p.deps);
    const second = p.calls.slice(AUTO_CANARY_PROBE_BUDGET_PER_PASS).map((c) => c.url);
    expect(sorted(second)).toEqual(sorted([url("home-1"), ...failing.slice(0, -1).map(url)])); // never probed first, then the oldest probes
    expect((await readyRow())!.desired_state).toBe("ready");
    vi.mocked(Date.now).mockReturnValue(LATER + 2_000);
    await reconcile(p.deps);
    const third = p.calls.slice(2 * AUTO_CANARY_PROBE_BUDGET_PER_PASS).map((c) => c.url);
    expect(third).toContain(url(failing.at(-1)!)); // the one left out last pass is probed now
    expect(p.calls).toHaveLength(3 * AUTO_CANARY_PROBE_BUDGET_PER_PASS);
  }, 120_000);
  it("an endpoint replaced while the probe ran (tunnel, DNS record or a rewrite) aborts the promotion (Astra AUTOCANARY-2 P2)", async () => {
    await enrolled();
    await endpoint();
    const changes = [
      "UPDATE machine_endpoints SET tunnel_id='tunnel-2',updated_at=updated_at+1 WHERE machine_id='home-1'",
      "UPDATE machine_endpoints SET dns_record_id='dns-2' WHERE machine_id='home-1'",
      "UPDATE machine_endpoints SET updated_at=updated_at+1 WHERE machine_id='home-1'",
      "UPDATE machine_endpoints SET tunnel_id='tunnel-3' WHERE machine_id='home-1'",
    ];
    for (const sql of changes) {
      const p = probe(async () => { await env.DB.prepare(sql).run(); return publicOk(); });
      expect((await reconcile(p.deps)).status).toBe(200);
      expect(p.calls, sql).toHaveLength(1);
      expect(await readyRow(), sql).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    }
    expect(await notices()).toBe(0);
    await reconcile(probe().deps); // a probe of the endpoint as it now stands is evidence
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("report ordering: a same-millisecond success and failure (either order) and a delayed older success never promote (Astra AUTOCANARY-2 P2)", async () => {
    const c = await enrolled();
    await endpoint();
    const p = probe();
    const T = LATER + 1_000;
    vi.mocked(Date.now).mockReturnValue(T);
    // Each pair is composed at the same epoch (Astra AUTOCANARY-10): whichever arrives first, the failure bumps it.
    const report = async (ok: boolean, at: number, epoch?: number | null) => recordHealth(testEnv(), "home-1", { appResponding: ok, bootId: BOOT,
      clock: clockAt(at), checks: { ...OK_CHECKS, uiAt: at, uiAgeMs: 0 }, evidenceEpoch: epoch === undefined ? await epochNow() : epoch }, at,
      undefined, c.generation);
    const row = () => env.DB.prepare("SELECT app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id='home-1'").first();
    let e = await epochNow();
    await report(true, T, e); await report(false, T, e); // success, then failure in the same millisecond
    expect(await row()).toEqual({ app_reported_at: T, app_ok_at: T, app_ok: 0 });
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    e = await epochNow();
    await report(false, T + 1, e); await report(true, T + 1, e); // failure, then success in the same millisecond
    // app_ok_at is the latest success seen, in either order (Astra AUTOCANARY-4 P2); the outcome stays failed.
    expect(await row()).toEqual({ app_reported_at: T + 1, app_ok_at: T + 1, app_ok: 0 });
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("checking");
    e = await epochNow();
    await report(false, T + 3, e); await report(true, T + 2, e); // a success composed before a failure arrives after it
    // Dropped as evidence (its epoch is stale); for display it only moves the last success forward, the outcome stays failed.
    expect(await row()).toEqual({ app_reported_at: T + 3, app_ok_at: T + 2, app_ok: 0 });
    expect(await env.DB.prepare("SELECT drop_reason FROM cloud_home_health WHERE home_id='home-1'").first()).toEqual({ drop_reason: "stale_epoch" });
    await reconcile(p.deps);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", ready_pending_at: null });
    expect(p.calls).toHaveLength(0);
    // Self-service still reads app_ok_at as the last time the app answered.
    await report(true, T + 4);
    expect(await row()).toEqual({ app_reported_at: T + 4, app_ok_at: T + 4, app_ok: 1 });
    await reconcile(p.deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("an oversized probe body fails the probe without being buffered: a 2 MiB Content-Length unread, a chunked body cancelled past 1 KiB", async () => {
    const c = await enrolled();
    await endpoint();
    const MIB2 = 2 * 1024 * 1024;
    /** A body that is valid JSON if read whole ({"app":"murage"} then spaces), counting how much of it was ever pulled. */
    function counting() {
      const counter = { pulled: 0, cancelled: false };
      const head = new TextEncoder().encode('{"app":"murage"}');
      const pad = new Uint8Array(256).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (counter.pulled >= MIB2) { controller.close(); return; }
          const chunk = counter.pulled === 0 ? head : pad;
          counter.pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() { counter.cancelled = true; },
      }, { highWaterMark: 0 });
      return { counter, stream };
    }
    const declared = counting();
    let p = probe(() => new Response(declared.stream, { status: 200, headers: { "content-length": String(MIB2) } }));
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(1);
    expect(declared.counter.pulled).toBeLessThanOrEqual(2 * 1024);
    expect((await readyRow())!.desired_state).toBe("checking");
    const chunked = counting();
    p = probe(() => new Response(chunked.stream, { status: 200 }));
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(1);
    expect(chunked.counter.pulled).toBeLessThanOrEqual(2 * 1024);
    expect(chunked.counter.cancelled).toBe(true);
    expect((await readyRow())!.desired_state).toBe("checking");
    expect(await notices()).toBe(0);
    await inStep(c); // the failed probes bumped the epoch
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("ready");
  });
  it("evidence 299 s old when read and a 4 s probe: older than five minutes at promotion, so no promotion (Astra AUTOCANARY-2 P3)", async () => {
    await enrolled(); // app report and heartbeat at LATER
    await endpoint();
    const read = LATER + AUTO_CANARY_FRESH_MS - 1_000;
    vi.mocked(Date.now).mockReturnValue(read);
    const p = probe(() => { vi.mocked(Date.now).mockReturnValue(read + 4_000); return publicOk(); });
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(1);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    expect(await notices()).toBe(0);
  });
  it("the public UI must serve: GET / 200 text/html with both markers and one hashed entry script, which must be 200 JavaScript (Astra AUTOCANARY-3 P1)", async () => {
    const c = await enrolled();
    await endpoint();
    const entry = "/assets/index-B9x_Qe-2.js";
    const big = (bytes: number, type: string) => {
      const counter = { pulled: 0, cancelled: false };
      const chunk = new TextEncoder().encode(type.includes("html") ? SHELL.padEnd(256, " ") : "/* padding */".padEnd(256, " "));
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (counter.pulled >= bytes) { controller.close(); return; }
          counter.pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() { counter.cancelled = true; },
      }, { highWaterMark: 0 });
      return { counter, stream };
    };
    const ui = (root: () => Response, asset: () => Response = () => script()) => (url: string) => new URL(url).pathname === "/" ? root() : asset();
    const failing: [string, (url: string) => Response][] = [
      // Until the door lane sets MURAGE_STATIC_DIR the home answers / with a JSON 404: never promoted automatically.
      ["404 JSON", ui(() => Response.json({ error: "not_found" }, { status: 404 }))],
      ["200 not html", ui(() => Response.json({ app: "murage" }))],
      ["html without the title", ui(() => html(SHELL.replace("<title>Murage</title>", "<title>Welcome to nginx!</title>")))],
      ["html without the root element", ui(() => html(SHELL.replace('<div id="root"></div>', "<div></div>")))],
      ["html without a module script", ui(() => html(SHELL.replace(/<script type="module"[^>]*><\/script>/, "")))],
      ["two module scripts", ui(() => html(SHELL.replace("</head>", '<script type="module" src="/assets/index-Zz9.js"></script></head>')))],
      ["the dev shell (unbuilt /src entry)", ui(() => html(SHELL.replace(entry, "/src/main.tsx")))],
      ["redirect at /", ui(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }))],
      ["oversized index (Content-Length)", ui(() => html(big(70 * 1024, "text/html").stream, { "content-length": String(70 * 1024) }))],
      ["oversized index (chunked)", ui(() => html(big(2 * 1024 * 1024, "text/html").stream))],
      ["asset 404", ui(() => html(), () => Response.json({ error: "not_found" }, { status: 404 }))],
      ["asset served as html (SPA fallback)", ui(() => html(), () => html())],
      ["asset served as JSON", ui(() => html(), () => script("{}", { "content-type": "application/json" }))],
      ["asset redirect", ui(() => html(), () => new Response(null, { status: 301, headers: { location: `https://elsewhere.test${entry}` } }))],
      ["asset empty", ui(() => html(), () => script(""))],
      ["asset network error", ui(() => html(), () => { throw new TypeError("Network connection lost."); })],
    ];
    for (const [name, answer] of failing) {
      const p = probe(undefined, answer);
      expect((await reconcile(p.deps)).status, name).toBe(200);
      expect(p.calls, name).toHaveLength(1);
      expect(await readyRow(), name).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    }
    expect(await notices()).toBe(0);
    // A chunked index past AUTO_CANARY_UI_MAX_BYTES is cancelled, never buffered.
    const chunked = big(2 * 1024 * 1024, "text/html");
    await reconcile(probe(undefined, ui(() => html(chunked.stream))).deps);
    expect(chunked.counter.pulled).toBeLessThanOrEqual(64 * 1024 + 512);
    expect(chunked.counter.cancelled).toBe(true);
    expect((await readyRow())!.desired_state).toBe("checking");
    // An oversized entry script (a real bundle is megabytes) is read only to its first KiB, then cancelled; it passes.
    const bundle = big(8 * 1024 * 1024, "text/javascript");
    await inStep(c); // the failed probes bumped the epoch
    const p = probe(undefined, ui(() => html(), () => script(bundle.stream, { "content-type": "application/javascript; charset=utf-8" })));
    await reconcile(p.deps);
    expect(p.all.at(-1)!.url).toBe(`https://home-1.murage.test${entry}`);
    expect(bundle.counter.pulled).toBeLessThanOrEqual(2 * 1024);
    expect(bundle.counter.cancelled).toBe(true);
    expect((await readyRow())!.desired_state).toBe("ready");
  }, 120_000);
  it("a provisioning budget that runs out while the probe runs is not promoted; the next pass gives up (Astra AUTOCANARY-3 P3)", async () => {
    const c = await enrolled();
    await endpoint();
    const read = NOW + PROVISION_MAX_MS - 1_000; // still inside the budget (first_at = NOW) when the candidates are read
    vi.mocked(Date.now).mockReturnValue(read);
    expect((await heartbeat(c, { appResponding: true, checks: OK_CHECKS })).status).toBe(200); // fresh evidence at `read`
    const p = probe(() => { vi.mocked(Date.now).mockReturnValue(read + 4_000); return publicOk(); });
    await reconcile(p.deps);
    expect(p.calls).toHaveLength(1);
    expect(await readyRow()).toMatchObject({ desired_state: "checking", canary_json: null, ready_pending_at: null });
    expect(await notices()).toBe(0);
    await reconcile(probe().deps);
    expect((await readyRow())!.desired_state).toBe("failed");
    expect(await env.DB.prepare("SELECT give_up_code FROM provision_attempts WHERE home_id='home-1'").first()).toMatchObject({ give_up_code: "home_never_ready" });
  });
});

describe("pre-authentication answers do not reveal whether a home exists", () => {
  async function raw(method: "GET" | "POST", path: string, options: { body?: string; token?: string } = {}) {
    const ctx = createExecutionContext();
    const headers = new Headers({ "CF-Connecting-IP": "203.0.113.10", "content-type": "application/json" });
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    const response = await createWorker(noNetwork, noNetwork).fetch(new Request(`https://admin.murage.test${path}`, {
      method, headers, body: options.body,
    }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return { status: response.status, text: await response.text() };
  }
  const UNAUTHORIZED = { status: 401, text: JSON.stringify({ error: "unauthorized" }) };

  it("answers the same 401 for an unknown id, an existing id without a credential and a wrong credential", async () => {
    expect((await reserve()).status).toBe(201);
    for (const operation of ["desired", "heartbeat", "lease"]) {
      const method = operation === "desired" ? "GET" : "POST";
      const body = method === "POST" ? JSON.stringify({ generation: 1, holder: "home-1" }) : undefined;
      for (const options of [{ body }, { body, token: "wrong" }]) {
        const unknown = await raw(method, `/v1/machines/no-such-home/${operation}`, options);
        const existing = await raw(method, `/v1/machines/home-1/${operation}`, options);
        expect(unknown).toEqual(UNAUTHORIZED);
        expect(existing).toEqual(unknown);
      }
    }
  });

  it("answers an existing home's empty lease body with the same 401, and 400 only after authentication", async () => {
    const credential = await ready();
    const unknown = await raw("POST", "/v1/machines/no-such-home/lease", {});
    const existing = await raw("POST", "/v1/machines/home-1/lease", {});
    const wrong = await raw("POST", "/v1/machines/home-1/lease", { token: "wrong" });
    expect(unknown).toEqual(UNAUTHORIZED);
    expect(existing).toEqual(unknown);
    expect(wrong).toEqual(unknown);
    expect((await raw("POST", "/v1/machines/home-1/lease", { token: credential.machineCredential })).status).toBe(400);
  });

  it("tells only an authenticated admin that a home is absent", async () => {
    expect((await call("/v1/fake-b3/homes/no-such-home/notice", { noticeId: "notice-key-0001", generation: 1 })).status).toBe(404);
    expect(await raw("POST", "/v1/fake-b3/homes/no-such-home/notice", { body: "{}", token: "wrong" })).toEqual(UNAUTHORIZED);
  });
});
