// design1019-approval-attention section 7, L cases and E caller witnesses: the actual server terminal wiring
// (server/index.ts), executed with injected ports as in decision/retirement-review.test.ts, over the real attention module,
// the real driver human wait and a real TurnWatchdog.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createGracefulShutdown } from "./graceful-shutdown.ts";
import { AttentionCleanupPending, cardAttention, type AttentionKey, type AttentionScope } from "./approval-attention.ts";
import { giveBackAdmitted as giveBackAdmittedReal } from "./admitted-turn.ts";
import { stopCloseConfirmed as stopCloseConfirmedReal } from "./contracts.ts";
import { humanWaitOpen, noteHumanWait } from "./harness/human-wait.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function select(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(ast);
  if (!found) throw new Error("missing terminal wiring");
  return found;
}
function evaluate(code: string, ports: Record<string, unknown>) {
  return new Function(...Object.keys(ports), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(ports));
}
/** The normal-completion fold: from the ended-generation retirement through the owner-aware fold. */
const completionFold = (() => {
  const start = source.indexOf("const endedGeneration = event.turnId ? internalCapabilities.dispatchingGeneration");
  const end = source.indexOf("if (pendingRoomStop)", start);
  if (start < 0 || end < 0) throw new Error("missing completion fold");
  return source.slice(start, end);
})();

let seq = 0;
function world(opts: { resumeThrows?: number; failFirstStep?: boolean } = {}) {
  const T = `thread-l${++seq}`;
  const internalTurnOwners = new Map<string, { generation: string; botId: string }>();
  const internalCapabilities = new InternalCapabilities();
  const dog = new TurnWatchdog({ stallMs: 60_000, checkMs: 60_000, onStall: () => {}, now: () => 0 });
  const activity = new Map<string, string>();
  const board = new Map<string, { activeRequestId: string | undefined; state: string; waitingOn?: string }>();
  const notified: string[] = [];
  let resumeThrows = opts.resumeThrows ?? 0;
  const counts = { waitReleases: 0, resumes: 0, abandoned: [] as string[] };
  const attention = cardAttention({
    ownsActivity: (threadId, generation) => internalTurnOwners.get(threadId)?.generation === generation,
    activity: (botId, threadId) => activity.get(`${botId}:${threadId}`),
    setActivity: (botId, threadId, to) => { activity.set(`${botId}:${threadId}`, to); },
    boardRun: id => board.get(id),
    parkBoard: id => { board.set(id, { ...board.get(id)!, state: "waiting", waitingOn: "owner_approval" }); },
    resumeBoard: id => { if (resumeThrows > 0) { resumeThrows--; throw new Error("board store busy"); } counts.resumes++; board.set(id, { ...board.get(id)!, state: "doing", waitingOn: undefined }); },
    notify: ask => { notified.push(ask.requestId); },
    wait: (threadId, generation, requestId, waiting) => { if (!waiting) counts.waitReleases++; dog.setWaitingOnHuman(threadId, waiting, requestId, generation); noteHumanWait(threadId, requestId, waiting, generation); },
  });
  const noop = () => {};
  const ports: Record<string, unknown> = {
    approvalAttention: attention, internalTurnOwners, internalCapabilities,
    recallWaits: new Map(), refusedLeases: new Set(), botOutsideWrites: { release: noop }, botTurnOrigins: new Map(), taskAllowanceSuggestions: new Map(),
    releaseDecisionProvenance: async () => {}, cancelRequests: async () => {}, decisionProvenance: new Map(),
    callSpeech: { invalidate: noop, invalidateAll: () => { if (opts.failFirstStep) throw new Error("speech shutdown failed"); } },
    replyState: { invalidateGeneration: noop, invalidate: noop, invalidateBot: noop, closeAll: noop },
    internalResponseBindings: new Map(), revokeGatewayTurnCredentials: noop, phoneDispatchFacts: new Map(),
    phoneAuthorities: { revokeGeneration: noop, revokeThread: noop, revokeBot: noop, revokeAll: noop },
    phoneJobs: { turnEnded: noop, turnEndedForThread: noop, turnEndedForBot: noop, turnEndedAll: noop },
    highlevelCalls: { turnEnded: noop, turnEndedForThread: noop, turnEndedForBot: noop, turnEndedAll: noop },
    abandonProjectUsageTurn: noop, turnRequestByGeneration: new Map(), hostComputerThreads: new Map(),
    projectTurnLeases: { abandon: (generation: string) => { counts.abandoned.push(generation); } }, turnOutputRoots: new Map(),
    discardDirectTurnCancellationProofsForGeneration: noop, successfulDecisionGenerations: new Set(), browserExecutions: { forget: noop },
    ownerStartedRuns: new Map(), highlevelProvenRuns: new Set(), highlevelDesktopRuns: new Set(), highlevelOwnerStartedAt: new Map(), sharedThreadFreed: noop, sharedBotFreed: noop,
    console: { error: noop, debug: noop, warn: noop, info: noop },
  };
  const names = ["retireInternalTurn", "retireAttention", "revokeInternalGeneration", "revokeInternalThread", "revokeInternalBot", "revokeAllInternalTurns"];
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? "")).map(n => n.getText(ast)).join("\n");
  const callbacks = evaluate(`${declarations}; return { retireInternalTurn, revokeInternalGeneration, revokeInternalThread, revokeInternalBot, revokeAllInternalTurns };`, ports) as {
    retireInternalTurn(threadId: string, generation: string): void;
    revokeInternalGeneration(threadId: string, generation: string, settled?: boolean, keepLease?: boolean): void;
    revokeInternalThread(threadId: string): void;
    revokeInternalBot(botId: string): void;
    revokeAllInternalTurns(): void;
  };
  const runs = new IndependentThreadRuns<object>();
  const callback = select(n => ts.isBinaryExpression(n) && n.left.getText(ast) === "directRuns.onReleased");
  evaluate(`${declarations}; ${callback.getText(ast)};`, { ...ports, directRuns: runs });
  const project = (id: string, state = "doing") => { board.set(id, { activeRequestId: id, state }); return id; };
  /** An admitted generation with one card, taken to `stage` (default a genuinely WAITING engine card). */
  const open = (threadId: string, generation: string, opts2: { bot?: string; stage?: "PENDING" | "PRESENTED" | "WAITING" | "SETTLED"; project?: string; requestId?: string } = {}) => {
    const botId = opts2.bot ?? "bot-a";
    internalCapabilities.begin(botId, threadId, generation);
    dog.watch(threadId, botId, { generation });
    const scope = attention.admit(threadId, generation);
    internalTurnOwners.set(threadId, { botId, generation });
    const requestId = opts2.requestId ?? `request-${generation}`;
    const key: AttentionKey = { kind: "engine", approvalId: `approval-${generation}` };
    attention.acquireWait(scope, requestId);
    attention.register(scope, { key, threadId, botId, requestId, ...(opts2.project ? { projectRequestId: opts2.project } : {}), isOpen: () => true });
    const stage = opts2.stage ?? "WAITING";
    if (stage !== "PENDING") attention.present(scope, key, `message-${generation}`);
    if (stage === "WAITING" || stage === "SETTLED") attention.ask(scope, key);
    if (stage === "SETTLED") attention.settle(scope, key);
    return { scope, key, requestId };
  };
  const complete = (threadId: string, generation: string) => {
    internalCapabilities.bindProviderTurn(threadId, generation, generation);
    internalCapabilities.completeProviderTurn(threadId, generation);
    evaluate(`${declarations}; ${completionFold}`, { ...ports, event: { threadId, turnId: generation, type: "turn.completed" } });
  };
  const clean = (threadId: string) => !humanWaitOpen(threadId) && !dog.waitingOnHuman(threadId);
  return { T, attention, internalTurnOwners, internalCapabilities, dog, activity, board, notified, counts, runs, project, open, complete, clean, ports, ...callbacks };
}

describe("one retirement operation (L)", () => {
  for (const stage of ["PENDING", "PRESENTED", "WAITING"] as const) {
    it(`W06 retirement releases every unfinished state (${stage})`, () => {
      const w = world();
      const p = w.project("p1");
      const card = w.open(w.T, "g1", { stage, project: p });
      expect(w.clean(w.T)).toBe(false);
      if (stage === "WAITING") w.board.set(p, { activeRequestId: p, state: "stopped" });
      w.retireInternalTurn(w.T, "g1");
      expect(w.attention.state(card.scope, card.key)).toBeUndefined();
      expect(w.attention.stats()).toMatchObject({ scopes: 0, cards: 0, requests: 0, waits: 0, holds: 0 });
      expect(w.clean(w.T)).toBe(true);
      expect(w.board.get(p)?.state).toBe(stage === "WAITING" ? "stopped" : "doing");
      expect(w.counts.resumes).toBe(0);
    });
  }

  it("W07 retirement removes settled markers", () => {
    const w = world();
    const card = w.open(w.T, "g1", { stage: "SETTLED" });
    expect(w.attention.state(card.scope, card.key)).toBe("SETTLED");
    w.retireInternalTurn(w.T, "g1");
    expect(w.attention.state(card.scope, card.key)).toBeUndefined();
    expect(w.attention.stats()).toMatchObject({ scopes: 0, cards: 0, requests: 0, waits: 0, holds: 0 });
  });

  it("W13 waiting stop clears both waits before late resolution", () => {
    const w = world();
    const card = w.open(w.T, "g1");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual([true, true]);
    // HELD Stop: cancellation/revocation of the generation, the physical lease retained until close confirmation.
    w.revokeInternalGeneration(w.T, "g1", false, true);
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.attention.stats().cards]).toEqual([false, false, 0]);
    w.attention.settleRequest(card.scope, card.requestId);
    w.attention.settle(card.scope, card.key);
    expect(w.attention.ask(card.scope, card.key)).toBe("refused");
    expect([humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.notified.length]).toEqual([false, false, 1]);
    expect(w.counts.abandoned).toEqual([]);
  });

  it("W24 cleanup failure stays fenced and retryable", () => {
    const w = world({ resumeThrows: 1 });
    const p = w.project("p1");
    const card = w.open(w.T, "g1", { project: p });
    expect(w.attention.retireTurn(card.scope, "ended")).toBe(false);
    expect(w.clean(w.T)).toBe(true);
    expect(w.attention.stats().scopes).toBe(1);
    expect(w.attention.register(card.scope, { key: { kind: "engine", approvalId: "late" }, threadId: w.T, botId: "bot-a", requestId: "late", isOpen: () => true })).toBe("refused");
    expect(w.attention.scopeOf(w.T, "g1")).toBe(card.scope);
    const releases = w.counts.waitReleases;
    w.retireInternalTurn(w.T, "g1");
    expect(w.attention.stats()).toMatchObject({ scopes: 0, cards: 0, holds: 0 });
    expect([w.counts.resumes, w.counts.waitReleases, w.board.get(p)?.state, w.notified.length]).toEqual([1, releases, "doing", 1]);
  });

  for (const order of ["completion then release", "release then completion"] as const) {
    it(`W25 completion then direct release retires effectively once (${order})`, () => {
      const w = world();
      const run = w.runs.admit("bot-a", w.T, {});
      const card = w.open(run.threadId, run.generation);
      const other = w.open(`${w.T}-b`, "other-generation", { bot: "bot-b" });
      if (order === "completion then release") { w.complete(run.threadId, run.generation); expect(w.runs.release(run)).toBe(true); }
      else { expect(w.runs.release(run)).toBe(true); w.complete(run.threadId, run.generation); }
      // The engine resolution arriving late, after both terminal routes, is inert too.
      w.attention.settleRequest(card.scope, card.requestId);
      w.attention.releaseWait(card.scope, card.requestId);
      expect([w.counts.waitReleases, w.clean(w.T)]).toEqual([1, true]);
      expect(w.attention.state(other.scope, other.key)).toBe("WAITING");
      expect(humanWaitOpen(`${w.T}-b`)).toBe(true);
    });
  }

  it("W26 retire scope after current owner was already removed", () => {
    const w = world();
    const old = w.open(w.T, "g1");
    w.internalTurnOwners.set(w.T, { botId: "bot-a", generation: "successor" });
    w.retireInternalTurn(w.T, "g1");
    expect([w.attention.state(old.scope, old.key), w.clean(w.T), w.internalTurnOwners.get(w.T)?.generation]).toEqual([undefined, true, "successor"]);
  });

  it("W27 history does not increase resolution work", () => {
    const w = world();
    for (let i = 0; i < 50; i++) w.open(`${w.T}-unrelated-${i}`, `unrelated-${i}`);
    const settleVisits = (scope: AttentionScope, requestId: string) => { const before = w.attention.stats().visited; w.attention.settleRequest(scope, requestId); return w.attention.stats().visited - before; };
    const baseline = (() => { const fresh = world(); const card = fresh.open(fresh.T, "fresh"); return settleVisits(card.scope, card.requestId); })();
    for (let i = 0; i < 1000; i++) {
      const run = w.runs.admit("bot-a", w.T, {});
      const card = w.open(run.threadId, run.generation);
      w.attention.settleRequest(card.scope, card.requestId);
      w.complete(run.threadId, run.generation);
      expect(w.attention.scopeOf(w.T, run.generation)).toBeUndefined();
      w.runs.release(run);
    }
    expect(w.attention.stats()).toMatchObject({ scopes: 50, cards: 50, requests: 50 });
    const live = w.open(w.T, "live-generation");
    expect(settleVisits(live.scope, live.requestId)).toBe(baseline);
  });

  it("W31 shutdown failure cannot skip attention retirement", () => {
    const w = world({ failFirstStep: true });
    w.open(w.T, "g1");
    expect(() => w.revokeAllInternalTurns()).toThrow("speech shutdown failed");
    expect([w.clean(w.T), w.attention.stats().scopes, w.attention.stats().holds]).toEqual([true, 0, 0]);
  });

  it("W32 replacement admission cannot abandon an accepting old scope", () => {
    const w = world();
    const old = w.open(w.T, "g1");
    const next = w.attention.admit(w.T, "g2");
    expect([w.attention.state(old.scope, old.key), w.clean(w.T), old.scope.accepting, next.accepting]).toEqual([undefined, true, false, true]);
    const failing = world({ resumeThrows: 5 });
    const held = failing.open(failing.T, "g1", { project: failing.project("p1") });
    expect(() => failing.attention.admit(failing.T, "g2")).toThrow(AttentionCleanupPending);
    expect([failing.attention.scopeFor(failing.T, "g2"), held.scope.accepting, failing.clean(failing.T)]).toEqual([undefined, false, true]);
  });
});

describe("every terminal caller reaches the coordinator (E)", () => {
  const routes = {
    "E01 normal completion retires waiting attention": (w: ReturnType<typeof world>, g: string) => w.complete(w.T, g),
    "E02 direct release retires waiting attention": (w: ReturnType<typeof world>) => { const run = w.runs.admit("bot-a", w.T, {}); w.open(w.T, run.generation); expect(w.runs.release(run)).toBe(true); },
    "E03 generation error retires waiting attention": (w: ReturnType<typeof world>, g: string) => w.revokeInternalGeneration(w.T, g),
    "E05 thread revocation retires waiting attention": (w: ReturnType<typeof world>) => w.revokeInternalThread(w.T),
    "E07 fleet revocation retires all waiting generations": (w: ReturnType<typeof world>) => w.revokeAllInternalTurns(),
  } as const;
  for (const [name, route] of Object.entries(routes)) {
    it(name, () => {
      const w = world();
      const unrelated = w.open(`${w.T}-unrelated`, "unrelated-generation", { bot: "bot-z" });
      if (!name.startsWith("E02")) w.open(w.T, "g1");
      route(w, "g1");
      expect([w.clean(w.T), w.attention.scopeOf(w.T, "g1"), w.attention.stats().holds - (name.startsWith("E07") ? 0 : 1)]).toEqual([true, undefined, 0]);
      expect(w.attention.state(unrelated.scope, unrelated.key)).toBe(name.startsWith("E07") ? undefined : "WAITING");
    });
  }

  it("E06 bot revocation retires all its waiting generations", () => {
    const w = world();
    w.open(w.T, "g1"); w.open(`${w.T}-2`, "g2");
    const unrelated = w.open(`${w.T}-z`, "gz", { bot: "bot-z" });
    w.revokeInternalBot("bot-a");
    expect([w.clean(w.T), w.clean(`${w.T}-2`), w.attention.scopeOf(w.T, "g1"), w.attention.scopeOf(`${w.T}-2`, "g2")]).toEqual([true, true, undefined, undefined]);
    expect([w.attention.state(unrelated.scope, unrelated.key), humanWaitOpen(`${w.T}-z`)]).toEqual(["WAITING", true]);
  });
});

/** A production body from index.ts, run as written: the ports a case names are real; every other free name is an inert
 * sink (a property is the sink again, a call returns undefined), so no unrelated subsystem is copied into the test. */
const sink: any = new Proxy(function () {}, { get: (_t, key) => (key === "then" || typeof key === "symbol" ? undefined : sink), apply: () => undefined });
function evaluateLoose(code: string, ports: Record<string, unknown>) {
  const scope = new Proxy(ports, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? (target as any)[key] : sink),
  });
  return new Function("__scope", `with (__scope) { ${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText} }`)(scope);
}
const declaration = (name: string) => select(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
/** The value of `prop` in the options literal passed to `callee` (e.g. the watchdog's onStall). */
function optionsOf(callee: string): ts.ObjectLiteralExpression {
  const call = select(n => (ts.isCallExpression(n) || ts.isNewExpression(n)) && n.expression.getText(ast) === callee
    && ts.isObjectLiteralExpression(n.arguments?.[0] ?? n)) as ts.CallExpression;
  return call.arguments[0] as ts.ObjectLiteralExpression;
}
const propertyOf = (literal: ts.ObjectLiteralExpression, prop: string) => {
  const found = literal.properties.find(p => p.name?.getText(ast) === prop);
  if (!found || !ts.isPropertyAssignment(found)) throw new Error(`missing ${prop}`);
  return found.initializer.getText(ast);
};
const coordinator = ["retireInternalTurn", "retireAttention", "revokeInternalGeneration", "revokeInternalThread", "revokeInternalBot", "revokeAllInternalTurns", "joinAttentionShutdown"].map(declaration).join("\n");

describe("terminal callers on the setup, Stop, timeout and shutdown routes (E)", () => {
  it("E04 setup failure retires pending execution wait", () => {
    const w = world();
    const run = w.runs.admit("bot-a", w.T, {});
    // Setup failed before the provider bound a turn: the card is still PENDING on its adopted execution wait.
    const card = w.open(w.T, run.generation, { stage: "PENDING" });
    expect([w.attention.state(card.scope, card.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual(["PENDING", true, true]);
    const giveBack = evaluateLoose(`${coordinator}; ${declaration("giveBackAdmittedTurn")}; return giveBackAdmittedTurn;`, {
      ...w.ports, directRuns: w.runs, giveBackAdmitted: (giveBackAdmittedReal as any), watchdog: w.dog, routineRunByTurn: new Map(), callRunByTurn: new Map(), seatWaitRunByTurn: new Map(),
    });
    // The engine stop is unconfirmed, so the thread is kept: no direct release may mask the setup route.
    giveBack(run, "bot-a", w.T, { keepThread: true, rejectionOwner: { current: () => true, release: () => {} }, reported: false }, "setup", new Error("setup rejected"));
    expect(w.runs.current(run)).toBe(true);
    expect([w.clean(w.T), w.attention.scopeOf(w.T, run.generation), w.attention.stats().waits]).toEqual([true, undefined, 0]);
  });

  /** interruptDirectThread on a WAITING direct turn whose engine interrupt is held until `confirm`. */
  const heldStop = () => {
    const w = world();
    const run = w.runs.admit("bot-a", w.T, {});
    const card = w.open(w.T, run.generation);
    let confirm!: (result: { closeConfirmed: boolean }) => void;
    const held = new Promise<{ closeConfirmed: boolean }>(resolve => { confirm = resolve; });
    const interrupts: string[] = [];
    const interrupt = evaluateLoose(`${coordinator}; ${declaration("cancelDirectTurnDispatch")}; ${declaration("interruptDirectThread")}; return interruptDirectThread;`, {
      ...w.ports, directRuns: w.runs, stopCloseConfirmed: stopCloseConfirmedReal, turnRequestByGeneration: new Map(), directTurnDispatchClaims: new Map(),
      workAdmission: { liveTurns: () => [] }, botForDirectThread: () => ({ modelSelection: { instanceId: "engine" } }),
      registry: { get: () => ({ adapter: { interruptTurn: (threadId: string) => { interrupts.push(threadId); return held; } } }) },
      releaseBrowserCapabilityForThread: async () => {}, screenPollers: new Map(), watchdog: w.dog,
      projectTurnLeases: { abandon: () => {}, markStopRequested: () => {}, releaseClosed: () => {} },
    }) as (botId: string, threadId: string) => Promise<void>;
    return { w, run, card, confirm, interrupts, stopping: interrupt("bot-a", w.T) };
  };

  it("E09 held stop retires attention without confirming physical stop", async () => {
    const { w, run, card, interrupts, confirm, stopping } = heldStop();
    await expect.poll(() => interrupts.length).toBe(1);
    // The interrupt is still HELD: nothing else has run that could retire this generation.
    expect([w.attention.state(card.scope, card.key), w.attention.scopeOf(w.T, run.generation), w.clean(w.T)]).toEqual([undefined, undefined, true]);
    expect([w.runs.get(w.T)?.generation, w.runs.get(w.T)?.phase, w.runs.current(run)]).toEqual([run.generation, "stopping", true]);
    confirm({ closeConfirmed: true }); await stopping;
  });

  it("E10 confirmed stop retirement is safe after held retirement", async () => {
    const { w, run, interrupts, confirm, stopping } = heldStop();
    await expect.poll(() => interrupts.length).toBe(1);
    // A replacement generation on the thread is genuinely waiting on the owner when the exact close is confirmed.
    const successor = w.open(w.T, "g-successor");
    confirm({ closeConfirmed: true });
    await stopping;
    expect(w.runs.get(w.T)).toBeUndefined();
    w.complete(w.T, run.generation);
    expect([w.attention.state(successor.scope, successor.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T), w.attention.scopeOf(w.T, run.generation)]).toEqual(["WAITING", true, true, undefined]);
  });

  it("E11 timeout revocation retires waiting attention", () => {
    const w = world();
    w.open(w.T, "g1");
    const unrelated = w.open(`${w.T}-unrelated`, "gz", { bot: "bot-z" });
    const onStall = evaluateLoose(`${coordinator}; return (${propertyOf(optionsOf("TurnWatchdog"), "onStall")});`, {
      ...w.ports, directRuns: w.runs, roomStallCompletions: { stall: () => false }, setTimeout: () => ({ unref() {} }),
    }) as (turn: { threadId: string; botId: string }) => void;
    // The injected trigger is the watchdog's stall callback itself; no owner wait is actually timed out.
    onStall({ threadId: w.T, botId: "bot-a" });
    expect([w.clean(w.T), w.attention.scopeOf(w.T, "g1"), w.internalTurnOwners.has(w.T)]).toEqual([true, undefined, false]);
    expect(w.attention.state(unrelated.scope, unrelated.key)).toBe("WAITING");
  });

  /** The real graceful shutdown with the server's own options and exit fallback. */
  const shutdown = (w: ReturnType<typeof world>, opts: { disposeFails?: boolean } = {}) => {
    const seen: Record<string, boolean> = {};
    const note = (name: string) => { seen[name] ??= w.clean(w.T) && w.attention.scopeOf(w.T, "g1") === undefined; };
    let exited!: () => void;
    const done = new Promise<void>(resolve => { exited = resolve; });
    const options = evaluateLoose(`${coordinator}; return (${optionsOf("createGracefulShutdown").getText(ast)});`, {
      ...w.ports,
      projectTurnLeases: { abandon: () => {}, generations: () => [], disposed: () => {} },
      watchdog: { stop: () => note("watchdog.stop") },
      store: { checkpointTurnState: () => note("store.checkpoint") },
      registry: { beginShutdown: () => {}, disposeAll: async () => { if (opts.disposeFails) throw new Error("engine fleet close failed"); return []; } },
      dataWriterGate: { stop: async () => { note("writerGate.stop"); } },
      exitWithChildIoReceipt: () => exited(),
      sseClients: [], localVmIdles: new Map(), pendingRoomStops: new Map(), roomStopRequests: new Map(), DATA_DIR: "/nonexistent",
    }) as Parameters<typeof createGracefulShutdown>[0];
    createGracefulShutdown({ ...options, timeoutMs: 2_000 })();
    return { seen, done };
  };

  it("E08 app quit retires waiting attention before consumers close", async () => {
    const w = world();
    w.open(w.T, "g1");
    const { seen, done } = shutdown(w);
    await done;
    expect(seen).toEqual({ "watchdog.stop": true, "store.checkpoint": true, "writerGate.stop": true });
  });

  it("E08 shutdown fallback joins unfinished attention cleanup before the writer gate", async () => {
    // The board release throws on every attempt revokeAllInternalTurns makes (the bulk retirement's live pass and closing
    // pass, then the per-owner retry), so the scope stays closed and retryable (W24). The engine fleet close fails too, so
    // the cleanup job never reaches its own writer-gate stop: the exit fallback is the only route left that can finish
    // the retirement before the store closes.
    const w = world({ resumeThrows: 3 });
    w.open(w.T, "g1", { project: w.project("card-run-1") });
    const { seen, done } = shutdown(w, { disposeFails: true });
    await done;
    // The cleanup jobs themselves left the scope unfinished (the watchdog stop saw it), and never checkpointed the store.
    expect([seen["watchdog.stop"], "store.checkpoint" in seen]).toEqual([false, false]);
    // The exit fallback retried it, and its writer-gate stop saw the finished retirement.
    expect(seen["writerGate.stop"]).toBe(true);
    expect(w.counts.resumes).toBe(1);
    expect([w.clean(w.T), w.attention.scopeOf(w.T, "g1"), w.attention.stats().scopes, w.board.get("card-run-1")?.state]).toEqual([true, undefined, 0, "doing"]);
  });
});

describe("unbound engine resolution (MAIN ruling: strict no-op)", () => {
  const subscriber = (w: ReturnType<typeof world>) => {
    const call = select(n => ts.isCallExpression(n) && n.expression.getText(ast) === "presentedRequests.subscribeExecution") as ts.CallExpression;
    return evaluateLoose(`${declaration("eventAttentionScope")}; return (${call.arguments[0].getText(ast)});`, {
      ...w.ports, unscopedRequestWaits: new Set(), watchdog: w.dog, directRuns: w.runs,
    }) as (event: Record<string, unknown>) => void;
  };

  it("Q3 unbound resolution settles nothing; the bound resolution and retirement release it", () => {
    const w = world();
    const card = w.open(w.T, "g1");
    const deliver = subscriber(w);
    deliver({ type: "request.resolved", threadId: w.T, requestId: card.requestId });
    deliver({ type: "request.resolved", threadId: w.T, turnId: "never-bound", requestId: card.requestId });
    expect([w.attention.state(card.scope, card.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual(["WAITING", true, true]);
    w.internalCapabilities.bindProviderTurn(w.T, "g1", "provider-g1");
    deliver({ type: "request.resolved", threadId: w.T, turnId: "provider-g1", requestId: card.requestId });
    expect([w.attention.state(card.scope, card.key), w.clean(w.T)]).toEqual(["SETTLED", true]);
  });

  it("Q3 unbound resolution of a retired generation leaves the successor's same-id request waiting", () => {
    const w = world();
    w.open(w.T, "g1", { requestId: "shared-request" });
    w.revokeInternalGeneration(w.T, "g1");
    const successor = w.open(w.T, "g2", { requestId: "shared-request" });
    subscriber(w)({ type: "request.resolved", threadId: w.T, requestId: "shared-request" });
    expect([w.attention.state(successor.scope, successor.key), humanWaitOpen(w.T), w.dog.waitingOnHuman(w.T)]).toEqual(["WAITING", true, true]);
  });
});
