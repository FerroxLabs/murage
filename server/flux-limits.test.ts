// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { accountTotal, createFluxSpendReader, fetchFluxLimits, FLUX_KEY_LIMITS_URL, fluxKeyFingerprint, parseFluxLimits, SPEND_CACHE_MS } from "./flux-limits.ts";
import { KNOWN_FRAME_KINDS, scopedConfig } from "./sse-visibility.ts";
import { fluxKeyEpoch, onFluxKeySaved, saveConfig } from "./config.ts";

const ok = { key_id: "k1", key_monthly_budget_usd: null, spent_usd_this_month: 12.4, tokens_this_month: 9, spend_basis: "billed_sale", resets_at: "2026-12-01T00:00:00Z", as_of: "2026-11-04T10:00:00Z" };
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("parseFluxLimits", () => {
  it("reads Flux's own figure and dates", () => {
    expect(parseFluxLimits(ok)).toEqual({ state: "ok", spentUsd: 12.4, asOf: ok.as_of, resetsAt: ok.resets_at, keyBudgetUsd: null });
  });
  it("is pending, never $0, for anything malformed", () => {
    for (const bad of [null, [], {}, { ...ok, spent_usd_this_month: -1 }, { ...ok, spent_usd_this_month: "12" }, { ...ok, spent_usd_this_month: Number.NaN },
      { ...ok, as_of: undefined }, { ...ok, resets_at: "soon" }, { ...ok, spend_basis: "estimate" }, { ...ok, key_monthly_budget_usd: -5 },
      { ...ok, bot_id: "b1" }, { ...ok, bot_spent_usd_this_month: 3 }]) {
      expect(parseFluxLimits(bad)).toEqual({ state: "pending" });
    }
  });
  it("carries the per-bot figure by bot_id", () => {
    expect(parseFluxLimits({ ...ok, bot_id: "b1", bot_spent_usd_this_month: 3.5 })).toMatchObject({ state: "ok", bot: { botId: "b1", spentUsd: 3.5 } });
  });
});

describe("fetchFluxLimits", () => {
  it("calls GET /v1/key/limits with the key and reads 200", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const r = await fetchFluxLimits("sk-flux-abc", (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization") };
      return respond(200, ok);
    }) as unknown as typeof fetch);
    expect(seen).toEqual({ url: FLUX_KEY_LIMITS_URL, auth: "Bearer sk-flux-abc" });
    expect(r.reading.state).toBe("ok");
  });
  it("404, 503 and a network error are pending; 503 honours Retry-After", async () => {
    expect((await fetchFluxLimits("k", (async () => respond(404, { detail: "Not Found" })) as unknown as typeof fetch)).reading).toEqual({ state: "pending" });
    const busy = await fetchFluxLimits("k", (async () => respond(503, { detail: { error: "key_fence_unavailable" } }, { "retry-after": "5" })) as unknown as typeof fetch);
    expect(busy).toEqual({ reading: { state: "pending" }, retryAfterMs: 5000 });
    expect((await fetchFluxLimits("k", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).reading).toEqual({ state: "pending" });
  });
});

describe("accountTotal (the one seam)", () => {
  it("is the key's figure, pending when Flux has none, and no total when a bot is above its rotated key", () => {
    expect(accountTotal(parseFluxLimits(ok))).toMatchObject({ state: "ok", spentUsd: 12.4 });
    expect(accountTotal({ state: "pending" })).toEqual({ state: "pending" });
    expect(accountTotal(parseFluxLimits({ ...ok, spent_usd_this_month: 1, bot_id: "b", bot_spent_usd_this_month: 30 }))).toEqual({ state: "multiKey" });
  });
});

describe("fluxKeyFingerprint", () => {
  it("is a short hash, never the key; any save or a new key changes it; no key has none", () => {
    const fp = fluxKeyFingerprint("sk-flux-secret-1", 0)!;
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain("secret");
    expect(fluxKeyFingerprint("sk-flux-secret-1", 0)).toBe(fp);
    expect(fluxKeyFingerprint("sk-flux-secret-1", 2)).not.toBe(fp);
    expect(fluxKeyFingerprint("sk-flux-secret-2", 0)).not.toBe(fp);
    expect(fluxKeyFingerprint("", 0)).toBeNull();
    expect(fluxKeyFingerprint(null, 3)).toBeNull();
  });
  it("every Flux save bumps the epoch, even with the same key; other saves do not", () => {
    const before = fluxKeyEpoch();
    saveConfig({ language: "" });
    expect(fluxKeyEpoch()).toBe(before);
    saveConfig({ flux: { apiKey: "sk-flux-same" } });
    const once = fluxKeyEpoch();
    expect(once).toBeGreaterThan(before);
    saveConfig({ flux: { apiKey: "sk-flux-same" } });
    expect(fluxKeyEpoch()).toBeGreaterThan(once);
  });
  it("every Flux save, a rollback's included, tells the listener (the server's config frame); other saves do not", () => {
    let told = 0;
    const off = onFluxKeySaved(() => { told++; });
    saveConfig({ language: "" });
    expect(told).toBe(0);
    saveConfig({ flux: { apiKey: "sk-flux-new" } });
    saveConfig({ flux: { apiKey: "sk-flux-old" } });
    expect(told).toBe(2);
    off();
    saveConfig({ flux: { apiKey: "sk-flux-new" } });
    expect(told).toBe(2);
  });
});

describe("createFluxSpendReader (pull only)", () => {
  const rig = (answer: (key: string) => Response | Promise<Response>) => {
    let clock = 1_000_000;
    let calls = 0;
    const live = { key: "sk-flux-old" as string | null, epoch: 0 };
    const reader = createFluxSpendReader({
      key: () => live.key,
      epoch: () => live.epoch,
      now: () => clock,
      fetchImpl: (async (_url: string, init: RequestInit) => { calls++; return answer(String(new Headers(init.headers).get("authorization")).slice(7)); }) as unknown as typeof fetch,
    });
    return { reader, live, tick: (ms: number) => { clock += ms; }, calls: () => calls };
  };

  it("answers the figure with the fingerprint it was read under; caches a minute; a settled turn re-reads", async () => {
    const r = rig(() => respond(200, ok));
    const a = await r.reader.read();
    expect(a).toEqual({ fingerprint: fluxKeyFingerprint("sk-flux-old", 0), total: { state: "ok", spentUsd: 12.4, asOf: ok.as_of, resetsAt: ok.resets_at } });
    expect(r.reader.fingerprint()).toBe(a.fingerprint);
    await r.reader.read();
    expect(r.calls()).toBe(1);
    r.reader.markStale();
    await r.reader.read();
    expect(r.calls()).toBe(2);
    r.tick(SPEND_CACHE_MS);
    await r.reader.read();
    expect(r.calls()).toBe(3);
  });

  it("no key: no fingerprint, pending, never asks Flux", async () => {
    const r = rig(() => respond(200, ok));
    r.live.key = null;
    expect(await r.reader.read()).toEqual({ fingerprint: null, total: { state: "pending" } });
    expect(r.calls()).toBe(0);
  });

  it("404, 503 and malformed are pending, never $0; a 503 holds reads off for Retry-After", async () => {
    for (const res of [() => respond(404, { detail: "Not Found" }), () => respond(200, { ...ok, spent_usd_this_month: null }), () => respond(200, "nope")]) {
      const r = rig(res);
      expect((await r.reader.read()).total).toEqual({ state: "pending" });
    }
    const busy = rig(() => respond(503, { detail: { error: "key_fence_unavailable" } }, { "retry-after": "5" }));
    expect((await busy.reader.read()).total).toEqual({ state: "pending" });
    busy.reader.markStale();
    await busy.reader.read();
    expect(busy.calls()).toBe(1);
    busy.tick(5_001);
    await busy.reader.read();
    expect(busy.calls()).toBe(2);
  });

  it("a key change while Flux is answering: pending under the new fingerprint, never the old key's figure", async () => {
    let release = (): void => {};
    const r = rig((k) => k === "sk-flux-old"
      ? new Promise<Response>((done) => { release = () => done(respond(200, { ...ok, spent_usd_this_month: 99 })); })
      : respond(200, { ...ok, spent_usd_this_month: 1 }));
    const oldFingerprint = r.reader.fingerprint();
    const inFlight = r.reader.read();
    r.live.key = "sk-flux-new"; r.live.epoch = 2;
    release();
    const answer = await inFlight;
    expect(answer.fingerprint).not.toBe(oldFingerprint);
    expect(answer.fingerprint).toBe(r.reader.fingerprint());
    expect(answer.total).toEqual({ state: "pending" });
    // the new key's own read, never the old key's cached or in-flight answer
    expect((await r.reader.read()).total).toMatchObject({ state: "ok", spentUsd: 1 });
  });

  it("the same key saved again: the fingerprint moves and the cached reading is not served", async () => {
    let figure = 50;
    const r = rig(() => respond(200, { ...ok, spent_usd_this_month: figure }));
    const first = await r.reader.read();
    r.live.epoch = 2; figure = 7;
    const second = await r.reader.read();
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.total).toMatchObject({ state: "ok", spentUsd: 7 });
    expect(r.calls()).toBe(2);
  });

  it("a key removed while Flux is answering: no fingerprint, no figure", async () => {
    let release = (): void => {};
    const r = rig(() => new Promise<Response>((done) => { release = () => done(respond(200, ok)); }));
    const inFlight = r.reader.read();
    r.live.key = null; r.live.epoch = 2;
    release();
    expect(await inFlight).toEqual({ fingerprint: null, total: { state: "pending" } });
  });
});

describe("spend reaches the owner's desktop only", () => {
  it("scopedConfig drops spend, and there is no spend frame kind", () => {
    const out = scopedConfig({ profile: {}, vps: {}, spend: { monthlyLimitUsd: 10, headsUpLeft: null, keyFingerprint: "abc" } } as { profile: unknown; vps: unknown; spend: unknown }) as Record<string, unknown>;
    expect(out.spend).toBeUndefined();
    expect((KNOWN_FRAME_KINDS as readonly string[]).includes("spend")).toBe(false);
  });
});
