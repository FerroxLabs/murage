// STOP-FENCE (1.0.18) r3.2 tests. T27 is intentionally unused. Every driver test also asserts: no event after the final turn.completed, and a fresh send on
// the thread then completes (`afterStop`). A "mutant" in a comment names the one change that turns the test red with all other code intact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openCodeDestinationAnswer } from "../../opencode-destination.ts";
import { createPrewarmGate, warmPool } from "../warm-pool.ts";
import { ScopeUnavailableError } from "../scoped-cli-home.ts";
import { fencedWrite, createSendFences, SendStoppedError } from "./send-fence.ts";
import { applyStop, cleanupEngine, createFixture, makeFakeEngine, waitFor, type FakeEngine, type StopAction } from "./stop-fence-harness.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { localSetupFailureOf } from "../../local-setup-failure.ts";

const scopeStart = vi.hoisted(() => ({ impl: null as null | (() => Promise<void>) }));
vi.mock("../scoped-cli-home.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scoped-cli-home.ts")>();
  return { ...actual, awaitScopeStart: (...args: Parameters<typeof actual.awaitScopeStart>) => (scopeStart.impl ? scopeStart.impl() : actual.awaitScopeStart(...args)) };
});
// Counts real engine spawns (a pass-through): a child killed at once by a stop never writes its marker file, so "no spawn" is asserted here.
const spawnSpy = vi.hoisted(() => ({ n: 0, last: null as unknown }));
vi.mock("../../procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => { spawnSpy.n++; const child = actual.spawnCli(...args); if (!args[1].includes("--version")) spawnSpy.last = child; return child; } };
});
// Test hooks on three collaborators (all pass-through unless a test arms them): the prewarm gate's takeOver (counted, optionally held), applyProviderRoute (counted, optionally replaced), handedEngineEnv (counted, optionally held).
const hooks = vi.hoisted(() => ({ takeOvers: 0, takeOverHold: null as null | Promise<void>, routeCalls: 0, routeImpl: null as null | ((...args: unknown[]) => unknown), handedCalls: 0, handedHold: null as null | Promise<void> }));
vi.mock("../warm-pool.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../warm-pool.ts")>();
  return { ...actual, createPrewarmGate: () => {
    const gate = actual.createPrewarmGate();
    const takeOver = gate.takeOver.bind(gate);
    gate.takeOver = async (...args: Parameters<typeof takeOver>) => { hooks.takeOvers++; await hooks.takeOverHold; return takeOver(...args); };
    return gate;
  } };
});
vi.mock("../../provider-routing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../provider-routing.ts")>();
  return { ...actual, applyProviderRoute: (...args: Parameters<typeof actual.applyProviderRoute>) => { hooks.routeCalls++; return hooks.routeImpl ? (hooks.routeImpl(...args) as ReturnType<typeof actual.applyProviderRoute>) : actual.applyProviderRoute(...args); } };
});
vi.mock("../../engine-env.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine-env.ts")>();
  return { ...actual, handedEngineEnv: async (...args: Parameters<typeof actual.handedEngineEnv>) => { hooks.handedCalls++; await hooks.handedHold; return actual.handedEngineEnv(...args); } };
});
const engines: FakeEngine[] = [];
const instances: ProviderInstance[] = [];
const engineOf = (...args: Parameters<typeof makeFakeEngine>) => { const e = makeFakeEngine(...args); engines.push(e); return e; };
beforeEach(() => { spawnSpy.n = 0; });
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const engine of engines.splice(0)) cleanupEngine(engine);
});
type Ev = { type: string; stopReason?: string; ok?: boolean; message?: string; turnId?: string; threadId?: string };
async function boot(engine: FakeEngine, extra: Parameters<typeof createFixture>[1] = {}) {
  ensureDirs();
  const instance = await createFixture(engine, extra);
  instances.push(instance);
  const events: Ev[] = [];
  instance.adapter.onEvent((event) => { events.push(event as Ev); });
  return { instance, events };
}
const send = (instance: ProviderInstance, threadId = "t1", text = "hello") => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, model: "p/m" });
const types = (events: Ev[]) => events.map((event) => event.type);
const completions = (events: Ev[]) => events.filter((event) => event.type === "turn.completed");
const STOPPED_PAIR = ["turn.started", "turn.completed"];
/** The pair belongs to the turn the send returned: one start and one completion, both with that turnId and thread, in order (a receipt under another id is a bug). */
function pairFor(events: Ev[], turnId: string, threadId = "t1") {
  expect(events.filter((e) => e.type === "turn.started" || e.type === "turn.completed").map((e) => [e.type, e.turnId, e.threadId])).toEqual([["turn.started", turnId, threadId], ["turn.completed", turnId, threadId]]);
}
/** The common tail of every stop test: the pair is the whole story, nothing follows it, and the thread takes a fresh send. */
async function afterStop(instance: ProviderInstance, engine: FakeEngine, events: Ev[], turnId: string, threadId = "t1") {
  // long enough for a wrongly spawned node child to have written its marker (a spawn that slipped past a gate shows here)
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(engine.started(), "no engine was spawned after the stop").toBe(false);
  expect(spawnSpy.n, "spawnCli was never called").toBe(0);
  expect(types(events)).toEqual(STOPPED_PAIR);
  expect(completions(events)[0]?.stopReason).toBe("cancelled");
  pairFor(events, turnId, threadId);
  const before = events.length;
  await send(instance, threadId, "again");
  await waitFor(() => expect(completions(events).length).toBe(2));
  expect(events.length).toBeGreaterThan(before);
  expect(completions(events)[1]?.stopReason).not.toBe("cancelled");
  void engine;
}
const STOPS: StopAction[] = ["interrupt", "reset", "stopAll"];

describe("stop-fence r3.2 units", () => {
  const mk = () => {
    const epochs = new Map<string, number>(); let disposed = false; let owner: { kind: "send" | "prewarm" } | null = null;
    const fences = createSendFences({ epochOf: (t) => epochs.get(t) ?? 0, disposed: () => disposed, owner: () => owner });
    return { fences, bump: (t: string) => epochs.set(t, (epochs.get(t) ?? 0) + 1), dispose: () => { disposed = true; }, setOwner: (o: typeof owner) => { owner = o; } };
  };
  it("U1 fencedWrite: a dead fence refuses a call and halts once; responses and session/cancel pass; the prompt flips promptSent after the write", () => {
    const { fences, bump } = mk();
    const fence = fences.begin("t", "id", "send");
    const state = { promptSent: false };
    const order: string[] = [];
    // live: a call is written, the prompt flips promptSent AFTER the bytes are handed over
    fencedWrite(fence, state, { method: "session/prompt" }, () => { order.push(`write:${state.promptSent}`); }, () => order.push("halt"));
    expect(order).toEqual(["write:false"]);
    expect(state.promptSent).toBe(true);
    const fresh = mk();
    const dead = fresh.fences.begin("t", "id", "send");
    const s2 = { promptSent: false };
    fresh.bump("t");
    const calls: string[] = [];
    const halt = vi.fn();
    expect(() => fencedWrite(dead, s2, { method: "session/new" }, () => calls.push("new"), halt)).toThrow(SendStoppedError);
    expect(halt).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(s2.promptSent).toBe(false);
    expect(() => fencedWrite(dead, s2, { method: "session/prompt" }, () => calls.push("prompt"), halt)).toThrow(SendStoppedError);
    expect(s2.promptSent).toBe(false);
    fencedWrite(dead, s2, { id: 1, result: {} }, () => calls.push("response"), halt);
    fencedWrite(dead, s2, { id: 2, error: { code: 1 } }, () => calls.push("error-response"), halt);
    fencedWrite(dead, s2, { method: "session/cancel" }, () => calls.push("cancel"), halt);
    expect(calls).toEqual(["response", "error-response", "cancel"]);
    expect(halt).toHaveBeenCalledTimes(2);
    void bump;
  });
  it("U1b once the prompt is written the fence is never consulted", () => {
    const { fences, bump } = mk();
    const fence = fences.begin("t", "id", "send");
    const state = { promptSent: false };
    fencedWrite(fence, state, { method: "session/prompt" }, () => {}, () => {});
    bump("t");
    const wrote: string[] = [];
    fencedWrite(fence, state, { method: "session/set_config_option" }, () => wrote.push("x"), () => wrote.push("halt"));
    expect(wrote).toEqual(["x"]);
  });
  it("U2 send-fence: end and release twice, own/handOff/end order, a throw between begin and end leaves nothing", () => {
    const { fences, bump, dispose } = mk();
    const ran: string[] = [];
    const f = fences.begin("a", "1", "send");
    f.own(() => ran.push("c1")); f.own(() => ran.push("c2"));
    expect([...fences.threads()]).toEqual(["a"]);
    f.release(); f.release();
    expect([...fences.threads()]).toEqual([]);
    f.end(); f.end();
    expect(ran).toEqual(["c1", "c2"]);
    const g = fences.begin("a", "2", "send");
    g.own(() => ran.push("handed"));
    g.handOff();
    g.end();
    expect(ran).toEqual(["c1", "c2"]);
    expect(g.handedOff).toBe(true);
    const h = fences.begin("b", "3", "send");
    try { throw new Error("boom"); } catch { h.end(); }
    expect([...fences.threads()]).toEqual([]);
    // retired(): an epoch move; dispose is NOT a stop; live() covers both
    const r = fences.begin("c", "4", "send");
    expect([r.live(), r.retired()]).toEqual([true, false]);
    dispose();
    expect([r.live(), r.retired()]).toEqual([false, false]);
    const { fences: f2, bump: bump2 } = mk();
    const r2 = f2.begin("c", "5", "send");
    bump2("c");
    expect([r2.live(), r2.retired()]).toEqual([false, true]);
    expect(() => r2.check("site")).toThrow(SendStoppedError);
    // admission
    const m = mk();
    m.fences.begin("x", "1", "send");
    expect(() => m.fences.begin("x", "2", "send")).toThrow("already running");
    expect(() => m.fences.begin("x", "3", "prewarm")).toThrow("already running");
    const p = mk();
    p.fences.begin("x", "1", "prewarm");
    expect(() => p.fences.begin("x", "2", "send")).not.toThrow();
    expect(p.fences.cancelPrewarm("x")).toBe(true);
    const q = mk();
    q.setOwner({ kind: "send" });
    expect(() => q.fences.begin("x", "1", "send")).toThrow("already running");
    q.setOwner({ kind: "prewarm" });
    expect(() => q.fences.begin("x", "2", "send")).not.toThrow();
    void bump;
  });
  it("U3 warm-pool gate: end(t, stale) leaves the newer prewarm in place", () => {
    const gate = createPrewarmGate();
    const first = gate.begin("t");
    expect(first).toBeTruthy();
    expect(gate.begin("t")).toBeNull();
    gate.end("t", first!);
    const second = gate.begin("t");
    expect(second).toBeTruthy();
    gate.end("t", first!);
    expect(gate.has("t")).toBe(true);
    expect(gate.current("t", second!)).toBe(true);
    expect(gate.current("t", first!)).toBe(false);
    gate.end("t", second!);
    expect(gate.has("t")).toBe(false);
    const third = gate.begin("t");
    gate.end("t");
    expect(gate.has("t")).toBe(false);
    void third;
  });
});

describe("stop-fence r3.2 driver", () => {
  it.each(STOPS)("T2 a %s while isAuthenticated is held: no auth_required card, the stopped pair [mutant: G2 dropped]", async (action) => {
    const engine = engineOf();
    let calls = 0; let release!: (value: boolean) => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const { instance, events } = await boot(engine, { requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false,
      isAuthenticated: () => (++calls === 1 ? held : true) });
    const sent = send(instance);
    await waitFor(() => expect(calls).toBe(1));
    await applyStop(instance, action, "t1");
    release(false);
    const { turnId } = await sent;
    expect(engine.started()).toBe(false);
    await afterStop(instance, engine, events, turnId);
  });
  it("T2b a reset while isAuthenticated is held (then true): resolveTurnModel and applyTurnEnv never run, no spawn [mutant: G2 back inside the refusal branch]", async () => {
    const engine = engineOf();
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    let calls = 0;
    const resolveTurnModel = vi.fn((model: string | undefined) => model);
    const applyTurnEnv = vi.fn();
    const { instance, events } = await boot(engine, { requireAuthenticationBeforeSpawn: true, resolveTurnModel, applyTurnEnv,
      isAuthenticated: () => (++calls === 1 ? held : true) });
    const sent = send(instance);
    await waitFor(() => expect(calls).toBe(1));
    await applyStop(instance, "reset", "t1");
    release(true);
    const { turnId } = await sent;
    expect(resolveTurnModel).not.toHaveBeenCalled();
    expect(applyTurnEnv).not.toHaveBeenCalled();
    expect(engine.started()).toBe(false);
    resolveTurnModel.mockClear();
    await afterStop(instance, engine, events, turnId);
  });
  it("T7 spawnArgs asks Stop All synchronously: spawnCli is never reached, the stopped pair [mutant: G8 dropped]", async () => {
    const engine = engineOf();
    let inst: ProviderInstance | undefined; let armed = true;
    const { instance, events } = await boot(engine, { spawnArgs: () => { if (armed) { armed = false; void inst?.adapter.stopAll?.(); } return ["acp"]; } });
    inst = instance;
    const { turnId } = await send(instance);
    expect(engine.started()).toBe(false);
    await afterStop(instance, engine, events, turnId);
  });
  it.each(STOPS)("T9 a %s while the initialize reply is held: zero bytes after initialize, cancelled [mutant: the writer check removed]", async (action) => {
    const engine = engineOf(["initialize"]);
    const { instance, events } = await boot(engine);
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    await applyStop(instance, action, "t1");
    engine.open("initialize");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(engine.methods()).toEqual(["initialize"]);
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
  });
  it("T10 a reset during initialize, initialize rejects with a plain Error: cancelled, no runtime.error [mutant: the launch catch calls the pre-r3 stopWasAsked]", async () => {
    const engine = engineOf(["initialize"], false, { errorOn: ["initialize"] });
    const { instance, events } = await boot(engine);
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    await applyStop(instance, "reset", "t1");
    engine.open("initialize");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
  });
  it("T11 a reset during initialize, the child exits 1 first: cancelled, not exit_before_result [mutant: the close handler calls the pre-r3 stopWasAsked]", async () => {
    const engine = engineOf(["initialize"], false, { exitOn: ["initialize"] });
    const { instance, events } = await boot(engine);
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    await applyStop(instance, "reset", "t1");
    engine.open("initialize");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
  });
  it("T12 no stop, the child crashes during initialize: today's runtime.error plus exit_before_result [mutant: the arm drops fence.retired]", async () => {
    const engine = engineOf([], false, { exitOn: ["initialize"] });
    const { events } = await boot(engine).then(async ({ instance, events }) => { await send(instance); return { events }; });
    await waitFor(() => expect(completions(events).length).toBe(1));
    expect(types(events)).toContain("runtime.error");
    expect(completions(events)[0]?.stopReason).toBe("exit_before_result");
  });
  it("T15 a reset after the prompt is written (the turn keeps running), then the child crashes: today's runtime.error plus exit_before_result, not cancelled [mutant: the stopWasAsked fence arm without !state.promptSent]", async () => {
    const engine = engineOf(["session/prompt"], false, { exitOn: ["session/prompt"] });
    const { instance, events } = await boot(engine);
    await send(instance);
    await waitFor(() => expect(engine.hold("session/prompt")).toBe(true));
    await applyStop(instance, "reset", "t1"); // retires the thread (the fence reads retired) but never stops a turn whose prompt is already written
    engine.open("session_prompt");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types(events)).toContain("runtime.error");
    expect(completions(events)[0]?.stopReason).toBe("exit_before_result");
    expect(types(events).lastIndexOf("turn.completed")).toBe(events.length - 1);
  });
  it("T19 dispose while parked in auth (before start): rejects as the engine closing, no receipt [mutant: C1 uses !live() instead of retired()]", async () => {
    const engine = engineOf();
    let release!: (value: boolean) => void; let calls = 0;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const { instance, events } = await boot(engine, { requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false,
      isAuthenticated: () => (++calls === 1 ? held : true) });
    const outcome = send(instance).then(() => "resolved", (error: Error) => error.message);
    await waitFor(() => expect(calls).toBe(1));
    await instance.dispose();
    release(false);
    expect(await outcome).toContain("stopped");
    expect(completions(events)).toEqual([]);
    expect(engine.started()).toBe(false);
  });
  it("T20 a live fence never blocks the handshake writes: a plain send completes with one spawn [mutant: the writer refuses whenever !promptSent]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine);
    await send(instance);
    await waitFor(() => expect(completions(events).length).toBe(1));
    expect(completions(events)[0]?.stopReason).not.toBe("cancelled");
    expect(completions(events)[0]?.stopReason).not.toBe("exit_before_result");
    expect(engine.methods()).toEqual(expect.arrayContaining(["initialize", "session/new", "session/prompt"]));
  });
  it("T0a two real sends parked in auth: the second is refused busy, one spawn [mutant: admission ignores a pending send]", async () => {
    const engine = engineOf();
    let release!: (value: boolean) => void; let calls = 0;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const { instance, events } = await boot(engine, { requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false,
      isAuthenticated: () => (++calls === 1 ? held : true) });
    const first = send(instance);
    await waitFor(() => expect(calls).toBe(1));
    await expect(send(instance, "t1", "second")).rejects.toThrow("already running");
    release(true);
    await first;
    await waitFor(() => expect(completions(events).length).toBe(1));
    expect(engine.methods().filter((method) => method === "initialize")).toHaveLength(1);
    expect(calls).toBe(1);
  });
  it("T0h a completion listener sends again after an auth refusal and after a pre-spawn stop: admitted [mutant: release() after the emits]", async () => {
    for (const how of ["refusal", "stop"] as const) {
      const engine = engineOf();
      let release!: (value: boolean) => void; let calls = 0;
      const held = new Promise<boolean>((resolve) => { release = resolve; });
      const { instance, events } = await boot(engine, { requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false,
        isAuthenticated: () => { calls++; if (calls === 1) return held; return how === "stop" ? true : calls > 2; } });
      let again: Promise<unknown> | undefined;
      instance.adapter.onEvent((event) => { if ((event as Ev).type === "turn.completed" && !again) again = send(instance, "t1", "listener").then(() => "admitted", (error: Error) => error.message); });
      const first = send(instance);
      await waitFor(() => expect(calls).toBe(1));
      if (how === "stop") { await applyStop(instance, "reset", "t1"); release(true); } else release(false);
      await first;
      await waitFor(() => expect(again).toBeDefined());
      expect(await again).toBe("admitted");
      await waitFor(() => expect(completions(events).length).toBe(2));
    }
  });
  it("T3 REAL withScopeRetry, applyMountEnv busy, a reset in the backoff: applyMountEnv ran once, the stopped pair, no ScopeUnavailable [mutant: G3 dropped]", async () => {
    const engine = engineOf();
    const applyMountEnv = vi.fn(() => { throw new ScopeUnavailableError("busy", true); });
    const { instance, events } = await boot(engine, { scopeKind: "stop-fence-scope", applyMountEnv });
    const sent = send(instance);
    await waitFor(() => expect(applyMountEnv).toHaveBeenCalledTimes(1));
    await applyStop(instance, "reset", "t1");
    const { turnId } = await sent;
    expect(applyMountEnv).toHaveBeenCalledTimes(1);
    expect(engine.started()).toBe(false);
    applyMountEnv.mockImplementation(() => undefined as never);
    await afterStop(instance, engine, events, turnId);
  });
  it("T3b REAL withScopeRetry, applyMountEnv busy, dispose in the backoff: the send rejects with SendStoppedError (not the ScopeUnavailable wrapper), no local-setup failure, no completion, no spawn [mutant: F2-UNWRAP, the .catch dropped]", async () => {
    const engine = engineOf();
    const applyMountEnv = vi.fn(() => { throw new ScopeUnavailableError("busy", true); });
    const { instance, events } = await boot(engine, { scopeKind: "stop-fence-scope", applyMountEnv });
    const rejected = send(instance).then(() => undefined, (error: unknown) => error);
    await waitFor(() => expect(applyMountEnv).toHaveBeenCalledTimes(1));
    await instance.dispose();
    const error = await rejected;
    expect(error).toBeInstanceOf(SendStoppedError);
    expect(localSetupFailureOf(error)).toBeUndefined();
    expect(completions(events)).toEqual([]);
    expect(applyMountEnv).toHaveBeenCalledTimes(1);
    expect(engine.started()).toBe(false);
    expect(spawnSpy.n).toBe(0);
  });
  it("T4 a reset during awaitScopeStart, which then rejects with a plain Error: the stopped pair, the Error never surfaces [mutant: C1 rethrows instead of classifying]", async () => {
    const engine = engineOf();
    let rejectScope!: (error: Error) => void;
    scopeStart.impl = () => new Promise<void>((_, reject) => { rejectScope = reject; });
    const { instance, events } = await boot(engine, { scopeKind: "stop-fence-scope" });
    const sent = send(instance);
    await waitFor(() => expect(rejectScope).toBeDefined());
    await applyStop(instance, "reset", "t1");
    rejectScope(new Error("plain failure"));
    const { turnId } = await sent;
    scopeStart.impl = null;
    await afterStop(instance, engine, events, turnId);
  });
  it("T14 beforeSubmit resets synchronously: zero session/prompt bytes, notWritten once, cancelled [mutant: the pre-prompt halt check uses the pre-r3 turnHalted]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine);
    const notWritten = vi.fn();
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t1", text: "hello", model: "p/m", beforeSubmit: () => { void instance.adapter.resetSession?.("t1"); }, notWritten });
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(engine.methods()).not.toContain("session/prompt");
    expect(notWritten).toHaveBeenCalledTimes(1);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(types(events).at(-1)).toBe("turn.completed");
    expect(completions(events)).toHaveLength(1);
  });
  it("T16 Stop All: A parked in auth and B in the mount backoff end stopped with no spawn, and a send on a third thread then completes [mutant: stopAll omits fences.threads()]", async () => {
    const engine = engineOf();
    let release!: (value: boolean) => void; let authCalls = 0;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const mount = vi.fn((_env: unknown, ctx: { botId?: string }) => { if (ctx.botId === "bot-b") throw new ScopeUnavailableError("busy", true); });
    const { instance, events } = await boot(engine, { requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false, scopeKind: "stop-fence-scope", applyMountEnv: mount as never,
      isAuthenticated: () => (++authCalls === 1 ? held : true) });
    const a = send(instance, "A");
    await waitFor(() => expect(authCalls).toBe(1));
    const b = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "B", text: "hello", model: "p/m", warmIdentity: { botId: "bot-b" } } as never);
    await waitFor(() => expect(mount.mock.calls.filter((call) => call[1]?.botId === "bot-b").length).toBeGreaterThan(0));
    await instance.adapter.stopAll?.();
    release(true);
    await Promise.all([a, b]);
    expect(engine.started()).toBe(false);
    expect(completions(events)).toHaveLength(2);
    expect(completions(events).every((event) => event.stopReason === "cancelled")).toBe(true);
    await send(instance, "D");
    await waitFor(() => expect(completions(events).length).toBe(3));
    expect(completions(events)[2]?.stopReason).not.toBe("cancelled");
  });
});

// ---- prewarm, admission and the provider-route gate (D3) ----
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reclose = (e: FakeEngine, method: string) => { rmSync(e.gate(method), { force: true }); rmSync(join(e.root, `held-${method.replace(/\//g, "_")}`), { force: true }); };
const POOL_ENV = ["MURAGE_ACP_POOL", "MURAGE_ACP_POOL_IDLE_MS", "MURAGE_WARM_ACTIVITY_WINDOW_MS", "MURAGE_PREWARM_WAIT_MS", "MURAGE_PREWARM_TAKEOVER_MS"];
interface Holds { auth: Promise<boolean> | null; transformEnv: number; spawnArgs: number }
/** A pooled driver whose parked process has closed again (one real turn, then the idle timer): its next prewarm starts cold. Counters are zeroed after the warm-up turn. */
async function bootCold(engine: FakeEngine, extra: Parameters<typeof createFixture>[1] = {}, prewarmWaitMs = "100") {
  process.env.MURAGE_ACP_POOL = "1"; process.env.MURAGE_ACP_POOL_IDLE_MS = "150"; process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
  process.env.MURAGE_PREWARM_WAIT_MS = prewarmWaitMs; process.env.MURAGE_PREWARM_TAKEOVER_MS = "3000";
  const holds: Holds = { auth: null, transformEnv: 0, spawnArgs: 0 };
  const base = await boot(engine, { pooledSessions: true, requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false,
    isAuthenticated: () => { const held = holds.auth; holds.auth = null; return held ?? true; },
    transformEnv: () => { holds.transformEnv++; }, spawnArgs: () => { holds.spawnArgs++; return ["acp"]; }, ...extra });
  await send(base.instance);
  await waitFor(() => expect(completions(base.events).length).toBe(1));
  await tick(700);
  expect(warmPool.idleCount()).toBe(0);
  process.env.MURAGE_ACP_POOL_IDLE_MS = "60000";
  spawnSpy.n = 0; holds.transformEnv = 0; holds.spawnArgs = 0; hooks.takeOvers = 0; hooks.routeCalls = 0;
  return { ...base, holds, mark: base.events.length };
}
const heldAuth = (holds: Holds) => { let release!: (value: boolean) => void; holds.auth = new Promise<boolean>((resolve) => { release = resolve; }); return release; };
const holdTakeOver = () => { let free!: () => void; hooks.takeOverHold = new Promise<void>((resolve) => { free = resolve; }); return free; };
function expectStoppedSince(events: Ev[], mark: number, turnId: string) {
  const tail = events.slice(mark);
  expect(types(tail)).toEqual(STOPPED_PAIR);
  pairFor(tail, turnId);
  expect(completions(tail)[0]?.stopReason).toBe("cancelled");
}
async function freshSendCompletes(instance: ProviderInstance, events: Ev[], total: number) {
  await send(instance, "t1", "again");
  await waitFor(() => expect(completions(events).length).toBe(total));
  expect(completions(events)[total - 1]?.stopReason).not.toBe("cancelled");
}

describe("stop-fence r3.2 prewarm and admission", () => {
  beforeEach(() => { hooks.takeOvers = 0; hooks.takeOverHold = null; hooks.routeCalls = 0; hooks.routeImpl = null; hooks.handedCalls = 0; hooks.handedHold = null; });
  afterEach(() => { for (const name of POOL_ENV) delete process.env[name]; hooks.takeOverHold = null; hooks.handedHold = null; hooks.routeImpl = null; });

  it("T0b a real send while another real send is active is refused busy, one spawn [regression: :2539 also refuses]", async () => {
    const engine = engineOf(["session/prompt"]);
    const { instance, events } = await boot(engine);
    const first = send(instance);
    await waitFor(() => expect(engine.hold("session/prompt")).toBe(true));
    await expect(send(instance, "t1", "second")).rejects.toThrow("already running");
    engine.open("session_prompt");
    await first;
    await waitFor(() => expect(completions(events).length).toBe(1));
    expect(spawnSpy.n).toBe(1);
  });
  it("T0c a real send while another real send is inside its destination probe is refused busy, one spawn [regression: :2539 also refuses]", async () => {
    const engine = engineOf();
    let probing = false; let releaseProbe!: () => void;
    const { instance, events } = await boot(engine, { effectiveDestination: async () => { probing = true; await new Promise<void>((resolve) => { releaseProbe = resolve; }); return openCodeDestinationAnswer({}, { memoryOff: false }); } });
    const first = send(instance);
    await waitFor(() => expect(probing).toBe(true));
    await expect(send(instance, "t1", "second")).rejects.toThrow("already running");
    releaseProbe();
    await first;
    await waitFor(() => expect(completions(events).length).toBe(1));
    expect(spawnSpy.n).toBe(1);
  });
  it("T0e a real send over an active prewarm takes it over: the prewarm does not park, two spawns [regression]", async () => {
    const engine = engineOf(["initialize"]);
    engine.open("initialize");
    const { instance, events, holds, mark } = await bootCold(engine);
    reclose(engine, "initialize");
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    const real = send(instance, "t1", "real");
    await waitFor(() => expect(hooks.takeOvers).toBe(1));
    engine.open("initialize");
    await real;
    expect(await warming).toBe(false);
    await waitFor(() => expect(completions(events).length).toBe(2));
    expect(completions(events)[1]?.stopReason).not.toBe("cancelled");
    expect(spawnSpy.n).toBe(2);
    expect(holds.spawnArgs).toBe(2);
    expect(events.length).toBeGreaterThan(mark);
  });
  it("T0g two threads at once each start their own engine: two spawns, both complete [regression]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine);
    await Promise.all([send(instance, "t1"), send(instance, "t2")]);
    await waitFor(() => expect(completions(events).length).toBe(2));
    expect(spawnSpy.n).toBe(2);
  });
  it("T0f a prewarm over a real send parked in auth is refused: prewarm() false, spawnArgs never called by it, one spawn after release [mutant: admission admits a prewarm over a pending send]", async () => {
    const engine = engineOf();
    const { instance, events, holds } = await bootCold(engine);
    const release = heldAuth(holds);
    const first = send(instance, "t1", "real");
    await waitFor(() => expect(holds.auth).toBeNull());
    expect(await instance.adapter.prewarm!("t1")).toBe(false);
    expect(holds.spawnArgs).toBe(0);
    release(true);
    await first;
    await waitFor(() => expect(completions(events).length).toBe(2));
    expect(spawnSpy.n).toBe(1);
    expect(holds.spawnArgs).toBe(1);
  });
  it("T1 a stop during the prewarm wait: takeOver is never called, the stopped pair [mutant: G1 dropped]", async () => {
    const engine = engineOf();
    const { instance, events, holds, mark } = await bootCold(engine, {}, "400");
    const release = heldAuth(holds);
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(holds.auth).toBeNull());
    const real = send(instance, "t1", "real");
    await tick(100);
    await applyStop(instance, "reset", "t1");
    const { turnId } = await real; // the wait runs out (false) after the stop landed in it
    release(true);
    await warming;
    expect(hooks.takeOvers).toBe(0);
    expect(spawnSpy.n).toBe(0);
    expectStoppedSince(events, mark, turnId);
    await freshSendCompletes(instance, events, 3);
  });
  it("T26a a stop while takeOver is held (then frees): transformEnv ran only for the prewarm, no spawn, the stopped pair [mutant: G11 dropped]", async () => {
    const engine = engineOf();
    const { instance, events, holds, mark } = await bootCold(engine);
    const release = heldAuth(holds);
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(holds.auth).toBeNull());
    expect(holds.transformEnv).toBe(1);
    const free = holdTakeOver();
    const real = send(instance, "t1", "real");
    await waitFor(() => expect(hooks.takeOvers).toBe(1));
    await applyStop(instance, "reset", "t1");
    release(true);
    await warming;
    free();
    const { turnId } = await real;
    expect(holds.transformEnv).toBe(1);
    expect(spawnSpy.n).toBe(0);
    expectStoppedSince(events, mark, turnId);
    await freshSendCompletes(instance, events, 3);
  });
  it("T26b the prewarm ends during prewarming.wait (true) and the stop lands in that wait: transformEnv only by the prewarm, no spawn, the stopped pair [mutant: G11 dropped]", async () => {
    const engine = engineOf();
    const { instance, events, holds, mark } = await bootCold(engine, {}, "20000");
    const release = heldAuth(holds);
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(holds.auth).toBeNull());
    const real = send(instance, "t1", "real");
    await tick(100);
    await applyStop(instance, "reset", "t1");
    release(true); // the prewarm ends, the wait resolves true
    const [{ turnId }] = await Promise.all([real, warming]);
    expect(hooks.takeOvers).toBe(0);
    expect(holds.transformEnv).toBe(1);
    expect(spawnSpy.n).toBe(0);
    expectStoppedSince(events, mark, turnId);
    await freshSendCompletes(instance, events, 3);
  });
  it("G11 provider-routed real send, takeOver held, then a reset: applyProviderRoute is never called, no spawn, the stopped pair [mutant: applyProviderRoute moved before the G11 check]", async () => {
    const engine = engineOf();
    const { instance, events, holds, mark } = await bootCold(engine);
    const release = heldAuth(holds);
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(holds.auth).toBeNull());
    const free = holdTakeOver();
    const route = { apiKey: "k", connectionId: "c", revision: "1", model: "p/m", baseUrl: "https://example.invalid/v1", preset: "openai", protocol: "openai" };
    const real = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t1", text: "real", model: "p/m", providerRoute: route } as never);
    await waitFor(() => expect(hooks.takeOvers).toBe(1));
    await applyStop(instance, "reset", "t1");
    release(true);
    await warming;
    free();
    const { turnId } = await real;
    expect(hooks.routeCalls).toBe(0);
    expect(spawnSpy.n).toBe(0);
    expectStoppedSince(events, mark, turnId);
  });
  it.each(["never settles unless aborted", "rejects on abort", "resolves 100 ms after abort"] as const)("T0i a real send over a prewarm inside its destination probe, the probe %s: the probe is aborted, one spawn, no busy error [mutant: cancelPrewarm leaves the probe running]", async (mode) => {
    const engine = engineOf();
    let aborted = false; let probes = 0; let armed = false;
    const { instance, events, holds } = await bootCold(engine, { effectiveDestination: async (ctx: { signal: AbortSignal }) => {
      if (armed && ++probes === 1) { // the prewarm's probe (the warm-up turn's probe ran before `armed`)
        await new Promise<void>((resolve, reject) => ctx.signal.addEventListener("abort", () => {
          aborted = true;
          if (mode === "rejects on abort") reject(new Error("probe aborted")); else if (mode === "resolves 100 ms after abort") setTimeout(resolve, 100); else resolve();
        }, { once: true }));
      }
      return openCodeDestinationAnswer({}, { memoryOff: false });
    } } as never);
    armed = true;
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(probes).toBe(1));
    const real = send(instance, "t1", "real");
    await real;
    expect(aborted).toBe(true);
    expect(await warming).toBe(false);
    await waitFor(() => expect(completions(events).length).toBe(2));
    expect(completions(events)[1]?.stopReason).not.toBe("cancelled");
    expect(spawnSpy.n).toBe(1);
    expect(holds.spawnArgs).toBe(1);
  });
});

const agentsMcp = () => ({ agents: { command: process.execPath, args: ["--never-started"], env: { MURAGE_COMMS_TOKEN: `turn-${Math.random()}` } } }) as never;

describe("stop-fence r3.2 pooled, reuse and reconnect", () => {
  afterEach(() => { for (const name of POOL_ENV) delete process.env[name]; delete process.env.MURAGE_PROVIDER_CLOSE_MS; delete process.env.MURAGE_MCP_RECONNECT_WAIT_MS; });

  it("T16C Stop All: C parked idle in the pool is closed, A parked in auth ends stopped with no spawn, and D's next send completes [no mutant claimed: the pooled thread's epoch bump has no reader, see the pack]", async () => {
    process.env.MURAGE_ACP_POOL = "1"; process.env.MURAGE_ACP_POOL_IDLE_MS = "60000";
    const engine = engineOf([], false, { reply: true });
    let calls = 0; let release!: (value: boolean) => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const { instance, events } = await boot(engine, { pooledSessions: true, requireAuthenticationBeforeSpawn: true, mayRunUnauthenticated: () => false,
      isAuthenticated: () => (++calls === 2 ? held : true) });
    await send(instance, "C");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await waitFor(() => expect(warmPool.idleCount()).toBe(1));
    const a = send(instance, "A");
    await waitFor(() => expect(calls).toBe(2));
    await instance.adapter.stopAll?.();
    release(true);
    await a;
    await waitFor(() => expect(warmPool.idleCount()).toBe(0));
    expect(spawnSpy.n).toBe(1);
    expect(completions(events).map((event) => event.stopReason)).toEqual(expect.arrayContaining(["cancelled"]));
    const before = completions(events).length;
    await send(instance, "D");
    await waitFor(() => expect(completions(events).length).toBe(before + 1));
    expect(completions(events).at(-1)?.stopReason).not.toBe("cancelled");
    expect(spawnSpy.n).toBe(2);
  });

  it("T8 a reset during the reused process's session/load, which answers null: no new child, cancelled [mutant: G8 dropped]", async () => {
    process.env.MURAGE_ACP_POOL = "1"; process.env.MURAGE_ACP_POOL_IDLE_MS = "60000";
    const engine = engineOf(["session/load"], false, { nullOn: ["session/load"], reply: true });
    const { instance, events } = await boot(engine, { pooledSessions: true });
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t1", text: "one", model: "p/m", integrations: agentsMcp() });
    await waitFor(() => expect(completions(events).length).toBe(1));
    await waitFor(() => expect(warmPool.idleCount()).toBe(1));
    const mark = events.length;
    const second = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t1", text: "two", model: "p/m", resumeCursor: "s1", integrations: agentsMcp() });
    await waitFor(() => expect(engine.hold("session/load")).toBe(true));
    await applyStop(instance, "reset", "t1");
    engine.open("session_load");
    const { turnId } = await second;
    await tick(600);
    expect(spawnSpy.n, "the reused process was not replaced by a new child").toBe(1);
    expect(types(events.slice(mark))).toEqual(STOPPED_PAIR);
    pairFor(events.slice(mark), turnId);
    expect(completions(events.slice(mark))[0]?.stopReason).toBe("cancelled");
    expect(events.slice(mark).some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("T13 dispose during the MCP reconnect loop's 250 ms sleep while a second child's close is unconfirmed: exactly one runtime.error, nothing after turn.completed [mutant: settleHalted without its settled guard]", async () => {
    process.env.MURAGE_PROVIDER_CLOSE_MS = "2500"; process.env.MURAGE_MCP_RECONNECT_WAIT_MS = "6000";
    const engine = engineOf(["session/prompt"], false, { mcpList: true });
    const { instance, events } = await boot(engine, { mcpListMethod: "_fixture/mcp_list",
      spawnArgs: (_config: unknown, turn: { threadId: string }) => (turn.threadId === "t2" ? ["acp", "--stubborn"] : ["acp"]) } as never);
    await send(instance, "t2"); // holds in session/prompt on a child that ignores SIGTERM: its close stays unconfirmed during the dispose
    await waitFor(() => expect(engine.hold("session/prompt")).toBe(true));
    const one = instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t1", text: "one", model: "p/m", integrations: agentsMcp() });
    await waitFor(() => expect(engine.methods().filter((method) => method === "session/load").length).toBeGreaterThan(0));
    const disposing = instance.dispose();
    await Promise.race([one.catch(() => undefined), tick(4000)]);
    await tick(800);
    const t1 = events.filter((event) => (event as { threadId?: string }).threadId === "t1");
    expect(t1.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    const last = t1.map((event) => event.type).lastIndexOf("turn.completed");
    expect(last).toBeGreaterThanOrEqual(0);
    expect(t1.length - 1).toBe(last);
    engine.open("session_prompt");
    await disposing.catch(() => undefined);
    instances.splice(0);
  });
});

// D7 (MurageMain ruling ~15:20Z): a reset before the prompt, then a late child error or an oversized frame, or a reset after the prompt and the Fuigo watchdog.
describe("stop-fence D7: a reset, then a late child event", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const acpChild = () => spawnSpy.last as unknown as import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>;
  const settleAndCheck = async (events: Ev[], turnId: string) => {
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)).toHaveLength(1);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
  };
  it("T29a a reset during initialize, then the child reports an async error: the stopped receipt once, no runtime.error, not spawn_error [mutant: the G14 child-error guard dropped]", async () => {
    const engine = engineOf(["initialize"]);
    const { instance, events } = await boot(engine);
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    await applyStop(instance, "reset", "t1");
    acpChild().emit("error", Object.assign(new Error("spawn fixture ENOENT"), { code: "ENOENT" }));
    await settleAndCheck(events, turnId);
    engine.open("initialize");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
  });
  it("T29b a reset during initialize, then an oversized frame: the stopped receipt once, no runtime.error, not FRAME_TOO_LARGE [mutant: the G15 overflow guard dropped]", async () => {
    const engine = engineOf(["initialize"]);
    const { instance, events } = await boot(engine);
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    await applyStop(instance, "reset", "t1");
    acpChild().stdout.emit("data", Buffer.alloc(33 * 1024 * 1024, 97));
    await settleAndCheck(events, turnId);
    engine.open("initialize");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
  });
  it("T29c Fuigo, a reset after the prompt is written, the engine then stays silent: the watchdog still ends the turn once (one runtime.error, one completion), nothing after [mutant: turnHalted drops !state.promptSent]", async () => {
    vi.stubEnv("MURAGE_FUIGO_SILENT_MS", "400");
    const engine = engineOf(["session/prompt"]);
    const { instance, events } = await boot(engine, { driverKind: "fuigoAgent" });
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("session/prompt")).toBe(true));
    await applyStop(instance, "reset", "t1");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(completions(events)).toHaveLength(1);
    expect(completions(events)[0]?.stopReason).toBe("no_first_response");
    expect(completions(events)[0]?.turnId).toBe(turnId);
    const errors = events.filter((event) => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.turnId).toBe(turnId);
    expect(events.indexOf(errors[0]!)).toBeLessThan(events.indexOf(completions(events)[0]!));
    expect(types(events).filter((type) => type === "runtime.error")).toHaveLength(1);
    expect(types(events).lastIndexOf("turn.completed")).toBe(events.length - 1);
  });
});
