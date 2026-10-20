// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane msearch2 (1.0.2), Astra r2c P1: how many private records hold a word must never change what a reader's recall returns. On
// 5e16ad19c the word choice probed 2,000 postings of the WHOLE index before counting the reader's own, so 2,000 private "zephyrine"
// records turned the reader's question into a search for "zephyrine", and its 50 readable "pipeline" results became none (more:false,
// no partial, no bounded). Recall now reads a posting index keyed by (word, scope), so nothing another scope holds is ever stepped.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, recallWork } from "./index-reader.ts";
import { POSTINGS_BELOW, wordTerms } from "./postings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMemoryIndexReader(); });

type Row = { id: string; scope: string; text: string };
/** A fresh index holding these rows, written straight to its tables (as an older build or a test does): the triggers keep the postings. */
function indexOf(rows: Iterable<Row>) {
  closeMemoryIndexReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  new MemoryIndex(INDEX_PATH()).close();
  const db = new DatabaseSync(INDEX_PATH());
  db.exec("BEGIN");
  const entry = db.prepare("INSERT INTO entries VALUES(?,1,?,?)"), word = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (const row of rows) { entry.run(row.id, row.scope, row.text); word.run(row.id, row.text); }
  db.exec("COMMIT");
  db.close();
}
function* readable(count: number): Generator<Row> { for (let n = 0; n < count; n++) yield { id: `mine-${String(n).padStart(5, "0")}`, scope: "s", text: `pipeline note${n} quarterly` }; }
function* hidden(count: number, text = (n: number) => `zephyrine private${n}`): Generator<Row> { for (let n = 0; n < count; n++) yield { id: `theirs-${String(n).padStart(7, "0")}`, scope: "x", text: text(n) }; }
async function recall(query: string) {
  const before = { ...recallWork };
  const page = (await lexicalPageSliced(query, ["s"], 50, 0, undefined, { deadlineAt: Date.now() + 5000 }))!;
  const work = Object.fromEntries(Object.entries(recallWork).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
  return { page, ids: page.hits.map(hit => hit.id), work };
}

describe("recall: private postings never change what a reader gets", () => {
  it("Astra's table: 0, 1, 1,999, 2,000 and 200,000 private 'zephyrine' records give the reader the same 50 'pipeline' results, with the same work", { timeout: 600_000 }, async () => {
    const runs: Array<Awaited<ReturnType<typeof recall>> & { hidden: number }> = [];
    for (const count of [0, 1, 1_999, 2_000, 200_000]) {
      indexOf([...readable(1000), ...hidden(count)]);
      runs.push({ ...await recall("pipeline zephyrine"), hidden: count });
    }
    for (const run of runs) {
      console.log(`[r2c] ${run.hidden} private: ${run.ids.length} hits, more=${run.page.more}, statements=${run.work.statements}`);
      expect(run.ids).toHaveLength(50);
      expect(run.ids.every(id => id.startsWith("mine-"))).toBe(true);
      expect(run.page.partial).toBeUndefined();
      expect(run.page.bounded).toBeUndefined();
      expect(run.ids).toEqual(runs[0]!.ids);
      expect(run.page.more).toBe(runs[0]!.page.more);
      expect(run.work).toEqual(runs[0]!.work);
    }
  });

  it("a word the reader holds once narrows the query to it, with 0 or 200,000 private records holding it too", { timeout: 600_000 }, async () => {
    const rare = { id: "mine-rare", scope: "s", text: "pipeline zephyrine decision" };
    indexOf([...readable(1200), rare]);
    const without = await recall("pipeline zephyrine");
    indexOf([...readable(1200), rare, ...hidden(200_000)]);
    const withPrivate = await recall("pipeline zephyrine");
    expect(without.ids).toEqual(["mine-rare"]);
    expect(withPrivate.ids).toEqual(["mine-rare"]);
    expect(withPrivate.page).toEqual(without.page);
    expect(withPrivate.work).toEqual(without.work);
  });

  it("the statements, and the postings they read, are the same at 1k and at 1M private postings", { tags: ["nightly"], timeout: 900_000 }, async () => {
    const at = async (count: number) => { indexOf([...readable(1000), { id: "mine-rare", scope: "s", text: "zephyrine plan" }, ...hidden(count, n => `zephyrine pipeline ${n % 2 ? "quarterly" : "plan"}`)]); return recall("pipeline zephyrine quarterly plan"); };
    const small = await at(1_000), large = await at(1_000_000);
    console.log(`[r2c] statements 1k=${small.work.statements} 1M=${large.work.statements}`);
    expect(small.ids.length).toBeGreaterThan(0);
    expect(large.ids).toEqual(small.ids);
    expect(large.work).toEqual(small.work);
    expect(large.work.statements).toBeGreaterThan(0);
  });

  it("a reader of several scopes counts each of its own scopes, and a scope it cannot read adds nothing", async () => {
    indexOf([...readable(600), ...Array.from({ length: 600 }, (_, n) => ({ id: `team-${n}`, scope: "t", text: `pipeline team${n}` })), ...hidden(5000, n => `pipeline private${n}`)]);
    const both = (await lexicalPageSliced("pipeline", ["s", "t"], 50, 0))!;
    expect(both.hits).toHaveLength(50);
    expect(both.hits.every(hit => !hit.id.startsWith("theirs-"))).toBe(true);
    // 1,200 readable postings: common for this reader (the newest are read); 600 for a reader of one scope: narrow (all read, ranked)
    const before = recallWork.rankedScans;
    await lexicalPageSliced("pipeline", ["s"], 50, 0);
    expect(recallWork.rankedScans - before).toBe(1);
  });
});

describe("recall: the postings of an index made before them", () => {
  it("are filled newest first in short resumable steps; until then the page says it read only the newest, and after it equals a fresh index", { timeout: 300_000 }, async () => {
    const rows = [...readable(3000), { id: "mine-old", scope: "s", text: "zephyrine first" }, ...hidden(3000)].reverse();
    indexOf(rows);
    const fresh = await recall("zephyrine pipeline");
    // the same file as an earlier build left it: no postings objects at all
    const raw = new DatabaseSync(INDEX_PATH());
    raw.exec(`DROP TRIGGER entries_postings_replace; DROP TRIGGER entries_postings_insert; DROP TRIGGER entries_postings_delete; DROP TRIGGER entries_postings_update;
      DROP TABLE posting_vocab; DROP TABLE posting_words; DROP TABLE postings; DROP TABLE posting_scopes;`);
    raw.close();
    closeMemoryIndexReader();
    const index = new MemoryIndex(INDEX_PATH());
    expect(index.postingsOwed()).toBe(true);
    // a record written after the upgrade has its postings at once (the triggers)
    index.upsert([{ id: "mine-new", version: 1, scopeId: "s", text: "zephyrine latest", deleted: false }]);
    const during = await recall("zephyrine");
    expect(during.ids).toEqual(["mine-new"]);
    expect(during.page.bounded).toBe(true);
    let steps = 0;
    const first = index.fillPostings({ maxMs: 1000, maxRows: 500 });
    steps++;
    expect(first).toEqual({ done: false, filled: 500 });
    // stopped here (the helper killed): a new handle resumes from the recorded rowid
    index.close();
    const resumed = new MemoryIndex(INDEX_PATH());
    const meta = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    const below = Number((meta.prepare("SELECT value FROM index_meta WHERE key=?").get(POSTINGS_BELOW) as { value: string }).value);
    // closed here, not left to the collector: an open handle keeps Windows from removing the folder before the next test
    meta.close();
    expect(below).toBeGreaterThan(1);
    for (;;) { steps++; const step = resumed.fillPostings({ maxMs: 5, maxRows: 256 }); if (step.done) break; }
    expect(steps).toBeGreaterThan(3);
    expect(resumed.postingsOwed()).toBe(false);
    resumed.upsert([{ id: "mine-new", version: 1, scopeId: "s", text: "zephyrine latest", deleted: true }]);
    resumed.close();
    closeMemoryIndexReader();
    const after = await recall("zephyrine pipeline");
    expect(after.page).toEqual(fresh.page);
  });

  it("forgetting a record removes its postings, and re-indexing a record replaces them", async () => {
    indexOf(readable(10));
    const index = new MemoryIndex(INDEX_PATH());
    index.upsert([{ id: "mine-z", version: 1, scopeId: "s", text: "zephyrine draft", deleted: false }]);
    expect((await recall("zephyrine")).ids).toEqual(["mine-z"]);
    index.upsert([{ id: "mine-z", version: 1, scopeId: "s", text: "renamed draft", deleted: false }]);
    expect((await recall("zephyrine")).ids).toEqual([]);
    expect((await recall("renamed")).ids).toEqual(["mine-z"]);
    index.upsert([{ id: "mine-z", version: 1, scopeId: "s", text: "renamed draft", deleted: true }]);
    expect((await recall("renamed")).ids).toEqual([]);
    const db = new DatabaseSync(INDEX_PATH(), { readOnly: true });
    expect(db.prepare("SELECT count(*) AS n FROM postings WHERE term IN ('zephyrine','renamed','draft')").get()!.n).toBe(0);
    db.close();
    index.close();
  });

  it("the words are the index's own: case and accents folded, joined words split", () => {
    expect(wordTerms("Zéphyrine")).toEqual(["zephyrine"]);
    expect(wordTerms("pipe-line_v2")).toEqual(["line", "pipe", "v2"]);
  });
});
