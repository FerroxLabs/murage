// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/engine-health (UX 1.0.13, lane L2A): owner only, read only, each
// engine in plain words, the default engine named, and the Flux key in one word
// without ever waiting long or inventing a problem.
import { describe, expect, it, vi } from "vitest";
import { dropEngineHealthMemo, ENGINE_HEALTH_MEMO_MS, ENGINE_HEALTH_PATH, ENGINE_HEALTH_RECHECK_MS, ENGINE_HEALTH_RECHECK_PATH, FLUX_WAIT_MS, engineHealthRoute, fluxInfoFrom, engineRow, fluxHealthFrom, type EngineHealthDeps, type EngineHealthInstance, type EngineHealthMemo } from "./engine-health-routes.ts";
import type { FluxKeyCheck } from "./flux-key-health.ts";

const url = (path = ENGINE_HEALTH_PATH) => new URL(`http://127.0.0.1${path}`);
const claude: EngineHealthInstance = { instanceId: "claude", displayName: "Claude", snapshot: { state: "available", authenticated: true } };
const codex: EngineHealthInstance = { instanceId: "codex", displayName: "Codex", snapshot: { state: "available", authenticated: false } };
const deps = (over: Partial<EngineHealthDeps> = {}): EngineHealthDeps => ({
  owner: true,
  instances: async () => [claude, codex],
  primaryId: () => "claude",
  fluxKey: () => null,
  now: () => 1234,
  ...over,
});

describe("the bundled Fuigo", () => {
  it("has no login to lose: a client with no key is not signed out, Flux state speaks for it", () => {
    expect(engineRow({ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: false } }).state).toBe("ready");
  });
});

describe("a sign-in check that did not answer", () => {
  it("reads Checking sign-in, never Signed in and ready", () => {
    const row = engineRow({ instanceId: "codex", displayName: "Codex", driverKind: "codex", snapshot: { state: "available", authUnverified: true } });
    expect(row).toMatchObject({ state: "checking", line: "Checking sign-in." });
  });
  it("leaves an engine with no sign-in to report as ready", () => {
    expect(engineRow({ instanceId: "pi", displayName: "Pi", driverKind: "pi", snapshot: { state: "available" } }).state).toBe("ready");
  });
});

describe("engineHealthRoute", () => {
  it("is not this route's business for any other path", async () => {
    expect(await engineHealthRoute({ method: "GET", url: url("/api/health") }, deps())).toBeNull();
  });

  it("answers the unknown-route 404 to anyone but the owner, before reading anything", async () => {
    const instances = vi.fn(async () => [claude]);
    expect(await engineHealthRoute({ method: "GET", url: url() }, deps({ owner: false, instances }))).toEqual({ status: 404, body: { error: "no such route" } });
    expect(instances).not.toHaveBeenCalled();
  });

  it("only reads: any method but GET is refused", async () => {
    expect((await engineHealthRoute({ method: "POST", url: url() }, deps()))?.status).toBe(405);
  });

  it("lists every engine in plain words and names the default one", async () => {
    const answer = await engineHealthRoute({ method: "GET", url: url() }, deps());
    expect(answer).toEqual({
      status: 200,
      body: {
        engines: [
          { id: "claude", label: "Claude", state: "ready", line: "Signed in and ready.", usedBy: 0 },
          { id: "codex", label: "Codex", state: "signed-out", line: "Signed out. Sign in again in Settings, Engines.", usedBy: 0 },
        ],
        primary: { id: "claude", label: "Claude", state: "ready", line: "Signed in and ready.", usedBy: 0 },
        defaultId: "claude",
        flux: "none",
        fluxInfo: null,
        fuigoVersion: null,
        checkedAt: 1234,
      },
    });
  });

  it("falls back to the first ready engine when the default is unknown, and answers with no engines at all", async () => {
    const body = (await engineHealthRoute({ method: "GET", url: url() }, deps({ primaryId: () => "gone", instances: async () => [codex, claude] })))?.body as { primary: { id: string }; defaultId: string | null };
    expect(body.primary.id).toBe("claude");
    // the fallback is for Today's tag only: Health is told no default is set, so it never treats the fallback as one
    expect(body.defaultId).toBeNull();
    const empty = (await engineHealthRoute({ method: "GET", url: url() }, deps({ instances: async () => { throw new Error("scan failed"); } })))?.body as { engines: unknown[]; primary: unknown };
    expect(empty.engines).toEqual([]);
    expect(empty.primary).toBeNull();
  });

  it("says off and missing for an engine switched off or not on the computer", async () => {
    const body = (await engineHealthRoute({ method: "GET", url: url() }, deps({ instances: async () => [{ ...claude, enabled: false }, { ...codex, snapshot: { state: "unavailable" } }] })))?.body as { engines: Array<{ state: string }> };
    expect(body.engines.map((engine) => engine.state)).toEqual(["off", "missing"]);
  });

  it("reads the Flux key through the cached check, and says ok rather than wait past FLUX_WAIT_MS", async () => {
    vi.useFakeTimers();
    try {
      const pending = engineHealthRoute({ method: "GET", url: url() }, deps({ fluxKey: () => "sk-flux-test", refused: () => false, checkFlux: () => new Promise(() => undefined) }));
      await vi.advanceTimersByTimeAsync(FLUX_WAIT_MS);
      expect(((await pending)?.body as { flux: string }).flux).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says allowance used up when Flux reports the key blocked or spent", async () => {
    const used = await engineHealthRoute({ method: "GET", url: url() }, deps({ fluxKey: () => "k", refused: () => false, checkFlux: async () => ({ state: "valid", info: { blocked: false, expires: null, maxBudget: 30, spend: 30 } }) }));
    expect((used?.body as { flux: string }).flux).toBe("allowance-used-up");
  });

  it("serves one answer for a minute to every caller, then scans again", async () => {
    let clock = 1_000_000;
    let scans = 0;
    const memo: EngineHealthMemo = { at: 0, body: null };
    const ask = () => engineHealthRoute({ method: "GET", url: url() }, deps({ memo, now: () => clock, instances: async () => { scans++; return []; } }));
    await ask();
    clock += ENGINE_HEALTH_MEMO_MS - 1;
    await ask();
    expect(scans).toBe(1);
    clock += 1;
    await ask();
    expect(scans).toBe(2);
    // a non-owner never reads the memo either
    expect((await engineHealthRoute({ method: "GET", url: url() }, deps({ owner: false, memo })))?.status).toBe(404);
  });
});

describe("fluxHealthFrom", () => {
  const valid = (info: Partial<{ blocked: boolean; maxBudget: number | null; spend: number | null }>) => ({ state: "valid" as const, info: { blocked: false, expires: null, maxBudget: null, spend: null, ...info } });
  it("names each case", () => {
    expect(fluxHealthFrom(null, false, null)).toBe("none");
    expect(fluxHealthFrom("  ", false, null)).toBe("none");
    expect(fluxHealthFrom("k", true, null)).toBe("key-problem");
    expect(fluxHealthFrom("k", false, { state: "invalid" })).toBe("key-problem");
    expect(fluxHealthFrom("k", false, valid({ blocked: true }))).toBe("allowance-used-up");
    expect(fluxHealthFrom("k", false, valid({ maxBudget: 30, spend: 29.99 }))).toBe("ok");
    expect(fluxHealthFrom("k", false, valid({ maxBudget: 0, spend: 0 }))).toBe("ok");
    expect(fluxHealthFrom("k", false, { state: "unknown" })).toBe("ok");
  });
});

// HEALTH-DOCTOR (Sean 11-02): how many bots use each engine, the Flux figures the cached check already had, and Check again.
describe("the doctor's figures", () => {
  it("counts the bots on each engine and marks the bundled Fuigo", async () => {
    const fuigo: EngineHealthInstance = { instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available" } };
    const body = (await engineHealthRoute({ method: "GET", url: url() }, deps({ instances: async () => [fuigo, claude, codex], botEngineIds: () => ["fuigo", "claude", "fuigo"] })))?.body as { engines: Array<{ id: string; usedBy: number; fuigo?: true }> };
    expect(body.engines.map((row) => [row.id, row.usedBy, row.fuigo ?? false])).toEqual([["fuigo", 2, true], ["claude", 1, false], ["codex", 0, false]]);
  });

  it("a failing bot list still answers, with no counts", async () => {
    const body = (await engineHealthRoute({ method: "GET", url: url() }, deps({ botEngineIds: () => { throw new Error("store"); } })))?.body as { engines: Array<{ usedBy: number }> };
    expect(body.engines.map((row) => row.usedBy)).toEqual([0, 0]);
  });

  it("sends the Flux figures only from a valid check, never from an unknown or invalid one", async () => {
    const read = async (check: FluxKeyCheck) => ((await engineHealthRoute({ method: "GET", url: url() }, deps({ fluxKey: () => "k", refused: () => false, checkFlux: async () => check })))?.body as { fluxInfo: unknown }).fluxInfo;
    expect(await read({ state: "valid", info: { blocked: false, expires: "2026-12-01T00:00:00Z", maxBudget: 50, spend: 41 } })).toEqual({ spendPct: 82, expires: "2026-12-01T00:00:00Z" });
    expect(await read({ state: "unknown" })).toBeNull();
    expect(await read({ state: "invalid" })).toBeNull();
  });

  it("has no percentage without a budget, and never one past 100", () => {
    expect(fluxInfoFrom({ state: "valid", info: { blocked: false, expires: null, maxBudget: null, spend: 3 } })).toEqual({ spendPct: null, expires: null });
    expect(fluxInfoFrom({ state: "valid", info: { blocked: false, expires: null, maxBudget: 0, spend: 0 } })?.spendPct).toBeNull();
    expect(fluxInfoFrom({ state: "valid", info: { blocked: true, expires: null, maxBudget: 10, spend: 14 } })?.spendPct).toBe(100);
  });
});

describe("Check again (POST /api/engine-health/recheck)", () => {
  const recheckUrl = url(ENGINE_HEALTH_RECHECK_PATH);
  it("answers the unknown-route 404 to anyone but the owner, and drops nothing", async () => {
    const recheck = vi.fn();
    expect((await engineHealthRoute({ method: "POST", url: recheckUrl, contentType: "application/json" }, deps({ owner: false, recheck })))?.status).toBe(404);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("takes POST with a JSON body type only", async () => {
    const recheck = vi.fn();
    expect((await engineHealthRoute({ method: "GET", url: recheckUrl }, deps({ recheck })))?.status).toBe(405);
    expect((await engineHealthRoute({ method: "POST", url: recheckUrl, contentType: "text/plain" }, deps({ recheck })))?.status).toBe(415);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("drops the cached Flux answer and the memo, so the next read asks again, once per window", async () => {
    let clock = 5_000_000;
    let scans = 0;
    const recheck = vi.fn();
    const memo: EngineHealthMemo = { at: 0, body: null };
    const read = () => engineHealthRoute({ method: "GET", url: url() }, deps({ memo, now: () => clock, instances: async () => { scans++; return []; } }));
    const press = () => engineHealthRoute({ method: "POST", url: recheckUrl, contentType: "application/json" }, deps({ memo, now: () => clock, recheck }));
    await read();
    expect((await press())?.body).toEqual({ ok: true, fresh: true });
    expect(memo.body).toBeNull();
    await read();
    expect(scans).toBe(2);
    clock += ENGINE_HEALTH_RECHECK_MS - 1;
    expect((await press())?.body).toEqual({ ok: true, fresh: false });
    expect(recheck).toHaveBeenCalledTimes(1);
    clock += 1;
    await press();
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it("a read that started before Check again answers its caller but never puts its older answer back", async () => {
    const memo: EngineHealthMemo = { at: 0, body: null };
    let release: (rows: EngineHealthInstance[]) => void = () => {};
    const slow = engineHealthRoute({ method: "GET", url: url() }, deps({ memo, now: () => 9_000_000, instances: () => new Promise((resolve) => { release = resolve; }) }));
    await engineHealthRoute({ method: "POST", url: recheckUrl, contentType: "application/json" }, deps({ memo, now: () => 9_000_000, recheck: vi.fn() }));
    release([claude]);
    expect((await slow)?.status).toBe(200);
    expect(memo.body).toBeNull();
    dropEngineHealthMemo(memo);
    expect(memo.gen).toBe(2);
  });
});

describe("Health's Switch on, on the server", () => {
  it("refuses while answers run before it takes the fence or closes any stream, and drops the engine memo after", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("const instancePatch = /^\\/api\\/instances\\/([\\w.-]+)$/.exec(path);");
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, source.indexOf("// ── custom MCP servers", start));
    const guard = block.indexOf('url.searchParams.get("whenIdle") === "1" && engineSwitchWouldInterrupt()');
    const fence = block.indexOf("providerConfigBusy = true; void closeAllStreams();");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(fence);
    // nothing awaits between the check and the fence, so no turn can start in between
    expect(block.slice(guard, fence)).not.toContain("await");
    expect(block).toContain("dropEngineHealthMemo(engineHealthMemo);");
  });
});
