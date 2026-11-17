// STOP-CARD W4/W5: the shipped terminal line branch of foldRuntimeEvent's turn.completed (sites B failed line, C empty line),
// the shipped turnCardGate, noteOwnerStop and foldCardScope (all extracted from index.ts), over the real failed-turn-line.ts
// rules. After the owner's Stop of a plain direct owner turn, neither line is written; with no Stop each line is written once.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { source } from "./decision-wiring/fixture.ts";
import { createTurnCardGate } from "./turn-card-gate.ts";
import { emptyTurnLine, failedTurnLine, turnProducedSomething, turnWroteText, wantsEmptyTurnLine, wantsFailedTurnLine } from "./failed-turn-line.ts";

const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The `const lineContext = ...` statement and the `if (bot && wantsFailedTurnLine(...))` statement of the shipped fold. */
function terminalLineStatements(): string {
  let context: string | undefined, branch: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(ast) === "lineContext") context ??= node.getText(ast);
    if (ts.isIfStatement(node) && /^bot && wantsFailedTurnLine\(/.test(node.expression.getText(ast))) branch ??= node.getText(ast);
    ts.forEachChild(node, visit);
  };
  const fold = ast.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations[0]?.name.getText(ast) === "foldRuntimeEvent");
  if (!fold) throw new Error("Missing production branch: foldRuntimeEvent");
  visit(fold);
  if (!context || !branch) throw new Error("Missing production branch: terminal line");
  return `${context}\n${branch}`;
}
const declaration = (name: string) => {
  const node = ast.statements.find(s => (ts.isFunctionDeclaration(s) && s.name?.text === name) || (ts.isVariableStatement(s) && s.declarationList.declarations[0]?.name.getText(ast) === name));
  if (!node) throw new Error(`Missing production wiring: ${name}`);
  return node.getText(ast);
};

function rig() {
  const pushed: { tool: { name: string } }[] = [], logs: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: string) => { logs.push(line); });
  const bot = { id: "B", name: "Ada", modelSelection: { instanceId: "I" } };
  let current: { generation: string; phase: string } | undefined = { generation: "G", phase: "running" };
  const globals: Record<string, unknown> = {
    console, Map, Set, Boolean, Object, createTurnCardGate,
    admittedLedgerLeases: new Map(), internalTurnOwners: new Map(),
    directRuns: { get: () => current },
    terminalDispatchFor: (event: { turnId?: string }) => event.turnId === "P" ? { identity: { dispatchGeneration: "G" } } : event.turnId === "P2" ? { identity: { dispatchGeneration: "G2" } } : undefined,
    delegationWatch: new Map(), lastReply: new Map(), registry: { get: () => ({ driverKind: "acp" }) }, engineNameOf: () => "The engine",
    wantsFailedTurnLine, wantsEmptyTurnLine, failedTurnLine, emptyTurnLine, turnWroteText, turnProducedSomething,
    pushMessage: (message: { tool: { name: string } }) => { pushed.push(message); },
  };
  const text = `${declaration("turnCardGate")}
    ${["noteOwnerStop", "foldCardScope"].map(declaration).join("\n")}
    function terminalLine(event, bot) {
      const executionEvent = event, eventLease = {}, completedTurnId = event.turnId, directOwnerTurn = true, replacementOwnsThread = false;
      const routineRun = undefined, stoppedRoutineTurn = false, lateRedispatch = undefined, errorShownForTurn = false, memoryEcho = undefined, echoOnlyReply = false;
      const lineRows = [];
      ${terminalLineStatements()}
    }
    ;globalThis.result = { noteOwnerStop, terminalLine, turnCardGate };`;
  const context = vm.createContext(globals);
  vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
  const built = context.result as { noteOwnerStop(threadId: string, botId?: string): void; terminalLine(event: unknown, bot: unknown): void; turnCardGate: ReturnType<typeof createTurnCardGate> };
  const terminal = (ok: boolean, stopReason: string, turnId = "P") => built.terminalLine({ type: "turn.completed", threadId: "T", turnId, provider: "acp", ok, stopReason }, bot);
  return { built, pushed, logs, terminal, next: () => { current = { generation: "G2", phase: "running" }; built.turnCardGate.admitted("T", "G2", "B"); } };
}

afterEach(() => vi.restoreAllMocks());
describe("STOP-CARD W4/W5: the terminal line after an owner Stop goes through the one gate", () => {
  it("W4: an ok:false 'error' terminal after Stop writes no failed line", () => {
    const r = rig();
    r.built.noteOwnerStop("T");
    r.terminal(false, "error");
    expect({ pushed: r.pushed, logs: r.logs }).toEqual({ pushed: [], logs: ["[turn] card-suppressed site=failed-line after=owner-stop"] });
  });
  it("W5: an ok:true empty terminal after Stop writes no empty line", () => {
    const r = rig();
    r.built.noteOwnerStop("T");
    r.terminal(true, "end_turn");
    expect({ pushed: r.pushed, logs: r.logs }).toEqual({ pushed: [], logs: ["[turn] card-suppressed site=empty-line after=owner-stop"] });
  });
  it("control: with no Stop each line is written once, verbatim", () => {
    const r = rig();
    r.terminal(false, "error");
    r.terminal(true, "end_turn");
    expect(r.pushed.map(m => m.tool.name)).toEqual([`error: ${failedTurnLine("Ada", false)}`, `error: ${emptyTurnLine("The engine")}`]);
  });
  it("control: the next admitted turn's failed line after a Stop of the earlier turn is written", () => {
    const r = rig();
    r.built.noteOwnerStop("T");
    r.next();
    r.terminal(false, "error", "P2");
    expect(r.pushed.map(m => m.tool.name)).toEqual([`error: ${failedTurnLine("Ada", false)}`]);
  });
});
