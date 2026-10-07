// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every HTTP route the harness answers, read out of the real dispatcher.
//
// There is no route table to ask. server/index.ts is one `createServer`
// callback with a hand-written if-chain: `path === "/api/..."` checks, regex
// matches (`/^\/api\/.../.exec(path)`, `path.match(...)`, `X.test(path)`),
// `path.startsWith("/api/...")` subtrees, `[...].includes(path)` lists and
// calls into delegated handler modules (artifacts, inbox, media, workspace
// files, local models, memory, voice). A deny-by-default policy is only as
// good as the list of routes it is checked against, so this reads that list
// from the source with the TypeScript parser instead of trusting a hand-kept
// copy (plan 0.1.61 section 4.2a). route-policy.test.ts runs it.
//
// What it reads:
//  - the createServer callback in server/index.ts, and every local module the
//    callback hands the path to (a call whose arguments carry `path`, `url`
//    or an object with a `path` field);
//  - in those, every comparison of a path value with an "/api..." constant,
//    every regex anchored at "^/api" tested against a path value, every
//    `startsWith` of an "/api..." constant, and the `.find(prefix => ...)`
//    idiom over a list of prefix constants;
//  - constants through imports, template literals, `as const` objects and
//    `Object.freeze`;
//  - the methods each route answers, from the `method === "X"` tests that
//    guard it (the condition it sits in, the conditions of the blocks around
//    it, and for a match stored in a variable, the `if`s that test that
//    variable next). No method test means any method.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..", "..");

export type RouteKind = "exact" | "regex" | "prefix";
export interface DiscoveredRoute {
  /** null: the dispatcher does not narrow the method. */
  methods: string[] | null;
  kind: RouteKind;
  /** The literal path, the regex source, or the subtree prefix. */
  pattern: string;
  file: string;
  line: number;
  /** Concrete request paths this route answers, for checking a policy. */
  samples: string[];
}

type Value = string | RegExp | { [key: string]: Value } | Value[];

const PATH_NAMES = new Set(["path", "pathname", "url.pathname", "request.path", "req.path", "input.path", "request.url.pathname"]);
const METHOD_NAMES = new Set(["method", "request.method", "req.method", "input.method"]);
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const sources = new Map<string, ts.SourceFile>();
function sourceFile(file: string): ts.SourceFile {
  let sf = sources.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sources.set(file, sf);
  }
  return sf;
}

function localModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), join(base, "index.ts")]) if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  return undefined;
}

/** The declaration an identifier names at module level, followed through imports. */
function declarationOf(name: string, sf: ts.SourceFile, depth = 0): { init: ts.Expression; sf: ts.SourceFile } | undefined {
  if (depth > 6) return undefined;
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) return { init: decl.initializer, sf };
      }
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (element.name.text !== name) continue;
        const target = localModule(sf.fileName, statement.moduleSpecifier.text);
        if (target) return declarationOf((element.propertyName ?? element.name).text, sourceFile(target), depth + 1);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        const target = localModule(sf.fileName, statement.moduleSpecifier.text);
        if (target) return declarationOf((element.propertyName ?? element.name).text, sourceFile(target), depth + 1);
      }
    }
  }
  return undefined;
}

function regexFromLiteral(text: string): RegExp {
  const end = text.lastIndexOf("/");
  return new RegExp(text.slice(1, end), text.slice(end + 1));
}

/** The constant value of an expression, when the source fixes it. */
function valueOf(node: ts.Expression, sf: ts.SourceFile, depth = 0): Value | undefined {
  if (depth > 12) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return valueOf(node.expression, sf, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return regexFromLiteral(node.text);
  if (ts.isTemplateExpression(node)) {
    // A part may be one of a list (a callback parameter): so is the result.
    let out: string[] = [node.head.text];
    let many = false;
    for (const span of node.templateSpans) {
      const part = valueOf(span.expression, sf, depth + 1);
      const parts = Array.isArray(part) ? part : [part];
      if (Array.isArray(part)) many = true;
      if (parts.some(item => typeof item !== "string")) return undefined;
      out = out.flatMap(head => (parts as string[]).map(item => head + item + span.literal.text));
    }
    return many ? out : out[0];
  }
  if (ts.isNewExpression(node) && node.expression.getText(sf) === "RegExp" && node.arguments?.[0]) {
    const source = valueOf(node.arguments[0], sf, depth + 1);
    const flags = node.arguments[1] ? valueOf(node.arguments[1], sf, depth + 1) : "";
    return typeof source === "string" && typeof flags === "string" ? new RegExp(source, flags) : undefined;
  }
  if (ts.isCallExpression(node) && node.expression.getText(sf) === "Object.freeze" && node.arguments[0]) return valueOf(node.arguments[0], sf, depth + 1);
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(element => valueOf(element as ts.Expression, sf, depth + 1));
    return items.every(item => item !== undefined) ? items as Value[] : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: { [key: string]: Value } = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      const value = key ? valueOf(property.initializer, sf, depth + 1) : undefined;
      if (key && value !== undefined) out[key] = value;
    }
    return out;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = valueOf(node.expression, sf, depth + 1);
    return object && typeof object === "object" && !(object instanceof RegExp) && !Array.isArray(object) ? object[node.name.text] : undefined;
  }
  if (ts.isIdentifier(node)) {
    // A callback parameter over a list of constants: `[A, B].find(prefix => ...)`.
    const parameter = callbackListValue(node, sf, depth);
    if (parameter) return parameter;
    const decl = declarationOf(node.text, sf);
    return decl ? valueOf(decl.init, decl.sf, depth + 1) : undefined;
  }
  return undefined;
}

function callbackListValue(node: ts.Identifier, sf: ts.SourceFile, depth: number): Value[] | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (!ts.isArrowFunction(at) && !ts.isFunctionExpression(at)) continue;
    const parameter = at.parameters.find(item => ts.isIdentifier(item.name) && item.name.text === node.text);
    if (!parameter) return undefined;
    const call = at.parent;
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || !["find", "some", "filter", "findIndex"].includes(call.expression.name.text)) return undefined;
    const list = valueOf(call.expression.expression, sf, depth + 1);
    return Array.isArray(list) ? list : undefined;
  }
  return undefined;
}

const isPathExpression = (node: ts.Expression, sf: ts.SourceFile) => PATH_NAMES.has(node.getText(sf));
const isMethodExpression = (node: ts.Expression, sf: ts.SourceFile) => METHOD_NAMES.has(unwrap(node).getText(sf));
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return node;
}

/** A relative path variable: `const rest = request.path.slice(PREFIX.length)`. */
function relativeBase(node: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (!ts.isBlock(at) && !ts.isSourceFile(at)) continue;
    for (const statement of at.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== node.text || !decl.initializer) continue;
        const init = unwrap(decl.initializer);
        if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === "slice"
          && isPathExpression(init.expression.expression, sf) && init.arguments[0] && ts.isPropertyAccessExpression(init.arguments[0])
          && init.arguments[0].name.text === "length") {
          const base = valueOf(init.arguments[0].expression, sf);
          if (typeof base === "string" && base.startsWith("/api")) return base;
        }
      }
    }
  }
  return undefined;
}

// "/api" itself, or the whole "/api/" namespace, is the gate in front of
// every route (route-policy.ts), not a route.
const API = (value: string) => value.startsWith("/api/") && value !== "/api/";
const apiRegex = (value: RegExp) => /^\^(?:\\\/|\/)api(?:\\\/|\/|\(|$)/.test(value.source);

interface Test { node: ts.Node; kind: RouteKind; pattern: string; samples: string[] }

/** The route tests one node makes, if it is one. */
function routeTests(node: ts.Node, sf: ts.SourceFile): Test[] {
  const out: Test[] = [];
  const addValue = (value: Value | undefined, kind: "exact" | "prefix", base = "") => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string") continue;
      const full = base + item;
      if (!API(full)) continue;
      if (kind === "exact") out.push({ node, kind, pattern: full, samples: [full] });
      else out.push({ node, kind, pattern: full.replace(/\/$/, ""), samples: [full.endsWith("/") ? `${full}probe` : `${full}/probe`] });
    }
  };
  const addRegex = (value: Value | undefined, base = "") => {
    if (!(value instanceof RegExp)) return;
    if (base) { out.push({ node, kind: "regex", pattern: `${base}${value.source.replace(/^\^/, "")}`, samples: regexSamples(value).map(sample => base + sample) }); return; }
    if (apiRegex(value)) out.push({ node, kind: "regex", pattern: value.source, samples: regexSamples(value) });
  };
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    for (const [a, b] of [[node.left, node.right], [node.right, node.left]]) {
      if (isPathExpression(a, sf)) addValue(valueOf(b, sf), "exact");
      else { const base = relativeBase(a, sf); if (base) addValue(valueOf(b, sf), "exact", base); }
    }
  }
  // `if (path !== X) return ...;` the route is what the rest of the block answers
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && earlyReturnGuard(node)) {
    for (const [a, b] of [[node.left, node.right], [node.right, node.left]]) if (isPathExpression(a, sf)) addValue(valueOf(b, sf), "exact");
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text, target = node.expression.expression, arg = node.arguments[0];
    if ((name === "exec" || name === "test") && arg) {
      if (isPathExpression(arg, sf)) addRegex(valueOf(target, sf));
      else { const base = relativeBase(arg, sf); if (base) addRegex(valueOf(target, sf), base); }
    }
    if (name === "match" && arg && isPathExpression(target, sf)) addRegex(valueOf(arg, sf));
    if (name === "startsWith" && arg && isPathExpression(target, sf)) addValue(valueOf(arg, sf), "prefix");
    if (name === "includes" && arg && isPathExpression(arg, sf)) addValue(valueOf(target, sf), "exact");
  }
  return out;
}

/** `path !== X` as the whole condition of an `if` (or one of its && parts)
 * whose branch returns: everything after it answers X. */
function earlyReturnGuard(node: ts.Expression): boolean {
  let at: ts.Node = node;
  while (ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) at = at.parent;
  const statement = at.parent;
  if (!statement || !ts.isIfStatement(statement) || statement.expression !== at) return false;
  const then = statement.thenStatement;
  return ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.length > 0 && ts.isReturnStatement(then.statements[then.statements.length - 1]));
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** The methods one condition allows, or null when it does not say. */
function methodSet(node: ts.Expression, sf: ts.SourceFile): Set<string> | null {
  node = unwrap(node);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      for (const [a, b] of [[node.left, node.right], [node.right, node.left]]) {
        const value = isMethodExpression(a, sf) ? valueOf(b, sf) : undefined;
        if (typeof value === "string") return new Set([value]);
      }
      return null;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const left = methodSet(node.left, sf), right = methodSet(node.right, sf);
      return left && right ? new Set([...left, ...right]) : null;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = methodSet(node.left, sf), right = methodSet(node.right, sf);
      if (left && right) return new Set([...left].filter(item => right.has(item)));
      return left ?? right;
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes"
    && node.arguments[0] && isMethodExpression(node.arguments[0], sf)) {
    const list = valueOf(node.expression.expression, sf);
    if (Array.isArray(list) && list.every(item => typeof item === "string")) return new Set(list as string[]);
  }
  return null;
}

/** Conjuncts that hold wherever `node` is evaluated inside `condition`. */
function conjunctsAround(node: ts.Node, condition: ts.Expression): ts.Expression[] {
  const out: ts.Expression[] = [];
  let child = node;
  for (let at = node.parent; at && child !== condition; child = at, at = at.parent) {
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) out.push(at.left === child ? at.right : at.left);
    if (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) return [];
    if (ts.isConditionalExpression(at) && at.whenTrue === child) out.push(at.condition);
    if (ts.isConditionalExpression(at) && at.whenFalse === child) return out;
  }
  return out;
}

function topConjuncts(condition: ts.Expression): ts.Expression[] {
  condition = unwrap(condition);
  if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...topConjuncts(condition.left), ...topConjuncts(condition.right)];
  return [condition];
}

function intersect(sets: Array<Set<string> | null>): Set<string> | null {
  let out: Set<string> | null = null;
  for (const set of sets) {
    if (!set) continue;
    const kept: string[] = out ? [...(out as Set<string>)].filter(item => set.has(item)) : [...set];
    out = new Set(kept);
  }
  return out;
}

/** Where `node` sits: the condition or expression statement that holds it. */
function methodsFor(node: ts.Node, sf: ts.SourceFile, stop: ts.Node): Set<string> | null {
  const sets: Array<Set<string> | null> = [];
  let child: ts.Node = node;
  for (let at = node.parent; at && at !== stop; child = at, at = at.parent) {
    if (ts.isIfStatement(at) && at.expression === child) {
      for (const conjunct of conjunctsAround(node, at.expression)) sets.push(methodSet(conjunct, sf));
    } else if (ts.isIfStatement(at) && at.thenStatement === child) {
      for (const conjunct of topConjuncts(at.expression)) sets.push(methodSet(conjunct, sf));
    } else if (ts.isIfStatement(at) && at.elseStatement === child) {
      // the negation of a method test narrows nothing we can state
    } else if ((ts.isVariableDeclaration(at) || (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken)) && child !== at) {
      const variable = ts.isVariableDeclaration(at) ? at.name : at.left;
      if (ts.isIdentifier(variable)) {
        const own = conjunctsAround(node, (ts.isVariableDeclaration(at) ? at.initializer : at.right) as ts.Expression);
        const inline = intersect(own.map(conjunct => methodSet(conjunct, sf)));
        const later = methodsOfLaterTests(at, variable.text, sf);
        sets.push(inline && later ? intersect([inline, later]) : inline ?? later);
        if (!ts.isBinaryExpression(at) || !isConditionPart(at)) {
          // keep climbing: enclosing blocks narrow the route too
        }
      }
    }
  }
  return intersect(sets);
}

function isConditionPart(node: ts.Node): boolean {
  for (let at = node.parent; at; at = at.parent) if (ts.isIfStatement(at)) return true; else if (ts.isBlock(at)) return false;
  return false;
}

/** For `m = path.match(...)` / `const x = /.../.exec(path)`: the methods of
 * the `if`s that test the variable before it is reassigned. */
function methodsOfLaterTests(assignment: ts.Node, variable: string, sf: ts.SourceFile): Set<string> | null {
  let statement: ts.Node = assignment;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) statement = statement.parent;
  // an assignment inside an if condition: that if is the test
  if (ts.isIfStatement(statement)) {
    const own = conjunctsWithVariable(statement.expression, variable, sf);
    return own;
  }
  const block = statement.parent as ts.Block;
  if (!block || !("statements" in block)) return null;
  const index = block.statements.indexOf(statement as ts.Statement);
  const found: Array<Set<string> | null> = [];
  for (const next of block.statements.slice(index + 1)) {
    if (reassigns(next, variable, sf)) break;
    if (ts.isIfStatement(next) && mentions(next.expression, variable)) found.push(conjunctsWithVariable(next.expression, variable, sf));
  }
  if (!found.length || found.some(set => set === null)) return null;
  return new Set(found.flatMap(set => [...set!]));
}

function conjunctsWithVariable(condition: ts.Expression, variable: string, sf: ts.SourceFile): Set<string> | null {
  let hit: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!hit && ts.isIdentifier(node) && node.text === variable) hit = node; else ts.forEachChild(node, visit); };
  visit(condition);
  if (!hit) return null;
  return intersect(conjunctsAround(hit, condition).map(conjunct => methodSet(conjunct, sf)));
}

function mentions(node: ts.Node, variable: string): boolean {
  let found = false;
  const visit = (at: ts.Node) => { if (found) return; if (ts.isIdentifier(at) && at.text === variable) found = true; else ts.forEachChild(at, visit); };
  visit(node);
  return found;
}

function reassigns(node: ts.Node, variable: string, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (at: ts.Node) => {
    if (found) return;
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken && at.left.getText(sf) === variable) found = true;
    else ts.forEachChild(at, visit);
  };
  // an `if` that tests the variable and reassigns it inside is still a test
  if (ts.isIfStatement(node)) visit(node.expression);
  else visit(node);
  return found;
}

// ---------------------------------------------------------------------------
// Regex samples
// ---------------------------------------------------------------------------

/** Concrete strings a route regex matches: every alternative of every group,
 * optional parts both present and absent (bounded). Enough of the regex
 * language for route patterns: groups, alternation, classes, escapes and
 * quantifiers. */
export function regexSamples(regex: RegExp, limit = 64): string[] {
  const source = regex.source;
  let at = 0;
  const cap = (list: string[]) => [...new Set(list)].slice(0, limit);
  const product = (a: string[], b: string[]) => cap(a.flatMap(x => b.map(y => x + y)));
  function alternation(): string[] {
    let out: string[] = [];
    let branch = sequence();
    out = out.concat(branch);
    while (source[at] === "|") { at++; branch = sequence(); out = out.concat(branch); }
    return cap(out);
  }
  function sequence(): string[] {
    let out = [""];
    while (at < source.length && source[at] !== "|" && source[at] !== ")") {
      const atom = atomSamples();
      out = product(out, quantified(atom));
    }
    return out;
  }
  function quantified(atom: string[]): string[] {
    const q = source[at];
    if (q === "?" || q === "*") { at++; if (source[at] === "?") at++; return cap(["", ...atom]); }
    if (q === "+") { at++; if (source[at] === "?") at++; return atom; }
    if (q === "{") {
      const close = source.indexOf("}", at);
      const [min] = source.slice(at + 1, close).split(",").map(Number);
      at = close + 1;
      return atom.map(item => item.repeat(Math.max(min, 1)));
    }
    return atom;
  }
  function atomSamples(): string[] {
    const c = source[at];
    if (c === "^" || c === "$") { at++; return [""]; }
    if (c === "(") {
      at++;
      if (source.startsWith("?:", at) || source.startsWith("?=", at) || source.startsWith("?!", at)) at += 2;
      const inner = alternation();
      at++; // ")"
      return inner;
    }
    if (c === "[") {
      const close = classEnd(at);
      const body = source.slice(at + 1, close);
      at = close + 1;
      return [classSample(body)];
    }
    if (c === "\\") {
      const next = source[at + 1];
      at += 2;
      if (next === "w") return ["a"];
      if (next === "d") return ["1"];
      if (next === "s") return [" "];
      return [next];
    }
    if (c === ".") { at++; return ["a"]; }
    at++;
    return [c];
  }
  function classEnd(from: number): number {
    for (let i = from + 1; i < source.length; i++) { if (source[i] === "\\") { i++; continue; } if (source[i] === "]") return i; }
    return source.length - 1;
  }
  function classSample(body: string): string {
    if (body.startsWith("^")) return "a";
    if (body.startsWith("\\w") || body.startsWith("\\d")) return body.startsWith("\\w") ? "a" : "1";
    if (body[0] === "\\") return body[1];
    return body[0];
  }
  const out = alternation().filter(sample => regex.test(sample));
  return out.length ? out : [];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function dispatcher(sf: ts.SourceFile): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "createServer" && node.arguments[0]
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))) found = node.arguments[0];
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error("server/index.ts: the createServer dispatcher was not found");
  return found;
}

/** Local modules the dispatcher hands the request path to. */
function delegatedModules(root: ts.Node, sf: ts.SourceFile): string[] {
  const modules = new Set<string>();
  const carriesPath = (arg: ts.Expression): boolean => {
    arg = unwrap(arg);
    if (ts.isIdentifier(arg)) return ["path", "url", "delegated"].includes(arg.text);
    if (ts.isObjectLiteralExpression(arg)) return arg.properties.some(p => p.name && ["path", "url"].includes(p.name.getText(sf)));
    return false;
  };
  const callees = (expr: ts.Expression): ts.Identifier[] => {
    expr = unwrap(expr);
    if (ts.isIdentifier(expr)) return [expr];
    if (ts.isConditionalExpression(expr)) return [...callees(expr.whenTrue), ...callees(expr.whenFalse)];
    return [];
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.some(carriesPath)) {
      for (const callee of callees(node.expression)) {
        for (const statement of sf.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings) && bindings.elements.some(element => element.name.text === callee.text)) {
            const target = localModule(sf.fileName, statement.moduleSpecifier.text);
            if (target) modules.add(target);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return [...modules].sort();
}

function collect(root: ts.Node, sf: ts.SourceFile, stop: ts.Node, into: Map<string, DiscoveredRoute>, rootDir: string) {
  const file = relative(rootDir, sf.fileName).split("\\").join("/");
  const visit = (node: ts.Node) => {
    for (const test of routeTests(node, sf)) {
      if (!insideCondition(node, stop)) continue;
      const methods = methodsFor(node, sf, stop);
      const key = `${test.kind} ${test.pattern}`;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const known = into.get(key);
      const list = methods ? [...methods].filter(method => HTTP_METHODS.includes(method)).sort() : null;
      if (!known) into.set(key, { methods: list, kind: test.kind, pattern: test.pattern, file, line, samples: test.samples });
      else known.methods = known.methods === null || list === null ? null : [...new Set([...known.methods, ...list])].sort();
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** A route test decides a branch: it sits in an `if` condition, a guard
 * expression or a match stored for one. A path compared to pick a label
 * (`requiredKind` in the internal block) is not a route. */
function insideCondition(node: ts.Node, stop: ts.Node): boolean {
  let child: ts.Node = node;
  for (let at = node.parent; at && at !== stop; child = at, at = at.parent) {
    // `!path.startsWith(...)`: the branch is everything else
    if (ts.isPrefixUnaryExpression(at) && at.operator === ts.SyntaxKind.ExclamationToken) return false;
    if (ts.isIfStatement(at)) return at.expression === child;
    // a path test that picks a value, not a branch
    if (ts.isConditionalExpression(at) && at.condition === child) return false;
    // a match used as a value (`X.exec(path)![1]`, an argument), except the
    // `[...prefixes].find(prefix => path === prefix ...)` idiom
    if (ts.isElementAccessExpression(at)) return false;
    if (ts.isCallExpression(at) && at.expression !== child) {
      const callback = (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) && ts.isPropertyAccessExpression(at.expression) && ["find", "some"].includes(at.expression.name.text);
      if (!callback) return false;
    }
    if (ts.isVariableDeclaration(at) || (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.EqualsToken)) return true;
    if (ts.isReturnStatement(at) || ts.isExpressionStatement(at)) return false;
  }
  return false;
}

export function discoverRoutes(rootDir = ROOT): DiscoveredRoute[] {
  sources.clear();
  const index = sourceFile(join(rootDir, "server", "index.ts"));
  const root = dispatcher(index);
  const routes = new Map<string, DiscoveredRoute>();
  collect(root, index, root, routes, rootDir);
  for (const module of delegatedModules(root, index)) {
    const sf = sourceFile(module);
    // Each module's own routes first, every method its branches test
    // (house-rules.ts answers GET in one if and PUT in the next)...
    const own = new Map<string, DiscoveredRoute>();
    collect(sf, sf, sf, own, rootDir);
    for (const [key, route] of own) {
      const known = routes.get(key);
      if (!known) { routes.set(key, route); continue; }
      // ...then narrowed by the dispatcher branch that reaches the module.
      // A module testing methods the dispatcher never names keeps them.
      const narrowed = known.methods === null ? route.methods : route.methods === null ? known.methods : known.methods.filter(method => route.methods!.includes(method));
      known.methods = narrowed !== null && narrowed.length === 0 ? known.methods : narrowed;
    }
  }
  return [...routes.values()].sort((a, b) => a.pattern.localeCompare(b.pattern) || a.kind.localeCompare(b.kind));
}

/** A one-line description, for reports and failure messages. */
export function describeRoute(route: DiscoveredRoute): string {
  return `${(route.methods ?? ["*"]).join(",")} ${route.kind === "regex" ? `/${route.pattern}/` : route.kind === "prefix" ? `${route.pattern}/**` : route.pattern} (${route.file}:${route.line})`;
}
