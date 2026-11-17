import { createTurnCardGate } from "./turn-card-gate.ts";
// Every owner Stop entry (bot-level, routine, channel, direct fallback, room Stop, Inject now, the scoped Stop) driven as the shipped
// route block and functions, extracted from index.ts, over the real createLedgerLease: the owner reads no refusal sentence.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { source } from "./decision-wiring/fixture.ts";
import { createLedgerLease } from "./ledger-refusal.ts";
import { LEDGER_REFUSAL_LINE } from "./turn-end.ts";
import { sendNoticeLine } from "./send-store.ts";

const verdict = { state: "checking", reason: "not-built" } as const;
type Lease = ReturnType<typeof createLedgerLease>;
type Out = { status: number; body: unknown };

/** The route block that follows `m = path.match(<pattern>)`, with production syntax, as `async (m, method, req, res) => {...}`. */
function routeBlock(ast: ts.SourceFile, pattern: string): string {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) node.statements.forEach((statement, index) => {
      const next = node.statements[index + 1];
      if (statement.getText(ast).startsWith(`m = path.match(${pattern})`) && next && ts.isIfStatement(next) && next.expression.getText(ast) === 'm && method === "POST"') found = next.thenStatement.getText(ast);
    });
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error(`Missing production route: ${pattern}`);
  return `async (m, method, req, res) => ${found}`;
}

function rig(opts: { direct?: string[]; room?: string[] } = {}) {
  const captured: string[] = [], appended: unknown[] = [], calls: string[] = [], chips: string[] = [], order: string[] = [];
  const leases = new Map<string, Lease>(), byThread = new Map<string, Lease>();
  const directRunRows = new Map<string, { threadId: string; generation: string; botId: string; providerTurnId: string }>();
  const internalTurnOwners = new Map<string, { generation: string; botId: string }>();
  // Any revoking step ends in the shared revoke: the ledger then seals the turn that ran on that thread.
  const revoke = (step: string, threadId?: string) => {
    order.push(step);
    for (const [thread, lease] of byThread) if (threadId === undefined || threadId === thread) lease.onLedgerRefused(verdict);
  };
  const instance = { instanceId: "I", adapter: {
    interruptTurn: async (threadId: string) => { revoke("adapter.interruptTurn", threadId); return {}; },
    awaitTurnTeardown: async () => ({ closeConfirmed: true }) } };
  const bot = { id: "B", threadId: "home", modelSelection: { instanceId: "I" } };
  const globals: Record<string, any> = {
    console, Date, Map, Set, Object, JSON, Promise, URL, Array, Number, Boolean, String, Error,
    bus: { admitNewTurn: () => ({}), refuseTurn: () => { calls.push("bus.refuseTurn"); return []; } },
    database: () => ({ prepare: () => ({ get: () => undefined, run() {} }) }), createLedgerLease,
    persistLedgerRefusal: (_db: unknown, work: () => void) => { work(); return Promise.resolve(); },
    transaction: (work: (db: unknown) => void) => work({}),
    captureSource: (_db: unknown, row: { text: string }) => { captured.push(row.text); },
    store: { appendMessage: (_thread: string, message: unknown) => { appended.push(message); }, markTurnToolsUnrecorded() {}, setTaskActivity() {},
      bot: (id: string) => (id === "B" ? bot : undefined), tasks: () => [], pendingThreadsFor: () => [],
      group: (id: string) => (id === "g" ? { id: "g", threadId: "R", dm: false } : undefined),
      groupByThread: (threadId: string) => (opts.room?.includes(threadId) ? { id: "g" } : undefined), groupTaskByThread: () => undefined },
    murageLine: (line: unknown) => line, sendNoticeLine, randomUUID: () => "id",
    turnCardGate: createTurnCardGate(), admittedLedgerLeases: leases, ledgerCompletionSources: new Map(), ledgerLeasesByAdmission: new Map(), ledgerProviderInstances: new WeakMap(),
    refusedLeases: new Map(), internalTurnOwners, memoryDispatches: new Map(), projectTurnLeases: { abandon() {} },
    watchdog: { settle: () => { calls.push("watchdog.settle"); } },
    revokeInternalGeneration() {}, retireProviderTurn() {}, closeTurnLineage() {}, retryDelegationsWaitingOn() {}, drainQueuedSends() {},
    replySpeakerTurns: { ended() {} }, stopCloseConfirmed: () => true, broadcast: () => {}, windowRuntimeEvent: (e: unknown) => e,
    directRuns: { get: (threadId: string) => directRunRows.get(threadId), forBot: () => [...directRunRows.values()],
      release: (run: { threadId: string }) => { directRunRows.delete(run.threadId); } },
    replyState: { invalidate() {} }, askerWakes: { dropBot() {} }, dropHeldAskerWakes() {}, projectCardExecutor: { cancelBackoffs: () => 0 },
    markSendsStopped() {}, recordStopForThread: (_db: unknown, _bot: unknown, threadId: string) => { chips.push(threadId); },
    routines: { activeBotRunForThread: () => undefined, activeBotRunForBot: () => undefined, cancelRun: async () => { revoke("routines.cancelRun"); } },
    cancelDirectTurnDispatch: (_botId: string, threadId?: string) => { revoke("cancelDirectTurnDispatch", threadId); return undefined; },
    interruptDirectThread: async (_botId: string, threadId: string) => { revoke("interruptDirectThread", threadId); },
    workAdmission: { liveTurns: () => (opts.room ?? []).map(threadId => ({ threadId })) }, groupSpeakers: new Map(),
    cancelGroupTurnOperations: (_groupId: string, threadId: string) => { revoke("cancelGroupTurnOperations", threadId); },
    releaseBrowserCapabilityForThread: async () => {}, closeOpenApprovals() {}, registry: { get: () => instance },
    json: (res: { out?: Out }, status: number, body: unknown) => { res.out = { status, body }; },
    readBody: async (req: { body: unknown }) => req.body,
    activeGroupTurnForBot: () => undefined, requestedDirectBot: () => { throw new Error("the direct Stop button branch is not under test here"); },
    directTurnDispatchClaims: new Map(), grantOfRequest: new WeakSet(), groupTurnOperations: new Map(),
    channelMessageQueued: () => false, roomOwnerSendQueued: () => false,
  };
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (name: string) => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production wiring: ${name}`);
    return node.getText(ast);
  };
  const text = `${["admitLedgerLease", "noteOwnerStop", "stopBotEverywhere"].map(declaration).join("\n")}
    ;globalThis.result = { admitLedgerLease, noteOwnerStop,
      botInterrupt: ${routeBlock(ast, String.raw`/^\/api\/bots\/([\w-]+)\/interrupt$/`)},
      groupInterrupt: ${routeBlock(ast, String.raw`/^\/api\/groups\/([\w-]+)\/interrupt$/`)} };`;
  const context = vm.createContext(globals);
  vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
  const built = context.result as Record<string, (...args: any[]) => any>;
  const admit = (threadId: string, room: boolean) => {
    const generation = `G-${threadId}`;
    if (room) internalTurnOwners.set(threadId, { generation, botId: "B" });
    else directRunRows.set(threadId, { threadId, generation, botId: "B", providerTurnId: `P-${threadId}` });
    const leaseInstance = { instanceId: "I", adapter: { interruptTurn: async () => ({}), awaitTurnTeardown: async () => ({ closeConfirmed: true }) } };
    const lease = built.admitLedgerLease!("B", threadId, generation, { turnId: `L-${threadId}` }, leaseInstance, { seal() {} }) as Lease;
    lease.attach(`P-${threadId}`); byThread.set(threadId, lease);
  };
  for (const threadId of opts.direct ?? []) admit(threadId, false);
  for (const threadId of opts.room ?? []) admit(threadId, true);
  const post = async (route: "botInterrupt" | "groupInterrupt", id: string, body: unknown) => {
    const res: { out?: Out } = {};
    await built[route]!([`/${id}`, id], "POST", { body }, res);
    return res.out;
  };
  const settledOnce = (threads: number) => Array.from({ length: threads }, () => ["watchdog.settle", "bus.refuseTurn"]).flat();
  return { globals, post, captured, appended, calls, chips, order, revoke, settledOnce, bot };
}
const quiet = (r: ReturnType<typeof rig>, threads = 1) => {
  expect(r.captured).toEqual([]); expect(r.appended).toEqual([]); // no refusal sentence stored or shown
  expect(r.calls).toEqual(r.settledOnce(threads));                 // the turn still settled, once per thread
  expect(r.chips).toEqual([]);                                     // these entries record no Stop chip
};

describe("owner Stop entries note the owner's Stop on the admitted lease before the first revoking call", () => {
  it("S4a bot-level Stop, a direct run: no refusal sentence, the run is counted as stopped", async () => {
    const r = rig({ direct: ["T"] });
    expect(await r.post("botInterrupt", "B", { all: true })).toEqual({ status: 200, body: { ok: true, stopped: 1, unconfirmed: 0 } });
    expect(r.order).toEqual(["interruptDirectThread"]); quiet(r);
  });
  it("S4a bot-level Stop, a direct run that a routine holds: the note comes before the dispatch cancel", async () => {
    const r = rig({ direct: ["T"] });
    r.globals.routines.activeBotRunForThread = () => ({ id: "run" });
    expect(await r.post("botInterrupt", "B", { all: true })).toEqual({ status: 200, body: { ok: true, stopped: 1, unconfirmed: 0 } });
    expect(r.order[0]).toBe("cancelDirectTurnDispatch"); quiet(r);
  });
  it("S4b bot-level Stop, a room thread: no refusal sentence, the room turn is counted as stopped", async () => {
    const r = rig({ room: ["R"] });
    expect(await r.post("botInterrupt", "B", { all: true })).toEqual({ status: 200, body: { ok: true, stopped: 1, unconfirmed: 0 } });
    expect(r.order[0]).toBe("cancelGroupTurnOperations"); quiet(r);
  });
  it("S5 routine branch: no refusal sentence; a routine with no thread notes nothing and still answers ok", async () => {
    const r = rig({ direct: ["T"] });
    r.globals.activeGroupTurnForBot = () => ({ threadId: "T", group: { id: "g", name: "room" } });
    r.globals.routines.activeBotRunForBot = () => ({ id: "run", threadId: "T" });
    expect(await r.post("botInterrupt", "B", {})).toEqual({ status: 200, body: { ok: true } });
    expect(r.order[0]).toBe("cancelDirectTurnDispatch"); quiet(r);
    const bare = rig({ direct: ["T"] });
    bare.globals.activeGroupTurnForBot = () => ({ threadId: "T", group: { id: "g", name: "room" } });
    bare.globals.routines.activeBotRunForBot = () => ({ id: "run" });
    bare.globals.cancelDirectTurnDispatch = () => undefined; bare.globals.routines.cancelRun = async () => {};
    expect(await bare.post("botInterrupt", "B", {})).toEqual({ status: 200, body: { ok: true } });
    bare.revoke("later"); expect(bare.captured).toEqual([LEDGER_REFUSAL_LINE]); // no thread was named: that turn was not the owner's Stop
  });
  it("S6 channel branch: no refusal sentence for the room turn", async () => {
    const r = rig({ room: ["R"] });
    r.globals.activeGroupTurnForBot = () => ({ threadId: "R", group: { id: "g", name: "room" } });
    expect(await r.post("botInterrupt", "B", {})).toEqual({ status: 200, body: { ok: true } });
    expect(r.order[0]).toBe("cancelGroupTurnOperations"); quiet(r);
  });
  it("S7 direct fallback: one thread is noted, and it is the thread that is interrupted", async () => {
    const r = rig({ direct: ["claimed", "home"] });
    let asked = 0;
    r.globals.activeGroupTurnForBot = () => (asked++ === 0 ? { threadId: "claimed", group: { id: "g", name: "room" } } : undefined);
    r.globals.directTurnDispatchClaims.set("home", { threadId: "claimed" });
    const interrupted: string[] = [];
    r.globals.cancelDirectTurnDispatch = (_botId: string, threadId?: string) => { r.revoke("cancelDirectTurnDispatch", threadId); return { threadId: "claimed" }; };
    r.globals.registry = { get: () => ({ adapter: { interruptTurn: async (threadId: string) => { interrupted.push(threadId); r.revoke("adapter.interruptTurn", threadId); } } }) };
    expect(await r.post("botInterrupt", "B", { threadId: "claimed" })).toEqual({ status: 200, body: { ok: true } });
    expect(interrupted).toEqual(["claimed"]);
    expect(r.captured).toEqual([]); expect(r.appended).toEqual([]); expect(r.calls).toEqual(r.settledOnce(1)); expect(r.chips).toEqual([]);
    r.revoke("later", "home"); expect(r.captured).toEqual([LEDGER_REFUSAL_LINE]); // the bot's other thread was not stopped by the owner
  });
  it("S8 room Stop: every interrupted thread is noted, no refusal sentence", async () => {
    const r = rig({ room: ["R", "R2"] });
    r.globals.groupTurnOperations.set("g", [{ threadId: "R", cancelled: false }, { threadId: "R2", cancelled: false }]);
    expect(await r.post("groupInterrupt", "g", {})).toEqual({ status: 200, body: { ok: true } });
    expect(r.order[0]).toBe("cancelGroupTurnOperations"); quiet(r, 2);
  });
  it("S8 Inject now: the ended turn is silent; a repeated inject stops nothing and notes nothing", async () => {
    const r = rig({ room: ["R"] });
    r.globals.channelMessageQueued = (_groupId: string, id: string) => id === "q1";
    expect(await r.post("groupInterrupt", "g", { queueIds: ["q1"] })).toEqual({ status: 200, body: { ok: true } });
    quiet(r);
    const again = rig({ room: ["R"] });
    expect(await again.post("groupInterrupt", "g", { queueIds: ["q1"] })).toEqual({ status: 200, body: { ok: true, stopped: false } });
    expect(again.order).toEqual([]); again.revoke("later"); expect(again.captured).toEqual([LEDGER_REFUSAL_LINE]);
  });
  it("S9 scoped Stop (Help): no refusal sentence, and the scoped answer is unchanged", async () => {
    const r = rig({ direct: ["T"] });
    let outcome: string | undefined;
    const receipt = () => ({ status: 200, body: { attemptId: "a", receiptRevision: 1, bindingEpoch: 2, turnId: "P-T", terminalOutcome: outcome } });
    Object.assign(r.globals, { directTurnState: receipt, createHash: () => ({ update: () => ({ digest: () => "f" }) }),
      sendStore: { attempts: () => ({ transaction: (work: () => void) => work() }) }, settleDirectAttempts: () => { outcome = "stopped"; } });
    const body = { contract: 1, actionId: "act", threadId: "T", sendId: "s", attemptId: "a", receiptRevision: 1, bindingEpoch: 2, turnId: "P-T" };
    expect(await r.post("botInterrupt", "B", body)).toEqual({ status: 200, body: { ok: true, matched: true, stopped: true, unconfirmed: false, actionId: "act", receipt: receipt().body } });
    expect(r.order).toEqual(["interruptDirectThread"]); quiet(r);
  });
  it("without any owner Stop the same revoke keeps the ledger sentence (the cells above are not vacuous)", () => {
    const r = rig({ direct: ["T"] });
    r.revoke("shared");
    expect(r.captured).toEqual([LEDGER_REFUSAL_LINE]);
  });
});
