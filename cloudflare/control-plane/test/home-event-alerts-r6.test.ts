// SPDX-License-Identifier: AGPL-3.0-or-later
// J5b r7 RED corpus, control plane side (DESIGN-J5b-r7.md sections 1, 7, 8): C3 (clock step, prune by acceptance seq), C5 (a duplicate key leaves an open alert's
// detail alone), C6 (a new event into an open alert is atomic, two faults), C7 (R-loss-1 on the wire, MurageMain r7 ruling 7) and C8 (a hold alert has an owner,
// ruling 8). Written against CP base fe8af44a3a (feat/1019-cp-event-types), where recordHealth keeps no per-key memory: a replay of an
// event whose alert has since been resolved and aged out opens a NEW alert. A second file beside home-event-alerts.test.ts so the two merge without a
// conflict; at integration the three tests move into it. The migration 0158_home_event_keys.sql (a draft, number rechecked at integration) is picked up
// by the rig from the migrations folder.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { alertTier } from "../src/alert-tiers";
import { raiseAlert, recordHealth, sweepMonitoring } from "../src/ops-monitor";

const NOW = Date.UTC(2026, 9, 10, 8, 0, 0);
const DAY = 86_400_000;
const KIND = "restore.aborted";
const openCount = async (home: string, kind = KIND) => (await env.DB.prepare("SELECT count(*) AS n FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL").bind(home, kind).first<{ n: number }>())?.n ?? -1;
const resolveAll = (home: string, at: number) => env.DB.prepare("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=0 WHERE home_id=? AND resolved_at IS NULL").bind(at, home).run();
const send = (db: unknown, home: string, at: number, now: number) => recordHealth({ ...env, DB: db } as unknown as Env, home, { events: [{ type: KIND, at }] }, now);

describe("C3 clock step and prune by acceptance order", () => {
  it("keeps the 128 newest keys by seq after the wall clock steps back a day, and a replay after the 91 day sweep opens nothing", async () => {
    const home = "h-c3";
    for (let n = 0; n < 200; n++) {
      const now = n < 100 ? NOW + n * 1000 : NOW + (n - 100) * 1000 - DAY; // the wall clock is stepped back one day at key 100
      await send(env.DB, home, NOW + n * 1000, now);
      if (n % 10 === 9) await resolveAll(home, now + 1); // let later keys open their own alerts
    }
    await resolveAll(home, NOW + 10_000);
    await sweepMonitoring(env as Env, NOW + 91 * DAY); // the 91 day alert sweep: resolved alerts are gone, so only the key memory can stop a replay
    await send(env.DB, home, NOW + 199 * 1000, NOW + 91 * DAY + 1000); // the retried heartbeat of key 199
    expect(await openCount(home), "a replay of an already accepted key opened a new alert (base keeps no key)").toBe(0);
    const kept = await env.DB.prepare("SELECT at FROM home_event_keys WHERE home_id=? AND kind=? ORDER BY at").bind(home, KIND).all<{ at: number }>();
    expect(kept.results.map((r) => r.at), "prune keeps the 128 newest by seq (keys 72..199), not by first_seen").toEqual(Array.from({ length: 128 }, (_, i) => NOW + (72 + i) * 1000));
  }, 120_000);
});

/** A D1 wrapper for fault (b) of C6: the FIRST statement that sets cloud_alerts.detail and is run OUTSIDE a batch throws. Statements handed to batch() are
 *  unwrapped and run by the real batch, so a correct implementation (detail update inside the batch) never trips it. */
function outsideBatchFault() {
  let thrown = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof value !== "function") return value;
        if (["run", "all", "first", "raw"].includes(String(prop)) && /UPDATE\s+cloud_alerts\s+SET\s+detail/i.test(sql)) {
          return async (...args: unknown[]) => { if (thrown++ === 0) throw new Error("injected D1 failure outside a batch"); return (value as (...a: unknown[]) => unknown).apply(target, args); };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    real.set(p, stmt);
    return p;
  };
  return {
    prepare: (sql: string) => wrap(env.DB.prepare(sql), sql),
    exec: (sql: string) => env.DB.exec(sql),
    batch: (list: D1PreparedStatement[]) => env.DB.batch(list.map((statement) => real.get(statement) ?? statement)),
    thrownCount: () => thrown,
  };
}

describe("C6 a new event into an open alert is atomic", () => {
  it("fault (b) first: no detail UPDATE outside the batch; fault (a): a batch that throws once changes nothing; a replay after resolve and the 91 day sweep opens nothing", async () => {
    // Fault (b) (kills MU-58b). Correct code runs the detail update inside the batch, so the wrapper never throws and A's detail reads 200. MU-58b's
    // post-batch UPDATE throws, the retry is a duplicate (the key is recorded) and A would read 100. This half passes at base: base has no such split.
    const homeB = "h-c6b";
    await send(env.DB, homeB, 100, NOW);
    const fault = outsideBatchFault();
    try { await send(fault, homeB, 200, NOW + 1000); } catch { /* only a mutant throws here */ }
    await send(fault, homeB, 200, NOW + 2000); // the retried heartbeat
    const bDetail = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL").bind(homeB, KIND).all<{ detail: string }>();
    expect(bDetail.results, "still one open alert").toHaveLength(1);
    expect(bDetail.results[0].detail, "MU-58b: the detail was updated outside the batch and lost to the fault").toContain("event time 200");
    // Fault (a) (kills MU-58): the batch throws once.
    const home = "h-c6";
    await send(env.DB, home, 100, NOW); // alert A is open at event time 100
    let thrown = 0;
    const flaky = {
      prepare: (sql: string) => env.DB.prepare(sql),
      exec: (sql: string) => env.DB.exec(sql),
      batch: async (statements: D1PreparedStatement[]) => { if (thrown++ === 0) throw new Error("injected D1 failure"); return env.DB.batch(statements); },
    };
    try { await send(flaky, home, 200, NOW + 1000); } catch { /* the batch threw once */ }
    await send(flaky, home, 200, NOW + 2000); // the retried heartbeat
    const detail = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL").bind(home, KIND).all<{ detail: string }>();
    expect(detail.results, "still one open alert").toHaveLength(1);
    expect(detail.results[0].detail, "the detail update reads 200 (passes at base)").toContain("event time 200");
    await resolveAll(home, NOW + 5000);
    await sweepMonitoring(env as Env, NOW + 91 * DAY);
    await send(env.DB, home, 200, NOW + 91 * DAY + 1000); // the replay of B
    expect(await openCount(home), "the replay of B opened a new alert (base keeps no key)").toBe(0);
    const keys = await env.DB.prepare("SELECT count(*) AS n FROM home_event_keys WHERE home_id=? AND kind=? AND at=200").bind(home, KIND).first<{ n: number }>();
    expect(keys?.n, "exactly one key row exists for B").toBe(1);
  }, 60_000);
});

describe("C5 a duplicate key leaves an open alert's detail alone", () => {
  it("K1 at 200 opens A1, A1 resolves, K2 at 150 opens A2; the replay of K1 is a duplicate: no new alert and A2 still reads 150", async () => {
    const home = "h-c5";
    await send(env.DB, home, 200, NOW); // K1 opens A1
    await resolveAll(home, NOW + 500);
    await send(env.DB, home, 150, NOW + 1000); // K2 opens A2, detail "event time 150"
    await send(env.DB, home, 200, NOW + 2000); // the retried heartbeat of K1
    const open = await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL").bind(home, KIND).all<{ detail: string }>();
    expect(open.results, "no new alert for the replay").toHaveLength(1);
    expect(open.results[0].detail, "base runs its detail UPDATE because stored 150 < 200 (MU-47)").toContain("event time 150");
    const total = await env.DB.prepare("SELECT count(*) AS n FROM cloud_alerts WHERE home_id=? AND kind=?").bind(home, KIND).first<{ n: number }>();
    expect(total?.n, "exactly two alerts ever: A1 (resolved) and A2").toBe(2);
    const direct = await (raiseAlert as unknown as (e: Env, a: unknown, now: number, f: undefined, at: number) => Promise<unknown>)(env as Env, { homeId: home, kind: KIND, severity: "high", detail: "reported by the home, event time 200" }, NOW + 3000, undefined, 200);
    expect(direct, "raiseAlert with an event time answers \"duplicate\" for a known key").toBe("duplicate");
  });
});

describe("C7 R-loss-1 on the wire (MurageMain r7 ruling 7)", () => {
  // The CP suppresses a distinct event only when it carries the exact (kind, at) of a recorded key. The home halves (P26, T17) prove the home sends the
  // same key only when every condition holds; this half proves what the CP does with the keys. The two PIN halves pass at base by design.
  const prepare = async (home: string) => {
    await send(env.DB, home, 31337, NOW);
    await resolveAll(home, NOW + 500);
    await sweepMonitoring(env as Env, NOW + 91 * DAY); // the key memory is all that can stop a second alert
  };
  it("same kind, same millisecond: the distinct event is suppressed (the documented residual)", async () => {
    await prepare("h-c7a");
    await send(env.DB, "h-c7a", 31337, NOW + 91 * DAY + 1000);
    expect(await openCount("h-c7a"), "suppressed: base opens a second alert (it keeps no key)").toBe(0);
  });
  it("PIN: a different millisecond is delivered", async () => {
    await prepare("h-c7b");
    await send(env.DB, "h-c7b", 31342, NOW + 91 * DAY + 1000);
    expect(await openCount("h-c7b")).toBe(1);
  });
  it("PIN: a different kind is delivered", async () => {
    await prepare("h-c7c");
    await recordHealth(env as Env, "h-c7c", { events: [{ type: "restore.stuck", at: 31337 }] }, NOW + 91 * DAY + 1000);
    expect(await openCount("h-c7c", "restore.stuck")).toBe(1);
  });
});

describe("C8 a hold alert has an owner (MurageMain r7 ruling 8)", () => {
  it("home.event_spool_failed opens an alert and its tier names who acts", async () => {
    const home = "h-c8";
    await recordHealth(env as Env, home, { events: [{ type: "home.event_spool_failed", at: 7 }] }, NOW);
    expect(await openCount(home, "home.event_spool_failed"), "the alert opens (passes at base)").toBe(1);
    const tier = alertTier("home.event_spool_failed");
    expect(tier.tier, "base files it in the digest with no action text: nobody owns a hold").toBe("page");
    if (tier.tier === "page") {
      expect(tier.group.length).toBeGreaterThan(0);
      expect(tier.action, "the action text names the owner").toMatch(/MurageCloud|MurageMain|Sean|owner/);
    }
  });
});
