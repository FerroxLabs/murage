// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/engine-health (UX 1.0.13, lane L2A): owner only, read only, each
// engine in plain words, the default engine named, and the Flux key in one word
// without ever waiting long or inventing a problem.
import { describe, expect, it, vi } from "vitest";
import { ENGINE_HEALTH_MEMO_MS, ENGINE_HEALTH_PATH, FLUX_WAIT_MS, engineHealthRoute, fluxHealthFrom, type EngineHealthDeps, type EngineHealthInstance, type EngineHealthMemo } from "./engine-health-routes.ts";

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
          { id: "claude", label: "Claude", state: "ready", line: "Signed in and ready." },
          { id: "codex", label: "Codex", state: "signed-out", line: "Signed out. Sign in again in Settings, Engines." },
        ],
        primary: { id: "claude", label: "Claude", state: "ready", line: "Signed in and ready." },
        flux: "none",
        checkedAt: 1234,
      },
    });
  });

  it("falls back to the first ready engine when the default is unknown, and answers with no engines at all", async () => {
    const body = (await engineHealthRoute({ method: "GET", url: url() }, deps({ primaryId: () => "gone", instances: async () => [codex, claude] })))?.body as { primary: { id: string } };
    expect(body.primary.id).toBe("claude");
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
