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
function assignsTo(sf: ts.SourceFile, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  walk(sf, n => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left) && n.left.text === name) out.push(n);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(n.operand) && n.operand.text === name) out.push(n);
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
  loadIoMeterAddon: "6bc58e42cff9394b120e0f03ff4555a076b3a0ad2349c431d6610ca7a682e95e",
  privateCopy: "d7f708b9e289c87019b2a349758968340e4d1cbbb4a01905c37930ca41a79c72",
  loadExclusionAddon: "30a1a160e9689d08df062b0df88bff854bcc4f0e5c68b83913241725775ca8a7",
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
    const nonNull = rets.filter(r => !(r.expression && r.expression.kind === ts.SyntaxKind.NullKeyword));
    const cond = (r: ts.Node) => { let p: ts.Node | undefined = r.parent; while (p && !ts.isIfStatement(p)) p = p.parent; return p && ts.isIfStatement(p) ? norm(p.expression, sfs[EE]).replace(/\s+/g, "") : ""; };
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
  for (const n of ["overrideAllowed", "explicitOverride", "candidates", "loadIoMeterAddon", "privateCopy", "loadExclusionAddon"]) eeTexts[n] = fnText(sfs[EE], n);
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
