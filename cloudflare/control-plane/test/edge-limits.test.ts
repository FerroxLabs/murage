// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { classifyEdge, edgeGate } from "../src/edge-limits";
import worker from "../src/index";

const IP = "203.0.113.77";
type Fake = { limit: ReturnType<typeof vi.fn> };
const fake = (success: boolean): Fake => ({ limit: vi.fn(async () => ({ success })) });

function spyDb() {
  const prepare = vi.fn((sql: string) => env.DB.prepare(sql));
  const batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
  return { db: { prepare, batch } as unknown as D1Database, prepare, batch };
}

async function call(path: string, opts: { bearer?: boolean; open?: Fake; bearerLimit?: Fake; db?: D1Database; vars?: Record<string, string> } = {}) {
  const headers = new Headers({ "content-type": "application/json", "CF-Connecting-IP": IP });
  if (opts.bearer) headers.set("authorization", "Bearer not-a-real-credential");
  const testEnv = { ...env, ...opts.vars, ...(opts.db ? { DB: opts.db } : {}),
    ...(opts.open ? { MACHINE_OPEN_LIMIT: opts.open } : {}),
    ...(opts.bearerLimit ? { MACHINE_BEARER_LIMIT: opts.bearerLimit } : {}) } as unknown as Env;
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", headers, body: JSON.stringify({ generation: 1, token: "x" }),
  }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const get = (path: string, bearer: boolean, method = "POST") => classifyEdge(new Request(`https://x.test${path}`, {
  method, headers: { "CF-Connecting-IP": IP, ...(bearer ? { authorization: "Bearer abc" } : {}) },
}));

describe("edge limiter selection", () => {
  it("keys bearer machine routes by machine id plus IP and everything else open by IP", () => {
    for (const op of ["unwrap", "lease", "heartbeat", "desired", "endpoint"]) {
      expect(get(`/v1/machines/m-1/${op}`, true)).toEqual({ limiter: "MACHINE_BEARER_LIMIT", key: IP });
      expect(get(`/v1/machines/m-1/${op}`, false)).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: IP });
    }
    // enroll authenticates with a body token, so a bearer header never moves it to the roomier limiter.
    expect(get("/v1/machines/m-1/enroll", true)).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: IP });
    expect(get("/v1/homes/h-1/pairing/start", false)).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: IP });
    expect(get("/v1/announcements/subscribe", false)).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: IP });
    expect(get("/v1/announcements/subscribe", false, "GET")).toBeNull();
    expect(get("/v1/me", true, "GET")).toBeNull();
    expect(get("/v1/installations", true)).toBeNull();
  });
});

describe("edge gate", () => {
  it("allows when the binding is absent (fail open)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("/v1/machines/m-1/unwrap", { bearer: true });
    expect(response.status).toBe(401);
    error.mockRestore();
  });

  it("allows when the binding throws", async () => {
    const open = { limit: vi.fn(async () => { throw new Error("down"); }) };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("/v1/machines/m-1/unwrap", { open: open as unknown as Fake })).status).toBe(401);
    error.mockRestore();
  });

  it("answers 429 with retry-after and touches no D1 when the open limiter says no", async () => {
    const { db, prepare, batch } = spyDb();
    const open = fake(false);
    for (const path of ["/v1/machines/m-1/enroll", "/v1/machines/m-1/unwrap", "/v1/machines/m-1/lease",
      "/v1/announcements/subscribe"]) {
      const response = await call(path, { open, db });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toEqual({ error: "rate_limited" });
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(open.limit).toHaveBeenCalledWith({ key: IP });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM announcement_rate_limits").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_unwrap_log").first<{ n: number }>())?.n).toBe(0);
  });

  it("a Cloud pairing route authenticates first: an anonymous caller is 401, not 429, touching no D1 and no limiter (Astra MAKERKIT8 P3)", async () => {
    const { db, prepare, batch } = spyDb();
    const open = fake(false);
    const response = await call("/v1/homes/h-1/pairing/start", { open, db });
    expect([response.status, await response.json()]).toEqual([401, { error: "unauthorized" }]);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(open.limit).not.toHaveBeenCalled();
  });

  it("STEPUP-EMAIL-6 #4 / -10 #2: the step-up email endpoints' 429 carries retryAfter and retry_after_seconds, matching Retry-After, with no D1", async () => {
    for (const p of ["send", "verify"]) {
      // The gate itself (the worker authenticates these routes first; the gate is what answers once a caller is over the budget).
      const { db, prepare, batch } = spyDb();
      const open = fake(false);
      const response = (await edgeGate(new Request(`https://auth.murage.test/v1/account/step-up/email/${p}`, { method: "POST",
        headers: { "CF-Connecting-IP": IP, authorization: "Bearer not-a-real-credential" } }), { ...env, DB: db, MACHINE_OPEN_LIMIT: open } as unknown as Env))!;
      expect([response.status, await response.json()]).toEqual([429, { error: "rate_limited", retryAfter: 60, retry_after_seconds: 60 }]);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(open.limit).toHaveBeenCalledWith({ key: `stepup:${IP}` });
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    }
  });

  it("uses the bearer limiter, keyed by machine id and IP, for bearer requests", async () => {
    const { db, prepare } = spyDb();
    const open = fake(true);
    const bearerLimit = fake(false);
    const response = await call("/v1/machines/m-9/unwrap", { bearer: true, open, bearerLimit, db });
    expect(response.status).toBe(429);
    expect(bearerLimit.limit).toHaveBeenCalledWith({ key: IP });
    expect(open.limit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("lets a request through when the limiter allows it", async () => {
    const response = await call("/v1/machines/m-9/unwrap", { bearer: true, bearerLimit: fake(true) });
    expect(response.status).toBe(401);
  });
});

describe("r1: public token routes at the edge (ASTRA-WP7-1 #4)", () => {
  const post = async (path: string, body: unknown, open: Fake, db?: D1Database) => {
    const testEnv = { ...env, ...(db ? { DB: db } : {}), MACHINE_OPEN_LIMIT: open } as unknown as Env;
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://admin.murage.test${path}`, {
      method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": IP }, body: JSON.stringify(body) }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  it("every public route is keyed by IP alone: changing the selector never buys a fresh budget", () => {
    for (const path of ["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/withdrawal/repudiate", "/v1/public/withdrawal/new-link", "/v1/public/clarify"]) {
      for (const selector of ["a".repeat(22), "b".repeat(22)]) {
        expect(classifyEdge(new Request(`https://x.test${path}?selector=${selector}`, { method: "POST", headers: { "CF-Connecting-IP": IP } }))).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: IP });
      }
    }
  });
  it("over the limit: lookup and the act routes are 429 for every selector, new-link is 202 {}; no D1 either way", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, prepare, batch } = spyDb();
    const open = fake(false);
    for (const selector of ["a".repeat(22), "b".repeat(22), "c".repeat(22)]) {
      for (const path of ["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/withdrawal/repudiate"]) {
        const res = await post(path, { selector, secret: "s".repeat(43) }, open, db);
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "rate_limited" });
      }
      const res = await post("/v1/public/withdrawal/new-link", { selector }, open, db);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({});
    }
    expect(open.limit).toHaveBeenCalledTimes(12);
    for (const c of open.limit.mock.calls) expect(c[0]).toEqual({ key: IP });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    error.mockRestore();
  });
  it("within the limit, new-link goes on to the route (still 202 {})", async () => {
    const res = await post("/v1/public/withdrawal/new-link", { selector: "a".repeat(22) }, fake(true));
    expect([res.status, await res.json()]).toEqual([202, {}]);
  });
});

describe("Flux renewal acknowledgement at the edge (Astra B4-PORT P2)", () => {
  // The Flux routes are default-off (CLOUD_FLUX_ROUTES_ENABLED); these exercise the limiter as it stands once they are on.
  const fluxOn = { CLOUD_FLUX_ROUTES_ENABLED: "1" };
  it("classifies flux/subkey/ack with the other machine routes: open budget bearerless, bearer budget with a bearer, both keyed by IP", () => {
    for (const op of ["flux/subkey", "flux/subkey/ack", "flux/renewal-due"]) {
      expect(get(`/v1/machines/m-1/${op}`, false)).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: IP });
      expect(get(`/v1/machines/m-1/${op}`, true)).toEqual({ limiter: "MACHINE_BEARER_LIMIT", key: IP });
      // A different machine id in the path never buys a fresh budget.
      expect(get(`/v1/machines/m-2/${op}`, true)).toEqual(get(`/v1/machines/m-1/${op}`, true));
    }
  });
  it("a bearerless ack spends the shared open IP budget and is 429 with no D1 when it is exhausted", async () => {
    const { db, prepare, batch } = spyDb();
    const open = fake(false);
    for (const path of ["/v1/machines/m-1/unwrap", "/v1/machines/m-1/flux/subkey/ack", "/v1/machines/m-2/flux/subkey/ack"]) {
      const response = await call(path, { open, db, vars: fluxOn });
      expect([response.status, await response.json()]).toEqual([429, { error: "rate_limited" }]);
    }
    expect(open.limit).toHaveBeenCalledTimes(3);
    for (const c of open.limit.mock.calls) expect(c[0]).toEqual({ key: IP });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
  it("a bearer-shaped ack spends the shared bearer IP budget and is 429 with no D1 when it is exhausted", async () => {
    const { db, prepare, batch } = spyDb();
    const open = fake(true);
    const bearerLimit = fake(false);
    for (const path of ["/v1/machines/m-1/lease", "/v1/machines/m-1/flux/subkey/ack", "/v1/machines/m-3/flux/subkey/ack"]) {
      const response = await call(path, { bearer: true, open, bearerLimit, db, vars: fluxOn });
      expect(response.status).toBe(429);
    }
    expect(bearerLimit.limit).toHaveBeenCalledTimes(3);
    for (const c of bearerLimit.limit.mock.calls) expect(c[0]).toEqual({ key: IP });
    expect(open.limit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});
