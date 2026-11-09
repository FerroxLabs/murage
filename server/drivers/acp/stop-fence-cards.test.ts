// STOP-FENCE (1.0.18) r3.2 card and Fuigo-seed tests: T18a-d, T21, T22, T23, T24, T25, T28 (T27 is intentionally unused). Helpers are copied from stop-fence.test.ts
// (that file belongs to driver D3). A "mutant" in a title names the one edit that turns the test red with all other code intact.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { QUESTION_TIMEOUT_MS } from "../../../shared/questions.ts";
import { openCodeDestinationAnswer } from "../../opencode-destination.ts";
import { applyStop, cleanupEngine, createFixture, waitFor, type FakeEngine, type StopAction } from "./stop-fence-harness.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";

const hooks = vi.hoisted(() => ({
  spawns: 0, spawnThrow: false, cleanups: 0, seedCalls: 0,
  seed: null as null | (() => Promise<unknown>), cloudHome: false,
  handed: null as null | Promise<void>,
  tree: null as null | Promise<void>, treeEntered: 0,
}));
vi.mock("../../procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
    hooks.spawns++;
    if (hooks.spawnThrow) { hooks.spawnThrow = false; throw new Error("fixture spawn failure"); }
    return actual.spawnCli(...args);
  } };
});
// a pass-through that counts how many times the provider home was cleaned up
vi.mock("../../provider-routing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../provider-routing.ts")>();
  return { ...actual, applyProviderRoute: (...args: Parameters<typeof actual.applyProviderRoute>) => {
    const binding = actual.applyProviderRoute(...args);
    const real = binding.cleanup;
    binding.cleanup = () => { hooks.cleanups++; real(); };
    return binding;
  } };
});
vi.mock("../../folder-trust-seed.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../folder-trust-seed.ts")>();
  return { ...actual, cloudUnroutedFuigoHome: (...args: Parameters<typeof actual.cloudUnroutedFuigoHome>) => (hooks.cloudHome ? { path: "/tmp/stop-fence-cloud-home/.fuigo", cloud: true as const } : actual.cloudUnroutedFuigoHome(...args)), seedFuigoHome: (...args: Parameters<typeof actual.seedFuigoHome>) => { hooks.seedCalls++; return hooks.seed ? (hooks.seed() as ReturnType<typeof actual.seedFuigoHome>) : actual.seedFuigoHome(...args); } };
});
vi.mock("../../engine-env.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine-env.ts")>();
  return { ...actual, handedEngineEnv: async (...args: Parameters<typeof actual.handedEngineEnv>) => {
    const gate = hooks.handed;
    if (gate) { hooks.handed = null; await gate; }
    return actual.handedEngineEnv(...args);
  } };
});
vi.mock("../process-tree.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process-tree.ts")>();
  return { ...actual, untrackedIdentified: async (...args: Parameters<typeof actual.untrackedIdentified>) => {
    hooks.treeEntered++;
    if (hooks.tree) await hooks.tree;
    return actual.untrackedIdentified(...args);
  } };
});

// Fake ACP engine (copy of the harness engine plus a scripted session/new result). Every received method is appended to methods.log.
interface CardEngineOpts { errorOn?: string[]; exitOn?: string[]; newResult?: unknown }
function makeCardEngine(holdMethods: string[] = [], opts: CardEngineOpts = {}): FakeEngine {
  const root = mkdtempSync(join(tmpdir(), "stop-fence-cards-"));
  const cli = join(root, "engine.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const R = ${JSON.stringify(root)}, HOLD = new Set(${JSON.stringify(holdMethods)}), ERR = new Set(${JSON.stringify(opts.errorOn ?? [])}), EXIT = new Set(${JSON.stringify(opts.exitOn ?? [])});
const NEW = ${JSON.stringify(opts.newResult ?? { sessionId: "s1" })};
const wait = async name => { while (!existsSync(R + "/gate-" + name)) await new Promise(r => setTimeout(r, 20)); };
if (process.argv.includes("--version")) { console.log("1.19.4"); process.exit(0); }
writeFileSync(R + "/started", "x");
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m.method) return;
  appendFileSync(R + "/methods.log", m.method + "\\n");
  if (HOLD.has(m.method)) { writeFileSync(R + "/held-" + m.method.replace(/\\//g, "_"), "x"); await wait(m.method.replace(/\\//g, "_")); }
  if (EXIT.has(m.method)) process.exit(1);
  if (ERR.has(m.method)) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "fixture failure" } }); return; }
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (m.method === "session/new") out({ jsonrpc: "2.0", id: m.id, result: NEW });
  else if (m.method === "session/prompt") { out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }); out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
setInterval(() => {}, 1000);
`);
  chmodSync(cli, 0o755);
  return {
    root, cli,
    gate: (name) => join(root, `gate-${name}`),
    open: (name) => writeFileSync(join(root, `gate-${name}`), "open"),
    started: () => existsSync(join(root, "started")),
    methods: () => (existsSync(join(root, "methods.log")) ? readFileSync(join(root, "methods.log"), "utf8").split("\n").filter(Boolean) : []),
    hold: (name) => existsSync(join(root, `held-${name.replace(/\//g, "_")}`)),
  };
}

const engines: FakeEngine[] = [];
const instances: ProviderInstance[] = [];
const engineOf = (...args: Parameters<typeof makeCardEngine>) => { const e = makeCardEngine(...args); engines.push(e); return e; };
let folder = "";
beforeEach(() => {
  hooks.spawns = 0; hooks.spawnThrow = false; hooks.cleanups = 0; hooks.seedCalls = 0; hooks.seed = null; hooks.cloudHome = false; hooks.handed = null; hooks.tree = null; hooks.treeEntered = 0;
  folder = mkdtempSync(join(tmpdir(), "stop-fence-folder-"));
  writeFileSync(join(folder, "AGENTS.md"), "# project\n");
});
afterEach(async () => {
  vi.useRealTimers();
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const engine of engines.splice(0)) cleanupEngine(engine);
  rmSync(folder, { recursive: true, force: true });
  delete process.env.MURAGE_ACP_POOL; delete process.env.MURAGE_ACP_POOL_IDLE_MS; delete process.env.MURAGE_CLOUD_ROLE;
});
type Ev = { type: string; threadId?: string; stopReason?: string; requestId?: string; message?: string; turnId?: string };
async function boot(engine: FakeEngine, extra: Parameters<typeof createFixture>[1] = {}) {
  ensureDirs();
  const instance = await createFixture(engine, extra);
  instances.push(instance);
  const events: Ev[] = [];
  instance.adapter.onEvent((event) => { events.push(event as Ev); });
  return { instance, events };
}
const send = (instance: ProviderInstance, threadId = "t1", text = "hello") => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, model: "p/m" });
const types = (events: Ev[], threadId?: string) => events.filter((event) => !threadId || event.threadId === threadId).map((event) => event.type);
const completions = (events: Ev[], threadId?: string) => events.filter((event) => event.type === "turn.completed" && (!threadId || event.threadId === threadId));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STOPPED_PAIR = ["turn.started", "turn.completed"];
/** The pair belongs to the turn the send returned: one start and one completion, both with that turnId and thread, in order (a receipt under another id is a bug). */
function pairFor(events: Ev[], turnId: string, threadId = "t1") {
  expect(events.filter((e) => e.type === "turn.started" || e.type === "turn.completed").map((e) => [e.type, e.turnId, e.threadId])).toEqual([["turn.started", turnId, threadId], ["turn.completed", turnId, threadId]]);
}
/** The common tail of a stop that landed before any spawn: the pair is the whole story, nothing follows it, and the thread takes a fresh send. */
async function afterStop(instance: ProviderInstance, engine: FakeEngine, events: Ev[], turnId: string, threadId = "t1") {
  await sleep(600);
  expect(engine.started(), "no engine was spawned after the stop").toBe(false);
  expect(hooks.spawns, "spawnCli was never called").toBe(0);
  expect(types(events)).toEqual(STOPPED_PAIR);
  pairFor(events, turnId, threadId);
  expect(completions(events)[0]?.stopReason).toBe("cancelled");
  await send(instance, threadId, "again");
  await waitFor(() => expect(completions(events).length).toBe(2));
  expect(completions(events)[1]?.stopReason).not.toBe("cancelled");
}
const route = { connectionId: "conn-1", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", revision: "r1" } as const;
const providerHomes = () => { const dir = join(NATIVE_DIR, "provider-turns"); return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("fuigoAgent-")) : []; };
const trustSpawnArgs = (_config: unknown, _turn: unknown, ctx?: { folderTrusted?: boolean }) => [...(ctx?.folderTrusted ? ["--trust"] : []), "acp"];
const answerCard = (instance: ProviderInstance, threadId: string, requestId: string) =>
  (instance.adapter as unknown as { respondToRequest(t: string, r: string, a: unknown): Promise<unknown> }).respondToRequest(threadId, requestId, {
    behavior: "answer", message: "Trust this folder", answers: [{ id: "folderTrust", selected: ["Trust this folder"] }] });
const seedOutcome = (policySeeded: boolean) => ({ trusts: [], declines: [], declineSkipped: false, policySeeded, declinesSeeded: true, chipKey: null });

describe("stop-fence r3.2 cards: the provider home and the card gate", () => {
  const cardTurn = (extra: Record<string, unknown> = {}) => ({ threadId: "c1", text: "go", cwd: folder, providerRoute: route, folderTrust: { key: folder, folder, sources: ["AGENTS.md"] }, ...extra }) as never;
  const trustDriver = { driverKind: "fuigoAgent", folderTrust: true, spawnArgs: trustSpawnArgs } as const;
  it("T18a a card turn answered Trust: the home lives until the child closes, then is cleaned once [mutant: handOff missing]", async () => {
    const engine = engineOf(["session/new"]);
    const { instance, events } = await boot(engine, trustDriver);
    const before = providerHomes();
    await instance.adapter.sendTurn(cardTurn());
    await waitFor(() => expect(events.some((event) => event.type === "request.opened")).toBe(true));
    expect(hooks.cleanups, "the card is open: nothing cleaned yet").toBe(0);
    expect(providerHomes().length).toBe(before.length + 1);
    await answerCard(instance, "c1", events.find((event) => event.type === "request.opened")!.requestId!);
    await waitFor(() => expect(engine.hold("session/new")).toBe(true));
    expect(hooks.cleanups, "the child is running: the home lives").toBe(0);
    expect(providerHomes().length).toBe(before.length + 1);
    engine.open("session_new");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await waitFor(() => expect(hooks.cleanups).toBe(1));
    expect(providerHomes()).toEqual(before);
    await sleep(300);
    expect(hooks.cleanups).toBe(1);
  });
  it("T18b a Stop while the card is open: the home is cleaned once, the stopped pair, no spawn [mutant: handOff missing]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine, trustDriver);
    const before = providerHomes();
    await instance.adapter.sendTurn(cardTurn());
    await waitFor(() => expect(events.some((event) => event.type === "request.opened")).toBe(true));
    expect(hooks.cleanups, "the card is open: nothing cleaned yet").toBe(0);
    await instance.adapter.interruptTurn("c1");
    await waitFor(() => expect(completions(events).length).toBe(1));
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(hooks.cleanups).toBe(1);
    expect(providerHomes()).toEqual(before);
    expect(engine.started()).toBe(false);
    expect(hooks.spawns).toBe(0);
  });
  it("T18c a card nobody answers: the home is cleaned once when the question times out [mutant: handOff missing]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine, trustDriver);
    const before = providerHomes();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await instance.adapter.sendTurn(cardTurn({ unattendedAskNote: true }));
    expect(providerHomes().length).toBe(before.length + 1);
    expect(hooks.cleanups, "the card is open: nothing cleaned yet").toBe(0);
    vi.advanceTimersByTime(QUESTION_TIMEOUT_MS);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(hooks.cleanups).toBe(1);
    expect(providerHomes()).toEqual(before);
    vi.useRealTimers();
    expect(engine.started()).toBe(false);
  });
  it("T18d a provider-routed NON-card turn whose spawnCli throws synchronously: the home is cleaned exactly once [mutant: once() dropped]", async () => {
    const engine = engineOf();
    const { instance } = await boot(engine, { driverKind: "fuigoAgent" });
    const before = providerHomes();
    hooks.spawnThrow = true;
    const outcome = await instance.adapter.sendTurn({ threadId: "d1", text: "go", cwd: folder, providerRoute: route } as never).then(() => "resolved", (error: Error) => error.message);
    expect(outcome).toContain("fixture spawn failure");
    expect(hooks.spawns).toBe(1);
    expect(hooks.cleanups, "the launch catch and the fence end both reach the cleanup").toBe(1);
    expect(providerHomes()).toEqual(before);
  });
  it("T17 a provider-routed CARD turn stopped at the handedEngineEnv await: the card gate refuses, the home is cleaned once and its directory is gone [mutant: own() dropped]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine, trustDriver);
    const before = providerHomes();
    let release!: () => void;
    hooks.handed = new Promise<void>((resolve) => { release = resolve; });
    const sent = instance.adapter.sendTurn(cardTurn({ threadId: "t1" }));
    await sleep(400);
    expect(providerHomes().length).toBe(before.length + 1);
    await applyStop(instance, "reset", "t1");
    release();
    const { turnId } = await sent;
    await sleep(400);
    expect(hooks.cleanups).toBe(1);
    expect(providerHomes()).toEqual(before);
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(engine.started()).toBe(false);
    expect(hooks.spawns).toBe(0);
  });
  it("T6 a card turn with sessionReset true, a reset while the card is open, then answer Trust: spawnArgs and onSessionReset never run, cancelled, one turn.started, no spawn_error [mutants: L0 dropped; the card catch line dropped]", async () => {
    const engine = engineOf();
    const onSessionReset = vi.fn();
    const spawnArgs = vi.fn(trustSpawnArgs);
    const { instance, events } = await boot(engine, { folderTrust: true, spawnArgs, onSessionReset });
    await instance.adapter.sendTurn({ threadId: "t1", text: "go", cwd: folder, model: "p/m", sessionReset: true, folderTrust: { key: folder, folder, sources: ["AGENTS.md"] } } as never);
    await waitFor(() => expect(events.some((event) => event.type === "request.opened")).toBe(true));
    await applyStop(instance, "reset", "t1");
    await answerCard(instance, "t1", events.find((event) => event.type === "request.opened")!.requestId!).catch(() => undefined);
    await sleep(600);
    expect(spawnArgs).not.toHaveBeenCalled();
    expect(onSessionReset).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(completions(events)).toHaveLength(1);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(engine.started()).toBe(false);
    expect(hooks.spawns).toBe(0);
  });
  it.each<StopAction>(["reset", "stopAll"])("T21 a card turn with handedEngineEnv held, then a %s: no card opens, the stopped pair [mutant: G5 dropped]", async (action) => {
    const engine = engineOf();
    const { instance, events } = await boot(engine, { folderTrust: true, spawnArgs: trustSpawnArgs });
    let release!: () => void;
    hooks.handed = new Promise<void>((resolve) => { release = resolve; });
    const sent = instance.adapter.sendTurn({ threadId: "t1", text: "go", cwd: folder, model: "p/m", folderTrust: { key: folder, folder, sources: ["AGENTS.md"] } } as never);
    await sleep(400);
    expect(events).toEqual([]);
    await applyStop(instance, action, "t1");
    release();
    const { turnId } = await sent;
    expect(events.filter((event) => event.type === "request.opened")).toEqual([]);
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    await afterStop(instance, engine, events, turnId);
  });
});

describe("stop-fence r3.2 cards: session setup, the Ask switch and the destination probe", () => {
  const modelReply = (current: string) => ({ sessionId: "s1", configOptions: [{ id: "model", currentValue: current }] });
  it("T22a a reset while session/new is held, the reply names another model so set_config_option hits the writer: exactly the stopped pair, no session.started [mutant: the M2 clause dropped]", async () => {
    const engine = engineOf(["session/new"], { newResult: modelReply("p/other") });
    const { instance, events } = await boot(engine, { selectModel: { configId: "model" } });
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("session/new")).toBe(true));
    await applyStop(instance, "reset", "t1");
    engine.open("session_new");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await sleep(400);
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(engine.methods()).toEqual(["initialize", "session/new"]);
  });
  it("T22b a reset while session/new is held, the reply needs no further call: cancelled, no session.started [mutant: the fence clause dropped]", async () => {
    const engine = engineOf(["session/new"], { newResult: modelReply("p/m") });
    const { instance, events } = await boot(engine, { selectModel: { configId: "model" } });
    const { turnId } = await send(instance);
    await waitFor(() => expect(engine.hold("session/new")).toBe(true));
    await applyStop(instance, "reset", "t1");
    engine.open("session_new");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await sleep(400);
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(engine.methods()).toEqual(["initialize", "session/new"]);
  });
  it("T22c no stop, the child crashes while set_config_option is pending: today runtime.error and exit_before_result, no session.started after turn.completed [mutant: the state.settled clause dropped]", async () => {
    const engine = engineOf([], { newResult: modelReply("p/other"), exitOn: ["session/set_config_option"] });
    const { instance, events } = await boot(engine, { selectModel: { configId: "model" } });
    await send(instance);
    await waitFor(() => expect(completions(events).length).toBe(1));
    await sleep(400);
    expect(types(events)).toContain("runtime.error");
    expect(completions(events)[0]?.stopReason).toBe("exit_before_result");
    expect(types(events).at(-1)).toBe("turn.completed");
    expect(types(events)).not.toContain("session.started");
  });
  it("T23 an Ask turn, a reset while session/new is held, then release: the Ask switch never runs, the stopped pair [mutant: G9 dropped]", async () => {
    const engine = engineOf(["session/new"]);
    const apply = vi.fn(async () => undefined);
    const { instance, events } = await boot(engine, { askStop: { apply } });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t1", text: "hello", model: "p/m", askLevel: true } as never);
    await waitFor(() => expect(engine.hold("session/new")).toBe(true));
    await applyStop(instance, "reset", "t1");
    engine.open("session_new");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await sleep(400);
    expect(apply).not.toHaveBeenCalled();
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
    expect(engine.methods()).toEqual(["initialize", "session/new"]);
  });
  const probeSupport = (resolveAfterMs: number | null) => {
    let entered = 0; let aborted = false;
    return { entered: () => entered, extra: { effectiveDestination: (ctx: { signal: AbortSignal }) => aborted ? Promise.resolve(openCodeDestinationAnswer({}, { model: "p/m", memoryOff: true })) : new Promise((resolve, reject) => {
      entered++;
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
        if (resolveAfterMs === null) reject(new Error("stopped"));
        else setTimeout(() => resolve(openCodeDestinationAnswer({}, { model: "p/m", memoryOff: true })), resolveAfterMs);
      }, { once: true });
    }) as never } };
  };
  it.each([["a", null], ["b", 100]] as const)("T24%s a dispose during the destination probe (%s): the send rejects as the engine closing, no receipt, no spawn [mutant: the dispose loop calls retireThread]", async (_name, resolveAfterMs) => {
    const engine = engineOf();
    const probe = probeSupport(resolveAfterMs);
    const { instance, events } = await boot(engine, probe.extra);
    const outcome = send(instance).then(() => "resolved", (error: Error) => error.message);
    await waitFor(() => expect(probe.entered()).toBe(1));
    await instance.dispose().catch(() => undefined); // a probe that rejects on abort makes dispose reject too (stopAllOwned rethrows it, unchanged from base)
    expect(await outcome).toContain("stopped");
    expect(completions(events)).toEqual([]);
    expect(types(events)).toEqual([]);
    expect(engine.started()).toBe(false);
    expect(hooks.spawns).toBe(0);
  });
  it("T24c a Stop All during the destination probe, which rejects on abort: the stopped pair, no spawn [regression, no mutant claimed]", async () => {
    const engine = engineOf();
    const probe = probeSupport(null);
    const { instance, events } = await boot(engine, probe.extra);
    const sent = send(instance);
    await waitFor(() => expect(probe.entered()).toBe(1));
    await instance.adapter.stopAll?.().catch(() => undefined); // see T24a: stopAllOwned rethrows the probe rejection
    const { turnId } = await sent;
    await afterStop(instance, engine, events, turnId);
  });
});

describe("stop-fence r3.2 Fuigo seed: finishTurnEnv and onFolderPolicyApplied", () => {
  const fuigo = (extra: Record<string, unknown> = {}) => ({ driverKind: "fuigoAgent", folderTrust: true, folderTrustGeneration: () => 2 as const, spawnArgs: vi.fn(() => ["acp"]), finishTurnEnv: vi.fn(), ...extra }) as never;
  const trusted = (fromRecord: boolean) => ({ key: folder, folder, sources: [] as string[], decision: "trust", fromRecord });
  /** Park t1 (a finished pooled turn whose park check is held), then start t2 and hold it at the pending-check wait (core.ts parkCheck). */
  async function heldAtParkCheck(engine: FakeEngine, extra: Record<string, unknown>, turn2: Record<string, unknown>) {
    process.env.MURAGE_ACP_POOL = "1"; process.env.MURAGE_ACP_POOL_IDLE_MS = "600000";
    let releaseTree!: () => void;
    hooks.tree = new Promise<void>((resolve) => { releaseTree = resolve; });
    const { instance, events } = await boot(engine, { pooledSessions: true, ...extra });
    await send(instance, "t1");
    await waitFor(() => expect(completions(events, "t1").length).toBe(1));
    await waitFor(() => expect(hooks.treeEntered).toBeGreaterThan(0));
    const spawnsBefore = hooks.spawns;
    const sent = instance.adapter.sendTurn({ threadId: "t2", text: "second", cwd: folder, model: "p/m", ...turn2 } as never);
    await sleep(400);
    expect(types(events, "t2")).toEqual([]);
    return { instance, events, spawnsBefore, finish: async () => { await applyStop(instance, "reset", "t2"); releaseTree(); hooks.tree = null; const { turnId } = await sent; await sleep(500); return turnId; } };
  }
  it("T25a a fresh Fuigo home, generation 2, a reset while the seed is held and then resolves policySeeded false: finishTurnEnv never runs, no spawnArgs, the stopped pair [mutant: G10 dropped]", async () => {
    const engine = engineOf();
    const support = fuigo();
    const { instance, events } = await boot(engine, support);
    let release!: () => void;
    hooks.seed = () => new Promise((resolve) => { release = () => resolve(seedOutcome(false)); });
    const sent = instance.adapter.sendTurn({ threadId: "t1", text: "go", cwd: folder, providerRoute: route, folderTrust: trusted(true) } as never);
    await waitFor(() => expect(hooks.seedCalls).toBe(1));
    await applyStop(instance, "reset", "t1");
    release();
    const { turnId } = await sent;
    await sleep(500);
    expect((support as { finishTurnEnv: ReturnType<typeof vi.fn> }).finishTurnEnv).not.toHaveBeenCalled();
    expect((support as { spawnArgs: ReturnType<typeof vi.fn> }).spawnArgs).not.toHaveBeenCalled();
    hooks.seed = null;
    await afterStop(instance, engine, events, turnId);
  });
  it("T0d a real send over a prewarm held inside seedFuigoHome: the prewarm never calls spawnArgs, the real seed starts only after the prewarm seed resolves, one more spawn [mutants: cancelPrewarm does not kill; cancelPrewarm ends the gate at once]", async () => {
    process.env.MURAGE_ACP_POOL = "1"; process.env.MURAGE_ACP_POOL_IDLE_MS = "150"; process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
    process.env.MURAGE_PREWARM_WAIT_MS = "100"; process.env.MURAGE_PREWARM_TAKEOVER_MS = "3000";
    hooks.cloudHome = true;
    const engine = engineOf();
    const spawnArgs = vi.fn(() => ["acp"]);
    const { instance, events } = await boot(engine, fuigo({ pooledSessions: true, spawnArgs }));
    const order: string[] = [];
    hooks.seed = async () => { order.push("seed"); return seedOutcome(false); };
    await instance.adapter.sendTurn({ threadId: "t1", text: "go", cwd: folder, folderTrust: trusted(false) } as never);
    await waitFor(() => expect(completions(events).length).toBe(1));
    await sleep(700); // the idle window runs out: nothing is pooled, the next prewarm may start
    process.env.MURAGE_ACP_POOL_IDLE_MS = "60000";
    expect(spawnArgs).toHaveBeenCalledTimes(1);
    const seedsBefore = hooks.seedCalls; const spawnsBefore = hooks.spawns;
    let releasePrewarmSeed!: () => void;
    hooks.seed = async () => {
      order.push("seed");
      if (order.filter((entry) => entry === "seed").length === 1) await new Promise<void>((resolve) => { releasePrewarmSeed = () => { order.push("prewarm-seed-resolved"); resolve(); }; });
      return seedOutcome(false);
    };
    order.length = 0;
    const warming = instance.adapter.prewarm!("t1");
    await waitFor(() => expect(hooks.seedCalls).toBe(seedsBefore + 1));
    const real = instance.adapter.sendTurn({ threadId: "t1", text: "real", cwd: folder, folderTrust: trusted(false) } as never);
    await sleep(600); // past the prewarm wait and into the takeover, which waits for the prewarm to unwind
    expect(hooks.seedCalls, "the real send's seed has not started while the prewarm's seed is held").toBe(seedsBefore + 1);
    releasePrewarmSeed();
    expect(await warming).toBe(false);
    await real;
    await waitFor(() => expect(completions(events).length).toBe(2));
    expect(order.slice(0, 3)).toEqual(["seed", "prewarm-seed-resolved", "seed"]);
    expect(spawnArgs, "the prewarm never reached spawnArgs; only the real send did").toHaveBeenCalledTimes(2);
    expect(hooks.spawns - spawnsBefore).toBe(1);
    expect(completions(events)[1]?.stopReason).not.toBe("cancelled");
  });
  it("T25b no fresh home, generation 1 with no folder policy grant, pooling on, a reset while a park check is held: finishTurnEnv never runs for the turn, no spawn [mutant: G10 dropped]", async () => {
    const engine = engineOf();
    const finishTurnEnv = vi.fn();
    const held = await heldAtParkCheck(engine, { finishTurnEnv, spawnArgs: vi.fn(() => ["acp"]) }, {});
    finishTurnEnv.mockClear();
    const turnId = await held.finish();
    expect(finishTurnEnv).not.toHaveBeenCalled();
    expect(hooks.spawns).toBe(held.spawnsBefore);
    expect(types(held.events, "t2")).toEqual(STOPPED_PAIR);
    pairFor(held.events.filter((e) => e.threadId === "t2"), turnId, "t2");
    expect(completions(held.events, "t2")[0]?.stopReason).toBe("cancelled");
  });
  it("T5 a fresh Fuigo home, a reset during the pending park checks: seedFuigoHome is never called, the stopped pair [mutant: G4 dropped]", async () => {
    const engine = engineOf();
    hooks.seed = async () => seedOutcome(false);
    const held = await heldAtParkCheck(engine, fuigo(), { providerRoute: route, folderTrust: trusted(true) });
    const turnId = await held.finish();
    expect(hooks.seedCalls).toBe(0);
    expect(hooks.spawns).toBe(held.spawnsBefore);
    expect(types(held.events, "t2")).toEqual(STOPPED_PAIR);
    pairFor(held.events.filter((e) => e.threadId === "t2"), turnId, "t2");
    expect(completions(held.events, "t2")[0]?.stopReason).toBe("cancelled");
  });
  it("T28a generation 1 with a folder policy grant, a reset while a park check is held: onFolderPolicyApplied never called, the stopped pair [mutant: G13a dropped]", async () => {
    const engine = engineOf();
    const applied = vi.fn();
    const held = await heldAtParkCheck(engine, { folderTrust: true, spawnArgs: vi.fn(() => ["acp"]) }, { folderTrust: trusted(false), onFolderPolicyApplied: applied });
    const turnId = await held.finish();
    expect(applied).not.toHaveBeenCalled();
    expect(types(held.events, "t2")).toEqual(STOPPED_PAIR);
    pairFor(held.events.filter((e) => e.threadId === "t2"), turnId, "t2");
    expect(completions(held.events, "t2")[0]?.stopReason).toBe("cancelled");
  });
  it("T28b a fresh home, generation 2, a reset during the seed which resolves policySeeded true: onFolderPolicyApplied never called, the stopped pair [mutant: G13b dropped]", async () => {
    const engine = engineOf();
    const { instance, events } = await boot(engine, fuigo());
    const applied = vi.fn();
    let release!: () => void;
    hooks.seed = () => new Promise((resolve) => { release = () => resolve(seedOutcome(true)); });
    const sent = instance.adapter.sendTurn({ threadId: "t1", text: "go", cwd: folder, providerRoute: route, folderTrust: trusted(false), onFolderPolicyApplied: applied } as never);
    await waitFor(() => expect(hooks.seedCalls).toBe(1));
    await applyStop(instance, "reset", "t1");
    release();
    const { turnId } = await sent;
    await sleep(500);
    expect(applied).not.toHaveBeenCalled();
    hooks.seed = null;
    await afterStop(instance, engine, events, turnId);
  });
  it("T28c a Cloud Fuigo seed with policySeeded true, a reset while initialize is held, then a successful reply: onFolderPolicyApplied never called, the stopped pair [mutant: G13c dropped]", async () => {
    hooks.cloudHome = true;
    const engine = engineOf(["initialize"]);
    const { instance, events } = await boot(engine, fuigo());
    const applied = vi.fn();
    hooks.seed = async () => seedOutcome(true);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t1", text: "go", cwd: folder, folderTrust: trusted(false), onFolderPolicyApplied: applied } as never);
    await waitFor(() => expect(engine.hold("initialize")).toBe(true));
    expect(hooks.seedCalls).toBe(1);
    await applyStop(instance, "reset", "t1");
    engine.open("initialize");
    await waitFor(() => expect(completions(events).length).toBe(1));
    await sleep(400);
    expect(applied).not.toHaveBeenCalled();
    expect(engine.methods()).toEqual(["initialize"]);
    expect(types(events)).toEqual(STOPPED_PAIR);
    pairFor(events, turnId);
    expect(completions(events)[0]?.stopReason).toBe("cancelled");
  });
});
