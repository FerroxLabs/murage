// STOP-CARD-SPEC W16: every turn-scoped card write by the turn's own card writers in index.ts sits lexically inside
// `turnCardGate.write(`. A write site is a message write (append/patch/push) whose argument, with its local names resolved,
// carries a card: an `ok: false` tool (literal, shorthand variable or conditional branch), a diagnostic helper's card, or the
// ledger's notice line. A port handed a card writer (the dropped-delegation chip) must call it only through the gate.
// A new raw card write in one of these writers, or a gate removed from any existing write, fails here.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";

/** The writers that write cards for one turn (spec section 2 sites A-N): their top-level declaration names in index.ts. */
const WRITERS = new Set([
  "foldRuntimeEvent", "prepareTerminalEvent", "startTurnAdmitting", "giveBackAdmittedTurn", "runGroupMemberTurnDispatch",
  "markGatewayBusy", "putLimitLine", "failOverThread", "failoverRefusalSteps", "resendRecorded", "onDirectLimitTurnCompleted", "hurryDelegatedReplyCheck",
  "admitLedgerLease",
]);
/** The watchdog's onStall lives in an object literal: matched by its property name. */
const NESTED_WRITERS = new Set(["onStall"]);
/** Top-level execution subscribers (the repeat notice, the dropped-delegation chip): named by their order in index.ts. */
const SUBSCRIBER = "bus.subscribeExecution";
/** Helpers whose result is a card or notice line. */
const CARD_HELPERS = new Set(["turnFailureDiagnostic", "sendNoticeLine"]);
/** Callees handed a card writer as a port: the argument index of that writer. */
const CARD_PORTS: Record<string, number> = { settleQueuedDelegations: 5 };
const WRITE_CALL = /(^|\.)(appendMessage|patchMessage|pushMessage|push)$/;

// Spec O: the Stop's own unconfirmed-termination record remains visible.
const STOP_RECORD = "error: provider termination is unconfirmed after access changed: restart Murage before continuing";

const resolvedNames = new WeakMap<ts.Node, ts.Node | null>();

/** The covered writer that owns `node` (inside `top`, one top-level statement), or undefined. */
function ownerOf(node: ts.Node, top: ts.Statement, label: string | undefined, ast: ts.SourceFile): string | undefined {
  for (let n: ts.Node | undefined = node; n && n !== top; n = n.parent) {
    if (ts.isPropertyAssignment(n) && NESTED_WRITERS.has(n.name.getText(ast))) return n.name.getText(ast);
  }
  return label && (WRITERS.has(label) || label.startsWith(`${SUBSCRIBER}#`)) ? label : undefined;
}

/** Each top-level statement with its writer label: a declaration's name, or a subscriber's order among subscribers. */
function labelled(ast: ts.SourceFile): { top: ts.Statement; label: string | undefined }[] {
  let subscriber = 0;
  return ast.statements.map(top => {
    if (ts.isFunctionDeclaration(top)) return { top, label: top.name?.text };
    if (ts.isVariableStatement(top)) return { top, label: top.declarationList.declarations[0]?.name.getText(ast) };
    if (ts.isExpressionStatement(top) && ts.isCallExpression(top.expression) && top.expression.expression.getText(ast) === SUBSCRIBER) return { top, label: `${SUBSCRIBER}#${subscriber++}` };
    return { top, label: undefined };
  });
}

function insideGateWrite(node: ts.Node, ast: ts.SourceFile, stop?: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n && n !== stop; n = n.parent) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === "turnCardGate.write") return true;
  }
  return false;
}

/** The initializer of the nearest declaration of `name` visible from `from`, in its enclosing blocks and functions. */
function resolve(name: string, from: ts.Node, ast: ts.SourceFile): ts.Node | undefined {
  const cached = resolvedNames.get(from);
  if (cached !== undefined) return cached ?? undefined;
  for (let scope: ts.Node | undefined = from.parent; scope && scope !== ast; scope = scope.parent) {
    let found: ts.Node | undefined;
    const look = (n: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && n.getStart(ast) < from.getStart(ast)) { found = n.initializer; return; }
      if (n !== scope && (ts.isFunctionLike(n) || ts.isBlock(n))) return;
      ts.forEachChild(n, look);
    };
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope)) ts.forEachChild(scope, look);
    if (found) { resolvedNames.set(from, found); return found; }
  }
  resolvedNames.set(from, null);
  return undefined;
}

/** Whether `node` (its local names resolved) carries a card; the Stop record alone is not one. */
function carriesCard(node: ts.Node, ast: ts.SourceFile, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isObjectLiteralExpression(node) && node.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === "ok" && p.initializer.kind === ts.SyntaxKind.FalseKeyword)) {
    const name = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === "name");
    if (!(name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer) && name.initializer.text === STOP_RECORD)) return true;
  }
  if (ts.isCallExpression(node) && CARD_HELPERS.has(node.expression.getText(ast))) return true;
  if (ts.isShorthandPropertyAssignment(node) || (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))) {
    const target = resolve(ts.isShorthandPropertyAssignment(node) ? node.name.text : (node as ts.Identifier).text, node, ast);
    if (target && carriesCard(target, ast, seen)) return true;
  }
  return !!ts.forEachChild(node, child => carriesCard(child, ast, seen) || undefined);
}

/** A port's card writer must call its write callback only through the gate. */
function portBypasses(writer: ts.Node, ast: ts.SourceFile): boolean {
  if (ts.isIdentifier(writer)) { const target = resolve(writer.text, writer, ast); return target ? portBypasses(target, ast) : true; }
  if (!ts.isArrowFunction(writer) && !ts.isFunctionExpression(writer)) return true;
  const param = writer.parameters[0]?.name.getText(ast);
  if (!param) return true;
  let gated = false, raw = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === param && !ts.isParameter(n.parent)) {
      if (insideGateWrite(n, ast, writer)) gated = true; else raw = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(writer.body);
  return raw || !gated;
}

function rawTurnCardWrites(text: string): Record<string, number> {
  const ast = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const raw: Record<string, number> = {};
  for (const { top, label } of labelled(ast)) {
    // Only statements that can hold a covered writer: a named writer, a subscriber, or one holding a nested writer.
    if (!(label && (WRITERS.has(label) || label.startsWith(`${SUBSCRIBER}#`))) && ![...NESTED_WRITERS].some(n => top.getText(ast).includes(`${n}:`))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        const port = CARD_PORTS[callee];
        const bypass = WRITE_CALL.test(callee)
          ? node.arguments.some(a => carriesCard(a, ast)) && !insideGateWrite(node, ast)
          : port !== undefined && node.arguments[port] !== undefined && portBypasses(node.arguments[port]!, ast);
        const owner = bypass ? ownerOf(node, top, label, ast) : undefined;
        if (owner) raw[owner] = (raw[owner] ?? 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(top);
  }
  return raw;
}

/** Each gated write with its owning statement's text, before and with that one gate removed:
 * `turnCardGate.write(site, scope, write)` becomes a direct `(write)()`. */
function gateSites(text: string): { site: string; line: number; owner: string; mutated: string }[] {
  const ast = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: { site: string; line: number; owner: string; mutated: string }[] = [];
  for (const { top, label } of labelled(ast)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "turnCardGate.write" && node.arguments.length === 3) {
        const [site, , write] = node.arguments;
        const owner = ownerOf(node, top, label, ast) ?? String(label);
        // The owner alone, in a file of its own: a subscriber is then the first subscriber.
        const at = (n: number) => n - top.getStart(ast), whole = top.getText(ast);
        sites.push({ site: (site as ts.StringLiteral).text, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          owner: owner.startsWith(`${SUBSCRIBER}#`) ? `${SUBSCRIBER}#0` : owner,
          mutated: `${whole.slice(0, at(node.getStart(ast)))}(${write!.getText(ast)})()${whole.slice(at(node.getEnd()))}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(top);
  }
  return sites;
}

describe("STOP-CARD W16: no turn card write bypasses the single gate", () => {
  it("every ok:false card in the turn's card writers is inside turnCardGate.write (the Stop record is exempt)", () => {
    expect(rawTurnCardWrites(source)).toEqual({});
  });
  it("the guard sees a raw write: a bare ok:false card added to foldRuntimeEvent is reported", () => {
    const mutated = source.replace("const foldRuntimeEvent = (executionEvent: RuntimeEvent) => {",
      "const foldRuntimeEvent = (executionEvent: RuntimeEvent) => { pushMessage({ tool: { name: \"error: x\", ok: false } });");
    expect(mutated).not.toBe(source);
    expect(rawTurnCardWrites(mutated).foldRuntimeEvent).toBe(1);
  });
  it("removing any one gate is reported: each of the gated writes in index.ts, individually", () => {
    const sites = gateSites(source);
    expect(sites.length).toBe(33);
    expect(sites.map(s => s.site)).toEqual(expect.arrayContaining(["ledger-present", "fold-notice", "delegations-dropped", "limit", "submission", "dispatch-failure", "give-back"]));
    const missed = sites.filter(s => !(rawTurnCardWrites(s.mutated)[s.owner]! >= 1)).map(s => `${s.site}@${s.owner}:${s.line}`);
    expect(missed).toEqual([]);
  });
  it("the writers the guard covers all exist in index.ts", () => {
    const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = new Set(ast.statements.flatMap(s => ts.isFunctionDeclaration(s) ? [s.name?.text] : ts.isVariableStatement(s) ? [s.declarationList.declarations[0]?.name.getText(ast)] : []));
    expect([...WRITERS].filter(w => !names.has(w))).toEqual([]);
    expect(source.includes("onStall:")).toBe(true);
    expect(ast.statements.filter(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(ast) === SUBSCRIBER).length).toBeGreaterThan(1);
  });
});
