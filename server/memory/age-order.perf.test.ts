// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lane 2, the measured gate (LANE2-MEMORY-DESIGN r2.8, r3.3): on a synthetic 1,000,000-record store no statement of owner search
// or browse runs over 50 ms, on every fixture the design names (a sparse scope of 50 records, a common word across the years, two
// conjunctive common words, 64 KB documents, mode F mid-fill and mode R), and the p95 is reported. Runs on the build host rig only
// (MEMORY_PERF_LANE2=1): the fixture takes minutes to write.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { AGE_FILL_BELOW, LEXICAL_GENERATION, LEXICAL_ROWIDS } from "./age-index.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { ownerMemoryList, ownerSearchTrace, ownerSearchWork, type OwnerListInput } from "./owner-list.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { fillRecordKeysNow } from "./record-keys.ts";
import { dropRecordKeys, ensureRecordKeys, RECORD_KEYS_TABLE } from "./schema.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const suite = process.env.MEMORY_PERF_LANE2 === "1" ? describe : describe.skip;
const COUNT = Number(process.env.MEMORY_PERF_LANE2_ROWS ?? 1_000_000);
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const roster = { bots: [{ id: "a", threadId: "ta" }, { id: "sparse", threadId: "ts" }], groups: [] };
const WORDS = ["pipeline", "renewals", "hiring", "weekly", "client", "report", "budget", "review", "launch", "design"];
const STATES = ["active", "active", "active", "candidate", "archived", "superseded"];
const list = (input: OwnerListInput) => ownerMemoryList(input, roster);

suite("1,000,000 records: no statement over 50 ms", () => {
  let scope = "", sparse = "", first = 0;
  beforeAll(() => {
    closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster);
    const db = database();
    scope = ensureScope("bot", "a"); sparse = ensureScope("bot", "sparse");
    // records across six years, one every ~190 s, a few per millisecond now and then, through the backfill (the trigger is measured elsewhere)
    dropRecordKeys(db);
    const started = performance.now();
    db.exec("BEGIN");
    const add = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement',?,?,?,NULL,NULL,?)");
    const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'indexed','unavailable',NULL)");
    first = Date.UTC(2020, 0, 1);
    const big = "lorem ipsum dolor sit amet ".repeat(2600); // ~64 KB
    for (let n = 0; n < COUNT; n++) {
      const id = `r${String(n).padStart(7, "0")}`;
      const words = `${WORDS[n % 10]} ${WORDS[(n * 7) % 10]} ${WORDS[(n * 3) % 10]} note${n}${n % 20_000 === 0 ? " zephyrine" : ""}${n % 100_000 === 7 ? ` ${big}` : ""}`;
      const at = first + Math.floor(n / 3) * 190_000 + (n % 3 === 0 ? 0 : 0);
      add.run(id, n % 20_000 === 11 ? sparse : scope, words, STATES[n % 6], n % 5000 === 0 ? 1 : 0, at, at);
      receipt.run(id);
    }
    db.exec("COMMIT");
    console.log(`[lane2 perf] ${COUNT} records written in ${((performance.now() - started) / 1000).toFixed(0)} s`);
    const keyed = performance.now();
    ensureRecordKeys(db);
    fillRecordKeysNow(db);
    console.log(`[lane2 perf] keys backfilled in ${((performance.now() - keyed) / 1000).toFixed(0)} s`);
    // the index in age order, written as the helper writes it
    const indexed = performance.now();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
    new MemoryIndex(INDEX_PATH()).close();
    const raw = new DatabaseSync(INDEX_PATH());
    raw.exec("BEGIN");
    const entry = raw.prepare("INSERT INTO entries VALUES(?,1,?,?)"), word = raw.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,?)"), key = raw.prepare("INSERT INTO lexical_keys VALUES(?,1,?)");
    for (const row of db.prepare(`SELECT r.id,r.scope_id AS s,r.text,k.age_key AS k FROM memory_records r JOIN ${RECORD_KEYS_TABLE} k ON k.record_id=r.id AND k.record_version=r.version`).iterate() as Iterable<{ id: string; s: string; text: string; k: number }>) {
      entry.run(row.id, row.s, row.text); word.run(row.k, row.id, row.text); key.run(row.id, row.k);
    }
    raw.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(LEXICAL_ROWIDS, "age");
    raw.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(LEXICAL_GENERATION, "1");
    raw.exec("COMMIT");
    raw.close();
    console.log(`[lane2 perf] index written in ${((performance.now() - indexed) / 1000).toFixed(0)} s`);
  }, 1_800_000);
  afterAll(() => { closeMemoryIndexReader(); });

  const cases: Array<[string, OwnerListInput, number]> = [
    ["browse scoped default", { botId: "a" }, 3], ["browse scoped recent", { botId: "a", view: "recent" }, 3], ["browse scoped important", { botId: "a", view: "important" }, 3],
    ["browse scoped review", { botId: "a", view: "review" }, 3], ["browse scoped archived", { botId: "a", state: "archived" }, 3],
    ["browse unscoped default", {}, 3], ["browse unscoped recent", { view: "recent" }, 3], ["browse unscoped important", { view: "important" }, 3], ["browse unscoped candidate", { state: "candidate" }, 3],
    ["sparse scope, common word", { botId: "sparse", query: "pipeline" }, 3], ["sparse scope, browse", { botId: "sparse" }, 3],
    ["common word", { botId: "a", query: "pipeline" }, 3], ["two common words (conjunction)", { botId: "a", query: "pipeline renewals" }, 3],
    ["two common words, no co-occurrence", { botId: "a", query: "pipeline report" }, 2],
    ["rare word across the years", { botId: "a", query: "zephyrine" }, 3], ["64 KB documents", { botId: "a", query: "lorem ipsum" }, 2],
    ["no match", { botId: "a", query: "nonexistentword" }, 1], ["important with a word", { botId: "a", query: "pipeline", view: "important" }, 2],
  ];

  async function measure(label: string, input: OwnerListInput, pages: number) {
    ownerSearchTrace.on = true; ownerSearchTrace.statements = []; ownerSearchTrace.times = [];
    ownerSearchWork.slowestMs = 0;
    const started = performance.now();
    let cursor: string | undefined, shown = 0;
    for (let n = 0; n < pages; n++) {
      const page = await list({ ...input, ...(cursor ? { cursor } : {}) });
      shown += page.rows.length;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const ms = performance.now() - started;
    ownerSearchTrace.on = false;
    const times = [...ownerSearchTrace.times].sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    const slowest = ownerSearchTrace.statements[ownerSearchTrace.times.indexOf(Math.max(...ownerSearchTrace.times))];
    console.log(`[lane2 perf] ${label}: ${pages} page(s), ${shown} rows, ${times.length} statements, max ${ownerSearchWork.slowestMs.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, page time ${(ms / pages).toFixed(0)} ms`);
    if (ownerSearchWork.slowestMs > 50) console.log(`[lane2 perf] slowest: ${slowest?.sql.replace(/\s+/g, " ").slice(0, 300)}`);
    return { max: ownerSearchWork.slowestMs, p95 };
  }

  for (const [label, input, pages] of cases) {
    it(`mode R: ${label}`, { timeout: 600_000 }, async () => {
      const { max, p95 } = await measure(label, input, pages);
      expect(p95).toBeLessThanOrEqual(50);
      expect(max).toBeLessThanOrEqual(50);
    });
  }

  it("mode F mid-fill: the same searches over the second word table above the frontier", { timeout: 900_000 }, async () => {
    // the index as 1.0.2 left it (automatic rowids) half copied: the fill's frontier in the middle of the run
    closeMemoryIndexReader();
    const raw = new DatabaseSync(INDEX_PATH());
    raw.exec("BEGIN");
    raw.exec("DELETE FROM index_meta WHERE key IN ('lexical_rowids','lexical_generation')");
    raw.exec("CREATE VIRTUAL TABLE lexical_age USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61')");
    raw.exec("CREATE TABLE lexical_age_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version))");
    const half = Number(raw.prepare("SELECT fts_rowid AS k FROM lexical_keys ORDER BY fts_rowid DESC LIMIT 1 OFFSET ?").get(Math.floor(COUNT / 2))!.k);
    raw.exec("INSERT INTO lexical_age(rowid,id,version,text) SELECT l.rowid,l.id,l.version,l.text FROM lexical l WHERE l.rowid>=" + half);
    raw.exec("INSERT INTO lexical_age_keys SELECT id,version,fts_rowid FROM lexical_keys WHERE fts_rowid>=" + half);
    raw.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(AGE_FILL_BELOW, String(half));
    raw.exec("COMMIT");
    raw.close();
    for (const [label, input, pages] of cases.filter(([, input]) => input.query)) {
      const { max, p95 } = await measure(`F ${label}`, input, pages);
      expect(p95).toBeLessThanOrEqual(50);
      expect(max).toBeLessThanOrEqual(50);
    }
  });
});
