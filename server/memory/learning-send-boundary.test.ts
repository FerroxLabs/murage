import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning send boundary (designs/MEM-LEARNING-FENCE-R6.md section 4, R8 section 4). A TypeScript-checker symbol scan of every
// non-test file under server/: each sink (fetch, child_process, spawnCli, fs writes, stdin write/end, any Writable .write, sendTurn,
// appendNative) sits inside a learning gate's `send` emit or matches a call-site pin in ci/learning-sinks.json. A new, moved or vanished
// pin fails. The adapter chains from each `beforeSubmit`/`admit` hook to its physical write are linted as synchronous, and planted
// bypasses (T15a) must each fail the scan.
//
// Regenerate the sink and caller pins (never the chains or timers) with LEARNING_SINKS_WRITE=1; a reviewer reads the diff.
//
// Scope (MurageMain ruling, 1.0.18): this lint's threat model is ACCIDENTAL misuse by our own in-repo code: a new send path that forgets
// the gate, a direct call, a copy-pasted helper, a write moved into a timer or a promise reaction. It is NOT a defence against adversarial
// code inside the repo (a Proxy over the gate, a look-alike class built to dodge it): a static lint cannot be complete against that, and
// the runtime StopGate (server/drivers/stop-gate.ts) stays the real guard. A stopGate.launch(entry, fn) callback counts as same-tick only
// for the proven call shape (a non-async function expression, argument 2, on a value whose type is declared in stop-gate.ts), because
// launch calls fn synchronously (stop-gate.ts launch); chain hops may name same-file write helpers in `via`.
//
// Reasons: `learning-path` is a pin that carries the learning payload on an admitted path, and the scan proves the admission:
// `admittedBy: "chain:<name>"` (the call is a hop of that linted chain) or `"fence:<prop>"` (the call hands the engine a `<prop>` hook
// that admits on a learning gate, and a linted chain runs that hook before its write). `learning-local` is learning bytes handed to a
// process this file owns and nothing else: `admittedBy: "child:<spawn anchor>"` (the receiver is the const child that pinned spawn made).
// Every other caller of a pinned caller (the ACP send/writeTo/request/writeAcpResponse) must not be reached by a gate payload: a turn's
// `.text`, or a chain hook's payload, through same-file initializers and assignments, so a payload swapped in above an unchanged anchor fails.
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
/** Pins are keyed with forward slashes; path.relative and path.join give backslashes on Windows. */
const fwd = (p: string): string => p.replace(/\\/g, "/");
const relFwd = (p: string): string => fwd(relative(ROOT, p));
const PINS_FILE = join(ROOT, "ci", "learning-sinks.json");
type Reason = "fixed-text" | "not-learning" | "adapter-write" | "log-excluded" | "learning-path" | "learning-local";
interface Pin { file: string; fn: string; anchor: string; kind: string; n?: number; reason: Reason; admittedBy?: string }
interface CallerPin { file: string; fn: string; anchor: string; callee: string; n?: number; reason: Reason; admittedBy?: string }
/** `via` (optional, only on a hook hop): the names of the same-file helper functions that hold the write(s) `to` names. The lint proves each
 *  is called synchronously after the hook, inside the hook's function, and that its own path to the write is synchronous. */
interface Hop { file: string; fn: string; from: string; to: string; payload: string[]; via?: string[] }
interface Chain { name: string; admittedBy: string; hops: Hop[] }
interface TimerPin { file: string; fn: string; anchor: string }
interface Pins { sinks: Pin[]; callers: CallerPin[]; chains: Chain[]; timers: TimerPin[]; pinnedCallers: Array<{ file: string; name: string }> }

const squash = (text: string) => text.replace(/\s+/g, "");
const anchorOf = (node: ts.Node) => squash(node.getText()).slice(0, 160);
const isTest = (file: string) => /\.test\.ts$|\/testing\/|\.d\.ts$/.test(file);

function fnName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) return cur.name?.getText() ?? "<anonymous>";
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent) {
      const p = cur.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText();
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return squash(p.left.getText()).slice(0, 60);
    }
  }
  return "<module>";
}

/** One parse of each file for the whole run: the base program parses the server once, and every planted program reuses those trees,
 *  parsing only the files it overrides (each program still gets its own checker). Without it each plant that adds a file (so
 *  TypeScript cannot reuse the old program's structure) re-parsed the whole server and its typings, and the macOS runner's worker
 *  ran out of memory. */
const parsedFiles = new Map<string, ts.SourceFile>();
function program(extra: Record<string, string> = {}, old?: ts.Program): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.server.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
  const host = ts.createCompilerHost(parsed.options, true);
  const over = new Map(Object.entries(extra).map(([k, v]) => [fwd(join(ROOT, k)), v]));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, fresh) => {
    if (over.has(name)) return ts.createSourceFile(name, over.get(name)!, lang, true);
    const hit = parsedFiles.get(name);
    if (hit) return hit;
    const sf = getSourceFile(name, lang, onError, fresh);
    if (sf) parsedFiles.set(name, sf);
    return sf;
  };
  const readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host);
  host.readFile = name => over.get(name) ?? readFile(name);
  host.fileExists = name => over.has(name) || fileExists(name);
  const roots = [...new Set([...parsed.fileNames.filter(f => !isTest(f) && f.includes("/server/")), ...over.keys()].filter(f => !isTest(f)))];
  return ts.createProgram({ rootNames: roots, options: { ...parsed.options, noEmit: true }, host, oldProgram: old });
}

const FS_WRITES = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "write", "writeSync", "writev", "writevSync", "createWriteStream", "copyFile", "copyFileSync", "cp", "cpSync"]);
const CHILD = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const TIMERS = new Set(["setTimeout", "setImmediate", "queueMicrotask", "nextTick", "setInterval"]);
/** Calls whose function argument runs later: a timer, a promise reaction, a listener. */
const DEFERRERS = new Set([...TIMERS, "then", "catch", "finally", "on", "once", "addListener", "prependListener", "addEventListener"]);
/** Array methods whose callback runs before they return. */
const SYNC_CALLBACKS = new Set(["map", "forEach", "filter", "flatMap", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "reduce", "reduceRight", "sort", "toSorted"]);
const fnLike = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
const isAsyncFn = (n: ts.Node): boolean => fnLike(n) && !!ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
/** A function nested in an emit that runs before the emit returns: a synchronous `new Promise` executor or array callback. Anything
 *  else (a timer, a then/catch/finally, a listener, an async function, a callback of any other call, a declared function) may run after. */
const runsInline = (fn: ts.Node): boolean => {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || isAsyncFn(fn)) return false;
  const p = fn.parent;
  if (ts.isNewExpression(p)) return p.expression.getText() === "Promise" && p.arguments?.[0] === fn;
  return ts.isCallExpression(p) && p.arguments.some(a => a === fn) && ts.isPropertyAccessExpression(p.expression) && SYNC_CALLBACKS.has(p.expression.name.text);
};
/** A stop gate: a value whose type's `launch`, `step`, `cleanupStep`, `handoff` and `bindLive` are all declared in server/drivers/stop-gate.ts
 *  (createStopGate's own object). The shape alone is not enough: a look-alike declared anywhere else, with the same five names, is not it. */
const STOP_GATE_FILE = "/server/drivers/stop-gate.ts";
const isStopGate = (t: ts.Type): boolean => t.isUnion() ? t.types.every(isStopGate) : ["launch", "step", "cleanupStep", "handoff", "bindLive"].every(name => !!t.getProperty(name)?.declarations?.some(d => fwd(d.getSourceFile().fileName).endsWith(STOP_GATE_FILE)));
/** Every possible receiver must be the stop gate (a union with a look-alike member fails; `null`/`undefined` members are dropped by the caller). */
const receiverIsStopGate = (checker: ts.TypeChecker, e: ts.Expression): boolean => isStopGate(checker.getNonNullableType(checker.getTypeAtLocation(e)));
/** A function boundary: anything that may run its body later than the code around it (arrow, function expression, declaration, method,
 *  accessor, constructor, static block; a generator's body runs on `.next()`, an async function's after its first await). */
const execBoundary = (n: ts.Node): boolean => ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n) || ts.isClassLike(n);
/** The members a stop gate is made of: no one outside stop-gate.ts may write, delete, define or proxy them. */
const GATE_MEMBERS = new Set(["launch", "step", "cleanupStep", "handoff", "bindLive"]);
/** An expression without the wrappers that change only its type: parentheses, `!`, `as`, `<T>` and `satisfies`. */
const peel = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) ? peel(e.expression) : e;
const isGenerator = (n: ts.Node): boolean => !!(n as ts.FunctionLikeDeclaration).asteriskToken;
/** The one call shape of a stop gate's launch the chain lint accepts as same-tick: a non-async function expression passed as the second
 *  argument of `<stop gate>.launch(entry, fn, ...)`. StopGate.launch reads the gate and then calls fn synchronously, in the same tick
 *  (server/drivers/stop-gate.ts launch; designs/STOP-NONACP-DISPOSE-r3.1.md, the gate sits on the write). Anything else (an async callback,
 *  a launch-like call on a value that is not a stop gate, a callback of another call) is a deferral as before. */
const isGateLaunchCallback = (checker: ts.TypeChecker, fn: ts.Node): boolean => {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || isAsyncFn(fn) || isGenerator(fn)) return false;
  const p = fn.parent;
  return ts.isCallExpression(p) && p.arguments[1] === fn && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "launch" && receiverIsStopGate(checker, p.expression.expression);
};
const deferralName = (fn: ts.Node): string => {
  if (isAsyncFn(fn)) return "async function";
  const p = fn.parent;
  if (!ts.isCallExpression(p)) return "nested function";
  const name = ts.isIdentifier(p.expression) ? p.expression.text : ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : "call";
  return DEFERRERS.has(name) ? name : `callback of ${name}`;
};
const SINK_NAMES = new Set([...FS_WRITES, ...CHILD, "fetch", "request", "spawnCli", "appendNative"]);
const PROPERTY_SINKS = new Set([...SINK_NAMES, "end", "sendTurn"]);
const inType = (node: ts.Node): boolean => { for (let cur: ts.Node | undefined = node.parent; cur && !ts.isStatement(cur); cur = cur.parent) if (ts.isTypeNode(cur)) return true; return false; };
/** The plain names an initializer may stand for: `a`, `o.a`, `x ?? a`, `x || a`. */
const aliasOperands = (e: ts.Expression): string[] => {
  if (ts.isParenthesizedExpression(e)) return aliasOperands(e.expression);
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) return [...aliasOperands(e.left), ...aliasOperands(e.right)];
  return /^[\w.]+$/.test(e.getText()) ? [e.getText()] : [];
};
/** A sink reference that only defines a local alias (`const f = o.f ?? fetch`): the alias's calls are the sinks, not this reference. */
const aliasDefinition = (node: ts.Node): boolean => {
  let cur = node;
  while (ts.isBinaryExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent)) cur = cur.parent;
  return ts.isVariableDeclaration(cur.parent) && cur.parent.initializer === cur && ts.isIdentifier(cur.parent.name);
};
/** The local names that may be a sink in this file: the sink names, renamed imports of them, and `const f = <sink>` aliases. */
function localSinkNames(sf: ts.SourceFile): Set<string> {
  const names = new Set(SINK_NAMES);
  let grew = true;
  while (grew) {
    grew = false;
    const v = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && names.has((node.propertyName ?? node.name).text) && !names.has(node.name.text)) { names.add(node.name.text); grew = true; }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && aliasOperands(node.initializer).some(t => names.has(t.split(".").pop()!)) && !names.has(node.name.text)) { names.add(node.name.text); grew = true; }
      ts.forEachChild(node, v);
    };
    v(sf);
  }
  return names;
}

interface Scan { sinks: Pin[]; callers: CallerPin[]; problems: string[] }
/** The stop-gate protection findings (hand-built gates, writes to a gate, proxies, untyped flows) per parsed file. A planted program reuses
 *  the base program's parsed trees for every file it does not override (parsedFiles), so those files' findings are computed once; a planted
 *  file is a new tree and is checked afresh. Without it each planted program re-asked the checker about every expression in the server. */
const gateCache = new WeakMap<ts.SourceFile, string[]>();

function scan(prog: ts.Program, pins: Pins): Scan {
  const checker = prog.getTypeChecker();
  const sinks: Pin[] = [], callers: CallerPin[] = [], problems: string[] = [];
  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    let s = checker.getSymbolAtLocation(node);
    if (s && s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { /* unresolved alias */ } }
    return s;
  };
  const declFile = (s: ts.Symbol | undefined) => s?.declarations?.[0]?.getSourceFile().fileName ?? "";
  /** The sink a referenced symbol is, or "" (an identifier use counts too, so `const f = fetch` is caught). */
  const sinkOfSymbol = (s: ts.Symbol | undefined): string => {
    if (!s) return "";
    const name = s.getName(), file = declFile(s);
    if (name === "fetch" && file.includes("node_modules")) return "fetch";
    if (name === "request" && /undici/.test(file)) return "fetch";
    if (CHILD.has(name) && /@types\/node\/child_process/.test(file)) return "spawn";
    if (name === "spawnCli" && file.endsWith("/server/procs.ts")) return "spawn";
    if (FS_WRITES.has(name) && /@types\/node\/(fs|fs\/promises)\.d\.ts$/.test(file)) return "fs-write";
    if (name === "appendNative" && file.includes("/server/")) return "native-log";
    return "";
  };
  const writableType = (t: ts.Type): boolean => t.isUnion() ? t.types.some(writableType) : !!(t.getProperty("write") && t.getProperty("writable") && t.getProperty("end"));
  const isGate = (t: ts.Type): boolean => t.isUnion() ? t.types.some(isGate) : !!(t.getProperty("admit") && t.getProperty("notWritten") && t.getProperty("released"));
  const gateSendCall = (call: ts.CallExpression) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "send" && isGate(checker.getTypeAtLocation(call.expression.expression));
  /** True when `node` runs inside the emit of a gate.send: lexically inside it and not below a function that may run after the emit
   *  returns (the emit may not be async, and a deferral inside it is outside it: a timer, then/catch/finally, a listener, an async
   *  function, any callback but a Promise executor or a synchronous array method's). */
  const insideEmit = (node: ts.Node): boolean => {
    let deferred: ts.Node | undefined;
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isCallExpression(cur.parent) && cur.parent.arguments[0] === cur && gateSendCall(cur.parent)) {
        if (isAsyncFn(cur)) problems.push(`async emit at ${where(cur)}`);
        if (deferred) { problems.push(`deferred write inside an emit (${deferralName(deferred)}) at ${where(node)}`); return false; }
        return true;
      }
      if (!deferred && fnLike(cur) && !runsInline(cur)) deferred = cur;
    }
    return false;
  };
  const where = (node: ts.Node) => { const sf = node.getSourceFile(); return `${relFwd(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`; };
  const pinnedCallerDecls = new Set<ts.Node>();
  const counts = new Map<string, number>();
  const push = <T extends { file: string; fn: string; anchor: string; n?: number }>(list: T[], entry: T, key: string): T => {
    const k = `${key}|${entry.file}|${entry.fn}|${entry.anchor}`;
    const n = counts.get(k) ?? 0; counts.set(k, n + 1);
    const pushed = n ? { ...entry, n } : entry;
    list.push(pushed);
    return pushed;
  };
  /** The sink an identifier reference is (`fetch(`, an imported or aliased sink), or "". */
  const identSink = (node: ts.Node, local: Set<string>): string => {
    if (!(ts.isIdentifier(node) && local.has(node.text) && !inType(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !ts.isImportSpecifier(node.parent) && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) && !aliasDefinition(node))) return "";
    return sinkOfSymbol(resolve(node)) || (ts.isCallExpression(node.parent) && node.parent.expression === node && !SINK_NAMES.has(node.text) ? "alias-call" : "");
  };
  /** The sink a called property is (`x.write(`, `child.stdin.end(`, `adapter.sendTurn(`), or "". */
  const propSink = (node: ts.Node): string => {
    if (!(ts.isPropertyAccessExpression(node) && ts.isCallExpression(node.parent) && node.parent.expression === node && PROPERTY_SINKS.has(node.name.text))) return "";
    const name = node.name.text, recv = node.expression;
    let kind = sinkOfSymbol(resolve(node.name));
    if (!kind && (name === "write" || name === "end") && /stdin$/.test(squash(recv.getText()))) kind = "stdin";
    if (!kind && name === "write" && writableType(checker.getTypeAtLocation(recv))) kind = "stream-write";
    if (!kind && name === "sendTurn") kind = "sendTurn";
    return kind;
  };
  /** The function a call runs when its callee is a function declared in the same file (`const f = () => ...` or `function f`). */
  const sameFileHelper = (call: ts.CallExpression, sf: ts.SourceFile): ts.FunctionLikeDeclaration | undefined => {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const decl = resolve(call.expression)?.valueDeclaration;
    if (!decl || decl.getSourceFile() !== sf) return undefined;
    if (ts.isFunctionDeclaration(decl)) return decl;
    return ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) ? decl.initializer : undefined;
  };
  /** Whether `root` holds a sink, directly or through the same-file helpers it calls. */
  const reachesSink = (root: ts.Node, sf: ts.SourceFile, local: Set<string>, seen = new Set<ts.Node>()): boolean => {
    const v = (n: ts.Node): boolean => {
      if (identSink(n, local) || propSink(n)) return true;
      if (ts.isCallExpression(n)) { const helper = sameFileHelper(n, sf); if (helper?.body && !seen.has(helper)) { seen.add(helper); if (v(helper.body)) return true; } }
      return !!ts.forEachChild(n, c => v(c) || undefined);
    };
    return v(root);
  };
  /** The emit's same-file helpers run inside it only as far as they run synchronously: an async helper, or a deferral in a helper,
   *  that reaches a sink fails (the emit's own deferrals are caught by insideEmit). */
  const followHelpers = (emit: ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile, local: Set<string>) => {
    const seen = new Set<ts.Node>();
    const walk = (body: ts.Node, label: string) => {
      const v = (n: ts.Node): void => {
        if (n !== body && fnLike(n) && !runsInline(n)) {
          // a deferral: in a helper, any write it reaches fails; in the emit, its own writes fail in insideEmit and its helpers' here
          if (label !== "the emit") { if (reachesSink(n, sf, local)) problems.push(`deferred write in helper ${label} (${deferralName(n)}) at ${where(n)}`); }
          else for (const c of callsIn(n)) { const helper = sameFileHelper(c, sf); if (helper && reachesSink(helper, sf, local)) problems.push(`deferred write inside an emit (${deferralName(n)}) through helper ${c.expression.getText()} at ${where(c)}`); }
          return;
        }
        if (ts.isCallExpression(n)) {
          const helper = sameFileHelper(n, sf);
          if (helper?.body && !seen.has(helper)) {
            seen.add(helper);
            const name = n.expression.getText();
            if (isAsyncFn(helper)) { if (reachesSink(helper.body, sf, local)) problems.push(`async helper ${name} with a write, called from the emit at ${where(n)}`); }
            else walk(helper.body, name);
          }
        }
        ts.forEachChild(n, v);
      };
      v(body);
    };
    walk(emit.body, "the emit");
  };
  const callsIn = (root: ts.Node): ts.CallExpression[] => { const out: ts.CallExpression[] = []; const v = (n: ts.Node) => { if (ts.isCallExpression(n)) out.push(n); ts.forEachChild(n, v); }; v(root); return out; };

  // the pins by key, and the chain hops' resolved function names (a hook hop names its function by its hook)
  const pinSinks = new Map(pins.sinks.map(e => [keyOf(e), e])), pinCallers = new Map(pins.callers.map(e => [keyOf(e), e]));
  const hopFn = (hop: Hop): string => {
    if (hop.fn || !hop.from) return hop.fn;
    const sf = prog.getSourceFile(join(ROOT, hop.file));
    const hit = sf ? callsIn(sf).find(c => anchorOf(c).startsWith(squash(hop.from))) : undefined;
    return hit ? fnName(hit) : "";
  };
  const onChain = (pin: { file: string; fn: string; anchor: string }, name: string): boolean => {
    const chain = pins.chains.find(c => c.name === name);
    return !!chain && chain.hops.some(h => h.file === pin.file && pin.anchor.startsWith(squash(h.to)) && (hopFn(h) === pin.fn || !!h.via?.includes(pin.fn)));
  };
  /** The call hands the engine a `prop` hook (`{ beforeSubmit }`) bound to a function that admits on a learning gate, and a linted
   *  chain runs a hook of that name before its write. */
  const fenced = (call: ts.CallExpression, prop: string): boolean => {
    let ok = false;
    const admits = (m: ts.Node): void => { if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && m.expression.name.text === "admit" && isGate(checker.getTypeAtLocation(m.expression.expression))) ok = true; if (!ok) ts.forEachChild(m, admits); };
    const v = (n: ts.Node): void => {
      if ((ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n)) && n.name.getText() === prop) {
        const bound = ts.isShorthandPropertyAssignment(n) ? checker.getShorthandAssignmentValueSymbol(n) : ts.isIdentifier(n.initializer) ? resolve(n.initializer) : undefined;
        const decl = bound?.valueDeclaration;
        const init = decl && ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const) !== 0 ? decl.initializer : ts.isPropertyAssignment(n) && fnLike(n.initializer) ? n.initializer : undefined;
        if (init) admits(init);
      }
      if (!ok) ts.forEachChild(n, v);
    };
    call.arguments.forEach(v);
    return ok && pins.chains.some(c => c.hops.some(h => h.from.includes(prop)));
  };
  /** The write's receiver is `<child>.stdin` where `<child>` is a const made by the pinned spawn `anchor` in this file. */
  const ownedChild = (call: ts.CallExpression, file: string, anchor: string): boolean => {
    const callee = call.expression;
    if (!anchor || !ts.isPropertyAccessExpression(callee) || !ts.isPropertyAccessExpression(callee.expression) || callee.expression.name.text !== "stdin" || !ts.isIdentifier(callee.expression.expression)) return false;
    const decl = resolve(callee.expression.expression)?.valueDeclaration;
    return !!decl && ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const) !== 0 && !!decl.initializer && ts.isCallExpression(decl.initializer)
      && anchorOf(decl.initializer).startsWith(squash(anchor)) && pins.sinks.some(p => p.file === file && p.kind === "spawn" && p.anchor.startsWith(squash(anchor)));
  };
  const verifyPin = (label: "sink" | "caller", entry: { file: string; fn: string; anchor: string; n?: number; kind?: string; callee?: string }, call: ts.Node) => {
    const pin: Pin | CallerPin | undefined = label === "sink" ? pinSinks.get(keyOf(entry)) : pinCallers.get(keyOf(entry));
    if (!pin) return; // unpinned: the diff reports it
    const by = pin.admittedBy ?? "", at = where(call);
    if (pin.reason === "learning-path") {
      const ok = by.startsWith("chain:") ? onChain(pin, by.slice("chain:".length)) : by.startsWith("fence:") && ts.isCallExpression(call) ? fenced(call, by.slice("fence:".length)) : false;
      if (!ok) problems.push(`learning-path ${label} pin not proven (${by || "no admittedBy"}) at ${at}`);
    } else if (pin.reason === "learning-local") {
      if (!(by.startsWith("child:") && ts.isCallExpression(call) && ownedChild(call, entry.file, by.slice("child:".length)))) problems.push(`learning-local ${label} pin not proven (${by || "no admittedBy"}) at ${at}`);
    } else if (label === "caller" && pin.reason === "adapter-write") problems.push(`adapter-write is a sink reason; a caller on a chain is learning-path, at ${at}`);
  };

  // the gate payloads a not-learning caller must never carry: each chain hook's admitted payload (the symbols its first write names) and,
  // by type, any turn's `.text` (a SendTurnInput carries the hidden learning prompt)
  const origins = new Set<ts.Symbol>();
  const valueSymbol = (id: ts.Identifier) => ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : resolve(id);
  for (const chain of pins.chains) for (const hop of chain.hops) if (hop.from) {
    const sf = prog.getSourceFile(join(ROOT, hop.file));
    if (!sf) continue;
    const payload = new Set(hop.payload.map(squash));
    for (const call of callsIn(sf)) if (anchorOf(call).startsWith(squash(hop.to))) {
      const ids = (m: ts.Node): void => { if (ts.isIdentifier(m) && payload.has(m.text)) { const s = valueSymbol(m); if (s) origins.add(s); } ts.forEachChild(m, ids); };
      call.arguments.forEach(ids);
    }
  }
  const turnShaped = (t: ts.Type): boolean => t.isUnion() ? t.types.some(turnShaped) : !!(t.getProperty("beforeSubmit") && t.getProperty("notWritten") && t.getProperty("text"));
  const assignIndex = new Map<ts.SourceFile, Map<ts.Symbol, ts.Expression[]>>();
  /** Every right-hand side assigned to `s` or to a property of it (`s = x`, `s.p = x`, `s += x`) in its file. */
  const assignmentsOf = (sf: ts.SourceFile, s: ts.Symbol): ts.Expression[] => {
    let index = assignIndex.get(sf);
    if (!index) {
      const built = new Map<ts.Symbol, ts.Expression[]>();
      const v = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          let left: ts.Expression = n.left;
          while (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left) || ts.isParenthesizedExpression(left) || ts.isNonNullExpression(left)) left = left.expression;
          const target = ts.isIdentifier(left) ? resolve(left) : undefined;
          if (target) built.set(target, [...(built.get(target) ?? []), n.right]);
        }
        ts.forEachChild(n, v);
      };
      v(sf);
      index = built;
      assignIndex.set(sf, built);
    }
    return index.get(s) ?? [];
  };
  const bindingInit = (d: ts.BindingElement): ts.Expression | undefined => {
    let cur: ts.Node = d;
    while (ts.isBindingElement(cur) || ts.isObjectBindingPattern(cur) || ts.isArrayBindingPattern(cur)) cur = cur.parent;
    return ts.isVariableDeclaration(cur) ? cur.initializer : undefined;
  };
  /** Whether a gate payload can reach `root`, through same-file initializers and assignments. A parameter is a boundary (the calls of a
   *  pinned caller are each pinned and checked here), a whole turn object stops the walk (only its `.text` is the payload), and a
   *  function's body is not its value. */
  const reachesPayload = (root: ts.Node): boolean => {
    const seen = new Set<ts.Symbol>();
    const walk = (n: ts.Node): boolean => {
      if (fnLike(n)) return false;
      const textOf = ts.isPropertyAccessExpression(n) && n.name.text === "text" ? n.expression
        : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "text" ? n.expression : undefined;
      if (textOf && turnShaped(checker.getTypeAtLocation(textOf))) return true;
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
        const s = valueSymbol(n);
        if (!s) return false;
        if (origins.has(s)) return true;
        if (seen.has(s) || turnShaped(checker.getTypeAtLocation(n))) return false;
        seen.add(s);
        const sf = n.getSourceFile();
        for (const d of s.declarations ?? []) {
          if (d.getSourceFile() !== sf) continue;
          const init = ts.isVariableDeclaration(d) ? d.initializer : ts.isBindingElement(d) ? bindingInit(d) : undefined;
          if (init && walk(init)) return true;
        }
        return assignmentsOf(sf, s).some(walk);
      }
      return !!ts.forEachChild(n, c => walk(c) || undefined);
    };
    return walk(root);
  };

  for (const sf of prog.getSourceFiles()) {
    const rel = relFwd(sf.fileName);
    if (!rel.startsWith("server/") || isTest(rel)) continue;
    for (const pc of pins.pinnedCallers) if (pc.file === rel) {
      const visitDecl = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText() === pc.name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) pinnedCallerDecls.add(node);
        if (ts.isFunctionDeclaration(node) && node.name?.text === pc.name) pinnedCallerDecls.add(node);
        ts.forEachChild(node, visitDecl);
      };
      visitDecl(sf);
    }
  }
  for (const sf of prog.getSourceFiles()) {
    const rel = relFwd(sf.fileName);
    if (!rel.startsWith("server/") || isTest(rel)) continue;
    const cachedGate = gateCache.get(sf), freshGate: string[] = [];
    const local = localSinkNames(sf);
    const visit = (node: ts.Node) => {
      const identKind = identSink(node, local);
      if (identKind && !insideEmit(node)) {
        const at = ts.isCallExpression(node.parent) ? node.parent : node;
        verifyPin("sink", push(sinks, { file: rel, fn: fnName(node), anchor: anchorOf(at), kind: identKind, reason: "not-learning" }, "s"), at);
      }
      const propKind = propSink(node);
      if (propKind && !insideEmit(node)) verifyPin("sink", push(sinks, { file: rel, fn: fnName(node), anchor: anchorOf(node.parent), kind: propKind, reason: "not-learning" }, "s"), node.parent);
      if (ts.isCallExpression(node) && gateSendCall(node)) {
        const emit = node.arguments[0];
        if (emit && (ts.isArrowFunction(emit) || ts.isFunctionExpression(emit))) followHelpers(emit, sf, local);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const decl = resolve(node.expression)?.valueDeclaration;
        if (decl && pinnedCallerDecls.has(decl)) {
          const entry = push(callers, { file: rel, fn: fnName(node), anchor: anchorOf(node), callee: node.expression.text, reason: "not-learning" }, "c");
          verifyPin("caller", entry, node);
          // only a chain's own hop may carry the payload; every other caller of the shared send/writeTo/request must be clean of it
          const pin = pinCallers.get(keyOf(entry));
          if (pin?.reason !== "learning-path" && node.arguments.some(a => reachesPayload(a))) problems.push(`a gate payload reaches the ${pin?.reason ?? "unpinned"} ${entry.callee}( caller at ${where(node)}`);
        }
      }
      // a nested send: a gate.send whose emit reaches another gate.send or admit, or any send/admit inside pinnedCall (r8 change 4)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["send", "admit"].includes(node.expression.name.text) && isGate(checker.getTypeAtLocation(node.expression.expression))) {
        if (insideEmit(node)) problems.push(`nested gate send at ${where(node)}`);
        if (fnName(node) === "pinnedCall" && rel === "server/memory/extractor-connections.ts") problems.push(`send inside pinnedCall at ${where(node)}`);
      }
      // the stop gate is recognised by type (isGateLaunchCallback), so only createStopGate may make one: outside stop-gate.ts no object
      // literal, type assertion or class may stand in for it (a value annotated StopGate whose launch defers would launder a deferred write)
      if (rel !== "server/drivers/stop-gate.ts" && !cachedGate) {
        const problems = freshGate; // this file's findings are kept for the later programs that reuse its parsed tree (see gateCache)
        if (ts.isObjectLiteralExpression(node)) { const ctx = checker.getContextualType(node); if (ctx && isStopGate(checker.getNonNullableType(ctx))) problems.push(`a hand-built stop gate at ${where(node)}`); }
        if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isStopGate(checker.getTypeFromTypeNode(node.type)) && !isStopGate(checker.getTypeAtLocation(node.expression))) problems.push(`a stop gate made by a type assertion at ${where(node)}`);
        if (ts.isClassLike(node) && (node.heritageClauses ?? []).some(h => h.types.some(t => isStopGate(checker.getTypeAtLocation(t.expression))))) problems.push(`a class standing in for the stop gate at ${where(node)}`);
        // ...and no one may change a real one: no write to, delete of, define on or proxy over a stop gate member or value
        const isStopGateValue = (e: ts.Expression): boolean => isStopGate(checker.getNonNullableType(checker.getTypeAtLocation(peel(e))));
        const gateOrAny = (e: ts.Expression): boolean => { const t = checker.getTypeAtLocation(peel(e)); return !!(t.flags & ts.TypeFlags.Any) || isStopGate(checker.getNonNullableType(t)); };
        // a member named like a gate's, on a receiver that is a stop gate or untyped (`step` and `handoff` are ordinary names elsewhere)
        const memberOf = (e: ts.Expression): boolean => {
          const x = peel(e);
          if (ts.isPropertyAccessExpression(x)) return GATE_MEMBERS.has(x.name.text) && gateOrAny(x.expression);
          return ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression) && GATE_MEMBERS.has(x.argumentExpression.text) && gateOrAny(x.expression);
        };
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && memberOf(node.left)) problems.push(`a write to a stop gate member at ${where(node)}`);
        if (ts.isDeleteExpression(node) && memberOf(node.expression)) problems.push(`a delete of a stop gate member at ${where(node)}`);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect")) {
          const callee = `${node.expression.expression.text}.${node.expression.name.text}`, [first, second] = node.arguments;
          if (/^Object\.(assign|defineProperties|setPrototypeOf)$/.test(callee) && first && (isStopGateValue(first) || (gateOrAny(first) && node.arguments.some(a => ts.isObjectLiteralExpression(peel(a)) && (peel(a) as ts.ObjectLiteralExpression).properties.some(p => !!p.name && p.name.getText() === "launch"))))) problems.push(`${callee} on a stop gate at ${where(node)}`);
          if (/^(Object\.defineProperty|Reflect\.(set|defineProperty|deleteProperty|setPrototypeOf))$/.test(callee) && first && (isStopGateValue(first) || (gateOrAny(first) && second && ts.isStringLiteralLike(second) && GATE_MEMBERS.has(second.text)))) problems.push(`${callee} on a stop gate at ${where(node)}`);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy" && node.arguments?.[0] && gateOrAny(node.arguments[0])) problems.push(`a Proxy over the stop gate at ${where(node)}`);
        // an untyped value must not flow into a place that expects the stop gate (argument, initializer, return, assignment)
        if (ts.isExpression(node) && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent) || ts.isVariableDeclaration(node.parent) || ts.isReturnStatement(node.parent) || ts.isBinaryExpression(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isArrowFunction(node.parent))) {
          // the cheap test first: only an `any`-typed expression can be this, and most are not
          const ctx = checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any ? checker.getContextualType(node) : undefined;
          if (ctx && isStopGate(checker.getNonNullableType(ctx))) problems.push(`an untyped value flows into a stop gate at ${where(node)}`);
        }
      }
      // other checks (section 4): adapterText only at its sites; fixedPrompt only on module-level constants; the r3 builders are gone
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fixedPrompt") {
        const arg = node.arguments[0];
        const decl = arg && ts.isIdentifier(arg) ? resolve(arg)?.valueDeclaration : undefined;
        const moduleConst = !!decl && ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(decl.parent.parent) && ts.isSourceFile(decl.parent.parent.parent) && !!decl.initializer && (ts.isStringLiteralLike(decl.initializer) || ts.isCallExpression(decl.initializer) || ts.isTemplateExpression(decl.initializer));
        if (!moduleConst) problems.push(`fixedPrompt on a value that is not a module constant at ${where(node)}`);
      }
      if (ts.isIdentifier(node) && ["memorySendFence", "fenceFromCheck", "adapterText"].includes(node.text)) problems.push(`${node.text} at ${where(node)}`);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (cachedGate) problems.push(...cachedGate);
    else if (rel !== "server/drivers/stop-gate.ts") { gateCache.set(sf, freshGate); problems.push(...freshGate); }
  }
  return { sinks, callers, problems };
}

/** The whole-chain synchronous lint for one hop: from the hook (or the function's start) to the next call on the path, nothing awaits,
 *  defers or stores the payload, every timer is pinned and none captures the payload, and the next call is not inside a deferred function. */
function lintHop(prog: ts.Program, hop: Hop, timers: TimerPin[]): string[] {
  const sf = prog.getSourceFile(join(ROOT, hop.file));
  if (!sf) return [`${hop.file}: missing`];
  const calls: ts.CallExpression[] = [];
  const all = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, all); };
  all(sf);
  const froms = hop.from ? calls.filter(c => anchorOf(c).startsWith(squash(hop.from))) : [];
  if (hop.from && froms.length !== 1) return [`${hop.file}: the hook anchor ${hop.from} matches ${froms.length} calls`];
  const from = froms[0];
  const fn = from ? fnName(from) : hop.fn;
  if (hop.via?.length) return from ? lintViaHop(prog, sf, hop, from, fn, timers) : [`${hop.file}: a via hop needs its hook anchor`];
  const to = calls.find(c => fnName(c) === fn && anchorOf(c).startsWith(squash(hop.to)) && (!from || c.getStart() > from.getEnd()));
  if (!to) return [`${hop.file} ${fn}: write anchor moved (${hop.from || "start"} -> ${hop.to})`];
  let fnNode: ts.Node | undefined = to.parent;
  while (fnNode && !((ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode) || ts.isFunctionDeclaration(fnNode) || ts.isMethodDeclaration(fnNode)) && nameOfFn(fnNode) === fn)) fnNode = fnNode.parent;
  if (!fnNode || !(fnNode as ts.FunctionLikeDeclaration).body) return [`${hop.file} ${fn}: enclosing function not found`];
  const out: string[] = [];
  // the write may sit only in a synchronous Promise executor below the innermost function that holds the hook (or below the function)
  const fnLike = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
  let hookFn: ts.Node = fnNode;
  if (from) for (let cur: ts.Node = from.parent; cur && cur !== fnNode; cur = cur.parent) if (fnLike(cur)) { hookFn = cur; break; }
  if (!(to.getStart() >= hookFn.getStart() && to.getEnd() <= hookFn.getEnd())) out.push(`${hop.file} ${fn}: the write is outside the hook's function`);
  deferredBetween(prog, to, to.getStart() >= hookFn.getStart() && to.getEnd() <= hookFn.getEnd() ? hookFn : fnNode, hop.file, fn, out);
  lintRange(prog, hop, fn, fnNode, from ? from.getEnd() : (fnNode as ts.FunctionLikeDeclaration).body!.getStart(), to, timers, out);
  return out;
}
/** Whether a function between a write and its chain function may run after the write's caller returns. The only functions that run
 *  inline are a synchronous Promise executor and a non-async stop-gate launch callback (isGateLaunchCallback). */
function deferredBetween(prog: ts.Program, from: ts.Node, stop: ts.Node, hopFile: string, fn: string, out: string[]): void {
  const checker = prog.getTypeChecker();
  for (let cur: ts.Node = from.parent; cur && cur !== stop; cur = cur.parent) {
    // any function between them, a declaration or a method too: a declared function may be handed to a timer or a then
    if (execBoundary(cur)) {
      const executor = (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isNewExpression(cur.parent) && cur.parent.expression.getText() === "Promise" && cur.parent.arguments?.[0] === cur && !isAsyncFn(cur) && !isGenerator(cur);
      if (!executor && !isGateLaunchCallback(checker, cur)) out.push(`${hopFile} ${fn}: the write sits in a deferred function`);
    }
  }
}
/** Every function in the file declared under `name`: `function name`, or `const name = () => ...` / `= function ...`. */
function declsNamed(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration[] {
  const out: ts.FunctionLikeDeclaration[] = [];
  const v = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) out.push(n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) out.push(n.initializer);
    ts.forEachChild(n, v);
  };
  v(sf);
  return out;
}
/** A hook hop whose write sits in same-file helpers (`via`). Each named helper must be a non-async function that a call inside the hook's
 *  function reaches after the hook, outside any deferred function; the path to the write inside the helper is then linted as a hop of its own. */
function lintViaHop(prog: ts.Program, sf: ts.SourceFile, hop: Hop, from: ts.CallExpression, fn: string, timers: TimerPin[]): string[] {
  const out: string[] = [];
  const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration => execBoundary(n);
  let fnNode: ts.Node | undefined = from.parent;
  while (fnNode && !(isFn(fnNode) && nameOfFn(fnNode) === fn)) fnNode = fnNode.parent;
  if (!fnNode) return [`${hop.file} ${fn}: enclosing function not found`];
  let hookFn: ts.Node = fnNode;
  for (let cur: ts.Node = from.parent; cur && cur !== fnNode; cur = cur.parent) if (isFn(cur)) { hookFn = cur; break; }
  for (const name of hop.via ?? []) {
    // the helper's declaration, and EVERY reference to it in the file: each must be a plain call, after the hook and inside the hook's
    // function. A reference that is not a call (`.then(helper)`, `helper.bind(...)`, `const f = helper`) could run it later, and a call
    // outside the hook's function or before the hook writes without the admission.
    const decls = declsNamed(sf, name);
    const helper = decls.length === 1 ? decls[0] : undefined;
    if (!helper || !helper.body) { out.push(`${hop.file} ${fn}: helper ${name} is not exactly one same-file function`); continue; }
    if (isAsyncFn(helper)) out.push(`${hop.file} ${fn}: helper ${name} is async`);
    if (isGenerator(helper)) out.push(`${hop.file} ${fn}: helper ${name} is a generator`);
    // by NAME, not by symbol: any identifier spelled like the helper (a shorthand property, a property access, a rebinding) is a reference
    const refs: ts.Identifier[] = [];
    const collect = (n: ts.Node) => { if (ts.isIdentifier(n) && n.text === name && n !== helper.name && n !== (helper.parent as ts.VariableDeclaration).name) refs.push(n); ts.forEachChild(n, collect); };
    collect(sf);
    const sites: ts.CallExpression[] = [];
    for (const ref of refs) {
      if (ts.isCallExpression(ref.parent) && ref.parent.expression === ref) sites.push(ref.parent);
      else out.push(`${hop.file} ${fn}: helper ${name} is referenced other than by a plain call at ${relFwd(sf.fileName)}:${sf.getLineAndCharacterOfPosition(ref.getStart()).line + 1}`);
    }
    for (const site of sites) if (!(site.getStart() >= hookFn.getStart() && site.getEnd() <= hookFn.getEnd() && site.getStart() > from.getEnd())) out.push(`${hop.file} ${fn}: the write is outside the hook's function (helper ${name} is called outside it or before the hook)`);
    const inside = sites.filter(c => c.getStart() >= hookFn.getStart() && c.getEnd() <= hookFn.getEnd() && c.getStart() > from.getEnd());
    if (!inside.length) { if (!sites.length) out.push(`${hop.file} ${fn}: helper ${name} is never called after the hook`); continue; }
    for (const site of inside) {
      deferredBetween(prog, site, hookFn, hop.file, fn, out);
      lintRange(prog, hop, fn, fnNode, from.getEnd(), site, timers, out);
    }
    const writes = callsInNode(helper.body).filter(c => anchorOf(c).startsWith(squash(hop.to)));
    if (!writes.length) { out.push(`${hop.file} ${name}: write anchor moved (${hop.to})`); continue; }
    for (const write of writes) {
      deferredBetween(prog, write, helper, hop.file, name, out);
      lintRange(prog, hop, name, helper, helper.body.getStart(), write, timers, out);
    }
  }
  return out;
}
function callsInNode(root: ts.Node): ts.CallExpression[] { const out: ts.CallExpression[] = []; const v = (n: ts.Node) => { if (ts.isCallExpression(n)) out.push(n); ts.forEachChild(n, v); }; v(root); return out; }
/** The synchronous lint of the code between `start` and `to` inside `fnNode`: nothing awaits (but the write call itself), every timer is
 *  pinned and none captures the payload, no callback is handed the payload, and the payload is not stored outside the function. */
function lintRange(prog: ts.Program, hop: Hop, fn: string, fnNode: ts.Node, start: number, to: ts.CallExpression, timers: TimerPin[], out: string[]): void {
  const end = to.getStart();
  const payload = new Set(hop.payload.map(squash));
  const captures = (node: ts.Node): boolean => { let hit = false; const v = (n: ts.Node) => { if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && payload.has(squash(n.getText()))) hit = true; if (!hit) ts.forEachChild(n, v); }; v(node); return hit; };
  const fnStart = fnNode.getStart(), fnEnd = fnNode.getEnd();
  const walk = (node: ts.Node) => {
    const at = node.getStart();
    if (at >= start && at < end) {
      // an await is allowed only around the write call itself (the call runs before the suspension)
      if (ts.isAwaitExpression(node) && !(to.getStart() >= node.expression.getStart() && to.getEnd() <= node.getEnd())) out.push(`${hop.file} ${fn}: await on the hook chain (${anchorOf(node).slice(0, 60)})`);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (TIMERS.has(name)) {
          if (!timers.some(t => t.file === hop.file && anchorOf(node).startsWith(squash(t.anchor)))) out.push(`${hop.file} ${fn}: unpinned timer on the hook chain (${anchorOf(node).slice(0, 60)})`);
          if (captures(node)) out.push(`${hop.file} ${fn}: a timer captures the payload`);
        }
        if (["then", "catch", "finally", "on", "once", "addListener", "addEventListener"].includes(name) && node.arguments.some(captures)) out.push(`${hop.file} ${fn}: the payload is handed to a callback (${name})`);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && captures(node.right)) {
        const decl = prog.getTypeChecker().getSymbolAtLocation(node.left)?.valueDeclaration;
        if (decl && !(decl.getStart() >= fnStart && decl.getEnd() <= fnEnd)) out.push(`${hop.file} ${fn}: the payload is stored outside the chain`);
      }
    }
    if (node.getEnd() > start && at < end) ts.forEachChild(node, walk);
  };
  ts.forEachChild(fnNode, walk);
}
function nameOfFn(node: ts.Node): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  const p = node.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return p.name.getText();
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return squash(p.left.getText()).slice(0, 60);
  return "";
}

const keyOf = (e: { file: string; fn: string; anchor: string; n?: number; kind?: string; callee?: string }) => `${e.file}|${e.fn}|${e.kind ?? e.callee}|${e.anchor}|${e.n ?? 0}`;
function diff(found: Scan, pins: Pins): string[] {
  const out: string[] = [...found.problems];
  for (const [label, have, want] of [["sink", found.sinks, pins.sinks], ["caller", found.callers, pins.callers]] as const) {
    const pinned = new Set(want.map(keyOf)), seen = new Set(have.map(keyOf));
    for (const e of have) if (!pinned.has(keyOf(e))) out.push(`unpinned ${label}: ${keyOf(e)}`);
    for (const e of want) if (!seen.has(keyOf(e))) out.push(`vanished or moved ${label} pin: ${keyOf(e)}`);
  }
  for (const e of pins.sinks) if (e.reason === "adapter-write" && !e.admittedBy) out.push(`adapter-write without admittedBy: ${keyOf(e)}`);
  for (const e of [...pins.sinks, ...pins.callers]) if ((e.reason === "learning-path" || e.reason === "learning-local") && !e.admittedBy) out.push(`${e.reason} without admittedBy: ${keyOf(e)}`);
  // the hidden learning turn carries the flattened extraction/grounding/inference messages: every sendTurn there must hand the engine
  // the gate's admit hook (GrokBuild r1), so it can never be pinned under another reason
  for (const e of [...found.sinks, ...pins.sinks]) if (e.file === "server/drivers/cli-memory-learning.ts" && e.kind === "sendTurn" && pins.sinks.find(p => keyOf(p) === keyOf(e))?.admittedBy !== "fence:beforeSubmit") out.push(`a learning sendTurn without the beforeSubmit fence: ${keyOf(e)}`);
  const writes = pins.sinks.filter(e => e.reason === "adapter-write").length;
  // one write per chain, or one per helper a chain's last hop names in `via`
  const sites = pins.chains.reduce((n, c) => n + (c.hops[c.hops.length - 1]?.via?.length || 1), 0);
  if (writes !== sites) out.push(`adapter-write pins (${writes}) and linted chain writes (${sites}) differ`);
  // and each helper a chain names in `via` has its own adapter-write pin (one pin per verified write, not just the same total)
  for (const c of pins.chains) {
    const last = c.hops[c.hops.length - 1];
    for (const name of last?.via ?? []) if (!pins.sinks.some(e => e.reason === "adapter-write" && e.file === last.file && e.fn === name && e.anchor.startsWith(squash(last.to)))) out.push(`chain ${c.name}: no adapter-write pin for its helper ${name}`);
  }
  return out;
}
function lintChains(prog: ts.Program, pins: Pins): string[] { return pins.chains.flatMap(chain => chain.hops.flatMap(hop => lintHop(prog, hop, pins.timers).map(p => `${chain.name}: ${p}`))); }

let base: ts.Program, pins: Pins, found: Scan;
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const planted = (extra: Record<string, string>) => { const prog = program(extra, base); return [...diff(scan(prog, pins), pins), ...lintChains(prog, pins)]; };

describe("the learning send boundary (section 4)", () => {
  it("keys files with forward slashes whatever the platform's separator", () => {
    expect(fwd("server\\memory\\learning-send.ts")).toBe("server/memory/learning-send.ts");
    expect(fwd("server/atomic.ts")).toBe("server/atomic.ts");
    expect(fwd("server\\sentinel\\win-acl.ts").startsWith("server/")).toBe(true);
  });
  beforeAll(() => {
    pins = JSON.parse(readFileSync(PINS_FILE, "utf8")) as Pins;
    base = program();
    found = scan(base, pins);
    if (process.env.LEARNING_SINKS_WRITE === "1") {
      const keep = new Map(pins.sinks.map(e => [keyOf(e), e]));
      const keepCallers = new Map(pins.callers.map(e => [keyOf(e), e]));
      pins = { ...pins, sinks: found.sinks.map(e => keep.get(keyOf(e)) ?? (e.kind === "native-log" ? { ...e, reason: "log-excluded" as const } : e)), callers: found.callers.map(e => keepCallers.get(keyOf(e)) ?? e) };
      writeFileSync(PINS_FILE, JSON.stringify(pins, null, 1) + "\n");
    }
  }, 600_000);

  it("every sink in server/ is inside a gate's send or pinned at its call site, and nothing else is wrong", () => {
    expect(diff(found, pins)).toEqual([]);
  });
  it("every hook-to-write chain is synchronous for its payload", () => {
    expect(lintChains(base, pins)).toEqual([]);
  });
  it("HTTP learning transports have no exemption: their fetch is inside the gate's send", () => {
    expect(pins.sinks.filter(e => (e.kind === "fetch" || e.kind === "alias-call") && (e.file === "server/drivers/http-text-only.ts" || e.file === "server/memory/extract.ts"))).toEqual([]);
  });

  describe("T15a: planted bypasses fail the scan", () => {
    const NEW = "server/memory/__planted__.ts";
    it("a raw fetch in a new file", () => { expect(planted({ [NEW]: `export const leak = (p: string) => fetch("https://x.invalid", { method: "POST", body: p });\n` }).join("\n")).toMatch(/unpinned sink: server\/memory\/__planted__\.ts\|leak\|fetch/); }, 600_000);
    it("an aliased fetch", () => { expect(planted({ [NEW]: `const f = fetch;\nexport const leak = (p: string) => f("https://x.invalid", { body: p });\n` }).join("\n")).toMatch(/unpinned sink: .*__planted__.*\|(fetch|alias-call)\|/); }, 600_000);
    it("a Writable.write in a new helper", () => { expect(planted({ [NEW]: `import type { Writable } from "node:stream";\nexport const leak = (w: Writable, p: string) => w.write(p);\n` }).join("\n")).toMatch(/unpinned sink: .*__planted__.*stream-write/); }, 600_000);
    it("a deferred payload write", () => { expect(planted({ [NEW]: `import type { Writable } from "node:stream";\nexport const leak = (w: Writable, p: string) => queueMicrotask(() => w.write(p));\n` }).join("\n")).toMatch(/unpinned sink: .*__planted__.*stream-write/); }, 600_000);
    it("an await inside a hook chain", () => {
      const file = "server/drivers/codex.ts", text = read(file);
      const bad = text.replace(/awaitingTurnStart = true;(\s*)turnStartSent = true;/, "await Promise.resolve();$1awaitingTurnStart = true;$1turnStartSent = true;");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*await on the hook chain/);
    }, 600_000);
    it("Muse admission cannot move ahead of an await, outside the write function or into a timer", () => {
      const file = "server/drivers/muse-code.ts", text = read(file);
      const awaited = text.replace("admitted = true;", "await Promise.resolve(); admitted = true;");
      expect(awaited).not.toBe(text);
      expect(planted({ [file]: awaited }).join("\n")).toMatch(/muse: .*await on the hook chain/);
      const moved = text.replace("p.beforeSubmit?.();", "(() => { p.beforeSubmit?.(); })();");
      expect(planted({ [file]: moved }).join("\n")).toMatch(/muse: .*outside the hook's function/);
      const prompt = 'submit();\n              child.stdin.write(bytes, "utf8", onWritten);';
      const deferred = text.replace(prompt, 'submit();\n              setTimeout(() => child.stdin.write(bytes, "utf8", onWritten), 0);');
      expect(deferred).not.toBe(text);
      expect(planted({ [file]: deferred }).join("\n")).toMatch(/muse: .*deferred function/);
    }, 600_000);
    describe("a stop gate's launch callback is same-tick only for its proven call shape (STOP-NONACP)", () => {
      // the controls: the shipped code (a non-async callback of the stop gate's launch) is accepted by the chain lint
      it("accepts the shipped muse and codex launch callbacks", () => { expect(lintChains(base, pins).filter(p => /^(muse|codex):/.test(p))).toEqual([]); });
      it("rejects a genuinely async muse launch callback", () => {
        const file = "server/drivers/muse-code.ts", text = read(file);
        const bad = text.replace("gate.launch(prompt.entry, () => {", "gate.launch(prompt.entry, async () => {");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a deferred muse write inside the launch callback", () => {
        const file = "server/drivers/muse-code.ts", text = read(file);
        const bad = text.replace("gate.launch(prompt.entry, () => {\n              submit();\n              child.stdin.write(bytes, \"utf8\", onWritten);", "gate.launch(prompt.entry, () => {\n              submit();\n              void Promise.resolve().then(() => child.stdin.write(bytes, \"utf8\", onWritten));");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a muse write helper that is called outside the hook's function", () => {
        const file = "server/drivers/muse-code.ts", text = read(file);
        const bad = text.replace("p.beforeSubmit?.();", "(() => { p.beforeSubmit?.(); })();");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/muse: .*outside the hook's function/);
      }, 600_000);
      it("rejects a genuinely async codex launch callback", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const bad = text.replace("gate.launch(entry, () => request(method, commandParams ?? {", "gate.launch(entry, async () => request(method, commandParams ?? {");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*deferred function/);
      }, 600_000);
      it("rejects a look-alike that has all five of the stop gate's names but is not declared in stop-gate.ts", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const bad = text.replace("gate.launch(entry, () => request(method, commandParams ?? {", "lookalike.launch(entry, () => request(method, commandParams ?? {")
          + "\nconst lookalike = { launch: (_entry: unknown, f: () => unknown) => setTimeout(f, 0), step: undefined, cleanupStep: undefined, handoff: undefined, bindLive: undefined };\n";
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*deferred function/);
      }, 600_000);
      const MUSE = "server/drivers/muse-code.ts";
      const PROMPT_CALL = "if (p && MUSE_PROMPT_METHODS.has(String(frame.method))) writePrompt(p as PromptFrame, chunk);";
      const CONTROL_CALL = "else writeControl(controlFrame(chunk, frame));";
      it("rejects the prompt helper called from a declared function handed to a then", () => {
        const text = read(MUSE), bad = text.replace(PROMPT_CALL, "if (p && MUSE_PROMPT_METHODS.has(String(frame.method))) { function later() { writePrompt(p as PromptFrame, chunk); } Promise.resolve().then(later); }");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects the prompt helper handed on without a plain call (a bound reference), whatever else calls it", () => {
        const text = read(MUSE), bad = text.replace(CONTROL_CALL, `${CONTROL_CALL}\n        Promise.resolve().then(writePrompt.bind(null, p as PromptFrame, chunk));`);
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is referenced other than by a plain call/);
      }, 600_000);
      it("rejects an async write helper", () => {
        const text = read(MUSE), bad = text.replace("const writePrompt = (prompt: PromptFrame, bytes: string) => {", "const writePrompt = async (prompt: PromptFrame, bytes: string) => {");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is async/);
      }, 600_000);
      it("rejects a deferred call of the control write helper", () => {
        const text = read(MUSE), bad = text.replace(CONTROL_CALL, "else setTimeout(() => writeControl(controlFrame(chunk, frame)), 0);");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a union receiver when any member is not the stop gate", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const bad = text.replace("gate.launch(entry, () => request(method, commandParams ?? {", "pick.launch(entry, () => request(method, commandParams ?? {")
          + "\ndeclare const real: import(\"./stop-gate.ts\").StopGate;\nconst lookalike = { launch: (_entry: unknown, f: () => unknown) => Promise.resolve().then(f), step: undefined, cleanupStep: undefined, handoff: undefined, bindLive: undefined };\nconst pick = Math.random() > 2 ? real : lookalike;\n";
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*deferred function/);
      }, 600_000);
      it("rejects the prompt helper escaping through a shorthand property", () => {
        const text = read(MUSE), bad = text.replace(CONTROL_CALL, `${CONTROL_CALL}\n        const escaped = { writePrompt };\n        Promise.resolve().then(() => escaped.writePrompt(p as PromptFrame, chunk));`);
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is referenced other than by a plain call/);
      }, 600_000);
      it("rejects a generator write helper", () => {
        const text = read(MUSE), bad = text.replace("const writePrompt = (prompt: PromptFrame, bytes: string) => {", "const writePrompt = function* (prompt: PromptFrame, bytes: string) {");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is a generator/);
      }, 600_000);
      it("rejects a write moved into an accessor the helper hands to a then", () => {
        const text = read(MUSE), original = "const writeControl = (bytes: ControlFrame) => {\n          submit();\n          child.stdin.write(bytes, \"utf8\", onWritten);\n        };";
        const bad = text.replace(original, "const writeControl = (bytes: ControlFrame) => {\n          submit();\n          const lazy = { get value() { return child.stdin.write(bytes, \"utf8\", onWritten); } };\n          void Promise.resolve().then(() => lazy.value);\n        };");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a hand-built value annotated as the stop gate whose launch defers", () => {
        const text = read(MUSE);
        const bad = text.replace("gate.launch(prompt.entry, () => {", "const delayed: StopGate = { ...gate, launch(_entry: unknown, fn: () => unknown) { void Promise.resolve().then(fn); throw new Error(\"queued\"); } };\n            delayed.launch(prompt.entry, () => {");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/a hand-built stop gate at server\/drivers\/muse-code\.ts/);
        const asserted = text.replace("gate.launch(prompt.entry, () => {", "const delayed = { launch: (_entry: unknown, fn: () => unknown) => Promise.resolve().then(fn) } as unknown as StopGate;\n            delayed.launch(prompt.entry, () => {");
        expect(asserted).not.toBe(text);
        expect(planted({ [MUSE]: asserted }).join("\n")).toMatch(/a stop gate made by a type assertion at server\/drivers\/muse-code\.ts/);
      }, 600_000);
      it("rejects replacing, proxying or defining over a real stop gate's launch, and an untyped value passed as the gate", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const call = "await gate.step(entry, gate.launch(entry, () => request(method, commandParams ?? {";
        const replaced = text.replace(call, `gate.launch = new Proxy(gate.launch, { apply: (target, self, args) => Promise.resolve().then(() => Reflect.apply(target, self, args)) });\n        ${call}`);
        expect(replaced).not.toBe(text);
        expect(planted({ [file]: replaced }).join("\n")).toMatch(/a write to a stop gate member at server\/drivers\/codex\.ts/);
        const cast = text.replace(call, `(gate as unknown as { launch: unknown }).launch = () => undefined;\n        ${call}`);
        expect(planted({ [file]: cast }).join("\n")).toMatch(/a write to a stop gate member at server\/drivers\/codex\.ts/);
        const defined = text.replace(call, `Object.defineProperty(gate, "launch", { value: () => undefined });\n        ${call}`);
        expect(planted({ [file]: defined }).join("\n")).toMatch(/Object\.defineProperty on a stop gate at server\/drivers\/codex\.ts/);
        const muse = read(MUSE);
        const proxied = muse.replace("gate.launch(prompt.entry, () => {", "const g2 = new Proxy(gate, {});\n            g2.launch(prompt.entry, () => {");
        expect(proxied).not.toBe(muse);
        expect(planted({ [MUSE]: proxied }).join("\n")).toMatch(/a Proxy over the stop gate at server\/drivers\/muse-code\.ts/);
        const untyped = muse.replace("gate.launch(prompt.entry, () => {", "const fake: any = {};\n            const g3: StopGate = fake;\n            g3.launch(prompt.entry, () => {");
        expect(untyped).not.toBe(muse);
        expect(planted({ [MUSE]: untyped }).join("\n")).toMatch(/an untyped value flows into a stop gate at server\/drivers\/muse-code\.ts/);
      }, 600_000);
      it("rejects the prompt helper called from a class field initializer", () => {
        const text = read(MUSE), bad = text.replace(PROMPT_CALL, "if (p && MUSE_PROMPT_METHODS.has(String(frame.method))) { class Later { sent = writePrompt(p as PromptFrame, chunk); } void Promise.resolve().then(() => new Later()); }");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a chain whose helper has no pin of its own", () => {
        const unpinned = { ...pins, sinks: pins.sinks.map(e => e.file === MUSE && e.fn === "writeControl" ? { ...e, reason: "not-learning" as const, admittedBy: "" } : e) };
        expect(diff(found, unpinned).join("\n")).toMatch(/chain muse: no adapter-write pin for its helper writeControl/);
      });
    });
    it("a new unpinned timer on the ACP prompt path", () => {
      const file = "server/drivers/acp/core.ts", text = read(file);
      const bad = text.replace("send({ jsonrpc: \"2.0\", id, method, params });", "setImmediate(() => undefined); send({ jsonrpc: \"2.0\", id, method, params });");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/unpinned timer/);
    }, 600_000);
    it("a gate payload passed to a not-learning ACP caller, the !proc arm or the interjection", () => {
      const file = "server/drivers/acp/core.ts", text = read(file);
      const caller = pins.callers.find(c => c.file === file && c.callee === "send");
      expect(caller).toBeTruthy();
      const bad = text.replace("writeAcpResponse(child?.stdin, obj,", "writeAcpResponse(child?.stdin, (globalThis as { leak?: unknown }).leak ?? obj,");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/vanished or moved|unpinned/);
    }, 600_000);
    const GATED = `import type { LearningGate } from "./learning-send.ts";\n`;
    it("a deferred fetch inside an otherwise accepted gate.send (H5)", () => {
      // the control: the same fetch run inside the emit is accepted
      expect(planted({ [NEW]: `${GATED}export const fine = (gate: LearningGate, p: string) => gate.send(() => fetch("https://x.invalid", { method: "POST", body: p }));\n` }).join("\n")).not.toMatch(/__planted__/);
      const out = planted({ [NEW]: `${GATED}export const leak = (gate: LearningGate, p: string) => gate.send(() => { queueMicrotask(() => { void fetch("https://x.invalid", { method: "POST", body: p }); }); });\n` }).join("\n");
      expect(out).toMatch(/deferred write inside an emit \(queueMicrotask\) at server\/memory\/__planted__\.ts/);
      expect(out).toMatch(/unpinned sink: server\/memory\/__planted__\.ts\|leak\|fetch\|/);
    }, 600_000);
    it("a setTimeout, a then and an async callback inside a gate.send (H5)", () => {
      const out = planted({ [NEW]: `${GATED}import type { Writable } from "node:stream";\nexport const leak = (gate: LearningGate, w: Writable, p: string) => gate.send(() => {\n  setTimeout(() => fetch("https://x.invalid", { body: p }), 0);\n  [p].forEach(async q => { await null; w.write(q); });\n  return Promise.resolve().then(() => w.write(p));\n});\n` }).join("\n");
      expect(out).toMatch(/deferred write inside an emit \(setTimeout\)/);
      expect(out).toMatch(/deferred write inside an emit \(then\)/);
      expect(out).toMatch(/deferred write inside an emit \(async function\)/);
      expect(out).toMatch(/unpinned sink: .*__planted__.*\|fetch\|/);
      expect(out).toMatch(/unpinned sink: .*__planted__.*\|stream-write\|/);
    }, 600_000);
    it("a deferral in a same-file helper the emit calls, under an unchanged pin (H5)", () => {
      const file = "server/drivers/headless-text-only.ts", text = read(file);
      const write = `writeFileSync(o.temp.promptFile, promptBytes, { mode: 0o600 })`;
      const bad = text.replace(`${write};`, `setImmediate(() => { ${write}; });`);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/deferred write in helper writeAndSpawn \(setImmediate\)/);
      expect(out).not.toMatch(/unpinned sink:|vanished or moved sink pin:/); // the pin still matches: only the helper walk sees the deferral
    }, 600_000);
    it("the voice host SSE emit without projectEvent (D24CH)", () => {
      const file = "server/voice/voice-host-route.ts", text = read(file);
      const bad = text.replace("JSON.stringify(projectEvent(event))", "JSON.stringify(event)");
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/unpinned sink: server\/voice\/voice-host-route\.ts\|emit\|stream-write\|/);
      expect(out).toMatch(/vanished or moved sink pin: server\/voice\/voice-host-route\.ts\|emit\|stream-write\|/);
    }, 600_000);
    it("an unchanged-anchor gate payload at a pinned not-learning ACP send( caller and at the interjection (H5)", () => {
      const file = "server/drivers/acp/core.ts", text = read(file);
      const sendSite = `send({ jsonrpc: "2.0", id: msg.id, result });`;
      const bad = text.replace(sendSite, `result = turn.text; ${sendSite}`);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/a gate payload reaches the not-learning send\( caller at server\/drivers\/acp\/core\.ts/);
      expect(out).not.toMatch(/vanished or moved caller pin/);
      const steer = `const response = request(support.interjection!.method, { sessionId, text, interjectionId }, ackMs)`;
      const bad2 = text.replace(steer, `text = turn.text; ${steer}`);
      expect(bad2).not.toBe(text);
      expect(planted({ [file]: bad2 }).join("\n")).toMatch(/a gate payload reaches the not-learning request\( caller/);
    }, 600_000);
    it("a learning-path pin whose hook no longer admits (H4)", () => {
      const file = "server/drivers/cli-memory-learning.ts", text = read(file);
      const bad = text.replace("try { gate.admit(); }", "try { gate.check(); }");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/learning-path sink pin not proven \(fence:beforeSubmit\)/);
    }, 600_000);
    it("the hidden learning sendTurn without its beforeSubmit (H4, GrokBuild r1)", () => {
      const file = "server/drivers/cli-memory-learning.ts", text = read(file);
      const bad = text.replace(", ...(beforeSubmit ? { beforeSubmit, notWritten } : {})", "");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/a learning sendTurn without the beforeSubmit fence: server\/drivers\/cli-memory-learning\.ts\|hiddenTurnRunner\|sendTurn/);
      // re-pinning it under any other reason fails too
      const repinned = { ...pins, sinks: pins.sinks.map(e => e.kind === "sendTurn" && e.file === file ? { ...e, reason: "not-learning" as const, admittedBy: "" } : e) };
      expect(diff(found, repinned).join("\n")).toMatch(/a learning sendTurn without the beforeSubmit fence/);
    }, 600_000);
    it("the learning pins name their admission (H4)", () => {
      const learning = [...pins.sinks, ...pins.callers].filter(e => e.reason === "learning-path" || e.reason === "learning-local");
      expect(learning.map(e => `${e.file}|${e.fn}|${e.reason}|${e.admittedBy}`).sort()).toEqual([
        "server/drivers/acp/core.ts|launch|learning-path|chain:acp",
        "server/drivers/acp/core.ts|request|learning-path|chain:acp",
        "server/drivers/acp/core.ts|send|learning-path|chain:acp",
        "server/drivers/acp/core.ts|writeTo|learning-path|chain:acp",
        "server/drivers/cli-memory-learning.ts|hiddenTurnRunner|learning-path|fence:beforeSubmit",
        "server/gepa-worker.ts|write|learning-local|child:spawn(command.executable,",
      ]);
    });
    it("a second send inside pinnedCall", () => {
      const file = "server/memory/extractor-connections.ts", text = read(file);
      const bad = text.replace("pinAnswered=null;\n  if(base!==\"flux-fast\")", "pinAnswered=null;\n  (globalThis as unknown as {g:import(\"./learning-send.ts\").LearningGate}).g.send(()=>undefined);\n  if(base!==\"flux-fast\")");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/send inside pinnedCall/);
    }, 600_000);
    it("an exemption whose line moved", () => {
      const moved = { ...pins, sinks: pins.sinks.map((e, i) => i === 0 ? { ...e, anchor: e.anchor + "x" } : e) };
      expect(diff(found, moved).join("\n")).toMatch(/vanished or moved sink pin/);
    });
    it("fixedPrompt on a computed value", () => {
      expect(planted({ [NEW]: `import { fixedPrompt } from "./fixed-prompt.ts";\nexport const leak = (p: string) => fixedPrompt(p);\n` }).join("\n")).toMatch(/fixedPrompt on a value/);
    }, 600_000);
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
