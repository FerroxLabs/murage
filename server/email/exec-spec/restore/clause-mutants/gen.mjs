// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT GENERATOR (r3.4d restore plan, step 1). Uses the TypeScript compiler API to find every enforced clause in the body of each
// of the registered predicates (STEP_INVARIANTS, STATE_INVARIANTS, TRACE_INVARIANTS of invariants.current.ts) and writes:
//   clauses.json            one entry per clause: id "<predicate>#<n>" (source order), kind, clause text, 1-based line
//   invariants.cm-schema.ts a mutant-schema copy of the spec: every clause is wrapped so that setting __CM to its id removes it
// Clause kinds (the plan's list):
//   op       each operand of a top-level && / || chain in a checked condition (if / while / for / ternary condition), a returned
//            expression, an arrow body (.every / .some / .filter / .find callbacks included) or a boolean initializer;
//            removed = replaced by the chain's identity (true in &&, false in ||)
//   guard    each `if (...) return <violation>` (violation = fail(...), {ok:false}, or a reason string), and each ternary returning a
//            violation on one side; removed = the condition never selects the violation
//   branch   each early-reject branch: an `if` whose block ends in `return <violation>` (more than one statement); removed = skipped
// Usage: node gen.mjs <invariants.current.ts> <outDir>
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const ts = require(process.env.TS_PATH || "typescript");

const [src, outDir] = process.argv.slice(2);
const text = fs.readFileSync(src, "utf8");
const sf = ts.createSourceFile(src, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;

// 1. the registered predicate names
const names = [];
const decls = new Map();
for (const st of sf.statements) {
  if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
    const n = d.name.getText(sf);
    if (["STEP_INVARIANTS", "STATE_INVARIANTS", "TRACE_INVARIANTS"].includes(n)) {
      let init = d.initializer; while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
      for (const p of init.properties) names.push(p.name.getText(sf));
    } else if (d.initializer) decls.set(n, d.initializer);
  } else if (ts.isFunctionDeclaration(st) && st.name) decls.set(st.name.text, st);
}
if (names.length !== 39) throw new Error("expected 39 registered predicates, found " + names.length);

const strip = e => { while (ts.isParenthesizedExpression(e)) e = e.expression; return e; };
const isViolation = e => {
  if (!e) return false; e = strip(e);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "fail") return true;
  if (ts.isStringLiteral(e) || ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isObjectLiteralExpression(e)) return e.properties.some(p => p.name && p.name.getText(sf) === "ok" && p.initializer && p.initializer.kind === ts.SyntaxKind.FalseKeyword);
  if (ts.isConditionalExpression(e)) return isViolation(e.whenTrue) || isViolation(e.whenFalse);
  return false;
};
const returnsViolation = s => !!s && ts.isReturnStatement(s) && isViolation(s.expression);
const valueLiteral = e => { e = strip(e); return ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e) || ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e); };

// DIRECTION of a removal: "weaker" = the predicate can only accept more (closed by a must-reject witness or a proven redundancy);
// "stricter" = it can only reject more (closed by a must-accept witness); "?" = not decidable from the syntax (callbacks, initializers).
const isExempt = s => !!s && (ts.isContinueStatement(s) || ts.isBreakStatement(s) || (ts.isReturnStatement(s) && !!s.expression && ts.isIdentifier(strip(s.expression)) && strip(s.expression).text === "OK") || (ts.isBlock(s) && s.statements.length === 1 && isExempt(s.statements[0])));
const ifBase = node => { const t = node.thenStatement; if (returnsViolation(t) || (ts.isBlock(t) && t.statements.length >= 1 && returnsViolation(t.statements[t.statements.length - 1]))) return "reject"; if (isExempt(t)) return "exempt"; return null; };
function direction(operand, root, chain, base) {
  if (!base) return "?";
  let neg = 0; for (let n = operand.parent; n && n !== root.parent; n = n.parent) if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) neg++;
  const condMoreTrue = (chain === "&&") !== (neg % 2 === 1);
  return (base === "reject") === condMoreTrue ? "stricter" : "weaker";
}
const clauses = [];
const inserts = []; // { pos, text, order } ; starts: order = -span (outer first); ends: order = +inf
const clip = s => s.replace(/\s+/g, " ").trim().slice(0, 200);
function addWrap(pred, kind, node, replacement, extra) {
  const n = clauses.filter(c => c.predicate === pred).length + 1;
  const id = pred + "#" + n;
  const s = node.getStart(sf), e = node.getEnd();
  clauses.push({ id, predicate: pred, kind, line: lineOf(s), text: clip(node.getText(sf)), ...extra });
  inserts.push({ pos: s, text: "(__CM === " + JSON.stringify(id) + " ? " + replacement + " : (", order: -(e - s), seq: inserts.length });
  inserts.push({ pos: e, text: "))", order: Number.MAX_SAFE_INTEGER, seq: inserts.length });
}
// a chain: flatten the top-level operator; nothing below it (the plan says top-level)
function chainOps(e) {
  e = strip(e);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) e = strip(e.operand);
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  if (op !== ts.SyntaxKind.AmpersandAmpersandToken && op !== ts.SyntaxKind.BarBarToken) return null;
  const out = [];
  const walk = x => { const y = strip(x); if (ts.isBinaryExpression(y) && y.operatorToken.kind === op && x === y) { walk(y.left); walk(y.right); } else out.push(x); };
  walk(e.left); walk(e.right);
  return { op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||", ops: out };
}
function addChain(pred, e, ctx, base = null) {
  const c = chainOps(e); if (!c) return;
  if (c.ops.some(valueLiteral)) return; // `x || []` style defaults are values, not clauses
  for (const o of c.ops) addWrap(pred, "op", o, c.op === "&&" ? "true" : "false", { ctx, chain: c.op, dir: direction(o, e, c.op, base) });
}
function visit(pred, node) {
  // a violation message is text, not a clause: never descend into fail(...) arguments or template strings
  if ((ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fail") || ts.isTemplateExpression(node)) return;
  if (ts.isIfStatement(node)) {
    addChain(pred, node.expression, "if", ifBase(node));
    const t = node.thenStatement;
    if (returnsViolation(t) || (ts.isBlock(t) && t.statements.length === 1 && returnsViolation(t.statements[0]))) addWrap(pred, "guard", node.expression, "false", { ctx: "if-return-violation", dir: "weaker" });
    else if (ts.isBlock(t) && t.statements.length > 1 && returnsViolation(t.statements[t.statements.length - 1])) addWrap(pred, "branch", node.expression, "false", { ctx: "early-reject-block", dir: "weaker" });
  } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) addChain(pred, node.expression, "loop");
  else if (ts.isForStatement(node) && node.condition) addChain(pred, node.condition, "loop");
  else if (ts.isConditionalExpression(node)) {
    const vt = isViolation(node.whenTrue), vf = isViolation(node.whenFalse);
    addChain(pred, node.condition, "ternary", vt !== vf ? (vt ? "reject" : "exempt") : null);
    if (vt !== vf) addWrap(pred, "guard", node.condition, vt ? "false" : "true", { ctx: "ternary-violation", dir: "weaker" });
  } else if (ts.isReturnStatement(node) && node.expression) addChain(pred, node.expression, "return");
  else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) addChain(pred, node.body, "arrow");
  else if (ts.isVariableDeclaration(node) && node.initializer && !ts.isArrowFunction(node.initializer)) addChain(pred, node.initializer, "init");
  ts.forEachChild(node, ch => visit(pred, ch));
}
for (const n of names) {
  const d = decls.get(n); if (!d) throw new Error("no declaration for " + n);
  const body = ts.isFunctionDeclaration(d) ? d.body : d.body ?? d;
  ts.forEachChild(body, ch => visit(n, ch));
  if (!ts.isBlock(body)) visit(n, body);
}
// 2. the schema copy: pure insertions, applied right to left
inserts.sort((a, b) => b.pos - a.pos || b.order - a.order || b.seq - a.seq);
let out = text;
for (const i of inserts) out = out.slice(0, i.pos) + i.text + out.slice(i.pos);
out = "// @ts-nocheck\n// GENERATED by clause-mutants/gen.mjs: never commit\nexport let __CM = \"\";\nexport function __setCM(x) { __CM = x; }\n" + out;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "clauses.json"), JSON.stringify({ source: path.basename(src), predicates: names, clauses }, null, 1));
fs.writeFileSync(path.join(path.dirname(src), "invariants.cm-schema.ts"), out);
const by = {}; for (const c of clauses) by[c.predicate] = (by[c.predicate] || 0) + 1;
console.log("clauses " + clauses.length + " (op " + clauses.filter(c => c.kind === "op").length + ", guard " + clauses.filter(c => c.kind === "guard").length + ", branch " + clauses.filter(c => c.kind === "branch").length + ")");
console.log(names.map(n => n + "=" + (by[n] || 0)).join(" "));
