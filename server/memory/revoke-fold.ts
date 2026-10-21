// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The revoke fold (1.0.3 REVOKE-FOLD-DESIGN r3 + r4, amending REVOKE-STORM-DESIGN-M M4). 1.0.2 left a backlog of audience-only revokes (one per
// flipped receipt), each walking about the whole store, one at a time. A cohort of them whose caps no turn position separates is folded into
// ONE audience bulk revoke B: B's root and cap cover every member's, its '*' window covers every member's from its first row, and each
// member's roots, frontier and holds are copied into B before the member's own rows go. B then walks once.
//   F1.1  eligible: active, audience-only, kind receipt/bulk/inherit, phase flow/mark/hold, readable root, never a fold bulk (root cause
//         "fold" or a bulk_id in memory_revoke_fold, r4 A2), never an upgrade seed. A cohort is a maximal run in revoke_id order, at most
//         FLIP_DRAIN_MAX long, whose [min started_lsn, max started_lsn) holds no turn position: no line turn_lsn, no session first_lsn, no
//         open turn of this process (each open turn tested, r4 A1).
//   F1.2  B: root_lsn = min of the members', started_lsn = hi, root {kind:"bulk", cause:"fold", cohort:{lo, hi, ids}}.
//   F1.3  stages in B's cursor ({fold: {stage, job, after}}), one page per step, saved in the slice's transaction:
//         (0) open (B, its lsns, root and '*' rows) -> enrol (map rows) -> per member: root (a receipt re-committed into B) -> frontier
//         (flow items re-seeded, mark nodes copied, fresh seqs) -> holds (hold: rows copied, paged; the member turns 'folded') -> clean (its
//         pending, scope, frontier and reached rows go) -> sweep (no member row left) -> activate.
//   F1.5  every step is a keyed insert or a resumable page; a restart resumes B from its cursor (no new cohort test).
// The fold takes the marker's turn: while B seeds no slice advances any job (revoke-marker.ts runMarkerSlice), so a member's rows are static.
import type { DatabaseSync } from "node:sqlite";
import { openTurnPositions } from "./lineage-write.ts";
import { FLIP_DRAIN_MAX } from "./receipt-outputs.ts";
import { MARKER_SLICE_ROWS, PENDING_ALL_THREADS } from "./lineage-types.ts";
import { activateBulkRevoke, commitRevoke, openBulkRevoke, receiptCommitCost } from "./revoke-commit.ts";
import { bumpDenyGeneration, HOLD_PREFIX, hasFoldMap, hasWritetime, markPending, PENDING_ALL_SCOPES, seedFlow, setFoldHooks, st, totalChanges, type FoldBudget } from "./revoke-marker.ts";

export const FOLD_CAUSE = "fold";
/** Tests only (a per-job baseline run for the differential test): false leaves every job to walk on its own. */
export const REVOKE_FOLD = { enabled: true };
/** The fold's pending copy and closure certificate (DRAIN-104 section 4). A test knob, as REVOKE_FOLD: off is 1.0.3's fold (the frontier stage
 * goes straight to "holds" and ignores a `pk` cursor; no closureIds, no narrow), the fail-first control of the section-4 tests. */
export const FOLD_CLOSURE = { enabled: true };
/** Rows opening a bulk writes (revoke-commit.ts BULK_OPEN_COST): a member's root re-commit is admitted with room for it too (F1.3). */
const FOLD_OPEN_COST = 8;
export type FoldCohort = { lo: number; hi: number; ids: number[] };
type Stage = "enrol" | "root" | "frontier" | "holds" | "clean" | "sweep";
/** `after`: the last frontier seq copied; `key`: the last hold thread_id copied (both resume a member's copy mid-way, F1.5). */
/** `pk`: the member's pending copy (DRAIN-104 section 4), present iff it is running: [table (0 threads, 1 scopes), key, since] of the last
 * row copied. Inside stage "frontier", so a 1.0.3 that resumes the cursor finds no frontier row after `after`, moves to "holds" and ignores it. */
type FoldCursor = { stage: Stage; job: number; after?: number; key?: string; pk?: [number, string, number] };
type Candidate = { id: number; kind: string; root: Record<string, any>; rootLsn: number; started: number };

const SEEDING_FOLD = `SELECT revoke_id,root,cursor FROM memory_revoke_jobs WHERE state='seeding' AND kind='bulk' AND json_valid(root)
  AND json_extract(root,'$.cause')='fold' ORDER BY revoke_id LIMIT 1`;
const seedingFold = (db: DatabaseSync) => st(db, SEEDING_FOLD).get() as { revoke_id: number; root: string; cursor: string } | undefined;

/** Connections whose listen-time fold is decided (a stopped process's backlog is folded once per start; a new connection is a new start). */
const listened = new WeakSet<DatabaseSync>();
/** The candidate set a runner decision last found unfoldable: the same set is not tested again (a position inside an interval stays). */
const lastNegative = new WeakMap<DatabaseSync, string>();

/** The eligible jobs (F1.1, r4 A2), in revoke_id order. */
export function foldCandidates(db: DatabaseSync, phases: readonly string[]): Candidate[] {
  const rows = st(db, `SELECT revoke_id,kind,root,root_lsn,started_lsn FROM memory_revoke_jobs WHERE state='active' AND kind IN ('receipt','bulk','inherit')
    AND phase IN (SELECT value FROM json_each(?)) AND revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)
    AND revoke_id NOT IN (SELECT bulk_id FROM memory_revoke_fold) ORDER BY revoke_id`).all(JSON.stringify(phases));
  const out: Candidate[] = [];
  for (const row of rows) {
    let root: Record<string, any>;
    try { root = JSON.parse(String(row.root)); } catch { continue; } // unreadable: keeps its own window and walk
    if (!root || typeof root !== "object" || root.cause === FOLD_CAUSE || root.cause === "upgrade-seed") continue;
    if (row.kind === "receipt" && (typeof root.bundleId !== "string" || root.cause !== "receipt-revoked")) continue;
    out.push({ id: Number(row.revoke_id), kind: String(row.kind), root, rootLsn: Number(row.root_lsn), started: Number(row.started_lsn) });
  }
  return out;
}

/** Every turn position in [lo, hi): line turn_lsn, session first_lsn and each open turn's turnLsn (r4 A1), distinct and sorted. One
 * read-only pass over the two tables. */
export function turnPositions(db: DatabaseSync, lo: number, hi: number): number[] {
  const out = new Set<number>();
  if (!(lo < hi)) return [];
  for (const row of st(db, "SELECT DISTINCT turn_lsn AS p FROM memory_line_lineage WHERE turn_lsn>=? AND turn_lsn<?").all(lo, hi)) out.add(Number(row.p));
  for (const row of st(db, "SELECT DISTINCT first_lsn AS p FROM memory_session_lineage WHERE first_lsn>=? AND first_lsn<?").all(lo, hi)) out.add(Number(row.p));
  for (const p of openTurnPositions()) if (p >= lo && p < hi) out.add(p);
  return [...out].sort((a, b) => a - b);
}
/** Whether a sorted list holds a value in [lo, hi). */
function anyIn(sorted: readonly number[], lo: number, hi: number): boolean {
  let a = 0, b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m]! < lo) a = m + 1; else b = m; }
  return a < sorted.length && sorted[a]! < hi;
}
/** The cohorts of `jobs` (revoke_id order): maximal runs, at most FLIP_DRAIN_MAX long, whose [min started, max started) holds no turn
 * position; a position ends a cohort before the job that would bring it inside. */
export function foldCohorts(db: DatabaseSync, jobs: readonly Candidate[], max: number = FLIP_DRAIN_MAX): FoldCohort[] {
  if (!jobs.length) return [];
  const lo = Math.min(...jobs.map(job => job.started)), hi = Math.max(...jobs.map(job => job.started));
  const positions = turnPositions(db, lo, hi);
  const out: FoldCohort[] = [];
  let cur: FoldCohort = { lo: jobs[0]!.started, hi: jobs[0]!.started, ids: [jobs[0]!.id] };
  for (const job of jobs.slice(1)) {
    const nlo = Math.min(cur.lo, job.started), nhi = Math.max(cur.hi, job.started);
    if (cur.ids.length < max && !anyIn(positions, nlo, nhi)) { cur.lo = nlo; cur.hi = nhi; cur.ids.push(job.id); continue; }
    out.push(cur);
    cur = { lo: job.started, hi: job.started, ids: [job.id] };
  }
  out.push(cur);
  return out;
}

/** (0) open: B 'seeding' with its lsns, root and '*' rows, one transaction (F1.3). From this commit B alone covers every member's window. */
function openFold(db: DatabaseSync, cohort: FoldCohort, members: readonly Candidate[]): number {
  const B = openBulkRevoke(db, FOLD_CAUSE, true);
  if (!(B > 0)) return 0;
  const rootLsn = Math.min(...members.map(m => m.rootLsn));
  const cursor: { fold: FoldCursor } = { fold: { stage: "enrol", job: 0 } };
  st(db, "UPDATE memory_revoke_jobs SET root=?,root_lsn=?,started_lsn=?,cursor=? WHERE revoke_id=?")
    .run(JSON.stringify({ kind: "bulk", cause: FOLD_CAUSE, cohort }), rootLsn, cohort.hi, JSON.stringify(cursor), B);
  markPending(db, B, PENDING_ALL_THREADS, rootLsn);
  st(db, "INSERT OR IGNORE INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES(?,?,?)").run(PENDING_ALL_SCOPES, rootLsn, B);
  bumpDenyGeneration(db);
  return B;
}

/** Decide (at listen, or in the runner when two or more flow-phase bulks wait) and open the first cohort of two or more. True: one opened. */
function decide(db: DatabaseSync): boolean {
  if (!REVOKE_FOLD.enabled) return false;
  const listen = !listened.has(db);
  if (!listen) {
    const flowBulks = Number(st(db, `SELECT count(*) AS n FROM (SELECT 1 FROM memory_revoke_jobs WHERE state='active' AND kind='bulk' AND phase='flow'
      AND revoke_id IN (SELECT revoke_id FROM memory_revoke_audience) AND revoke_id NOT IN (SELECT bulk_id FROM memory_revoke_fold) LIMIT 2)`).get()?.n ?? 0);
    if (flowBulks < 2) return false;
  }
  // at listen every eligible job; in the runner only jobs still in their flow phase (a marking job is never joined, M5)
  const jobs = foldCandidates(db, listen ? ["flow", "mark", "hold"] : ["flow"]);
  const key = jobs.map(job => job.id).join(",");
  if (!listen && lastNegative.get(db) === key) return false;
  const cohort = jobs.length >= 2 ? foldCohorts(db, jobs).find(c => c.ids.length >= 2) : undefined;
  if (!cohort) {
    if (listen) listened.add(db); else lastNegative.set(db, key);
    return false;
  }
  const ids = new Set(cohort.ids);
  return openFold(db, cohort, jobs.filter(job => ids.has(job.id))) > 0;
}

const page = (budget: FoldBudget) => Math.max(1, Math.min(MARKER_SLICE_ROWS / 4, budget.rows()));
const MEMBER_TABLES = [
  ["memory_deny_pending", "thread_id,since_lsn,revoke_id"], ["memory_deny_pending_scope", "scope_id,since_lsn,revoke_id"],
  ["memory_revoke_frontier", "revoke_id,seq"], ["memory_revoke_reached", "revoke_id,thread_id"],
] as const;
function deleteMemberPage(db: DatabaseSync, table: string, key: string, revokeId: number, n: number): number {
  return Number(st(db, `DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE revoke_id=?1 LIMIT ?2)`).run(revokeId, n).changes);
}
function nextSeq(db: DatabaseSync, revokeId: number): number {
  const last = st(db, "SELECT seq FROM memory_revoke_frontier WHERE revoke_id=? ORDER BY seq DESC LIMIT 1").get(revokeId)?.seq;
  return Math.max(0, Number(last ?? 0)) + 1;
}

/** Adds a member's cohort index to B's root.closureIds (sorted, no duplicates; at most FLIP_DRAIN_MAX small integers). */
function noteClosure(db: DatabaseSync, B: number, index: number): void {
  const row = st(db, "SELECT root FROM memory_revoke_jobs WHERE revoke_id=?").get(B);
  let root: Record<string, unknown>;
  try { root = JSON.parse(String(row?.root)); } catch { return; } // unreadable: not certified, '*' stays to the tidy
  const ids = Array.isArray(root.closureIds) ? (root.closureIds as unknown[]).map(Number).filter(Number.isSafeInteger) : [];
  if (ids.includes(index)) return;
  root.closureIds = [...ids, index].sort((x, y) => x - y);
  st(db, "UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=?").run(JSON.stringify(root), B);
}

/** Moves the seeding fold bulk B by whole steps within the budget. */
function runFold(db: DatabaseSync, B: number, rootJson: string, cursorJson: string, budget: FoldBudget): boolean | "blocked" {
  let cohort: FoldCohort;
  try { cohort = JSON.parse(rootJson).cohort; } catch { throw new Error("MEMORY_REVOKE_NODE_UNREADABLE"); }
  if (!cohort || !Array.isArray(cohort.ids)) throw new Error("MEMORY_REVOKE_NODE_UNREADABLE");
  let c: FoldCursor;
  try { c = JSON.parse(cursorJson).fold; } catch { c = { stage: "enrol", job: 0 }; }
  if (!c || typeof c.stage !== "string") c = { stage: "enrol", job: 0 };
  const save = () => st(db, "UPDATE memory_revoke_jobs SET cursor=? WHERE revoke_id=?").run(JSON.stringify({ fold: c }), B);
  const ids = cohort.ids.map(Number);
  let moved = false;
  while (!budget.exhausted()) {
    const n = page(budget);
    // every step is charged what it wrote (a flow item re-seeded writes its pending row and its queue row), so the slice's row budget and
    // its write cap see the same count; no step writes more than one page of rows plus its bookkeeping (Astra build1: bounded writes)
    const w0 = totalChanges(db);
    const wrote = (rows: number) => Math.max(rows, totalChanges(db) - w0);
    if (c.stage === "enrol") {
      // (1) one map row per member, in ids order: from here every entry that takes the id resolves it to B (F1.6)
      const take = ids.slice(c.job, c.job + n);
      const insert = st(db, "INSERT OR IGNORE INTO memory_revoke_fold(old_id,bulk_id) VALUES(?,?)");
      for (const id of take) insert.run(id, B);
      budget.spend(wrote(take.length));
      c.job += take.length;
      if (c.job >= ids.length) c = { stage: "root", job: 0 };
    } else if (c.job >= ids.length) {
      c = { stage: "sweep", job: 0 };
    } else if (c.stage === "root") {
      // (a) a receipt job's root re-committed into B: B's receipt node, a fresh flow seed, its consumer edges (keyed inserts)
      const id = ids[c.job]!;
      const job = st(db, "SELECT kind,root FROM memory_revoke_jobs WHERE revoke_id=?").get(id);
      let root: Record<string, any> = {};
      try { root = job ? JSON.parse(String(job.root)) : {}; } catch { root = {}; }
      if (job && job.kind === "receipt" && typeof root.bundleId === "string") {
        if (!budget.fits(receiptCommitCost(db, root.bundleId) + FOLD_OPEN_COST, !moved)) { save(); return moved ? true : "blocked"; }
        commitRevoke(db, { kind: "receipt", bundleId: root.bundleId, cause: "receipt-revoked" }, { into: B, inline: false });
      }
      budget.spend(wrote(1));
      c = { stage: "frontier", job: c.job, after: Number.MIN_SAFE_INTEGER };
    } else if (c.stage === "frontier" && c.pk !== undefined && FOLD_CLOSURE.enabled) {
      // (c2) the member's pending rows become flow seeds of B (DRAIN-104 section 4): the threads and scopes its flow closure expanded before
      // the fold, whose windows the clean stage deletes; markPending keeps the smallest since per node and a row above B's commit stays an
      // inherit hold. Keyed inserts, a page per step on the primary key from `pk`; the '*' rows are B's own (step 0). The page that completes
      // the copy records the member's index in root.closureIds (a set: repairFoldMap's rewind re-runs the copy).
      const id = ids[c.job]!, [table, key, since] = c.pk;
      const rows = (table === 0
        ? st(db, "SELECT thread_id AS k,since_lsn AS s FROM memory_deny_pending WHERE revoke_id=?1 AND (thread_id,since_lsn)>(?2,?3) ORDER BY thread_id,since_lsn LIMIT ?4").all(id, key, since, n)
        : st(db, "SELECT scope_id AS k,since_lsn AS s FROM memory_deny_pending_scope WHERE revoke_id=?1 AND (scope_id,since_lsn)>(?2,?3) ORDER BY scope_id,since_lsn LIMIT ?4").all(id, key, since, n)) as Array<{ k: string; s: number }>;
      for (const row of rows) {
        if (table === 0 ? row.k === PENDING_ALL_THREADS : row.k === PENDING_ALL_SCOPES) continue;
        seedFlow(db, B, table === 0 ? String(row.k) : `scope:${row.k}`, Number(row.s));
      }
      if (rows.length) { const last = rows[rows.length - 1]!; c.pk = [table, String(last.k), Number(last.s)]; }
      if (rows.length < n) {
        if (table === 0) c.pk = [1, "", Number.MIN_SAFE_INTEGER];
        else { noteClosure(db, B, c.job); c = { stage: "holds", job: c.job }; }
      }
      budget.spend(wrote(rows.length + 1));
    } else if (c.stage === "frontier") {
      // (c) every frontier row of the member in seq order: flow items re-seeded under B, mark nodes copied with fresh seqs
      const id = ids[c.job]!;
      const rows = st(db, "SELECT seq,node FROM memory_revoke_frontier WHERE revoke_id=? AND seq>? ORDER BY seq LIMIT ?").all(id, c.after ?? Number.MIN_SAFE_INTEGER, n);
      let seq = nextSeq(db, B);
      const insert = st(db, "INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,?,?)");
      for (const row of rows) {
        if (Number(row.seq) < 0) {
          let item: { node?: unknown; since?: unknown };
          try { item = JSON.parse(String(row.node)); } catch { throw new Error("MEMORY_REVOKE_NODE_UNREADABLE"); }
          if (typeof item?.node !== "string" || !Number.isSafeInteger(item.since)) throw new Error("MEMORY_REVOKE_NODE_UNREADABLE");
          seedFlow(db, B, item.node, Number(item.since));
          seq = nextSeq(db, B);
        } else insert.run(B, seq++, String(row.node));
      }
      budget.spend(wrote(rows.length));
      if (rows.length) c.after = Number(rows[rows.length - 1]!.seq);
      if (rows.length < n) c = FOLD_CLOSURE.enabled ? { ...c, pk: [0, "", Number.MIN_SAFE_INTEGER] } : { stage: "holds", job: c.job }; // then its pending copy (c2), in this stage
    } else if (c.stage === "holds") {
      // (d) only hold: rows (B walks every thread itself), a page per step in thread_id order from the saved key (a member's rows are
      // static while B seeds: holdRevoke and releaseHold resolve its id to B); (e) the member retires in the transaction of the last page
      const id = ids[c.job]!;
      const holds = st(db, `SELECT thread_id FROM memory_revoke_reached WHERE revoke_id=? AND thread_id>='hold:' AND thread_id>? AND thread_id<'hold;'
        ORDER BY thread_id LIMIT ?`).all(id, c.key ?? "", n);
      const insert = st(db, "INSERT OR IGNORE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,0)");
      for (const row of holds) insert.run(B, String(row.thread_id));
      if (holds.length) c.key = String(holds[holds.length - 1]!.thread_id);
      if (holds.length < n) {
        st(db, "UPDATE memory_revoke_jobs SET state='folded' WHERE revoke_id=? AND state='active'").run(id);
        bumpDenyGeneration(db);
        c = { stage: "clean", job: c.job };
      }
      budget.spend(wrote(holds.length + 1));
    } else if (c.stage === "clean") {
      // (e) its pending, pending_scope, frontier and reached rows go, a page per step; its deny marks stay under its id
      const id = ids[c.job]!;
      let gone = 0;
      for (const [table, key] of MEMBER_TABLES) if (gone < n) gone += deleteMemberPage(db, table, key, id, n - gone);
      budget.spend(wrote(gone));
      if (gone < n) { bumpDenyGeneration(db); c = { stage: "root", job: c.job + 1 }; }
    } else {
      // sweep, then activation (F1.4): only once no pending, scope, frontier or reached row is left under any member id
      let gone = 0;
      for (const id of ids) {
        for (const [table, key] of MEMBER_TABLES) if (gone < n) gone += deleteMemberPage(db, table, key, id, n - gone);
        if (gone >= n) break;
      }
      budget.spend(wrote(gone));
      if (gone >= n) { moved = true; continue; }
      st(db, "UPDATE memory_revoke_jobs SET cursor='' WHERE revoke_id=?").run(B);
      // certified closure (DRAIN-104 section 4): every member's pending rows were copied into B's flow, so B's flow phase covers the union of
      // the members' closures and its '*' window can end at its flow gate (revoke-marker.ts); a member copied by 1.0.3 is not in the set
      const root = st(db, "SELECT root FROM memory_revoke_jobs WHERE revoke_id=?").get(B)?.root;
      let closure: number[] = [];
      try { const got = JSON.parse(String(root)).closureIds; if (Array.isArray(got)) closure = got.map(Number); } catch { closure = []; }
      if (ids.every((_, index) => closure.includes(index))) st(db, "UPDATE memory_revoke_jobs SET root=json_set(root,'$.narrow',1) WHERE revoke_id=?").run(B);
      activateBulkRevoke(db, B);
      return true;
    }
    moved = true;
  }
  save();
  return true;
}

/** The marker's fold hook (revoke-marker.ts runMarkerSlice): resume a seeding fold, or decide and open one. null: no fold work. */
function foldSlice(db: DatabaseSync, budget: FoldBudget): boolean | "blocked" | null {
  if (!hasWritetime(db) || !hasFoldMap(db)) return null;
  const held = seedingFold(db);
  if (held) return runFold(db, Number(held.revoke_id), String(held.root), String(held.cursor), budget);
  return decide(db) ? true : null;
}
/** Rows the seeding fold's next indivisible step writes: a member's root re-commit with a bulk's opening (0 otherwise; a page fits any slice). */
function foldNeed(db: DatabaseSync): number {
  if (!hasWritetime(db) || !hasFoldMap(db)) return 0;
  const held = seedingFold(db);
  if (!held) return 0;
  try {
    const c = JSON.parse(String(held.cursor)).fold as FoldCursor;
    const id = (JSON.parse(String(held.root)).cohort.ids as number[])[c.job];
    if (c.stage !== "root" || id === undefined) return 0;
    const job = st(db, "SELECT kind,root FROM memory_revoke_jobs WHERE revoke_id=?").get(id);
    const bundleId = job && job.kind === "receipt" ? JSON.parse(String(job.root)).bundleId : undefined;
    return typeof bundleId === "string" ? receiptCommitCost(db, bundleId) + FOLD_OPEN_COST : 0;
  } catch { return 0; }
}
const foldPending = (db: DatabaseSync): boolean => hasWritetime(db) && hasFoldMap(db) && Boolean(seedingFold(db));

setFoldHooks({ slice: foldSlice, need: foldNeed, pending: foldPending });

/** Whether the fold map is missing or empty while a fold bulk's job row is present: the file came back from a round trip through 1.0.2 (the
 * step to v10 drops the map, 1.0.2 refuses it) and repairFoldMap has work. Two LIMIT 1 probes; false below v10. */
export function foldMapLost(db: DatabaseSync): boolean {
  if (!hasWritetime(db)) return false;
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_revoke_fold'").get() && db.prepare("SELECT 1 FROM memory_revoke_fold LIMIT 1").get()) return false;
  return Boolean(db.prepare(FOLD_BULKS + " LIMIT 1").get());
}
const FOLD_BULKS = "SELECT revoke_id,state,root,cursor FROM memory_revoke_jobs WHERE kind='bulk' AND json_valid(root) AND json_extract(root,'$.cause')='fold' ORDER BY revoke_id";

/** One member's leftovers moved to its fold bulk B: what 1.0.2 wrote under the member's own id while the map was gone (it resolves no id, so a
 * carried child was enqueued and held under the member, and a folded member in hold or tidy was set active again). Frontier rows join B's
 * (flow items re-seeded, mark nodes with fresh seqs, as the fold's frontier stage copies them), pending rows join B's at their own since
 * (kept until B's tidy), hold rows are copied and the member's other reached rows go (B walks every thread itself). A member set active
 * again is folded again. An undo in flight is left to finish. Returns what changed: rows moved, flow items among them, the member reset. */
function moveMember(db: DatabaseSync, R: number, B: number): { moved: number; flow: boolean; reset: boolean } {
  const job = st(db, "SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R);
  if (job && (job.state === "undoing" || job.state === "undone")) return { moved: 0, flow: false, reset: false };
  let moved = 0, flow = false;
  let seq = nextSeq(db, B);
  const insert = st(db, "INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,?,?)");
  for (const row of st(db, "SELECT seq,node FROM memory_revoke_frontier WHERE revoke_id=? ORDER BY seq").all(R)) {
    if (Number(row.seq) < 0) {
      let item: { node?: unknown; since?: unknown };
      try { item = JSON.parse(String(row.node)); } catch { throw new Error("MEMORY_REVOKE_NODE_UNREADABLE"); }
      if (typeof item?.node !== "string" || !Number.isSafeInteger(item.since)) throw new Error("MEMORY_REVOKE_NODE_UNREADABLE");
      seedFlow(db, B, item.node, Number(item.since));
      seq = nextSeq(db, B);
      flow = true;
    } else insert.run(B, seq++, String(row.node));
    moved++;
  }
  for (const row of st(db, "SELECT thread_id,since_lsn FROM memory_deny_pending WHERE revoke_id=?").all(R)) { markPending(db, B, String(row.thread_id), Number(row.since_lsn)); moved++; }
  for (const row of st(db, "SELECT scope_id,since_lsn FROM memory_deny_pending_scope WHERE revoke_id=?").all(R)) { markPending(db, B, `scope:${String(row.scope_id)}`, Number(row.since_lsn)); moved++; }
  moved += Number(st(db, "INSERT OR IGNORE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) SELECT ?,thread_id,0 FROM memory_revoke_reached WHERE revoke_id=? AND thread_id>=? AND thread_id<'hold;'").run(B, R, HOLD_PREFIX).changes);
  for (const [table] of MEMBER_TABLES) moved += Number(st(db, `DELETE FROM ${table} WHERE revoke_id=?`).run(R).changes);
  const reset = Number(st(db, "UPDATE memory_revoke_jobs SET state='folded' WHERE revoke_id=? AND state='active'").run(R).changes) > 0;
  return { moved, flow, reset };
}

/** The fold map rebuilt after a round trip through 1.0.2 (1.0.3 -> Prepare to reinstall -> 1.0.2 -> 1.0.3), in the caller's transaction, from
 * the fold bulks' own job rows: each keeps root.cohort.ids (a v10 row, which the step to v10 and 1.0.2 leave as it is). Runs only while the map is
 * missing or empty and a fold bulk is present (foldMapLost), so a second run, or a run on a file that never went back, does nothing.
 *  - map rows: every member of an active or finished B; for a B still seeding, exactly the members its enrol stage had taken.
 *  - a seeding B whose current member was past its root stage goes back to that member's frontier copy (1.0.2 may have walked the still
 *    active member or added to it; the copy is keyed or re-walked, never lost); the members before it are moved (below).
 *  - every member already folded into B has whatever 1.0.2 left under its own id moved into B (moveMember); B, when it had finished or was
 *    holding or tidying, marks again (flow first when a flow item came over), so those rows are walked and its tidy takes them away.
 * A fold bulk whose job row was pruned left no folded member behind (its tidy deletes them first): its members' marks read as they are, and
 * 1.0.2 gave any carried child a job of the member's own, which walks as any revoke does. Returns the map rows written. */
export function repairFoldMap(db: DatabaseSync): number {
  if (!hasWritetime(db) || !hasFoldMap(db) || !foldMapLost(db)) return 0;
  const enrol = st(db, "INSERT OR IGNORE INTO memory_revoke_fold(old_id,bulk_id) VALUES(?,?)");
  let mapped = 0;
  for (const bulk of st(db, FOLD_BULKS).all()) {
    const B = Number(bulk.revoke_id);
    let ids: number[];
    try { ids = (JSON.parse(String(bulk.root)).cohort.ids as unknown[]).map(Number).filter(id => Number.isSafeInteger(id) && id > 0); } catch { continue; } // no cohort: nothing to map
    let enrolled = ids, done = ids;
    if (bulk.state === "seeding") {
      let c: FoldCursor | undefined;
      try { c = JSON.parse(String(bulk.cursor)).fold; } catch { c = undefined; }
      if (!c || typeof c.stage !== "string") c = { stage: "enrol", job: 0 };
      const k = Math.max(0, Math.min(ids.length, Number(c.job) || 0));
      if (c.stage === "enrol") { enrolled = ids.slice(0, k); done = []; }
      else if (c.stage !== "sweep" && k < ids.length) {
        done = ids.slice(0, k);
        if (c.stage !== "root") st(db, "UPDATE memory_revoke_jobs SET cursor=? WHERE revoke_id=?").run(JSON.stringify({ fold: { stage: "frontier", job: k, after: Number.MIN_SAFE_INTEGER } }), B);
      }
    }
    for (const id of enrolled) mapped += Number(enrol.run(id, B).changes);
    let moved = 0, flow = false, reset = false;
    for (const id of done) { const m = moveMember(db, id, B); moved += m.moved; flow ||= m.flow; reset ||= m.reset; }
    if (bulk.state !== "seeding" && (moved || reset)) {
      if (flow) st(db, "UPDATE memory_revoke_jobs SET phase='flow',cursor='',state='active' WHERE revoke_id=?").run(B);
      else st(db, "UPDATE memory_revoke_jobs SET phase='mark',cursor='',state='active' WHERE revoke_id=? AND (state='done' OR phase IN ('hold','tidy','done'))").run(B);
    }
    if (moved || reset) bumpDenyGeneration(db);
  }
  return mapped;
}
