import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { migrated } from "./d1";

const ctx = () => {
  const waits: Promise<unknown>[] = [];
  return { waits, ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext };
};

describe("the Worker entry", () => {
  it("starts with neither APNs nor FCM configured", async () => {
    const env = { DB: migrated(), IOS_BUNDLE_ID: "com.murage.mobile", ANDROID_PACKAGE: "com.murage.mobile", GLOBAL_DAILY_CAP: "100000", RELAY_PAUSED: "0" };
    const { ctx: c } = ctx();
    const res = await worker.fetch(new Request("https://relay.test/v1/challenges", { method: "POST", headers: { "cf-connecting-ip": "100.64.0.9" } }), env as never, c);
    expect(res.status).toBe(201);
    const sweep = ctx();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await worker.scheduled({} as ScheduledController, env as never, sweep.ctx);
      await Promise.all(sweep.waits);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("the RELAY_PAUSED var refuses events", async () => {
    const env = { DB: migrated(), IOS_BUNDLE_ID: "com.murage.mobile", ANDROID_PACKAGE: "com.murage.mobile", GLOBAL_DAILY_CAP: "100000", RELAY_PAUSED: "1" };
    const res = await worker.fetch(new Request("https://relay.test/v1/events", { method: "POST", body: "{}" }), env as never, ctx().ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "relay_paused" });
  });
});

describe("the scheduled run", () => {
  it("a failing flush still sweeps, and the failure is logged without content", async () => {
    const db = migrated();
    await db.prepare("INSERT INTO relay_challenges (id,expires_at) VALUES ('old',1)").run();
    const broken = { prepare: (sql: string) => { if (sql.includes("lease_until=?")) throw new Error("D1 down murage_pt_secret"); return db.prepare(sql); }, batch: db.batch.bind(db) };
    const env = { DB: broken, IOS_BUNDLE_ID: "com.murage.mobile", ANDROID_PACKAGE: "com.murage.mobile", GLOBAL_DAILY_CAP: "100000", RELAY_PAUSED: "0" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = ctx();
      await worker.scheduled({} as ScheduledController, env as never, run.ctx);
      await Promise.all(run.waits);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM relay_challenges").first<{ n: number }>()).toEqual({ n: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/murage_pt_|D1 down/);
      expect(JSON.stringify(spy.mock.calls)).toContain("flush");
    } finally {
      spy.mockRestore();
    }
  });
});
