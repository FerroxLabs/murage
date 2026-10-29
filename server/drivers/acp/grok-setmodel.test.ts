// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GROK-SETMODEL-1010 (design r3): a fresh Grok scope pins the chosen model on the first turn, or fails with a next step.
// The owner's model list cache seeds a scope that has none (and follows the owner's deletion, across login generations);
// a refused pin of a subscription catalog model waits once, bounded, for grok's own catalog announcement and pins again;
// everything else fails at once; session.started never names a model whose pin failed. Never another model.
// Synthetic homes and the fake ACP CLI only.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The core reads its per-request settings timeout once, at load: short here so the stalled pin (T5) ends quickly.
vi.hoisted(() => { process.env.MURAGE_ACP_SESSION_CONFIG_MS = "1000"; });

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { resetIsolationCache } from "../isolation-cache.ts";
import { SCOPE_MARKER } from "../scoped-cli-home.ts";
import { acpModelIdsIn, type AcpSessionContext } from "./core.ts";
import { createCursorAgentDriver } from "./cursor.ts";
import { GROK_MODELS_CACHE, grokModelsCacheSeed, scopeGrokHome } from "./grok-scope.ts";
import {
  configureGrokSession, grokModelErrorLine, grokModelOrigin, grokModelsTimeoutLine, grokModelUnlistedLine, GrokAgentDriver, GROK_MODELS_WAIT_TITLE,
} from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) removeTempDirSync(home);
  delete process.env.MURAGE_GROK_MODELS_WAIT_MS;
});

const CACHE_47 = { models: { "grok-4.7": { id: "grok-4.7" }, "grok-4.6": { id: "grok-4.6" } } };

function ownerHome(opts: { cache?: unknown; config?: string } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-setmodel-"));
  homes.push(home);
  const grok = join(home, ".grok");
  mkdirSync(grok, { recursive: true });
  writeFileSync(join(grok, "config.toml"), opts.config ?? '[models]\ndefault = "grok-4.7"\n');
  writeFileSync(join(grok, "auth.json"), "{}");
  if (opts.cache !== undefined) writeFileSync(join(grok, GROK_MODELS_CACHE), typeof opts.cache === "string" ? opts.cache : JSON.stringify(opts.cache));
  return home;
}

/** Build (or rebuild) the bot's scope the way a turn does; returns the engine home (the current login generation). */
function build(home: string, botId = "bot-seed"): string {
  resetIsolationCache();
  const env: Record<string, string | undefined> = { HOME: home };
  scopeGrokHome(env, "grok 1.0.70", botId);
  return env.GROK_HOME!;
}
const scopeRoot = (engineHome: string) => engineHome.replace(/[\\/]login-g\d+$/, "");
const marker = (engineHome: string) => JSON.parse(readFileSync(join(scopeRoot(engineHome), SCOPE_MARKER), "utf8")) as { seeded?: Record<string, string>; deletedGenerated?: string[]; generation?: number };

describe("S: the owner's model list cache seeds a scope that has none", () => {
  it("S1 lands byte for byte once, records its sha, and never replaces what is there", () => {
    ensureDirs();
    const home = ownerHome({ cache: CACHE_47 });
    const owner = join(home, ".grok", GROK_MODELS_CACHE);
    const gh = build(home);
    const scoped = join(gh, GROK_MODELS_CACHE);
    expect(lstatSync(scoped).isFile()).toBe(true);
    expect(lstatSync(scoped).isSymbolicLink()).toBe(false);
    expect(readFileSync(scoped, "utf8")).toBe(readFileSync(owner, "utf8"));
    expect(Object.keys(marker(gh).seeded ?? {})).toEqual([GROK_MODELS_CACHE]);
    // the owner's file changes: the scope's copy is grok's to refresh, never rewritten by Murage
    writeFileSync(owner, JSON.stringify({ models: { "grok-4.8": {} } }));
    build(home);
    expect(readFileSync(scoped, "utf8")).toBe(JSON.stringify(CACHE_47));
    // grok rewrote the scope's file: never touched, and a write in the scope never reaches the owner's
    writeFileSync(scoped, JSON.stringify({ models: { "grok-4.9": {} } }));
    build(home);
    expect(JSON.parse(readFileSync(scoped, "utf8"))).toEqual({ models: { "grok-4.9": {} } });
    expect(JSON.parse(readFileSync(owner, "utf8"))).toEqual({ models: { "grok-4.8": {} } });
  });

  it("S2 guards: no link followed; not JSON, no models, over 4 MB skipped; a scope file already there survives", () => {
    ensureDirs();
    const home = ownerHome();
    const grok = join(home, ".grok");
    const elsewhere = join(home, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ models: { secret: {} } }));
    let linked = true;
    try { symlinkSync(elsewhere, join(grok, GROK_MODELS_CACHE)); } catch { linked = false; } // Windows without symlink rights
    if (linked) { expect(grokModelsCacheSeed(grok)).toEqual({}); rmSync(join(grok, GROK_MODELS_CACHE)); }
    writeFileSync(join(grok, GROK_MODELS_CACHE), "not json");
    expect(grokModelsCacheSeed(grok)).toEqual({});
    writeFileSync(join(grok, GROK_MODELS_CACHE), JSON.stringify({ fetched_at: 1 }));
    expect(grokModelsCacheSeed(grok)).toEqual({});
    writeFileSync(join(grok, GROK_MODELS_CACHE), JSON.stringify({ models: {}, pad: "x".repeat(4 * 1024 * 1024) }));
    expect(grokModelsCacheSeed(grok)).toEqual({});
    expect(grokModelsCacheSeed(join(home, "missing"))).toEqual({});
    rmSync(join(grok, GROK_MODELS_CACHE));
    // a scope whose grok already wrote its own cache: the owner's appearing later never replaces it (EEXIST path)
    const gh = build(home);
    writeFileSync(join(gh, GROK_MODELS_CACHE), JSON.stringify({ models: { "grok-own": {} } }));
    writeFileSync(join(grok, GROK_MODELS_CACHE), JSON.stringify(CACHE_47));
    build(home);
    expect(JSON.parse(readFileSync(join(gh, GROK_MODELS_CACHE), "utf8"))).toEqual({ models: { "grok-own": {} } });
    expect(marker(gh).seeded ?? {}).toEqual({});
  });

  it("S3 Rule 6: the owner's file removed takes our unchanged copy with it, keeps a rewritten one, and re-seeds when it returns", () => {
    ensureDirs();
    const home = ownerHome({ cache: CACHE_47 });
    const owner = join(home, ".grok", GROK_MODELS_CACHE);
    const gh = build(home, "bot-r6");
    rmSync(owner);
    build(home, "bot-r6");
    expect(existsSync(join(gh, GROK_MODELS_CACHE))).toBe(false);
    expect(marker(gh).seeded ?? {}).toEqual({});
    expect(marker(gh).deletedGenerated).toContain(GROK_MODELS_CACHE);
    // the owner's comes back: an absent scope is seeded again and leaves the deletion record
    writeFileSync(owner, JSON.stringify(CACHE_47));
    build(home, "bot-r6");
    expect(readFileSync(join(gh, GROK_MODELS_CACHE), "utf8")).toBe(JSON.stringify(CACHE_47));
    expect(marker(gh).deletedGenerated ?? []).not.toContain(GROK_MODELS_CACHE);
    // grok rewrote it, then the owner's goes: grok's own state stays, the entry is cleared
    writeFileSync(join(gh, GROK_MODELS_CACHE), JSON.stringify({ models: { "grok-4.9": {} } }));
    rmSync(owner);
    build(home, "bot-r6");
    expect(JSON.parse(readFileSync(join(gh, GROK_MODELS_CACHE), "utf8"))).toEqual({ models: { "grok-4.9": {} } });
    expect(marker(gh).seeded ?? {}).toEqual({});
  });

  it("S4 a deleted seed stays deleted through a rebuild and a login-generation rotation (no carry from an older generation)", () => {
    ensureDirs();
    const home = ownerHome({ cache: CACHE_47 });
    const owner = join(home, ".grok", GROK_MODELS_CACHE);
    const g0 = build(home, "bot-rot");
    expect(existsSync(join(g0, GROK_MODELS_CACHE))).toBe(true);
    // the scope's login goes missing: the next launch moves to a new generation, carrying the scope's state (the seed among it)
    rmSync(join(g0, "auth.json"));
    const g1 = build(home, "bot-rot");
    expect(g1).not.toBe(g0);
    expect(existsSync(join(g1, GROK_MODELS_CACHE))).toBe(true);
    // the owner deletes theirs: the copy leaves the current generation; the older generation keeps its preserved copy (never written)
    rmSync(owner);
    expect(build(home, "bot-rot")).toBe(g1);
    expect(existsSync(join(g1, GROK_MODELS_CACHE))).toBe(false);
    expect(existsSync(join(g0, GROK_MODELS_CACHE))).toBe(true);
    // a rebuild carries the older generations' entries in again; never this one
    build(home, "bot-rot");
    expect(existsSync(join(g1, GROK_MODELS_CACHE))).toBe(false);
    // nor a rotation
    rmSync(join(g1, "auth.json"));
    const g2 = build(home, "bot-rot");
    expect(g2).not.toBe(g1);
    expect(existsSync(join(g2, GROK_MODELS_CACHE))).toBe(false);
    // the owner's returns: seeded fresh into the current generation
    writeFileSync(owner, JSON.stringify(CACHE_47));
    build(home, "bot-rot");
    expect(lstatSync(join(g2, GROK_MODELS_CACHE)).isFile()).toBe(true);
    expect(marker(g2).deletedGenerated ?? []).not.toContain(GROK_MODELS_CACHE);
  });
});

describe("model origin is carried, never guessed from the name", () => {
  it("provider, local, custom (also a block named like a built-in), catalog, unknown", () => {
    const home = ownerHome({ config: '[model.grok-local]\nname = "Local"\n\n[model."grok-4.7"]\nmodel = "mine"\nbase_url = "http://127.0.0.1:1/v1"\n' });
    const env = { HOME: home, GROK_HOME: join(home, ".grok") };
    expect(grokModelOrigin({ model: "grok-4.7", providerRoute: {} }, env)).toBe("provider");
    expect(grokModelOrigin({ requestedModel: "ollama::qwen3", model: "ollama-qwen3" }, env)).toBe("local");
    expect(grokModelOrigin({ model: "grok-local" }, env)).toBe("custom");
    expect(grokModelOrigin({ model: "grok-4.7" }, env)).toBe("custom");
    expect(grokModelOrigin({ model: "grok-4.6" }, env)).toBe("catalog");
    expect(grokModelOrigin({ model: "grok-typed-9" }, env)).toBe("unknown");
    expect(grokModelOrigin({ model: "grok-4.7" }, { HOME: ownerHome(), GROK_HOME: join(homes.at(-1)!, ".grok") })).toBe("catalog");
  });

  it("reads the model ids of a catalog announcement, top level only", () => {
    expect(acpModelIdsIn({ models: [{ id: "a" }, { modelId: "b" }, "c"] })).toEqual(["a", "b", "c"]);
    expect(acpModelIdsIn({ models: { x: {}, y: {} } })).toEqual(["x", "y"]);
    expect(acpModelIdsIn({ availableModels: [{ modelId: "z" }] })).toEqual(["z"]);
    // only a complete list can show a model is absent: anything else is unreadable (null), never an empty or partial list
    expect(acpModelIdsIn({ models: [{ id: "a" }, { slug: "grok-4.7" }] })).toBeNull();
    expect(acpModelIdsIn({ models: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.7" }] } })).toBeNull();
    expect(acpModelIdsIn({ availableModels: [{ modelId: "z" }, {}] })).toBeNull();
    expect(acpModelIdsIn({ nested: { models: [] } })).toBeNull();
    expect(acpModelIdsIn(null)).toBeNull();
    expect(acpModelIdsIn({ models: Array.from({ length: 300 }, (_, n) => ({ id: `m${n}` })) })).toBeNull();
  });
});

describe("configureGrokSession: only a refused catalog model waits", () => {
  const refusal = () => Object.assign(new Error("Invalid params"), { code: -32602, acpMethod: "session/set_model" });
  function ctx(opts: { model: string; requestedModel?: string; providerRoute?: boolean; env: Record<string, string | undefined>; refuse: () => Error; update?: { ids: string[] | null } | null }) {
    const calls: string[] = [];
    const waits: number[] = [];
    const pins: unknown[] = [];
    let n = 0;
    const c: AcpSessionContext = {
      request: async (_method, params) => { calls.push((params as { modelId: string }).modelId); if (n++ === 0) throw opts.refuse(); return {}; },
      sessionId: "s1",
      config: {} as AcpSessionContext["config"],
      turn: { threadId: "t", text: "hi", model: opts.model, ...(opts.providerRoute ? { providerRoute: {} as never } : {}) } as SendTurnInput,
      sessionModels: [{ modelId: "grok-4.6" }],
      requestedModel: opts.requestedModel ?? opts.model,
      env: opts.env,
      awaitModelsUpdate: async (ms) => { waits.push(ms); return opts.update === undefined ? { ids: [opts.model] } : opts.update; },
      recordModelPin: (fields) => { pins.push(fields); },
    };
    return { run: () => configureGrokSession(c), calls, waits, pins };
  }
  const plainEnv = () => { const home = ownerHome(); return { HOME: home, GROK_HOME: join(home, ".grok") }; };

  it("a local pick is pinned as its inject slug exactly and never waits", async () => {
    const s = ctx({ model: "ollama-qwen3", requestedModel: "ollama::qwen3", env: plainEnv(), refuse: refusal });
    await expect(s.run()).rejects.toThrow(grokModelErrorLine("ollama-qwen3", "Invalid params"));
    expect(s.calls).toEqual(["ollama-qwen3"]);
    expect(s.waits).toEqual([]);
  });

  it("a provider-routed turn is pinned exactly and never waits", async () => {
    const s = ctx({ model: "grok-4.7", providerRoute: true, env: plainEnv(), refuse: refusal });
    await expect(s.run()).rejects.toThrow(/could not switch to grok-4\.7/);
    expect(s.calls).toEqual(["grok-4.7"]);
    expect(s.waits).toEqual([]);
  });

  it("an owner block named like a built-in is custom: refused at once, no wait", async () => {
    const home = ownerHome({ config: '[model."grok-4.7"]\nmodel = "mine"\n' });
    const s = ctx({ model: "grok-4.7", env: { HOME: home, GROK_HOME: join(home, ".grok") }, refuse: refusal });
    await expect(s.run()).rejects.toThrow(/could not switch to grok-4\.7/);
    expect(s.waits).toEqual([]);
    expect(s.pins).toEqual([{ outcome: "error", waitedMs: 0 }]);
  });

  it("a timeout (no JSON-RPC code) never waits; -32602 from another method never waits", async () => {
    const timeout = ctx({ model: "grok-4.7", env: plainEnv(), refuse: () => new Error("Grok did not respond to session/set_model in time") });
    await expect(timeout.run()).rejects.toThrow(/did not respond/);
    expect(timeout.waits).toEqual([]);
    const other = ctx({ model: "grok-4.7", env: plainEnv(), refuse: () => Object.assign(new Error("Invalid params"), { code: -32602, acpMethod: "session/set_mode" }) });
    await expect(other.run()).rejects.toThrow();
    expect(other.waits).toEqual([]);
  });

  it("an announcement in an unreadable shape lets grok's answer to one more pin decide", async () => {
    const s = ctx({ model: "grok-4.7", env: plainEnv(), refuse: refusal, update: { ids: null } });
    await s.run();
    expect(s.calls).toEqual(["grok-4.7", "grok-4.7"]);
    expect((s.pins[0] as { outcome: string }).outcome).toBe("repinned");
  });
});

describe("first Grok turn in a fresh bot scope (fake grok, scoped GROK_HOME)", () => {
  async function grokTurn(threadId: string, opts: { cache?: unknown; config?: string; model?: string; env?: Record<string, string>; during?: (stop: () => Promise<unknown>, dump: string) => Promise<void> } = {}) {
    ensureDirs();
    resetIsolationCache();
    const home = ownerHome({ cache: opts.cache, config: opts.config });
    const dump = join(home, "spawn.json");
    const instance = await GrokAgentDriver.create({ instanceId: `grok-setmodel-${threadId}`, displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_PROMPT_DUMP: `${dump}.prompt.json`, FAKE_ACP_VERSION: "grok 1.0.70 (fixture)",
        FAKE_ACP_GROK_MODELS_CACHE: "1", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", ...opts.env } });
    const recorder = recordEvents(instance.adapter);
    const startedAt = Date.now();
    try {
      await instance.adapter.sendTurn({ threadId, text: "hello", cwd: home, model: opts.model ?? "grok-4.7" } as SendTurnInput);
      await opts.during?.(() => instance.adapter.interruptTurn(threadId), dump);
      const completed = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 30000);
      const elapsedMs = Date.now() - startedAt;
      const events = recorder.events.filter((e: any) => e.threadId === threadId) as any[];
      const setModels = existsSync(`${dump}.setmodel.json`) ? JSON.parse(readFileSync(`${dump}.setmodel.json`, "utf8")) as string[] : [];
      const chips = events.filter((e) => typeof e.itemId === "string" && e.itemId.startsWith("models-wait-"));
      const native = join(NATIVE_DIR, `${threadId}.ndjson`);
      const pins = existsSync(native)
        ? readFileSync(native, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.dir === "lifecycle" && r.msg?.event === "model_pin").map((r) => r.msg)
        : [];
      return {
        completed, elapsedMs, setModels, chips, pins, prompted: existsSync(`${dump}.prompt.json`),
        model: events.find((e) => e.type === "session.started")?.model,
        error: events.find((e) => e.type === "runtime.error")?.message as string | undefined,
      };
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  }

  it("T1 warm (seeded): one set_model grok-4.7, ok, no chip, model_pin ok with the cache held at spawn", async () => {
    const r = await grokTurn("grok-setmodel-t1", { cache: CACHE_47 });
    expect(r.completed).toMatchObject({ ok: true });
    expect(r.setModels).toEqual(["grok-4.7"]);
    expect(r.model).toBe("grok-4.7");
    expect(r.chips).toEqual([]);
    expect(r.pins).toMatchObject([{ outcome: "ok", waitedMs: 0, cacheAtSpawn: true }]);
  });

  it("T2 cold, the catalog arrives: refused, the chip, the announcement, pinned again, ok on grok-4.7", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "10000";
    const r = await grokTurn("grok-setmodel-t2", { env: { FAKE_ACP_GROK_CATALOG_MS: "2000", FAKE_ACP_GROK_CATALOG_IDS: "grok-4.7,grok-4.6" } });
    expect(r.completed).toMatchObject({ ok: true });
    expect(r.setModels).toEqual(["grok-4.7", "grok-4.7"]);
    expect(r.model).toBe("grok-4.7");
    expect(r.chips.map((e) => [e.type, e.title ?? null])).toEqual([["item.started", GROK_MODELS_WAIT_TITLE], ["item.completed", null]]);
    expect(r.pins).toHaveLength(1);
    expect(r.pins[0]).toMatchObject({ outcome: "repinned", cacheAtSpawn: false });
    expect(r.pins[0].waitedMs).toBeGreaterThan(0);
  });

  it("T3 cold, the catalog never arrives: fails at the bound with the timeout line, and session.started names no model", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "1500";
    const r = await grokTurn("grok-setmodel-t3");
    expect(r.completed).toMatchObject({ ok: false });
    expect(r.error).toContain(grokModelsTimeoutLine("grok-4.7"));
    expect(r.setModels).toEqual(["grok-4.7"]);
    // initialize advertised fake-acp-model and session/new grok-4.6: neither is reported
    expect(r.model).toBeNull();
    expect(r.pins).toMatchObject([{ outcome: "timeout" }]);
  });

  it("T4 the catalog arrives without the model: fails with the unlisted line, one set_model", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "10000";
    const r = await grokTurn("grok-setmodel-t4", { env: { FAKE_ACP_GROK_CATALOG_MS: "500", FAKE_ACP_GROK_CATALOG_IDS: "grok-4.8" } });
    expect(r.completed).toMatchObject({ ok: false });
    expect(r.error).toContain(grokModelUnlistedLine("grok-4.7"));
    expect(r.setModels).toEqual(["grok-4.7"]);
    expect(r.pins).toMatchObject([{ outcome: "unlisted" }]);
  });

  it("T5 a set_model that never answers is a timeout, not a refusal: fails at once, no wait, no chip, no model", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "10000";
    const r = await grokTurn("grok-setmodel-t5", { env: { FAKE_ACP_SET_MODEL_STALL: "1" } });
    expect(r.completed).toMatchObject({ ok: false });
    expect(r.error).toContain("Grok could not switch to grok-4.7. Try again");
    expect(r.setModels).toEqual(["grok-4.7"]);
    expect(r.chips).toEqual([]);
    expect(r.model).toBeNull();
    expect(r.elapsedMs).toBeLessThan(9000);
  });

  it("T6 a grok-named custom block and a local pick are pinned exactly and fail at once", async () => {
    const custom = await grokTurn("grok-setmodel-t6a", { config: '[model.grok-local]\nname = "Local"\n', model: "grok-local", env: { FAKE_ACP_MODE: "set-model-invalid-params" } });
    expect(custom.completed).toMatchObject({ ok: false });
    expect(custom.error).toContain("Grok could not switch to grok-local");
    expect(custom.setModels).toEqual(["grok-local"]);
    expect(custom.chips).toEqual([]);
    const local = await grokTurn("grok-setmodel-t6b", { model: "ollama::qwen3", env: { FAKE_ACP_MODE: "set-model-invalid-params" } });
    expect(local.completed).toMatchObject({ ok: false });
    expect(local.setModels).toHaveLength(1);
    expect(local.setModels[0]).not.toBe("ollama::qwen3"); // the inject slug config.toml names, exactly
    expect(local.chips).toEqual([]);
  });

  it("T9 a stop while the refused pin is pending outranks an announcement already recorded: no second pin, no prompt", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "10000";
    const r = await grokTurn("grok-setmodel-t9", {
      env: { FAKE_ACP_GROK_CATALOG_MS: "100", FAKE_ACP_GROK_CATALOG_IDS: "grok-4.7", FAKE_ACP_SET_MODEL_DELAY_MS: "2500" },
      during: async (stop, dump) => {
        const until = Date.now() + 15000;
        while (!existsSync(`${dump}.setmodel.json`) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => setTimeout(resolve, 700)); // the announcement (100 ms after session/new) is recorded; the refusal is not in yet
        await stop();
      },
    });
    expect(r.setModels).toEqual(["grok-4.7"]);
    expect(r.prompted).toBe(false);
    expect(r.pins.filter((p: { outcome: string }) => p.outcome === "repinned")).toEqual([]);
  });

  it("the lines keep their next step inside the turn error for a long model id", () => {
    const long = `local-${"x".repeat(120)}`;
    // the turn error keeps 159 characters and an ellipsis: everything up to the next step must fit; only the engine's reason may be cut
    for (const line of [grokModelsTimeoutLine(long), grokModelUnlistedLine(long), grokModelErrorLine(long, "x".repeat(200)).replace(/ \(x+\)$/, "")]) {
      expect(line.length).toBeLessThanOrEqual(159);
      expect(line).toContain("this bot's settings");
    }
  });

  it("T7 an old grok without set_model fails at once with the next step", async () => {
    const r = await grokTurn("grok-setmodel-t7", { env: { FAKE_ACP_MODE: "no-session-config" } });
    expect(r.completed).toMatchObject({ ok: false });
    expect(r.error).toContain("if it repeats, update Grok.");
    expect(r.error!.length).toBeLessThanOrEqual(160);
    expect(r.chips).toEqual([]);
    expect(r.model).toBeNull();
  });
});

describe("T8 a confirmed pin is reported when a later Ask step fails (shared core, an engine with the Ask session-mode hook)", () => {
  it("Cursor at Ask: set_model works, set_mode is refused, the turn stops, session.started keeps the pinned model", async () => {
    ensureDirs();
    const scratch = mkdtempSync(join(tmpdir(), "murage-grok-setmodel-t8-"));
    homes.push(scratch);
    const dump = join(scratch, "dump.json");
    const instance = await createCursorAgentDriver().create({
      instanceId: "cursor-pin-confirmed", displayName: "Cursor", enabled: true, config: { cli, fullAuto: false },
      environment: { HOME: scratch, USERPROFILE: scratch, FAKE_ACP_DUMP: dump, FAKE_ACP_SET_MODE_REFUSE: "1", FAKE_ACP_SESSION_MODELS: "gpt-5",
        FAKE_ACP_SESSION_MODES: JSON.stringify({ currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "ask" }] }) },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t8-pin", text: "read it", cwd: scratch, model: "gpt-5", routeAsks: true, askLevel: true } as SendTurnInput);
      const done = await recorder.until((e) => e.threadId === "t8-pin" && e.type === "turn.completed", 20000);
      expect(done).toMatchObject({ ok: false });
      expect(JSON.parse(readFileSync(`${dump}.setmodel.json`, "utf8"))).toEqual(["gpt-5"]);
      const started = recorder.events.find((e: any) => e.threadId === "t8-pin" && e.type === "session.started") as any;
      expect(started?.model).toBe("gpt-5");
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
