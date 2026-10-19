// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepCloudRetention } from "../src/cloud-machines";
import worker from "../src/index";
import { sha256 } from "../src/installations";
import { stagingKeyWrapper } from "../src/key-wrapper";
import shapes from "./fixtures/cp0-shapes.json";

const ADMIN = "test-only-cloud-admin-token-with-no-real-access";
const KEK = btoa("x".repeat(32));
const IP = "203.0.113.9";
const BINDING = { serverId: "server-1", boundIps: [IP] };
let staging = true;
let siteOrigin: string | undefined;
const testEnv = () => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK,
  ...(staging ? { CLOUD_CP0_STAGING: "1" } : {}), ...(siteOrigin === undefined ? {} : { SITE_ORIGIN: siteOrigin }) }) as Env;
async function call(path: string, body: unknown, token?: string, ip?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (ip) headers.set("CF-Connecting-IP", ip);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function create(homeId = "home-test") {
  const response = await call("/v1/machines", { ...shapes.createRequest, ...BINDING, homeId }, ADMIN);
  expect(response.status).toBe(201);
  return response.json<typeof shapes.createResponse>();
}
async function enroll(homeId: string, token: string, ip?: string) {
  return call(`/v1/machines/${homeId}/enroll`, { token }, undefined, ip ?? IP);
}
async function enrolled(homeId = "home-test") {
  const machine = await create(homeId);
  const response = await enroll(homeId, machine.enrollmentToken);
  expect(response.status).toBe(200);
  return response.json<typeof shapes.enrollResponse>();
}
const unwrap = (id: string, credential: string, generation = 1, ip: string = IP) =>
  call(`/v1/machines/${id}/unwrap`, { generation }, credential, ip);
afterEach(() => { vi.restoreAllMocks(); staging = true; siteOrigin = undefined; });

describe("CP0 machine enrollment and key custody", () => {
  it("a token redeems once; a reused token and an expired token get 401", async () => {
    const machine = await create();
    const tokenRow = await env.DB.prepare("SELECT * FROM cloud_enrollment_tokens WHERE machine_id=?").bind(machine.homeId).first();
    expect(tokenRow?.hash).toBe(await sha256(machine.enrollmentToken));
    expect(Number(tokenRow?.expires_at) - Date.now()).toBeGreaterThan(29 * 60 * 1000);
    expect((await enroll(machine.homeId, machine.enrollmentToken)).status).toBe(200);
    expect((await enroll(machine.homeId, machine.enrollmentToken)).status).toBe(401);
    const expired = await create("expired");
    await env.DB.prepare("UPDATE cloud_enrollment_tokens SET expires_at=? WHERE machine_id=?").bind(Date.now() - 1, "expired").run();
    expect((await enroll("expired", expired.enrollmentToken)).status).toBe(401);
  });

  it("concurrent redemption issues exactly one credential", async () => {
    const machine = await create();
    const responses = await Promise.all(Array.from({ length: 8 }, () => enroll(machine.homeId, machine.enrollmentToken)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401, 401, 401, 401, 401, 401, 401]);
    const successful = await responses.find((response) => response.status === 200)!.json<typeof shapes.enrollResponse>();
    expect((await unwrap(machine.homeId, successful.machineCredential)).status).toBe(200);
  });

  it("unwrap with generation N-1 gets 409", async () => {
    const first = await enrolled();
    expect((await unwrap("home-test", first.machineCredential, 0)).status).toBe(409);
    const rotated = await (await call("/v1/machines/home-test/rotate", {}, ADMIN)).json<typeof shapes.createResponse>();
    const current = await (await enroll("home-test", rotated.enrollmentToken)).json<typeof shapes.enrollResponse>();
    const response = await unwrap("home-test", current.machineCredential, current.generation - 1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(shapes.staleResponse);
  });

  it("no unwrap or enroll response contains kek or keyEncryptionKey, and no log line contains the KEK", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const enrolledMachine = await enrolled();
    const response = await unwrap("home-test", enrolledMachine.machineCredential);
    expect(response.status).toBe(200);
    const keys = await response.json<typeof shapes.unwrapResponse>();
    for (const payload of [enrolledMachine, keys]) {
      expect(JSON.stringify(payload)).not.toMatch(/"(?:kek|keyEncryptionKey)"/);
      expect(JSON.stringify(payload)).not.toContain(KEK);
    }
    for (const key of [keys.dataKey, keys.bootstrapSecret, keys.volumeKey]) expect(atob(key)).toHaveLength(32);
    expect(new Set([keys.dataKey, keys.bootstrapSecret, keys.volumeKey]).size).toBe(3);
    const stored = await env.DB.prepare("SELECT * FROM cloud_home_keys").first();
    expect(JSON.stringify(stored)).not.toContain(keys.dataKey);
    const logs = await env.DB.prepare("SELECT * FROM cloud_unwrap_log").all();
    expect(logs.results).toHaveLength(1);
    expect(logs.results[0].outcome).toBe("ok");
    expect(JSON.stringify(logs)).not.toContain(KEK);
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls, ...warn.mock.calls])).not.toContain(KEK);
  });

  it("one home's credential can't unwrap another home's keys (401)", async () => {
    const first = await enrolled("first");
    await enrolled("second");
    expect((await unwrap("second", first.machineCredential)).status).toBe(401);
    expect((await unwrap("missing", first.machineCredential)).status).toBe(401);
    const logs = await env.DB.prepare("SELECT outcome FROM cloud_unwrap_log").all();
    // Unknown machine ids are not audited (unbounded unauthenticated growth).
    expect(logs.results.map((row) => row.outcome)).toEqual(["unauthorized"]);
  });

  it("throttles unwrap per source IP before any DB lookup and never logs unknown ids", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await unwrap(`ghost-${i}`, "x", 1, "198.51.100.77")).status);
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_unwrap_log").first<{ n: number }>())?.n).toBe(0);
    // A different source is unaffected.
    expect((await unwrap("ghost", "x", 1, "198.51.100.78")).status).toBe(401);
  });

  it("retention sweep deletes unwrap log rows older than 30 days only", async () => {
    const old = Date.now() - 31 * 86_400_000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_unwrap_log VALUES ('h',1,?,NULL,'ok')").bind(old),
      env.DB.prepare("INSERT INTO cloud_unwrap_log VALUES ('h',1,?,NULL,'ok')").bind(Date.now()),
    ]);
    await sweepCloudRetention(env);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_unwrap_log").first<{ n: number }>())?.n).toBe(1);
  });

  it("with bound_ips set, unwrap from another CF-Connecting-IP gets 403", async () => {
    const machine = await enrolled();
    expect((await unwrap("home-test", machine.machineCredential, 1, "203.0.113.8")).status).toBe(403);
    expect((await call("/v1/machines/home-test/unwrap", { generation: 1 }, machine.machineCredential)).status).toBe(403);
    expect((await unwrap("home-test", machine.machineCredential, 1, "203.0.113.9")).status).toBe(200);
    const logs = await env.DB.prepare("SELECT outcome FROM cloud_unwrap_log ORDER BY rowid").all();
    expect(logs.results.map((row) => row.outcome)).toEqual(["forbidden", "forbidden", "ok"]);
  });

  it("after rotate, the old credential gets 401 and the new token enrolls", async () => {
    const old = await enrolled();
    const originalKeys = await (await unwrap("home-test", old.machineCredential)).json<typeof shapes.unwrapResponse>();
    const rotation = await call("/v1/machines/home-test/rotate", {}, ADMIN);
    expect(rotation.status).toBe(200);
    const rotated = await rotation.json<typeof shapes.createResponse>();
    expect(rotated.generation).toBe(2);
    expect((await unwrap("home-test", old.machineCredential)).status).toBe(401);
    const response = await enroll("home-test", rotated.enrollmentToken);
    expect(response.status).toBe(200);
    const current = await response.json<typeof shapes.enrollResponse>();
    const keys = await (await unwrap("home-test", current.machineCredential, 2)).json<typeof shapes.unwrapResponse>();
    expect(keys).toEqual({ ...originalKeys, generation: 2 });
  });

  it("rotation invalidates an outstanding enrollment token", async () => {
    const original = await create();
    const rotated = await (await call("/v1/machines/home-test/rotate", {}, ADMIN)).json<typeof shapes.createResponse>();
    expect((await enroll("home-test", original.enrollmentToken)).status).toBe(401);
    expect((await enroll("home-test", rotated.enrollmentToken)).status).toBe(200);
  });

  it("admin routes without the bearer get 401", async () => {
    expect((await call("/v1/machines", shapes.createRequest)).status).toBe(401);
    expect((await call("/v1/machines", shapes.createRequest, "wrong")).status).toBe(401);
    expect((await call("/v1/machines/home-test/rotate", {})).status).toBe(401);
  });

  it("the step-D murage-enroll fake speaks the shared JSON shapes", async () => {
    const created = await create();
    expect(Object.keys(created).sort()).toEqual(Object.keys(shapes.createResponse).sort());
    expect(created.machineId).toBe(created.homeId);
    const response = await call(`/v1/machines/${created.homeId}/enroll`, { ...shapes.enrollRequest, token: created.enrollmentToken }, undefined, IP);
    const machine = await response.json<typeof shapes.enrollResponse>();
    expect(Object.keys(machine).sort()).toEqual(Object.keys(shapes.enrollResponse).sort());
    expect(machine).toEqual({ ...shapes.enrollResponse, machineCredential: expect.any(String) });
    const keys = await (await call(`/v1/machines/${created.homeId}/unwrap`, shapes.unwrapRequest, machine.machineCredential, IP)).json();
    expect(Object.keys(keys as object).sort()).toEqual(Object.keys(shapes.unwrapResponse).sort());
  });

  it("enforces token server and IP bindings before consuming the token", async () => {
    const created = await create();
    await env.DB.prepare("UPDATE cloud_machines SET server_id=? WHERE id=?").bind("server-other", created.machineId).run();
    expect((await enroll(created.machineId, created.enrollmentToken, "203.0.113.9")).status).toBe(401);
    await env.DB.prepare("UPDATE cloud_machines SET server_id=? WHERE id=?").bind("server-1", created.machineId).run();
    expect((await enroll(created.machineId, created.enrollmentToken, "203.0.113.8")).status).toBe(401);
    expect((await enroll(created.machineId, created.enrollmentToken, "203.0.113.9")).status).toBe(200);
  });

  it("enrols from ANY bound IP (second, IPv6) and still refuses an unlisted or loosened address", async () => {
    const V6 = "2001:db8::1234";
    const made = await call("/v1/machines", { ...shapes.createRequest, serverId: "server-1", boundIps: [IP, V6], homeId: "home-dual" }, ADMIN);
    expect(made.status).toBe(201);
    const created = await made.json<typeof shapes.createResponse>();
    expect((await enroll(created.machineId, created.enrollmentToken, "2001:db8::1235")).status).toBe(401);
    expect((await enroll(created.machineId, created.enrollmentToken, "2001:db8::1234/128")).status).toBe(401);
    expect((await enroll(created.machineId, created.enrollmentToken, "203.0.113.10")).status).toBe(401);
    expect((await enroll(created.machineId, created.enrollmentToken, V6)).status).toBe(200);
  });

  it("AES256GCM authenticates homeId and rejects tampered ciphertext", async () => {
    const wrapper = stagingKeyWrapper(KEK);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapper.wrap("home-1", bytes);
    expect(await wrapper.unwrap("home-1", wrapped)).toEqual(bytes);
    await expect(wrapper.unwrap("home-2", wrapped)).rejects.toThrow();
    const parts = wrapped.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    await expect(wrapper.unwrap("home-1", parts.join("."))).rejects.toThrow();
    expect(() => stagingKeyWrapper(btoa("short"))).toThrow("cloud_key_unavailable");
  });

  it("rejects duplicate identities and invalid origin input without changing existing keys", async () => {
    const first = await enrolled();
    expect((await call("/v1/machines", { ...shapes.createRequest, ...BINDING }, ADMIN)).status).toBe(409);
    expect((await call("/v1/machines", { ...shapes.createRequest, ...BINDING, homeId: "bad", publicOrigin: "https://x.test/\nINJECT" }, ADMIN)).status).toBe(400);
    expect((await unwrap("home-test", first.machineCredential)).status).toBe(200);
  });

  it("create requires serverId and boundIps", async () => {
    expect((await call("/v1/machines", shapes.createRequest, ADMIN)).status).toBe(400);
    expect((await call("/v1/machines", { ...shapes.createRequest, serverId: "s" }, ADMIN)).status).toBe(400);
    expect((await call("/v1/machines", { ...shapes.createRequest, ...BINDING, boundIps: [] }, ADMIN)).status).toBe(400);
    expect((await call("/v1/machines", { ...shapes.createRequest, ...BINDING, boundIps: ["not-an-ip"] }, ADMIN)).status).toBe(400);
    const row = await env.DB.prepare("SELECT 1 AS n FROM cloud_machines").first();
    expect(row).toBeNull();
  });

  it("unwrap fails closed with 403 when bound_ips is NULL, even from any IP", async () => {
    const machine = await enrolled();
    await env.DB.prepare("UPDATE cloud_machines SET bound_ips=NULL WHERE id=?").bind("home-test").run();
    expect((await unwrap("home-test", machine.machineCredential)).status).toBe(403);
    await env.DB.prepare("UPDATE cloud_machines SET bound_ips=? WHERE id=?").bind("not json", "home-test").run();
    expect((await unwrap("home-test", machine.machineCredential)).status).toBe(403);
    const logs = await env.DB.prepare("SELECT outcome FROM cloud_unwrap_log ORDER BY rowid").all();
    expect(logs.results.map((row) => row.outcome)).toEqual(["forbidden", "forbidden"]);
  });

  it("rotate refuses an unbound machine and keeps the binding on the new token", async () => {
    await enrolled();
    const rotated = await call("/v1/machines/home-test/rotate", {}, ADMIN);
    expect(rotated.status).toBe(200);
    const token = await env.DB.prepare("SELECT bound_server_id,bound_ip FROM cloud_enrollment_tokens WHERE used_at IS NULL").first();
    expect(token).toEqual({ bound_server_id: "server-1", bound_ip: IP });
    await env.DB.prepare("UPDATE cloud_machines SET bound_ips=NULL WHERE id=?").bind("home-test").run();
    expect((await call("/v1/machines/home-test/rotate", {}, ADMIN)).status).toBe(409);
    expect((await call("/v1/machines/missing/rotate", {}, ADMIN)).status).toBe(404);
  });

  it("owner assignment: admin-only, 404s, idempotent, never returns the user id, absent without staging", async () => {
    await enrolled();
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)')
      .bind("user-own", "t", "own@example.test", Date.now(), Date.now()).run();
    const email = "own@example.test";
    expect((await call("/v1/machines/home-test/owner", { email })).status).toBe(401);
    expect((await call("/v1/machines/missing/owner", { email }, ADMIN)).status).toBe(404);
    expect((await call("/v1/machines/home-test/owner", { email: "nobody@example.test" }, ADMIN)).status).toBe(404);
    const first = await call("/v1/machines/home-test/owner", { email }, ADMIN);
    expect(first.status).toBe(200);
    const text = await first.text();
    expect(JSON.parse(text)).toEqual({ machineId: "home-test", assigned: true });
    const row = await env.DB.prepare("SELECT owner_user_id FROM machine_owners WHERE machine_id=?").bind("home-test").first<{ owner_user_id: string }>();
    expect(text).not.toContain(row!.owner_user_id);
    expect((await call("/v1/machines/home-test/owner", { email }, ADMIN)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM machine_owners").first<{ n: number }>())!.n).toBe(1);
    staging = false;
    expect((await call("/v1/machines/home-test/owner", { email }, ADMIN)).status).toBe(404);
  });

  it("create and rotate are not mounted without CLOUD_CP0_STAGING=1", async () => {
    await enrolled();
    staging = false;
    expect((await call("/v1/machines", { ...shapes.createRequest, ...BINDING, homeId: "prod-home" }, ADMIN)).status).toBe(404);
    expect((await call("/v1/machines/home-test/rotate", {}, ADMIN)).status).toBe(404);
    expect((await call("/v1/machines/home-test/retire", {}, ADMIN)).status).toBe(404);
    expect(await env.DB.prepare("SELECT state FROM cloud_machines WHERE id=?").bind("home-test").first()).toEqual({ state: "active" });
    expect(await env.DB.prepare("SELECT 1 FROM cloud_machines WHERE id=?").bind("prod-home").first()).toBeNull();
  });
});

describe("enroll response siteOrigin", () => {
  const rest = { ...shapes.enrollResponse, machineCredential: expect.any(String) };
  const enrollWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((args) => String(args[0]).includes("SITE_ORIGIN"));
  // A fresh source IP per test keeps this block clear of the per-IP enroll limiter (30/min) the file above already spends.
  let ipSuffix = 10;
  async function enrolledFresh() {
    const ip = `198.51.100.${ipSuffix++}`;
    const created = await call("/v1/machines", { ...shapes.createRequest, serverId: "server-1", boundIps: [ip], homeId: "home-test" }, ADMIN);
    expect(created.status).toBe(201);
    const response = await enroll("home-test", (await created.json<typeof shapes.createResponse>()).enrollmentToken, ip);
    expect(response.status).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  it("passes a valid https SITE_ORIGIN through exactly as configured", async () => {
    siteOrigin = "https://murage-site-preview.vercel.app";
    const warn = vi.spyOn(console, "warn");
    const machine = await enrolledFresh();
    expect(machine.siteOrigin).toBe("https://murage-site-preview.vercel.app");
    const others = { ...machine };
    delete others.siteOrigin;
    expect(others).toEqual(rest);
    expect(enrollWarnings(warn)).toHaveLength(0);
  });

  it("omits siteOrigin and warns once when SITE_ORIGIN is missing", async () => {
    const warn = vi.spyOn(console, "warn");
    const machine = await enrolledFresh();
    expect("siteOrigin" in machine).toBe(false);
    expect(machine).toEqual(rest);
    expect(enrollWarnings(warn)).toHaveLength(1);
    expect(String(enrollWarnings(warn)[0][0])).toMatch(/not set/);
  });

  for (const bad of ["http://murage.ai", "https://murage.ai/home", "https://murage.ai/?x=1", "not a url"]) {
    it(`omits siteOrigin and warns once for ${bad}`, async () => {
      siteOrigin = bad;
      const warn = vi.spyOn(console, "warn");
      const machine = await enrolledFresh();
      expect("siteOrigin" in machine).toBe(false);
      expect(machine).toEqual(rest);
      expect(enrollWarnings(warn)).toHaveLength(1);
      expect(String(enrollWarnings(warn)[0][0])).toMatch(/not a bare https origin/);
      expect(String(enrollWarnings(warn)[0][0])).not.toContain(bad);
    });
  }
});
