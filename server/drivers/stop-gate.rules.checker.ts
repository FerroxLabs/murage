// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STOP-NONACP r3 + r3.1: the checker behind stop-gate.rules.test.ts. TypeScript compiler API only (typescript is already a devDependency).
//
//   R1  every `await` (and `for await`), every .then/.catch/.finally on a Promise-like, every detached Promise-like statement is one of:
//       `await gate.step(e, p)`; `await gate.cleanupStep(e, p)` (cleanupStep only in functions on the CLEANUP list); or a listed EXEMPT SITE
//       { key, ordinal, text } (D1). The gate is resolved by symbol (a variable initialised by createStopGate) or by type (StopGate shape),
//       never by its text, so `stopGate` and `stop.gate` are both found. A turn-path function may call a not-turn / reap function only
//       as the argument of a gate call / inside a catch, finally or onStopped callback; an async turn-path function used as a value is
//       red; each unless a listed site.
//   R2  (D2) an object literal `type: "turn.completed" | "turn.started"` anywhere in a scanned file; an EMITTERS call whose event is not
//       an object literal with a string-literal `type` (and no spread after it); an alias of an emitter. Dynamic emits and aliases
//       are red unless a listed site. Ending literals can never be exempt.
//   R3  (D3) a launch primitive call (spawnCli/execCli/child_process imports, global fetch, `.stdin.write(...)`, `.stdin.end(data)`,
//       `request(method)` with a launch method or a method not provably outside LAUNCH_METHODS) must have the callback given to
//       `gate.launch` as its nearest enclosing function and no await/yield before it in that callback; else red unless a listed site.
//   CFG a site that matches nothing, an unknown key, a CLEANUP key that is not there or never uses cleanupStep, a site with no reason.
//
// Keys, not lines: `codex>create>sendTurn>launchAttempt`; anonymous callbacks `>#n` (n = order among the anonymous functions of
// their parent), a repeated sibling name gets `name#2`. Ordinals are 1-based per function and per kind, nested functions excluded.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DEFAULT_PRIMITIVE_IMPORTS, ENDING, LAUNCH_METHODS, ROW_KINDS } from "./stop-gate.rules.config.ts";
import type { EngineRules, FnRule, RowKind } from "./stop-gate.rules.config.ts";

export type RuleId = "R1" | "R2" | "R3" | "CFG";
export interface Diagnostic { rule: RuleId; engine: string; key: string; line: number; kind: string; ordinal: number; text: string; message: string }

export interface Item {
  kind: RowKind;
  key: string;
  ordinal: number;
  text: string;
  line: number;
  pos: number;
  /** why this item needs an exempt site; undefined: compliant, no site needed */
  violation?: { rule: RuleId; message: string };
}

export interface Analysis {
  engine: EngineRules;
  fileName: string;
  items: Item[];
  /** every function key in the file -> its node */
  keys: Map<string, ts.Node>;
  direct: Diagnostic[];
  cleanupUsed: Map<string, number>;
}

export interface Ctx { program: ts.Program; checker: ts.TypeChecker }

const GATE_METHODS = new Set(["step", "cleanupStep", "launch", "handoff", "run", "drain", "close", "ask", "enter", "leave", "settleOutstanding"]);
const GATE_SHAPE = ["step", "cleanupStep", "launch", "handoff"];

export const fingerprint = (s: string): string => {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length <= 140 ? c : `${c.slice(0, 120)}...[${c.length}]`;
};

export function rowField(kind: RowKind): "awaits" | "chains" | "detached" | "emits" | "launches" | "calls" | "refs" {
  switch (kind) {
    case "await": return "awaits";
    case "chain": return "chains";
    case "detached": return "detached";
    case "emit": return "emits";
    case "launch": return "launches";
    case "call": return "calls";
    case "ref": return "refs";
  }
}

// ---------------------------------------------------------------------------------------------------------------- program

export function createRulesProgram(repoRoot: string, rootFiles: string[], virtual: Record<string, string> = {}): Ctx {
  const cfgPath = path.join(repoRoot, "tsconfig.server.json");
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read ${cfgPath}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined };
  const host = ts.createCompilerHost(options, true);
  const abs = (f: string) => path.resolve(repoRoot, f);
  const virt = new Map<string, string>(Object.entries(virtual).map(([k, v]) => [abs(k), v]));
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => virt.has(path.resolve(f)) || origFileExists(f);
  host.readFile = (f) => virt.get(path.resolve(f)) ?? origReadFile(f);
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const v = virt.get(path.resolve(f));
    if (v !== undefined) return ts.createSourceFile(f, v, lang, true);
    return origGetSourceFile(f, lang, onError, shouldCreate);
  };
  const roots = [...rootFiles.map(abs), ...virt.keys()];
  const program = ts.createProgram({ rootNames: [...new Set(roots)], options, host });
  return { program, checker: program.getTypeChecker() };
}

// ---------------------------------------------------------------------------------------------------------------- helpers

const unwrap = (e: ts.Node): ts.Node => {
  let n = e;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    else return n;
  }
};

const isFnLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

const propName = (n: ts.PropertyName): string => (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n) ? n.text : n.getText());

function fnName(node: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return propName(node.name);
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  let p: ts.Node | undefined = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p))) p = p.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return propName(p.name);
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
    if (ts.isIdentifier(p.left)) return p.left.text;
  }
  return undefined;
}

/** key of every function-like node, and the reverse map. */
export function computeKeys(sf: ts.SourceFile, id: string): { keyOf: Map<ts.Node, string>; nodeOf: Map<string, ts.Node> } {
  const keyOf = new Map<ts.Node, string>();
  const nodeOf = new Map<string, ts.Node>();
  const used = new Map<string, number>();
  const visit = (node: ts.Node, parentKey: string, anon: { n: number }): void => {
    let pk = parentKey;
    let an = anon;
    if (isFnLike(node)) {
      let name = fnName(node);
      if (name === undefined) { anon.n += 1; name = `#${anon.n}`; }
      let key = `${parentKey}>${name}`;
      const seen = (used.get(key) ?? 0) + 1;
      used.set(key, seen);
      if (seen > 1) key = `${key}#${seen}`;
      keyOf.set(node, key);
      nodeOf.set(key, node);
      pk = key;
      an = { n: 0 };
    }
    ts.forEachChild(node, (c) => visit(c, pk, an));
  };
  visit(sf, id, { n: 0 });
  return { keyOf, nodeOf };
}

/** a name that declares or labels rather than uses a value (so it is neither an alias nor a function-as-value use). */
function isDeclarationPosition(node: ts.Node, par: ts.Node): boolean {
  if (ts.isVariableDeclaration(par) || ts.isParameter(par) || ts.isFunctionDeclaration(par) || ts.isMethodDeclaration(par) || ts.isPropertyAssignment(par)) return par.name === node;
  if (ts.isBindingElement(par)) return par.name === node || par.propertyName === node;
  if (ts.isBinaryExpression(par)) return par.left === node && par.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  return ts.isImportSpecifier(par) || ts.isExportSpecifier(par) || ts.isImportClause(par) || ts.isNamespaceImport(par) || ts.isPropertySignature(par)
    || ts.isMethodSignature(par) || ts.isTypeReferenceNode(par) || ts.isPropertyDeclaration(par) || ts.isTypeQueryNode(par) || ts.isQualifiedName(par)
    || ts.isNamedTupleMember(par) || ts.isLabeledStatement(par) || ts.isBreakOrContinueStatement(par) || ts.isTypePredicateNode(par);
}

/** every await/yield positioned before `call` in `fn`'s own body (nested functions excluded); an await that contains the call does not precede it. */
function precedingSuspend(fn: ts.FunctionLikeDeclaration, call: ts.Node): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n !== fn && isFnLike(n)) return;
    const suspend = ts.isAwaitExpression(n) || ts.isYieldExpression(n) || (ts.isForOfStatement(n) && !!n.awaitModifier);
    if (suspend) {
      const contains = n.getStart() <= call.getStart() && call.getEnd() <= n.getEnd();
      if (!contains && n.getStart() < call.getEnd()) { found = n; return; }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------- analysis

export function analyze(ctx: Ctx, fileName: string, engine: EngineRules): Analysis {
  const { program, checker } = ctx;
  const sf = program.getSourceFile(path.resolve(fileName));
  if (!sf) throw new Error(`rules: ${fileName} is not in the program`);
  const { keyOf, nodeOf } = computeKeys(sf, engine.id);
  const items: Item[] = [];
  const direct: Diagnostic[] = [];
  const cleanupUsed = new Map<string, number>();
  const counters = new Map<string, number>();
  const fnRules = new Map<string, FnRule>(engine.fns.map((f) => [f.key, f]));
  const cleanup = new Set(engine.cleanup);
  const emitters = new Set(engine.emitters);
  const primitiveImports = new Set([...DEFAULT_PRIMITIVE_IMPORTS, ...(engine.primitiveImports ?? [])]);
  const requestFns = new Set(engine.requestFns ?? []);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const text = (n: ts.Node) => fingerprint(n.getText(sf));

  const fnOf = (n: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (isFnLike(p)) return p;
    return undefined;
  };
  const keyOfNode = (n: ts.Node): string => {
    const f = fnOf(n);
    return f ? (keyOf.get(f) ?? engine.id) : engine.id;
  };
  const kindOfKey = (key: string): "turn" | "not-turn" | "close" | "reap" => fnRules.get(key)?.kind ?? "turn";

  const push = (kind: RowKind, node: ts.Node, violation?: { rule: RuleId; message: string }, txt?: string): void => {
    const key = keyOfNode(node);
    const ck = `${key}|${kind}`;
    const ordinal = (counters.get(ck) ?? 0) + 1;
    counters.set(ck, ordinal);
    items.push({ kind, key, ordinal, text: txt ?? text(node), line: line(node), pos: node.getStart(sf), violation });
  };
  const diag = (rule: RuleId, node: ts.Node, message: string, kind = ""): void => {
    const key = keyOfNode(node);
    direct.push({ rule, engine: engine.id, key, line: line(node), kind, ordinal: 0, text: text(node), message });
  };

  // ---- gate resolution: by symbol, then by type
  const gateCache = new Map<ts.Node, boolean>();
  const isGate = (e0: ts.Node): boolean => {
    const e = unwrap(e0);
    const hit = gateCache.get(e);
    if (hit !== undefined) return hit;
    let res = false;
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const sym = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrap(decl.initializer);
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "createStopGate") res = true;
      }
    }
    if (!res) {
      const t = checker.getTypeAtLocation(e);
      if (!(t.flags & ts.TypeFlags.Any)) res = GATE_SHAPE.every((p) => !!checker.getPropertyOfType(checker.getApparentType(t), p));
    }
    gateCache.set(e, res);
    return res;
  };
  const gateCall = (n: ts.Node): string | undefined => {
    const c = unwrap(n);
    if (!ts.isCallExpression(c) || !ts.isPropertyAccessExpression(c.expression)) return undefined;
    const name = c.expression.name.text;
    if (!GATE_METHODS.has(name)) return undefined;
    return isGate(c.expression.expression) ? name : undefined;
  };

  const thenable = (t: ts.Type, node: ts.Node, depth = 0): boolean => {
    if (depth > 4) return false;
    if (t.isUnion()) return t.types.some((x) => thenable(x, node, depth + 1));
    const apparent = checker.getApparentType(t);
    const then = checker.getPropertyOfType(apparent, "then");
    if (!then) return false;
    return checker.getTypeOfSymbolAtLocation(then, node).getCallSignatures().length > 0;
  };
  const isAnyType = (t: ts.Type) => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;

  // ---- function targets (same file only)
  const targetOf = (name: ts.Node): { key: string; node: ts.FunctionLikeDeclaration } | undefined => {
    let sym = checker.getSymbolAtLocation(name);
    if (!sym) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    for (const d of sym.declarations ?? []) {
      if (d.getSourceFile() !== sf) continue;
      let cand: ts.Node | undefined = d;
      if (ts.isVariableDeclaration(d) && d.initializer) cand = unwrap(d.initializer);
      else if (ts.isPropertyAssignment(d)) cand = unwrap(d.initializer);
      else if (ts.isShorthandPropertyAssignment(d)) {
        const vs = checker.getShorthandAssignmentValueSymbol(d);
        const vd = vs?.valueDeclaration;
        if (vd && ts.isVariableDeclaration(vd) && vd.initializer) cand = unwrap(vd.initializer);
      }
      if (cand && isFnLike(cand) && keyOf.has(cand)) return { key: keyOf.get(cand) as string, node: cand };
    }
    return undefined;
  };

  const inGateArgument = (n: ts.Node, fn: ts.Node | undefined): boolean => {
    for (let p: ts.Node | undefined = n.parent, child: ts.Node = n; p && p !== fn; child = p, p = p.parent) {
      if (ts.isCallExpression(p) && p.arguments.some((a) => a === child) && gateCall(p) !== undefined) return true;
    }
    return false;
  };
  const inReapPlace = (n: ts.Node, fn: ts.Node | undefined): boolean => {
    for (let p: ts.Node | undefined = n.parent, child: ts.Node = n; p && p !== fn; child = p, p = p.parent) {
      if (ts.isCatchClause(p)) return true;
      if (ts.isTryStatement(p) && p.finallyBlock === child) return true;
      if (isFnLike(p)) {
        const pp = p.parent;
        if (pp && ts.isPropertyAssignment(pp) && propName(pp.name) === "onStopped") return true;
      }
    }
    return false;
  };

  // ---- R3 helpers
  // every identifier that resolves to a function of this file, by function node (for the launch-helper check and function-as-value uses)
  const fnRefs = new Map<ts.Node, ts.Identifier[]>();
  const collectRefs = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && !(n.parent && isDeclarationPosition(n, n.parent))) {
      const t = targetOf(n);
      if (t) { const l = fnRefs.get(t.node) ?? []; l.push(n); fnRefs.set(t.node, l); }
    }
    ts.forEachChild(n, collectRefs);
  };
  let refsCollected = false;
  const refsOf = (f: ts.Node): ts.Identifier[] => {
    if (!refsCollected) { refsCollected = true; collectRefs(sf); }
    return fnRefs.get(f) ?? [];
  };
  const launchCallbackOk = (call: ts.Node, depth = 0): string | undefined => {
    const f = fnOf(call);
    if (!f) return "not inside a gate.launch callback (module level)";
    let p: ts.Node | undefined = f.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) p = p.parent;
    const lc = p && ts.isCallExpression(p) && p.arguments.some((a) => unwrap(a) === f) ? p : undefined;
    if (!lc || gateCall(lc) !== "launch") {
      // nearest sound extension of D3 (reported in NOTES.txt): a primitive inside a named local helper is accepted only when EVERY reference to
      // that helper is a call that itself satisfies this rule (the sole irreversible step of a gate.launch callback, no await before it)
      if (depth < 3 && keyOf.has(f)) {
        const refs = refsOf(f);
        const allLaunchCalls = refs.length > 0 && refs.every((r) => {
          const callee: ts.Node = r.parent && ts.isPropertyAccessExpression(r.parent) && r.parent.name === r ? r.parent : r;
          const par = callee.parent;
          return !!par && ts.isCallExpression(par) && par.expression === callee && launchCallbackOk(par, depth + 1) === undefined;
        });
        if (allLaunchCalls) return undefined;
      }
      return "its nearest enclosing function is not the callback passed to gate.launch";
    }
    const before = precedingSuspend(f, call);
    if (before) return `an await or yield precedes it in the gate.launch callback (line ${line(before)})`;
    return undefined;
  };
  const importOf = (id: ts.Identifier): { name: string; module: string; ns: boolean } | undefined => {
    const sym = checker.getSymbolAtLocation(id);
    const d = sym?.declarations?.[0];
    if (!d) return undefined;
    if (ts.isImportSpecifier(d)) {
      const imp = d.parent.parent.parent;
      return { name: (d.propertyName ?? d.name).text, module: ts.isStringLiteral(imp.moduleSpecifier) ? imp.moduleSpecifier.text : "", ns: false };
    }
    if (ts.isNamespaceImport(d) || ts.isImportClause(d)) {
      const imp = ts.isNamespaceImport(d) ? d.parent.parent : d.parent;
      return { name: "*", module: ts.isStringLiteral(imp.moduleSpecifier) ? imp.moduleSpecifier.text : "", ns: true };
    }
    return undefined;
  };
  const isChildProcessModule = (m: string) => m === "node:child_process" || m === "child_process";
  /** is this call a launch primitive; returns a label. */
  const primitiveOf = (call: ts.CallExpression): string | undefined => {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) {
      const imp = importOf(callee);
      if (imp && !imp.ns && primitiveImports.has(imp.name)) return imp.name;
      if (callee.text === "fetch") {
        const sym = checker.getSymbolAtLocation(callee);
        if (!(sym?.declarations ?? []).some((d) => d.getSourceFile() === sf)) return "fetch";
      }
      if (requestFns.has(callee.text)) {
        const a0 = call.arguments[0];
        if (!a0) return undefined;
        const u = unwrap(a0);
        if (ts.isStringLiteralLike(u)) return LAUNCH_METHODS.includes(u.text) ? `${callee.text}(${u.text})` : undefined;
        const t = checker.getTypeAtLocation(a0);
        const parts = t.isUnion() ? t.types : [t];
        const provablySafe = parts.every((x) => x.isStringLiteral() && !LAUNCH_METHODS.includes(x.value));
        return provablySafe ? undefined : `${callee.text}(non-literal method)`;
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      const recv = unwrap(callee.expression);
      if ((name === "write" || (name === "end" && call.arguments.length > 0)) && ts.isPropertyAccessExpression(recv) && recv.name.text === "stdin") return `stdin.${name}`;
      if (ts.isIdentifier(recv)) {
        const imp = importOf(recv);
        if (imp?.ns && isChildProcessModule(imp.module) && primitiveImports.has(name)) return `child_process.${name}`;
      }
    }
    return undefined;
  };

  // ---- R2 helpers
  /** can a spread of this type put a `type` that is, or may be, an ending into the event? (any, an index signature, a `type` that is not a literal outside ENDING) */
  const mayCarryType = (t: ts.Type, at: ts.Node, depth = 0): boolean => {
    if (depth > 4) return true;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (t.isUnionOrIntersection()) return t.types.some((x) => mayCarryType(x, at, depth + 1));
    if (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.BooleanLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) return false;
    const prop = checker.getPropertyOfType(t, "type");
    if (prop) {
      const pt = checker.getTypeOfSymbolAtLocation(prop, at);
      const parts = pt.isUnion() ? pt.types : [pt];
      return !parts.every((x) => x.isStringLiteral() ? !ENDING.includes(x.value) : (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0);
    }
    return !!checker.getIndexInfoOfType(t, ts.IndexKind.String);
  };
  const endingTypeOf = (o: ts.ObjectLiteralExpression): { literal?: string; dynamic: boolean } => {
    let literal: string | undefined;
    let typeIndex = -1;
    o.properties.forEach((p, i) => {
      if (ts.isPropertyAssignment(p) && propName(p.name) === "type") {
        typeIndex = i;
        const v = unwrap(p.initializer);
        literal = ts.isStringLiteralLike(v) ? v.text : undefined;
      } else if (ts.isShorthandPropertyAssignment(p) && p.name.text === "type") { typeIndex = i; literal = undefined; }
    });
    // a spread before `type` is overwritten by it; a spread after it is fine only when its type cannot carry a `type` (checked by type, not by text)
    const dynamic = typeIndex < 0 || literal === undefined
      || o.properties.slice(typeIndex + 1).some((p) => ts.isSpreadAssignment(p) && mayCarryType(checker.getTypeAtLocation(p.expression), p.expression));
    return { literal, dynamic };
  };
  const isEmitterCallee = (callee: ts.Node): boolean => {
    const c = unwrap(callee);
    return (ts.isIdentifier(c) || ts.isPropertyAccessExpression(c)) && emitters.has(c.getText(sf));
  };
  const emitterNames = [...emitters];

  // ---- the walk
  const checks = (node: ts.Node): void => {
    // R1: await
    if (ts.isAwaitExpression(node)) {
      const g = gateCall(node.expression);
      if (g === "step" || g === "cleanupStep") push("await", node, undefined, text(node.expression));
      else push("await", node, { rule: "R1", message: "bare await: wrap it as `await gate.step(e, p)` (turn path), `gate.cleanupStep` (CLEANUP function) or list an exempt site" }, text(node.expression));
    }
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      push("await", node, { rule: "R1", message: "`for await` on a turn path is red: list an exempt site" }, `for await ${text(node.expression)}`);
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      // R1: cleanupStep only in CLEANUP functions
      if (gateCall(node) === "cleanupStep") {
        const key = keyOfNode(node);
        cleanupUsed.set(key, (cleanupUsed.get(key) ?? 0) + 1);
        if (!cleanup.has(key)) diag("R1", node, "gate.cleanupStep outside a CLEANUP function (use gate.step, or add the function to the CLEANUP list with a reason)", "await");
      }
      // R1: .then / .catch / .finally on a Promise-like
      if (ts.isPropertyAccessExpression(callee) && ["then", "catch", "finally"].includes(callee.name.text)) {
        const rt = checker.getTypeAtLocation(callee.expression);
        if (isAnyType(rt) || thenable(rt, callee.expression)) {
          push("chain", node, { rule: "R1", message: `.${callee.name.text}() on a Promise-like: use await gate.step, gate.handoff, or list an exempt site` });
        }
      }
      // R2: emitters
      if (isEmitterCallee(callee) && node.arguments.length > 0) {
        const a0 = unwrap(node.arguments[0]);
        if (ts.isObjectLiteralExpression(a0)) {
          const t = endingTypeOf(a0);
          if (t.dynamic && !(t.literal !== undefined && ENDING.includes(t.literal))) {
            push("emit", node, { rule: "R2", message: "an emitter call whose event `type` is not a string literal (or is followed by a spread) can hide an ending: list an exempt site" });
          }
        } else {
          push("emit", node, { rule: "R2", message: "an emitter call whose event is not an object literal can hide an ending: list an exempt site" });
        }
      }
      // R3: primitives
      const prim = primitiveOf(node);
      if (prim) {
        const why = launchCallbackOk(node);
        push("launch", node, why ? { rule: "R3", message: `launch primitive ${prim}: ${why}` } : undefined);
      }
      // R1: calls into not-turn / reap functions
      const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
      if (nameNode) {
        const tgt = targetOf(nameNode);
        if (tgt) {
          const tk = kindOfKey(tgt.key);
          const callerKey = keyOfNode(node);
          if ((tk === "not-turn" || tk === "reap") && kindOfKey(callerKey) === "turn") {
            const fnNode = fnOf(node);
            const ok = tk === "not-turn" ? inGateArgument(node, fnNode) : inReapPlace(node, fnNode) || inGateArgument(node, fnNode);
            push("call", node, ok ? undefined : { rule: "R1", message: `a turn-path function calls the ${tk} function ${tgt.key} ${tk === "not-turn" ? "outside a gate.step argument" : "outside a catch, finally or onStopped callback"}` });
          }
        }
      }
    }

    // R1: detached promise-like statements
    if (ts.isVoidExpression(node)) {
      const inner = unwrap(node.expression);
      if (!(ts.isCallExpression(inner) && gateCall(inner) === "handoff")) {
        const t = checker.getTypeAtLocation(inner);
        if (!isAnyType(t) && thenable(t, inner)) push("detached", node, { rule: "R1", message: "a detached `void promise`: route it through gate.handoff, or list an exempt site" }, text(inner));
      }
    } else if (ts.isExpressionStatement(node)) {
      const inner = unwrap(node.expression);
      if (!ts.isAwaitExpression(inner) && !ts.isVoidExpression(inner) && !(ts.isCallExpression(inner) && gateCall(inner) === "handoff")) {
        const t = checker.getTypeAtLocation(inner);
        if (!isAnyType(t) && thenable(t, inner)) push("detached", node, { rule: "R1", message: "an expression statement whose result is a Promise-like and unused: route it through gate.handoff, or list an exempt site" }, text(inner));
      }
    }

    // R2: ending literals, anywhere
    if (ts.isObjectLiteralExpression(node)) {
      const t = endingTypeOf(node);
      if (t.literal !== undefined && ENDING.includes(t.literal)) diag("R2", node, `object literal with type "${t.literal}": a turn ends only through e.finish and starts only through e.markStarted`, "emit");
    }

    // R2: aliases of an emitter; R1: async turn-path functions used as values
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const par = node.parent;
      const isCallee = par && ts.isCallExpression(par) && par.expression === node;
      const isMemberName = par && ts.isPropertyAccessExpression(par) && par.name === node;
      const isMemberObject = par && ts.isPropertyAccessExpression(par) && par.expression === node;
      const declName = !!par && isDeclarationPosition(node, par);
      const inType = (() => {
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isTypeNode(p)) return true;
          if (isFnLike(p) || (p.kind >= ts.SyntaxKind.FirstStatement && p.kind <= ts.SyntaxKind.LastStatement)) return false;
        }
        return false;
      })();
      if (!isCallee && !isMemberName && !declName && !inType) {
        const txt = node.getText(sf);
        if (emitterNames.includes(txt) && !isMemberObject) {
          push("emit", node, { rule: "R2", message: `alias or value use of the emitter ${txt}: list an exempt site` }, `alias ${fingerprint(par ? par.getText(sf) : txt)}`);
        }
        if (ts.isIdentifier(node) && !isMemberObject) {
          const tgt = targetOf(node);
          if (tgt && ts.isFunctionLike(tgt.node) && tgt.node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) && kindOfKey(tgt.key) === "turn") {
            // handing the function to gate.handoff / gate.run is the sanctioned detachment: its own awaits are checked where it is defined
            const viaGate = !!par && ts.isCallExpression(par) && par.arguments.some((a) => a === node) && (gateCall(par) === "handoff" || gateCall(par) === "run");
            push("ref", node, viaGate ? undefined : { rule: "R1", message: `the async turn-path function ${tgt.key} is used as a value: list an exempt site` }, `${txt} in ${fingerprint(par ? par.getText(sf) : txt)}`);
          }
        }
      }
    }

  };
  const visit = (node: ts.Node): void => {
    checks(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { engine, fileName, items, keys: nodeOf, direct, cleanupUsed };
}

// ---------------------------------------------------------------------------------------------------------------- the rule verdict

export function check(ctx: Ctx, fileName: string, engine: EngineRules): Diagnostic[] {
  const a = analyze(ctx, fileName, engine);
  const out: Diagnostic[] = [...a.direct];
  const used = new Set<string>();
  const fnRules = new Map<string, FnRule>(engine.fns.map((f) => [f.key, f]));
  for (const it of a.items) {
    if (!it.violation) continue;
    const rule = fnRules.get(it.key);
    const rows = rule?.[rowField(it.kind)] ?? [];
    const idx = rows.findIndex((r) => r[0] === it.ordinal && r[1] === it.text);
    if (idx >= 0) { used.add(`${it.key}|${it.kind}|${idx}`); continue; }
    out.push({ rule: it.violation.rule, engine: engine.id, key: it.key, line: it.line, kind: it.kind, ordinal: it.ordinal, text: it.text, message: it.violation.message });
  }

  // CFG: the config must match the file exactly
  const cfg = (key: string, message: string, kind = "cfg"): void => { out.push({ rule: "CFG", engine: engine.id, key, line: 0, kind, ordinal: 0, text: "", message }); };
  const seenKeys = new Set<string>();
  for (const f of engine.fns) {
    if (seenKeys.has(f.key)) cfg(f.key, "duplicate function entry");
    seenKeys.add(f.key);
    if (!a.keys.has(f.key)) { cfg(f.key, "stale: no function with this key in the file"); continue; }
    if (!f.reason.trim()) cfg(f.key, "an exempt function needs a reason");
    if (f.kind === "turn") {
      for (const k of ROW_KINDS) for (const r of f[rowField(k)] ?? []) if (!r[2]?.trim()) cfg(f.key, `a turn-path exempt site needs its own reason (${k} #${r[0]})`);
    }
    for (const k of ROW_KINDS) {
      (f[rowField(k)] ?? []).forEach((r, i) => {
        if (!used.has(`${f.key}|${k}|${i}`)) cfg(f.key, `stale exempt site: ${k} #${r[0]} \`${r[1]}\` matches nothing that needs an exemption`, k);
      });
    }
  }
  for (const key of engine.cleanup) {
    if (!a.keys.has(key)) cfg(key, "CLEANUP key: no function with this key in the file");
    else if (!a.cleanupUsed.get(key)) cfg(key, "CLEANUP key never calls gate.cleanupStep: remove it from the list");
  }
  return out;
}

export const formatDiagnostics = (ds: Diagnostic[]): string =>
  ds.map((d) => `${d.rule} ${d.engine} ${d.key} L${d.line} [${d.kind}] ${d.text}: ${d.message}`).join("\n");

// ---------------------------------------------------------------------------------------------------------------- listings (config authoring)

export function listItems(ctx: Ctx, fileName: string, engine: EngineRules): Item[] {
  return analyze(ctx, fileName, engine).items;
}

export function readText(repoRoot: string, rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

// ---------------------------------------------------------------------------------------------------------------- syntactic edit helpers (no type checker)

export interface AwaitSite { key: string; ordinal: number; wrapper: "step" | "cleanupStep" | "bare"; start: number; end: number; operand: string; arg: string; argStart: number; argEnd: number; calleeStart: number; calleeEnd: number }

/** every await of a file with its enclosing key and ordinal, and, for a `gate.step(e, X, ...)`/`gate.cleanupStep(e, X)` operand, where X sits. Syntactic only. */
export function awaitSites(fileText: string, fileName: string, id: string): AwaitSite[] {
  const sf = ts.createSourceFile(fileName, fileText, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const { keyOf } = computeKeys(sf, id);
  const counters = new Map<string, number>();
  const out: AwaitSite[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isAwaitExpression(n)) {
      let f: ts.Node | undefined = n.parent;
      while (f && !isFnLike(f)) f = f.parent;
      const key = f ? (keyOf.get(f) ?? id) : id;
      const ordinal = (counters.get(key) ?? 0) + 1;
      counters.set(key, ordinal);
      const op = unwrap(n.expression);
      let wrapper: AwaitSite["wrapper"] = "bare";
      let argStart = 0;
      let argEnd = 0;
      let calleeStart = 0;
      let calleeEnd = 0;
      if (ts.isCallExpression(op) && ts.isPropertyAccessExpression(op.expression) && (op.expression.name.text === "step" || op.expression.name.text === "cleanupStep") && op.arguments.length >= 2) {
        wrapper = op.expression.name.text as "step" | "cleanupStep";
        argStart = op.arguments[1].getStart(sf);
        argEnd = op.arguments[1].getEnd();
        calleeStart = op.expression.getStart(sf);
        calleeEnd = op.expression.getEnd();
      }
      out.push({ key, ordinal, wrapper, start: n.getStart(sf), end: n.getEnd(), operand: fingerprint(n.expression.getText(sf)), arg: argEnd > argStart ? fingerprint(fileText.slice(argStart, argEnd)) : "", argStart, argEnd, calleeStart, calleeEnd });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface BodyPoint { key: string; bodyStart: number; isAsync: boolean }

/** the position just after the opening brace of every block-bodied function, by key. */
export function bodyPoints(fileText: string, fileName: string, id: string): Map<string, BodyPoint> {
  const sf = ts.createSourceFile(fileName, fileText, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const { keyOf } = computeKeys(sf, id);
  const out = new Map<string, BodyPoint>();
  for (const [node, key] of keyOf) {
    const fn = node as ts.FunctionLikeDeclaration;
    if (fn.body && ts.isBlock(fn.body)) out.set(key, { key, bodyStart: fn.body.getStart(sf) + 1, isAsync: !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) });
  }
  return out;
}

export interface LaunchEdit { key: string; cbKey: string; text: string; callStart: number; callEnd: number; callbackStart: number; callbackEnd: number; bodyStart: number; bodyEnd: number; expressionBody: boolean; callbackText: string }

/** every `gate.launch(e, <inline function>, ...)` call (syntactic: callee `.launch`), with its callback body span. */
export function launchCallbacks(fileText: string, fileName: string, id: string): LaunchEdit[] {
  const sf = ts.createSourceFile(fileName, fileText, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const { keyOf } = computeKeys(sf, id);
  const out: LaunchEdit[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "launch" && n.arguments.length >= 2) {
      const cb = unwrap(n.arguments[1]);
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        let f: ts.Node | undefined = n.parent;
        while (f && !isFnLike(f)) f = f.parent;
        const expressionBody = !ts.isBlock(cb.body);
        out.push({ key: f ? (keyOf.get(f) ?? id) : id, cbKey: keyOf.get(cb) ?? id, text: n.getText(sf), callStart: n.getStart(sf), callEnd: n.getEnd(), callbackStart: cb.getStart(sf), callbackEnd: cb.getEnd(), bodyStart: cb.body.getStart(sf), bodyEnd: cb.body.getEnd(), expressionBody, callbackText: cb.getText(sf) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
