// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The branch index answers "is X on the branch ending at L" exactly, for every
// pair, after every kind of write the Store makes (append, fork, row stored
// again, insert before, insert after), and a thread filled from its rows gives
// the same answers as one the writers kept.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  BRANCH_TABLES_SQL, indexStats, afterKey, compareOnBranch, branchOracle, childrenOf, encodeRow, ensureThreadKey, fillSlice, invalidateThread, midKey, moveRow, spliceAfter, spliceBefore, threadKey,
  type ThreadKey,
} from "./branch-index.ts";

function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

const open = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id);");
  db.exec(BRANCH_TABLES_SQL);
  return db;
};

it("order keys: midKey lies strictly between, afterKey above, over thousands of random pairs and nested splices", () => {
  const next = rng(1);
  const key = (): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(next() * 1e9) + 1)); return b; };
  for (let i = 0; i < 2_000; i++) {
    let a: Buffer = key(), b: Buffer = key();
    if (Buffer.compare(a, b) === 0) continue;
    if (Buffer.compare(a, b) > 0) [a, b] = [b, a];
    let lo = a, hi = b;
    for (let depth = 0; depth < 50; depth++) {
      const m = midKey(lo, hi);
      expect(Buffer.compare(lo, m)).toBeLessThan(0);
      expect(Buffer.compare(m, hi)).toBeLessThan(0);
      if (next() < 0.5) lo = m; else hi = m; // nested splices at the same edge
    }
    expect(Buffer.compare(afterKey(a), a)).toBeGreaterThan(0);
    expect(Buffer.compare(midKey(a, null), a)).toBeGreaterThan(0);
  }
  // a run of continuations keeps keys short
  let k: Buffer = Buffer.alloc(8, 1);
  for (let i = 0; i < 100_000; i++) k = afterKey(k);
  expect(k.length).toBeLessThanOrEqual(12);
});

interface Model { rows: Map<number, { id: string; parent: number | null }>; }

/** A thread driven by random writes, mirrored in a plain model. */
class Harness {
  db = open(); tk: ThreadKey; model: Model = { rows: new Map() }; nextRow = 1; threadId = "t";
  constructor(private random: () => number) { this.tk = ensureThreadKey(this.db, this.threadId, () => false); }
  private store(id: string, parent: number | null, legacy = false): number {
    // other threads take rowids too
    while (this.random() < 0.15) this.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('other',?,1,'user','text','x','{}')").run(`o${this.nextRow++}`);
    const mrow = this.nextRow++;
    const parentId = parent === null ? null : this.model.rows.get(parent)!.id;
    const json = JSON.stringify(legacy ? { id } : { id, parentId });
    this.db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?,?)").run(mrow, this.threadId, id, mrow, "user", "text", "hello", json);
    this.model.rows.set(mrow, { id, parent });
    return mrow;
  }
  private setParent(mrow: number, parent: number) {
    const entry = this.model.rows.get(mrow)!;
    entry.parent = parent;
    this.db.prepare("UPDATE messages SET json = ? WHERE rowid = ?").run(JSON.stringify({ id: entry.id, parentId: this.model.rows.get(parent)!.id }), mrow);
  }
  pick(): number { const ids = [...this.model.rows.keys()]; return ids[Math.floor(this.random() * ids.length)]!; }
  append(): void {
    const parent = this.model.rows.size === 0 || this.random() < 0.04 ? null : this.random() < 0.7 ? [...this.model.rows.keys()].at(-1)! : this.pick();
    const mrow = this.store(`m${this.nextRow}`, parent);
    encodeRow(this.db, this.tk, mrow, parent);
  }
  insertBefore(): void {
    if (!this.model.rows.size) return;
    const target = this.pick();
    const parent = this.model.rows.get(target)!.parent;
    const mrow = this.store(`s${this.nextRow}`, parent);
    this.setParent(target, mrow);
    expect(spliceBefore(this.db, this.tk, mrow, target, parent)).toBe(true);
  }
  insertAfter(): void {
    if (!this.model.rows.size) return;
    const anchor = this.pick();
    const kids = [...this.model.rows].filter(([, v]) => v.parent === anchor).map(([k]) => k);
    const mrow = this.store(`a${this.nextRow}`, anchor);
    for (const kid of kids) this.setParent(kid, mrow);
    // the structure names exactly the children the model has
    expect(childrenOf(this.db, this.tk, anchor).filter((c) => c !== mrow)).toEqual(kids.sort((a, b) => a - b));
    expect(spliceAfter(this.db, this.tk, mrow, anchor)).toBe(true);
  }
  replace(): void {
    if (!this.model.rows.size) return;
    const old = this.pick();
    const entry = this.model.rows.get(old)!;
    this.db.prepare("DELETE FROM messages WHERE rowid = ?").run(old);
    while (this.random() < 0.3) this.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('other',?,1,'user','text','x','{}')").run(`o${this.nextRow++}`);
    const mrow = this.nextRow++;
    this.db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?,?)").run(mrow, this.threadId, entry.id, mrow, "user", "text", "hello", JSON.stringify({ id: entry.id, parentId: entry.parent === null ? null : this.model.rows.get(entry.parent)!.id }));
    // children name their parent by rowid in the model: rename it
    this.model.rows.delete(old);
    this.model.rows.set(mrow, entry);
    for (const v of this.model.rows.values()) if (v.parent === old) v.parent = mrow;
    moveRow(this.db, this.tk, old, mrow, entry.parent);
  }
  depth(mrow: number): number { let d = 0; for (let cur: number | null = this.model.rows.get(mrow)?.parent ?? null; cur !== null; cur = this.model.rows.get(cur)?.parent ?? null) d++; return d; }
  /** The ancestors-or-self of `leaf` in the model. */
  branch(leaf: number): Set<number> {
    const out = new Set<number>();
    for (let cur: number | null = leaf; cur !== null && !out.has(cur); cur = this.model.rows.get(cur)?.parent ?? null) out.add(cur);
    return out;
  }
  check(label: string): void {
    const tk = threadKey(this.db, this.threadId)!;
    for (const leaf of this.model.rows.keys()) {
      const truth = this.branch(leaf), test = branchOracle(this.db, tk, leaf);
      for (const row of this.model.rows.keys()) if (test(row) !== truth.has(row)) throw new Error(`${label}: row ${row} on branch of ${leaf}: expected ${truth.has(row)}`);
      // and the order of two rows on one branch is the order along it
      const along = [...truth].map((m) => ({ m, depth: this.depth(m) })).sort((a, b) => a.depth - b.depth);
      for (let i = 1; i < along.length; i++) {
        if (compareOnBranch(this.db, tk, along[i]!.m, along[i - 1]!.m) <= 0) throw new Error(`${label}: row ${along[i]!.m} should come after ${along[i - 1]!.m} on the branch of ${leaf}`);
      }
    }
  }
  /** Drop every derived row and fill the thread again from its rows, in slices of `rows` rows. */
  refill(rows: number): void {
    invalidateThread(this.db, this.tk);
    this.db.exec("DELETE FROM msg_branch; DELETE FROM seg;");
    this.tk = threadKey(this.db, this.threadId)!;
    for (let guard = 0; guard < 10_000; guard++) { if (fillSlice(this.db, this.threadId, rows, 1e9).done) break; }
    expect(threadKey(this.db, this.threadId)!.state).toBe(2);
  }
}

it("the oracle equals a parent walk for every (row, leaf) pair after every kind of write, and after a refill from the rows", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const random = rng(seed * 7919);
    const h = new Harness(random);
    for (let step = 0; step < 60; step++) {
      const roll = random();
      if (roll < 0.5) h.append(); else if (roll < 0.65) h.insertBefore(); else if (roll < 0.85) h.insertAfter(); else h.replace();
      if (step % 6 === 5 || step < 8) h.check(`seed ${seed} step ${step}`);
    }
    h.check(`seed ${seed} end`);
    for (const slice of [1, 3, 1000]) { h.refill(slice); h.check(`seed ${seed} refill ${slice}`); }
  }
});

it("a spliced row on a two-row thread, and forty nested splices at one edge, stay on the branch", () => {
  const h = new Harness(() => 0.5);
  h.append(); h.append(); // rows 1 and 2
  const target = [...h.model.rows.keys()][1]!;
  for (let i = 0; i < 40; i++) {
    const parent = h.model.rows.get(target)!.parent;
    const mrow = (h as unknown as { store(id: string, p: number | null): number }).store(`n${i}`, parent);
    (h as unknown as { setParent(m: number, p: number): void }).setParent(target, mrow);
    expect(spliceBefore(h.db, h.tk, mrow, target, parent)).toBe(true);
  }
  h.check("forty nested");
});

it("a long chain with a handful of forks answers in a handful of reads, wherever the row is", () => {
  const db = open();
  const tk = ensureThreadKey(db, "t", () => false);
  db.exec("BEGIN");
  let previous: number | null = null;
  const forks: number[] = [];
  const insert = db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= 100_000; i++) {
    insert.run(i, "t", `r${i}`, i, "user", "text", "x", "{}");
    encodeRow(db, tk, i, previous);
    previous = i;
  }
  // a fork 100 rows from the end, then another off the fork, ten deep
  let fork = 99_900;
  for (let i = 0; i < 10; i++) {
    const row = 100_001 + i;
    insert.run(row, "t", `r${row}`, row, "user", "text", "x", "{}");
    encodeRow(db, tk, row, fork);
    fork = row; forks.push(row);
  }
  db.exec("COMMIT");
  const test = branchOracle(db, tk, fork);
  const before = indexStats.rowReads + indexStats.segReads;
  expect(test(1)).toBe(true);
  expect(test(99_900)).toBe(true);
  expect(test(99_901)).toBe(false);
  expect(test(100_000)).toBe(false);
  expect(test(100_001)).toBe(true);
  expect(test(50_000)).toBe(true);
  expect(indexStats.rowReads + indexStats.segReads - before).toBeLessThanOrEqual(80);
});
