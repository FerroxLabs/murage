// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra round 4 reproductions (Medium 1, 2, 3, 5, the Fuigo part of 4, and Low 7), each through the real producer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginFluxKeyEvidence, checkFluxKey, fluxKeyRefused, fluxKeyTicketCurrent, reportFluxKeyEvidence, requestFluxKeyRecheck, resetFluxKeyHealthForTests } from "./flux-key-health.ts";
import { DRIVER_KIND as FUIGO_DRIVER_KIND } from "./drivers/acp/fuigo.ts";
import { EventBus } from "./harness/bus.ts";
import { ANY_ADDRESS, instanceAuthFailed, keyRejected, resetKeyRejectionsForTests } from "./key-rejections.ts";
import { ProviderConnectionsService } from "./provider-connections.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { searchFlux } from "./web-search.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener } from "./contracts.ts";

const KEY = "sk-flux-" + "e".repeat(40);
const ADDRESS = "https://api.fluxrouter.ai/v1";
const roots: string[] = [];
beforeEach(() => { resetFluxKeyHealthForTests(); resetKeyRejectionsForTests(); });
afterEach(() => { roots.splice(0).forEach(root => removeTempDirSync(root)); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const gate = () => { let release!: (response: Response) => void; const response = new Promise<Response>(resolve => { release = resolve; }); return { response, release }; };
const keyOk = () => new Response(JSON.stringify({ info: { blocked: false, expires: null, max_budget: null, spend: null } }), { status: 200 });
const refuse = () => new Response("no", { status: 401 });
const chat = { flux: false, scope: ADDRESS };

describe("Medium 1: each state has its own order", () => {
  it("successful chats that overtake successful key probes do not leave the refusal latched", async () => {
    const refused = beginFluxKeyEvidence(KEY);
    reportFluxKeyEvidence(refused, KEY, "refused");
    expect(fluxKeyRefused(KEY)).toBe(true);
    for (let round = 0; round < 3; round++) {
      requestFluxKeyRecheck();
      const g = gate();
      const probe = checkFluxKey(KEY, { fetchImpl: async () => g.response, manual: true });
      await tick();
      const chatTicket = beginFluxKeyEvidence(KEY); // begun after the probe
      reportFluxKeyEvidence(chatTicket, KEY, "accepted", chat); // a chat success finishes first
      g.release(keyOk());
      expect((await probe).state).toBe("valid");
      expect(fluxKeyRefused(KEY)).toBe(false);
      if (round < 2) reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused");
    }
  });
  it("a chat success clears the engine rejection even when a recheck happened while it ran", () => {
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused", chat);
    expect(keyRejected(ADDRESS, KEY)).toBe(true);
    for (let round = 0; round < 3; round++) {
      const running = beginFluxKeyEvidence(KEY);
      requestFluxKeyRecheck();
      expect(fluxKeyTicketCurrent(running)).toBe(false);
      reportFluxKeyEvidence(running, KEY, "accepted", chat);
      expect(keyRejected(ADDRESS, KEY)).toBe(false);
      reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused", chat);
    }
  });
  it("a refusal from before a recheck is still ignored", () => {
    const old = beginFluxKeyEvidence(KEY);
    requestFluxKeyRecheck();
    expect(reportFluxKeyEvidence(old, KEY, "refused", chat)).toBe(false);
    expect(keyRejected(ADDRESS, KEY)).toBe(false);
  });
});

function service(modelsFetch: typeof fetch, keyFetch: typeof fetch, rows: () => unknown[]) {
  const cacheDir = mkdtempSync(join(tmpdir(), "flux-r5-")); roots.push(cacheDir);
  return new ProviderConnectionsService({
    readBank: () => "[]", cacheDir, fetch: modelsFetch,
    legacyConnections: () => rows() as never,
    keyGate: async connection => { if (connection.id !== "legacy-flux") return null; const check = await checkFluxKey(KEY, { fetchImpl: keyFetch }); return check.state === "invalid" ? "unauthorized" : null; },
    beginEvidence: beginFluxKeyEvidence, evidenceCurrent: fluxKeyTicketCurrent,
    onCatalogOutcome: (connection, outcome, code, ticket) => {
      const scope = outcome === "ok" || code !== "forbidden" ? ANY_ADDRESS : undefined;
      reportFluxKeyEvidence(ticket ?? beginFluxKeyEvidence(connection.key), connection.key, outcome === "ok" ? "accepted" : "refused", { flux: connection.id === "legacy-flux", ...(scope === undefined ? {} : { scope }) });
    },
  });
}
const fluxRow = () => ({ id: "legacy-flux", preset: "flux", label: "Flux Router", key: KEY, enabled: true, revision: "r1", legacy: true, managedIn: "connections" });

describe("Medium 2: a key-gate refusal marks the engine key rejected", () => {
  it("the probe's 401 stops the refresh and the engine shows the key rejected", async () => {
    const svc = service(async () => { throw new Error("must not be asked"); }, async () => refuse(), () => [fluxRow()]);
    const catalog = await svc.refresh("legacy-flux");
    expect(catalog.error?.code).toBe("unauthorized");
    expect(fluxKeyRefused(KEY)).toBe(true);
    expect(keyRejected(ADDRESS, KEY)).toBe(true);
  });
});

describe("Medium 3: a successful search reports acceptance", () => {
  it("a newer successful search outranks an older one that later fails with 401", async () => {
    const a = gate();
    let calls = 0;
    const fetch = (async () => {
      calls++;
      if (calls === 1) return a.response;
      return new Response(JSON.stringify({ answer: "yes", citations: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const input = { baseUrl: ADDRESS, apiKey: KEY, query: "q" };
    const first = searchFlux(input, { fetch });
    await tick();
    await searchFlux(input, { fetch });
    a.release(refuse());
    await expect(first).rejects.toBeTruthy();
    expect(fluxKeyRefused(KEY)).toBe(false);
  });
});

describe("Medium 5: eviction keeps what still matters", () => {
  const other = (n: number) => "sk-flux-" + String(n).padStart(40, "0");
  it("an active refusal survives 300 other keys", () => {
    reportFluxKeyEvidence(beginFluxKeyEvidence(KEY), KEY, "refused");
    for (let n = 0; n < 300; n++) reportFluxKeyEvidence(beginFluxKeyEvidence(other(n)), other(n), n % 2 ? "refused" : "accepted");
    expect(fluxKeyRefused(KEY)).toBe(true);
    for (let n = 0; n < 40; n++) reportFluxKeyEvidence(beginFluxKeyEvidence(other(1000 + n)), other(1000 + n), "refused");
    expect(fluxKeyRefused(KEY)).toBe(true);
  });
  it("a key with a request in flight keeps its order while others are evicted", () => {
    const older = beginFluxKeyEvidence(KEY);
    const newer = beginFluxKeyEvidence(KEY);
    expect(reportFluxKeyEvidence(newer, KEY, "accepted")).toBe(true);
    for (let n = 0; n < 300; n++) reportFluxKeyEvidence(beginFluxKeyEvidence(other(n)), other(n), "accepted");
    expect(reportFluxKeyEvidence(older, KEY, "refused")).toBe(false);
    expect(fluxKeyRefused(KEY)).toBe(false);
  });
});

describe("Fuigo auth failure (base behaviour; scoped version is FLUX-EVIDENCE-R5-DEFERRED-1017)", () => {
  it("a real Fuigo 401 after an unrelated provider's catalog acceptance marks the instance unauthenticated", async () => {
    let listener: RuntimeEventListener | null = null;
    const instance = { instanceId: "fuigo-p", driverKind: FUIGO_DRIVER_KIND, displayName: "x", enabled: true, models: { default: "m", options: [] }, adapter: { provider: FUIGO_DRIVER_KIND, onEvent: (l: RuntimeEventListener) => { listener = l; return () => {}; } } } as unknown as ProviderInstance;
    new EventBus(() => {}).attach([instance]);
    const emit = (event: Partial<RuntimeEvent>) => listener?.({ eventId: "e", provider: FUIGO_DRIVER_KIND, threadId: "t", turnId: "u", ...event } as unknown as RuntimeEvent);
    expect(FUIGO_DRIVER_KIND).toBe("fuigoAgent");
    emit({ type: "turn.started" });
    requestFluxKeyRecheck();
    await checkFluxKey(KEY, { fetchImpl: async () => keyOk(), manual: true });
    emit({ type: "runtime.error", message: "Invalid API key (401)" });
    expect(instanceAuthFailed("fuigo-p")).toBe(true);
  });
});

describe("Round 6", () => {
  it("Medium 2: probe A 401, then search B success: no cached invalid, no relatch", async () => {
    const a = gate(), b = gate();
    const probe = checkFluxKey(KEY, { fetchImpl: async () => a.response, manual: true });
    await tick();
    const search = searchFlux({ baseUrl: ADDRESS, apiKey: KEY, query: "q" }, { fetch: (async () => b.response) as unknown as typeof globalThis.fetch });
    await tick();
    a.release(refuse());
    expect((await probe).state).toBe("invalid");
    b.release(new Response(JSON.stringify({ answer: "yes", citations: [] }), { status: 200 }));
    await search;
    expect(fluxKeyRefused(KEY)).toBe(false);
    let calls = 0;
    const again = await checkFluxKey(KEY, { fetchImpl: async () => { calls++; return keyOk(); } });
    expect(again.state).not.toBe("invalid");
    expect(calls).toBe(1);
    expect(fluxKeyRefused(KEY)).toBe(false);
  });
});

describe("Low 7: replaced connections leave no owner entry", () => {
  it("fifty replaced connections keep the owner map small", async () => {
    let id = "legacy-x0";
    const svc = service(async () => new Response(JSON.stringify({ data: [{ id: "m1" }] })), async () => keyOk(), () => [{ id, preset: "openai", label: "x", key: "sk-" + "a".repeat(40), enabled: true, revision: id, legacy: true, managedIn: "engines" }]);
    for (let n = 0; n < 50; n++) { id = "legacy-x" + n; await svc.refresh(id); }
    expect((svc as unknown as { owner: Map<string, symbol> }).owner.size).toBeLessThanOrEqual(2);
  });
});
