// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { verifyHomeKey, type SignedEnvelope } from "../src/b3-signatures";
import shapes from "./fixtures/cp0-shapes.json";

const ADMIN = "test-only-cloud-admin-token-with-no-real-access";
const KEK = btoa("x".repeat(32));
const IP = "203.0.113.9";
const HOME = "home-test";
let signing: JsonWebKey; let publicJwk: JsonWebKey;
let staging = true;
const testEnv = () => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK, CLOUD_B3_SIGNING_JWK: JSON.stringify(signing),
  ...(staging ? { CLOUD_CP0_STAGING: "1" } : {}) }) as Env;
async function call(path: string, body?: unknown, token?: string, ip: string = IP) {
  const headers = new Headers({ "content-type": "application/json", "CF-Connecting-IP": ip });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://admin.murage.test${path}`, {
    method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function enrolled() {
  const created = await call("/v1/machines", { ...shapes.createRequest, serverId: "server-1", boundIps: [IP], homeId: HOME }, ADMIN);
  expect(created.status).toBe(201);
  const { enrollmentToken } = await created.json<typeof shapes.createResponse>();
  const enrol = await call(`/v1/machines/${HOME}/enroll`, { token: enrollmentToken });
  expect(enrol.status).toBe(200);
  return (await enrol.json<typeof shapes.enrollResponse>()).machineCredential;
}
const lease = (credential: string, ip?: string) => call(`/v1/machines/${HOME}/lease`, { generation: 1, holder: HOME }, credential, ip);
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signing = await crypto.subtle.exportKey("jwk", pair.privateKey);
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});
afterEach(() => { staging = true; });

describe("CP0 control link (wire 1) without a cloud_homes row or B3 mode", () => {
  it("an active staging machine gets a lease, a heartbeat and desired state run, signed, with no fake literal", async () => {
    const credential = await enrolled();
    const granted = await lease(credential);
    expect(granted.status).toBe(200);
    const leaseBody = await granted.json<Record<string, unknown>>();
    expect(leaseBody).toEqual({ wire: 1, installationId: HOME, holder: HOME, generation: 1,
      expiresAt: expect.any(Number), renewAfterMs: 60_000, ttlMs: 3_600_000, skewMs: 120_000 });
    expect(await (await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1 }, credential)).json()).toEqual({ wire: 1, accepted: true });
    const response = await call(`/v1/machines/${HOME}/desired`, undefined, credential);
    expect(response.status).toBe(200);
    const desired = await response.json<Record<string, unknown> & { homeKey: SignedEnvelope }>();
    expect(Object.keys(desired).sort()).toEqual(["engineSubscriptionGates", "executionAllowed", "generation", "heartbeatEveryMs",
      "heartbeatFresh", "homeId", "homeKey", "desiredState", "lease", "wire"].sort());
    expect(desired).toMatchObject({ wire: 1, homeId: HOME, generation: 1, desiredState: "ready", executionAllowed: true,
      heartbeatFresh: true, heartbeatEveryMs: 60_000, lease: { holder: HOME, generation: 1, expiresAt: leaseBody.expiresAt } });
    expect(JSON.stringify(desired)).not.toContain("fakeOnly");
    const identity = await verifyHomeKey(desired.homeKey, publicJwk, HOME, 1, "https://home.murage.test", Date.now());
    expect(identity.homeId).toBe(HOME);
  });

  it("desired without a lease never allows execution", async () => {
    const credential = await enrolled();
    const desired = await (await call(`/v1/machines/${HOME}/desired`, undefined, credential)).json<Record<string, unknown>>();
    expect(desired).toMatchObject({ desiredState: "ready", lease: null, executionAllowed: false, heartbeatFresh: false });
    expect((await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1 }, credential)).status).toBe(409);
  });

  it("a non-active machine is stopped: no lease, no heartbeat, desired never allows execution", async () => {
    const credential = await enrolled();
    expect((await lease(credential)).status).toBe(200);
    await env.DB.prepare("UPDATE cloud_machines SET state='suspended' WHERE id=?").bind(HOME).run();
    expect((await lease(credential)).status).toBe(409);
    expect((await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1 }, credential)).status).toBe(409);
    const desired = await (await call(`/v1/machines/${HOME}/desired`, undefined, credential)).json<Record<string, unknown>>();
    expect(desired).toMatchObject({ wire: 1, desiredState: "stopped", executionAllowed: false });
  });

  it("an expired lease and a rotated generation stop execution", async () => {
    const credential = await enrolled();
    await lease(credential);
    await env.DB.prepare("UPDATE cloud_cp0_control SET expires_at=? WHERE machine_id=?").bind(Date.now() - 1, HOME).run();
    expect(await (await call(`/v1/machines/${HOME}/desired`, undefined, credential)).json()).toMatchObject({ executionAllowed: false });
    await env.DB.prepare("UPDATE cloud_machines SET generation=2,credential_hash=NULL WHERE id=?").bind(HOME).run();
    expect((await call(`/v1/machines/${HOME}/desired`, undefined, credential)).status).toBe(401);
  });

  it("rejects a wrong credential, an unbound IP, a foreign holder, a stale generation and a wrong method", async () => {
    const credential = await enrolled();
    expect((await lease("wrong")).status).toBe(401);
    expect((await lease(credential, "198.51.100.1")).status).toBe(403);
    expect((await call(`/v1/machines/${HOME}/lease`, { generation: 1, holder: "other" }, credential)).status).toBe(403);
    expect((await call(`/v1/machines/${HOME}/lease`, { generation: 2, holder: HOME }, credential)).status).toBe(409);
    expect((await call(`/v1/machines/${HOME}/desired`, {}, credential)).status).toBe(405);
    expect((await call("/v1/machines/missing/desired", undefined, credential)).status).toBe(401);
  });

  it("routes are absent without CLOUD_CP0_STAGING=1", async () => {
    const credential = await enrolled();
    staging = false;
    expect((await lease(credential)).status).toBe(404);
    expect((await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1 }, credential)).status).toBe(404);
    expect((await call(`/v1/machines/${HOME}/desired`, undefined, credential)).status).toBe(404);
    expect(await env.DB.prepare("SELECT 1 FROM cloud_cp0_control").first()).toBeNull();
  });
});

describe("heartbeat health block (B5 monitoring)", () => {
  it("accepts disk, backup and the mining event on the existing heartbeat and stores them", async () => {
    const credential = await enrolled();
    await lease(credential);
    const now = Date.now();
    const response = await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1,
      health: { diskUsedPercent: 91, lastBackupAt: now, events: [{ type: "abuse.mining_suspected", at: now }] } }, credential);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT disk_used_percent AS d FROM cloud_home_health WHERE home_id=?").bind(HOME).first()).toEqual({ d: 91 });
    expect((await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=?").bind(HOME).all()).results).toEqual([{ kind: "abuse.mining_suspected" }]);
  });
  it("rejects an unknown event type or an out-of-range disk value", async () => {
    const credential = await enrolled();
    await lease(credential);
    expect((await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1, health: { diskUsedPercent: 101 } }, credential)).status).toBe(400);
    expect((await call(`/v1/machines/${HOME}/heartbeat`, { generation: 1, health: { events: [{ type: "x", at: 1 }] } }, credential)).status).toBe(400);
  });
});
