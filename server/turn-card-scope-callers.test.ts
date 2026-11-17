import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { source, wiring } from "./decision-wiring/fixture.ts";
import { createTurnCardGate } from "./turn-card-gate.ts";

afterEach(() => vi.restoreAllMocks());
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

// Run the production subscriber/call expression, including its scope, rather than supplying a scope from the test.
function productionCall(site: "loop" | "submission", globals: Record<string, unknown>) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (site === "loop" && ts.isCallExpression(node) && node.expression.getText(ast) === "bus.subscribeExecution"
      && node.getText(ast).includes("repeats.record(")) found = node.arguments[0];
    if (site === "submission" && ts.isCallExpression(node) && node.expression.getText(ast) === "turnCardGate.write"
      && node.arguments[0]?.getText(ast) === '"submission"' && node.getText(ast).includes("providerTurnId")) found ??= node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error(`Missing production card writer: ${site}`);
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(ts.transpileModule(`globalThis.run = ${site === "loop" ? found.getText(ast) : `() => ${found.getText(ast)}`}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
  return context.run as (event?: unknown) => void;
}

// The else-branch of the turn.completed handler that settles the queued handoffs, run as written in index.ts.
function delegationsDroppedBranch(globals: Record<string, unknown>) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.elseStatement && ts.isBlock(node.elseStatement)
      && node.elseStatement.getText(ast).includes("settleQueuedDelegations(") && node.elseStatement.getText(ast).includes("writeChip")) found ??= node.elseStatement;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error("Missing production branch: delegations dropped chip");
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(ts.transpileModule(`globalThis.run = () => ${found.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
  return context.run as () => void;
}

function rig(botId = "Y", generation = "G") {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const cards: unknown[] = [];
  const gate = createTurnCardGate();
  const turn = { threadId: "R", botId, generation, providerTurnId: "P", textActivity: false, text: "", engineName: "Fixture", selection: { instanceId: "I" } };
  let matchedLease = true;
  const globals = {
    turnCardGate: gate, murageLine: (m: unknown) => m,
    terminalDispatchFor: () => matchedLease ? { identity: { botId, dispatchGeneration: generation } } : undefined,
    store: { botByThread: () => undefined, bot: () => ({ id: botId, modelSelection: turn.selection }),
      scanNewest() {}, patchMessage: () => false, appendMessage: (_thread: string, m: unknown) => { cards.push(m); } },
    groupSpeakers: new Map([["R", { botId }]]),
    shouldIgnoreProviderEvent: () => false, loopNudge: { observe() {} }, repeats: { record: () => ({ threshold: 5 }) },
    toolTitleKey: () => "call", askCallLabel: () => "Fixture call", loopNoticeName: () => "Repeated call.",
    gatewayBusyStreaks: { refused: () => ({ count: 1, repeated: false }) }, setup: { firstJobPending: () => false },
    gatewayBusyLogLine: () => "Fixture busy", gatewayBusyFacts: () => ({}), gatewayBusyLine: () => "Fixture busy.",
    engineLabelOf: () => "Fixture", routineLimitLine: () => "Fixture limit.", routineLimitFailedLine: () => "Fixture limit.",
    engineKey: () => "I", limitUntil: () => 100, limitState: { record: () => ({}) },
    routineRunByTurn: new Map([[generation, "routine-run"]]),
    providerTurnId: "P", threadId: "R", dispatchClaimId: generation, bot: { id: botId },
    kind: "without-memory-checking", line: "Fixture refusal.",
  };
  const names = ["foldCardScope", "putLimitLine", "markGatewayBusy", "routineLimitRefusal",
    ...(source.includes("function limitCardScope(") ? ["limitCardScope"] : [])];
  const built = wiring(names, globals);
  return { cards, gate, turn, built, globals: { ...globals, foldCardScope: built.foldCardScope }, noLease: () => { matchedLease = false; } };
}

describe("M5 production card writers retain their turn's bot and generation", () => {
  it("F: a room Stop for X leaves Y's repeat notice visible without a lease", () => {
    const r = rig(); r.noLease();
    r.gate.noteStop({ threadId: "R", botId: "X", turnIds: [] });
    productionCall("loop", r.globals)({ type: "item.started", itemType: "tool", title: "Fixture call", threadId: "R", turnId: "P" });
    expect(r.cards).toEqual([{ role: "bot", kind: "activity", tool: { name: "Repeated call.", ok: false } }]);
  });
  it("F: the stopped generation's late repeat notice stays held after the next admission", () => {
    const r = rig();
    r.gate.noteStop({ threadId: "R", generation: "G", botId: "Y", turnIds: [] });
    r.gate.admitted("R", "G2", "Y");
    productionCall("loop", r.globals)({ type: "item.started", itemType: "tool", title: "Fixture call", threadId: "R", turnId: "P" });
    expect(r.cards).toEqual([]);
  });
  for (const site of ["H", "J"] as const) {
    const write = (r: ReturnType<typeof rig>) => site === "H" ? r.built.markGatewayBusy!(r.turn, "busy", 0) : productionCall("submission", r.globals)();
    it(`${site}: a late card for the stopped generation stays held after the next admission`, () => {
      const r = rig();
      r.gate.noteStop({ threadId: "R", generation: "G", botId: "Y", turnIds: [] });
      r.gate.admitted("R", "G2", "Y");
      write(r);
      expect(r.cards).toEqual([]);
    });
    it(`${site}: a room Stop for X leaves Y's real card visible`, () => {
      const r = rig();
      r.gate.noteStop({ threadId: "R", botId: "X", turnIds: [] });
      write(r);
      expect(r.cards).toHaveLength(1);
    });
  }
  it("H: a routine preparation refusal without a limit turn keeps its bound generation", () => {
    const r = rig();
    r.gate.noteStop({ threadId: "R", generation: "G", botId: "Y", turnIds: [] });
    r.gate.admitted("R", "G2", "Y");
    expect(r.built.routineLimitRefusal!({ id: "routine-run", threadId: "R", botId: "Y" }, { message: "plan limit is reached" })).toMatchObject({ line: "Fixture limit." });
    expect(r.cards).toEqual([]);
  });
  it("P: a routine's pre-admission limit line is not held by an older Stop on the thread", () => {
    const r = rig();
    r.gate.noteStop({ threadId: "R", generation: "G", botId: "Y", turnIds: [] });
    r.globals.routineRunByTurn.clear();
    expect(r.built.routineLimitRefusal!({ id: "new-run", threadId: "R", botId: "Y" }, { message: "plan limit is reached" })).toMatchObject({ line: "Fixture limit." });
    expect(r.cards).toEqual([{ role: "bot", kind: "activity", tool: { name: "Fixture limit.", ok: false } }]);
  });
  for (const stopped of [true, false]) {
    it(`M2: the delegations-dropped chip on the shipped wiring writes ${stopped ? 0 : 1} after ${stopped ? "a Stop" : "no Stop"}`, () => {
      const gate = createTurnCardGate();
      if (stopped) gate.noteStop({ threadId: "R", botId: "Y", turnIds: [] });
      const writes: string[] = [];
      const globals = {
        turnCardGate: gate, turnEndedByClose: () => false, turnDispatchClosed: false, turnStopped: () => true,
        store: { botByThread: () => ({ id: "Y" }) }, commsBus: {}, approvalBus: {}, askerWakes: { failed() {} },
        foldCardScope: (_event: unknown, _lease: unknown, botId?: string) => ({ threadId: "R", botId }),
        event: { threadId: "R", type: "turn.completed" },
        settleQueuedDelegations: (_c: unknown, _a: unknown, _t: unknown, _e: unknown, _f: unknown, writeChip?: (write: () => void) => void) => { writeChip?.(() => { writes.push("chip"); }); return "discarded"; },
      };
      vi.spyOn(console, "info").mockImplementation(() => {});
      delegationsDroppedBranch(globals)();
      expect(writes).toHaveLength(stopped ? 0 : 1);
    });
  }
  it("L2: a provider event never attaches a turn id to a lease whose dispatch is no longer open", () => {
    const attached: string[] = [];
    const pending = { state: "settled", providerTurnId: undefined, identity: { dispatchGeneration: "G" }, noteEventTurn: (id: string) => { attached.push(id); } };
    const built = wiring(["admittedLeaseForEvent"], { terminalDispatchFor: () => pending, admittedLedgerLeases: new Map([["G", pending]]) });
    built.admittedLeaseForEvent!({ type: "item.started", threadId: "R", turnId: "P" });
    expect(attached).toEqual([]);
    pending.state = "open";
    built.admittedLeaseForEvent!({ type: "item.started", threadId: "R", turnId: "P" });
    expect(attached).toEqual(["P"]);
  });
});
