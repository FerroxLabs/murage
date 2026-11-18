// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW r4.1 (MEMW-POSTINGS-OVERSIZE): the oversize postings path, one row operation a transaction. E1-E3 and E7 (E4-E6 are the geometry tests of
// index-wal), D14' (stored-text price), and the inline gate, the part partition and the seq rule. Each test is one mutant away from red.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestIndex, put } from "./testing/open-index.ts";
import type { IndexedMemory, MemoryIndex } from "./index.ts";
import { MEMW_ENVELOPE_FRAMES, pOp, stepFrames, stepPrice } from "./postings-steps.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const open = () => { const d = mkdtempSync(join(tmpdir(), "memw-ovs-")); dirs.push(d); return openTestIndex(join(d, "i.db")); };
type Any = { db: import("node:sqlite").DatabaseSync; writer: { L(): number; pageSize: number; write: (...a: unknown[]) => unknown }; settle(): Promise<boolean> };
const raw = (index: MemoryIndex) => index as unknown as Any;
const n = (index: MemoryIndex, sql: string, ...args: unknown[]) => Number(raw(index).db.prepare(sql).get(...args as never[])!.n);
const words = (count: number, prefix = "zq") => Array.from({ length: count }, (_, i) => `${prefix}${i.toString(36)}`);
const rec = (i: number, text: string, extra: Partial<IndexedMemory> = {}): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: "scope:a", text, deleted: false, ...extra });
/** The backfill, until nothing is owed: an oversize entry is filled one posting a transaction. */
async function backfill(index: MemoryIndex): Promise<void> { for (let i = 0; i < 5_000 && index.postingsOwed(); i++) await index.fillPostings({ maxMs: 50 }); }
interface Step { shape: string; price: number; rise: number; posted: number; todo: number; parts: number; emptied: boolean }
/** Runs debt steps one at a time to the end, recording each one's declared price, log rise and the rows it changed. */
async function dropAll(index: MemoryIndex, limit = 20_000): Promise<Step[]> {
  const out: Step[] = []; let shape = "", price = 0;
  index.postingStepHook = (s, p) => { shape = s; price = p; };
  try {
    for (let i = 0; i < limit; i++) {
      const L0 = raw(index).writer.L(), posted0 = n(index, "SELECT count(*) AS n FROM postings"), todo0 = n(index, "SELECT count(*) AS n FROM posting_todo"), parts0 = n(index, "SELECT count(*) AS n FROM posting_drop");
      const r = index.postingDropStep();
      if (r === "none") break;
      expect(r).toBe("stepped");
      await raw(index).settle();
      out.push({ shape, price, rise: raw(index).writer.L() - L0, posted: n(index, "SELECT count(*) AS n FROM postings") - posted0, todo: n(index, "SELECT count(*) AS n FROM posting_todo") - todo0,
        parts: n(index, "SELECT count(*) AS n FROM posting_drop") - parts0, emptied: n(index, "SELECT count(*) AS n FROM posting_drop WHERE terms='[]'") > 0 });
    }
  } finally { index.postingStepHook = null; }
  return out;
}
const frames = (index: MemoryIndex, bytes: number) => bytes / (raw(index).writer.pageSize + 24);

describe("E1: every drop, fill, list, unlist, C1 and C2 transaction changes exactly the rows of its shape", () => {
  it("a forgotten 300-term record: one posting a step, then C1, then C2", async () => {
    const index = await open();
    await put(index, [rec(1, words(300).join(" "))]);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(0); // oversize add: listed, nothing inline
    expect(n(index, "SELECT count(*) AS n FROM posting_todo")).toBe(1);
    await backfill(index);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(300);
    expect(n(index, "SELECT count(*) AS n FROM posting_todo")).toBe(0);
    await put(index, [rec(1, "", { deleted: true })]);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(300); // the unit dropped nothing inline
    const parts = n(index, "SELECT count(*) AS n FROM posting_drop");
    expect(parts).toBeGreaterThanOrEqual(2);
    const steps = await dropAll(index);
    const posting = steps.filter(s => s.shape === "posting"), empty = steps.filter(s => s.shape === "empty"), complete = steps.filter(s => s.shape === "complete");
    expect(posting).toHaveLength(300);
    for (const s of posting) expect(s).toMatchObject({ posted: -1, todo: 0, parts: 0 });
    expect(empty).toHaveLength(parts);
    expect(complete).toHaveLength(parts);
    for (const s of complete) expect(s.parts).toBe(-1);
    expect(steps).toHaveLength(300 + 2 * parts);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(0);
    expect(index.deletionScrubPending()).toBe(false);
    index.close();
  });
  it("control: a 1-term part (a record with one long term) takes one posting step, C1, C2", async () => {
    const index = await open();
    await put(index, [rec(1, "a".repeat(600))]);
    await backfill(index);
    await put(index, [rec(1, "", { deleted: true })]);
    expect((await dropAll(index)).map(s => s.shape)).toEqual(["posting", "empty", "complete"]);
    index.close();
  });
});

describe("E2: declared prices equal the design exactly and bound every step's log rise", () => {
  it("a giant-term part (one 98 KB term, 32 short terms, a 1,500 B term)", async () => {
    const index = await open();
    const text = [..."abcdefgh"].flatMap(c => words(4, `q${c}`)).concat(["g".repeat(98_000), "h".repeat(1_500)]).join(" ");
    await put(index, [rec(1, text)]);
    await backfill(index);
    await put(index, [rec(1, "", { deleted: true })]);
    const steps = await dropAll(index), F_W = stepFrames(raw(index).writer.pageSize);
    expect(F_W).toBe(1018);
    expect(MEMW_ENVELOPE_FRAMES).toBe(324);
    for (const s of steps) { expect(frames(index, s.rise)).toBeLessThanOrEqual(s.price); expect(s.price).toBeLessThanOrEqual(F_W); }
    const prices = new Map(steps.map(s => [s.shape, s.price]));
    const giant = steps.filter(s => s.shape === "posting").map(s => s.price).sort((a, b) => b - a)[0];
    expect(giant).toBe(13 * 21 + 2 * 9 + 2 + 324); // FTS5 cuts a token at 32,768 B: payload 32,792 B = 9 overflow pages (the design's 196,608 B term cannot exist)
    expect(prices.get("complete")).toBe(2 * (13 * 21 + 2 + 2) + 324); // 878: the part row and its posting_drop_seq row
    expect(stepPrice.todo()).toBe(601);
    expect(pOp(20, 196_608 + 24) + 324).toBe(697);
    index.close();
  });
  it("control: 33 short terms", async () => {
    const index = await open();
    await put(index, [rec(1, words(300).join(" "))]);
    await backfill(index);
    await put(index, [rec(1, "", { deleted: true })]);
    for (const s of await dropAll(index)) { expect(frames(index, s.rise)).toBeLessThanOrEqual(s.price); expect(s.price).toBeLessThanOrEqual(1018); }
    index.close();
  });
});

describe("E3: completion runs in its own payload-free transactions", () => {
  it("after the last posting delete the part row is intact, then C1 empties it, then C2 removes the row and its index entry", async () => {
    const index = await open();
    await put(index, [rec(1, "a".repeat(600))]);
    await backfill(index);
    await put(index, [rec(1, "", { deleted: true })]);
    const partId = n(index, "SELECT id AS n FROM posting_drop");
    const seq = n(index, "SELECT seq AS n FROM posting_drop");
    expect(index.postingDropStep()).toBe("stepped"); await raw(index).settle(); // the posting
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(0);
    expect(n(index, "SELECT count(*) AS n FROM posting_drop WHERE id=? AND terms<>'[]'", partId)).toBe(1); // part row intact
    expect(index.postingDropStep()).toBe("stepped"); await raw(index).settle(); // C1
    expect(n(index, "SELECT count(*) AS n FROM posting_drop WHERE id=? AND terms='[]'", partId)).toBe(1);
    expect(index.postingDropStep()).toBe("stepped"); await raw(index).settle(); // C2
    expect(n(index, "SELECT count(*) AS n FROM posting_drop")).toBe(0);
    expect(n(index, "SELECT count(*) AS n FROM posting_drop INDEXED BY posting_drop_seq WHERE seq=?", seq)).toBe(0);
    expect(index.postingDropStep()).toBe("none");
    index.close();
  });
});

describe("E7: the picker skips a listed seq while parts remain, and opens no write transaction for an empty read", () => {
  it("0 fill transactions during the drain; the seq is filled after C2", async () => {
    const index = await open();
    await put(index, [rec(1, words(300).join(" "))]); // listed, oversize
    const scope = n(index, "SELECT scope AS n FROM posting_todo"), seq = n(index, "SELECT seq AS n FROM posting_todo");
    // an older build's debt on the same (scope, seq): a part naming one of its terms, and one posting already there
    raw(index).db.prepare("INSERT INTO posting_drop(scope,seq,terms) VALUES(?,?,?)").run(scope, seq, JSON.stringify(["zq0"]));
    raw(index).db.prepare("INSERT INTO postings(term,scope,seq) VALUES('zq0',?,?)").run(scope, seq);
    const w = raw(index).writer, real = w.write.bind(w), kinds: string[] = [];
    w.write = (kind: unknown, ...rest: unknown[]) => { kinds.push(String(kind)); return real(kind, ...rest); };
    expect(index.postingsOwed()).toBe(false); // the only listed seq has debt: nothing for the filler
    expect(await index.fillPostings({ maxMs: 50 })).toMatchObject({ done: true, filled: 0 });
    while (index.postingDropOwed()) { expect(index.postingDropStep()).toBe("stepped"); await raw(index).settle(); if (index.postingDropOwed()) expect(await index.fillPostings({ maxMs: 50 })).toMatchObject({ filled: 0 }); }
    expect(kinds.filter(k => k === "fill")).toEqual([]);
    expect(index.takeFillKick()).toBe(true);
    expect(index.postingsOwed()).toBe(true);
    await backfill(index);
    expect(n(index, "SELECT count(*) AS n FROM postings WHERE scope=? AND seq=?", scope, seq)).toBe(300);
    index.close();
  });
});

describe("the inline gate, the part partition and the seq rule", () => {
  it("D4: a 2,000 B token plus 10 short terms is never inline", async () => {
    const index = await open();
    await put(index, [rec(1, ["t".repeat(2_000), ...words(10)].join(" "))]);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(0);
    expect(n(index, "SELECT count(*) AS n FROM posting_todo")).toBe(1);
    index.close();
  });
  it("D4 control: a 512 B token is inline", async () => {
    const index = await open();
    await put(index, [rec(1, ["t".repeat(512), ...words(10)].join(" "))]);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(11);
    expect(n(index, "SELECT count(*) AS n FROM posting_todo")).toBe(0);
    index.close();
  });
  it("D15: 5,000 short terms: every part holds at most 33 terms and together they are the term set", async () => {
    const index = await open();
    const all = words(5_000);
    await put(index, [rec(1, all.join(" "))]);
    await backfill(index);
    await put(index, [rec(1, "", { deleted: true })]);
    const rows = raw(index).db.prepare("SELECT terms FROM posting_drop ORDER BY id").all().map(r => JSON.parse(String(r.terms)) as string[]);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(33);
    expect(rows.flat().sort()).toEqual([...all].sort());
    index.close();
  });
  it("D9: a forgotten record's seq with debt pending is never reused by a new record (also with no other entries)", async () => {
    const index = await open();
    await put(index, [rec(1, words(300).join(" "))]);
    await backfill(index);
    await put(index, [rec(1, "", { deleted: true })]);
    const debtSeq = n(index, "SELECT max(seq) AS n FROM posting_drop");
    expect(n(index, "SELECT count(*) AS n FROM entries")).toBe(0);
    await put(index, [rec(2, "zq1 fresh words")]);
    expect(n(index, "SELECT rowid AS n FROM entries WHERE id='memory:2'")).toBeGreaterThan(debtSeq);
    await dropAll(index);
    expect(n(index, "SELECT count(*) AS n FROM postings p JOIN entries e ON e.rowid=p.seq")).toBe(3);
    index.close();
  });
  it("an oversize record replaced by a short text drains its old postings and keeps the new ones", async () => {
    const index = await open();
    await put(index, [rec(1, words(300).join(" "))]);
    await backfill(index);
    await put(index, [rec(1, "zq1 other")]);
    expect(n(index, "SELECT count(*) AS n FROM posting_drop")).toBeGreaterThan(0);
    await dropAll(index);
    expect(n(index, "SELECT count(*) AS n FROM postings")).toBe(2);
    index.close();
  });
});

describe("D14': the price of a stored text", () => {
  it("units() charges 2 x scratch for the stored text and 8 x (bytes + 64) for an oversize stored text (196,608 B)", async () => {
    const index = await open();
    const text = words(28_000, "k").join(" ").slice(0, 196_608).replace(/\s\S*$/, "");
    await put(index, [rec(1, text)]);
    const one = index.unitPostingsCost(text, null), none = index.unitPostingsCost(null, null);
    const page = raw(index).writer.pageSize, fz = page + 24, bytes = Buffer.byteLength(text, "utf8");
    expect(none).toBe(4 * fz); // no side: postingsCost(0) is the bare +4
    expect(one).toBeGreaterThanOrEqual(8 * (bytes + 64) + 2 * Math.ceil(4 * bytes / page) * fz); // a stored text of 196,608 B prices >= the mutant (stored x R_d dropped)
    expect(frames(index, one)).toBeGreaterThan(98);
    index.close();
  });
});
