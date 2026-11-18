// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginFluxKeyEvidence, reportFluxKeyEvidence, FLUX_KEY_INFO_URL, KEY_INFO_TTL_MS, KEY_REFUSED_RETRY_MS, checkFluxKey, fluxKeyRefused, fluxRetryDelayMs, noteFluxKeyRefused, requestFluxKeyRecheck, resetFluxKeyHealthForTests } from "./flux-key-health.ts";

const KEY = "sk-flux-" + "a".repeat(40);
const ok = () => new Response(JSON.stringify({ info: { blocked: false, expires: "2027-01-01T00:00:00Z", max_budget: 10, spend: 1.5 } }), { status: 200 });

describe("Flux key validity through GET /key/info", () => {
  beforeEach(() => resetFluxKeyHealthForTests());

  it("asks /key/info with a Bearer key and reads the info", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    const check = await checkFluxKey(KEY, { fetchImpl, now: 1 });
    expect(check).toEqual({ state: "valid", info: { blocked: false, expires: "2027-01-01T00:00:00Z", maxBudget: 10, spend: 1.5 } });
    expect(fetchImpl.mock.calls[0]![0]).toBe(FLUX_KEY_INFO_URL);
    expect(FLUX_KEY_INFO_URL).toBe("https://api.fluxrouter.ai/key/info");
    expect((fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("caches a valid answer until its lifetime ends", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await checkFluxKey(KEY, { fetchImpl, now: 0 });
    await checkFluxKey(KEY, { fetchImpl, now: KEY_INFO_TTL_MS - 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checkFluxKey(KEY, { fetchImpl, now: KEY_INFO_TTL_MS + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a 401 marks the key invalid, is not asked again inside the backoff, and backs off 1, 5, 15, 15 minutes", async () => {
    expect(KEY_REFUSED_RETRY_MS).toEqual([60_000, 300_000, 900_000]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("no", { status: 401 }));
    expect((await checkFluxKey(KEY, { fetchImpl, now: 0 })).state).toBe("invalid");
    expect(fluxKeyRefused(KEY)).toBe(true);
    await checkFluxKey(KEY, { fetchImpl, now: 59_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checkFluxKey(KEY, { fetchImpl, now: 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await checkFluxKey(KEY, { fetchImpl, now: 60_000 + 299_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await checkFluxKey(KEY, { fetchImpl, now: 360_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await checkFluxKey(KEY, { fetchImpl, now: 360_000 + 899_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await checkFluxKey(KEY, { fetchImpl, now: 360_000 + 900_000 });
    await checkFluxKey(KEY, { fetchImpl, now: 360_000 + 1_800_000 - 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // a different key starts clean
    const other = "sk-flux-" + "b".repeat(40);
    const fine = vi.fn<typeof fetch>(async () => ok());
    expect((await checkFluxKey(other, { fetchImpl: fine, now: 0 })).state).toBe("valid");
    expect(fluxKeyRefused(other)).toBe(false);
  });

  it("a person's Test or key save forces one fresh check past the 401 latch, so a re-enabled key recovers", async () => {
    let status = 401;
    const fetchImpl = vi.fn<typeof fetch>(async () => (status === 401 ? new Response("no", { status }) : ok()));
    expect((await checkFluxKey(KEY, { fetchImpl, now: 0 })).state).toBe("invalid");
    expect((await checkFluxKey(KEY, { fetchImpl, now: 5 })).state).toBe("invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    status = 200;
    requestFluxKeyRecheck();
    expect((await checkFluxKey(KEY, { fetchImpl, now: 10 })).state).toBe("valid");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fluxKeyRefused(KEY)).toBe(false);
    await checkFluxKey(KEY, { fetchImpl, now: 20 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a request already in flight when Check again is pressed never refills the cache; the next check asks fresh", async () => {
    let release!: (response: Response) => void;
    const slow = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
    const before = checkFluxKey(KEY, { fetchImpl: slow, now: 0 });
    requestFluxKeyRecheck();
    const fresh = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ info: { blocked: false, expires: null, max_budget: 10, spend: 9 } }), { status: 200 }));
    const after = checkFluxKey(KEY, { fetchImpl: fresh, now: 1 });
    release(ok());
    expect((await before).state).toBe("valid");
    expect(await after).toMatchObject({ state: "valid", info: { spend: 9 } });
    // One /key/info request in flight per key (flux-key-health.ts): the fresh request starts only once the stale one has ended.
    expect(fresh).toHaveBeenCalledTimes(1);
    const cached = vi.fn<typeof fetch>(async () => ok());
    expect(await checkFluxKey(KEY, { fetchImpl: cached, now: 2 })).toMatchObject({ state: "valid", info: { spend: 9 } });
    expect(cached).not.toHaveBeenCalled();
  });

  it("an answer that lands after Check again does not put the old figure back", async () => {
    let release!: (response: Response) => void;
    const slow = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
    const before = checkFluxKey(KEY, { fetchImpl: slow, now: 0 });
    requestFluxKeyRecheck();
    release(ok());
    await before;
    const fresh = vi.fn<typeof fetch>(async () => ok());
    await checkFluxKey(KEY, { fetchImpl: fresh, now: 1 });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("other failures back off from 1 minute, doubling, to 1 hour", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(fluxRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("down", { status: 503 }));
    expect((await checkFluxKey(KEY, { fetchImpl, now: 0 })).state).toBe("unknown");
    await checkFluxKey(KEY, { fetchImpl, now: 59_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checkFluxKey(KEY, { fetchImpl, now: 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await checkFluxKey(KEY, { fetchImpl, now: 60_000 + 119_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fluxKeyRefused(KEY)).toBe(false);
  });

  it("shares one request between simultaneous callers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await Promise.all([checkFluxKey(KEY, { fetchImpl, now: 0 }), checkFluxKey(KEY, { fetchImpl, now: 0 })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("a 401 that was only a hold does not latch forever", () => {
  beforeEach(() => resetFluxKeyHealthForTests());

  it("a manual check re-probes a held 401 and clears it when Flux now accepts the key", async () => {
    let status = 401;
    const fetchImpl = vi.fn<typeof fetch>(async () => (status === 401 ? new Response("no", { status }) : ok()));
    expect((await checkFluxKey(KEY, { fetchImpl, now: 0 })).state).toBe("invalid");
    expect(fluxKeyRefused(KEY)).toBe(true);
    status = 200;
    expect((await checkFluxKey(KEY, { fetchImpl, now: 5, manual: true })).state).toBe("valid");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fluxKeyRefused(KEY)).toBe(false);
  });

  it("an automatic check clears it once the backoff has passed and Flux accepts the key", async () => {
    let status = 401;
    const fetchImpl = vi.fn<typeof fetch>(async () => (status === 401 ? new Response("no", { status }) : ok()));
    expect((await checkFluxKey(KEY, { fetchImpl, now: 0 })).state).toBe("invalid");
    status = 200;
    expect((await checkFluxKey(KEY, { fetchImpl, now: 30_000 })).state).toBe("invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await checkFluxKey(KEY, { fetchImpl, now: KEY_REFUSED_RETRY_MS[0]! })).state).toBe("valid");
    expect(fluxKeyRefused(KEY)).toBe(false);
  });

  it("a failed re-probe (Flux down) keeps the refusal and the backoff step", async () => {
    let status = 401;
    const fetchImpl = vi.fn<typeof fetch>(async () => (status === 401 ? new Response("no", { status }) : new Response("down", { status: 503 })));
    await checkFluxKey(KEY, { fetchImpl, now: 0 });
    status = 503;
    expect((await checkFluxKey(KEY, { fetchImpl, now: 60_000 })).state).toBe("unknown");
    expect(fluxKeyRefused(KEY)).toBe(true);
  });
});

describe("Flux web search honours the shared refused state", () => {
  it("a 401 latches the key; the next search says refused without a request; Test recovers it", async () => {
    const { searchFlux } = await import("./web-search.ts");
    resetFluxKeyHealthForTests();
    const flux = { baseUrl: "https://api.fluxrouter.ai/v1", apiKey: KEY, query: "q" };
    const refusing = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
    await expect(searchFlux(flux, { fetch: refusing })).rejects.toMatchObject({ code: "auth" });
    expect(fluxKeyRefused(KEY)).toBe(true);
    await expect(searchFlux(flux, { fetch: refusing })).rejects.toMatchObject({ code: "auth" });
    expect(refusing).toHaveBeenCalledTimes(1);
    const fine = vi.fn<typeof fetch>(async () => ok());
    requestFluxKeyRecheck();
    expect((await checkFluxKey(KEY, { fetchImpl: fine, now: 1 })).state).toBe("valid");
    expect(fluxKeyRefused(KEY)).toBe(false);
    const answered = vi.fn<typeof fetch>(async () => Response.json({ answer: "a", citations: ["https://example.com/x"] }));
    await expect(searchFlux(flux, { fetch: answered })).resolves.toMatchObject({ provider: "flux" });
  });
});

describe("catalog refresh asks /key/info first", () => {
  it("never sends a refused key to the catalog route", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ProviderConnectionsService } = await import("./provider-connections.ts");
    resetFluxKeyHealthForTests();
    const catalog = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: "flux-auto" }] })));
    const keyFetch = vi.fn<typeof fetch>(async () => new Response("no", { status: 401 }));
    const service = new ProviderConnectionsService({
      readBank: () => undefined, cacheDir: mkdtempSync(join(tmpdir(), "flux-gate-")), fetch: catalog,
      legacyConnections: () => [{ id: "legacy-flux", preset: "flux", label: "Flux Router", key: KEY, enabled: true, revision: "r1", legacy: true, managedIn: "connections" }],
      keyGate: async connection => { const check = await checkFluxKey(connection.key, { fetchImpl: keyFetch }); return check.state === "invalid" ? "unauthorized" : null; },
    });
    const first = await service.refresh("legacy-flux");
    expect(first.error?.code).toBe("unauthorized");
    await service.refresh("legacy-flux");
    expect(catalog).not.toHaveBeenCalled();
    expect(keyFetch).toHaveBeenCalledTimes(1);
    expect(fluxKeyRefused(KEY)).toBe(true);
  });
});

describe("evidence order for /key/info", () => {
  beforeEach(() => resetFluxKeyHealthForTests());
  const gate = () => { let release!: (response: Response) => void; const response = new Promise<Response>(resolve => { release = resolve; }); return { response, release }; };

  it("a recheck is not answered by a probe that began before it", async () => {
    const old = gate();
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => { calls.push("call"); return calls.length === 1 ? old.response : ok(); });
    const first = checkFluxKey(KEY, { fetchImpl, now: 0 });
    await Promise.resolve();
    requestFluxKeyRecheck();
    const after = checkFluxKey(KEY, { fetchImpl, now: 1_000 });
    // queued behind the old probe, not joined to it
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    old.release(new Response("no", { status: 401 }));
    expect((await first).state).toBe("invalid");
    expect((await after).state).toBe("valid");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // the old 401 wrote nothing: no refusal, no 15 minute wait
    expect(fluxKeyRefused(KEY)).toBe(false);
    expect((await checkFluxKey(KEY, { fetchImpl, now: 2_000 })).state).toBe("valid");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("one fresh probe serves every check after a recheck", async () => {
    const old = gate();
    let n = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => (++n === 1 ? old.response : ok()));
    const first = checkFluxKey(KEY, { fetchImpl, now: 0 });
    await Promise.resolve();
    requestFluxKeyRecheck();
    const a = checkFluxKey(KEY, { fetchImpl, now: 1 });
    const b = checkFluxKey(KEY, { fetchImpl, now: 1 });
    old.release(ok());
    await Promise.all([first, a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a late success does not erase a newer refusal", async () => {
    const slow = gate();
    const fetchImpl = vi.fn<typeof fetch>(async () => slow.response);
    const probe = checkFluxKey(KEY, { fetchImpl, now: 0 });
    await Promise.resolve();
    // a refusal from a request that began after the probe
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused");
    slow.release(ok());
    await probe;
    expect(fluxKeyRefused(KEY)).toBe(true);
    // and the stale answer was not cached for ten minutes
    const again = vi.fn<typeof fetch>(async () => new Response("no", { status: 401 }));
    expect((await checkFluxKey(KEY, { fetchImpl: again, now: 1 })).state).toBe("invalid");
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("a success that began after the refusal still clears it", async () => {
    noteFluxKeyRefused(KEY);
    requestFluxKeyRecheck();
    expect((await checkFluxKey(KEY, { fetchImpl: async () => ok(), now: 0 })).state).toBe("valid");
    expect(fluxKeyRefused(KEY)).toBe(false);
  });
});
