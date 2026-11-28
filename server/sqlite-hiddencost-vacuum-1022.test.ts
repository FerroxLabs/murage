// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (HIDDEN-COST item 7; owner: q1022-sqlite-opus): the memory worker's idle storage sweep (root-set-compaction.ts
// maintainLineageStorage) ran up to 64 incremental_vacuum(512) commits for any free page. Real messages.db of a new installation
// (auto_vacuum=INCREMENTAL), the real sweep. W7: a few free pages (under 5% of the file, under 64 MiB) stay for SQLite to reuse and no
// vacuum statement runs; a free share over the bound is still handed back.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { ioBudget } from "./io-budget.ts";
import { closeDatabase, database } from "./database.ts";
import { maintainLineageStorage } from "./memory/root-set-compaction.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

async function cleanSlate() { closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
beforeEach(cleanSlate);
afterEach(async () => { ioBudget.stop(); await cleanSlate(); });

it("W7 vacuum threshold: a few free pages are left for reuse with no vacuum statement; a large free share is still handed back", { timeout: 120_000 }, async () => {
  const db = database();
  const pragma = (name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0]);
  expect(pragma("auto_vacuum"), "a new installation has incremental vacuum").toBe(2);
  const vacuums: string[] = [], exec = db.exec.bind(db);
  (db as unknown as { exec: unknown }).exec = (sql: string) => { if (/incremental_vacuum/i.test(sql)) vacuums.push(sql); return exec(sql); };
  db.exec("CREATE TABLE fixture_filler(id INTEGER PRIMARY KEY, body BLOB)");
  const insert = db.prepare("INSERT INTO fixture_filler(body) VALUES(randomblob(16384))");
  db.exec("BEGIN"); for (let index = 0; index < 400; index++) insert.run(); db.exec("COMMIT");
  db.prepare("DELETE FROM fixture_filler WHERE id <= 3").run(); // about 12 pages of a file over 1,600 pages: well under 5%
  const freeSmall = pragma("freelist_count");
  expect(freeSmall, "the delete left free pages").toBeGreaterThan(0);
  expect(freeSmall, "under the 5% share").toBeLessThan(pragma("page_count") * 0.05);
  await maintainLineageStorage({ database: () => db, idle: () => true, pauseMs: 0 });
  console.log(`SQLITE-MEASURE W7 small-free=${freeSmall} vacuum-statements=${vacuums.length} free-after=${pragma("freelist_count")}`);
  expect(vacuums.length, "W7: a few free pages cost no incremental_vacuum commit").toBe(0);
  expect(pragma("freelist_count"), "W7: the free pages are left for reuse").toBe(freeSmall);
  db.prepare("DELETE FROM fixture_filler WHERE id <= 200").run(); // about half the file
  await maintainLineageStorage({ database: () => db, idle: () => true, pauseMs: 0 });
  expect(vacuums.length, "W7: a large free share is handed back").toBeGreaterThan(0);
  expect(pragma("freelist_count"), "W7: handed back in full").toBe(0);
});
