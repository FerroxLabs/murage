// STOP-CARD-SPEC W11: the shipped giveBackAdmittedTurn (extracted from index.ts) with the shipped turnCardGate and the
// shipped noteOwnerStop: a start failure after the owner's Stop writes no card, is not counted as shown, and the thread is
// still released and the caller still hears of it once. The control without a Stop writes the card verbatim.
import { describe, expect, it, vi, afterEach } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { source } from "./decision-wiring/fixture.ts";
import { createTurnCardGate } from "./turn-card-gate.ts";
import { giveBackAdmitted } from "./admitted-turn.ts";

afterEach(() => vi.restoreAllMocks());

function rig(idle = false) {
  const appended: { tool?: { name?: string } }[] = [], released: string[] = [], dispatchErrors: string[] = [];
  const run = { botId: "B", threadId: "T", generation: "G", phase: "dispatching" };
  let current: typeof run | undefined = idle ? undefined : run;
  const globals: Record<string, unknown> = {
    console, Map, Set, Object, Error, String, createTurnCardGate, giveBackAdmitted,
    admittedLedgerLeases: new Map(), internalTurnOwners: new Map(),
    directRuns: { get: () => current, current: (r: typeof run) => current === r, admit: () => { current = run; return run; } },
    bot: { id: "B" }, threadId: "T", routingBot: {}, task: {}, opts: undefined, ownerFirst: false, rebuildOf: undefined,
    DirectTurnSetupCancelled: class DirectTurnSetupCancelled extends Error {},
    settleDirectAttempts() {}, routineRunByTurn: new Map(), callRunByTurn: new Map(), seatWaitRunByTurn: new Map(),
    turnAttribution: { ended() {} }, revokeInternalGeneration() {}, clearDirectTurnDispatch() {}, watchdog: { settle() {} }, endTurnTrace() {},
    replySpeakerTurns: { ended() {} }, retryDelegationsWaitingOn() {},
    store: { appendMessage: (_t: string, m: { tool?: { name?: string } }) => { appended.push(m); }, taskByThread: () => ({ busy: true }), setTaskActivity() {} },
    murageLine: (line: unknown) => line, turnFailureDiagnostic: (message: string) => ({ name: `error: ${message}`, ok: false }),
    drainQueuedSends() {}, drainConnectorResumes() {}, drainSecretResumes() {}, drainTeamIncidents() {}, browserSetup: undefined, browserExtension: undefined,
  };
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (name: string) => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production wiring: ${name}`);
    return node.getText(ast);
  };
  const gateStatement = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(ast) === "turnCardGate");
  // Absent on a parent commit (the base replay): the shipped code then runs without the gate and the witness shows its RED.
  const names = ["noteOwnerStop", "giveBackAdmittedTurn"];
  const start = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "startTurnAdmitting") as ts.FunctionDeclaration;
  const admission = start.body!.statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(ast) === "run");
  const admissionStatements = [start.body!.statements[admission]!, start.body!.statements[admission + 1]!]
    .filter((node, i) => i === 0 || ts.isExpressionStatement(node) && node.expression.getText(ast).startsWith("turnCardGate.admitted("));
  const text = `${gateStatement?.getText(ast) ?? ""}\n${names.map(declaration).join("\n")}\n;globalThis.result = { ${names.join(", ")}, admitNext() { ${admissionStatements.map(s => s.getText(ast)).join("\n")} } };`;
  const context = vm.createContext(globals);
  vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
  const built = context.result as Record<string, (...args: any[]) => any>;
  const state = { rejectionOwner: { current: () => true, release: () => { released.push("thread"); current = undefined; } }, reported: false } as Record<string, unknown>;
  const giveBack = () => built.giveBackAdmittedTurn!(run, "B", "T", state, "setup", new Error("The engine could not start."), (m: string) => { dispatchErrors.push(m); });
  return { built, appended, released, dispatchErrors, state, giveBack };
}

it("H2: idle Stop then a new admission failing before resources still writes its real error", () => {
  const r = rig(true);
  r.built.noteOwnerStop!("T");
  r.built.admitNext!();
  r.giveBack();
  expect({ cards: r.appended.map(m => m.tool?.name), released: r.released, errors: r.dispatchErrors })
    .toEqual({ cards: ["error: The engine could not start."], released: ["thread"], errors: ["The engine could not start."] });
});

describe("STOP-CARD W11: the give-back card after an owner Stop", () => {
  it("a generic start failure after Stop: no card, not counted as written, thread released, caller told once", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.built.noteOwnerStop!("T");
    r.giveBack();
    expect({ appended: r.appended, written: r.state.failureCardWritten, released: r.released, errors: r.dispatchErrors })
      .toEqual({ appended: [], written: undefined, released: ["thread"], errors: ["The engine could not start."] });
  });
  it("control: the same failure with no Stop writes the card verbatim and counts it", () => {
    const r = rig();
    r.giveBack();
    expect({ names: r.appended.map(m => m.tool?.name), written: r.state.failureCardWritten, errors: r.dispatchErrors })
      .toEqual({ names: ["error: The engine could not start."], written: true, errors: ["The engine could not start."] });
  });
});
