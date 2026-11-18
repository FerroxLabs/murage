import "../testing/port-integrity.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning send boundary (designs/MEM-LEARNING-FENCE-R6.md section 4, R8 section 4). A TypeScript-checker symbol scan of every
// non-test file under server/: each sink (fetch, child_process, spawnCli, fs writes, stdin write/end, any Writable .write, sendTurn,
// appendNative) sits inside a learning gate's `send` emit or matches a call-site pin in ci/learning-sinks.json. A new, moved or vanished
// pin fails. The adapter chains from each `fencedSubmit` emit (the gate's send, through SendTurnInput.fencedWrite) to its physical write
// are linted as synchronous, and planted bypasses (T15a) must each fail the scan. H1-SENDLOCK: `send` is the gate's only release (no
// admit/wrote/notWritten), and every withCliMemoryLearning adapter declares fencedLearningWrite and writes inside a send.
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
// that runs its argument inside a learning gate's send, and a linted chain's write runs inside that hook through fencedSubmit). `learning-local` is learning bytes handed to a
// process this file owns and nothing else: `admittedBy: "child:<spawn anchor>"` (the receiver is the const child that pinned spawn made).
// Every other caller of a pinned caller (the ACP send/writeTo/request/writeAcpResponse) must not be reached by a gate payload: a turn's
// `.text`, or a chain hook's payload, through same-file initializers and assignments, so a payload swapped in above an unchanged anchor fails.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import ts from "typescript";
import { plant, call, prop, stmt, decl } from "../testing/ast-plant.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
/** Pins are keyed with forward slashes; path.relative and path.join give backslashes on Windows. */
const fwd = (p: string): string => p.replace(/\\/g, "/");
const relFwd = (p: string): string => fwd(relative(ROOT, p));
// MAIN RULING: wave 1 moved Windows/Signal and Chrome sites and added scoped-state, ledger and restore-fixture writes; retain exact non-learning pins.
// MAIN RULING INT-CONFLICT-DEFAULT 4367d86628 / b36bf61264c: retain exact caller pins through counted-fs; inventory its physical writes and integrated local plumbing, with all chain/Stop contracts unchanged.
// MAIN RULING INT-CONFLICT-DEFAULT 6d0b181f4f 3e21303a24: exact moved bounded probe sites and the reviewed raw Cloud relay writer; all unlisted sites still fail.
// MAIN RULING 2026-11-14 INT-CONFLICT-DEFAULT 0753532d25 ee5db3261a: pin the reviewed fixed wipe shim/ACL support writes, compact session-ID cleanup journal and current Muse host environment. Prompt/answer boundaries and every unlisted sink remain checked.
// MAIN RULING INT-CONFLICT-DEFAULT a587265f6e / 99f4720b22: io-proxy-launcher native spawn gains reviewed withHideInherit options; argv, env, stdio and admission stay.
// MAIN RULING INT-CONFLICT-DEFAULT a587265f6e / 99f4720b22: phone-proxy runAdb native spawn copies the identical argument array; its existing non-learning pin and guards stay.
// MAIN RULING INT-CONFLICT-DEFAULT a587265f6e / 99f4720b22: field-replay git native exec copies arguments and gains reviewed Windows inheritance; exact private fixture operation stays.
// MAIN RULING INT-CONFLICT-DEFAULT 3facefc99e a39360909c / 1114-PI-ROOTS-PUBLISH-ON-CHANGE: pin only the new constant-size Pi wipe descriptor write; all learning chains and bypass controls stay.
const PINS_FILE = join(ROOT, "ci", "learning-sinks.json");
type Reason = "fixed-text" | "not-learning" | "adapter-write" | "log-excluded" | "learning-path" | "learning-local";
interface Pin { file: string; fn: string; anchor: string; kind: string; n?: number; reason: Reason; admittedBy?: string; review?: string }
interface CallerPin { file: string; fn: string; anchor: string; callee: string; n?: number; reason: Reason; admittedBy?: string; review?: string }
/** `via` (optional, only on a hook hop): the names of the same-file helper functions that hold the write(s) `to` names. The lint proves each
 *  is called synchronously after the hook, inside the hook's function, and that its own path to the write is synchronous. */
interface Hop { callback?: number; file: string; fn: string; from: string; to: string; payload: string[]; via?: string[]; fromIndex?: number; fromCount?: number; emit?: { file: string; fn: string; name: string } }
interface Chain { name: string; admittedBy: string; hops: Hop[] }
interface TimerPin { file: string; fn: string; anchor: string }
interface Pins { validators?: Array<{ file: string; fn: string; validated: true }>; logicalOwners?: Array<{ file: string; helper: string; owner: string }>; sinks: Pin[]; callers: CallerPin[]; chains: Chain[]; timers: TimerPin[]; pinnedCallers: Array<{ file: string; name: string }> }

const squash = (text: string) => text.replace(/\s+/g, "");
const anchorOf = (node: ts.Node) => squash(node.getText()).slice(0, 160);
const isTest = (file: string) => /\.test\.ts$|\/testing\/|\.d\.ts$/.test(file);

const functionBinding = (node: ts.Node): ts.Node => {
  let cur = node;
  while (ts.isParenthesizedExpression(cur.parent) || ts.isConditionalExpression(cur.parent)) cur = cur.parent;
  return cur.parent;
};

function fnName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) return cur.name?.getText() ?? "<anonymous>";
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent) {
      const p = functionBinding(cur);
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
/** A learning gate's shape (learning-send.ts LearningGate), and the admission methods H1-SENDLOCK removed: send is the only release. */
const GATE_KEYS = ["send", "check", "released", "refused", "purpose"];
const REMOVED_GATE_METHODS = ["admit", "wrote", "notWritten"];
/** Fence helpers are resolved to their real declarations; authority paths and callback placement are proved below. */
const FENCE_RUNNERS: Record<string, string> = { fencedWrite: "fencedSubmit(turn,", consuming: "emitConsumingTurnResponse|releaseNativeWire" };
/** Check the actual parameter symbols and both authority paths. Unknown conditions are explored both ways;
 * no source spelling or parameter count is pinned, and an unwrapped write is mandatory. */
function checkFenceRunner(decl: ts.FunctionDeclaration, checker: ts.TypeChecker): boolean {
  const turn = decl.parameters[0], write = decl.parameters[1];
  if (!turn || !write || !ts.isIdentifier(turn.name) || !ts.isIdentifier(write.name) || !decl.body || isAsyncFn(decl) || isGenerator(decl)) return false;
  const turnSymbol = checker.getSymbolAtLocation(turn.name), writeSymbol = checker.getSymbolAtLocation(write.name);
  const own = (node: ts.Expression, symbol: ts.Symbol | undefined): boolean => ts.isIdentifier(peel(node)) && !!symbol && checker.getSymbolAtLocation(peel(node)) === symbol;
  const member = (node: ts.Expression, name: string): boolean => { const e = peel(node); return ts.isPropertyAccessExpression(e) && e.name.text === name && own(e.expression, turnSymbol); };
  const serialized = decl.parameters[2], validate = decl.parameters[3];
  if (!serialized || !validate || !ts.isIdentifier(serialized.name) || !ts.isIdentifier(validate.name)) return false;
  const serializedSymbol = checker.getSymbolAtLocation(serialized.name), validateSymbol = checker.getSymbolAtLocation(validate.name);
  const undefinedSymbol = checker.resolveName("undefined", undefined, ts.SymbolFlags.Value, false);
  const isUndefined = (node: ts.Expression): boolean => ts.isIdentifier(peel(node)) && peel(node).getText() === "undefined" && checker.getSymbolAtLocation(peel(node)) === undefinedSymbol;
  const bytes = (node: ts.Expression): boolean => {
    const e = peel(node);
    if (!ts.isConditionalExpression(e) || !ts.isBinaryExpression(e.condition) || e.condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken || !own(e.condition.left, serializedSymbol) || !isUndefined(e.condition.right) || !isUndefined(e.whenTrue)) return false;
    const no = peel(e.whenFalse);
    return ts.isCallExpression(no) && ts.isPropertyAccessExpression(no.expression) && no.expression.name.text === "byteLength"
      && own(no.expression.expression, checker.resolveName("Buffer", undefined, ts.SymbolFlags.Value, false))
      && no.arguments.length === 1 && own(no.arguments[0], serializedSymbol);
  };
  // The only permitted fallback is an uncaught synchronous validator call,
  // immediately followed by write. Extra statements could rebind validation,
  // schedule it, swallow its error or skip it. The path proof below retains
  // both binding branches and rejects all assignments to captured authority.
  const statements = decl.body.statements;
  if (statements.length !== 4) return false;
  const fallback = statements[2];
  if (!ts.isExpressionStatement(fallback) || !ts.isCallExpression(fallback.expression)
    || !own(fallback.expression.expression, validateSymbol) || !fallback.expression.questionDotToken || fallback.expression.arguments.length) return false;
  type Exit = "next" | "fence" | "write" | "throw" | "bad";
  const check = (hasFence: boolean, hasBinding: boolean): boolean => {
    const truth = (e: ts.Expression): boolean | undefined => {
      e = peel(e);
      if (member(e, "fencedWrite")) return hasFence;
      if (member(e, "releaseBinding")) return hasBinding;
      if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) { const value = truth(e.operand); return value === undefined ? undefined : !value; }
      return e.kind === ts.SyntaxKind.TrueKeyword ? true : e.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
    };
    const unsafe = (root: ts.Node): boolean => {
      // A captured write may be invoked by a same-file helper or constructor.
      // Captured callbacks and state mutation cannot hide an early write.
      if (ts.isIdentifier(root) && checker.getSymbolAtLocation(root) === writeSymbol) return true;
      if (ts.isIdentifier(root) && checker.getSymbolAtLocation(root) === turnSymbol
        && !(ts.isPropertyAccessExpression(root.parent) && root.parent.expression === root)) return true;
      if (ts.isCallExpression(root) && member(root.expression, "fencedWrite") || ts.isDeleteExpression(root)
        || ts.isPostfixUnaryExpression(root)
        || ts.isPrefixUnaryExpression(root) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(root.operator)
        || ts.isBinaryExpression(root) && root.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && root.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
      return !!ts.forEachChild(root, n => unsafe(n) || undefined);
    };
    const returned = (e: ts.Expression): Exit[] => {
      e = peel(e);
      if (ts.isConditionalExpression(e)) {
        const yes = truth(e.condition);
        if (unsafe(e.condition)) return ["bad"];
        return [...(yes !== false ? returned(e.whenTrue) : []), ...(yes !== true ? returned(e.whenFalse) : [])];
      }
      if (ts.isCallExpression(e) && member(e.expression, "fencedWrite")) return hasFence && e.arguments.length === 3 && own(e.arguments[0], writeSymbol) && own(e.arguments[1], validateSymbol) && bytes(e.arguments[2]) && !e.arguments.slice(1).some(unsafe) ? ["fence"] : ["bad"];
      if (ts.isCallExpression(e) && own(e.expression, writeSymbol)) return !hasFence && !hasBinding && !e.arguments.length ? ["write"] : ["bad"];
      return ["bad"];
    };
    const statement = (node: ts.Statement): Exit[] => {
      if (ts.isBlock(node)) return sequence([...node.statements]);
      if (ts.isIfStatement(node)) {
        if (unsafe(node.expression)) return ["bad"];
        const yes = truth(node.expression);
        return [...(yes !== false ? statement(node.thenStatement) : []), ...(yes !== true ? node.elseStatement ? statement(node.elseStatement) : ["next" as const] : [])];
      }
      if (ts.isReturnStatement(node)) return node.expression ? returned(node.expression) : ["bad"];
      if (ts.isThrowStatement(node)) return unsafe(node.expression) ? ["bad"] : ["throw"];
      // Loops, try/finally and dispatching callbacks require an explicit extension to this proof.
      if (!(ts.isExpressionStatement(node) || ts.isVariableStatement(node) || ts.isEmptyStatement(node))) return ["bad"];
      return unsafe(node) ? ["bad"] : ["next"];
    };
    const sequence = (nodes: ts.Statement[]): Exit[] => {
      let paths: Exit[] = ["next"];
      for (const node of nodes) paths = paths.flatMap(exit => exit === "next" ? statement(node) : [exit]);
      return paths;
    };
    const expected: Exit = hasFence ? "fence" : hasBinding ? "throw" : "write";
    return sequence([...decl.body!.statements]).every(exit => exit === expected);
  };
  return [false, true].every(fence => [false, true].every(binding => check(fence, binding)));
}
/** Validator provenance belongs to the actual argument, not a matching but
 * unused function elsewhere in the adapter. These small guards are reviewed
 * synchronous, uncaught paths; the larger ACP/Codex contracts remain below. */
function validatedFenceCall(call: ts.CallExpression, file: string, checker: ts.TypeChecker): boolean {
  const argument = call.arguments[3];
  if (!argument) return false;
  const expected: Record<string, string> = {
    "server/drivers/acp/core.ts": '() => { if (turnHalted()) throw new Error("ACP_TURN_STOPPED"); fenceBeforeWrite(fence, state, obj, settleHalted); }',
    "server/drivers/codex.ts": '() => { const why = gate.why(entry); if (why || entry.done || stopRequested) throw new GateStopped(why); }',
    "server/drivers/pi.ts": '() => { if (stopGate.why(e) || e.done) throw new Error("PI_TURN_STOPPED"); }',
    "server/drivers/antigravity.ts": '() => { if (gate.why(entry) || entry.done || stopRequested) throw new GateStopped(gate.why(entry)); }',
  };
  if (expected[file]) return ts.isArrowFunction(argument) && !isAsyncFn(argument) && !isGenerator(argument)
    && squash(argument.getText()) === squash(expected[file]);
  if (file !== "server/drivers/claude.ts" || !ts.isIdentifier(argument)) return false;
  const declaration = checker.getSymbolAtLocation(argument)?.valueDeclaration;
  if (!declaration || !ts.isParameter(declaration) || !ts.isArrowFunction(declaration.parent)
    || declaration.parent.parameters[1] !== declaration || !ts.isBlock(declaration.parent.body)) return false;
  const symbol = checker.getSymbolAtLocation(argument);
  let mutated = false;
  const inspect = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(node.left) && checker.getSymbolAtLocation(node.left) === symbol) mutated = true;
    ts.forEachChild(node, inspect);
  };
  inspect(declaration.parent.body);
  return !mutated;
}
const FAIL_CLOSED = 'if(adapter.capabilities?.fencedLearningWrite!==true)returnPromise.reject(newError("CLI_LEARNING_WRITE_NOT_FENCED"));';
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

interface Scan { sinks: Pin[]; callers: CallerPin[]; problems: string[]; admitted?: Pin[] }
/** Cache complete per-file observations only when the pins and all checker inputs are byte-identical.
 * A transitive import or global declaration change invalidates every affected file; unrelated
 * modules are reusable when a planted bypass overrides one source file. */
interface FileObservation {
  sinks: Pin[]; callers: CallerPin[]; problems: string[]; admitted: Pin[];
  learner: boolean; declared: boolean; sendsDirect: boolean; runner?: boolean; failClosed?: boolean;
}
const observations = new Map<string, FileObservation>();
const sourceHashes = new WeakMap<ts.SourceFile, string>();
const sourceImports = new WeakMap<ts.SourceFile, ts.StringLiteralLike[]>();
const checkerObservationKeys = new WeakMap<ts.Program, Map<ts.SourceFile, string>>();
const writerContractObservations = new Map<string, string[]>();
const syntaxContractCounts = new Map<string, number>();
const syntaxTailContracts = new Map<string, boolean>();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
function sourceHash(sf: ts.SourceFile): string {
  let hash = sourceHashes.get(sf); if (!hash) { hash = sha(sf.text); sourceHashes.set(sf, hash); } return hash;
}
function observationKeys(prog: ts.Program, pins: Pins): Map<ts.SourceFile, string> {
  const checker = prog.getTypeChecker(), files = prog.getSourceFiles();
  const dependencies = new Map<ts.SourceFile, ts.SourceFile[]>();
  for (const sf of files) {
    let imports = sourceImports.get(sf);
    if (!imports) {
      imports = [];
      const collect = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports!.push(node.moduleSpecifier);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) imports!.push(node.argument.literal);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports!.push(node.arguments[0]);
        ts.forEachChild(node, collect);
      };
      collect(sf); sourceImports.set(sf, imports);
    }
    const imported: ts.SourceFile[] = [];
    for (const specifier of imports) {
      let symbol = checker.getSymbolAtLocation(specifier);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declaration of symbol?.declarations ?? []) imported.push(declaration.getSourceFile());
    }
    dependencies.set(sf, imported);
  }
  // Ambient/global declarations affect files without an explicit import edge.
  const globals = files.filter(sf => !ts.isExternalModule(sf) || /declare\s+(?:global|module\s+["'])/.test(sf.text));
  const common = sha(JSON.stringify(prog.getCompilerOptions()) + JSON.stringify(pins) + globals.map(sf => sf.fileName + ":" + sourceHash(sf)).sort().join("|"));
  const keys = new Map<ts.SourceFile, string>();
  for (const sf of files) {
    const rel = relFwd(sf.fileName);
    if (!rel.startsWith("server/") || isTest(rel)) continue;
    const seen = new Set<ts.SourceFile>(), pending = [sf];
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current); pending.push(...(dependencies.get(current) ?? []));
    }
    // Modules in one import cycle share a transitive closure, but never observations.
    keys.set(sf, sha(rel + "\0" + common + [...seen].map(dep => dep.fileName + ":" + sourceHash(dep)).sort().join("|")));
  }
  checkerObservationKeys.set(prog, keys);
  return keys;
}

function scan(prog: ts.Program, pins: Pins): Scan {
  const checker = prog.getTypeChecker();
  const cacheKeys = observationKeys(prog, pins);
  const sinks: Pin[] = [], callers: CallerPin[] = [], problems: string[] = [], admitted: Pin[] = [];
  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    let s = checker.getSymbolAtLocation(node);
    if (s && s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { /* unresolved alias */ } }
    return s;
  };
  const logicalOwners = new Map<ts.SourceFile, Map<string, string>>();
  for (const contract of pins.logicalOwners ?? []) {
    const sf = prog.getSourceFile(join(ROOT, contract.file));
    const helpers = sf ? declsNamed(sf, contract.helper) : [], owners = sf ? declsNamed(sf, contract.owner) : [];
    const helper = helpers.length === 1 ? helpers[0] : undefined, owner = owners.length === 1 ? owners[0] : undefined;
    const declaration = helper && (ts.isFunctionDeclaration(helper) ? helper : ts.isVariableDeclaration(helper.parent) ? helper.parent : undefined);
    const symbol = declaration?.name && resolve(declaration.name);
    const references: ts.Identifier[] = [];
    if (sf && symbol) {
      const collect = (node: ts.Node): void => { if (ts.isIdentifier(node) && node !== declaration?.name && (ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : resolve(node)) === symbol) references.push(node); ts.forEachChild(node, collect); };
      collect(sf);
    }
    const call = references.length === 1 && ts.isCallExpression(references[0].parent) && references[0].parent.expression === references[0] ? references[0].parent : undefined;
    if (!sf || !helper || !owner?.body || !call || call.getStart() < owner.body.getStart() || call.getEnd() > owner.body.getEnd()) {
      problems.push(`logical owner ${contract.owner} does not uniquely call ${contract.helper} without escaping (${contract.file})`);
      continue;
    }
    const map = logicalOwners.get(sf) ?? new Map<string, string>(); map.set(contract.helper, contract.owner); logicalOwners.set(sf, map);
  }
  const logicalFn = (node: ts.Node): string => { const physical = fnName(node); return logicalOwners.get(node.getSourceFile())?.get(physical) ?? physical; };
  const declFile = (s: ts.Symbol | undefined) => s?.declarations?.[0]?.getSourceFile().fileName ?? "";
  /** The sink a referenced symbol is, or "" (an identifier use counts too, so `const f = fetch` is caught). */
  const sinkOfSymbol = (s: ts.Symbol | undefined): string => {
    if (!s) return "";
    const name = s.getName(), file = declFile(s);
    if (name === "fetch" && file.includes("node_modules")) return "fetch";
    if (name === "request" && /undici/.test(file)) return "fetch";
    if (CHILD.has(name) && /@types\/node\/child_process/.test(file)) return "spawn";
    if (name === "spawnCli" && file.endsWith("/server/procs.ts")) return "spawn";
    // The metered adapters retain Node's filesystem signatures but declare
    // their own exported wrappers. Follow the resolved declaration to these
    // actual modules, including named, namespace and default-object imports.
    if (FS_WRITES.has(name) && (/@types\/node\/(fs|fs\/promises)\.d\.ts$/.test(file)
      || fwd(file) === fwd(join(ROOT, "server/counted-fs.ts"))
      || fwd(file) === fwd(join(ROOT, "server/counted-fs-promises.ts"))
      || fwd(file) === fwd(join(ROOT, "server/sentinel/io-meter.ts")))) return "fs-write";
    if (name === "appendNative" && file.includes("/server/")) return "native-log";
    return "";
  };
  const writableType = (t: ts.Type): boolean => t.isUnion() ? t.types.some(writableType) : !!(t.getProperty("write") && t.getProperty("writable") && t.getProperty("end"));
  const isGate = (t: ts.Type): boolean => t.isUnion() ? t.types.some(isGate) : GATE_KEYS.every(k => !!t.getProperty(k));
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
  const consumingDeclarations = [
    ["server/consuming-turn-response.ts", "emitConsumingTurnResponse"],
    ["server/drivers/engine-input.ts", "releaseNativeWire"],
    ["server/drivers/engine-input.ts", "releaseNativeAnswer"],
  ].map(([file, name]) => {
    const source = prog.getSourceFile(join(ROOT, file));
    const matches = source?.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  });
  const fenceDeclaration = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Node | undefined => {
    const declaration = resolve(expression)?.valueDeclaration;
    if (!declaration || seen.has(declaration)) return undefined;
    seen.add(declaration);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer))) return fenceDeclaration(declaration.initializer, seen);
    return declaration;
  };
  /** Consuming authority is attached only to the synchronous write argument, never the surrounding function. */
  const insideConsuming = (node: ts.Node): boolean => {
    let deferred: ts.Node | undefined;
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        const p = cur.parent;
        const call = ts.isCallExpression(p) ? p : ts.isPropertyAssignment(p) && p.name.getText() === "write" && ts.isObjectLiteralExpression(p.parent) && ts.isCallExpression(p.parent.parent) ? p.parent.parent : undefined;
        if (call) {
          const declaration = fenceDeclaration(call.expression);
          const consuming = !!declaration && declaration === consumingDeclarations[0] && call.arguments[2] === p.parent;
          const native = !!declaration && (declaration === consumingDeclarations[1] || declaration === consumingDeclarations[2]) && call.arguments[3] === cur;
          if (!consuming && !native && /^(emitConsumingTurnResponse|releaseNativeWire|releaseNativeAnswer)$/.test(call.expression.getText())) problems.push(`fence name shadowed at ${where(call)}`);
          if (consuming || native) {
            if (isAsyncFn(cur) || isGenerator(cur) || deferred) { problems.push(`deferred write inside a consuming fence at ${where(node)}`); return false; }
            return true;
          }
        }
      }
      if (!deferred && execBoundary(cur) && !runsInline(cur) && !isGateLaunchCallback(checker, cur)) deferred = cur;
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
    // A property typed as the global fetch keeps that call signature's declaration,
    // even when its property symbol belongs to an injected client object.
    if (!kind && name === "fetch" && checker.getTypeAtLocation(node).getCallSignatures().some(signature => {
      const declaration = signature.getDeclaration();
      return !!declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === "fetch"
        && fwd(declaration.getSourceFile().fileName).includes("/node_modules/");
    })) kind = "fetch";
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
    const walk = (body: ts.Node, label: string, absent = new Set<ts.Symbol>()) => {
      const absentCondition = (expression: ts.Expression): boolean | undefined => {
        const e = peel(expression);
        if (ts.isIdentifier(e) && absent.has(resolve(e)!)) return false;
        if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) { const inner = absentCondition(e.operand); return inner === undefined ? undefined : !inner; }
        return undefined;
      };
      const reachable = (node: ts.Node): boolean => {
        for (let current: ts.Node = node; current !== body && current.parent; current = current.parent) {
          const parent = current.parent;
          if (ts.isIfStatement(parent)) {
            const condition = absentCondition(parent.expression);
            if ((condition === false && current === parent.thenStatement) || (condition === true && current === parent.elseStatement)) return false;
          }
        }
        return true;
      };
      // A declaration is not a scheduled callback. Its body is visited at each real call,
      // provided that every reachable reference is a plain call. Escapes still fail closed.
      const calledLocally = (fn: ts.Node): boolean => {
        const declaration = ts.isFunctionDeclaration(fn) ? fn : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && (fn.parent.parent.flags & ts.NodeFlags.Const) !== 0 ? fn.parent : undefined;
        const name = declaration?.name;
        if (!name || !ts.isIdentifier(name)) return false;
        const symbol = resolve(name);
        if (!symbol) return false;
        let valid = true, invoked = false;
        const refs = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && node !== name && resolve(node) === symbol && reachable(node)) {
            if (ts.isCallExpression(node.parent) && node.parent.expression === node) invoked = true;
            else valid = false;
          }
          ts.forEachChild(node, refs);
        };
        refs(body);
        return valid && invoked;
      };
      const v = (n: ts.Node): void => {
        if (ts.isIfStatement(n)) {
          const condition = absentCondition(n.expression);
          if (condition !== undefined) { if (condition) v(n.thenStatement); else if (n.elseStatement) v(n.elseStatement); return; }
        }
        if (n !== body && fnLike(n) && !runsInline(n)) {
          if (calledLocally(n)) return;
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
            if (isAsyncFn(helper) || isGenerator(helper)) { if (reachesSink(helper.body, sf, local)) problems.push(`async helper ${name} with a write, called from the emit at ${where(n)}`); }
            else {
              const omitted = new Set(helper.parameters.filter((p, index) => index >= n.arguments.length && !p.initializer && ts.isIdentifier(p.name)).map(p => resolve(p.name)).filter((symbol): symbol is ts.Symbol => !!symbol));
              walk(helper.body, name, omitted);
            }
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
    const hit = sf ? callsIn(sf).filter(c => anchorOf(c).startsWith(squash(hop.from)))[hop.fromIndex ?? 0] : undefined;
    return hit ? logicalFn(hit) : "";
  };
  const onChain = (pin: { file: string; fn: string; anchor: string }, name: string): boolean => {
    const chain = pins.chains.find(c => c.name === name);
    return !!chain && chain.hops.some(h => h.file === pin.file && pin.anchor.startsWith(squash(h.to)) && (hopFn(h) === pin.fn || !!h.via?.includes(pin.fn)));
  };
  /** The call hands the engine a `prop` hook (`{ fencedWrite }`) bound to a function that runs its write inside a learning gate's send,
   *  and a linted chain's first hop writes inside that hook (its `from` is the hook's runner, FENCE_RUNNERS). */
  const fenced = (call: ts.CallExpression, prop: string): boolean => {
    let ok = false;
    const admits = (m: ts.Node): void => { if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression) && m.expression.name.text === "send" && isGate(checker.getTypeAtLocation(m.expression.expression))) ok = true; if (!ok) ts.forEachChild(m, admits); };
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
    const runner = FENCE_RUNNERS[prop];
    return ok && !!runner && pins.chains.some(c => c.hops.some(h => h.from.startsWith(runner)));
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
  // H1-SENDLOCK (design section 2): the adapters that learn, the ones that declare the fenced write, the ones that write inside a
  // gate.send directly, the fencedSubmit body and the fail-closed construction check
  const learners = new Set<string>(), declared = new Set<string>(), sendsDirect = new Set<string>();
  let fenceRunner = false, failClosed = false;
  for (const sf of prog.getSourceFiles()) {
    const rel = relFwd(sf.fileName);
    if (!rel.startsWith("server/") || isTest(rel)) continue;
    const cacheKey = cacheKeys.get(sf)!;
    const cached = observations.get(cacheKey);
    if (cached) {
      sinks.push(...cached.sinks); callers.push(...cached.callers); problems.push(...cached.problems); admitted.push(...cached.admitted);
      if (cached.learner) learners.add(rel);
      if (cached.declared) declared.add(rel);
      if (cached.sendsDirect) sendsDirect.add(rel);
      if (cached.runner !== undefined) fenceRunner = cached.runner;
      if (cached.failClosed !== undefined) failClosed = cached.failClosed;
      continue;
    }
    const initial = { sinks: sinks.length, callers: callers.length, problems: problems.length, admitted: admitted.length };
    const freshGate: string[] = [];
    const local = localSinkNames(sf);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = resolve(node.expression)?.valueDeclaration;
        if (target && ts.isFunctionDeclaration(target) && target.name?.text === "fencedSubmit" && relFwd(target.getSourceFile().fileName) === "server/drivers/engine-input.ts") {
          const pin = pins.validators?.find(pin => pin.file === rel && pin.fn === fnName(node) && pin.validated === true);
          const validator = node.arguments[3];
          if (!pin || !validator || !validatedFenceCall(node, rel, checker)) problems.push(`fencedSubmit validator dropped at ${where(node)}`);
        }
      }
      const identKind = identSink(node, local);
      if (identKind && !insideEmit(node) && !insideConsuming(node)) {
        const at = ts.isCallExpression(node.parent) ? node.parent : node;
        verifyPin("sink", push(sinks, { file: rel, fn: logicalFn(node), anchor: anchorOf(at), kind: identKind, reason: "not-learning" }, "s"), at);
      }
      const propKind = propSink(node);
      if (propKind && !insideEmit(node) && !insideConsuming(node)) verifyPin("sink", push(sinks, { file: rel, fn: logicalFn(node), anchor: anchorOf(node.parent), kind: propKind, reason: "not-learning" }, "s"), node.parent);
      if ((identKind || propKind) && insideConsuming(node)) admitted.push({ file: rel, fn: logicalFn(node), anchor: anchorOf(ts.isCallExpression(node.parent) ? node.parent : node), kind: identKind || propKind, reason: "learning-path", admittedBy: "fence:consuming" });
      if (ts.isCallExpression(node) && gateSendCall(node)) {
        const emit = node.arguments[0];
        if (emit && (ts.isArrowFunction(emit) || ts.isFunctionExpression(emit))) followHelpers(emit, sf, local);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const decl = resolve(node.expression)?.valueDeclaration;
        if (decl && pinnedCallerDecls.has(decl)) {
          const entry = push(callers, { file: rel, fn: logicalFn(node), anchor: anchorOf(node), callee: node.expression.text, reason: "not-learning" }, "c");
          verifyPin("caller", entry, node);
          // only a chain's own hop may carry the payload; every other caller of the shared send/writeTo/request must be clean of it
          const pin = pinCallers.get(keyOf(entry));
          if (pin?.reason !== "learning-path" && node.arguments.some(a => reachesPayload(a))) problems.push(`a gate payload reaches the ${pin?.reason ?? "unpinned"} ${entry.callee}( caller at ${where(node)}`);
        }
      }
      // H1-SENDLOCK: send is the gate's only release; a removed admission method called on any gate fails
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && REMOVED_GATE_METHODS.includes(node.expression.name.text) && isGate(checker.getTypeAtLocation(node.expression.expression))) problems.push(`removed gate method ${node.expression.name.text}( called on a learning gate at ${where(node)}`);
      if (rel === "server/memory/learning-send.ts" && ts.isInterfaceDeclaration(node) && node.name.text === "LearningGate") {
        for (const m of node.members) if (m.name && REMOVED_GATE_METHODS.includes(m.name.getText())) problems.push(`LearningGate declares the removed ${m.name.getText()} at ${where(m)}`);
        for (const k of GATE_KEYS) if (!node.members.some(m => m.name?.getText() === k)) problems.push(`LearningGate lost ${k}: the gate shape the scan keys on changed`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "withCliMemoryLearning") learners.add(rel);
      if (ts.isPropertyAssignment(node) && node.name.getText() === "fencedLearningWrite" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) declared.add(rel);
      if (ts.isCallExpression(node) && gateSendCall(node) && node.arguments[0] && fnLike(node.arguments[0]) && reachesSink(node.arguments[0], sf, local)) sendsDirect.add(rel);
      if (rel === "server/drivers/engine-input.ts" && ts.isFunctionDeclaration(node) && node.name?.text === "fencedSubmit") fenceRunner = checkFenceRunner(node, checker);
      if (rel === "server/drivers/cli-memory-learning.ts" && ts.isFunctionDeclaration(node) && node.name?.text === "withCliMemoryLearning") failClosed = squash(node.body?.getText() ?? "").includes(FAIL_CLOSED);
      // a nested send: a gate.send whose emit reaches another gate.send or admit, or any send/admit inside pinnedCall (r8 change 4)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["send", ...REMOVED_GATE_METHODS].includes(node.expression.name.text) && isGate(checker.getTypeAtLocation(node.expression.expression))) {
        if (insideEmit(node)) problems.push(`nested gate send at ${where(node)}`);
        if (fnName(node) === "pinnedCall" && rel === "server/memory/extractor-connections.ts") problems.push(`send inside pinnedCall at ${where(node)}`);
      }
      // the stop gate is recognised by type (isGateLaunchCallback), so only createStopGate may make one: outside stop-gate.ts no object
      // literal, type assertion or class may stand in for it (a value annotated StopGate whose launch defers would launder a deferred write)
      if (rel !== "server/drivers/stop-gate.ts") {
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
    if (rel !== "server/drivers/stop-gate.ts") problems.push(...freshGate);
    observations.set(cacheKey, {
      sinks: sinks.slice(initial.sinks), callers: callers.slice(initial.callers), problems: problems.slice(initial.problems), admitted: admitted.slice(initial.admitted),
      learner: learners.has(rel), declared: declared.has(rel), sendsDirect: sendsDirect.has(rel),
      ...(rel === "server/drivers/engine-input.ts" ? { runner: fenceRunner } : {}),
      ...(rel === "server/drivers/cli-memory-learning.ts" ? { failClosed } : {}),
    });
  }
  for (const pin of pins.validators ?? []) {
    const source = prog.getSourceFile(join(ROOT, pin.file));
    const matches = source ? callsInNode(source).filter(call => fnName(call) === pin.fn && fwd(resolve(call.expression)?.valueDeclaration?.getSourceFile().fileName ?? "") === fwd(join(ROOT, "server/drivers/engine-input.ts"))
      && resolve(call.expression)?.name === "fencedSubmit") : [];
    if (matches.length !== 1) problems.push(`fencedSubmit validator dropped: pinned site ${pin.file}:${pin.fn} matches ${matches.length}`);
  }
  if (!fenceRunner) problems.push(`fencedSubmit changed: its write must run inside turn.fencedWrite when the turn has one (engine-input.ts)`);
  if (!failClosed) problems.push(`withCliMemoryLearning lost its fail-closed fencedLearningWrite check (cli-memory-learning.ts)`);
  const chained = new Set(pins.chains.flatMap(c => c.hops).filter(h => h.from.startsWith(FENCE_RUNNERS.fencedWrite) || squash(h.to).startsWith(FENCE_RUNNERS.fencedWrite)).map(h => h.file));
  for (const file of learners) {
    if (file === "server/drivers/cli-memory-learning.ts") continue;
    if (!declared.has(file)) problems.push(`a withCliMemoryLearning adapter does not declare fencedLearningWrite: ${file}`);
    if (!chained.has(file) && !sendsDirect.has(file)) problems.push(`a withCliMemoryLearning adapter has no prompt write inside a gate's send (no fencedSubmit chain, no gate.send stdin write): ${file}`);
  }
  for (const file of declared) if (!learners.has(file)) problems.push(`fencedLearningWrite declared outside a withCliMemoryLearning adapter: ${file}`);
  return { sinks, callers, problems, admitted };
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
  if (hop.from && froms.length !== (hop.fromCount ?? 1)) return [`${hop.file}: the hook anchor ${hop.from} matches ${froms.length} calls (expected ${hop.fromCount ?? 1})`];
  const from = froms[hop.fromIndex ?? 0];
  const fn = from ? fnName(from) : hop.fn;
  if (hop.via?.length) return from ? lintViaHop(prog, sf, hop, from, fn, timers) : [`${hop.file}: a via hop needs its hook anchor`];
  // a fence hop (H1-SENDLOCK): the hook is fencedSubmit(turn, emit), the engine-input.ts helper, and the write must sit inside its emit
  const fence = !!from && squash(hop.from).startsWith(FENCE_RUNNERS.fencedWrite);
  const gateEmit = !!from && squash(hop.from).startsWith("gate.send(");
  let emit: ts.FunctionLikeDeclaration | undefined;
  let emitFile = sf;
  let portAdapter: ts.FunctionLikeDeclaration | undefined;
  // Transport-owner hops resolve their same-scope callback just like a
  // fencedSubmit emit. Only these two actual release parameters are admitted.
  if (hop.callback !== undefined && !gateEmit) {
    const expected = hop.file === "server/drivers/claude.ts" ? { owner: "cliStdinWrite", index: 0 }
      : hop.file === "server/drivers/acp/approval-delivery.ts" ? { owner: "writeAcpResponse", index: 1 } : undefined;
    const checker = prog.getTypeChecker();
    const parameter = from && ts.isIdentifier(from.expression) ? checker.getSymbolAtLocation(from.expression)?.valueDeclaration : undefined;
    if (!expected || !from || hop.callback !== expected.index || from.arguments.length !== 2
      || !parameter || !ts.isParameter(parameter) || parameter.name.getText() !== "release"
      || !ts.isFunctionDeclaration(parameter.parent) || parameter.parent.name?.text !== expected.owner
      || fn !== expected.owner || squash(from.getText()) !== squash(hop.from))
      return [`${hop.file} ${fn}: unreviewed writer callback hop`];
    const bounded = boundedCallback(prog, from, hop.callback);
    if (!bounded.fn) return [`${hop.file} ${fn}: ${bounded.problem}`];
    emit = bounded.fn;
  }
  if (fence) {
    const checker = prog.getTypeChecker();
    const callee = from.expression, decl = ts.isIdentifier(callee) ? (() => { let s = checker.getSymbolAtLocation(callee); if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s); return s?.valueDeclaration; })() : undefined;
    if (!decl || !relFwd(decl.getSourceFile().fileName).endsWith("server/drivers/engine-input.ts") || !(ts.isFunctionDeclaration(decl) && decl.name?.text === "fencedSubmit")) return [`${hop.file} ${fn}: the fence hook is not engine-input.ts fencedSubmit`];
    const arg = from.arguments[1];
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) emit = arg;
    else if (arg && ts.isIdentifier(arg)) {
      const binding = checker.getSymbolAtLocation(arg)?.valueDeclaration;
      if (binding?.getSourceFile() === sf) {
        if (!ts.isParameter(binding)) {
          const bounded = boundedCallback(prog, from, 1);
          if (!bounded.fn) return [`${hop.file} ${fn}: ${bounded.problem}`];
          emit = bounded.fn;
        }
        // ACP's release adapter forwards its unwrapped parameter through a typed transport port.
        // Prove both callers carry that very release symbol, and that the writer invokes the
        // transport's release parameter with the exact local write symbol.
        if (ts.isParameter(binding) && hop.emit) {
          const adapter = binding.parent;
          if (!(ts.isArrowFunction(adapter) || ts.isFunctionExpression(adapter))) return [`${hop.file} ${fn}: release port is not a function expression`];
          const declaration = adapter.parent && ts.isConditionalExpression(adapter.parent) ? adapter.parent.parent : undefined;
          const releaseSymbol = declaration && ts.isVariableDeclaration(declaration) ? checker.getSymbolAtLocation(declaration.name) : undefined;
          const target = prog.getSourceFile(join(ROOT, hop.emit.file));
          const writer = target && declsNamed(target, hop.emit.fn).find(d => ts.isFunctionDeclaration(d));
          const candidate = target && declsNamed(target, hop.emit.name).filter(d => fnName(d) === hop.emit!.fn);
          const releaseParameter = writer?.parameters.find(p => p.name.getText() === "release");
          const portSymbol = releaseParameter && checker.getSymbolAtLocation(releaseParameter.name);
          const writeSymbol = candidate?.length === 1 && ts.isVariableDeclaration(candidate[0].parent) ? checker.getSymbolAtLocation(candidate[0].parent.name) : undefined;
          const releases = writer?.body && callsInNode(writer.body).filter(c => ts.isIdentifier(c.expression) && checker.getSymbolAtLocation(c.expression) === portSymbol);
          const callerSites = releaseSymbol && calls.filter(c => c.arguments.some(a => ts.isIdentifier(a) && checker.getSymbolAtLocation(a) === releaseSymbol));
          const validPort = writer && releaseParameter && callerSites && callerSites.length >= 2 && releases && releases.length === 1 && releases[0].arguments[1] && checker.getSymbolAtLocation(releases[0].arguments[1]) === writeSymbol;
          const forwarder = declsNamed(sf, "writeTo");
          const forwarding = forwarder.length === 1 && forwarder[0].parameters.find(p => p.name.getText() === "release");
          const forwardedSymbol = forwarding && checker.getSymbolAtLocation(forwarding.name);
          const forwarded = forwarder.length === 1 && forwarder[0].body && callsInNode(forwarder[0].body).some(c => ts.isIdentifier(c.expression) && (() => { let symbol = checker.getSymbolAtLocation(c.expression); if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol); return symbol?.declarations?.some(d => d.getSourceFile() === target && ts.isFunctionDeclaration(d) && d.name?.text === hop.emit!.fn); })() && c.arguments.some(a => ts.isIdentifier(a) && checker.getSymbolAtLocation(a) === forwardedSymbol));
          // MAIN RULING INT-CONFLICT-DEFAULT de1ff54d75 446b419576: the newer direct return lives in a synchronous try that records refusal and rethrows.
          const directReturn = adapter.body === from || ts.isBlock(adapter.body) && (() => {
            const statements = adapter.body.statements;
            const attempt = statements.length === 1 && ts.isTryStatement(statements[0]) ? statements[0] : undefined;
            const returned = attempt?.tryBlock.statements;
            return !!attempt && !attempt.finallyBlock && returned?.length === 1 && ts.isReturnStatement(returned[0]) && returned[0].expression === from
              && !!attempt.catchClause && squash(attempt.catchClause.getText()) === squash("catch (error) { submissionRefused = true; throw error; }");
          })();
          if (validPort && forwarded && candidate?.length === 1 && !isAsyncFn(adapter) && directReturn) {
            const bounded = boundedCallback(prog, releases[0], 1);
            if (!bounded.fn) return [`${hop.file} ${fn}: ${bounded.problem}`];
            emit = bounded.fn; emitFile = target!; portAdapter = adapter;
          }
        }
      }
    }
    if (!emit?.body) return [`${hop.file} ${fn}: the fencedSubmit write is not a resolved same-file function or proven transport port`];
    if (isAsyncFn(emit) || isGenerator(emit)) return [`${hop.file} ${fn}: async emit in fencedSubmit`];
  }
  if (gateEmit) {
    const checker = prog.getTypeChecker(), expression = from.expression;
    const arg = from.arguments[0];
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "send" || !GATE_KEYS.every(k => !!checker.getNonNullableType(checker.getTypeAtLocation(expression.expression)).getProperty(k)) || !arg || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) || isAsyncFn(arg)) return [`${hop.file} ${fn}: gate.send is not a synchronous learning emit`];
    emit = arg;
  }
  const to = callsInNode(emitFile).find(c => (emit ? c.getStart() >= emit.body!.getStart() && c.getEnd() <= emit.getEnd() : fnName(c) === fn) && anchorOf(c).startsWith(squash(hop.to)) && (!from || emit || c.getStart() > from.getEnd()));
  if (!to && squash(hop.to).startsWith("fencedSubmit(turn,"))
    return [`${hop.file}: the hook anchor fencedSubmit(turn, matches 0 calls`];
  if (!to) return [`${hop.file} ${fn}: write anchor moved (${hop.from || "start"} -> ${hop.to})${emit ? ": the write is not inside fencedSubmit's emit" : ""}`];
  let fnNode: ts.Node | undefined = to.parent;
  while (fnNode && !((ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode) || ts.isFunctionDeclaration(fnNode) || ts.isMethodDeclaration(fnNode)) && (emit ? fnNode === emit : nameOfFn(fnNode) === fn))) fnNode = fnNode.parent;
  if (!fnNode || !(fnNode as ts.FunctionLikeDeclaration).body) return [`${hop.file} ${fn}: enclosing function not found`];
  const out: string[] = [];
  if (!from && hop.file === "server/drivers/claude.ts" && hop.fn === "write") {
    const releases = calls.filter(c => ts.isIdentifier(c.expression) && c.expression.text === "release" && c.arguments[0] && ts.isIdentifier(c.arguments[0]) && c.arguments[0].text === "write" && fnName(c) === "cliStdinWrite");
    if (releases.length !== 1) out.push(`${hop.file} ${fn}: writer callback escapes its bounded dispatcher`);
    else { const bounded = boundedCallback(prog, releases[0], 0); if (!bounded.fn) out.push(`${hop.file} ${fn}: ${bounded.problem}`); }
  }
  if (!from && (isAsyncFn(fnNode) || isGenerator(fnNode))) out.push(`${hop.file} ${fn}: chain function is async or a generator`);
  // the write may sit only in a synchronous Promise executor below the innermost function that holds the hook (or below the function)
  const fnLike = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
  let hookFn: ts.Node = fnNode;
  if (emit) hookFn = emit;
  else if (from) for (let cur: ts.Node = from.parent; cur && cur !== fnNode; cur = cur.parent) if (fnLike(cur)) { hookFn = cur; break; }
  if (!(to.getStart() >= hookFn.getStart() && to.getEnd() <= hookFn.getEnd())) out.push(`${hop.file} ${fn}: the write is outside the hook's function`);
  if (emit && from) {
    let originalFn: ts.Node | undefined = from.parent;
    while (originalFn && !(fnLike(originalFn) && nameOfFn(originalFn) === fn)) originalFn = originalFn.parent;
    if (originalFn) deferredBetween(prog, from, portAdapter ?? originalFn, hop.file, fn, out);
  }
  deferredBetween(prog, to, to.getStart() >= hookFn.getStart() && to.getEnd() <= hookFn.getEnd() ? hookFn : fnNode, hop.file, fn, out);
  lintRange(prog, hop, fn, fnNode, emit ? emit.body!.getStart() : from ? from.getEnd() : (fnNode as ts.FunctionLikeDeclaration).body!.getStart(), to, timers, out);
  return out;
}

/** A dispatcher exception belongs to the exact fallback branch of the owner
 * being checked. Matching a callee and argument position alone would let the
 * same callback escape after COMMIT or run again for a learning input frame.
 * lintWriterContracts separately pins these complete routing statements. */
function reviewedWriterFallback(ownerCall: ts.CallExpression, dispatcher: ts.CallExpression): boolean {
  const statement = dispatcher.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== dispatcher) return false;
  const ownerStatement = ownerCall.parent;
  if (!ts.isExpressionStatement(ownerStatement)) return false;
  const file = relFwd(ownerCall.getSourceFile().fileName);
  if (file === "server/drivers/codex.ts" && fnName(ownerCall) === "send") {
    const block = ownerStatement.parent, attempt = block.parent, branch = attempt.parent;
    return ts.isBlock(block) && ts.isTryStatement(attempt) && attempt.tryBlock === block
      && ts.isIfStatement(branch) && branch.thenStatement === attempt && branch.expression.getText() === "input"
      && branch.elseStatement === statement;
  }
  if (file === "server/drivers/acp/approval-delivery.ts" && fnName(ownerCall) === "writeAcpResponse") {
    const branch = ownerStatement.parent;
    if (!ts.isIfStatement(branch) || branch.thenStatement !== ownerStatement || branch.expression.getText() !== "release") return false;
    const fallback = branch.elseStatement;
    return !!fallback && ts.isIfStatement(fallback) && fallback.expression.getText() === "beforeWrite"
      && (fallback.thenStatement === statement || fallback.elseStatement === statement);
  }
  return false;
}

/** Resolve only a same-scope const callback. Every reference must be a direct
 * call or one of the reviewed synchronous dispatcher arguments. No alias,
 * reassignment, escaping shorthand, mutable callback or imported function is
 * accepted. The dispatchers themselves are checked by lintWriterContracts. */
function boundedCallback(prog: ts.Program, call: ts.CallExpression, index: number): { fn?: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration; problem?: string } {
  const arg = call.arguments[index];
  if (!arg) return { problem: "missing writer callback" };
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return { fn: arg };
  if (!ts.isIdentifier(arg)) return { problem: "writer callback is not an inline function or a bounded const" };
  const checker = prog.getTypeChecker(), symbol = checker.getSymbolAtLocation(arg), decl = symbol?.valueDeclaration;
  const declaredFunction = decl && ts.isFunctionDeclaration(decl) && decl.body && decl.getSourceFile() === call.getSourceFile() ? decl : undefined;
  const initializer = decl && ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const) && decl.initializer
    && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) && decl.getSourceFile() === call.getSourceFile() ? decl.initializer : undefined;
  if (!decl || (!declaredFunction && !initializer)) return { problem: "writer callback is not a same-file const function" };
  const scope = (n: ts.Node): ts.Node | undefined => { for (let p = n.parent; p; p = p.parent) if (fnLike(p)) return p; return undefined; };
  if (initializer && scope(decl) !== scope(call)) return { problem: "writer callback crosses a function boundary" };
  const declarationName = declaredFunction?.name ?? (ts.isVariableDeclaration(decl) ? decl.name : undefined);
  let problem: string | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n !== declarationName
      && (ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n)) === symbol) {
      const parent = n.parent;
      if (ts.isCallExpression(parent)) {
        if (parent.expression === n && scope(parent) === scope(call)
          && relFwd(call.getSourceFile().fileName) === "server/drivers/claude.ts" && fnName(parent) === "cliStdinWrite"
          && ts.isIfStatement(parent.parent.parent) && parent.parent.parent.elseStatement === parent.parent) { /* checked release fallback only */ }
        else if (parent === call && parent.arguments[index] === n) { /* this checked owner */ }
        else if (ts.isIdentifier(parent.expression)) {
          let target = checker.getSymbolAtLocation(parent.expression);
          if (target && target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
          const file = target?.valueDeclaration?.getSourceFile().fileName ?? "";
          const name = parent.expression.text;
          const position = name === "releaseNativeAnswer" ? 3 : name === "emitEngineWire" ? 2 : -1;
          const module = name === "releaseNativeAnswer" ? "engine-input" : "engine-wire";
          if (!(position >= 0 && parent.arguments[position] === n && fwd(file).endsWith(`/server/drivers/${module}.ts`)
            && scope(parent) === scope(call) && reviewedWriterFallback(call, parent))) problem = "writer callback escapes its bounded dispatcher";
        } else problem = "writer callback escapes its bounded dispatcher";
      } else problem = "writer callback is referenced other than by a bounded call";
    }
    ts.forEachChild(n, visit);
  };
  visit(call.getSourceFile());
  return problem ? { problem } : { fn: declaredFunction ?? initializer };
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
  const p = functionBinding(node);
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
  // the gate's send as its fencedWrite hook (GrokBuild r1, H1-SENDLOCK), so it can never be pinned under another reason
  for (const e of [...found.sinks, ...pins.sinks]) if (e.file === "server/drivers/cli-memory-learning.ts" && e.kind === "sendTurn" && pins.sinks.find(p => keyOf(p) === keyOf(e))?.admittedBy !== "fence:fencedWrite") out.push(`a learning sendTurn without the fencedWrite fence: ${keyOf(e)}`);
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
function lintChains(prog: ts.Program, pins: Pins): string[] {
  return [...lintWriterContracts(prog), ...pins.chains.flatMap(chain => {
    // Repeated hooks need an exact count and one hop for every occurrence. A new,
    // deleted or duplicated hook cannot silently select another submission path.
    const groups = new Map<string, Hop[]>();
    for (const hop of chain.hops) if (hop.from) {
      const key = `${hop.file}|${squash(hop.from)}`;
      groups.set(key, [...(groups.get(key) ?? []), hop]);
    }
    const coverage: string[] = [];
    for (const [key, hops] of groups) {
      const count = hops[0].fromCount ?? 1;
      const indices = hops.map(h => h.fromIndex ?? 0).sort((a, b) => a - b);
      if (!Number.isInteger(count) || count < 1 || hops.length !== count
        || hops.some(h => (h.fromCount ?? 1) !== count)
        || indices.some((index, i) => index !== i)) coverage.push(`${chain.name}: incomplete hook coverage for ${key}`);
    }
    return [...coverage, ...chain.hops.flatMap(hop => lintHop(prog, hop, pins.timers).map(p => `${chain.name}: ${p}`))];
  })];
}

/** Small, reviewed callback plumbing contracts, independent of the inventory.
 * These are syntax nodes, not substrings: moving a check out of its owner or
 * keeping its spelling in a comment cannot satisfy a contract. The payload
 * path below each dispatcher is still walked by lintHop. */
function lintWriterContracts(prog: ts.Program): string[] {
  const checked = checkerObservationKeys.get(prog);
  const files = ["server/drivers/stop-gate.ts", "server/drivers/acp/core.ts", "server/drivers/acp/approval-delivery.ts", "server/drivers/codex.ts", "server/drivers/claude.ts", "server/drivers/pi.ts", "server/drivers/antigravity.ts", "server/drivers/cli-memory-learning.ts", "server/drivers/engine-input.ts"];
  const cacheKey = checked && sha(files.map(file => { const sf = prog.getSourceFile(join(ROOT, file)); return sf ? checked.get(sf) ?? sourceHash(sf) : "missing:" + file; }).join("|"));
  const cached = cacheKey && writerContractObservations.get(cacheKey);
  if (cached) return cached;
  const out: string[] = [];
  const tokens = (text: string): string => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
    const parts: string[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) parts.push(`${kind}:${scanner.getTokenText()}`);
    return JSON.stringify(parts);
  };
  const requireNode = (file: string, label: string, syntax: string, owner?: string) => {
    const sf = prog.getSourceFile(join(ROOT, file));
    const compact = squash(syntax), exactTokens = tokens(syntax);
    const key = sf && sourceHash(sf) + "|" + (owner ?? "") + "|" + exactTokens;
    let count = key ? syntaxContractCounts.get(key) : undefined;
    if (count === undefined) {
      count = 0;
      const visit = (n: ts.Node) => { if ((!owner || fnName(n) === owner) && squash(n.getText()) === compact && tokens(n.getText()) === exactTokens) count = (count ?? 0) + 1; ts.forEachChild(n, visit); };
      if (sf) visit(sf);
      if (key) syntaxContractCounts.set(key, count);
    }
    if (count !== 1) out.push(`${file}: ${label} contract changed (expected one syntax node, got ${count})`);
  };
  // Type provenance alone cannot establish same-tick execution: prove the
  // shipped StopGate.launch still calls its callback directly on both paths.
  const stopFile = prog.getSourceFile(join(ROOT, "server/drivers/stop-gate.ts"));
  const launches = stopFile ? declsNamed(stopFile, "launch") : [];
  const launch = launches[0];
  const checker = prog.getTypeChecker();
  let direct = 0, escaped = false;
  if (launch?.body) {
    const callback = checker.getSymbolAtLocation(launch.parameters[1].name);
    const visit = (n: ts.Node) => {
      if (ts.isAwaitExpression(n)) escaped = true;
      if (ts.isIdentifier(n) && n !== launch.parameters[1].name && checker.getSymbolAtLocation(n) === callback) {
        if (!ts.isCallExpression(n.parent) || n.parent.expression !== n) escaped = true;
        else { direct++; const deferred: string[] = []; deferredBetween(prog, n.parent, launch, "server/drivers/stop-gate.ts", "launch", deferred); if (deferred.length) escaped = true; }
      }
      ts.forEachChild(n, visit);
    };
    visit(launch.body);
  }
  if (launches.length !== 1 || !launch || isAsyncFn(launch) || isGenerator(launch) || direct !== 2 || escaped) out.push("server/drivers/stop-gate.ts: actual StopGate.launch is not a synchronous bounded callback");
  requireNode("server/drivers/stop-gate.ts", "StopGate stops before launch", `if (w || e.done) throw new GateStopped(w);`, "launch");
  requireNode("server/drivers/acp/core.ts", "ACP prompt frame classification", `promptFrame = (obj as { method?: string }).method === "session/prompt"`, "send");
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d 446b419576e: exact synchronous Stop/fence owner plus refusal bookkeeping; every bypass mutant stays.
  requireNode("server/drivers/acp/core.ts", "ACP fenced release and inside-owner Stop", `release = promptFrame ? <T>(wire: string, write: () => T): T => {
    try {
      return fencedSubmit(turn, write, wire, () => {
        if (turnHalted()) throw new Error("ACP_TURN_STOPPED");
        fenceBeforeWrite(fence, state, obj, settleHalted);
      });
    } catch (error) { submissionRefused = true; throw error; }
  } : undefined`, "send");
  // Both the pooled and unpooled transport must receive the same release.
  requireNode("server/drivers/acp/core.ts", "ACP pooled release forwarding", `writeTo(threadId, proc, obj, done, requestUrl, turn.releaseBinding, beforeWrite, release)`, "send");
  const requireTail = (file: string, fn: string, callee: string, tail: string) => {
    const sf = prog.getSourceFile(join(ROOT, file));
    const key = sf && sourceHash(sf) + "|" + fn + "|" + callee + "|" + squash(tail);
    let valid = key ? syntaxTailContracts.get(key) : undefined;
    if (valid === undefined) {
      const calls = sf ? callsInNode(sf).filter(c => fnName(c) === fn && c.expression.getText() === callee) : [];
      valid = calls.length === 1 && squash(calls[0].getText()).endsWith(squash(tail));
      if (key) syntaxTailContracts.set(key, valid);
    }
    if (!valid) out.push(`${file}: ${fn} ${callee} release forwarding contract changed`);
  };
  requireTail("server/drivers/acp/core.ts", "send", "writeAcpResponse", ", requestUrl, turn.releaseBinding ?? null, beforeWrite, release)");
  requireTail("server/drivers/acp/core.ts", "writeTo", "writeAcpResponse", ", requestUrl, binding ?? null, beforeWrite, release)");
  requireNode("server/drivers/acp/approval-delivery.ts", "ACP synchronous release", `if (release) release(wire, write); else if (beforeWrite) emitEngineWire(beforeWrite, wire, write); else releaseNativeAnswer(binding, "acp:approval", wire, write);`, "writeAcpResponse");
  requireNode("server/drivers/codex.ts", "Codex input frame classification", `input = method === "turn/start" || method === "review/start" || method === "thread/compact/start"`, "send");
  requireNode("server/drivers/codex.ts", "Codex inside-owner Stop", `if (input) try { fencedSubmit(turn, write, wire, () => {
    const why = gate.why(entry);
    if (why || entry.done || stopRequested) throw new GateStopped(why);
  }); } catch (error) { completed(false); promptSubmissionRefused = !promptWriteEntered; throw error; }
  else releaseNativeAnswer(nativeBinding, "codex:protocol", wire, write);`, "send");
  requireNode("server/drivers/antigravity.ts", "Antigravity inside-owner Stop validator", `() => {
    if (gate.why(entry) || entry.done || stopRequested) throw new GateStopped(gate.why(entry));
  }`, "writePrompt");
  requireNode("server/drivers/pi.ts", "Pi inside-owner Stop validator", `() => {
    if (stopGate.why(e) || e.done) throw new Error("PI_TURN_STOPPED");
  }`, "send");
  requireNode("server/drivers/claude.ts", "Claude validator provenance", `release: StdinFrame["release"] = (write, validate) => {
    const emit = () => { boundary?.markInFlight(); if (boundary) partialWrites.add(boundary); return write(); };
    return input ? fencedSubmit(input, emit, wire, validate) : emitEngineWire(beforeWrite, wire, emit, validate);
  }`, "writeUser");
  requireNode("server/drivers/claude.ts", "Claude live Stop and writable validator", `validate = () => {
    if (release && "turn" in s && (s.closing || !s.turn || s.turn.stopRequested || s.turn.settled)) throw new GateStopped("asked");
    if (!s.child.stdin.writable || s.child.stdin.destroyed) throw new Error("Claude stdin is not writable");
  }`, "cliStdinWrite");
  requireNode("server/drivers/claude.ts", "held S2 frames route before release", `if (route === "held") return;`, "cliStdinWrite");
  requireNode("server/drivers/claude.ts", "held S2 frames reacquire release", `if (release) release(write, validate); else write();`, "cliStdinWrite");
  requireNode("server/drivers/claude.ts", "stdin revalidates inside the owner", `write = () => { validate(); return registerBusyloopRequestSite(fluxRouteFor(s.requestUrl), s.child.stdin.write(wire, done)); }`, "cliStdinWrite");
  requireNode("server/drivers/claude.ts", "S2 flush retains captured release", `gate.forward(frame, () => cliStdinWrite(kept, frame.wire, frame.done, frame.release))`);
  const claudeSource = prog.getSourceFile(join(ROOT, "server/drivers/claude.ts"));
  if (claudeSource) {
    const symbols = new Set<ts.Symbol>();
    const inspect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === "validate" && fnName(node) === "cliStdinWrite") {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) symbols.add(symbol);
        if (!ts.isVariableDeclarationList(node.parent) || !(node.parent.flags & ts.NodeFlags.Const)) out.push("server/drivers/claude.ts: mutable forwarded validator");
      }
      ts.forEachChild(node, inspect);
    };
    inspect(claudeSource);
    const assignments = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ts.isIdentifier(node.left) && symbols.has(checker.getSymbolAtLocation(node.left)!)) out.push("server/drivers/claude.ts: forwarded validator reassigned");
      ts.forEachChild(node, assignments);
    };
    assignments(claudeSource);
  }
  const claude = prog.getSourceFile(join(ROOT, "server/drivers/claude.ts"));
  const routed = claude ? callsInNode(claude).filter(c => fnName(c) === "cliStdinWrite" && c.expression.getText() === "gate.route") : [];
  const released = claude ? callsInNode(claude).filter(c => fnName(c) === "cliStdinWrite" && c.expression.getText() === "release") : [];
  if (routed.length !== 1 || released.length !== 1 || routed[0].getStart() >= released[0].getStart()) out.push("server/drivers/claude.ts: S2 routing precedes every authorization contract changed");
  requireNode("server/drivers/cli-memory-learning.ts", "learning callback hands writer and validator to the owner", `fencedWrite = gate ? <R>(write: () => R, validate?: (context: ReleaseContext) => void): R => {
    try { return gate.send(write, validate); }
    catch (error) { state.fenced = error instanceof Error ? error : new MemorySendFenced(); finish(); throw error; }
  } : undefined`, "hiddenTurnRunner");
  requireNode("server/drivers/engine-input.ts", "owner validation, binding and generation", `validate = (context: ReleaseContext) => {
    assertReleaseContext(context, db);
    activeContext = context;
    let result: unknown;
    try { result = extra?.(context); }
    catch (error) { ownerFailure = true; throw error; }
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("ASYNC_RELEASE_TRANSACTION");
    if (binding) assertConsumingBinding(binding);
    checkEngineInput(fence, prompt, bytes);
  }`, "engineWriter");
  requireNode("server/drivers/engine-input.ts", "final write binding and generation", `emit = () => {
    if (!activeContext) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
    assertReleaseContext(activeContext, db);
    if (binding) assertConsumingBinding(binding);
    checkEngineInput(fence, prompt, bytes);
    reserveRelease(budgets, { attempts: 1, bytes: bytes!, work: 1 });
    entered = true;
    return write();
  }`, "engineWriter");
  if (cacheKey) writerContractObservations.set(cacheKey, out);
  return out;
}

let base: ts.Program, pins: Pins, found: Scan, control: string[];
const mutationEvidence: object[] = [];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const planted = (extra: Record<string, string>) => {
  expect(control, "every mutant requires a green, unchanged control").toEqual([]);
  const prog = program(extra, base);
  // A known fence violation already rejects this mutant. Check the actual
  // overlaid declaration with the same checker predicate before invalidating
  // every importing file's observations. Valid fences still take the complete
  // inventory and chain path below; the unchanged control always takes it too.
  const input = Object.prototype.hasOwnProperty.call(extra, "server/drivers/engine-input.ts")
    ? prog.getSourceFile(join(ROOT, "server/drivers/engine-input.ts")) : undefined;
  const fence = input?.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "fencedSubmit");
  const problems = fence && !checkFenceRunner(fence, prog.getTypeChecker())
    ? ["fencedSubmit changed: its write must run inside turn.fencedWrite when the turn has one (engine-input.ts)"]
    : [...diff(scan(prog, pins), pins), ...lintChains(prog, pins)];
  mutationEvidence.push({ test: expect.getState().currentTestName, controlProblems: control.length,
    files: Object.entries(extra).map(([file, text]) => ({ file, sha256: digest(text) })), problems });
  return problems;
};
/** A dead or ambiguous source anchor is a failed mutation, never evidence. */
function mutate(text: string, search: string | RegExp, replacement: string | ((...args: any[]) => string), within?: string): string {
  let start = 0, end = text.length;
  if (within) {
    const sf = ts.createSourceFile("mutation.ts", text, ts.ScriptTarget.Latest, true);
    const functions = declsNamed(sf, within);
    expect(functions.length, `mutation must select exactly one function: ${within}`).toBe(1);
    start = functions[0].getStart(); end = functions[0].getEnd();
  }
  const target = text.slice(start, end);
  const count = typeof search === "string" ? target.split(search).length - 1 : [...target.matchAll(new RegExp(search.source, search.flags.includes("g") ? search.flags : search.flags + "g"))].length;
  expect(count, `mutation anchor must match exactly once: ${search}`).toBe(1);
  const changed = text.slice(0, start) + target.replace(search as any, replacement as any) + text.slice(end);
  expect(changed, "mutation must change the intended source").not.toBe(text);
  mutationEvidence.push({ test: expect.getState().currentTestName, anchor: String(search), within, matches: count,
    originalSha256: digest(text), changedSha256: digest(changed) });
  return changed;
}
afterAll(() => {
  if (process.env.LEARNING_MUTANTS_REPORT) writeFileSync(process.env.LEARNING_MUTANTS_REPORT, JSON.stringify({ control, mutations: mutationEvidence }, null, 2));
});

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
    if (process.env.LEARNING_SINKS_REPORT) writeFileSync(process.env.LEARNING_SINKS_REPORT, JSON.stringify({ found, diff: diff(found, pins), chains: lintChains(base, pins) }, null, 2));
    if (process.env.LEARNING_SINKS_WRITE === "1") {
      const keep = new Map(pins.sinks.map(e => [keyOf(e), e]));
      const keepCallers = new Map(pins.callers.map(e => [keyOf(e), e]));
      pins = { ...pins, sinks: found.sinks.map(e => keep.get(keyOf(e)) ?? (e.kind === "native-log" ? { ...e, reason: "log-excluded" as const } : e)), callers: found.callers.map(e => keepCallers.get(keyOf(e)) ?? e) };
      writeFileSync(PINS_FILE, JSON.stringify(pins, null, 1) + "\n");
    }
    control = [...diff(found, pins), ...lintChains(base, pins)];
  }, 600_000);

  it("every sink in server/ is inside a gate's send or pinned at its call site, and nothing else is wrong", () => {
    expect(diff(found, pins)).toEqual([]);
  });
  it("every hook-to-write chain is synchronous for its payload", () => {
    expect(lintChains(base, pins)).toEqual([]);
  });
  it("H1 keeps the shipped gate.send callback separate from transport release parameters", () => {
    const hops = pins.chains.flatMap(chain => chain.hops);
    const gate = hops.find(hop => hop.file === "server/drivers/claude.ts" && squash(hop.from).startsWith("gate.send("));
    expect(gate?.callback).toBe(0);
    expect(lintHop(base, gate!, pins.timers ?? [])).toEqual([]);
    // Callback metadata on an ordinary call still cannot bypass owner checks.
    const release = hops.find(hop => hop.file === "server/drivers/acp/approval-delivery.ts" && hop.callback === 1)!;
    expect(release).toBeTruthy();
    expect(lintHop(base, { ...release, callback: 0 }, pins.timers ?? []).join("\n")).toMatch(/unreviewed writer callback hop/);
  });
  it("checks every explicitly indexed repeated submission hook and rejects incomplete coverage", () => {
    const file = "server/memory/__indexed_hooks__.ts";
    const text = `declare function send(payload: string): void;
export function first(payload: string, beforeSubmit: () => void) { beforeSubmit(); send(payload); }
export function second(payload: string, beforeSubmit: () => void) { beforeSubmit(); send(payload); }
`;
    const hops = [0, 1].map(fromIndex => ({ file, fn: "", from: "beforeSubmit()", to: "send(payload)", payload: ["payload"], fromIndex, fromCount: 2 }));
    const inventory = { ...pins, chains: [{ name: "indexed", admittedBy: "fixture", hops }] };
    const prog = program({ [file]: text }, base);
    expect(lintChains(prog, inventory)).toEqual([]);
    for (const fn of ["first", "second"]) {
      const changed = mutate(text, `function ${fn}(payload: string, beforeSubmit: () => void) { beforeSubmit();`, `async function ${fn}(payload: string, beforeSubmit: () => void) { beforeSubmit(); await Promise.resolve();`);
      expect(changed).not.toBe(text);
      expect(lintChains(program({ [file]: changed }, base), inventory).join("\n")).toMatch(/await on the hook chain/);
    }
    expect(lintChains(prog, { ...inventory, chains: [{ ...inventory.chains[0], hops: hops.slice(0, 1) }] }).join("\n")).toMatch(/hook coverage/);
    expect(lintChains(prog, { ...inventory, chains: [{ ...inventory.chains[0], hops: [hops[0], hops[0]] }] }).join("\n")).toMatch(/hook coverage/);
    const extra = text + "export function third(payload: string, beforeSubmit: () => void) { beforeSubmit(); send(payload); }\n";
    expect(lintChains(program({ [file]: extra }, base), inventory).join("\n")).toMatch(/matches 3 calls/);
  }, 600_000);

  it("HTTP learning transports have no exemption: their fetch is inside the gate's send", () => {
    expect(pins.sinks.filter(e => (e.kind === "fetch" || e.kind === "alias-call") && (e.file === "server/drivers/http-text-only.ts" || e.file === "server/memory/extract.ts"))).toEqual([]);
  });

  describe("scanner redesign regressions", () => {
    it("counted filesystem wrappers retain sink recognition through their resolved exports", () => {
      const file = "server/memory/__counted_fs_sinks__.ts";
      const source = `import fs, { writeFileSync as writeNamed, promises } from "../counted-fs.ts";
import * as asyncFs from "../counted-fs-promises.ts";
export async function persist() {
  writeNamed("fixture", "a");
  fs.writeFileSync("fixture", "b");
  await asyncFs.writeFile("fixture", "c");
  await promises.appendFile("fixture", "d");
}`;
      const observed = scan(program({ [file]: source }, base), pins);
      expect(observed.sinks.filter(sink => sink.file === file).map(sink => sink.kind)).toEqual(["fs-write", "fs-write", "fs-write", "fs-write"]);
    }, 600_000);
    it("H-FENCE-5 forwards the exact validator and serialized byte count", () => {
      const file = "server/drivers/engine-input.ts", text = read(file);
      for (const replacement of ["write, undefined,", "write, () => {},", "write, validate, 0 /*", "write, validate, serialized.length /*"]) {
        const bad = plant(file, call("fencedWrite", { in: "fencedSubmit" }), (_node, source) => replacement.endsWith("/*")
          ? source.replace(/write, validate, [\s\S]*\)$/, replacement.slice(0, -3) + ")")
          : source.replace("write, validate,", replacement), text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/fencedSubmit changed/);
      }
    }, 600_000);
    it("H-FENCE-6 fallback validation is synchronous, before write, and cannot swallow failure", () => {
      const file = "server/drivers/engine-input.ts", text = read(file);
      for (const replacement of ["", "try { validate?.(); } catch {}", "queueMicrotask(() => validate?.());"]) {
        const bad = plant(file, stmt(/^validate\?\.\(\);$/, { in: "fencedSubmit" }), replacement, text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/fencedSubmit changed/);
      }
      const late = plant(file, stmt(/^validate\?\.\(\);$/, { in: "fencedSubmit" }), "", text).replace("return write();\n}", "return write(); validate?.();\n}");
      expect(planted({ [file]: late }).join("\n")).toMatch(/fencedSubmit changed/);
    }, 600_000);
    it("H-FENCE-7 every adapter retains its live validator", () => {
      for (const file of ["server/drivers/codex.ts", "server/drivers/acp/core.ts", "server/drivers/claude.ts", "server/drivers/pi.ts"]) {
        const bad = plant(file, call("fencedSubmit"), (node) => {
          const c = node as ts.CallExpression;
          return c.expression.getText() + "(" + c.arguments.slice(0, 3).map(a => a.getText()).join(", ") + ")";
        }, read(file));
        expect(planted({ [file]: bad }).join("\n")).toMatch(/fencedSubmit validator dropped/);
      }
    }, 600_000);
    it("H-FENCE-HIGH validator reassignment and dead throws cannot authorize a write", () => {
      const file = "server/drivers/engine-input.ts", text = read(file);
      const rebound = plant(file, stmt(/^if \(turn\.fencedWrite\)/, { in: "fencedSubmit" }), { kind: "before", text: "validate = () => {};" }, text);
      expect(planted({ [file]: rebound }).join("\n")).toMatch(/fencedSubmit changed/);
      const pi = "server/drivers/pi.ts";
      const dead = plant(pi, call("fencedSubmit"), node => {
        const c = node as ts.CallExpression;
        return c.expression.getText() + "(" + c.arguments.slice(0, 3).map(a => a.getText()).join(", ") + ", () => { if (false) throw Error(); })";
      }, read(pi));
      expect(planted({ [pi]: dead }).join("\n")).toMatch(/validator|inside-owner Stop/);
    }, 600_000);
    it("H-FENCE-HIGH provenance rejects a decoy validator and a rebound Claude guard", () => {
      const file = "server/drivers/pi.ts", text = read(file);
      const decoy = plant(file, call("fencedSubmit"), node => {
        const call = node as ts.CallExpression;
        return `(() => { const decoy = ${call.arguments[3].getText()}; void decoy; return fencedSubmit(${call.arguments.slice(0, 3).map(arg => arg.getText()).join(", ")}, () => { if (false) throw Error(); }); })()`;
      }, text);
      expect(planted({ [file]: decoy }).join("\n")).toMatch(/validator/);
      const claude = "server/drivers/claude.ts";
      const rebound = mutate(read(claude), "const validate = () => {", "let validate = () => {", "cliStdinWrite")
        .replace("    validate();\n    const write =", "    validate = () => {};\n    validate();\n    const write =");
      expect(planted({ [claude]: rebound }).join("\n")).toMatch(/validator/);
    }, 600_000);
    it("H-FENCE-8 shadowed consuming names are refused and real aliases retain identity", () => {
      const file = "server/memory/__identity_fence__.ts";
      const shadow = `import type { Writable } from "node:stream";
function emitConsumingTurnResponse(b: unknown, d: unknown, w: { write: () => unknown }) { return w.write(); }
export function leak(raw: Writable) { return emitConsumingTurnResponse(null, null, { write: () => raw.write("x") }); }`;
      expect(planted({ [file]: shadow }).join("\n")).toMatch(/fence name shadowed/);
      const alias = `import type { Writable } from "node:stream";
import { releaseNativeAnswer as answer } from "../drivers/engine-input.ts";
export function release(raw: Writable) { return answer(null, "fixture", "x", () => raw.write("x")); }`;
      expect(scan(program({ [file]: alias }, base), pins).admitted?.filter(pin => pin.file === file).map(pin => pin.admittedBy)).toEqual(["fence:consuming"]);
    }, 600_000);
    it("H-FENCE-9 deferrals inside consuming callbacks are refused", () => {
      const file = "server/memory/__deferred_fence__.ts";
      for (const body of ['queueMicrotask(() => raw.write("x"))', 'setTimeout(() => raw.write("x"), 0)', 'Promise.resolve().then(() => raw.write("x"))']) {
        const text = `import type { Writable } from "node:stream"; import { releaseNativeWire } from "../drivers/engine-input.ts";
export function release(raw: Writable) { return releaseNativeWire(null, "fixture", "x", () => ${body}); }`;
        expect(planted({ [file]: text }).join("\n")).toMatch(/deferred.*fence/);
      }
    }, 600_000);
    it("H-FENCE-1 the shipped 4-arg fencedSubmit is accepted", () => {
      expect(found.problems.filter(problem => problem.includes("fencedSubmit changed"))).toEqual([]);
    });
    it("H-FENCE-2 each fence-runner mutant is flagged", () => {
      expect(found.problems.filter(problem => problem.includes("fencedSubmit changed"))).toEqual([]);
      const file = "server/drivers/engine-input.ts", text = read(file);
      const mutants = [
        plant(file, { kind: "body", name: "fencedSubmit" }, "{ return write(); }", text),
        plant(file, stmt(/^if \(turn\.releaseBinding\)/, { in: "fencedSubmit" }), "", text),
        plant(file, stmt(/^if \(turn\.fencedWrite\)/, { in: "fencedSubmit" }), { kind: "before", text: "write();" }, text),
        plant(file, call("fencedWrite", { in: "fencedSubmit" }), (_node, source) => source.replace("(write,", "(() => write(),"), text),
        plant(file, stmt(/^if \(turn\.fencedWrite\)/, { in: "fencedSubmit" }), { kind: "before", text: "const early = () => write(); early();" }, text),
        plant(file, stmt(/^if \(turn\.fencedWrite\)/, { in: "fencedSubmit" }), { kind: "before", text: "turn.fencedWrite = undefined;" }, text),
      ];
      for (const mutant of mutants) expect(planted({ [file]: mutant }).join("\n")).toMatch(/fencedSubmit changed/);
    }, 600_000);
    it("H-FENCE-3 an identifier emit is linted as the emit", () => {
      expect(lintChains(base, pins).filter(problem => /^(codex|acp):/.test(problem))).toEqual([]);
      const file = "server/drivers/codex.ts", text = read(file);
      const awaited = plant(file, decl("write", { in: "send" }), (_node, source) => source.replace("() => gate.launch", "async () => { await Promise.resolve(); return gate.launch") + "; }", text);
      expect(planted({ [file]: awaited }).join("\n")).toMatch(/async emit in fencedSubmit|await on the hook chain/);
      const deferred = plant(file, decl("write", { in: "send" }), (_node, source) => source.replace("() => gate.launch", "() => setTimeout(() => gate.launch") + ", 0)", text);
      expect(planted({ [file]: deferred }).join("\n")).toMatch(/deferred function|timer captures the payload/);
    }, 600_000);
    it("checker dependency edits invalidate cached sink observations", () => {
      const file = "server/memory/__cache_sink__.ts", dependency = "server/memory/__cache_gate__.ts";
      const gate = `export interface Gate { send<R>(emit: () => R): R; check(): void; released: boolean; refused: boolean; purpose: string; }`;
      const text = `import type { Gate } from "./__cache_gate__.ts"; export function send(gate: Gate) { return gate.send(() => fetch("https://fixture.invalid")); }`;
      const clean = { [file]: text, [dependency]: gate };
      expect(planted(clean).filter(problem => problem.includes(file))).toEqual([]);
      expect(planted({ ...clean, [dependency]: gate.replace("check(): void", "gone(): void") }).join("\n")).toMatch(/unpinned sink: .*__cache_sink__/);
      expect(planted(clean).filter(problem => problem.includes(file))).toEqual([]);
    }, 600_000);
    it("mutually importing files retain separate sink observations", () => {
      const first = "server/memory/__cache_cycle_first__.ts", second = "server/memory/__cache_cycle_second__.ts";
      const sources = {
        [first]: 'import { second } from "./__cache_cycle_second__.ts"; export function first() { void second; return fetch("https://fixture.invalid/first"); }',
        [second]: 'import { first } from "./__cache_cycle_first__.ts"; export function second() { void first; return fetch("https://fixture.invalid/second"); }',
      };
      const observed = scan(program(sources, base), pins);
      expect(observed.sinks.filter(sink => sink.file === first || sink.file === second).map(sink => `${sink.file}|${sink.fn}`).sort()).toEqual([`${first}|first`, `${second}|second`]);
    }, 600_000);
    it("logical sink ownership rejects an additional caller or an escaping helper", () => {
      const file = "server/drivers/codex.ts", text = read(file);
      const duplicate = plant(file, call("launchBody", { in: "launchAttempt" }), (_node, source) => `(${source}, ${source})`, text);
      expect(planted({ [file]: duplicate }).join("\n")).toMatch(/logical owner launchAttempt does not uniquely call launchBody/);
      const escaping = plant(file, call("launchBody", { in: "launchAttempt" }), (_node, source) => `({ launchBody }, ${source})`, text);
      expect(planted({ [file]: escaping }).join("\n")).toMatch(/logical owner launchAttempt does not uniquely call launchBody/);
    }, 600_000);
    it("H-FENCE-4 only writes inside the consuming fence are admitted", () => {
      const file = "server/memory/__consuming_fence__.ts";
      const text = `import type { Writable } from "node:stream";
import { emitConsumingTurnResponse } from "../consuming-turn-response.ts";
import type { ConsumingTurnBinding, ConsumingDescriptor } from "../consuming-turn-response.ts";
export function release(raw: Writable, binding: ConsumingTurnBinding, descriptor: ConsumingDescriptor) {
  return emitConsumingTurnResponse(binding, descriptor, { bytes: 1, refs: [], write: () => raw.write("x") });
}`;
      const inside = scan(program({ [file]: text }, base), pins);
      expect(inside.admitted?.filter(pin => pin.file === file).map(pin => pin.admittedBy)).toEqual(["fence:consuming"]);
      expect(diff(inside, pins).filter(problem => problem.includes(file))).toEqual([]);
      const outside = plant(file, call("emitConsumingTurnResponse"), (_node, source) => `(raw.write("x"), ${source.replace('raw.write("x")', 'true')})`, text);
      expect(planted({ [file]: outside }).join("\n")).toMatch(/unpinned sink: .*__consuming_fence__/);
      const native = text.replace('import { emitConsumingTurnResponse } from "../consuming-turn-response.ts";', 'import { releaseNativeWire } from "../drivers/engine-input.ts";').replace('emitConsumingTurnResponse(binding, descriptor, { bytes: 1, refs: [], write: () => raw.write("x") })', 'releaseNativeWire(binding, "fixture", "x", () => raw.write("x"))');
      expect(scan(program({ [file]: native }, base), pins).admitted?.filter(pin => pin.file === file).map(pin => pin.admittedBy)).toEqual(["fence:consuming"]);
    }, 600_000);
  });

  describe("T15a: planted bypasses fail the scan", () => {
    const NEW = "server/memory/__planted__.ts";
    it("a raw fetch in a new file", () => { expect(planted({ [NEW]: `export const leak = (p: string) => fetch("https://x.invalid", { method: "POST", body: p });\n` }).join("\n")).toMatch(/unpinned sink: server\/memory\/__planted__\.ts\|leak\|fetch/); }, 600_000);
    it("a typed fetch property is a content sink", () => {
      const out = planted({ [NEW]: `declare const client: { fetch: typeof fetch };
export const leak = (payload: string) => client.fetch("https://x.invalid", { method: "POST", body: payload });
` }).join("\n");
      expect(out).toMatch(/unpinned sink: .*__planted__.*\|fetch\|client.fetch/);
    }, 600_000);
    it("an aliased fetch", () => { expect(planted({ [NEW]: `const f = fetch;\nexport const leak = (p: string) => f("https://x.invalid", { body: p });\n` }).join("\n")).toMatch(/unpinned sink: .*__planted__.*\|(fetch|alias-call)\|/); }, 600_000);
    it("a counted filesystem write, directly or through a renamed import", () => {
      for (const name of ["writeFileSync", "leakWrite"]) {
        const source = `import { writeFileSync${name === "writeFileSync" ? "" : " as leakWrite"} } from "../counted-fs.ts";\nexport function leak(p: string) { ${name}("fixture", p); }`;
        expect(planted({ [NEW]: source }).join("\n")).toMatch(/unpinned sink: .*__planted__.*\|fs-write\|/);
      }
    }, 600_000);
    // MAIN RULING INT-CONFLICT-DEFAULT 6d0b181f4f 3a09281afd: the Sentinel meter wrapper remains a sink at every caller, including aliases.
    it("a Sentinel filesystem write, directly or through a renamed import", () => {
      for (const name of ["writeFileSync", "leakWrite"]) {
        const source = `import { writeFileSync${name === "writeFileSync" ? "" : " as leakWrite"} } from "../sentinel/io-meter.ts";\nexport function leak(p: string) { ${name}("fixture", p); }`;
        expect(planted({ [NEW]: source }).join("\n")).toMatch(/unpinned sink: .*__planted__.*\|fs-write\|/);
      }
    }, 600_000);
    it("a Writable.write in a new helper", () => { expect(planted({ [NEW]: `import type { Writable } from "node:stream";\nexport const leak = (w: Writable, p: string) => w.write(p);\n` }).join("\n")).toMatch(/unpinned sink: .*__planted__.*stream-write/); }, 600_000);
    it("a deferred payload write", () => { expect(planted({ [NEW]: `import type { Writable } from "node:stream";\nexport const leak = (w: Writable, p: string) => queueMicrotask(() => w.write(p));\n` }).join("\n")).toMatch(/unpinned sink: .*__planted__.*stream-write/); }, 600_000);
    it("an await inside a hook chain", () => {
      const file = "server/drivers/codex.ts", text = read(file);
      const bad = plant(file, stmt(/^awaitingTurnStart = true;$/, { nth: 1 }), { kind: "before", text: "await Promise.resolve();" }, text);
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*await on the hook chain/);
      // the same await in an async fencedSubmit emit: the bytes would leave after COMMIT
      const asyncEmit = plant(file, decl("write", { in: "send" }), (_node, source) => source.replace("() => gate.launch", "async () => { await Promise.resolve(); return gate.launch") + "; }", text);
      expect(asyncEmit).not.toBe(text);
      expect(planted({ [file]: asyncEmit }).join("\n")).toMatch(/codex: .*async emit in fencedSubmit/);
    }, 600_000);
    // H1-SENDLOCK: every learning adapter's prompt write sits inside the gate's send; moving it out of fencedSubmit, or out of
    // gate.send in the Claude runner, fails
    it("the Codex turn/start written outside fencedSubmit (H1-SENDLOCK)", () => {
      const file = "server/drivers/codex.ts", text = read(file);
      // MAIN RULING 1114-SC-SAFETY-T15A-ANCHORS: select the actual owner declaration; retain every original assertion.
      expect(control).toEqual([]);
      const bad = plant(file, call("fencedSubmit", { in: "send" }), "write()", text);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/codex: server\/drivers\/codex\.ts: the hook anchor fencedSubmit\(turn, matches 0 calls/);
      // and a turn/start frame issued before the fence, with the fenced one left in place
      const before = plant(file, stmt(/^const write = \(\) => gate\.launch/, { in: "send" }), { kind: "before", text: 'void request(method, { threadId: codexThreadId, input: [{ type: "text", text: turn.text }] }); ' }, text);
      expect(before).not.toBe(text);
      expect(planted({ [file]: before }).join("\n")).toMatch(/codex: .*write anchor moved|codex: .*matches 2 calls|unpinned/);
    }, 600_000);

  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: keep the frozen ID; additional coverage has its own ID.
  it("SC-SAFETY added coverage: the Codex turn/start written outside fencedSubmit (H1-SENDLOCK)", () => {
      expect(control).toEqual([]);
      const file = "server/drivers/codex.ts", text = read(file);
      const bad = plant(file, call("fencedSubmit", { in: "send" }), "write()", text);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/codex: server\/drivers\/codex\.ts: the hook anchor fencedSubmit\(turn, matches 0 calls/);
      // and a turn/start frame issued before the fence, with the fenced one left in place
      const before = mutate(text, "const write = () => gate.launch(entry, () => {", "child.stdin.write(wire); const write = () => gate.launch(entry, () => {");
      expect(before).not.toBe(text);
      expect(planted({ [file]: before }).join("\n")).toMatch(/codex: .*write anchor moved|codex: .*matches 2 calls|unpinned/);
      const misclassified = mutate(text, 'const input = method === "turn/start" || method === "review/start" || method === "thread/compact/start";', "const input = false;");
      expect(planted({ [file]: misclassified }).join("\n")).toMatch(/Codex input frame classification contract changed/);
      const inverted = mutate(text, "if (input) try { fencedSubmit(turn, write, wire, () => {", "if (!input) try { fencedSubmit(turn, write, wire, () => {");
      expect(planted({ [file]: inverted }).join("\n")).toMatch(/Codex inside-owner Stop contract changed/);
    }, 600_000);
    it("the ACP session/prompt written outside fencedSubmit (H1-SENDLOCK)", () => {
      const file = "server/drivers/acp/core.ts", text = read(file);
      // MAIN RULING 1114-SC-SAFETY-T15A-ANCHORS: select the actual owner declaration.
      expect(control).toEqual([]);
      const bad = plant(file, call("fencedSubmit", { in: "send" }), "write()", text);
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/acp: server\/drivers\/acp\/core\.ts: the hook anchor fencedSubmit\(turn, matches 0 calls/);
    }, 600_000);

  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: keep the frozen ID; additional coverage has its own ID.
  it("SC-SAFETY added coverage: the ACP session/prompt written outside fencedSubmit (H1-SENDLOCK)", () => {
      expect(control).toEqual([]);
      const file = "server/drivers/acp/core.ts", text = read(file);
      const bad = plant(file, call("fencedSubmit", { in: "send" }), "write()", text);
      expect(bad).not.toBe(text);
      // MAIN RULING (redesign §4.3): "Model the current `fencedSubmit` contract, including serialized byte accounting, consuming-binding failure, and inside-owner Stop validation."
      expect(planted({ [file]: bad }).join("\n")).toMatch(/acp: server\/drivers\/acp\/core\.ts: the hook anchor fencedSubmit\(turn, matches 0 calls/);
      {
        // Preserve the integration's physical-writer probe as a separate activated mutation.
        const file = "server/drivers/acp/approval-delivery.ts", text = read(file);
        const bad = plant(file, call("write", { in: "writeAcpResponse" }), (_node, source) => source.replace("stream.write", "stream.end"), text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/acp: .*write anchor moved .*fencedSubmit/);
      }
      const misclassified = mutate(text, 'const promptFrame = (obj as { method?: string }).method === "session/prompt";', "const promptFrame = false;");
      expect(planted({ [file]: misclassified }).join("\n")).toMatch(/ACP prompt frame classification contract changed/);
    }, 600_000);
    it("the Claude runner's stdin written outside gate.send (H1-SENDLOCK)", () => {
      const file = "server/drivers/claude.ts", text = read(file);
      // MAIN RULING 1114-SC-SAFETY-T15A-ANCHORS: select the actual owner declaration.
      expect(control).toEqual([]);
      const bad = plant(file, call("send", { in: "runReview", text: "cliStdinWrite" }), "(gate.check(), child.stdin.end(prompt), child.stdin.end(prompt))", text);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/unpinned sink: server\/drivers\/claude\.ts\|runReview\|stdin\|child\.stdin\.end\(prompt\)\|1/);
      expect(out).toMatch(/a withCliMemoryLearning adapter has no prompt write inside a gate's send .*server\/drivers\/claude\.ts/);
    }, 600_000);

  // MAIN RULING 1114-SC-SAFETY-HSCOPE4: keep the frozen ID; additional coverage has its own ID.
  it("SC-SAFETY added coverage: the Claude runner's stdin written outside gate.send (H1-SENDLOCK)", () => {
      expect(control).toEqual([]);
      const file = "server/drivers/claude.ts", text = read(file);
      const bad = plant(file, call("send", { in: "runReview", text: "cliStdinWrite" }), "(gate.check(), child.stdin.end(prompt), child.stdin.end(prompt))", text);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      // MAIN RULING (redesign §4.3): "Trace each chain to the physical socket/stdin enqueue."
      expect(out).toMatch(/unpinned sink: server\/drivers\/claude\.ts\|runReview\|stdin\|child\.stdin\.end\(prompt\)\|1/);
      expect(out).toMatch(/claude-one-shot: .*hook anchor gate\.send.*matches 0 calls/);
      expect(out).toMatch(/a withCliMemoryLearning adapter has no prompt write inside a gate's send .*server\/drivers\/claude\.ts/);
    }, 600_000);
    it("a removed admission method called on a gate, or declared on LearningGate (H1-SENDLOCK)", () => {
      expect(planted({ [NEW]: `${GATED}export const leak = (gate: LearningGate) => { (gate as LearningGate & { admit(): void }).admit(); (gate as LearningGate & { notWritten(): void }).notWritten(); };\n` }).join("\n"))
        .toMatch(/removed gate method admit\( called on a learning gate at server\/memory\/__planted__\.ts[\s\S]*removed gate method notWritten\(/);
      const file = "server/memory/learning-send.ts", text = read(file);
      const bad = mutate(text, /^(  send<R>[^\n]+;)$/m, "$1\n  wrote(): void;");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/LearningGate declares the removed wrote/);
    }, 600_000);
    it("a learning adapter without fencedLearningWrite, a changed fencedSubmit, or no fail-closed check (H1-SENDLOCK)", () => {
      const codex = "server/drivers/codex.ts", text = read(codex);
      const bad = plant(codex, prop("fencedLearningWrite"), "fencedLearningWrite: false", text);
      expect(bad).not.toBe(text);
      expect(planted({ [codex]: bad }).join("\n")).toMatch(/a withCliMemoryLearning adapter does not declare fencedLearningWrite: server\/drivers\/codex\.ts/);
      const input = "server/drivers/engine-input.ts", inputText = read(input);
      const badInput = plant(input, { kind: "body", name: "fencedSubmit" }, "{ return write(); }", inputText);
      expect(badInput).not.toBe(inputText);
      expect(planted({ [input]: badInput }).join("\n")).toMatch(/fencedSubmit changed/);
      const learning = "server/drivers/cli-memory-learning.ts", learningText = read(learning);
      const open = plant(learning, stmt(/^if \(adapter\.capabilities\?\.fencedLearningWrite/), "", learningText);
      expect(open).not.toBe(learningText);
      expect(planted({ [learning]: open }).join("\n")).toMatch(/lost its fail-closed fencedLearningWrite check/);
    }, 600_000);
    it("a consuming binding without its writer must fail closed", () => {
      const file = "server/drivers/engine-input.ts", text = read(file);
      const bad = mutate(text, 'if (turn.releaseBinding) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });', "");
      expect(planted({ [file]: bad }).join("\n")).toMatch(/fencedSubmit changed/);
    }, 600_000);
    it("both owner checks retain the captured generation rather than source visibility alone", () => {
      const file = "server/drivers/engine-input.ts", text = read(file);
      const validation = "if (binding) assertConsumingBinding(binding);\n      checkEngineInput(fence, prompt, bytes);";
      // Each node is individually targeted: one before entry and one at emit.
      const first = mutate(text, `if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("ASYNC_RELEASE_TRANSACTION");\n      ${validation}`,
        'if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("ASYNC_RELEASE_TRANSACTION");\n      checkEngineInput(fence, prompt, bytes);');
      const bad = mutate(first, `assertReleaseContext(activeContext, db);\n      ${validation}`, "assertReleaseContext(activeContext, db);\n      checkEngineInput(fence, prompt, bytes);");
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/owner validation, binding and generation contract changed/);
      expect(out).toMatch(/final write binding and generation contract changed/);
    }, 600_000);
    it("Stop validation stays inside each writer owner", () => {
      for (const [file, check, violation] of [
        ["server/drivers/codex.ts", "if (why || entry.done || stopRequested) throw new GateStopped(why);", /Codex inside-owner Stop contract changed/],
        ["server/drivers/acp/core.ts", 'if (turnHalted()) throw new Error("ACP_TURN_STOPPED");', /ACP fenced release and inside-owner Stop contract changed/],
        ["server/drivers/engine-input.ts", "try { result = extra?.(context); }", /owner validation, binding and generation contract changed/],
      ] as const) {
        const bad = mutate(read(file), check, "void 0;");
        expect(planted({ [file]: bad }).join("\n")).toMatch(violation);
      }
    }, 600_000);
    it("a named physical writer cannot defer bytes until after commit", () => {
      for (const [file, write, prefix] of [
        ["server/drivers/codex.ts", "child.stdin.write(wire, error => completed(!error))", "codex"],
        ["server/drivers/acp/approval-delivery.ts", "stream.write(wire, error => report(error, true))", "acp"],
        ["server/drivers/claude.ts", "s.child.stdin.write(wire, done)", "claude-one-shot"],
      ]) {
        const bad = mutate(read(file), write, `queueMicrotask(() => ${write})`);
        expect(planted({ [file]: bad }).join("\n")).toMatch(new RegExp(`${prefix}: .*deferred function`));
      }
    }, 600_000);
    it("a named callback cannot be reused outside the owner or escape through an alias", () => {
      const file = "server/drivers/codex.ts", text = read(file);
      const hook = "if (input) try { fencedSubmit(turn, write, wire, () => {";
      const early = mutate(text, hook, `write(); ${hook}`);
      expect(planted({ [file]: early }).join("\n")).toMatch(/codex: .*writer callback escapes its bounded dispatcher/);
      const escaped = mutate(text, hook, `const escaped = { write }; ${hook}`);
      expect(planted({ [file]: escaped }).join("\n")).toMatch(/codex: .*writer callback is referenced other than by a bounded call/);
      const mutable = mutate(text, "const write = () => gate.launch(entry, () => {", "let write = () => gate.launch(entry, () => {");
      expect(planted({ [file]: mutable }).join("\n")).toMatch(/codex: .*writer callback is not a same-file const function/);
    }, 600_000);
    it.each([
      ["Codex native answer", "server/drivers/codex.ts", 'releaseNativeAnswer(nativeBinding, "codex:protocol", wire, write)', 'appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj }'],
      ["ACP native answer", "server/drivers/acp/approval-delivery.ts", 'releaseNativeAnswer(binding, "acp:approval", wire, write)', 'else releaseNativeAnswer(binding, "acp:approval", wire, write);'],
      ["ACP engine wire", "server/drivers/acp/approval-delivery.ts", 'emitEngineWire(beforeWrite, wire, write)', 'else releaseNativeAnswer(binding, "acp:approval", wire, write);'],
    ].flatMap(([name, file, dispatch, anchor]) => [
      [name, "immediate", file, anchor, `${dispatch};`],
      [name, "deferred", file, anchor, `queueMicrotask(() => ${dispatch});`],
      [name, "nested", file, anchor, `(() => ${dispatch})();`],
    ]))("%s callback rejects immediate and deferred escapes outside its reviewed branch: %s", (_name, _shape, file, anchor, escape) => {
      const text = read(file);
      // Keep the reviewed owner and all existing pins intact. Only the new
      // reference leaves that owner's branch; the timer is not the oracle.
      const replacement = file.endsWith("codex.ts") ? `${escape} ${anchor}` : `${anchor} ${escape}`;
      const bad = mutate(text, anchor, replacement);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/writer callback escapes its bounded dispatcher/);
    }, 600_000);
    it("rejects a physical stdin enqueue outside the Codex owner", () => {
      expect(control).toEqual([]);
      const file = "server/drivers/codex.ts", text = read(file);
      const bad = mutate(text, "const write = () => gate.launch(entry, () => {", "child.stdin.write(wire); const write = () => gate.launch(entry, () => {");
      expect(bad).not.toBe(text);
      // MAIN RULING INT-CONFLICT-DEFAULT: current native-stdin scanner class; same exact outside-owner enqueue must fail.
      expect(planted({ [file]: bad }).join("\n")).toMatch(/unpinned sink: server\/drivers\/codex\.ts\|send\|stdin\|child\.stdin\.write\(wire\)/);
    }, 600_000);
    it("the actual StopGate implementation must invoke launch callbacks synchronously", () => {
      const file = "server/drivers/stop-gate.ts", text = read(file);
      const bad = mutate(text, "try { return fn(); } catch (x) { e.live = was; throw x; }", "try { return Promise.resolve().then(fn) as T; } catch (x) { e.live = was; throw x; }");
      expect(planted({ [file]: bad }).join("\n")).toMatch(/actual StopGate.launch is not a synchronous bounded callback/);
    }, 600_000);
    it("held S2 frames reacquire authority on flush instead of retaining an earlier grant", () => {
      const file = "server/drivers/claude.ts", text = read(file);
      const stripped = mutate(text, "gate.forward(frame, () => cliStdinWrite(kept, frame.wire, frame.done, frame.release))", "gate.forward(frame, () => cliStdinWrite(kept, frame.wire, frame.done))");
      expect(planted({ [file]: stripped }).join("\n")).toMatch(/S2 flush retains captured release contract changed/);
      const granted = mutate(text, 'if (route === "held") return;', 'if (route === "held") { release?.(() => undefined, () => undefined); return; }');
      expect(planted({ [file]: granted }).join("\n")).toMatch(/held S2 frames route before release contract changed/);
      const bypass = mutate(text, "if (release) release(write, validate); else write();", "write();");
      expect(planted({ [file]: bypass }).join("\n")).toMatch(/held S2 frames reacquire release contract changed/);
    }, 600_000);
    it("Muse admission cannot move ahead of an await, outside the write function or into a timer", () => {
      const file = "server/drivers/muse-code.ts", text = read(file);
      const awaited = mutate(text, "admitted = true;", "await Promise.resolve(); admitted = true;");
      expect(awaited).not.toBe(text);
      expect(planted({ [file]: awaited }).join("\n")).toMatch(/muse: .*await on the hook chain/);
      const moved = mutate(text, "p.beforeSubmit?.();", "(() => { p.beforeSubmit?.(); })();");
      expect(planted({ [file]: moved }).join("\n")).toMatch(/muse: .*outside the hook's function/);
      const prompt = 'child.stdin.write(bytes, "utf8", onWritten)';
      const deferred = mutate(text, prompt, 'setTimeout(() => child.stdin.write(bytes, "utf8", onWritten), 0)', "writePrompt");
      expect(deferred).not.toBe(text);
      expect(planted({ [file]: deferred }).join("\n")).toMatch(/muse: .*deferred function/);
    }, 600_000);
    describe("a stop gate's launch callback is same-tick only for its proven call shape (STOP-NONACP)", () => {
      // the controls: the shipped code (a non-async callback of the stop gate's launch) is accepted by the chain lint
      it("accepts the shipped muse and codex launch callbacks", () => { expect(lintChains(base, pins).filter(p => /^(muse|codex):/.test(p))).toEqual([]); });
      it("rejects a genuinely async muse launch callback", () => {
        const file = "server/drivers/muse-code.ts", text = read(file);
        const bad = mutate(text, "gate.launch(prompt.entry, () => {", "gate.launch(prompt.entry, async () => {");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a deferred muse write inside the launch callback", () => {
        const file = "server/drivers/muse-code.ts", text = read(file);
        const bad = mutate(text, 'child.stdin.write(bytes, "utf8", onWritten)', 'void Promise.resolve().then(() => child.stdin.write(bytes, "utf8", onWritten))', "writePrompt");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a muse write helper that is called outside the hook's function", () => {
        const file = "server/drivers/muse-code.ts", text = read(file);
        const bad = mutate(text, "p.beforeSubmit?.();", "(() => { p.beforeSubmit?.(); })();");
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/muse: .*outside the hook's function/);
      }, 600_000);
      it("rejects a genuinely async codex launch callback", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const bad = plant(file, call("launch", { in: "launchBody", text: "awaitingTurnStart = true" }), (_node, source) => source.replace("entry, () =>", "entry, async () =>"), text);
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*deferred function/);
      }, 600_000);
      it("rejects a look-alike that has all five of the stop gate's names but is not declared in stop-gate.ts", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const bad = plant(file, call("launch", { in: "launchBody", text: "awaitingTurnStart = true" }), (_node, source) => source.replace("gate.launch", "lookalike.launch"), text)
          + "\nconst lookalike = { launch: (_entry: unknown, f: () => unknown) => setTimeout(f, 0), step: undefined, cleanupStep: undefined, handoff: undefined, bindLive: undefined };\n";
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*deferred function/);
      }, 600_000);
      const MUSE = "server/drivers/muse-code.ts";
      const PROMPT_CALL = "if (p && MUSE_PROMPT_METHODS.has(String(frame.method))) writePrompt(p as PromptFrame, chunk);";
      const CONTROL_CALL = "else writeControl(controlFrame(chunk, frame));";
      it("rejects the prompt helper called from a declared function handed to a then", () => {
        const text = read(MUSE), bad = mutate(text, PROMPT_CALL, "if (p && MUSE_PROMPT_METHODS.has(String(frame.method))) { function later() { writePrompt(p as PromptFrame, chunk); } Promise.resolve().then(later); }");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects the prompt helper handed on without a plain call (a bound reference), whatever else calls it", () => {
        const text = read(MUSE), bad = mutate(text, CONTROL_CALL, `${CONTROL_CALL}\n        Promise.resolve().then(writePrompt.bind(null, p as PromptFrame, chunk));`);
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is referenced other than by a plain call/);
      }, 600_000);
      it("rejects an async write helper", () => {
        const text = read(MUSE), bad = mutate(text, "const writePrompt = (prompt: PromptFrame, bytes: string) => {", "const writePrompt = async (prompt: PromptFrame, bytes: string) => {");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is async/);
      }, 600_000);
      it("rejects a deferred call of the control write helper", () => {
        const text = read(MUSE), bad = mutate(text, CONTROL_CALL, "else setTimeout(() => writeControl(controlFrame(chunk, frame)), 0);");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a union receiver when any member is not the stop gate", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const bad = plant(file, call("launch", { in: "launchBody", text: "awaitingTurnStart = true" }), (_node, source) => source.replace("gate.launch", "pick.launch"), text)
          + "\ndeclare const real: import(\"./stop-gate.ts\").StopGate;\nconst lookalike = { launch: (_entry: unknown, f: () => unknown) => Promise.resolve().then(f), step: undefined, cleanupStep: undefined, handoff: undefined, bindLive: undefined };\nconst pick = Math.random() > 2 ? real : lookalike;\n";
        expect(bad).not.toBe(text);
        expect(planted({ [file]: bad }).join("\n")).toMatch(/codex: .*deferred function/);
      }, 600_000);
      it("rejects the prompt helper escaping through a shorthand property", () => {
        const text = read(MUSE), bad = mutate(text, CONTROL_CALL, `${CONTROL_CALL}\n        const escaped = { writePrompt };\n        Promise.resolve().then(() => escaped.writePrompt(p as PromptFrame, chunk));`);
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is referenced other than by a plain call/);
      }, 600_000);
      it("rejects a generator write helper", () => {
        const text = read(MUSE), bad = mutate(text, "const writePrompt = (prompt: PromptFrame, bytes: string) => {", "const writePrompt = function* (prompt: PromptFrame, bytes: string) {");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*helper writePrompt is a generator/);
      }, 600_000);
      it("rejects a write moved into an accessor the helper hands to a then", () => {
        // busyloop-r2.md:17-20 keeps the typed request marker around the actual write.
        const text = read(MUSE);
        const original = /const writeControl = \(bytes: ControlFrame\) => \{\n          submit\(\);\n          (registerBusyloopRequestSite\([^\n]+\);)\n        \};/;
        const bad = mutate(text, original, (_match, write: string) => `const writeControl = (bytes: ControlFrame) => {
          submit();
          const lazy = { get value() { return ${write} } };
          void Promise.resolve().then(() => lazy.value);
        };`);
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/muse: .*deferred function/);
      }, 600_000);
      it("rejects a hand-built value annotated as the stop gate whose launch defers", () => {
        const text = read(MUSE);
        const bad = mutate(text, "gate.launch(prompt.entry, () => {", "const delayed: StopGate = { ...gate, launch(_entry: unknown, fn: () => unknown) { void Promise.resolve().then(fn); throw new Error(\"queued\"); } };\n            delayed.launch(prompt.entry, () => {");
        expect(bad).not.toBe(text);
        expect(planted({ [MUSE]: bad }).join("\n")).toMatch(/a hand-built stop gate at server\/drivers\/muse-code\.ts/);
        const asserted = mutate(text, "gate.launch(prompt.entry, () => {", "const delayed = { launch: (_entry: unknown, fn: () => unknown) => Promise.resolve().then(fn) } as unknown as StopGate;\n            delayed.launch(prompt.entry, () => {");
        expect(asserted).not.toBe(text);
        expect(planted({ [MUSE]: asserted }).join("\n")).toMatch(/a stop gate made by a type assertion at server\/drivers\/muse-code\.ts/);
      }, 600_000);
      it("rejects replacing, proxying or defining over a real stop gate's launch, and an untyped value passed as the gate", () => {
        const file = "server/drivers/codex.ts", text = read(file);
        const call = "started = gate.launch(entry, () => {";
        const replaced = text.replace(call, `gate.launch = new Proxy(gate.launch, { apply: (target, self, args) => Promise.resolve().then(() => Reflect.apply(target, self, args)) });\n        ${call}`);
        expect(replaced).not.toBe(text);
        expect(planted({ [file]: replaced }).join("\n")).toMatch(/a write to a stop gate member at server\/drivers\/codex\.ts/);
        const cast = mutate(text, call, `(gate as unknown as { launch: unknown }).launch = () => undefined;\n        ${call}`);
        expect(planted({ [file]: cast }).join("\n")).toMatch(/a write to a stop gate member at server\/drivers\/codex\.ts/);
        const defined = mutate(text, call, `Object.defineProperty(gate, "launch", { value: () => undefined });\n        ${call}`);
        expect(planted({ [file]: defined }).join("\n")).toMatch(/Object\.defineProperty on a stop gate at server\/drivers\/codex\.ts/);
        const muse = read(MUSE);
        const proxied = mutate(muse, "gate.launch(prompt.entry, () => {", "const g2 = new Proxy(gate, {});\n            g2.launch(prompt.entry, () => {");
        expect(proxied).not.toBe(muse);
        expect(planted({ [MUSE]: proxied }).join("\n")).toMatch(/a Proxy over the stop gate at server\/drivers\/muse-code\.ts/);
        const untyped = mutate(muse, "gate.launch(prompt.entry, () => {", "const fake: any = {};\n            const g3: StopGate = fake;\n            g3.launch(prompt.entry, () => {");
        expect(untyped).not.toBe(muse);
        expect(planted({ [MUSE]: untyped }).join("\n")).toMatch(/an untyped value flows into a stop gate at server\/drivers\/muse-code\.ts/);
      }, 600_000);
      it("rejects the prompt helper called from a class field initializer", () => {
        const text = read(MUSE), bad = mutate(text, PROMPT_CALL, "if (p && MUSE_PROMPT_METHODS.has(String(frame.method))) { class Later { sent = writePrompt(p as PromptFrame, chunk); } void Promise.resolve().then(() => new Later()); }");
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
      const bad = plant(file, call("send", { in: "request", text: "id, method, params" }), (_node, source) => `(setImmediate(() => undefined), ${source})`, text);
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/unpinned timer/);
    }, 600_000);
    it("a gate payload passed to a not-learning ACP caller, the !proc arm or the interjection", () => {
      const file = "server/drivers/acp/core.ts", text = read(file);
      const caller = pins.callers.find(c => c.file === file && c.callee === "send");
      expect(caller).toBeTruthy();
      const bad = mutate(text, "writeAcpResponse(child?.stdin, obj,", "writeAcpResponse(child?.stdin, (globalThis as { leak?: unknown }).leak ?? obj,");
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
      const bad = mutate(text, `${write};`, `setImmediate(() => { ${write}; });`);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/deferred write in helper writeAndSpawn \(setImmediate\)/);
      expect(out).not.toMatch(/unpinned sink:|vanished or moved sink pin:/); // the pin still matches: only the helper walk sees the deferral
    }, 600_000);
    it("the voice host SSE emit without projectEvent (D24CH)", () => {
      const file = "server/voice/voice-host-route.ts", text = read(file);
      const bad = mutate(text, "JSON.stringify(projectEvent(event))", "JSON.stringify(event)");
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/unpinned sink: server\/voice\/voice-host-route\.ts\|emit\|stream-write\|/);
      expect(out).toMatch(/vanished or moved sink pin: server\/voice\/voice-host-route\.ts\|emit\|stream-write\|/);
    }, 600_000);
    it("an unchanged-anchor gate payload at a pinned not-learning ACP send( caller and at the interjection (H5)", () => {
      const file = "server/drivers/acp/core.ts", text = read(file);
      const sendSite = `return deliverNative(slot, source === 'user' ? 'answer' : 'retire', JSON.stringify({behavior,result}),`;
      const bad = mutate(text, sendSite, `result = turn.text; ${sendSite}`);
      expect(bad).not.toBe(text);
      const out = planted({ [file]: bad }).join("\n");
      expect(out).toMatch(/a gate payload reaches the not-learning send\( caller at server\/drivers\/acp\/core\.ts/);
      expect(out).not.toMatch(/vanished or moved caller pin/);
      const bad2 = plant(file, stmt(/^const response = NotModelRequest\("ACP interjection control"/), { kind: "before", text: "text = turn.text;" }, text);
      expect(bad2).not.toBe(text);
      expect(planted({ [file]: bad2 }).join("\n")).toMatch(/a gate payload reaches the not-learning request\( caller/);
    }, 600_000);
    it("a learning-path pin whose hook no longer writes inside the gate's send (H4, H1-SENDLOCK)", () => {
      const file = "server/drivers/cli-memory-learning.ts", text = read(file);
      const bad = plant(file, call("send", { text: "gate.send(write," }), "(gate.check(), write())", text);
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/learning-path sink pin not proven \(fence:fencedWrite\)/);
    }, 600_000);
    it("the hidden learning sendTurn without its fencedWrite (H4, GrokBuild r1)", () => {
      const file = "server/drivers/cli-memory-learning.ts", text = read(file);
      const bad = mutate(text, ", ...(fencedWrite ? { fencedWrite } : {})", "");
      expect(bad).not.toBe(text);
      expect(planted({ [file]: bad }).join("\n")).toMatch(/a learning sendTurn without the fencedWrite fence: server\/drivers\/cli-memory-learning\.ts\|hiddenTurnRunner\|sendTurn/);
      // re-pinning it under any other reason fails too
      const repinned = { ...pins, sinks: pins.sinks.map(e => e.kind === "sendTurn" && e.file === file ? { ...e, reason: "not-learning" as const, admittedBy: "" } : e) };
      expect(diff(found, repinned).join("\n")).toMatch(/a learning sendTurn without the fencedWrite fence/);
    }, 600_000);
    it("the learning pins name their admission (H4)", () => {
      const learning = [...pins.sinks, ...pins.callers].filter(e => e.reason === "learning-path" || e.reason === "learning-local");
      // MAIN RULING (redesign §4.3): "Preserve the existing final-write implementation and refresh the learning inventory."
      // MAIN RULING (§3): "owner No limits authority comes ONLY from an authenticated owner turn (the turn's own verified origin), never from thread ownership"
      // These admissions name the captured writer; they confer no owner permission.
      // MAIN RULING INT-CONFLICT-DEFAULT 434e85e2b0 / 90b159a048: keep exact direct and posture release-owner rows.
      expect(learning.map(e => `${e.file}|${e.fn}|${e.reason}|${e.admittedBy}`).sort()).toEqual([
        "server/drivers/acp/core.ts|launch|learning-path|chain:acp",
        "server/drivers/acp/core.ts|request|learning-path|chain:acp",
        "server/drivers/acp/core.ts|send|learning-path|chain:acp",
        "server/drivers/acp/core.ts|send|learning-path|chain:acp",
        "server/drivers/acp/core.ts|writeTo|learning-path|chain:acp",
        "server/drivers/cli-memory-learning.ts|hiddenTurnRunner|learning-path|fence:fencedWrite",
        "server/drivers/codex.ts|launchAttempt|learning-path|chain:codex",
        "server/drivers/codex.ts|onPostureChange|learning-path|chain:codex",
        "server/drivers/codex.ts|request|learning-path|chain:codex",
        "server/gepa-worker.ts|write|learning-local|child:spawn(command.executable,",
      ]);
    });
    it("physical dispatch admissions include fixed posture and unpooled response paths", () => {
      expect(lintChains(base, pins)).toEqual([]);
      const direct = pins.callers.find(pin => pin.file === "server/drivers/acp/core.ts" && pin.fn === "send" && pin.callee === "writeAcpResponse");
      const posture = pins.callers.find(pin => pin.file === "server/drivers/codex.ts" && pin.fn === "onPostureChange" && pin.anchor.startsWith('request("turn/start",'));
      expect(direct).toBeTruthy();
      expect(posture).toBeTruthy();
      for (const pin of [direct!, posture!]) {
        const sf = base.getSourceFile(join(ROOT, pin.file))!;
        const calls = callsInNode(sf).filter(node => fnName(node) === pin.fn && anchorOf(node) === pin.anchor);
        expect(calls).toHaveLength(1);
        let symbol = base.getTypeChecker().getSymbolAtLocation(calls[0].expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = base.getTypeChecker().getAliasedSymbol(symbol);
        expect(symbol?.valueDeclaration).toBeDefined();
      }
      // The original inventory describes learning payloads. These two additional
      // fixed/control paths use the same physically proved release owner.
      const learning = [...pins.sinks, ...pins.callers].filter(pin => pin.reason === "learning-path" || pin.reason === "learning-local").map(pin => pin.file === "server/drivers/codex.ts" && pin.fn === "launchAttempt" ? { ...pin, fn: "launchBody" } : pin);
      learning.push({ ...direct!, reason: "learning-path", admittedBy: "chain:acp" }, { ...posture!, reason: "learning-path", admittedBy: "chain:codex" });
      // MAIN RULING INT-CONFLICT-DEFAULT 434e85e2b0 / 90b159a048: retain both actual inventory rows and these additional physical-path witnesses.
      expect(learning.map(e => `${e.file}|${e.fn}|${e.reason}|${e.admittedBy}`).sort()).toEqual([
        "server/drivers/acp/core.ts|launch|learning-path|chain:acp",
        "server/drivers/acp/core.ts|request|learning-path|chain:acp",
        "server/drivers/acp/core.ts|send|learning-path|chain:acp",
        "server/drivers/acp/core.ts|send|learning-path|chain:acp",
        "server/drivers/acp/core.ts|send|learning-path|chain:acp",
        "server/drivers/acp/core.ts|writeTo|learning-path|chain:acp",
        "server/drivers/cli-memory-learning.ts|hiddenTurnRunner|learning-path|fence:fencedWrite",
        "server/drivers/codex.ts|launchBody|learning-path|chain:codex",
        "server/drivers/codex.ts|onPostureChange|learning-path|chain:codex",
        "server/drivers/codex.ts|onPostureChange|learning-path|chain:codex",
        "server/drivers/codex.ts|request|learning-path|chain:codex",
        "server/gepa-worker.ts|write|learning-local|child:spawn(command.executable,",
      ]);
    }, 600_000);
    it("a second send inside pinnedCall", () => {
      const file = "server/memory/extractor-connections.ts", text = read(file);
      const bad = mutate(text, "pinAnswered=null;\n  if(base!==\"flux-fast\")", "pinAnswered=null;\n  (globalThis as unknown as {g:import(\"./learning-send.ts\").LearningGate}).g.send(()=>undefined);\n  if(base!==\"flux-fast\")");
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
