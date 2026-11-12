// SPDX-License-Identifier: AGPL-3.0-or-later
// Cap catch-up and the raise that follows a top-up grant: owner caps and stops are never overridden, a router flush is repaired, and the work
// is bounded and idempotent through cap_version. The router is a fixture; no network.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { raiseCapToCover, sweepCapCatchUp, CAP_CATCHUP_HOMES, type FluxClient } from "../src/b4-flux";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const QUALIFIED = { stub: false, capabilities: { reversalTargets: true } } as never;
const M = 1_000_000;

interface Router { statusCalls: string[]; caps: Array<{ home: string; cap: number; version: number }>; spent: number; spendable: number | null; routerCap: number | undefined; onStatus?: () => Promise<void>; client: FluxClient }
function router(): Router {
  const r: Router = { statusCalls: [], caps: [], spent: 10 * M, spendable: 50 * M, routerCap: undefined, client: undefined as never };
  r.client = {
    status: async (home: string) => { r.statusCalls.push(home); await r.onStatus?.(); return { state: "active", capMicrocents: r.routerCap, spentMicrocents: r.spent, accountSpendableMicrocents: r.spendable }; },
    setCap: async (home: string, cap: number, version: number) => { r.caps.push({ home, cap, version }); },
  } as unknown as FluxClient;
  return r;
}
const e = () => ({ ...env, CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_API_BASE: "https://api.fluxrouter.ai", FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40), FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) }) as Env;
const deps = (r: Router, now = NOW) => ({ fluxClient: () => r.client, billingFlux: QUALIFIED, now: () => now });
async function seed(home: string, over: { state?: string; custom?: number; off?: number; hold?: number; cap?: number } = {}): Promise<void> {
  await env.DB.prepare(`INSERT OR REPLACE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,spending_off,billing_hold,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(home, "pro", 1, over.state ?? "active", over.cap ?? 30 * M, over.custom ?? 0, over.off ?? 0, over.hold ?? 0, NOW).run();
}
const stored = async (home: string) => (await env.DB.prepare("SELECT cap_microcents AS cap, cap_version AS v, cap_custom AS c FROM flux_home_keys WHERE home_id=?").bind(home).first<{ cap: number; v: number; c: number }>())!;
beforeEach(async () => { await env.DB.prepare("DELETE FROM flux_home_ops").run(); await env.DB.prepare("DELETE FROM flux_home_keys").run(); });

describe("cap raise to cover the balance", () => {
  it("raises a plan default cap to spent plus spendable, pushes it, and a second pass changes nothing", async () => {
    await seed("h1"); const r = router();
    expect(await raiseCapToCover(e(), "h1", deps(r))).toBe("raised");
    expect(await stored("h1")).toMatchObject({ cap: 60 * M, c: 0 });
    expect(r.caps).toEqual([{ home: "h1", cap: 60 * M, version: (await stored("h1")).v }]);
    r.routerCap = 60 * M;
    expect(await raiseCapToCover(e(), "h1", deps(r))).toBe("not_needed");
    expect(r.caps).toHaveLength(1);
  });

  it("never raises a cap the owner set, and says so", async () => {
    await seed("h1", { custom: 1 }); const r = router(); r.routerCap = 30 * M;
    expect(await raiseCapToCover(e(), "h1", deps(r))).toBe("owner_cap");
    expect(await stored("h1")).toMatchObject({ cap: 30 * M, c: 1 }); expect(r.caps).toEqual([]);
  });

  it("leaves spending off, a stopped home and a billing hold alone without asking the router", async () => {
    const r = router();
    for (const [i, o] of [{ off: 1 }, { state: "stopped" }, { state: "stopping" }, { hold: 1 }].entries()) {
      await seed(`h${i}`, o);
      expect(await raiseCapToCover(e(), `h${i}`, deps(r))).toBe("skipped");
      expect((await stored(`h${i}`)).cap).toBe(30 * M);
    }
    expect(r.statusCalls).toEqual([]); expect(r.caps).toEqual([]);
  });

  it("an unknown balance changes nothing", async () => {
    await seed("h1"); const r = router(); r.spendable = null;
    expect(await raiseCapToCover(e(), "h1", deps(r))).toBe("unknown");
    expect((await stored("h1")).cap).toBe(30 * M);
  });

  it("an owner cap set between the read and the write is not overridden", async () => {
    await seed("h1"); const r = router();
    r.onStatus = async () => { await env.DB.prepare("UPDATE flux_home_keys SET cap_custom=1, cap_microcents=20000000, cap_version=cap_version+1 WHERE home_id='h1'").run(); };
    expect(await raiseCapToCover(e(), "h1", deps(r))).toBe("raced");
    expect(await stored("h1")).toMatchObject({ cap: 20 * M, c: 1 }); expect(r.caps).toEqual([]);
  });

  it("a cap the router lost (flush, restore) is pushed again at a higher version, owner cap included", async () => {
    for (const custom of [0, 1]) {
      await seed("h1", { custom }); const r = router(); r.spendable = 5 * M; r.routerCap = 0;
      const before = (await stored("h1")).v;
      expect(await raiseCapToCover(e(), "h1", deps(r))).toBe("repaired");
      const after = await stored("h1");
      expect(after).toMatchObject({ cap: 30 * M, c: custom }); expect(after.v).toBeGreaterThan(before);
      expect(r.caps).toEqual([{ home: "h1", cap: 30 * M, version: after.v }]);
    }
  });
});

describe("cap catch-up sweep", () => {
  it("checks at most 25 homes per pass, least recently checked first, and each only once per interval", async () => {
    for (let i = 0; i < 30; i++) await seed(`h${String(i).padStart(2, "0")}`);
    const r = router(); r.spendable = 0; // nothing to raise: the reads are what is counted
    await sweepCapCatchUp(e(), deps(r));
    expect(r.statusCalls).toHaveLength(CAP_CATCHUP_HOMES);
    await sweepCapCatchUp(e(), deps(r));
    expect(r.statusCalls).toHaveLength(30);
    await sweepCapCatchUp(e(), deps(r));
    expect(r.statusCalls).toHaveLength(30);
    await sweepCapCatchUp(e(), deps(r, NOW + 31 * 60_000));
    expect(r.statusCalls).toHaveLength(55);
  });

  it("raises homes with more balance than room, skips owner caps and stops, and a repeat pass is idempotent", async () => {
    await seed("a"); await seed("b", { custom: 1 }); await seed("c", { off: 1 }); await seed("d", { state: "stopped" }); await seed("e", { hold: 1 });
    const r = router(); r.routerCap = 30 * M;
    expect(await sweepCapCatchUp(e(), deps(r))).toBe(1);
    expect((await stored("a")).cap).toBe(60 * M);
    for (const h of ["b", "c", "d", "e"]) expect((await stored(h)).cap).toBe(30 * M);
    expect(r.caps.map((c) => c.home)).toEqual(["a"]);
    r.routerCap = 60 * M;
    expect(await sweepCapCatchUp(e(), deps(r, NOW + 31 * 60_000))).toBe(0);
    expect(r.caps).toHaveLength(1);
  });
});
