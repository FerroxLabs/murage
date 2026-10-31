// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GROK-SETMODEL-PIN (1.0.11, the session-level cut of GROK-SETMODEL-1010 r3): a fresh grok process whose catalog fetch has not
// landed refuses set_model (-32602) for a model it has not listed yet. That refusal waits once, bounded, for grok's own catalog
// announcement and pins again; everything else fails at once; session.started never names a model whose pin failed. Never
// another model. Decided from the error code and the advertised list only. Synthetic homes and the fake ACP CLI only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { acpModelIdsIn, type AcpSessionContext } from "./core.ts";
import { createCursorAgentDriver } from "./cursor.ts";
import {
  configureGrokSession, grokModelErrorLine, grokModelsTimeoutLine, grokModelUnlistedLine, GrokAgentDriver, GROK_MODELS_WAIT_TITLE,
} from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) removeTempDirSync(home);
  delete process.env.MURAGE_GROK_MODELS_WAIT_MS;
});

function ownerHome(opts: { config?: string } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-setmodel-"));
  homes.push(home);
  const grok = join(home, ".grok");
  mkdirSync(grok, { recursive: true });
  writeFileSync(join(grok, "config.toml"), opts.config ?? '[models]\ndefault = "grok-4.7"\n');
  writeFileSync(join(grok, "auth.json"), "{}");
  return home;
}

describe("catalog announcements", () => {
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

describe("configureGrokSession: only a refused model grok has not listed yet waits", () => {
  const refusal = () => Object.assign(new Error("Invalid params"), { code: -32602, acpMethod: "session/set_model" });
  function ctx(opts: { model: string; advertised?: string[]; refuse: () => Error; update?: { ids: string[] | null } | null | "aborted"; cancelled?: () => boolean; refuseSecond?: boolean; onWait?: () => void }) {
    const calls: string[] = [];
    const waits: number[] = [];
    const pins: unknown[] = [];
    let n = 0;
    const c: AcpSessionContext = {
      request: async (_method, params) => { calls.push((params as { modelId: string }).modelId); n += 1; if (n === 1 || opts.refuseSecond) throw opts.refuse(); return {}; },
      sessionId: "s1",
      config: {} as AcpSessionContext["config"],
      turn: { threadId: "t", text: "hi", model: opts.model } as SendTurnInput,
      sessionModels: (opts.advertised ?? ["grok-4.6", "grok-4.5"]).map((modelId) => ({ modelId })),
      awaitModelsUpdate: async (ms) => { waits.push(ms); opts.onWait?.(); return opts.update === undefined ? { ids: [opts.model] } : opts.update; },
      ...(opts.cancelled ? { cancelled: opts.cancelled } : {}),
      recordModelPin: (fields) => { pins.push(fields); },
    };
    return { run: () => configureGrokSession(c), calls, waits, pins };
  }

  it("a refused model that is not advertised waits once and pins once more", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "4321";
    const s = ctx({ model: "grok-4.7", refuse: refusal });
    await s.run();
    expect(s.calls).toEqual(["grok-4.7", "grok-4.7"]);
    expect(s.waits).toEqual([4321]);
    expect(s.pins).toMatchObject([{ outcome: "repinned" }]);
  });

  it("a refused model the session already advertised fails at once (grok knows it and still said no): no wait", async () => {
    const s = ctx({ model: "grok-local", advertised: ["grok-4.6", "grok-local"], refuse: refusal });
    await expect(s.run()).rejects.toThrow(grokModelErrorLine("grok-local", "Invalid params"));
    expect(s.calls).toEqual(["grok-local"]);
    expect(s.waits).toEqual([]);
    expect(s.pins).toEqual([{ outcome: "error", waitedMs: 0 }]);
  });

  it("a session that advertised no list fails at once: no wait", async () => {
    const s = ctx({ model: "grok-4.7", advertised: [], refuse: refusal });
    await expect(s.run()).rejects.toThrow(/could not switch to grok-4\.7/);
    expect(s.waits).toEqual([]);
  });

  it("a timeout (no JSON-RPC code) never waits; -32602 from another method never waits", async () => {
    const timeout = ctx({ model: "grok-4.7", refuse: () => new Error("Grok did not respond to session/set_model in time") });
    await expect(timeout.run()).rejects.toThrow(/did not respond/);
    expect(timeout.waits).toEqual([]);
    const other = ctx({ model: "grok-4.7", refuse: () => Object.assign(new Error("Invalid params"), { code: -32602, acpMethod: "session/set_mode" }) });
    await expect(other.run()).rejects.toThrow();
    expect(other.waits).toEqual([]);
  });

  it("an announcement without the model fails with the unlisted line; none at the bound fails with the timeout line", async () => {
    const unlisted = ctx({ model: "grok-4.7", refuse: refusal, update: { ids: ["grok-4.8"] } });
    await expect(unlisted.run()).rejects.toThrow(grokModelUnlistedLine("grok-4.7"));
    expect(unlisted.calls).toEqual(["grok-4.7"]);
    const none = ctx({ model: "grok-4.7", refuse: refusal, update: null });
    await expect(none.run()).rejects.toThrow(grokModelsTimeoutLine("grok-4.7"));
    expect(none.calls).toEqual(["grok-4.7"]);
    expect(none.pins).toMatchObject([{ outcome: "timeout" }]);
  });

  it("a stopped wait writes a model_pin record", async () => {
    const s = ctx({ model: "grok-4.7", refuse: refusal, update: "aborted" });
    await expect(s.run()).rejects.toThrow("stopped");
    expect(s.calls).toEqual(["grok-4.7"]);
    expect(s.pins).toMatchObject([{ outcome: "aborted" }]);
  });

  it("a stop that lands while the announcement is already answered is seen right before the second pin", async () => {
    let halted = false;
    const s = ctx({ model: "grok-4.7", refuse: refusal, cancelled: () => halted, onWait: () => { halted = true; } });
    await expect(s.run()).rejects.toThrow("stopped");
    expect(s.calls).toEqual(["grok-4.7"]);
    expect(s.pins).toMatchObject([{ outcome: "aborted" }]);
  });

  it("a turn already stopped sends no pin at all", async () => {
    const s = ctx({ model: "grok-4.7", refuse: refusal, cancelled: () => true });
    await expect(s.run()).rejects.toThrow("stopped");
    expect(s.calls).toEqual([]);
    expect(s.waits).toEqual([]);
    expect(s.pins).toEqual([{ outcome: "aborted", waitedMs: 0 }]);
  });

  it("a refusal that arrives after a stop never starts the wait", async () => {
    let calls = 0;
    const s = ctx({ model: "grok-4.7", refuse: refusal, cancelled: () => calls++ > 0 });
    await expect(s.run()).rejects.toThrow("stopped");
    expect(s.waits).toEqual([]);
    expect(s.pins).toMatchObject([{ outcome: "aborted" }]);
  });

  it("a second pin that fails after a stop records the stop, not an engine error", async () => {
    let halted = false;
    const checks = { n: 0 };
    // the checks before the first pin, after its refusal and after the wait pass; the next one follows the second pin's failure
    const s = ctx({ model: "grok-4.7", refuse: refusal, refuseSecond: true, cancelled: () => { checks.n += 1; halted = checks.n > 3; return halted; } });
    await expect(s.run()).rejects.toThrow("stopped");
    expect(s.calls).toEqual(["grok-4.7", "grok-4.7"]);
    expect(s.pins).toMatchObject([{ outcome: "aborted" }]);
  });

  it("an announcement in an unreadable shape lets grok's answer to one more pin decide", async () => {
    const s = ctx({ model: "grok-4.7", refuse: refusal, update: { ids: null } });
    await s.run();
    expect(s.calls).toEqual(["grok-4.7", "grok-4.7"]);
    expect((s.pins[0] as { outcome: string }).outcome).toBe("repinned");
  });
});

describe("first Grok turn on a fresh grok process (fake grok, scoped GROK_HOME)", () => {
  type Adapter = Awaited<ReturnType<typeof GrokAgentDriver.create>>["adapter"];
  async function grokTurn(threadId: string, opts: {
    config?: string; model?: string; env?: Record<string, string>;
    during?: (stop: () => Promise<unknown>, dump: string, driver: { adapter: Adapter; dispose: () => Promise<void> }, chip: Promise<void>) => Promise<void>;
    after?: () => Promise<void>;
    onEvent?: (event: any, stop: () => void, driver: { adapter: Adapter; dispose: () => Promise<void> }) => void;
  } = {}) {
    ensureDirs();
    resetIsolationCache();
    const home = ownerHome({ config: opts.config });
    const dump = join(home, "spawn.json");
    const instance = await GrokAgentDriver.create({ instanceId: `grok-setmodel-${threadId}`, displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_PROMPT_DUMP: `${dump}.prompt.json`, FAKE_ACP_VERSION: "grok 1.0.70 (fixture)",
        FAKE_ACP_GROK_MODELS_CACHE: "1", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", ...opts.env } });
    const recorder = recordEvents(instance.adapter);
    let chipOpened = () => {};
    const chip = new Promise<void>((resolve) => { chipOpened = resolve; });
    const unlisten = instance.adapter.onEvent((event: any) => {
      if (event.type === "item.started" && String(event.itemId).startsWith("models-wait-")) chipOpened();
      opts.onEvent?.(event, () => { void instance.adapter.interruptTurn(threadId).catch(() => undefined); }, instance);
    });
    const startedAt = Date.now();
    try {
      await instance.adapter.sendTurn({ threadId, text: "hello", cwd: home, model: opts.model ?? "grok-4.7" } as SendTurnInput);
      await opts.during?.(() => instance.adapter.interruptTurn(threadId), dump, instance, chip);
      const completed = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 30000);
      await opts.after?.();
      const elapsedMs = Date.now() - startedAt;
      const events = recorder.events.filter((e: any) => e.threadId === threadId) as any[];
      const setModels = existsSync(`${dump}.setmodel.json`) ? JSON.parse(readFileSync(`${dump}.setmodel.json`, "utf8")) as string[] : [];
      const chips = events.filter((e) => typeof e.itemId === "string" && e.itemId.startsWith("models-wait-"));
      const native = join(NATIVE_DIR, `${threadId}.ndjson`);
      const rows: any[] = existsSync(native) ? readFileSync(native, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
      const pins = rows.filter((r) => r.dir === "lifecycle" && r.msg?.event === "model_pin").map((r) => r.msg);
      const setModelIds = rows.filter((r) => r.dir === "out" && r.msg?.method === "session/set_model").map((r) => r.msg.id);
      const lifecycleAt = (name: string) => rows.findIndex((r) => r.dir === "lifecycle" && r.msg?.event === name);
      return {
        completed, elapsedMs, setModels, chips, pins, prompted: existsSync(`${dump}.prompt.json`),
        setModelAnswers: rows.filter((r) => r.dir === "in" && setModelIds.includes(r.msg?.id) && !r.msg?.method).length,
        settledBeforeClose: lifecycleAt("turn_settled") >= 0 && (lifecycleAt("closed") < 0 || lifecycleAt("turn_settled") < lifecycleAt("closed")),
        model: events.find((e) => e.type === "session.started")?.model,
        error: events.find((e) => e.type === "runtime.error")?.message as string | undefined,
      };
    } finally {
      unlisten();
      recorder.stop();
      await instance.dispose();
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** SIGTERM cannot be caught on Windows, so the fixture's held close is POSIX only; everywhere else these tests read the child's own order. */
  const holdsClose = process.platform !== "win32";
  /** Files the test creates to let the fake child go on: every step below follows an event, none follows a delay. */
  function gates() {
    const dir = mkdtempSync(join(tmpdir(), "murage-grok-setmodel-gates-"));
    homes.push(dir);
    const path = (name: string) => join(dir, name);
    return {
      path,
      open: (name: string) => writeFileSync(path(name), ""),
      /** A child that stays up after a stop until `open("exit")`. */
      heldClose: () => ({ FAKE_ACP_TERM: "gate", FAKE_ACP_EXIT_GATE: path("exit") }),
    };
  }
  /** The first set_model has been written: with a refused pin, the turn is about to wait (or waiting) for the catalog. */
  async function pinSeen(dump: string): Promise<void> {
    const until = Date.now() + 15000;
    while (!existsSync(`${dump}.setmodel.json`) && Date.now() < until) await sleep(50);
  }
  const stoppedInTheWait = (r: Awaited<ReturnType<typeof grokTurn>>) => {
    expect(r.setModels).toEqual(["grok-4.7"]);
    expect(r.prompted).toBe(false);
    expect(r.pins).toMatchObject([{ outcome: "aborted" }]);
    // no session.started at all when the process closed first
    expect(r.model ?? null).toBeNull();
  };

  it("T1 a model grok already lists: one set_model, ok, no chip, model_pin ok", async () => {
    const r = await grokTurn("grok-setmodel-t1", { model: "grok-4.5" });
    expect(r.completed).toMatchObject({ ok: true });
    expect(r.setModels).toEqual(["grok-4.5"]);
    expect(r.model).toBe("grok-4.5");
    expect(r.chips).toEqual([]);
    expect(r.pins).toMatchObject([{ outcome: "ok", waitedMs: 0, cacheAtSpawn: false }]);
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

  it("T10 Stop fired from the event that closes the chip: no second pin, no prompt, a cancelled turn, an aborted record", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "60000";
    const g = gates();
    const r = await grokTurn("grok-setmodel-t10", {
      env: { FAKE_ACP_GROK_CATALOG_GATE: g.path("catalog"), FAKE_ACP_GROK_CATALOG_IDS: "grok-4.7" },
      during: async (_stop, _dump, _driver, chip) => { await chip; g.open("catalog"); },
      onEvent: (event, stop) => { if (event.type === "item.completed" && String(event.itemId).startsWith("models-wait-")) stop(); },
    });
    expect(r.completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(r.chips.map((e) => e.type)).toEqual(["item.started", "item.completed"]);
    stoppedInTheWait(r);
  });

  it.each([["T11 Stop All", "grok-setmodel-t11", "stopAll"], ["T12 app shutdown", "grok-setmodel-t12", "dispose"]] as const)(
    "%s during the wait, with a child that announces its catalog while it closes: no second pin, no prompt", async (_name, thread, how) => {
      process.env.MURAGE_GROK_MODELS_WAIT_MS = "60000";
      const g = gates();
      let stopping: Promise<unknown> | undefined;
      const r = await grokTurn(thread, {
        env: { ...g.heldClose(), FAKE_ACP_GROK_CATALOG_GATE: g.path("catalog"), FAKE_ACP_GROK_CATALOG_IDS: "grok-4.7" },
        during: async (_stop, _dump, driver, chip) => {
          await chip;
          stopping = (how === "stopAll" ? driver.adapter.stopAll() : driver.dispose()).catch(() => undefined);
          g.open("catalog");
        },
        after: async () => { g.open("exit"); await stopping; },
      });
      expect(r.completed).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(r.error).toBeUndefined();
      stoppedInTheWait(r);
      if (holdsClose) expect(r.settledBeforeClose).toBe(true);
    });

  it("T13 grok exits during the wait: the wait ends at once, with an aborted record", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "60000";
    const pidDir = mkdtempSync(join(tmpdir(), "murage-grok-setmodel-pid-"));
    homes.push(pidDir);
    const pidFile = join(pidDir, "grok.pid");
    // the bound is twice what the turn is given to complete: a turn that completes did not reach it
    const r = await grokTurn("grok-setmodel-t13", {
      env: { FAKE_ACP_PID_FILE: pidFile },
      during: async (_stop, _dump, _driver, chip) => {
        await chip;
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      },
    });
    expect(r.completed).toMatchObject({ ok: false });
    stoppedInTheWait(r);
  });

  it("T14 Stop All while the refused pin is pending: the refusal, once read, starts no wait", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "60000";
    const g = gates();
    let stopping: Promise<unknown> | undefined;
    const r = await grokTurn("grok-setmodel-t14", {
      env: { ...g.heldClose(), FAKE_ACP_SET_MODEL_GATE: g.path("set-model"), FAKE_ACP_SET_MODEL_GATE_ANSWER: "refuse" },
      during: async (_stop, dump, driver) => {
        await pinSeen(dump);
        stopping = driver.adapter.stopAll().catch(() => undefined);
        g.open("set-model");
      },
      after: async () => { g.open("exit"); await stopping; },
    });
    expect(r.completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(r.chips).toEqual([]);
    stoppedInTheWait(r);
    // the child is still up, so only its answer can have ended the turn
    if (holdsClose) expect([r.setModelAnswers, r.settledBeforeClose]).toEqual([1, true]);
  });

  it("T15 Stop All while a pin that succeeds is pending: session setup ends the turn once it reads the answer, no prompt", async () => {
    const g = gates();
    let stopping: Promise<unknown> | undefined;
    const r = await grokTurn("grok-setmodel-t15", {
      model: "grok-4.5",
      env: { ...g.heldClose(), FAKE_ACP_SET_MODEL_GATE: g.path("set-model") },
      during: async (_stop, dump, driver) => {
        await pinSeen(dump);
        stopping = driver.adapter.stopAll().catch(() => undefined);
        g.open("set-model");
      },
      after: async () => { g.open("exit"); await stopping; },
    });
    expect(r.completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(r.setModels).toEqual(["grok-4.5"]);
    expect(r.prompted).toBe(false);
    if (holdsClose) expect([r.setModelAnswers, r.settledBeforeClose]).toEqual([1, true]);
  });

  it("T16 Stop All fired from the event that opens the chip ends the wait at once, the child still up", async () => {
    process.env.MURAGE_GROK_MODELS_WAIT_MS = "60000";
    const g = gates();
    let stopping: Promise<unknown> | undefined;
    const r = await grokTurn("grok-setmodel-t16", {
      env: g.heldClose(),
      onEvent: (event, _stop, driver) => {
        if (event.type === "item.started" && String(event.itemId).startsWith("models-wait-")) stopping = driver.adapter.stopAll().catch(() => undefined);
      },
      after: async () => { g.open("exit"); await stopping; },
    });
    expect(r.completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(r.chips.map((e) => e.type)).toEqual(["item.started", "item.completed"]);
    stoppedInTheWait(r);
    if (holdsClose) expect(r.settledBeforeClose).toBe(true);
  });

  it("the lines keep their next step inside the turn error for a long model id", () => {
    const long = `local-${"x".repeat(120)}`;
    // the turn error keeps 159 characters and an ellipsis: everything up to the next step must fit; only the engine's reason may be cut
    for (const line of [grokModelsTimeoutLine(long), grokModelUnlistedLine(long), grokModelErrorLine(long, "x".repeat(200)).replace(/ \(x+\)$/, "")]) {
      expect(line.length).toBeLessThanOrEqual(159);
      expect(line).toMatch(/pick another Grok model|Choose another Grok model/);
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
