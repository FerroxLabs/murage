// SPDX-License-Identifier: AGPL-3.0-or-later
// Key evidence (accepted or refused) reaches Murage from many paths. One rule orders all of them (server/flux-key-health.ts):
// a ticket is taken when the request starts; its report counts only if no recheck happened since and no newer evidence for the
// same key was applied. These are Astra round 1 to 3 reproductions, each through the real producer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginFluxKeyEvidence, checkFluxKey, fluxKeyRefused, fluxKeyTicketCurrent, reportFluxKeyEvidence, requestFluxKeyRecheck, resetFluxKeyHealthForTests } from "./flux-key-health.ts";
import { ANY_ADDRESS, keyRejected, resetKeyRejectionsForTests } from "./key-rejections.ts";
import { ProviderConnectionsService } from "./provider-connections.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { searchFlux } from "./web-search.ts";

const KEY = "sk-flux-" + "c".repeat(40);
const OTHER = "sk-flux-" + "d".repeat(40);
const ADDRESS = "https://api.fluxrouter.ai/v1";
const roots: string[] = [];
beforeEach(() => { resetFluxKeyHealthForTests(); resetKeyRejectionsForTests(); });
afterEach(() => { roots.splice(0).forEach(root => removeTempDirSync(root)); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gate = () => { let release!: (response: Response) => void; const response = new Promise<Response>(resolve => { release = resolve; }); return { response, release }; };
const keyOk = () => new Response(JSON.stringify({ info: { blocked: false, expires: null, max_budget: null, spend: null } }), { status: 200 });
const models = () => new Response(JSON.stringify({ data: [{ id: "flux-auto", name: "Auto" }] }));
const refuse = () => new Response("no", { status: 401 });

/** The wiring server/index.ts gives the Flux connection. */
function service(modelsFetch: typeof fetch, keyFetch: typeof fetch = async () => keyOk()) {
  const cacheDir = mkdtempSync(join(tmpdir(), "flux-evidence-")); roots.push(cacheDir);
  return new ProviderConnectionsService({
    readBank: () => "[]", cacheDir, fetch: modelsFetch,
    legacyConnections: () => [{ id: "legacy-flux", preset: "flux", label: "Flux Router", key: KEY, enabled: true, revision: "r1", legacy: true, managedIn: "flux" } as never],
    keyGate: async () => { const check = await checkFluxKey(KEY, { fetchImpl: keyFetch }); return check.state === "invalid" ? "unauthorized" : null; },
    beginEvidence: beginFluxKeyEvidence, evidenceCurrent: fluxKeyTicketCurrent,
    onCatalogOutcome: (connection, outcome, code, ticket) => {
      const scope = outcome === "ok" || code !== "forbidden" ? ANY_ADDRESS : undefined;
      reportFluxKeyEvidence(ticket ?? beginFluxKeyEvidence(connection.key), connection.key, outcome === "ok" ? "accepted" : "refused", { flux: true, ...(scope === undefined ? {} : { scope }) });
    },
  });
}

describe("the evidence rule", () => {
  it("an older request never overrides a newer one for the same key, in either order", () => {
    const older = beginFluxKeyEvidence(KEY); const newer = beginFluxKeyEvidence(KEY);
    expect(reportFluxKeyEvidence(newer, KEY, "refused")).toBe(true);
    expect(reportFluxKeyEvidence(older, KEY, "accepted")).toBe(false);
    expect(fluxKeyRefused(KEY)).toBe(true);
    const a = beginFluxKeyEvidence(KEY); const b = beginFluxKeyEvidence(KEY);
    expect(reportFluxKeyEvidence(a, KEY, "accepted")).toBe(true);
    expect(reportFluxKeyEvidence(b, KEY, "refused")).toBe(true);
    expect(fluxKeyRefused(KEY)).toBe(true);
  });
  it("a recheck since the request began voids its evidence", () => {
    const ticket = beginFluxKeyEvidence(KEY);
    requestFluxKeyRecheck();
    expect(reportFluxKeyEvidence(ticket, KEY, "refused")).toBe(false);
    expect(fluxKeyRefused(KEY)).toBe(false);
  });
  it("state is kept per key: evidence about one key never touches another", () => {
    const first = beginFluxKeyEvidence(KEY); const second = beginFluxKeyEvidence(OTHER);
    reportFluxKeyEvidence(second, OTHER, "refused");
    reportFluxKeyEvidence(first, KEY, "refused");
    expect(fluxKeyRefused(KEY) && fluxKeyRefused(OTHER)).toBe(true);
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "accepted");
    expect(fluxKeyRefused(KEY)).toBe(false);
    expect(fluxKeyRefused(OTHER)).toBe(true);
  });
  it("a ticket for one key cannot be spent on another", () => {
    expect(reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), OTHER, "refused")).toBe(false);
    expect(fluxKeyRefused(OTHER)).toBe(false);
  });
});

describe("Astra round 3", () => {
  it("2: an older catalog success does not clear a newer engine key rejection", async () => {
    const slow = gate();
    const svc = service(vi.fn<typeof fetch>(async () => slow.response));
    const refresh = svc.refresh("legacy-flux");
    await tick();
    // a chat turn that began after the catalog request was refused
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused", { flux: false, scope: ADDRESS });
    expect(keyRejected(ADDRESS, KEY)).toBe(true);
    slow.release(models());
    await refresh;
    expect(keyRejected(ADDRESS, KEY)).toBe(true);
  });

  it("3: an obsolete 401 does not overwrite a newer successful catalog", async () => {
    const old = gate(); let calls = 0;
    const svc = service(vi.fn<typeof fetch>(async () => (++calls === 1 ? old.response : models())));
    const first = svc.refresh("legacy-flux");
    await tick();
    requestFluxKeyRecheck();
    const fresh = await svc.refresh("legacy-flux");
    expect(fresh.error).toBeUndefined();
    old.release(refuse());
    await first;
    const row = svc.list().find(item => item.id === "legacy-flux")!;
    expect(row.catalog.error).toBeUndefined();
    expect(row.catalog.models.length).toBe(1);
    expect(row.state).toBe("catalog-ready");
    expect(fluxKeyRefused(KEY)).toBe(false);
  });

  it("3 (reverse): an obsolete success does not replace a newer catalog error, in memory or on disk", async () => {
    const old = gate(); let calls = 0;
    const svc = service(vi.fn<typeof fetch>(async () => (++calls === 1 ? old.response : refuse())));
    const first = svc.refresh("legacy-flux");
    await tick();
    requestFluxKeyRecheck();
    expect((await svc.refresh("legacy-flux")).error?.code).toBe("unauthorized");
    old.release(models());
    await first;
    expect(svc.list().find(item => item.id === "legacy-flux")!.catalog.error?.code).toBe("unauthorized");
    expect(fluxKeyRefused(KEY)).toBe(true);
  });

  it("4: a web search that began before a recheck cannot re-refuse the key", async () => {
    const search = gate();
    const pending = searchFlux({ baseUrl: "https://api.fluxrouter.ai/v1", apiKey: KEY, query: "weather" }, { fetch: vi.fn<typeof fetch>(async () => search.response) }).catch(error => error);
    await tick();
    requestFluxKeyRecheck();
    expect((await checkFluxKey(KEY, { fetchImpl: async () => keyOk(), now: 1 })).state).toBe("valid");
    search.release(refuse());
    await pending;
    expect(fluxKeyRefused(KEY)).toBe(false);
    expect((await checkFluxKey(KEY, { fetchImpl: async () => keyOk(), now: 2 })).state).toBe("valid");
  });

  it("4: a late search refusal for a replaced key does not erase the current key's refusal", async () => {
    const search = gate();
    const pending = searchFlux({ baseUrl: "https://api.fluxrouter.ai/v1", apiKey: KEY, query: "weather" }, { fetch: vi.fn<typeof fetch>(async () => search.response) }).catch(error => error);
    await tick();
    expect((await checkFluxKey(OTHER, { fetchImpl: async () => refuse(), now: 0 })).state).toBe("invalid");
    search.release(refuse());
    await pending;
    expect(fluxKeyRefused(OTHER)).toBe(true);
    expect(fluxKeyRefused(KEY)).toBe(true);
    // the current key's next failed probe still reads as refused
    expect((await checkFluxKey(OTHER, { fetchImpl: async () => refuse(), now: 1, manual: true })).state).toBe("invalid");
    expect(fluxKeyRefused(OTHER)).toBe(true);
  });
});
