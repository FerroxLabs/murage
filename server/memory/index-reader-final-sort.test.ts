// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.11: a sliced scan returns its connection the moment its last chunk is read, so the final sort (several slices at up to
// SLICED_WINDOW_MAX rows) runs outside the snapshot: a TRUNCATE checkpoint run while the sort is about to start finds no reader in its way,
// and the scan's admission is already given back. The answer is the same as before (one total order).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { openTestIndex } from "./testing/open-index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, memoryIndexScansActive, readerTestProbe, resetScanAdmission } from "./index-reader.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
beforeEach(() => { closeMemoryIndexReader(); resetScanAdmission(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { delete readerTestProbe.beforeSort; closeMemoryIndexReader(); resetScanAdmission(); });

/** 6,000 entries that all match, with ranks in a few ties, so the kept window is past one sort run (2,048) and the sort is sliced. */
async function wideIndex() {
  const index = await openTestIndex(INDEX_PATH());
  index.prepareModel("model");
  index.close();
  const db = new DatabaseSync(INDEX_PATH());
  // A raw bulk load bypasses the production write path (applyBatch: segment gate 48/80, merge floor). The index runs automerge 0 /
  // crisismerge 1999 (MEMW), so an ungated load of this size would pile up segments to SQLITE_FULL: merge normally for the load only,
  // then restore the MEMW settings the production code expects.
  db.exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',8); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',16)");
  db.exec("BEGIN");
  const entry = db.prepare("INSERT INTO entries VALUES(?,1,'s',?)"), word = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (let n = 0; n < 6_000; n++) {
    const text = `quillwort ${"pad ".repeat(n % 7)}row ${n}`;
    const id = `q-${String(n).padStart(5, "0")}`;
    entry.run(id, text); word.run(id, text);
  }
  db.exec("COMMIT");
  db.exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1999)");
  db.close();
}

it("1.11: the final sort runs after the snapshot ended (a TRUNCATE gets busy 0, no scan admitted), with the same answer", { timeout: 300_000 }, async () => {
  await wideIndex();
  const seen: Array<{ busy: number; active: number }> = [];
  readerTestProbe.beforeSort = () => {
    const writer = new DatabaseSync(INDEX_PATH());
    try {
      writer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; INSERT INTO index_meta(key,value) VALUES('final-sort-probe','1') ON CONFLICT(key) DO UPDATE SET value=value||'1'; COMMIT");
      const result = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      seen.push({ busy: Number(result.busy), active: memoryIndexScansActive() });
    } finally { writer.close(); }
  };
  const offset = 2_100;
  const page = await lexicalPageSliced("quillwort", ["s"], 50, offset, undefined, { deadlineAt: Date.now() + 60_000 });
  expect(page).not.toBeNull();
  expect(page!.partial).toBeUndefined();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toEqual(seen.map(() => ({ busy: 0, active: 0 })));
  // the same rows, in the same order, from a fresh walk with no probe
  delete readerTestProbe.beforeSort;
  closeMemoryIndexReader();
  const again = await lexicalPageSliced("quillwort", ["s"], 50, offset, undefined, { deadlineAt: Date.now() + 60_000 });
  expect(again!.hits.map(hit => hit.id)).toEqual(page!.hits.map(hit => hit.id));
  expect(page!.hits).toHaveLength(50);
});
