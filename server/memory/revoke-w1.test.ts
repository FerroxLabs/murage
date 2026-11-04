// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKER-WINDOW-FANOUT-1016 W1 (check before enqueue): a walk child whose pop would write nothing is not enqueued. The contract is that the
// walk writes exactly the deny rows the 1.0.15 walk writes. Every test here is a differential: the same store is built twice, one copy is
// walked with W1 on and one with W1 off (REVOKE_W1.enabled = false, the 1.0.15 enqueue), and the deny, pending, reached and job tables are
// compared row by row, every column. Each test also asserts that W1 left children out (W1_PROBE), so it fails if the mechanism never fired.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import * as fold from "./revoke-fold.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { CARRY_CHILD_CODE, FIRST_LSN, lineChildRef, OBJECT_EDGE_LSN, objectCarryThread, recordChildRef, sessionChildRef, turnChildRef, type FrontierNode, type MemoryRef } from "./lineage-types.ts";
import { testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
const W1 = marker.REVOKE_W1, PROBE = marker.W1_PROBE;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db, rows = 256) => { for (let k = 0; k < 200_000; k++) if (!slice(db, rows)) return k; throw new Error("unbounded"); };
const pathOf = (db: Db) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
const probeTotal = () => Object.values(PROBE).reduce((a, b) => a + b, 0);
const CAP = 4000;

/** Store writers (the rows S1's writers leave), as revoke-cover.test.ts writes them. */
class Store {
  readonly db: Db;
  constructor(readonly fx: WritetimeFixture) { this.db = fx.db; }
  line(T: string, lsn: number, generated: boolean, turnLsn = lsn - 1): this {
    if (generated) this.fx.reply(T, `${T}-${lsn}`, lsn, { turnLsn }); else this.fx.owner(T, `${T}-${lsn}`, lsn);
    return this;
  }
  carry(T: string, from: number, to: number, child: { line: [string, number] } | { turn: [string, number] } | { ref: MemoryRef } | { session: [string, string, string] }): this {
    const row = "line" in child ? [CARRY_CHILD_CODE.line, lineChildRef(child.line[1]), testThreadNo(this.db, child.line[0])]
      : "turn" in child ? [CARRY_CHILD_CODE.turn, turnChildRef(child.turn[1]), testThreadNo(this.db, child.turn[0])]
      : "ref" in child ? [CARRY_CHILD_CODE.record, recordChildRef(child.ref), 0]
      : [CARRY_CHILD_CODE.session, sessionChildRef(child.session[1], child.session[2]), testThreadNo(this.db, child.session[0])];
    this.db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, T), to, from, row[0]!, row[1]!, row[2]!);
    return this;
  }
  consumer(ref: { kind: "source" | "record"; id: string }, child: [string, number]): this {
    this.db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, objectCarryThread(ref)), OBJECT_EDGE_LSN, OBJECT_EDGE_LSN, CARRY_CHILD_CODE.line, lineChildRef(child[1]), testThreadNo(this.db, child[0]));
    return this;
  }
  capture(T: string, lsn: number, id: string, scope = "s-room"): this {
    this.fx.source(id, scope, { thread: T, message: `${T}-${lsn}` });
    this.db.prepare("INSERT OR IGNORE INTO memory_line_capture(thread_no,lsn,source_id) VALUES(?,?,?)").run(testThreadNo(this.db, T), lsn, id);
    return this;
  }
  session(T: string, ns: string, first: number, last: number): this { this.fx.sessionLineage(T, "fuigo", ns, first, last); return this; }
  receipt(b: string, T: string, lsn: number, records: readonly string[]): this {
    this.db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'fuigo',?,?,'[]','[]',0,0,0,'delivered',0)")
      .run(b, T, `ns-${b}`, JSON.stringify(records.map(id => ({ id, version: 1 }))));
    noteReceiptOutput(this.db, b, T, lsn, { driverInstance: "fuigo", nativeSession: `ns-${b}` });
    return this;
  }
  head(next = 5000): this { this.db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(next); return this; }
}

function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** A random store with many paths to the same node (the duplicates W1 leaves out): threads of owner and generated lines, carries between
 * them (lines, turns, records, sources, sessions), captures, records with evidence and derivations (cycles included), object consumers,
 * receipts citing records, a bot scope's records. Deterministic per seed, so two builds are the same store. */
function randomStore(seed: number): { s: Store; roots: FrontierNode[][] } {
  const rnd = mulberry(seed), s = new Store((() => { const fx = new WritetimeFixture(); fx.cert(true); return fx; })());
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const TH = ["ta", "tb", "tc", "td", "te"];
  const lines = new Map<string, number[]>(TH.map(t => [t, []])), gen = new Map<string, number[]>(TH.map(t => [t, []]));
  const N = 110;
  for (let lsn = 1; lsn <= N; lsn++) {
    const T = pick(TH), g = rnd() < 0.55;
    s.line(T, lsn, g, Math.min(lsn - 1 - Math.floor(rnd() * 3), 3));
    lines.get(T)!.push(lsn); if (g) gen.get(T)!.push(lsn);
  }
  for (const T of TH) for (let k = 0; k < 2; k++) { const first = 1 + Math.floor(rnd() * N), last = first + Math.floor(rnd() * 40); s.session(T, `${T}-s${k}`, first, last); }
  const sources: string[] = [];
  for (let k = 0; k < 16; k++) { const T = pick(TH), l = gen.get(T)!; if (!l.length) continue; const id = `src${k}`; s.capture(T, pick(l), id, rnd() < 0.3 ? "s-bot" : "s-room"); sources.push(id); }
  const records: string[] = [];
  for (let k = 0; k < 14; k++) { const id = `rec${k}`; s.fx.record(id, 1, rnd() < 0.3 ? "s-bot" : "s-room", sources.length ? [pick(sources), pick(sources)].filter((x, i, a) => a.indexOf(x) === i) : []); records.push(id); }
  for (let k = 0; k < 10; k++) { const a = pick(records), b = pick(records); if (a !== b) { try { s.fx.derive(a, 1, b, 1); } catch { /* duplicate */ } } }
  for (let k = 0; k < 90; k++) {
    const P = pick(TH), pl = lines.get(P)!;
    if (!pl.length) continue;
    const from = rnd() < 0.1 ? FIRST_LSN : pick(pl), ends = gen.get(P)!.filter(l => from === FIRST_LSN || (l >= from && l <= from + 12));
    if (!ends.length) continue;
    const to = pick(ends), Q = pick(TH.filter(t => t !== P)), r = rnd();
    if (r < 0.4 && lines.get(Q)!.length) s.carry(P, from, to, { line: [Q, pick(lines.get(Q)!)] });
    else if (r < 0.55 && gen.get(Q)!.length) s.carry(P, from, to, { turn: [Q, pick(gen.get(Q)!) - 1] });
    else if (r < 0.72) s.carry(P, from, to, { ref: { kind: "record", id: pick(records), version: 1 } });
    else if (r < 0.88 && sources.length) s.carry(P, from, to, { ref: { kind: "source", id: pick(sources) } });
    else s.carry(P, from, to, { session: [Q, "fuigo", `${Q}-s${Math.floor(rnd() * 2)}`] });
  }
  for (let k = 0; k < 8; k++) { const T = pick(TH), l = lines.get(T)!; if (l.length && sources.length) s.consumer({ kind: rnd() < 0.5 ? "source" : "record", id: rnd() < 0.5 ? pick(sources) : pick(records) }, [T, pick(l)]); }
  for (let k = 0; k < 5; k++) { const T = pick(TH), l = gen.get(T)!; if (l.length) s.receipt(`bun${k}`, T, pick(l), [pick(records), pick(records)]); }
  s.head();
  const rootSet = (): FrontierNode[] => {
    const out: FrontierNode[] = [];
    for (let k = 0; k < 4; k++) {
      const r = rnd(), T = pick(TH), l = lines.get(T)!;
      if (r < 0.35 && l.length) out.push({ kind: "range", threadId: T, fromLsn: pick(l) });
      else if (r < 0.45 && l.length) out.push({ kind: "line", threadId: T, lsn: pick(l) });
      else if (r < 0.65 && sources.length) out.push({ kind: "source", id: pick(sources) });
      else if (r < 0.82) out.push({ kind: "record", id: pick(records), version: rnd() < 0.2 ? marker.softVersion(1) : 1 });
      else if (r < 0.92) out.push({ kind: "scope", scopeId: "s-bot" });
      else out.push({ kind: "receipt", bundleId: `bun${Math.floor(rnd() * 5)}` });
    }
    return out;
  };
  return { s, roots: [rootSet(), rootSet(), rootSet()] };
}

/** A job row as the marker leaves one in its mark phase, with its frontier and a pending window per thread its roots name. */
/** false: a content job. "bulk": an audience job that is a fold's bulk (its map names it), the audience job W1 applies to. "member": an
 * inherit audience job a fold could still take as a member, for which W1 enqueues every child (revoke-marker.ts foldableJob). */
type Role = false | "bulk" | "member";
function job(db: Db, id: number, nodes: readonly FrontierNode[], audience: Role): void {
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,'mark','','active')")
    .run(id, audience === "bulk" ? "bulk" : "inherit", JSON.stringify({ kind: audience === "bulk" ? "bulk" : "inherit", cause: "inherit" }), CAP, CAP);
  if (audience) db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(id);
  if (audience === "bulk") db.prepare("INSERT OR IGNORE INTO memory_revoke_fold(old_id,bulk_id) VALUES(?,?)").run(1000 + id, id);
  for (const node of nodes) marker.enqueueNode(db, id, node);
  for (const T of ["ta", "tb", "tc", "td", "te"]) db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,1,?)").run(T, id);
  db.prepare("INSERT OR IGNORE INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',1,?)").run(id);
}

const TABLES: Array<[string, string]> = [
  ["memory_deny_line", "thread_id,lsn,revoke_id"], ["memory_deny_range", "thread_id,from_lsn,revoke_id"],
  ["memory_deny_session", "thread_id,driver_instance,native_session,revoke_id"], ["memory_deny_memory", "kind,id,version,revoke_id"],
  ["memory_deny_pending", "thread_id,since_lsn,revoke_id"], ["memory_deny_pending_scope", "scope_id,since_lsn,revoke_id"],
  ["memory_revoke_reached", "revoke_id,thread_id"],
];
/** Every row of every table the walk writes and readers read, every column, in key order; and the job rows. */
function dump(db: Db): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [table, key] of TABLES) out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all().map(r => ({ ...r }));
  out.jobs = db.prepare("SELECT revoke_id,state,phase FROM memory_revoke_jobs ORDER BY revoke_id").all().map(r => ({ ...r }));
  return out;
}
const marks = (d: Record<string, unknown[]>) => ({ line: d.memory_deny_line, range: d.memory_deny_range, session: d.memory_deny_session, memory: d.memory_deny_memory });
const frontierInserts = { on: 0, off: 0 };

type Built = { s: Store; roots: FrontierNode[][] };
/** Builds the same store twice, adds the jobs to each, walks one with W1 on (`runOn`) and one with W1 off (drained). */
function twin(seed: number, audience: Role, runOn: (b: Built) => Db = b => { drainAll(b.s.db); return b.s.db; }): { on: Record<string, unknown[]>; off: Record<string, unknown[]>; skipped: number } {
  const on = randomStore(seed), off = randomStore(seed);
  for (const b of [on, off]) b.roots.forEach((nodes, i) => job(b.s.db, 10 + i, nodes, audience));
  const count = (db: Db) => db.prepare("CREATE TEMP TRIGGER IF NOT EXISTS w1_count AFTER INSERT ON memory_revoke_frontier BEGIN UPDATE w1_n SET n=n+1; END").run();
  for (const b of [on, off]) { b.s.db.exec("CREATE TEMP TABLE IF NOT EXISTS w1_n(n INTEGER); INSERT INTO w1_n VALUES(0)"); count(b.s.db); }
  try {
    marker.resetW1Probe();
    W1.enabled = true; const dbOn = runOn(on); const skipped = probeTotal();
    W1.enabled = false; drainAll(off.s.db);
    W1.enabled = true;
    // (a reopened connection has no temp table: the restart test does not count)
    const n = (db: Db) => { try { return Number((db.prepare("SELECT n FROM temp.w1_n").get() as { n: number } | undefined)?.n ?? 0); } catch { return 0; } };
    frontierInserts.on += n(dbOn); frontierInserts.off += n(off.s.db);
    return { on: dump(dbOn), off: dump(off.s.db), skipped };
  } finally { W1.enabled = true; on.s.fx.close(); off.s.fx.close(); }
}
/** Every job finished its walk (the differential compares whole walks, not a stalled one). */
const allDone = (d: Record<string, unknown[]>) => (d.jobs as Array<{ state: string }>).every(j => j.state === "done");

const SEEDS = Array.from({ length: 24 }, (_, k) => 1601 + k * 7);

beforeEach(() => { fold.REVOKE_FOLD.enabled = false; marker.REVOKE_COVER.enabled = true; marker.setScopeFlowEdgesRecorded(true); marker.resetW1Probe(); });
afterEach(() => { fold.REVOKE_FOLD.enabled = true; marker.REVOKE_COVER.enabled = true; W1.enabled = true; });

describe("W1 writes exactly the 1.0.15 walk's rows", () => {
  it("content jobs: every deny, pending, reached and job row is equal, row by row, over random stores; W1 left children out", () => {
    let skipped = 0;
    for (const seed of SEEDS) {
      const r = twin(seed, false);
      expect(allDone(r.off), `seed ${seed} baseline finished`).toBe(true);
      expect(r.on, `seed ${seed}`).toEqual(r.off);
      skipped += r.skipped;
    }
    expect(skipped).toBeGreaterThan(0);
  });

  it("audience jobs under the cover (three fold bulks at once): equal rows, row by row, cover rows included", () => {
    let skipped = 0;
    for (const seed of SEEDS) {
      const r = twin(seed, "bulk");
      expect(allDone(r.off), `seed ${seed} baseline finished`).toBe(true);
      expect(r.on, `seed ${seed}`).toEqual(r.off);
      skipped += r.skipped;
    }
    expect(skipped).toBeGreaterThan(0);
  });

  it("a job a fold could still take (an inherit audience job): W1 leaves out nothing, so a fold copies the 1.0.15 frontier", () => {
    for (const seed of SEEDS) {
      const r = twin(seed, "member");
      expect(allDone(r.off), `seed ${seed} baseline finished`).toBe(true);
      expect(r.on, `seed ${seed}`).toEqual(r.off);
      expect(r.skipped, `seed ${seed}`).toBe(0);
    }
  });

  it("every kind of child W1 can leave out was left out somewhere in the corpus, and the walk wrote fewer frontier rows", () => {
    frontierInserts.on = 0; frontierInserts.off = 0;
    const kinds = new Set<string>();
    for (const seed of SEEDS) { marker.resetW1Probe(); twin(seed, false); for (const [k, v] of Object.entries(PROBE)) if (v > 0) kinds.add(k); }
    for (const kind of ["range", "line", "record", "object", "source"]) expect(kinds.has(kind), kind).toBe(true);
    expect(frontierInserts.on).toBeLessThan(frontierInserts.off);
  });

  it("a slice rolled back after a visit and then retried: the same rows as the baseline", () => {
    let skipped = 0;
    for (const seed of SEEDS.slice(0, 10)) {
      const r = twin(seed, false, b => {
        const db = b.s.db;
        for (let k = 0; k < 200_000; k++) {
          // every third slice runs once and rolls back (its visits, marks and W1's skips all go), then runs again
          if (k % 3 === 1) { db.exec("BEGIN IMMEDIATE"); marker.markerSlice(db, 64, Number.POSITIVE_INFINITY, null); db.exec("ROLLBACK"); }
          if (!slice(db, 64)) return db;
        }
        throw new Error("unbounded");
      });
      expect(r.on, `seed ${seed}`).toEqual(r.off);
      skipped += r.skipped;
    }
    expect(skipped).toBeGreaterThan(0);
  });

  it("a restart in the middle of the walk (a new connection on the same file): the same rows as the baseline", () => {
    const opened: Db[] = [];
    try {
      let skipped = 0;
      for (const seed of SEEDS.slice(0, 10)) {
        const r = twin(seed, "bulk", b => {
          for (let k = 0; k < 4; k++) slice(b.s.db, 32);
          const path = pathOf(b.s.db);
          b.s.db.close();
          const db = new DatabaseSync(path); opened.push(db);
          drainAll(db, 32);
          b.s.fx.db.close = () => db.close(); // the fixture's close() closes the reopened connection, then wipes the dir
          return db;
        });
        expect(r.on, `seed ${seed}`).toEqual(r.off);
        skipped += r.skipped;
      }
      expect(skipped).toBeGreaterThan(0);
    } finally { for (const db of opened) { try { db.close(); } catch { /* closed */ } } }
  });

  it("windows: whenever a job's pending rows are gone, every mark the baseline writes is already written (the reader guarantee)", () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const base = randomStore(seed);
      base.roots.forEach((nodes, i) => job(base.s.db, 10 + i, nodes, false));
      W1.enabled = false; drainAll(base.s.db, 32); W1.enabled = true;
      const want = marks(dump(base.s.db)); base.s.fx.close();
      const b = randomStore(seed);
      b.roots.forEach((nodes, i) => job(b.s.db, 10 + i, nodes, false));
      try {
        for (let k = 0; k < 200_000; k++) {
          const more = slice(b.s.db, 32);
          const d = dump(b.s.db);
          for (const id of [10, 11, 12]) {
            const open = (d.memory_deny_pending as Array<{ revoke_id: number }>).some(r => r.revoke_id === id) || (d.memory_deny_pending_scope as Array<{ revoke_id: number }>).some(r => r.revoke_id === id);
            if (open) continue;
            const own = (rows: unknown[]) => (rows as Array<{ revoke_id: number }>).filter(r => r.revoke_id === id);
            const got = marks(d);
            for (const key of ["line", "range", "session", "memory"] as const) expect(own(got[key]), `seed ${seed} job ${id} ${key} at slice ${k}`).toEqual(own(want[key]));
          }
          if (!more) break;
        }
      } finally { b.s.fx.close(); }
    }
  });

  it("a soft-version record cycle walks to its end with W1, with the baseline's rows", () => {
    const build = () => {
      const fx = new WritetimeFixture(); fx.cert(true);
      const s = new Store(fx);
      s.line("ta", 1, false); s.line("ta", 2, true, 1); s.capture("ta", 2, "srcA");
      for (const id of ["ra", "rb", "rc"]) fx.record(id, 1, "s-room", ["srcA"]);
      fx.derive("ra", 1, "rb", 1); fx.derive("rb", 1, "rc", 1); fx.derive("rc", 1, "ra", 1); fx.derive("rb", 1, "ra", 1);
      s.carry("ta", 1, 2, { ref: { kind: "record", id: "ra", version: 1 } });
      s.consumer({ kind: "record", id: "rb" }, ["ta", 2]);
      s.head();
      job(s.db, 10, [{ kind: "record", id: "ra", version: marker.softVersion(1) }, { kind: "record", id: "rb", version: marker.softVersion(1) }], false);
      job(s.db, 11, [{ kind: "record", id: "ra", version: 1 }, { kind: "source", id: "srcA" }], false);
      return s;
    };
    const on = build(), off = build();
    try {
      marker.resetW1Probe();
      W1.enabled = true; drainAll(on.db, 16);
      const skipped = probeTotal();
      W1.enabled = false; drainAll(off.db, 16); W1.enabled = true;
      const a = dump(on.db), b = dump(off.db);
      expect(allDone(a)).toBe(true);
      expect(a).toEqual(b);
      expect(skipped).toBeGreaterThan(0);
      expect(PROBE.record ?? 0).toBeGreaterThan(0);
    } finally { on.fx.close(); off.fx.close(); }
  });
});
