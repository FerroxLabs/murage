// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLUX_KEY_INFO_URL, FLUX_RETRY_MAX_MS, KEY_INFO_TTL_MS, checkFluxKey, fluxKeyRefused, fluxRetryDelayMs, requestFluxKeyRecheck, resetFluxKeyHealthForTests } from "./flux-key-health.ts";

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

  it("a 401 marks the key invalid once and is never asked again for that key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("no", { status: 401 }));
    expect((await checkFluxKey(KEY, { fetchImpl, now: 0 })).state).toBe("invalid");
    expect(fluxKeyRefused(KEY)).toBe(true);
    await checkFluxKey(KEY, { fetchImpl, now: 10 * FLUX_RETRY_MAX_MS, manual: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
