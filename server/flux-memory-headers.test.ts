// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Flux Memory header decision (PROPOSAL-v2 5.4): who gets which headers,
// the kill switch and the latency breaker, the space helper behind its flag,
// and the per-engine renderers. The per-engine spawn assertions live in
// drivers/flux-header-matrix.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertNoForbiddenFluxHeaders,
  claudeCustomHeadersValue,
  codexFluxProviderFor,
  codexHttpHeaderArgs,
  computeFluxSpacePlan,
  describeFluxMemoryDecision,
  FLUX_CALL_SITES,
  FLUX_CODEX_TABLE_HEADERS,
  FLUX_ENGINE_HEADERS,
  FLUX_MEMORY_APP_HEADER,
  FLUX_MEMORY_CAPTURE_HEADER,
  FLUX_MEMORY_INJECT_HEADER,
  FLUX_MEMORY_READ_HEADER,
  FLUX_MEMORY_SPACE_HEADER,
  fluxCallHeaders,
  fluxFetch,
  fluxHeaderRefusal,
  fluxMemoryBreaker,
  FluxMemoryBreaker,
  fluxMemoryContextForTurn,
  fluxMemoryDecision,
  fluxMemorySettings,
  fluxSpaceString,
  fuigoConfigOverlay,
  hermesExtraHeaderLines,
  isFluxUrl,
  opencodeConfigOverlay,
  qwenSettingsJson,
  setFluxMemoryConfig,
  setFluxMemorySettings,
  withFluxCallHeaders,
  type FluxMemorySettings,
} from "./flux-memory-headers.ts";
import { FLUX_SURFACE } from "./flux-routing.ts";

const OFF = { [FLUX_MEMORY_APP_HEADER]: "murage", [FLUX_MEMORY_CAPTURE_HEADER]: "off", [FLUX_MEMORY_INJECT_HEADER]: "off" };
const APP_ONLY = { [FLUX_MEMORY_APP_HEADER]: "murage" };
const BASE: FluxMemorySettings = { killSwitch: false, inject: "on", ownerMemory: "on", spaces: false };

afterEach(() => {
  setFluxMemorySettings({});
  fluxMemoryBreaker.reset();
  vi.restoreAllMocks();
});

describe("who gets which headers", () => {
  const owner = { botId: "b", audience: "owner" as const, decidedOwner: true };

  it("an owner turn sends only the app header (interim: capture and recall on)", () => {
    const d = fluxMemoryDecision(fluxMemoryContextForTurn({ warmIdentity: owner }), { settings: BASE });
    expect(d.headers).toEqual(APP_ONLY);
    expect([d.capture, d.inject, d.reason]).toEqual(["on", "on", "owner"]);
  });

  it.each([
    ["a non-owner turn", { warmIdentity: { botId: "b", audience: "non-owner" as const, decidedOwner: false } }, "non-owner"],
    ["an owner-looking turn nobody proved", { warmIdentity: { botId: "b", audience: "owner" as const, decidedOwner: false } }, "non-owner"],
    ["a background turn on the owner's thread", { background: true, warmIdentity: owner }, "background"],
    ["a turn with no identity", {}, "unknown"],
    ["a prewarm with no identity", { prewarm: true }, "prewarm"],
  ])("%s sends off/off", (_name, turn, reason) => {
    const d = fluxMemoryDecision(fluxMemoryContextForTurn(turn), { settings: BASE });
    expect(d.headers).toEqual(OFF);
    expect(d.reason).toBe(reason);
  });

  it("a prewarm classifies as the thread it warms, so the real turn adopts the process", () => {
    const warm = fluxMemoryDecision(fluxMemoryContextForTurn({ prewarm: true, warmIdentity: owner }), { settings: BASE });
    const real = fluxMemoryDecision(fluxMemoryContextForTurn({ warmIdentity: owner }), { settings: BASE });
    expect(warm.signature).toBe(real.signature);
  });

  it("a bot that asks first, the post-gate owner posture and the kill switch send off/off on the owner's turn", () => {
    const asks = fluxMemoryContextForTurn({ warmIdentity: owner }, { asksFirst: true });
    expect(fluxMemoryDecision(asks, { settings: BASE }).reason).toBe("asks-first");
    const ctx = fluxMemoryContextForTurn({ warmIdentity: owner });
    expect(fluxMemoryDecision(ctx, { settings: { ...BASE, ownerMemory: "off" } }).headers).toEqual(OFF);
    expect(fluxMemoryDecision(ctx, { settings: { ...BASE, killSwitch: true } })).toMatchObject({ headers: OFF, reason: "kill-switch" });
  });

  it("the inject kill switch turns recall off and leaves capture on", () => {
    const d = fluxMemoryDecision(fluxMemoryContextForTurn({ warmIdentity: owner }), { settings: { ...BASE, inject: "off" } });
    expect(d.headers).toEqual({ ...APP_ONLY, [FLUX_MEMORY_INJECT_HEADER]: "off" });
    expect([d.capture, d.inject]).toEqual(["on", "off"]);
  });

  it("settings come from the environment and from the override", () => {
    expect(fluxMemorySettings({})).toEqual(BASE);
    expect(fluxMemorySettings({ MURAGE_FLUX_MEMORY: "off" }).killSwitch).toBe(true);
    expect(fluxMemorySettings({ MURAGE_FLUX_MEMORY_INJECT: "false" }).inject).toBe("off");
    expect(fluxMemorySettings({ MURAGE_FLUX_MEMORY_OWNER: "0" }).ownerMemory).toBe("off");
    expect(fluxMemorySettings({ MURAGE_FLUX_MEMORY_SPACES: "1" }).spaces).toBe(true);
    setFluxMemorySettings({ killSwitch: true });
    expect(fluxMemorySettings({}).killSwitch).toBe(true);
  });

  it("saved config sets the switches, env overrides config, the test override beats both, defaults unchanged", () => {
    try {
      expect(fluxMemorySettings({})).toEqual(BASE);
      setFluxMemoryConfig({ enabled: false, inject: false, owner: false, spaces: true });
      expect(fluxMemorySettings({})).toEqual({ killSwitch: true, inject: "off", ownerMemory: "off", spaces: true });
      // env wins over config, key by key
      expect(fluxMemorySettings({ MURAGE_FLUX_MEMORY: "on", MURAGE_FLUX_MEMORY_SPACES: "0" })).toMatchObject({ killSwitch: false, spaces: false, inject: "off" });
      // an unrecognised env value falls back to config, not to a surprise
      expect(fluxMemorySettings({ MURAGE_FLUX_MEMORY_INJECT: "maybe" }).inject).toBe("off");
      setFluxMemoryConfig({ spaces: false });
      expect(fluxMemorySettings({})).toEqual(BASE);
      setFluxMemoryConfig({ inject: true });
      setFluxMemorySettings({ inject: "off" });
      expect(fluxMemorySettings({}).inject).toBe("off");
    } finally { setFluxMemoryConfig(undefined); setFluxMemorySettings({}); }
  });

  it("the log line carries no header value", () => {
    const line = describeFluxMemoryDecision("claudeAgent", fluxMemoryDecision({ audience: "non-owner" }, { settings: BASE }));
    expect(line).toBe("[flux] memory-headers engine=claudeAgent thread=non-owner capture=off inject=off reason=non-owner");
  });
});

describe("never sent", () => {
  it("refuses the old scope name, required, and any unknown memory header", () => {
    expect(() => assertNoForbiddenFluxHeaders({ "X-Flux-Memory-Scope": "bot" })).toThrow();
    expect(() => assertNoForbiddenFluxHeaders({ "x-flux-memory-required": "true" })).toThrow();
    expect(() => assertNoForbiddenFluxHeaders({ "x-flux-memory-vault": "v" })).toThrow();
    expect(() => assertNoForbiddenFluxHeaders({ ...OFF, [FLUX_MEMORY_SPACE_HEADER]: "bot:abc" })).not.toThrow();
  });

  it("fluxFetch replaces a caller's memory headers and keeps the rest", async () => {
    const seen: Headers[] = [];
    const stub = (async (_url: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response("{}"); }) as typeof fetch;
    await fluxFetch("decider", "https://api.fluxrouter.ai/v1/x", { headers: { authorization: "Bearer k", "x-flux-memory-scope": "bot", "x-flux-memory-inject": "on" } }, stub);
    expect(Object.fromEntries(seen[0]!.entries())).toEqual({ authorization: "Bearer k", ...OFF });
  });

  it("a direct call is background work: off/off, whatever the site", () => {
    for (const site of Object.keys(FLUX_CALL_SITES) as Array<keyof typeof FLUX_CALL_SITES>) expect(fluxCallHeaders(site, { settings: BASE })).toEqual(OFF);
    expect(withFluxCallHeaders("voice-stream", { authorization: "Bearer k", "X-Flux-Memory-Inject": "on" })).toEqual({ authorization: "Bearer k", ...OFF });
  });

  it("knows a Flux host", () => {
    expect(isFluxUrl("https://api.fluxrouter.ai/v1")).toBe(true);
    expect(isFluxUrl("https://api.fluxrouter.ai.evil.example/v1")).toBe(false);
    expect(isFluxUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isFluxUrl(undefined)).toBe(false);
  });
});

describe("spaces, behind a flag that defaults off", () => {
  const SALT = "install-salt";
  const plan = computeFluxSpacePlan({
    salt: SALT,
    write: { kind: "bot-project", bot: "sable", project: "northwind" },
    read: [{ kind: "bot-project", bot: "sable", project: "northwind" }, { kind: "bot", bot: "sable" }, { kind: "project", project: "northwind" }, { kind: "shared" }],
  });
  const ownerCtx = { audience: "owner" as const, spaces: plan };

  it("sends no space header while the flag is off", () => {
    expect(fluxMemoryDecision(ownerCtx, { settings: BASE }).headers).toEqual(APP_ONLY);
  });

  it("sends the write target and the read list when the flag is on and memory is on", () => {
    const d = fluxMemoryDecision(ownerCtx, { settings: { ...BASE, spaces: true } });
    expect(d.headers[FLUX_MEMORY_SPACE_HEADER]).toBe(plan.write);
    expect(d.headers[FLUX_MEMORY_READ_HEADER]).toBe(plan.read.join(","));
    expect(plan.write).toMatch(/^bot:[0-9a-f]{16}#project:[0-9a-f]{16}$/);
    expect(plan.read).toHaveLength(4);
  });

  it("never sends space headers when the request has memory off", () => {
    expect(fluxMemoryDecision({ ...ownerCtx, audience: "non-owner" }, { settings: { ...BASE, spaces: true } }).headers).toEqual(OFF);
    const noRecall = fluxMemoryDecision(ownerCtx, { settings: { ...BASE, spaces: true, inject: "off" } });
    expect(noRecall.headers[FLUX_MEMORY_READ_HEADER]).toBeUndefined();
    expect(noRecall.headers[FLUX_MEMORY_SPACE_HEADER]).toBe(plan.write);
  });

  it("maps the table in 4.3 and keeps names out of the string", () => {
    const s = (ref: Parameters<typeof fluxSpaceString>[0]) => fluxSpaceString(ref, SALT);
    expect(s({ kind: "bot", bot: "sable" })).toMatch(/^bot:[0-9a-f]{16}$/);
    expect(s({ kind: "bot-team", bot: "sable", team: "ops" })).toMatch(/^bot:[0-9a-f]{16}#team:[0-9a-f]{16}$/);
    expect(s({ kind: "project", project: "p" })).toMatch(/^project:/);
    expect(s({ kind: "team", team: "t" })).toMatch(/^team:/);
    expect(s({ kind: "room", room: "r" })).toMatch(/^room:/);
    expect(s({ kind: "shared" })).toBe("you");
    expect(s({ kind: "room", room: "r", withOtherPeople: true })).toBeNull();
    expect(s({ kind: "local-only" })).toBeNull();
    expect(s({ kind: "bot", bot: "sable" })).not.toContain("sable");
    expect(s({ kind: "bot", bot: "sable" })).toBe(fluxSpaceString({ kind: "bot", bot: "sable" }, SALT));
    expect(s({ kind: "bot", bot: "sable" })).not.toBe(fluxSpaceString({ kind: "bot", bot: "sable" }, "other-salt"));
    expect(s({ kind: "bot-project", bot: "x".repeat(500), project: "y".repeat(500) })!.length).toBeLessThanOrEqual(128);
  });

  it("cuts a read list longer than 8 by priority, room reach-backs first", () => {
    const rooms = Array.from({ length: 4 }, (_, i) => ({ kind: "room" as const, room: `r${i}`, reachBack: true }));
    const cut = computeFluxSpacePlan({
      salt: SALT,
      write: null,
      read: [{ kind: "bot", bot: "a" }, ...rooms, ...Array.from({ length: 7 }, (_, i) => ({ kind: "team" as const, team: `t${i}` }))],
    });
    expect(cut.write).toBeNull();
    expect(cut.read).toHaveLength(8);
    expect(cut.read.filter((value) => value.startsWith("room:"))).toHaveLength(0);
    expect(cut.read[0]).toBe(fluxSpaceString({ kind: "bot", bot: "a" }, SALT));
  });

  it("drops local-only spaces and duplicates from the read list", () => {
    const list = computeFluxSpacePlan({ salt: SALT, write: { kind: "local-only" }, read: [{ kind: "shared" }, { kind: "shared" }, { kind: "local-only" }] });
    expect(list).toEqual({ write: null, read: ["you"] });
  });
});

describe("circuit breaker", () => {
  const fill = (breaker: FluxMemoryBreaker, injectOn: boolean, ms: number, n: number) => { for (let i = 0; i < n; i++) breaker.record({ firstTokenMs: ms, injectOn }); };

  it("opens for 15 minutes when first-token p95 is more than 1 s over the no-memory baseline", () => {
    let now = 1_000_000;
    const breaker = new FluxMemoryBreaker({ now: () => now });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fill(breaker, false, 800, 6);
    fill(breaker, true, 1500, 18);
    fill(breaker, true, 2300, 1);
    expect(breaker.isOpen()).toBe(false); // 19 turns: not a full window yet
    fill(breaker, true, 2300, 1);
    expect(breaker.isOpen()).toBe(true);
    const ctx = { audience: "owner" as const };
    const open = fluxMemoryDecision(ctx, { settings: BASE, breaker });
    expect(open.headers).toEqual({ ...APP_ONLY, [FLUX_MEMORY_INJECT_HEADER]: "off" });
    expect(open.reason).toBe("breaker");
    now += 15 * 60_000 - 1;
    expect(breaker.isOpen()).toBe(true);
    now += 2;
    expect(breaker.isOpen()).toBe(false);
    expect(fluxMemoryDecision(ctx, { settings: BASE, breaker }).headers).toEqual(APP_ONLY);
  });

  it("stays closed within a second of the baseline, and without a baseline", () => {
    const within = new FluxMemoryBreaker();
    fill(within, false, 800, 6);
    fill(within, true, 1700, 20);
    expect(within.isOpen()).toBe(false);
    const blind = new FluxMemoryBreaker();
    fill(blind, true, 9000, 20);
    expect(blind.isOpen()).toBe(false);
  });

  it("ignores a sample that is not a duration", () => {
    const breaker = new FluxMemoryBreaker();
    breaker.record({ firstTokenMs: Number.NaN, injectOn: true });
    breaker.record({ firstTokenMs: -5, injectOn: false });
    expect(breaker.isOpen()).toBe(false);
  });
});

describe("what each engine is given", () => {
  it("claude: newline-separated Name: value", () => {
    expect(claudeCustomHeadersValue(OFF)).toBe("x-flux-memory-app: murage\nx-flux-memory-capture: off\nx-flux-memory-inject: off");
  });

  it("codex: three fixed tables, picked by what the decision turns off", () => {
    expect(FLUX_CODEX_TABLE_HEADERS.flux).toEqual(APP_ONLY);
    expect(FLUX_CODEX_TABLE_HEADERS["flux-off"]).toEqual(OFF);
    expect(FLUX_CODEX_TABLE_HEADERS["flux-noinject"]).toEqual({ ...APP_ONLY, [FLUX_MEMORY_INJECT_HEADER]: "off" });
    expect(codexFluxProviderFor(fluxMemoryDecision({ audience: "owner" }, { settings: BASE }))).toBe("flux");
    expect(codexFluxProviderFor(fluxMemoryDecision({ audience: "owner" }, { settings: { ...BASE, inject: "off" } }))).toBe("flux-noinject");
    expect(codexFluxProviderFor(fluxMemoryDecision({ audience: "background" }, { settings: BASE }))).toBe("flux-off");
    expect(codexHttpHeaderArgs("flux-off", OFF)).toEqual([
      "-c", 'model_providers.flux-off.http_headers={ "x-flux-memory-app" = "murage", "x-flux-memory-capture" = "off", "x-flux-memory-inject" = "off" }',
    ]);
  });

  it("fuigo and grok: the global [models].extra_headers overlay, merged over an existing one", () => {
    expect(JSON.parse(fuigoConfigOverlay(OFF))).toEqual({ models: { extra_headers: OFF } });
    const merged = JSON.parse(fuigoConfigOverlay(OFF, JSON.stringify({ models: { extra_headers: { "x-team": "a", "x-flux-memory-inject": "on" }, hidden_models: ["m"] }, features: { a: true } })));
    expect(merged).toEqual({ models: { extra_headers: { "x-team": "a", ...OFF }, hidden_models: ["m"] }, features: { a: true } });
    expect(JSON.parse(fuigoConfigOverlay(OFF, "{not json"))).toEqual({ models: { extra_headers: OFF } });
  });

  it("hermes, qwen and opencode renderers", () => {
    expect(hermesExtraHeaderLines(OFF)).toEqual(["  extra_headers:", '    "x-flux-memory-app": "murage"', '    "x-flux-memory-capture": "off"', '    "x-flux-memory-inject": "off"']);
    expect(JSON.parse(qwenSettingsJson(OFF))).toEqual({ memory: { enableManagedAutoMemory: false }, model: { generationConfig: { customHeaders: OFF } } });
    expect(JSON.parse(qwenSettingsJson())).toEqual({ memory: { enableManagedAutoMemory: false } });
    expect(JSON.parse(opencodeConfigOverlay("flux", OFF))).toEqual({ provider: { flux: { options: { headers: OFF } } } });
    expect(JSON.parse(opencodeConfigOverlay("flux", APP_ONLY, JSON.stringify({ provider: { flux: { options: { headers: { a: "b", "x-flux-memory-inject": "off" }, baseURL: "u" } } } })))).toEqual({ provider: { flux: { options: { headers: { a: "b", ...APP_ONLY }, baseURL: "u" } } } });
  });
});

describe("engine coverage", () => {
  it("every engine that can route through Flux has a header mechanism", () => {
    for (const engine of Object.keys(FLUX_SURFACE)) expect(FLUX_ENGINE_HEADERS[engine], engine).toBeDefined();
  });

  it("an unsupported engine is refused on off headers and left alone on an owner turn", () => {
    const off = fluxMemoryDecision({ audience: "non-owner" }, { settings: BASE });
    const on = fluxMemoryDecision({ audience: "owner" }, { settings: BASE });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(fluxHeaderRefusal("someNewEngine", off)).toMatch(/cannot carry Flux Memory choices/);
    expect(fluxHeaderRefusal("someNewEngine", on)).toBeNull();
    expect(fluxHeaderRefusal("claudeAgent", off)).toBeNull();
  });
});
