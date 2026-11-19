// SPDX-License-Identifier: AGPL-3.0-or-later
// D6 guard (design DESIGN-WALFLAKE6 rev8, pins P1 to P5g): a pure function over the five production sources. Test-only; nothing in production imports it.
import { createHash } from "node:crypto";
import ts from "typescript";

export const GUARD_FILES = ["server/wal-maintenance.ts", "server/io-budget.ts", "server/admission-shared.ts", "server/io-meter.ts", "server/engine-exclusion.ts"] as const;
export type GuardSources = Record<(typeof GUARD_FILES)[number], string>;
const WM = "server/wal-maintenance.ts", IB = "server/io-budget.ts", AS = "server/admission-shared.ts", IM = "server/io-meter.ts", EE = "server/engine-exclusion.ts";
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const walk = (n: ts.Node, f: (n: ts.Node) => void) => { f(n); ts.forEachChild(n, c => walk(c, f)); };
const norm = (n: ts.Node, sf: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, n, sf);
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function findFn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration[] {
  const out: ts.FunctionDeclaration[] = [];
  walk(sf, n => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) out.push(n); });
  return out;
}
/** Every declaration of a name in a file (variable, function, class, parameter, catch variable, import binding, binding-pattern element). */
function declsOf(sf: ts.SourceFile, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  walk(sf, n => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.name.text === name) out.push(n);
    else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name) out.push(n);
    else if (ts.isImportSpecifier(n) && n.name.text === name) out.push(n);
    else if (ts.isImportClause(n) && n.name?.text === name) out.push(n);
    else if (ts.isNamespaceImport(n) && n.name.text === name) out.push(n);
    else if (ts.isImportEqualsDeclaration(n) && n.name.text === name) out.push(n);
  });
  return out;
}
function importSpecifier(sf: ts.SourceFile, name: string): { from: string; imported: string } | null {
  let found: { from: string; imported: string } | null = null;
  for (const st of sf.statements) if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings))
    for (const el of st.importClause.namedBindings.elements) if (el.name.text === name) found = { from: (st.moduleSpecifier as ts.StringLiteral).text, imported: (el.propertyName ?? el.name).text };
  return found;
}
/** Peel parentheses, type assertions, non-null and satisfies wrappers, and a comma expression (its value is its right operand): `((x as T)!)` and `(0, x)` write x. */
function peel(e: ts.Node): ts.Node {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) return peel(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) return peel(e.right);
  return e;
}
/** The leaf write targets of an assignment target or pattern: array and object destructuring (nested, with rest; a default `x = v` is itself an assignment node the walk visits) down to identifiers and member expressions. */
function leaves(t: ts.Node, out: ts.Node[]): void {
  const e = peel(t);
  if (ts.isArrayLiteralExpression(e)) { for (const el of e.elements) leaves(el, out); return; }
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isShorthandPropertyAssignment(p)) out.push(p.name);
      else if (ts.isPropertyAssignment(p)) leaves(p.initializer, out);
      else if (ts.isSpreadAssignment(p)) leaves(p.expression, out);
    }
    return;
  }
  if (ts.isSpreadElement(e)) { leaves(e.expression, out); return; }
  out.push(e);
}
/** The key a property name or element access spells, when it is a literal. */
function keyOf(n: ts.Node): string | null {
  const e = peel(n);
  if (ts.isIdentifier(e) || ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text;
  if (ts.isComputedPropertyName(e)) return keyOf(e.expression);
  return null;
}
/** Does this write target name `name`: the bare identifier, or a member of any holder (`ns.name`, `ns["name"]`, `exports.name`)? */
function targetNames(t: ts.Node, name: string): boolean {
  if (ts.isIdentifier(t)) return t.text === name;
  if (ts.isPropertyAccessExpression(t)) return t.name.text === name;
  if (ts.isElementAccessExpression(t)) return keyOf(t.argumentExpression) === name;
  return false;
}
const HOLDER_CALLS: Record<string, string[]> = { Object: ["assign", "defineProperty", "defineProperties"], Reflect: ["set", "defineProperty", "deleteProperty"] };
/** The names a file can mutate a holder through: module namespace, default and require bindings, plus the CommonJS and global holders. */
function holderNames(sf: ts.SourceFile): Set<string> {
  const names = new Set(["exports", "module", "globalThis"]);
  walk(sf, n => {
    if (ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n)) names.add(n.name.text);
    else if (ts.isImportClause(n) && n.name) names.add(n.name.text);
  });
  return names;
}
const holderRoot = (e: ts.Node): string | null => { const p = peel(e); return ts.isIdentifier(p) ? p.text : ts.isPropertyAccessExpression(p) ? holderRoot(p.expression) : null; };
/** Every node that can write the binding `name`: assignment (plain, compound, logical), destructuring, ++/--, for-in/for-of heads, delete, and the reflective writers on a holder. */
function assignsTo(sf: ts.SourceFile, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  const holders = holderNames(sf);
  const hit = (target: ts.Node) => { const l: ts.Node[] = []; leaves(target, l); return l.some(x => targetNames(x, name)); };
  const keys = (o: ts.Node) => { const e = peel(o); return ts.isObjectLiteralExpression(e) ? e.properties.some(p => (ts.isShorthandPropertyAssignment(p) ? p.name.text === name : p.name !== undefined && keyOf(p.name) === name)) : false; };
  walk(sf, n => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && hit(n.left)) out.push(n);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && hit(n.operand)) out.push(n);
    if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer) && hit(n.initializer)) out.push(n);
    if (ts.isDeleteExpression(n) && hit(n.expression)) out.push(n);
    if (ts.isCallExpression(n) && n.arguments.length) {
      const callee = peel(n.expression);
      if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || !HOLDER_CALLS[callee.expression.text]?.includes(callee.name.text)) return;
      const root = holderRoot(n.arguments[0]!), key = n.arguments[1] ? keyOf(n.arguments[1]) : null;
      const onHolder = root !== null && holders.has(root), spelled = n.arguments.slice(1).some(keys);
      if (onHolder || key === name || spelled) out.push(n);
    }
  });
  return out;
}
/** The workerData property assignments of the (single) `new Worker(` call in wal-maintenance.ts. */
function spawnProps(sf: ts.SourceFile): Map<string, ts.Expression> {
  const props = new Map<string, ts.Expression>();
  walk(sf, n => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Worker" && n.arguments?.[1] && ts.isObjectLiteralExpression(n.arguments[1]))
      for (const p of n.arguments[1].properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "workerData" && ts.isObjectLiteralExpression(p.initializer))
        for (const q of p.initializer.properties) { if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer); else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name); else props.set("?" + q.pos, q as never); }
  });
  return props;
}

/** Resolve each runtime reference in its lexical scope; only unbound names may use worker globals. */
export function freeIdentifiers(fn: ts.FunctionDeclaration, allowed: readonly string[] = []): string[] {
  const sf = fn.getSourceFile();
  const host = ts.createCompilerHost({});
  host.getSourceFile = file => file === sf.fileName ? sf : undefined;
  const checker = ts.createProgram([sf.fileName], { noLib: true, noResolve: true }, host).getTypeChecker();
  const free = new Set<string>();
  const inside = (n: ts.Node): boolean => n === fn || Boolean(n.parent && inside(n.parent));
  const visit = (n: ts.Node) => {
    if (ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n) ||
          ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return;
      // Shorthand properties have their own property symbol; resolve the value binding instead.
      const symbol = ts.isShorthandPropertyAssignment(p) ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(n);
      if (symbol?.declarations?.length) {
        if (symbol.declarations.some(d => !inside(d))) free.add(n.text);
      } else if (!allowed.includes(n.text)) free.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return [...free].sort();
}
/** The design's closure set (BigInt64Array, Atomics, BigInt, Math, Number) plus the two worker-global builtins the ledger reads (Error, performance) and `undefined`. None is a module binding. */
export const LEDGER_ALLOWED = ["Atomics", "BigInt", "BigInt64Array", "Error", "Math", "Number", "performance", "undefined"];

// Pins by normalized-text hash (printer output without comments: whitespace and comment edits do not move them; any code edit does).
export const PINS = {
  overrideAllowed: "60fadd187e73002860ea77879bafa8f51ab0308d7fbaef600da296321837d750",
  explicitOverride: "58586fa2246420147392651082e62050bb043ef40a3b2547a880163d5937d29e",
  candidates: "d2be05d29a76a863c82cd55ce99d5e0548dd7583caccb684f2f1573569fa8278",
  loadIoMeterAddon: "a364a2fd8a1630df08c1d3de23dc203b548ac4f7381f58a0fc9c9fda260185b8", // re-pinned (METERDL): a worker returns the main thread's handed copy and never makes its own
  loadHandedIoMeter: "2a29cc9d35d74114cf8ec22a3cc28d4502e36d7c423af2a8e29ec94534af654c", // METERDL: the worker's re-check of the handed copy (canonical file, dev/ino/size/sha256) before require
  privateCopy: "640e758ca00036f5a34b0010da9ab6322bcda6f9b0feecb5f6790b2bc4eb220e", // re-pinned: the copy is written in full and proven by a no-follow read-back (inode, size, sha256) like the worker's loadNativeMeter, instead of fsync barriers
  loadExclusionAddon: "05390c26b2a0ef62b3e1dc0f14f4d182375b6576b064c5473172d7424b88254c", // re-pinned for bd9a612caa: the catch records the Windows code-integrity verdict only (no candidate is admitted differently)
  ensureIoMeter: "d143eff95191a0309976397ef9ed8ae229bbae4dde643537d7af6286ebc406d8",
  ioMeterNativePath: "5b7ad4c0169959994279c0228b263a500eee230658f7179911e568e667f6dfb7",
  loadNativeMeter: "2916598ff02e989c5ff5bd9dd8c436fe58131309757886892753635654902ae6",
};

function fnText(sf: ts.SourceFile, name: string): string | null { const f = findFn(sf, name); return f.length === 1 ? norm(f[0]!, sf) : null; }

export function walGuard(src: GuardSources): string[] {
  const v: string[] = [];
  const sfs = Object.fromEntries(GUARD_FILES.map(f => [f, parse(f, src[f])])) as Record<(typeof GUARD_FILES)[number], ts.SourceFile>;
  const bare = Object.fromEntries(GUARD_FILES.map(f => [f, stripComments(src[f])])) as Record<(typeof GUARD_FILES)[number], string>;
  // ---- D5: no test seam in the owned files (and none read by production)
  const SEAM = /\b(walMaintenanceTestHooks|walWorkerSeam|onWalPass|passListeners|lastRequestedPass|requestedPass|registerTestHandle|setAdmissionClockOffsetForFixture|resetAdmissionForFixture|admissionClockOffset(Ms)?|beforeRunning|parkAt|takeHold|awaitGate|gateHeld|paceTrace|unreadableReads|restartDelaysMs|failureLogGapMs|retryMs)\b/;
  for (const f of GUARD_FILES) {
    for (const m of bare[f].matchAll(new RegExp(SEAM.source, "g"))) v.push(`seam: ${f} holds the test seam "${m[1]}"`);
    if (f === WM && /\b(holdMs|holdStart|holdGate)\b/.test(bare[f])) v.push(`seam: ${f} holds a test hold`);
    walk(sfs[f], n => { if (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) { const nm = (n as { name?: ts.Node }).name; if (nm && ts.isIdentifier(nm) && /TestHooks|Seam|ForFixture/.test(nm.text)) v.push(`seam: ${f} declares "${nm.text}"`); } });
  }
  if (/workerData\.(barrier|trace|admissionClockOffsetMs)\b/.test(bare[WM])) v.push("seam: wal-maintenance.ts reads a workerData field only tests set");
  for (const k of spawnProps(sfs[WM]).keys()) if (!["file", "shared", "copied", "admission", "admissionSource", "nativeMeterPath", "nativeMeterId", "osPageSize", "stepBytes", "pollMs", "dueMs", "debtBytes", "debtFd"].includes(k)) v.push(`seam: workerData field "${k}" is not on the production list`);
  const rap = findFn(sfs[IB], "readAdmissionProcess");
  if (rap.length !== 1 || rap[0]!.parameters.length !== 0) v.push("seam: readAdmissionProcess takes a parameter (a dependency override only tests pass)");
  // ---- P3: exactly one eval-family call, the (0,eval) at the admission site; none anywhere else in the five files
  for (const f of GUARD_FILES) {
    const t = bare[f].replace(/\s+/g, "");
    const evals = t.match(/\beval\b/g)?.length ?? 0, okEval = t.match(/\(0,eval\)\(/g)?.length ?? 0, evalOpt = t.match(/\beval:true/g)?.length ?? 0;
    if (f === WM) { if (okEval !== 1 || evalOpt !== 1 || evals !== okEval + evalOpt) v.push(`P3: ${f} does not hold exactly the audited eval sites (found ${evals} eval tokens, ${okEval} (0,eval) calls)`); }
    else if (evals !== 0) v.push(`P3: ${f} holds an eval`);
    if (/\.eval\b/.test(bare[f])) v.push(`P3: ${f} holds a member-form eval`);
    if (/\bFunction\s*\(|\bnew\s+Function\b|\.constructor\s*\(/.test(bare[f])) v.push(`P3: ${f} holds Function(...) or new Function`);
  }
  // wal-maintenance.ts: the audited evals are admissionSource (ledger) and the worker-source-only one is gone; allow exactly the (0,eval) at the admission site
  if (!/admission=workerData\.admission&&workerData\.admissionSource\?\(0,eval\)\("\("\+workerData\.admissionSource\+"\)"\)\(/.test(bare[WM].replace(/\s+/g, ""))) v.push("P3: the admission (0,eval) site is not the audited shape");
  // ---- P1/P2: the ledger
  const led = findFn(sfs[AS], "checkpointLedger");
  if (led.length !== 1 || !led[0]!.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) v.push("P2: admission-shared.ts does not export exactly one static function declaration checkpointLedger");
  else {
    const free = freeIdentifiers(led[0]!, LEDGER_ALLOWED);
    if (free.length) v.push(`P1: checkpointLedger closes over ${free.join(", ")}`);
  }
  if (assignsTo(sfs[AS], "checkpointLedger").length || declsOf(sfs[AS], "checkpointLedger").length !== 1) v.push("P2: admission-shared.ts reassigns or redeclares checkpointLedger");
  const imp = importSpecifier(sfs[WM], "checkpointLedger");
  if (!imp || imp.from !== "./admission-shared.ts" || imp.imported !== "checkpointLedger") v.push("P2: wal-maintenance.ts checkpointLedger is not the ImportSpecifier of ./admission-shared.ts");
  if (declsOf(sfs[WM], "checkpointLedger").length !== 1 || assignsTo(sfs[WM], "checkpointLedger").length) v.push("P2: checkpointLedger is shadowed or assigned in wal-maintenance.ts");
  const spawn = spawnProps(sfs[WM]), adm = spawn.get("admissionSource");
  if (!adm || norm(adm, sfs[WM]) !== "checkpointLedger.toString()") v.push("P2: admissionSource is not checkpointLedger.toString()");
  // ---- P4: native producer
  const impN = importSpecifier(sfs[WM], "ioMeterNativePath"), np = spawn.get("nativeMeterPath");
  if (!impN || impN.from !== "./io-meter.ts" || impN.imported !== "ioMeterNativePath") v.push("P4: ioMeterNativePath is not the ImportSpecifier of ./io-meter.ts");
  if (declsOf(sfs[WM], "ioMeterNativePath").length !== 1 || assignsTo(sfs[WM], "ioMeterNativePath").length) v.push("P4: ioMeterNativePath is shadowed or assigned in wal-maintenance.ts");
  if (!np || norm(np, sfs[WM]) !== "ioMeterNativePath()") v.push("P4: nativeMeterPath is not the zero-argument call ioMeterNativePath()");
  if (assignsTo(sfs[IM], "ioMeterNativePath").length || findFn(sfs[IM], "ioMeterNativePath").length !== 1) v.push("P4: io-meter.ts reassigns or redeclares ioMeterNativePath");
  // ---- P5a/P5b: qualification before return, publication after load
  const impL = importSpecifier(sfs[IM], "loadIoMeterAddon");
  if (!impL || impL.from !== "./engine-exclusion.ts" || impL.imported !== "loadIoMeterAddon") v.push("P5a: loadIoMeterAddon is not the ImportSpecifier of ./engine-exclusion.ts");
  if (declsOf(sfs[IM], "loadIoMeterAddon").length !== 1 || assignsTo(sfs[IM], "loadIoMeterAddon").length) v.push("P5a: loadIoMeterAddon is shadowed or assigned in io-meter.ts");
  const lio = findFn(sfs[EE], "loadIoMeterAddon");
  if (lio.length !== 1) v.push("P5a: engine-exclusion.ts does not hold exactly one loadIoMeterAddon");
  else {
    const rets: ts.ReturnStatement[] = []; walk(lio[0]!, n => { if (ts.isReturnStatement(n)) rets.push(n); });
    const cond = (r: ts.Node) => { let p: ts.Node | undefined = r.parent; while (p && !ts.isIfStatement(p)) p = p.parent; return p && ts.isIfStatement(p) ? norm(p.expression, sfs[EE]).replace(/\s+/g, "") : ""; };
    // METERDL: off the main thread the loader returns only the main thread's proven copy (loadHandedIoMeter, pinned below), never a copy of its own.
    const handed = rets.filter(r => r.expression && norm(r.expression, sfs[EE]).replace(/\s+/g, "") === "loadHandedIoMeter(require)");
    if (handed.length !== 1 || cond(handed[0]!) !== "!isMainThread") v.push("P5a: off the main thread loadIoMeterAddon does not return only the handed copy (one copy per worker)");
    const nonNull = rets.filter(r => !(r.expression && r.expression.kind === ts.SyntaxKind.NullKeyword) && !handed.includes(r));
    if (nonNull.length !== 1 || cond(nonNull[0]!) !== "usable(addon,Boolean(explicit)&&file===explicit)&&addon.ioMeterAdd&&addon.ioMeterTotal&&addon.ioMeterBytes" || norm(nonNull[0]!.expression!, sfs[EE]).replace(/\s+/g, "") !== "{addon,path:held.copy,id:held.id}") v.push("P5a: loadIoMeterAddon returns a non-null value other than the qualified private copy (qualification bypass)");
  }
  const ens = findFn(sfs[IM], "ensureIoMeter");
  const pathAssigns = assignsTo(sfs[IM], "nativeMeterPath");
  if (pathAssigns.length !== 1 || ens.length !== 1) v.push("P5b: nativeMeterPath is not assigned exactly once in ensureIoMeter");
  else {
    const a = pathAssigns[0] as ts.BinaryExpression, blk = a.parent.parent as ts.Block;
    const stmts = ts.isBlock(blk) ? blk.statements.map(s => norm(s, sfs[IM]).replace(/\s+/g, "")) : [];
    const k = stmts.indexOf(norm(a.parent, sfs[IM]).replace(/\s+/g, ""));
    if (norm(a.right, sfs[IM]) !== "path" || k < 2 || !stmts[k - 2]!.startsWith('db.loadExtension(path,"sqlite3_muragemeter_init")') || stmts[k - 1] !== "db.enableLoadExtension(false);" || !a.getFullText(sfs[IM]) || !(ens[0]!.pos <= a.pos && a.end <= ens[0]!.end)) v.push("P5b: nativeMeterPath is not published only after loadExtension and enableLoadExtension(false), from the loader's path");
  }
  const inp = findFn(sfs[IM], "ioMeterNativePath")[0];
  if (inp) { const rs: ts.ReturnStatement[] = []; walk(inp, n => { if (ts.isReturnStatement(n)) rs.push(n); }); if (rs.length !== 1 || !rs[0]!.expression || norm(rs[0]!.expression, sfs[IM]) !== "nativeMeterPath") v.push("P4: ioMeterNativePath returns something other than nativeMeterPath"); }
  // ---- P5c-P5g: exact pins on the loader chain (hash of the printed function) and the worker's own check
  const eeTexts: Record<string, string | null> = {};
  for (const n of ["overrideAllowed", "explicitOverride", "candidates", "loadIoMeterAddon", "privateCopy", "loadExclusionAddon", "loadHandedIoMeter"]) eeTexts[n] = fnText(sfs[EE], n);
  for (const [n, t] of Object.entries(eeTexts)) if (t === null || sha(t) !== (PINS as Record<string, string>)[n]) v.push(`P5: engine-exclusion.ts ${n} differs from its pin`);
  const ensT = fnText(sfs[IM], "ensureIoMeter"), nat = fnText(sfs[IM], "ioMeterNativePath");
  if (ensT === null || sha(ensT) !== PINS.ensureIoMeter) v.push("P5b: io-meter.ts ensureIoMeter differs from its pin");
  if (nat === null || sha(nat) !== PINS.ioMeterNativePath) v.push("P4: io-meter.ts ioMeterNativePath differs from its pin");
  let calls = 0; walk(sfs[EE], n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "overrideAllowed") { calls++; if (n.arguments.length) v.push("P5c: overrideAllowed is called with an argument"); } });
  if (calls < 2) v.push("P5c: overrideAllowed is not called by candidates() and explicitOverride()");
  let loops = 0; walk(sfs[EE], n => { if (ts.isForOfStatement(n) && norm(n.initializer, sfs[EE]) === "const file") { loops++; if (norm(n.expression, sfs[EE]) !== "candidates()") v.push("P5e: a loader iterates something other than candidates()"); } });
  if (loops !== 2) v.push(`P5e: expected exactly two loader loops over candidates(), found ${loops}`);
  const cand = findFn(sfs[EE], "candidates")[0];
  if (cand) { let pushes = 0; walk(cand, n => { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push") { pushes++; if (!(n.arguments.length === 1 && /^path\.resolve\(/.test(norm(n.arguments[0]!, sfs[EE])))) v.push("P5d: a candidates() push is not wrapped in path.resolve"); } }); if (pushes !== 4) v.push(`P5e: candidates() holds ${pushes} pushes, expected 4`); }
  // the worker's own check, in the worker source: absolute, regular, canonical, O_NOFOLLOW, sha256 before require
  const w = bare[WM].replace(/\s+/g, ""), wi = w.indexOf("functionloadNativeMeter(p,id){");
  const body = wi < 0 ? "" : w.slice(wi, w.indexOf("returnrequire(p);}", wi) + 18);
  for (const need of ["path.isAbsolute(p)", "lstatSync(p).isFile()", "realpathSync(p)!==p", "O_RDONLY|(fs.constants.O_NOFOLLOW||0)", "st.dev!==id.dev||st.ino!==id.ino||st.size!==id.size", 'createHash("sha256")', "!==id.sha256"]) if (!body.includes(need)) v.push(`P5g: the worker's native meter check lacks ${need}`);
  if ((w.match(/require\(workerData\.nativeMeterPath/g)?.length ?? 0) || (w.match(/require\(p\)/g)?.length ?? 0) !== 1 || !w.includes("loadNativeMeter(workerData.nativeMeterPath,workerData.nativeMeterId)")) v.push("P5g: the worker requires the meter path other than through loadNativeMeter");
  const lnm = body ? sha(body) : "";
  if (lnm !== PINS.loadNativeMeter) v.push("P5g: the worker's loadNativeMeter differs from its pin");
  return v;
}
