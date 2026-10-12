// Who may a bot read for, worked out once per pass instead of once per ask.
//
// One idle poll of the procedure-review queue asks for up to 64 parked
// reviews, and each ask walked the whole roster, confirming every room and
// thread scope by primary key (976,072 confirmations in one minute on the
// live store). Inside one synchronous pass the answer for a bot and thread
// is computed once. The memo is only ever trusted while nothing has changed:
// any row this connection writes (total_changes), a new roster.bots or
// roster.groups array, or a change in their lengths ends it, and it is gone
// when the pass returns. In-place edits of a room or bot (members, tasks,
// team) are NOT seen, so the work inside a pass must never change the roster;
// the one pass today (the idle procedure-review poll) only reads it. Outside
// a pass every ask is computed fresh, as before.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { withStatementReuse, writeStamp } from "../io-budget.ts";

interface Pass { db: DatabaseSync; changes: number; roster: object | null; groups: object | null; shape: string; answers: Map<string, string[]>; lookups: Map<string, unknown>; lookupChanges: number }
let active: Pass | null = null;
const counters = new WeakMap<object, StatementSync>();

function totalChanges(db: DatabaseSync): number {
  const stamp = writeStamp(db);  // a counter of this connection's writes, when the handle is instrumented: no statement to run
  if (stamp !== undefined) return stamp;
  let statement = counters.get(db);
  if (!statement) { statement = db.prepare("SELECT total_changes() AS n"); counters.set(db, statement); }
  return Number(statement.get()?.n);
}
const shapeOf = (roster: { bots: readonly unknown[]; groups: readonly unknown[] }) => `${roster.bots.length}:${roster.groups.length}`;

/** Run `work` (synchronous) with eligibility answers remembered inside it. Nested passes share the outer one. */
export function inEligibilityPass<T>(db: DatabaseSync, work: () => T): T {
  if (active) return work();
  active = { db, changes: totalChanges(db), roster: null, groups: null, shape: "", answers: new Map(), lookups: new Map(), lookupChanges: -1 };
  try { return withStatementReuse(work); } finally { active = null; }
}

/** The remembered answer for `key` under this roster, or `compute()` (remembered when nothing changed meanwhile). */
export function eligibilityAnswer(db: DatabaseSync, key: string, roster: { bots: readonly unknown[]; groups: readonly unknown[] }, compute: () => string[]): string[] {
  const pass = active;
  if (!pass || pass.db !== db) return compute();
  const now = totalChanges(db), shape = shapeOf(roster);
  if (now !== pass.changes || pass.roster !== roster.bots || pass.groups !== roster.groups || pass.shape !== shape) {
    pass.answers.clear(); pass.changes = now; pass.roster = roster.bots; pass.groups = roster.groups; pass.shape = shape;
  }
  const known = pass.answers.get(key);
  if (known) return [...known];
  const fresh = compute();
  // computing may itself have written (a scope created on demand): then it is not remembered
  if (totalChanges(db) === now) pass.answers.set(key, [...fresh]);
  return fresh;
}

/** A row lookup remembered for the rest of this pass, ended by any row this connection writes (total_changes).
 * For lookups that read only the database (a thread's human binding): a binding written or revoked is seen at once.
 * Outside a pass, or on another connection, it is `compute()` every time. */
export function passLookup<T>(db: DatabaseSync, key: string, compute: () => T): T {
  const pass = active;
  if (!pass || pass.db !== db) return compute();
  const now = totalChanges(db);
  if (pass.lookupChanges !== now) { pass.lookups.clear(); pass.lookupChanges = now; }
  if (pass.lookups.has(key)) return pass.lookups.get(key) as T;
  const fresh = compute();
  if (totalChanges(db) === now) pass.lookups.set(key, fresh);
  return fresh;
}
