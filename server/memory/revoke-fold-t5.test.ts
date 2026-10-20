// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T5 with the revoke fold ON (the scratch/103-nofold probe, nofold-t5.test.ts, made the acceptance test of the fold member cap). A 1.0.2
// backlog of audience receipt revokes, one of them mid-mark with a line mark in THREADS[0]; the upgrade's activation
// (activateRevokesAtUpgrade) moves every active job to a fresh slot S; the listen fold folds them into one bulk B. A CLEAN turn begun in the
// first seconds after boot (turn > S), in that thread and in a quiet one, must read only "checking" or "shown" while B drains and "shown"
// once it has drained: B walks with its members' cap (cohort.hi), not its own activation slot. A reply whose recorded sources include the
// revoked line itself must end withheld for the audience reader and never read shown.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { commitRevoke, inheritMarks } from "./revoke-commit.ts";
import { holdRevoke, markerSlice } from "./revoke-marker.ts";
import { denyLookup } from "./deny-read.ts";
import { activateRevokesAtUpgrade } from "./schema.ts";
import { REVOKE_FOLD } from "./revoke-fold.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { storm, THREADS } from "./testing/revoke-storm-fixture.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => markerSlice(db, rows, Number.POSITIVE_INFINITY, null, Number.POSITIVE_INFINITY));
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const pathOf = (db: Db) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);

function legacy(count: number, mid = Math.min(3, count - 1)): { fx: WritetimeFixture; jobs: number[] } {
  const fx = storm(count);
  fx.db.prepare("UPDATE memory_disclosures SET state='revoked'").run();
  fx.db.exec("DELETE FROM memory_receipt_flips");
  const jobs = tx(fx.db, () => Array.from({ length: count }, (_, i) => commitRevoke(fx.db, { kind: "receipt", bundleId: `b${i}`, cause: "receipt-revoked" }, { inline: false })));
  const M = jobs[mid]!;
  tx(fx.db, () => {
    fx.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(M);
    fx.db.prepare("DELETE FROM memory_revoke_frontier WHERE revoke_id=? AND seq<0").run(M);
    fx.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,100,?),(?,101,?)").run(M, JSON.stringify({ kind: "line", threadId: "inh-a", lsn: 500 }), M, JSON.stringify({ kind: "line", threadId: "inh-b", lsn: 501 }));
    holdRevoke(fx.db, M, "bk-1");
    fx.denyLine(THREADS[0]!, 10, M);
  });
  return { fx, jobs };
}

const CLEAN = [{ id: "clean-root", thread: THREADS[0]! }, { id: "clean-other", thread: "quiet-thread" }] as const;
const READERS = { member: MEMBER, owner: OWNER, content: CONTENT } as const;
function states(db: Db): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CLEAN) for (const [name, reader] of Object.entries(READERS))
    out[`${c.id}/${name}`] = denyLookup(db, { threadId: c.thread, lines: [{ messageId: c.id, author: "bot" as never }] }, reader).get(c.id)?.state ?? "none";
  return out;
}

/** writeHook: each reply's write-time inheritance runs with a carried range over its own thread from line 1 to its turn, so clean-root's
 * recorded sources include the revoked line 10 (a reply that read it); clean-other's range holds no revoked line. */
function run(opts: { upgrade: boolean; restart: boolean; writeHook: boolean }) {
  const { fx, jobs } = legacy(6);
  const file = pathOf(fx.db);
  let db: Db = fx.db;
  const seen = new Map<string, Set<string>>();
  const note = () => { for (const [k, v] of Object.entries(states(db))) { if (!seen.has(k)) seen.set(k, new Set()); seen.get(k)!.add(v); } };
  try {
    if (opts.upgrade) tx(db, () => activateRevokesAtUpgrade(db)); // boot: every active 1.0.2 job moves to a fresh slot S
    const caps = db.prepare("SELECT revoke_id AS r,started_lsn AS c,state,phase FROM memory_revoke_jobs ORDER BY revoke_id").all();
    slice(db, 4); // the runner's first slice after boot
    const next = n(db, "SELECT next AS n FROM memory_lsn WHERE id=1");
    const turn = next, lsn = next + 1; // a clean turn begun now, in the first seconds after boot
    for (const c of CLEAN) {
      fx.owner(c.thread, `${c.id}-q`, turn).reply(c.thread, c.id, lsn, { turnLsn: turn });
      if (opts.writeHook) tx(db, () => inheritMarks(db, { kind: "line", threadId: c.thread, lsn }, [], [{ threadId: c.thread, from: 1, to: turn }]));
    }
    db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn + 1);
    const first = states(db);
    note();
    let k = 0, restarted = false;
    while (k < 200_000) {
      const moved = slice(db, 4); k++;
      note();
      if (opts.restart && !restarted && k === 6) { db.close(); db = new DatabaseSync(file); restarted = true; note(); }
      if (!moved) break;
    }
    const active = n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding')");
    const final = states(db);
    const folds = n(db, "SELECT count(*) AS n FROM memory_revoke_fold");
    const fold = db.prepare("SELECT revoke_id AS r,started_lsn AS c,state,json_extract(root,'$.cohort.hi') AS hi FROM memory_revoke_jobs WHERE kind='bulk' AND json_valid(root) AND json_extract(root,'$.cause')='fold'").all();
    return { jobs, caps, turn, lsn, first, seen: Object.fromEntries([...seen].map(([k2, v]) => [k2, [...v]])), final, slices: k, active, folds, fold };
  } finally { if (db !== fx.db) db.close(); fx.close(); }
}

function check(out: ReturnType<typeof run>, writeHook: boolean): void {
  expect(out.active).toBe(0); // the backlog drained
  // the reply that read the revoked line: every audience reader (member, owner) holds it and finally withholds it, never shows it; a content
  // reader is not bound by an audience-only revoke. Every other read is of a clean turn: only checking or shown, and shown at the end.
  const read = (key: string) => writeHook && (key === "clean-root/member" || key === "clean-root/owner");
  for (const [key, set] of Object.entries(out.seen))
    for (const s of set) expect(read(key) ? ["checking", "withheld"] : ["shown", "checking"], `${key} read ${s} during the drain`).toContain(s);
  for (const [key, s] of Object.entries(out.final)) expect(s, `${key} final`).toBe(read(key) ? "withheld" : "shown");
}

describe("T5 with the revoke fold on: a clean turn begun after boot ends shown", () => {
  it("the fold is on", () => { expect(REVOKE_FOLD.enabled).toBe(true); });
  for (const upgrade of [true, false]) for (const restart of [false, true]) for (const writeHook of [false, true]) {
    it(`fold on: upgrade=${upgrade} restart=${restart} writeHook=${writeHook}`, () => {
      const out = run({ upgrade, restart, writeHook });
      console.log(`### FOLDON-T5 upgrade=${upgrade} restart=${restart} writeHook=${writeHook}\n` + JSON.stringify(out));
      expect(out.folds, "the backlog folded").toBeGreaterThan(0);
      check(out, writeHook);
    });
  }
});

describe("a fold bulk back from 1.0.2 walks with its own cap again", () => {
  it("the v10 to v12 step flags every fold bulk, whatever its state, and keeps its cohort", () => {
    const { fx } = legacy(6);
    try {
      tx(fx.db, () => activateRevokesAtUpgrade(fx.db));
      for (let k = 0; k < 200 && slice(fx.db, 4); k++) { /* fold and drain */ }
      const before = fx.db.prepare("SELECT root FROM memory_revoke_jobs WHERE kind='bulk' AND json_extract(root,'$.cause')='fold'").get() as { root: string };
      expect(JSON.parse(before.root).reupgraded).toBeUndefined();
      tx(fx.db, () => activateRevokesAtUpgrade(fx.db)); // the re-upgrade step (no active job left: the flag still lands)
      const root = JSON.parse((fx.db.prepare("SELECT root FROM memory_revoke_jobs WHERE kind='bulk' AND json_extract(root,'$.cause')='fold'").get() as { root: string }).root);
      expect(root.reupgraded).toBe(1);
      expect(root.cohort.ids).toEqual(JSON.parse(before.root).cohort.ids);
    } finally { fx.close(); }
  });
});

describe("the same T5 with the fold off (per-job baseline)", () => {
  for (const writeHook of [false, true]) it(`fold off: upgrade=true restart=false writeHook=${writeHook}`, () => {
    REVOKE_FOLD.enabled = false;
    try {
      const out = run({ upgrade: true, restart: false, writeHook });
      console.log(`### NOFOLD-T5 writeHook=${writeHook}\n` + JSON.stringify(out));
      expect(out.folds).toBe(0);
      check(out, writeHook);
    } finally { REVOKE_FOLD.enabled = true; }
  });
});
