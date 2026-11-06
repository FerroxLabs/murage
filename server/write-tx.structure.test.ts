// SPDX-License-Identifier: AGPL-3.0-or-later
// DBBUSY-1018, structurally: no write transaction on a shared database file starts DEFERRED. A top-level `SAVEPOINT` or a bare
// `BEGIN` reads on a snapshot and asks for the write lock only at its first write; when another connection (the checkpointer
// worker's search-index merge slices, wal-maintenance.ts) commits in between, that write fails with SQLITE_BUSY_SNAPSHOT (517),
// which no busy wait cures, and the owner sees "Busy for a moment". Write frames go through beginWrite (write-tx.ts), which takes
// BEGIN IMMEDIATE at top level and a SAVEPOINT only inside an open transaction.
//
// Under server/ (tests and test support excluded) every string passed to an `.exec(...)` call that starts with SAVEPOINT, or
// with BEGIN not followed by IMMEDIATE or EXCLUSIVE, is counted per file; so is the same text inside worker source strings
// (`.exec("BEGIN")` written into a string a worker evaluates; those are not AST calls in this file, so they are found by a
// text match over every string literal). Only the files below may have them, at exactly these counts. For the files that are
// "SAVEPOINT only when nested" (guarded: true), the NEAREST if/else or ?: around each opener in its own function must test
// nesting of the same handle the opener's `.exec` runs on (`<db>.isTransaction`, directly, negated, or through a const that
// lexically resolves to it) and the opener must sit on the branch that runs only inside an open transaction. A deleted or
// inverted guard fails even when the count is unchanged; an unrelated if further out, another handle's isTransaction, or a
// same-named const in another block does not stand in for it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const server = dirname(fileURLToPath(import.meta.url));

/** File (relative to server/, posix) -> how many deferred openers it may have, and why each is not a deferred write. */
const ALLOWED: Record<string, { count: number; why: string; guarded?: true }> = {
  "write-tx.ts": { count: 1, why: "the helper: SAVEPOINT only when a transaction is open (nested), after BEGIN IMMEDIATE otherwise" },
  "database.ts": { count: 1, why: "transaction(): SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "installation-app-schema-downgrade.ts": { count: 1, why: "SAVEPOINT only inside the caller's transaction (outer), BEGIN IMMEDIATE otherwise", guarded: true },
  "app-trigger-store.ts": { count: 1, why: "inTx: SAVEPOINT only when db.isTransaction, BEGIN IMMEDIATE otherwise", guarded: true },
  "memory/learning-ledger.ts": { count: 1, why: "SAVEPOINT only when outer, beginForSource (BEGIN IMMEDIATE) otherwise", guarded: true },
  "memory/outcomes.ts": { count: 1, why: "SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "memory/procedure-landing.ts": { count: 1, why: "SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "memory/lessons.ts": { count: 1, why: "SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "room-requests.ts": { count: 1, why: "SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "pending-delegations-schema.ts": { count: 2, why: "pd_rebuild and pd_migrate: SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "mobile-push-store.ts": { count: 1, why: "SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "bot-calls-schema.ts": { count: 2, why: "SAVEPOINT only when nested, BEGIN IMMEDIATE otherwise", guarded: true },
  "memory/index-reader.ts": { count: 1, why: "read-only snapshot of the memory index scan (never writes, so never 517; must not wait for writers)" },
  "setup-thread-facts.ts": { count: 1, why: "read-only snapshot of the setup facts (never writes; only when no transaction is open)" },
  "memory/upgrade-counts.ts": { count: 1, why: "worker source: one read-only snapshot for the upgrade counts" },
  "memory/provenance-stamp.ts": { count: 1, why: "worker source: one read-only snapshot for the provenance recompute" },
  "health/stats-publisher.ts": { count: 1, why: "worker source: a new private snapshot file no other connection opens" },
  "skill-search.ts": { count: 2, why: "the skill index temp file and an in-memory team index: private to this process, no other writer" },
};

const DEFERRED_START = /^\s*(?:SAVEPOINT\b|BEGIN\b(?!\s+(?:IMMEDIATE|EXCLUSIVE)\b))/i;
const DEFERRED_IN_SOURCE = /\.exec\(\s*["'`]\s*(?:SAVEPOINT\b|BEGIN\b(?!\s+(?:IMMEDIATE|EXCLUSIVE)\b))/gi;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "testing" || name === "testdata") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !/\.(test|spec)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node);

const strip = (expr: ts.Expression): ts.Expression => { while (ts.isParenthesizedExpression(expr)) expr = expr.expression; return expr; };
const receiverText = (expr: ts.Expression): string => strip(expr).getText().replace(/\s+/g, "");

/** True when the binding name (an identifier or a destructuring pattern) declares `name`. */
function bindsName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some(element => !ts.isOmittedExpression(element) && bindsName(element.name, text));
}
/** What `scope` itself declares under `name`: the const declaration (with its initializer), "other" for any other binding
 *  (let/var, a parameter, a destructured name, a function, class or import), undefined when this scope does not declare it. */
function declaredIn(scope: ts.Node, text: string): ts.VariableDeclaration | "other" | undefined {
  const fromList = (list: ts.VariableDeclarationList): ts.VariableDeclaration | "other" | undefined => {
    for (const declaration of list.declarations) {
      if (!bindsName(declaration.name, text)) continue;
      return ts.isIdentifier(declaration.name) && declaration.initializer && (list.flags & ts.NodeFlags.Const) ? declaration : "other";
    }
    return undefined;
  };
  const fromStatements = (statements: readonly ts.Statement[]): ts.VariableDeclaration | "other" | undefined => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) { const hit = fromList(statement.declarationList); if (hit) return hit; }
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === text) return "other";
      else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause, bindings = clause.namedBindings;
        if (clause.name?.text === text) return "other";
        if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === text) return "other";
        if (bindings && ts.isNamedImports(bindings) && bindings.elements.some(element => element.name.text === text)) return "other";
      }
    }
    return undefined;
  };
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) return fromStatements(scope.statements);
  if (ts.isCaseBlock(scope)) { for (const clause of scope.clauses) { const hit = fromStatements(clause.statements); if (hit) return hit; } return undefined; }
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some(parameter => bindsName(parameter.name, text))) return "other";
    if ((ts.isFunctionExpression(scope) || ts.isFunctionDeclaration(scope)) && scope.name?.text === text) return "other";
    return undefined;
  }
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) return fromList(scope.initializer);
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, text)) return "other";
  return undefined;
}
/** The declaration `id` actually refers to, by lexical scope (the innermost enclosing scope that declares the name wins, so a
 *  same-named const in a sibling or outer block never stands in for a shadowing one). */
function resolveBinding(id: ts.Identifier): ts.VariableDeclaration | "other" | undefined {
  for (let at: ts.Node | undefined = id.parent; at; at = at.parent) { const hit = declaredIn(at, id.text); if (hit) return hit; }
  return undefined;
}

/** The value of `expr` as a nesting test of the handle `receiver`: true when it is `<receiver>.isTransaction` (or a const that
 *  lexically resolves to one), false when it is the negation of one, undefined when it tests anything else (another handle's
 *  isTransaction included). */
function nestingPolarity(expr: ts.Expression, receiver: string, depth = 0): boolean | undefined {
  expr = strip(expr);
  if (depth > 8) return undefined;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = nestingPolarity(expr.operand, receiver, depth + 1);
    return inner === undefined ? undefined : !inner;
  }
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === "isTransaction" && receiverText(expr.expression) === receiver ? true : undefined;
  if (!ts.isIdentifier(expr)) return undefined;
  const bound = resolveBinding(expr);
  return bound && bound !== "other" && bound.initializer ? nestingPolarity(bound.initializer, receiver, depth + 1) : undefined;
}

/** The receiver of the `.exec(...)` call whose first argument holds `node`, or undefined. */
function execReceiver(node: ts.Node): string | undefined {
  for (let child: ts.Node = node, at = node.parent; at; child = at, at = at.parent) {
    if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && at.expression.name.text === "exec" && at.arguments[0] === child) return receiverText(at.expression.expression);
    if (ts.isFunctionLike(at)) return undefined;
  }
  return undefined;
}

/** True when the NEAREST if/else or ?: around `node` in its own function tests nesting of the SAME handle the opener's `.exec`
 *  runs on (`db.isTransaction`, directly or via a const that lexically resolves to it) and `node` is on the branch that runs
 *  only inside an open transaction. An unrelated if around the opener, another handle's isTransaction, or a shadowed const
 *  does not count. */
function underGuard(node: ts.Node): boolean {
  const receiver = execReceiver(node);
  if (receiver === undefined) return false;
  let child: ts.Node = node;
  for (let at = node.parent; at && !ts.isFunctionLike(at) && !ts.isSourceFile(at); child = at, at = at.parent) {
    let branch: boolean | undefined, condition: ts.Expression | undefined;
    if (ts.isIfStatement(at) && child !== at.expression) { condition = at.expression; branch = child === at.thenStatement; }
    else if (ts.isConditionalExpression(at) && child !== at.condition) { condition = at.condition; branch = child === at.whenTrue; }
    if (!condition) continue;
    const polarity = nestingPolarity(condition, receiver);
    return polarity !== undefined && polarity === branch;
  }
  return false;
}
const unguarded = new Map<string, number[]>();

/** file -> the lines of every deferred opener in it (and, in `unguarded`, the ones with no if/?: around them). */
function deferredOpeners(root = server): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const path of sources(root)) {
    const text = readFileSync(path, "utf8");
    if (!/SAVEPOINT|BEGIN/i.test(text)) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = relative(root, path).split(sep).join("/");
    const note = (node: ts.Node) => {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const lines = found.get(rel) ?? []; lines.push(line); found.set(rel, lines);
      if (!underGuard(node)) { const bare = unguarded.get(rel) ?? []; bare.push(line); unguarded.set(rel, bare); }
    };
    const inExecArg = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec" && node.arguments[0]) {
        const mark = (inner: ts.Node): void => {
          if (isText(inner)) { inExecArg.add(inner); if (DEFERRED_START.test(inner.text)) note(inner); }
          ts.forEachChild(inner, mark);
        };
        mark(node.arguments[0]);
      }
      if (isText(node) && !inExecArg.has(node)) for (const _ of node.text.matchAll(DEFERRED_IN_SOURCE)) note(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

describe("write transactions claim the write lock up front (DBBUSY-1018)", () => {
  const found = deferredOpeners();

  it("no top-level SAVEPOINT or deferred BEGIN outside the allowlist: write frames use beginWrite (write-tx.ts)", () => {
    const offenders = [...found].filter(([file]) => !ALLOWED[file]).map(([file, lines]) => `${file}:${lines.join(",")} use beginWrite/endWrite/undoWrite (write-tx.ts)`);
    expect(offenders).toEqual([]);
  });

  it("each allowlisted file has exactly its listed count (a new opener needs its reason; a removed one comes off the list)", () => {
    const counts = Object.fromEntries([...found].filter(([file]) => ALLOWED[file]).map(([file, lines]) => [file, lines.length]));
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, entry]) => [file, entry.count]));
    expect(counts).toEqual(expected);
  });

  it("every nested-only file keeps its SAVEPOINT on the nested branch of an isTransaction guard (a removed or inverted guard fails here)", () => {
    const bare = Object.entries(ALLOWED).filter(([, entry]) => entry.guarded).flatMap(([file]) => (unguarded.get(file) ?? []).map(line => `${file}:${line}`));
    expect(bare).toEqual([]);
  });

  it("the scan sees what it must: a deferred SAVEPOINT, a bare BEGIN in a worker source, and not BEGIN IMMEDIATE or comments", () => {
    expect(DEFERRED_START.test("SAVEPOINT x")).toBe(true);
    expect(DEFERRED_START.test("BEGIN")).toBe(true);
    expect(DEFERRED_START.test("BEGIN DEFERRED")).toBe(true);
    expect(DEFERRED_START.test("BEGIN IMMEDIATE")).toBe(false);
    expect(DEFERRED_START.test("BEGIN EXCLUSIVE")).toBe(false);
    expect([...'db.exec("BEGIN");'.matchAll(DEFERRED_IN_SOURCE)].length).toBe(1);
    expect([...'db.exec("BEGIN IMMEDIATE");'.matchAll(DEFERRED_IN_SOURCE)].length).toBe(0);
    const guarded = (src: string) => {
      const file = ts.createSourceFile("g.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let hit: ts.Node | undefined;
      const walk = (node: ts.Node): void => { if (ts.isStringLiteral(node) && node.text.startsWith("SAVEPOINT")) hit = node; ts.forEachChild(node, walk); };
      walk(file);
      return underGuard(hit!);
    };
    expect(guarded('function f(db){ const nested = db.isTransaction; db.exec(nested ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); }')).toBe(true);
    expect(guarded('function f(db){ const outer = db.isTransaction; if (!outer) db.exec("BEGIN IMMEDIATE"); else db.exec("SAVEPOINT a"); }')).toBe(true);
    expect(guarded('function f(db){ if (db.isTransaction) { db.exec("SAVEPOINT a"); } }')).toBe(true);
    // the pending-delegations shape with its ternary removed: an unrelated if around it is not a guard
    expect(guarded('function f(db, existing){ if (existing) { const nested = db.isTransaction; db.exec("SAVEPOINT a"); } }')).toBe(false);
    expect(guarded('function f(db){ const nested = db.isTransaction; db.exec(nested ? "BEGIN IMMEDIATE" : "SAVEPOINT a"); }')).toBe(false);
    expect(guarded('function f(db, x){ db.exec(x ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); }')).toBe(false);
    expect(guarded('function f(db){ let nested = db.isTransaction; nested = false; db.exec(nested ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); }')).toBe(false);
    // another handle's isTransaction is not a guard for this handle's SAVEPOINT (directly or through a const)
    expect(guarded('function f(db, otherDb){ if (otherDb.isTransaction) db.exec("SAVEPOINT p"); }')).toBe(false);
    expect(guarded('function f(db, otherDb){ const nested = otherDb.isTransaction; db.exec(nested ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); }')).toBe(false);
    expect(guarded('function f(self){ if (self.db.isTransaction) self.db.exec("SAVEPOINT p"); }')).toBe(true);
    // the const the condition names is the one in scope: a same-named const in a sibling block does not stand in for it
    expect(guarded('function f(db, flag){ { const nested = db.isTransaction; } { const nested = flag; db.exec(nested ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); } }')).toBe(false);
    expect(guarded('function f(db, flag){ { const nested = flag; } { const nested = db.isTransaction; db.exec(nested ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); } }')).toBe(true);
    expect(guarded('function f(db){ const nested = db.isTransaction; return (nested) => db.exec(nested ? "SAVEPOINT a" : "BEGIN IMMEDIATE"); }')).toBe(false);
    // the helper itself is seen (its nested SAVEPOINT), so the walk reaches template heads inside exec arguments
    expect(found.get("write-tx.ts")?.length).toBe(1);
  });
});
