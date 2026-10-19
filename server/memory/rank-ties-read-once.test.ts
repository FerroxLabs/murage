// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lane 2, item 2.5 (r3.6): the recall walk's ceiling counts stepped rows (index-reader.ts lexicalPageSliced: `stepped` moves per
// row pulled from the ranked batch, emitted or not), and a run of equal ranks is read once per search within the kept window: the
// pages that follow the first inside the window run no statement at all.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, recallWork } from "./index-reader.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMemoryIndexReader(); });

/** 40,000 entries in groups of 500 with the same text (the same rank), a rare word in every group. */
function tiedIndex() {
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.close();
  const db = new DatabaseSync(INDEX_PATH());
  db.exec("BEGIN");
  const entry = db.prepare("INSERT INTO entries VALUES(?,1,'s',?)"), word = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (let n = 0; n < 40_000; n++) {
    const text = `zephyrine group ${Math.floor(n / 500)} of equal weight`;
    const id = `t-${String(n).padStart(6, "0")}`;
    entry.run(id, text); word.run(id, text);
  }
  db.exec("COMMIT");
  db.close();
}

describe("recall over 500-row tie groups", () => {
  it("reads a tie run once per search inside the window: the next pages cost no statement, and no row is repeated or skipped", { timeout: 300_000 }, async () => {
    tiedIndex();
    const seen: string[] = [];
    const statements: number[] = [];
    for (const offset of [0, 50, 100]) {
      const before = recallWork.statements;
      const page = await lexicalPageSliced("zephyrine", ["s"], 50, offset, undefined, { deadlineAt: Date.now() + 10_000 });
      statements.push(recallWork.statements - before);
      expect(page).not.toBeNull();
      expect(page!.hits).toHaveLength(50);
      expect(page!.partial).toBeUndefined();
      seen.push(...page!.hits.map(hit => hit.id));
    }
    expect(new Set(seen).size).toBe(150);
    expect(statements[0]).toBeGreaterThan(0);
    expect(statements[1]).toBe(0);
    expect(statements[2]).toBe(0);
    // the order is one total order: the same 150 rows again, in the same order, from a fresh walk
    closeMemoryIndexReader();
    const again: string[] = [];
    for (const offset of [0, 50, 100]) again.push(...(await lexicalPageSliced("zephyrine", ["s"], 50, offset, undefined, { deadlineAt: Date.now() + 10_000 }))!.hits.map(hit => hit.id));
    expect(again).toEqual(seen);
  });
});
