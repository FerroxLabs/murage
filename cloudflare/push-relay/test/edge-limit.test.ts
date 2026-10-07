import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import { randomToken } from "../src/http";
import { edgeAllows, type EdgeLimiter } from "../src/limits";
import worker from "../src/index";
import { migrated } from "./d1";
import { publisher, relayUnderTest } from "./relay-harness";

const BINDING = "0b0f5a1e-4c2d-4e8f-9a1b-2c3d4e5f6a7b";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A Rate Limiting binding in miniature: `limit` uses per key, forever. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const binding: EdgeLimiter = {
    limit: async ({ key }) => {
      keys.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key)! <= limit };
    },
  };
  return { binding, keys };
}

/** Counts every statement the relay prepares or batches: any is D1 work. */
function watched(db: Db) {
  let work = 0;
  return { db: { prepare: (sql: string) => { work++; return db.prepare(sql); }, batch: (list: Parameters<Db["batch"]>[0]) => { work++; return db.batch(list); } } as Db, work: () => work };
}

function gated(openLimit = 20, bearerLimit = 120) {
  const open = limiter(openLimit);
  const bearer = limiter(bearerLimit);
  const events = vi.fn(async () => new Response(null, { status: 202 }));
  const d1 = watched(migrated());
  const t = relayUnderTest({ db: d1.db, edge: { open: open.binding, bearer: bearer.binding }, events });
  return { t, open, bearer, events, work: d1.work };
}

async function refusedWithoutD1(g: ReturnType<typeof gated>, res: Promise<Response>) {
  const before = g.work();
  const answer = await res;
  expect(answer.status).toBe(429);
  expect(await answer.json()).toEqual({ error: "rate_limited" });
  expect(answer.headers.get("content-type")).toBe("application/json");
  expect(g.work()).toBe(before);
}

describe("the edge limit", () => {
  it("gates challenges per client before D1", async () => {
    const g = gated(3);
    for (let i = 0; i < 3; i++) expect((await g.t.call("POST", "/v1/challenges")).status).toBe(201);
    await refusedWithoutD1(g, g.t.call("POST", "/v1/challenges"));
    expect(g.open.keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(g.open.keys).toEqual(Array(4).fill(g.open.keys[0]));
    expect(g.bearer.keys).toEqual([]);
    // Another address has its own bucket.
    expect((await g.t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "100.64.0.2" })).status).toBe(201);
  });
  it("keys an IPv6 client by its /64, like the D1 limits", async () => {
    const g = gated(1);
    expect((await g.t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "2001:db8:1:2::1" })).status).toBe(201);
    await refusedWithoutD1(g, g.t.call("POST", "/v1/challenges", undefined, { "cf-connecting-ip": "2001:db8:1:2:ffff::9" }));
    expect(g.open.keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(g.open.keys[1]).toBe(g.open.keys[0]);
  });
  it("gates redemptions and registrations before D1", async () => {
    const g = gated(0);
    await refusedWithoutD1(g, g.t.call("POST", "/v1/publishers/redeem", { grant: randomToken("murage_pg_") }));
    await refusedWithoutD1(g, g.t.call("POST", "/v1/devices", {}));
  });
  it("gates a missing or malformed bearer on every bearer route before D1, the kill switch included", async () => {
    const g = gated(0);
    const routes: [string, string][] = [["PUT", "/v1/devices/self/token"], ["POST", "/v1/bindings"], ["DELETE", `/v1/bindings/${BINDING}`], ["POST", "/v1/events"]];
    for (const [method, path] of routes) {
      await refusedWithoutD1(g, g.t.call(method, path, {}));
      await refusedWithoutD1(g, g.t.call(method, path, {}, auth("murage_ds_short")));
      await refusedWithoutD1(g, g.t.call(method, path, {}, { authorization: "Basic abc" }));
    }
    // A device secret where only a publisher token is accepted is malformed too.
    await refusedWithoutD1(g, g.t.call("POST", "/v1/events", {}, auth(randomToken("murage_ds_"))));
    expect(g.events).not.toHaveBeenCalled();
    expect(g.bearer.keys).toEqual([]);
  });
  it("gates every well-formed bearer before D1 looks it up, on its own limit", async () => {
    const g = gated(20, 2);
    const guess = randomToken("murage_ds_");
    expect((await g.t.call("POST", "/v1/bindings", undefined, auth(guess))).status).toBe(401);
    expect((await g.t.call("DELETE", `/v1/bindings/${BINDING}`, undefined, auth(randomToken("murage_pt_")))).status).toBe(401);
    await refusedWithoutD1(g, g.t.call("PUT", "/v1/devices/self/token", { pushToken: "d".repeat(64) }, auth(guess)));
    await refusedWithoutD1(g, g.t.call("POST", "/v1/events", {}, auth(randomToken("murage_pt_"))));
    expect(g.open.keys).toEqual([]);
  });
  it("lets the real flow through under the limits, and leaves unrouted requests alone", async () => {
    const g = gated();
    const p = await publisher(g.t);
    expect(p.publisherToken).toMatch(/^murage_pt_/);
    expect((await g.t.call("POST", "/v1/events", {}, auth(p.publisherToken))).status).toBe(202);
    expect(g.events).toHaveBeenCalledTimes(1);
    // challenge, registration, redemption; then the binding and the event.
    expect(g.open.keys).toHaveLength(3);
    expect(g.bearer.keys).toHaveLength(2);
    for (const [method, path] of [["GET", "/v1/challenges"], ["POST", "/v1/nothing"], ["DELETE", "/v1/bindings/not-a-uuid"]]) {
      expect((await g.t.call(method, path)).status).toBe(404);
    }
    expect(g.open.keys).toHaveLength(3);
    expect(g.bearer.keys).toHaveLength(2);
  });
});

describe("without a working binding", () => {
  afterEach(() => vi.restoreAllMocks());
  it("no binding is no edge limit: only D1's limits apply", async () => {
    const t = relayUnderTest();
    for (let i = 0; i < 30; i++) expect((await t.call("POST", "/v1/challenges")).status).toBe(201);
    // The 31st is D1's per-IP hourly limit, not the edge's.
    expect((await t.call("POST", "/v1/challenges")).status).toBe(429);
    expect(await edgeAllows(undefined, "ip4=1.2.3.4")).toBe(true);
  });
  it("a binding that throws lets the request through and says so without the key", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = relayUnderTest({ edge: { open: { limit: async () => { throw new Error("limiter down 100.64.0.1"); } } } });
    expect((await t.call("POST", "/v1/challenges")).status).toBe(201);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/100\.64|limiter down/);
  });
});

describe("the Worker entry", () => {
  const base = { IOS_BUNDLE_ID: "com.murage.mobile", ANDROID_PACKAGE: "com.murage.mobile", GLOBAL_DAILY_CAP: "100000", RELAY_PAUSED: "0" };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const challenge = () => new Request("https://relay.test/v1/challenges", { method: "POST", headers: { "cf-connecting-ip": "100.64.0.9" } });
  it("runs without the rate-limit bindings (a dry run, the tests)", async () => {
    expect((await worker.fetch(challenge(), { ...base, DB: migrated() } as never, ctx)).status).toBe(201);
  });
  it("wires EDGE_OPEN_LIMIT and EDGE_BEARER_LIMIT", async () => {
    const open = limiter(0);
    const bearer = limiter(0);
    const env = { ...base, DB: migrated(), EDGE_OPEN_LIMIT: open.binding, EDGE_BEARER_LIMIT: bearer.binding };
    expect((await worker.fetch(challenge(), env as never, ctx)).status).toBe(429);
    const events = new Request("https://relay.test/v1/events", { method: "POST", body: "{}", headers: { "cf-connecting-ip": "100.64.0.9", ...auth(randomToken("murage_pt_")) } });
    expect((await worker.fetch(events, env as never, ctx)).status).toBe(429);
    expect(open.keys).toHaveLength(1);
    expect(open.keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(bearer.keys).toEqual(open.keys);
  });
});
