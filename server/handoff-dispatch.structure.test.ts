// The property that matters, as a test: a hand-off starts through ONE path (server/handoff-dispatch.ts), and no other code can start one.
// This resolves symbols with the TypeScript type checker over every non-test source under server/ (recursively), so a new caller that skirts the dispatch fails
// here before it can ship even when it renames the function (an alias), reaches it through a string or computed property, spreads an options object that
// carries the run, or forwards a start through a callback. The reviewer's mutation probes (an aliased startTurn, ['delegationRun'], a constant computed key, an option-forwarding
// helper in index.ts, a redispatch with `userMessage: undefined`) are run against it as negative tests: each must be reported.
//
// THIS TEST IS A LINT. The proof is at run time (handoff-capability.ts: a ticket only the dispatcher can mint; index.ts assertHandoffStartable: a ticket must be live and an
// already-started one may only run again with its own stored prompt; store.ts: a hand-off prompt id is written only in the transaction that starts its row).
// pm-sends-102-r26.test.ts forges each of those and shows the runtime refuses it whatever this analysis says.
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { DELEGATION_NOT_STARTABLE, _resetPending, drainDelegations, queueDelegation } from "./delegations.ts";
import * as dispatch from "./handoff-dispatch.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { runOf } from "./testing/handoff-turn.ts";
import { ownerWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(serverDir, "..");
const DISPATCH = "handoff-dispatch.ts";

// ── the program ──────────────────────────────────────────────────────────────────────

function sourcePaths(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // a dot folder is never source: parallel shards put their fixture data folders (server/.e2a-fixtures-*) in this tree while it is walked
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(path).isDirectory()) out.push(...sourcePaths(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
const PROBE = join(serverDir, "__structure_probe__.ts");
function buildProgram(given: Record<string, string> = {}, old?: ts.Program): ts.Program {
  // the compiler asks for files with '/' on every platform; the probes are keyed by join() (with '\\' on Windows)
  const norm = (file: string): string => file.replace(/\\/g, "/");
  const virtual: Record<string, string> = Object.fromEntries(Object.entries(given).map(([file, text]) => [norm(file), text]));
  const config = ts.readConfigFile(join(rootDir, "tsconfig.server.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, rootDir).options;
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host), fileExists = host.fileExists.bind(host), readFile = host.readFile.bind(host);
  host.fileExists = (file) => norm(file) in virtual || fileExists(file);
  host.readFile = (file) => virtual[norm(file)] ?? readFile(file);
  host.getSourceFile = (file, language, onError, shouldCreate) => (norm(file) in virtual ? ts.createSourceFile(file, virtual[norm(file)]!, language, true) : getSourceFile(file, language, onError, shouldCreate));
  const roots = sourcePaths(serverDir).filter((path) => !path.endsWith("pi-mcp-extension.ts"));
  return ts.createProgram([...roots, ...Object.keys(virtual)], options, host, old);
}

/** The file a node is in, relative to server/ ("" outside it); the program also holds what the sources import (shared/, node_modules). */
// relative names with '/' on every platform (Windows paths use '\\'), as the lists below are written
const rel = (file: ts.SourceFile): string => { const path = relative(serverDir, file.fileName).replace(/\\/g, "/"); return path.startsWith("..") ? "" : path; };
const isSource = (file: ts.SourceFile): boolean => { const r = rel(file); return r !== "" && !r.endsWith(".test.ts") && !r.endsWith(".d.ts") && !r.includes("node_modules"); };
const inTesting = (name: string): boolean => name.startsWith("testing/");

function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); }

// ── symbol resolution ────────────────────────────────────────────────────────────────

interface Analysis { violations: string[]; checker: ts.TypeChecker }
const strip = (expression: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression) ? strip(expression.expression) : expression);

function analyse(program: ts.Program, only?: string): Analysis {
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  const files = program.getSourceFiles().filter(isSource).filter((file) => !only || rel(file) === only);
  const report = (file: ts.SourceFile, node: ts.Node, rule: string, detail: string): void => {
    if (only && rel(file) !== only) return;
    violations.push(`${rule}: ${rel(file)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${detail}`);
  };
  const resolveAlias = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    let at = symbol;
    for (let hops = 0; at && at.flags & ts.SymbolFlags.Alias && hops < 10; hops++) { const next = checker.getAliasedSymbol(at); if (next === at) break; at = next; }
    return at;
  };
  /** The property or variable a name stands for, through imports, and the key of an element access with a literal key. */
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => resolveAlias(checker.getSymbolAtLocation(node));
  const declaredIn = (symbol: ts.Symbol | undefined, file: string, name: string): boolean =>
    Boolean(symbol && symbol.name === name && symbol.declarations?.some((declaration) => rel(declaration.getSourceFile()) === file));

  /** The key of an element access when it is knowable: a string literal, or any expression whose type is one string (`const key = "startTurn" as const`). */
  const constKey = (expression: ts.Expression): string | undefined => {
    const inner = strip(expression);
    if (ts.isStringLiteralLike(inner)) return inner.text;
    const type = checker.getTypeAtLocation(inner);
    return type.isStringLiteral() ? type.value : undefined;
  };
  /** The property an element access with a known key names, found on the type of the object (getPropertyOfType), not by the symbol of the key's variable. */
  const elementProperty = (access: ts.ElementAccessExpression): ts.Symbol | undefined => {
    const key = constKey(access.argumentExpression);
    if (key === undefined) return undefined;
    const property = checker.getPropertyOfType(checker.getTypeAtLocation(access.expression), key) ?? checker.getPropertyOfType(checker.getApparentType(checker.getTypeAtLocation(access.expression)), key);
    return resolveAlias(property);
  };

  /** Everything an expression is an alias of: itself, then what a `const x = <expression>` or `{ x: <expression> }` it names was set to. */
  function origins(expression: ts.Expression, seen = new Set<ts.Node>()): ts.Symbol[] {
    const inner = strip(expression);
    if (seen.has(inner)) return [];
    seen.add(inner);
    let symbol: ts.Symbol | undefined;
    if (ts.isIdentifier(inner)) symbol = symbolAt(inner);
    else if (ts.isPropertyAccessExpression(inner)) symbol = symbolAt(inner.name);
    else if (ts.isElementAccessExpression(inner)) symbol = elementProperty(inner) ?? symbolAt(inner.argumentExpression);
    if (!symbol) return [];
    const found = [symbol];
    for (const declaration of symbol.declarations ?? []) {
      if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer) found.push(...origins(declaration.initializer, seen));
      else if (ts.isShorthandPropertyAssignment(declaration)) { const value = checker.getShorthandAssignmentValueSymbol(declaration); if (value) found.push(value, ...(value.declarations ?? []).flatMap((d) => (ts.isVariableDeclaration(d) && d.initializer ? origins(d.initializer, seen) : []))); }
    }
    return found;
  }
  const isStartTurn = (symbols: ts.Symbol[]): boolean => symbols.some((symbol) =>
    declaredIn(symbol, "index.ts", "startTurn") || declaredIn(symbol, "index.ts", "startTurnAdmitting") || (declaredIn(symbol, DISPATCH, "startTurn")));
  const handoffRunMember = (symbol: ts.Symbol | undefined): boolean => Boolean(symbol && symbol.declarations?.some((declaration) => rel(declaration.getSourceFile()) === DISPATCH && declaration.parent && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "HandoffRun"));
  const typeHasRun = (type: ts.Type): boolean => Boolean(checker.getNonNullableType(type).getProperty("delegationRun"));
  /** The key of an object literal element, when it can be known: an identifier, a string, or a computed key whose type is one string. */
  function keyOf(name: ts.PropertyName | undefined): string | undefined | null {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) { const type = checker.getTypeAtLocation(name.expression); return type.isStringLiteral() ? type.value : null; }   // null: a key that is not a known string
    return undefined;
  }
  const BANNED_INTERNALS: Array<[string, string]> = [[DISPATCH, "startDelegation"], [DISPATCH, "markDelegationSubmitted"], [DISPATCH, "markDelegationAccepted"], [DISPATCH, "DispatchTicket"]];

  /** The names a start of the server's turn can be held under: startTurn itself, and whatever a const, property, binding or import renames it to (to a fixpoint, across files). */
  const finalName = (expression: ts.Expression): string | undefined => { const inner = strip(expression); return ts.isIdentifier(inner) ? inner.text : ts.isPropertyAccessExpression(inner) ? inner.name.text : ts.isElementAccessExpression(inner) ? constKey(inner.argumentExpression) : undefined; };
  const startNames = new Set(["startTurn", "startTurnAdmitting"]);
  for (let pass = 0, before = -1; pass < 6 && before !== startNames.size; pass++) {
    before = startNames.size;
    for (const file of program.getSourceFiles().filter(isSource)) walk(file, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && startNames.has(finalName(node.initializer) ?? "")) startNames.add(node.name.text);
      else if (ts.isPropertyAssignment(node) && startNames.has(finalName(node.initializer) ?? "")) { const key = keyOf(node.name); if (key) startNames.add(key); }
      else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && startNames.has(node.propertyName && (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName)) ? node.propertyName.text : node.name.text)) startNames.add(node.name.text);
      else if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && startNames.has((node.propertyName ?? node.name).text)) startNames.add(node.name.text);
    });
  }
  const bannedNames = new Set(BANNED_INTERNALS.map(([, banned]) => banned));
  /** The functions of index.ts that own the start of a hand-off's turn; the rest of the file is held to the same rules as any other source. */
  const INDEX_CONSUMERS = new Set(["startTurn", "startTurnAdmitting", "recordHandoffAccepted"]);
  /** A memory re-dispatch hands the SAME options on again, with the turn's own prompt: the spread comes first, `userMessage` is the turn's `userMessage` variable (the one
   * startTurnAdmitting declares, never undefined or a literal) and comes after it, `memoryRedispatch: attempt` too, and no later property puts a run or another prompt back. */
  const redispatchOf = (literal: ts.ObjectLiteralExpression, spread: ts.SpreadAssignment): boolean => {
    const at = literal.properties.indexOf(spread);
    const after = literal.properties.slice(at + 1);
    const named = (key: string) => after.find((p) => (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && keyOf(p.name) === key);
    const prompt = named("userMessage"), destination = named("threadId");
    const flag = after.find((p) => ts.isPropertyAssignment(p) && keyOf(p.name) === "memoryRedispatch");
    if (!prompt || !flag) return false;
    // the value of each is the variable of that name declared in startTurnAdmitting: the turn's own prompt and the turn's own destination, never a literal, undefined or another conversation
    const bound = (property: ts.ObjectLiteralElementLike, variable: string): boolean => {
      const valueSymbol = ts.isShorthandPropertyAssignment(property) ? checker.getShorthandAssignmentValueSymbol(property) : ts.isPropertyAssignment(property) && ts.isIdentifier(strip(property.initializer)) ? symbolAt(strip(property.initializer)) : undefined;
      return Boolean(valueSymbol?.declarations?.some((d) => (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) && d.name.getText() === variable && insideFunction(d, new Set(["startTurnAdmitting"]))));
    };
    if (!bound(prompt, "userMessage")) return false;
    if (destination && !bound(destination, "threadId")) return false;
    // nothing after the spread but the allowed keys
    return after.every((p) => { const key = keyOf(p.name); return key === "threadId" || key === "userMessage" || key === "memoryRedispatch"; });
  };
  /** Whether the node sits anywhere inside a function declaration with one of these names (an arrow or a closure nested in it counts: it is its code). */
  const insideFunction = (node: ts.Node, names: ReadonlySet<string>): boolean => { for (let at: ts.Node | undefined = node; at; at = at.parent) if (ts.isFunctionDeclaration(at) && at.name && names.has(at.name.text)) return true; return false; };
  const insideCall = (node: ts.Node, callee: string): boolean => { for (let at: ts.Node | undefined = node; at; at = at.parent) if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === callee) return true; return false; };

  for (const file of files) {
    const name = rel(file);
    // Who may read, declare, call or hold the hand-off's run: the dispatch itself, the test fakes, and in index.ts only the functions that own the start (never the whole file).
    const consumerFile = name === DISPATCH || inTesting(name);
    const consumerOf = (node: ts.Node): boolean => consumerFile || (name === "index.ts" && (insideFunction(node, INDEX_CONSUMERS) || insideCall(node, "configureHandoffDispatch")));
    walk(file, (node) => {
      const consumer = consumerOf(node);
      // R1: the ticket's internals and the stamp are named (by any alias, string key or namespace) only where they are made
      const nameNode = ts.isIdentifier(node) ? node : ts.isStringLiteralLike(node) && node.parent && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node ? node : undefined;
      // (the original name is always written somewhere in an alias chain: an import specifier, a property name or a string key, so only those are resolved)
      if (nameNode && bannedNames.has(nameNode.text)) {
        const symbol = symbolAt(nameNode);
        for (const [declaringFile, banned] of BANNED_INTERNALS) if (declaredIn(symbol, declaringFile, banned) && name !== declaringFile) report(file, node, "R1 internals", `${banned} is named outside ${declaringFile}`);
      }
      // R1a: an element access with a known (constant) key that names one of the banned members
      if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression)) {
        const key = constKey(node.argumentExpression);
        if (key !== undefined && bannedNames.has(key)) { const symbol = elementProperty(node); for (const [declaringFile, banned] of BANNED_INTERNALS) if (banned === key && declaredIn(symbol, declaringFile, banned) && name !== declaringFile) report(file, node, "R1 internals", `${banned} is reached through a constant computed key outside ${declaringFile}`); }
      }
      // R1b: an element access whose key cannot be known, on an object that has one of the banned members
      if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression) && !checker.getTypeAtLocation(node.argumentExpression).isStringLiteral()) {
        const type = checker.getTypeAtLocation(node.expression);
        if (BANNED_INTERNALS.some(([, banned]) => type.getProperty(banned)) && name !== DISPATCH) report(file, node, "R1b dynamic access", "a computed key on an object that holds the dispatch's internals");
      }
      // R2: nothing but the dispatch builds the option that carries a hand-off's run: a property, a computed or string key, a spread of options that carry it, an assignment
      if (name !== DISPATCH) {
        if (ts.isObjectLiteralExpression(node)) {
          for (const property of node.properties) {
            if (ts.isSpreadAssignment(property)) {
              if (typeHasRun(checker.getTypeAtLocation(property.expression))) {
                // the two memory re-dispatches (index.ts) hand the SAME options on again with the turn's own prompt (`userMessage`): the dispatch's run is never started by them (see the proof below)
                // a spread is also fine when the same literal clears the run (`delegationRun: undefined`): nothing downstream of that copy holds it
                // (the clear only counts when it comes AFTER the spread: a spread that comes later puts the run back)
                const at = node.properties.indexOf(property);
                const cleared = node.properties.some((p, index) => index > at && ts.isPropertyAssignment(p) && keyOf(p.name) === "delegationRun" && ts.isIdentifier(p.initializer) && p.initializer.text === "undefined");
                const sameTurn = cleared || name === "index.ts" && redispatchOf(node, property);
                if (!sameTurn) report(file, property, "R2 spread", "options that carry a hand-off's run are spread");
              }
              continue;
            }
            const key = keyOf(property.name);
            if (key === "delegationRun") { if (!(ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) && property.initializer.text === "undefined")) report(file, property, "R2 delegationRun", "builds the option that carries a hand-off's run"); }
            else if (key === null) { const contextual = checker.getContextualType(node); if (contextual && typeHasRun(contextual)) report(file, property, "R2 computed", "a computed key in options that may carry a hand-off's run"); }
          }
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = node.left;
          const written = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isElementAccessExpression(target) ? constKey(target.argumentExpression) : undefined;
          if (written === "delegationRun") report(file, node, "R2 assignment", "assigns the option that carries a hand-off's run");
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["assign", "defineProperty", "set"].includes(node.expression.name.text)) {
          for (const argument of node.arguments) if (ts.isStringLiteralLike(argument) && argument.text === "delegationRun") report(file, node, "R2 reflect", "defines the option that carries a hand-off's run");
        }
      }
      // R3: reading or declaring the option is for the server's startTurn (and the test fakes), not for anything else
      if (!consumer) {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "delegationRun") report(file, node, "R3 read", "reads the option that carries a hand-off's run");
        if (ts.isElementAccessExpression(node) && constKey(node.argumentExpression) === "delegationRun") report(file, node, "R3 read", "reads the option that carries a hand-off's run by key");
        if (ts.isBindingElement(node) && (node.propertyName ? keyOf(node.propertyName) : ts.isIdentifier(node.name) ? node.name.text : undefined) === "delegationRun") report(file, node, "R3 destructure", "destructures the option that carries a hand-off's run");
        if (ts.isPropertySignature(node) && keyOf(node.name) === "delegationRun") report(file, node, "R3 declare", "declares an option that carries a hand-off's run");
        // R7: nobody else is handed the run's type (a parameter, a variable or a callback signature that could forward it; an import under another name is found at its specifier)
        if (ts.isIdentifier(node) && (node.text === "HandoffRun" || node.text === "HandoffTurnOptions") && !ts.isImportSpecifier(node.parent)) {
          const symbol = symbolAt(node);
          if (declaredIn(symbol, DISPATCH, "HandoffRun") || declaredIn(symbol, DISPATCH, "HandoffTurnOptions")) report(file, node, "R7 type", `${node.text} is used outside the dispatch and the server`);
        }
      }
      // R4: the run's own methods are called only by the server's startTurn (and the test fakes)
      if (!consumer && ts.isCallExpression(node) && ["start", "within", "submitted", "accepted"].includes(finalName(node.expression) ?? "")) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? symbolAt(node.expression.name) : ts.isElementAccessExpression(node.expression) ? symbolAt(node.expression.argumentExpression) : undefined;
        if (handoffRunMember(callee)) report(file, node, "R4 run method", "calls a method of a hand-off's run");
      }
      // R5a: the host seam reached through a constant computed key (`host[key]`), called or passed on
      if (!consumer && name !== "index.ts" && ts.isElementAccessExpression(node) && startNames.has(constKey(node.argumentExpression) ?? "") && isStartTurn(origins(node))) {
        report(file, node, ts.isCallExpression(node.parent) && node.parent.expression === node ? "R5 startTurn" : "R5 reference", "reaches the server's startTurn or the dispatch's host seam through a constant computed key");
      }
      // R8: in index.ts a call to startTurn that hands on an options value it did not build in place (a parameter, a variable) forwards whatever run it carries
      if (name === "index.ts" && !consumer && ts.isCallExpression(node) && startNames.has(finalName(node.expression) ?? "") && isStartTurn(origins(node.expression))) {
        const options = node.arguments[2];
        if (options && !ts.isObjectLiteralExpression(strip(options)) && typeHasRun(checker.getTypeAtLocation(options))) report(file, node, "R8 forward", "forwards an options value that may carry a hand-off's run into startTurn");
      }
      // R5: nothing else starts a turn through the server's startTurn or the host seam; a start reached through an alias, a callback or a stored reference is found by its origin
      if (!consumer && name !== "index.ts") {
        if (ts.isCallExpression(node) && startNames.has(finalName(node.expression) ?? "") && isStartTurn(origins(node.expression))) report(file, node, "R5 startTurn", "starts a turn through the server's startTurn or the dispatch's host seam");
        if (ts.isIdentifier(node) && startNames.has(node.text) && !(ts.isCallExpression(node.parent) && node.parent.expression === node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && ts.isCallExpression(node.parent.parent))) {
          const symbol = symbolAt(node);
          if (isStartTurn(symbol ? [symbol] : []) && !ts.isPropertySignature(node.parent) && !ts.isMethodSignature(node.parent)) report(file, node, "R5 reference", "holds a reference to the server's startTurn");
        }
      }
    });
  }
  return { violations, checker };
}

let base: ts.Program;
let baseAnalysis: Analysis;
beforeAll(() => { base = buildProgram(); baseAnalysis = analyse(base); }, 300_000);

const sourceOf = (program: ts.Program, name: string): ts.SourceFile => program.getSourceFiles().find((file) => rel(file) === name)!;
function bodyOf(file: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  walk(file, (node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found = node.body; });
  return found;
}
function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText();
    if (ts.isVariableDeclaration(at) && at.initializer && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))) return at.name.getText();
    if (ts.isPropertyAssignment(at) && at.initializer && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))) return at.name.getText();
  }
  return "<module>";
}
/** Calls inside a body that resolve (by symbol, so by any alias) to a declaration with this name. */
function callsTo(checker: ts.TypeChecker, body: ts.Node, wanted: string): number {
  let n = 0;
  walk(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const target = ts.isIdentifier(node.expression) ? node.expression : ts.isPropertyAccessExpression(node.expression) ? node.expression.name : undefined;
    let symbol = target ? checker.getSymbolAtLocation(target) : undefined;
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (symbol?.name === wanted) n++;
  });
  return n;
}

describe("the dispatch is the only place a hand-off starts (symbols resolved with the type checker)", () => {
  it("reads every non-test server source, recursively", () => {
    const files = base.getSourceFiles().filter(isSource);
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => rel(file) === DISPATCH)).toBe(true);
    expect(files.some((file) => inTesting(rel(file)))).toBe(true);
    expect(files.some((file) => rel(file).startsWith("drivers/") || rel(file).startsWith("memory/"))).toBe(true);
  });

  it("the whole server is clean: no alias, string key, computed key, spread or callback starts a hand-off, builds its run, reads it or holds its type outside the dispatch and the server's startTurn", () => {
    expect(baseAnalysis.violations).toEqual([]);
  });

  it("startDelegation, markDelegationSubmitted, markDelegationAccepted, the ticket class and the stamp are not exported", () => {
    for (const name of ["startDelegation", "markDelegationSubmitted", "markDelegationAccepted", "DispatchTicket"]) expect(Object.keys(dispatch)).not.toContain(name);
  });

  it("the memory re-dispatches in index.ts hand on the SAME options with the turn's own prompt, so they can never start the hand-off's run again", () => {
    // every call that starts, or writes the prompt of, a hand-off's run is inside the branch that has no prompt yet: `if (!userMessage)`; the re-dispatches pass `userMessage`
    const index = sourceOf(base, "index.ts");
    const checker = baseAnalysis.checker;
    const outside: string[] = [];
    walk(index, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !["start", "within"].includes(node.expression.name.text)) return;
      const symbol = checker.getSymbolAtLocation(node.expression.name);
      if (!symbol?.declarations?.some((declaration) => declaration.parent && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "HandoffRun")) return;
      let guarded = false;
      for (let at: ts.Node | undefined = node; at; at = at.parent) if (ts.isIfStatement(at) && at.expression.getText() === "!userMessage" && at.thenStatement.pos <= node.pos && node.end <= at.thenStatement.end) guarded = true;
      if (!guarded) outside.push(`${enclosingName(node)}:${index.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    });
    expect(outside).toEqual([]);
    // and the re-dispatches themselves are exactly the two spreads the analysis allows, each with `userMessage` and `memoryRedispatch: attempt`
    let redispatches = 0;
    walk(index, (node) => {
      if (!ts.isObjectLiteralExpression(node) || !node.properties.some((p) => ts.isSpreadAssignment(p) && p.expression.getText() === "opts")) return;
      const keys = node.properties.map((p) => (ts.isSpreadAssignment(p) ? "..." : ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) ? p.name.getText() : ""));
      if (keys.includes("memoryRedispatch")) { redispatches++; expect(keys).toEqual(expect.arrayContaining(["...", "threadId", "userMessage", "memoryRedispatch"])); }
    });
    expect(redispatches).toBe(2);
  });

  it("the old second paths are gone: no processOne, runDelegatedTurn, delegationRunFor, redispatchTarget or mustWaitFor anywhere", () => {
    const gone = new Set(["processOne", "runDelegatedTurn", "delegationRunFor", "redispatchTarget", "mustWaitFor"]);
    const found: string[] = [];
    for (const file of base.getSourceFiles().filter(isSource)) walk(file, (node) => { if (ts.isIdentifier(node) && gone.has(node.text)) found.push(`${rel(file)}: ${node.text}`); });
    expect(found).toEqual([]);
  });

  it("no startTurn call (by symbol, so by any alias) and no approval logic sits inside the queue walk, the shared drain, the boot settling, the release functions, Send again, Dismiss or any other entry point", () => {
    const entryPoints: Array<[string, string]> = [
      ["delegations.ts", "drainDelegations"], ["delegations.ts", "settleStartedDelegations"], ["delegations.ts", "reconcileStartedDelegations"], ["delegations.ts", "settleAfterFailure"],
      ["delegations.ts", "releaseDelegationsWaitingOn"], ["delegations.ts", "releaseParkedDelegations"], ["delegations.ts", "resendHeldDelegation"], ["delegations.ts", "dismissHeldDelegation"],
      ["delegations.ts", "dropUnreachableDelegations"], ["delegations.ts", "discardDelegations"], ["delegations.ts", "stopWaitingDelegation"], ["delegations.ts", "dropQueuedDelegation"],
      ["shared-work.ts", "drainSharedWork"],
    ];
    for (const [fileName, name] of entryPoints) {
      const body = bodyOf(sourceOf(base, fileName), name);
      expect(body, `${fileName} ${name}`).toBeDefined();
      expect(callsTo(baseAnalysis.checker, body!, "startTurn"), `${name} must not start a turn`).toBe(0);
      expect(callsTo(baseAnalysis.checker, body!, "startTurnAdmitting"), `${name} must not start a turn`).toBe(0);
      expect(callsTo(baseAnalysis.checker, body!, "requestPeerApproval"), `${name} keeps no approval logic`).toBe(0);
    }
  });

  it("the walk and the shared drain hand every hand-off to dispatchHandoff, and the shared drain finds a hand-off's request by the hand-off row, not by the spelling of its key", () => {
    expect(callsTo(baseAnalysis.checker, bodyOf(sourceOf(base, "delegations.ts"), "drainDelegations")!, "dispatchHandoff")).toBeGreaterThan(0);
    const drain = bodyOf(sourceOf(base, "shared-work.ts"), "drainSharedWork")!;
    expect(callsTo(baseAnalysis.checker, drain, "dispatchHandoff")).toBeGreaterThan(0);
    expect(callsTo(baseAnalysis.checker, drain, "handoffPhaseOf")).toBe(1);
    // the partner is looked for by the request's id before anything else decides how the request starts
    let lookup: ts.CallExpression | undefined;
    walk(drain, (node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "handoffPhaseOf") lookup = node; });
    expect(lookup!.arguments.map((argument) => argument.getText())).toEqual(["row.id"]);
  });

  it("the releases ask the dispatch's own question: the server's predicate is admit, and nothing else decides it", () => {
    const index = sourceOf(base, "index.ts");
    expect(callsTo(baseAnalysis.checker, bodyOf(index, "handoffCanStartNow")!, "admit")).toBe(1);
    expect(index.text).toContain("handoffCanStartNow(handoffId)");
    // and the server drains only through drainDelegations with three arguments (no runner is passed any more)
    walk(index, (node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "drainDelegations") expect(node.arguments.length).toBe(3); });
    // boot settles through the paged settling, never the all-at-once one
    expect(callsTo(baseAnalysis.checker, index, "reconcileStartedDelegations")).toBe(0);
    expect(callsTo(baseAnalysis.checker, index, "settleStartedDelegations")).toBeGreaterThan(0);
  });

  it("every way execution state can be written is in a function that owns it: SQL that starts a hand-off, stamps its start or sets its phase from a parameter", () => {
    // allowed: (file, function) pairs. The dispatch's startDelegation is the only start; the others only HOLD (started_at=NULL), migrate a stand-in record, or are test fixtures.
    const startsOk = new Set([`${DISPATCH}:startDelegation`, "delegations.ts:holdUnexecuted", "delegations.ts:holdBusyGaveUp", "pending-delegations-schema.ts:migrateOwnerHandoffPage", "testing/handoff-turn.ts:forceStarted"]);
    const phaseFromParameterOk = new Set(["delegations.ts:stmts"]);
    const found: string[] = [];
    for (const file of base.getSourceFiles().filter(isSource)) {
      walk(file, (node) => {
        if (!ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) return;
        const text = (ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ") : node.text).replace(/\s+/g, " ").toLowerCase();
        if (!text.includes("pending_delegations")) return;
        const where = `${rel(file)}:${enclosingName(node)}`;
        // what a statement SETS (its WHERE clause is only a guard): a start, a stamp of the start time, or a bumped attempt count
        const set = /update pending_delegations set (.*?)(?: where |$)/.exec(text)?.[1] ?? "";
        const startsRow = /\bphase ?= ?'started'/.test(set) || /\bstarted_at ?= ?(\?|\d)/.test(set) || /insert [^;]*into pending_delegations[^;]*'started'/.test(text) || set.includes("start_attempts=coalesce(start_attempts,0)+1");
        if (startsRow && !startsOk.has(where)) found.push(`${where}: ${text.slice(0, 90)}`);
        if (/update pending_delegations set phase ?= ?\?/.test(text) && !phaseFromParameterOk.has(where)) found.push(`${where}: ${text.slice(0, 90)}`);
      });
    }
    expect(found).toEqual([]);
    expect(base.getSourceFiles().filter(isSource).some((file) => file.text.includes("start_attempts=COALESCE(start_attempts,0)+1") && rel(file) === DISPATCH)).toBe(true);
  });
});

describe("the structural analysis catches what the reviewer's mutation probes slip in (negative tests)", () => {
  const probe = (text: string): string[] => analyse(buildProgram({ [PROBE]: text }, base), "__structure_probe__.ts").violations;
  it("an aliased startTurn (the host seam held in a const and called under another name)", () => {
    const found = probe(`import type { HandoffHost } from "./handoff-dispatch.ts";
declare const host: HandoffHost;
const go = host.startTurn;
export const probe = () => go("bot", "text", { threadId: "x", commsDepth: 1, onDispatchError: () => {} } as never);
`);
    expect(found.join("\n")).toMatch(/R5 startTurn/);
  }, 300_000);
  it("a computed string key that carries the run: ['delegationRun']", () => {
    const found = probe(`import type { HandoffRun } from "./handoff-dispatch.ts";
export const probe = (run: HandoffRun) => ({ threadId: "x", commsDepth: 1, ["delegationRun"]: run, onDispatchError: () => {} });
`);
    expect(found.join("\n")).toMatch(/R2 delegationRun/);
  }, 300_000);
  it("the stamp function the dispatch used to register is gone: reaching for it, by a literal key, a constant computed key or an import, is a compile error", () => {
    const errors = (text: string): string => { const program = buildProgram({ [PROBE]: text }, base); return ts.getPreEmitDiagnostics(program, program.getSourceFile(PROBE)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"); };
    expect(errors(`import * as stamps from "./handoff-stamp.ts";
export const probe = () => stamps["registerHandoffStamp"](() => {});
`)).toMatch(/registerHandoffStamp/);
    expect(errors(`import * as stamps from "./handoff-stamp.ts";
const key = "registerHandoffStamp" as const;
export const probe = () => stamps[key](() => {});
`)).toMatch(/registerHandoffStamp/);
    expect(errors(`import { registerHandoffStamp } from "./handoff-stamp.ts";
export const probe = () => registerHandoffStamp(() => {});
`)).toMatch(/registerHandoffStamp/);
  }, 300_000);
  it("the host seam reached through a constant computed key: host[key](...), and forwarded through a typed callback", () => {
    const called = probe(`import type { HandoffHost } from "./handoff-dispatch.ts";
declare const host: HandoffHost;
const key = "startTurn" as const;
export const probe = () => host[key]("bot", "text", { threadId: "x", commsDepth: 1, onDispatchError: () => {} } as never);
`);
    expect(called.join("\n")).toMatch(/R5 startTurn/);
    const forwarded = probe(`import type { HandoffHost } from "./handoff-dispatch.ts";
declare const host: HandoffHost;
const key = "startTurn" as const;
const relay = (go: HandoffHost["startTurn"]) => go("bot", "text", { threadId: "x" } as never);
export const probe = () => relay(host[key]);
`);
    expect(forwarded.join("\n")).toMatch(/R5 reference/);
  }, 300_000);
  it("an option-forwarding startTurn helper added to index.ts, and a re-dispatch that clears the prompt (userMessage: undefined)", { tags: ["nightly"], timeout: 600_000 }, () => {
    const indexPath = join(serverDir, "index.ts");
    const real = readFileSync(indexPath, "utf8");
    const analyseIndex = (text: string): string[] => analyse(buildProgram({ [indexPath]: text }, base), "index.ts").violations;
    expect(analyseIndex(real)).toEqual([]);                                                   // (the real file is clean)
    const helper = analyseIndex(`${real}\nexport function relayStart(botId: string, options: Parameters<typeof startTurn>[2]) { return startTurn(botId, "x", options); }\n`);
    expect(helper.join("\n")).toMatch(/R8 forward/);
    const redispatch = "{ ...opts, threadId, userMessage, memoryRedispatch: attempt }";
    expect(real).toContain(redispatch);
    const cleared = analyseIndex(real.replace(redispatch, "{ ...opts, threadId, userMessage: undefined, memoryRedispatch: attempt }"));
    expect(cleared.join("\n")).toMatch(/R2 spread/);
    const reordered = analyseIndex(real.replace(redispatch, "{ userMessage, memoryRedispatch: attempt, threadId, ...opts }"));
    expect(reordered.join("\n")).toMatch(/R2 spread/);
    // r26b #6: a redispatch whose destination is another conversation (a literal, or any variable that is not the turn's own threadId) is reported too
    const elsewhere = analyseIndex(real.replace(redispatch, '{ ...opts, threadId: "another-existing-task", userMessage, memoryRedispatch: attempt }'));
    expect(elsewhere.join("\n")).toMatch(/R2 spread/);
    const otherVariable = analyseIndex(real.replace(redispatch, "{ ...opts, threadId: botId, userMessage, memoryRedispatch: attempt }"));
    expect(otherVariable.join("\n")).toMatch(/R2 spread/);
  });
  it("an options object spread that carries the run, and a callback that forwards it", () => {
    const spread = probe(`import type { HandoffTurnOptions } from "./handoff-dispatch.ts";
export const probe = (options: HandoffTurnOptions) => ({ ...options, threadId: "y" });
`);
    expect(spread.join("\n")).toMatch(/R2 spread/);
    const forwarded = probe(`import type { HandoffTurnOptions } from "./handoff-dispatch.ts";
export const relay = (start: (options: HandoffTurnOptions) => Promise<unknown>, options: HandoffTurnOptions) => start(options);
`);
    expect(forwarded.join("\n")).toMatch(/R7 type/);
  }, 300_000);
  it("a destructured, string-key or constant computed-key read of the run", () => {
    const read = probe(`export const probe = (options: Record<string, unknown>) => { const { delegationRun } = options as { delegationRun: unknown }; return options["delegationRun"] ?? delegationRun; };
`);
    expect(read.join("\n")).toMatch(/R3/);
    const computed = probe(`const key = "delegationRun" as const;
export const probe = (options: Record<string, unknown>) => options[key];
`);
    expect(computed.join("\n")).toMatch(/R3 read/);
  }, 300_000);
  it("the clean program is reported clean (the probes are what fail, not the method)", () => {
    expect(probe(`export const harmless = (a: number) => a + 1;
`)).toEqual([]);
  }, 300_000);
});

describe("the transcript refuses a hand-off's prompt that the dispatch did not stamp", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
  afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

  it("appendMessage with a dlg- id and no stamp throws and writes nothing; so does any function that is not the dispatch's", () => {
    const w = ownerWorld("owner");
    const count = () => Number((database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id LIKE 'dlg-%'").get(w.target.threadId) as { n: number }).n);
    expect(() => w.store.appendMessage(w.target.threadId, { role: "user", kind: "text", text: "sneaky" }, "dlg-sneaky")).toThrow(expect.objectContaining({ code: "HANDOFF_PROMPT_REFUSED" }));
    expect(() => w.store.appendMessage(w.target.threadId, { role: "user", kind: "text", text: "sneakier" }, "dlg-sneakier", () => {})).toThrow(expect.objectContaining({ code: "HANDOFF_PROMPT_REFUSED" }));
    expect(count()).toBe(0);
    // an ordinary message with an ordinary stable id is not affected
    expect(w.store.appendMessage(w.target.threadId, { role: "user", kind: "text", text: "fine" }, "plain-id").id).toBe("plain-id");
  });

  it("a ticket that the dispatch cleared (a failed start) can no longer start anything", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "x", depth: 0 }, 2).id!;
    w.knobs.beforeStamp = () => { throw new Error("refused"); };
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(w.turns).toEqual([]);
    expect(() => runOf(id).start(w.target.threadId)).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    expect(Number((database().prepare("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='started'").get() as { n: number }).n)).toBe(0);
  });

  it("a ticket for a conversation other than the stored one cannot start (the stored destination is enforced at the commit)", async () => {
    const w = ownerWorld("owner");
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "pinned", depth: 0 }, 2).id!;
    let refusal: unknown;
    w.knobs.beforeStamp = () => { try { runOf(id).start("another-conversation"); } catch (error) { refusal = error; } };
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(refusal).toMatchObject({ code: DELEGATION_NOT_STARTABLE });
    expect(w.turns.map((turn) => turn.id)).toEqual([id]);                       // and the real start, on the stored conversation, went through
    expect(w.turns[0]!.thread).toBe(w.target.threadId);
  });
});
