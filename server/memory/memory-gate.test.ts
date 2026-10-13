// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R2-01 (lanes/upgfast-review/r2): one memory gate before every effect. The policy of the gate, and a structural proof (over the sources, with the
// TypeScript compiler API) that every place that publishes a procedure change, undoes one, writes feedback, writes a lesson or ledger row, or
// renders learned words asks the gate first, and that the table below names exactly those places.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { expect, it } from "vitest";
import { setIntegrityFlags } from "./integrity-flags.ts";
import { MEMORY_USES, assertMemoryGate, memoryGate } from "./memory-gate.ts";

const SERVER = join(import.meta.dirname, "..");

it("the gate: a hold refuses every use; a pending pass refuses only the uses that read earlier memory", () => {
  const db = new DatabaseSync(":memory:");
  expect(MEMORY_USES.map(use => memoryGate(db, use))).toEqual(MEMORY_USES.map(() => "ok"));
  setIntegrityFlags(db, { hold: "INVALID_MEMORY_REFERENCE" });
  for (const use of MEMORY_USES) expect(memoryGate(db, use), use).toBe("held:INVALID_MEMORY_REFERENCE");
  expect(() => assertMemoryGate(db, "publish-procedure")).toThrow(/set memory aside/);
  setIntegrityFlags(db, { hold: null, pending: true, eventsFloor: 10, lessonsFloor: 10, feedbackFloor: 10 });
  const waits = MEMORY_USES.filter(use => memoryGate(db, use) === "pending");
  expect(waits.sort()).toEqual(["publish-procedure", "replay", "rollback-procedure"]);
  expect(() => assertMemoryGate(db, "publish-procedure")).toThrow(/still going over earlier memory/);
  setIntegrityFlags(db, { pending: false });
  expect(MEMORY_USES.map(use => memoryGate(db, use))).toEqual(MEMORY_USES.map(() => "ok"));
});

it("an Undo of a change recorded after the pass began is not held back by it; one from before is", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE memory_learning_events(id TEXT PRIMARY KEY, x INTEGER)");
  db.exec("INSERT INTO memory_learning_events(id,x) VALUES('old',1),('new',2)"); // rowids 1 and 2
  setIntegrityFlags(db, { pending: true, eventsFloor: 1, lessonsFloor: 0, feedbackFloor: 0 });
  expect(memoryGate(db, "rollback-procedure", { eventId: "old" })).toBe("pending");
  expect(memoryGate(db, "rollback-procedure", { eventId: "new" })).toBe("ok");
  expect(memoryGate(db, "rollback-procedure")).toBe("pending");
});

// ── structural ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The functions (file relative to server/, top-level function name) that carry an effect themselves, and so must ask the gate before it. */
const GATED_ENTRY_POINTS: Record<string, string[]> = {
  "memory/procedure-landing.ts": ["applyProcedureSuggestion", "changeProcedureEvent", "notNowProcedureSuggestion"],
  "memory/procedure-review.ts": ["processProcedureReview"],
  "procedure-review-host.ts": ["createProcedureReviewHost"],
  "memory/feedback.ts": ["recordFeedback"],
  "memory/outcomes.ts": ["insertFeedback"],
  "memory/learning-ledger.ts": ["recordLearningEvent", "recordDefaultLearningConnection"],
  "memory/lessons.ts": ["insertLesson"],
};
/** Functions whose effect only takes back a publication THEY follow (made under a gate that passed): a gate here could leave the change published. */
const COMPENSATING: Record<string, string[]> = { "memory/procedure-landing.ts": ["settleAppliedChange", "reconcilePublishing", "reconcileUndoing", "finishUndo"] };
/** Callees that gate themselves, so their callers need not (the function that holds the effect is in the table above, or is the render itself). */
const CALLEE_GATED: Record<string, { file: string; fn: string }> = {
  recordLearningEvent: { file: "memory/learning-ledger.ts", fn: "recordLearningEvent" },
  insertLesson: { file: "memory/lessons.ts", fn: "insertLesson" },
  renderLearnedBlock: { file: "memory/lessons.ts", fn: "renderLearnedBlock" },
};
const GATE_CALL = /\b(memoryGate|assertMemoryGate)\(/;
const EFFECT_SQL = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(memory_feedback|memory_learning_events|memory_lessons)\b/i;
const EFFECT_METHODS = new Set(["publish", "publishEdited", "publishEvaluated", "rollback"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "testing" || name === "testdata") continue;
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".bench.ts")) out.push(path);
  }
  return out;
}
const topLevel = (node: ts.Node): ts.Node | null => {
  for (let at: ts.Node | undefined = node; at; at = at.parent) if (at.parent && ts.isSourceFile(at.parent)) return at;
  return null;
};
const nameOf = (top: ts.Node | null): string | null => {
  if (!top) return null;
  if (ts.isFunctionDeclaration(top)) return top.name?.text ?? null;
  if (ts.isVariableStatement(top)) { const d = top.declarationList.declarations[0]; return d && ts.isIdentifier(d.name) ? d.name.text : null; }
  return null;
};
const unwrap = (expression: ts.Expression): ts.Expression => (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression);

interface Site { file: string; fn: string | null; at: number; what: string; fnStart: number }
function effectSites(): { direct: Site[]; callees: Site[] } {
  const direct: Site[] = [], callees: Site[] = [];
  for (const path of sources(SERVER)) {
    const file = relative(SERVER, path).split("\\").join("/");
    // the migration and its fixtures write old-format rows by design (they run before any use of memory)
    if (file === "memory/schema.ts") continue;
    const text = readFileSync(path, "utf8");
    if (!/memory_feedback|memory_learning_events|memory_lessons|landingHost|host\.|insertLesson|recordLearningEvent|renderLearnedBlock/.test(text)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let what: string | null = null, bucket = direct;
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee) && callee.text in CALLEE_GATED) { what = callee.text; bucket = callees; }
        else if (ts.isPropertyAccessExpression(callee) && EFFECT_METHODS.has(callee.name.text)) {
          const owner = unwrap(callee.expression);
          if (ts.isIdentifier(owner) && (owner.text === "host" || owner.text === "landingHost")) what = `${owner.text}.${callee.name.text}`;
        }
      } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && EFFECT_SQL.test(node.getText(source))) what = `sql:${EFFECT_SQL.exec(node.getText(source))![1]}`;
      if (what) {
        const top = topLevel(node);
        bucket.push({ file, fn: nameOf(top), at: node.getStart(source), what, fnStart: top ? top.getStart(source) : 0 });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { direct, callees };
}

it("every effect that is not gated by its callee sits in a listed entry point, with the gate asked before it", () => {
  const { direct } = effectSites();
  const text = new Map<string, string>();
  const read = (file: string) => { if (!text.has(file)) text.set(file, readFileSync(join(SERVER, file), "utf8")); return text.get(file)!; };
  const ungated: string[] = [], unlisted: string[] = [];
  for (const site of direct) {
    if (COMPENSATING[site.file]?.includes(site.fn ?? "")) continue;
    const listed = GATED_ENTRY_POINTS[site.file]?.includes(site.fn ?? "");
    if (!listed) { unlisted.push(`${site.file}:${site.fn ?? "?"} (${site.what})`); continue; }
    const before = read(site.file).slice(site.fnStart, site.at);
    if (!GATE_CALL.test(before)) ungated.push(`${site.file}:${site.fn} (${site.what})`);
  }
  expect(unlisted, "an effect outside the table: list its function or route it through a gated one").toEqual([]);
  expect(ungated, "an effect with no gate call before it in its function").toEqual([]);
  // the table covers the uses exactly: every listed function holds at least one effect
  for (const [file, fns] of Object.entries(GATED_ENTRY_POINTS)) for (const fn of fns) {
    expect(direct.some(site => site.file === file && site.fn === fn), `${file}:${fn} is listed but holds no effect`).toBe(true);
  }
});

it("every callee that gates itself asks the gate before its own effect", () => {
  for (const { file, fn } of Object.values(CALLEE_GATED)) {
    const source = ts.createSourceFile(file, readFileSync(join(SERVER, file), "utf8"), ts.ScriptTarget.Latest, true);
    const found = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === fn) as ts.FunctionDeclaration | undefined;
    expect(found, `${file}:${fn}`).toBeTruthy();
    const body = found!.body!.getText(source);
    expect(GATE_CALL.test(body), `${file}:${fn} must call the gate`).toBe(true);
    // and the gate is its first statement that touches the database
    const gateAt = body.search(GATE_CALL), dbAt = body.search(/\.(prepare|exec)\(/);
    expect(dbAt === -1 || gateAt < dbAt || fn === "renderLearnedBlock").toBe(true);
  }
});

it("the gate is the only reader of the hold flag", () => {
  const readers: string[] = [];
  for (const path of sources(SERVER)) {
    const file = relative(SERVER, path).split("\\").join("/");
    if (file === "memory/memory-gate.ts" || file === "memory/integrity-flags.ts") continue;
    if (/\bintegrityHoldCode\b/.test(readFileSync(path, "utf8"))) readers.push(file);
  }
  expect(readers).toEqual([]);
});

it("every update of the learning ledger in the procedure landing sits in a gated entry point or in the completion of one already gated (Keep included)", () => {
  const file = "memory/procedure-landing.ts";
  const text = readFileSync(join(SERVER, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ fn: string | null; at: number; fnStart: number }> = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /UPDATE\s+memory_learning_events\b/i.test(node.getText(source))) {
      const top = topLevel(node);
      found.push({ fn: nameOf(top), at: node.getStart(source), fnStart: top ? top.getStart(source) : 0 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found.length).toBeGreaterThan(0);
  const COMPLETION = new Set([...COMPENSATING[file], "patchDetail"]);
  const bad = found.filter(site => !COMPLETION.has(site.fn ?? "") && !GATE_CALL.test(text.slice(site.fnStart, site.at))).map(site => site.fn);
  expect(bad, "a ledger update with no gate before it in its function").toEqual([]);
});
