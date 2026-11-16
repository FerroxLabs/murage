// SPDX-License-Identifier: AGPL-3.0-or-later
// A catalog refresh carries the recheck order it began under: a request after a recheck never joins an older refresh, and an older
// answer neither reinstates a refusal the fresh probe declined nor erases a newer one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginFluxKeyEvidence, checkFluxKey, fluxKeyRefused, fluxKeyTicketCurrent, reportFluxKeyEvidence, requestFluxKeyRecheck, resetFluxKeyHealthForTests } from "./flux-key-health.ts";
import { ProviderConnectionsService } from "./provider-connections.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const KEY = "sk-flux-" + "b".repeat(40);
const roots: string[] = [];
beforeEach(() => resetFluxKeyHealthForTests());
afterEach(() => { roots.splice(0).forEach(root => removeTempDirSync(root)); });
const gate = () => { let release!: (response: Response) => void; const response = new Promise<Response>(resolve => { release = resolve; }); return { response, release }; };
const keyOk = () => new Response(JSON.stringify({ info: { blocked: false, expires: null, max_budget: null, spend: null } }), { status: 200 });
const models = () => new Response(JSON.stringify({ data: [{ id: "flux-auto", name: "Auto" }] }));

/** The same wiring server/index.ts gives the Flux connection. */
function service(options: { keyFetch: typeof fetch; modelsFetch: typeof fetch }) {
  const cacheDir = mkdtempSync(join(tmpdir(), "flux-order-")); roots.push(cacheDir);
  return new ProviderConnectionsService({
    readBank: () => "[]", cacheDir, fetch: options.modelsFetch,
    legacyConnections: () => [{ id: "legacy-flux", preset: "flux", label: "Flux Router", key: KEY, enabled: true, revision: "r1", legacy: true, managedIn: "flux" } as never],
    keyGate: async () => { const check = await checkFluxKey(KEY, { fetchImpl: options.keyFetch }); return check.state === "invalid" ? "unauthorized" : null; },
    beginEvidence: beginFluxKeyEvidence, evidenceCurrent: fluxKeyTicketCurrent,
    onCatalogOutcome: (_connection, outcome, _code, ticket) => { reportFluxKeyEvidence(ticket ?? beginFluxKeyEvidence(KEY), KEY, outcome === "ok" ? "accepted" : "refused"); },
  });
}

describe("catalog refreshes and the recheck order", () => {
  it("a manual Test after a recheck is not answered by a refresh that began before it", async () => {
    const old = gate();
    let probes = 0;
    const keyFetch = vi.fn<typeof fetch>(async () => (++probes === 1 ? old.response : keyOk()));
    const svc = service({ keyFetch, modelsFetch: vi.fn<typeof fetch>(async () => models()) });
    const first = svc.refresh("legacy-flux");
    await new Promise(resolve => setTimeout(resolve, 0));
    requestFluxKeyRecheck();
    const manual = svc.refresh("legacy-flux");
    old.release(new Response("no", { status: 401 }));
    const [stale, fresh] = await Promise.all([first, manual]);
    expect(fresh.error).toBeUndefined();
    expect(fresh.models.length).toBe(1);
    expect(keyFetch).toHaveBeenCalledTimes(2);
    // the obsolete refresh's refusal was not reinstated, and it reports the catalog as it now stands
    expect(stale.error).toBeUndefined();
    expect(fluxKeyRefused(KEY)).toBe(false);
  });

  it("an older catalog success does not erase a newer refusal", async () => {
    const slow = gate();
    const svc = service({ keyFetch: async () => keyOk(), modelsFetch: vi.fn<typeof fetch>(async () => slow.response) });
    const first = svc.refresh("legacy-flux");
    await new Promise(resolve => setTimeout(resolve, 0));
    requestFluxKeyRecheck();
    expect((await checkFluxKey(KEY, { fetchImpl: async () => new Response("no", { status: 401 }), now: 0 })).state).toBe("invalid");
    expect(fluxKeyRefused(KEY)).toBe(true);
    slow.release(models());
    await first;
    expect(fluxKeyRefused(KEY)).toBe(true);
  });

  it("an acceptance needs its ordering token", () => {
    const early = beginFluxKeyEvidence(KEY);
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused");
    reportFluxKeyEvidence(early, KEY, "accepted");
    expect(fluxKeyRefused(KEY)).toBe(true);
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "accepted");
    expect(fluxKeyRefused(KEY)).toBe(false);
  });
});
