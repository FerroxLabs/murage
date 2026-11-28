// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (HIDDEN-COST item 5; owner: q1022-sqlite-opus): io-budget.ts instrumentDatabase sampled the log (a stat of -wal and
// -shm and a read of -shm) around every exec outside a transaction, and classified every statement text with about 8 regexes on every
// prepare. Real messages.db through database() (the production instrumented handle).
//  W5a: 100 reads and settings by exec take no log sample; a commit still takes its sample (the bytes are still charged).
//  W5b: preparing the same text 100 times classifies it once (counted as RegExp.prototype.test calls inside the prepares).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { ioBudget } from "./io-budget.ts";
import { closeDatabase, database } from "./database.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

async function cleanSlate() { closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
beforeEach(cleanSlate);
afterEach(async () => { vi.restoreAllMocks(); ioBudget.stop(); await cleanSlate(); });

it("W5a per-commit sampling: reads and settings by exec take no log sample; a commit still takes one", () => {
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS fixture_w5(id INTEGER PRIMARY KEY, body TEXT)");
  const samples = vi.spyOn(ioBudget, "sampleByteSource");
  for (let index = 0; index < 50; index++) { db.exec("SELECT count(*) FROM fixture_w5"); db.exec("PRAGMA busy_timeout"); }
  const reads = samples.mock.calls.length;
  console.log(`SQLITE-MEASURE W5a samples-for-100-reads=${reads}`);
  expect(reads, "W5a: a read or a setting outside a transaction adds no frame, so it takes no sample (base: two each)").toBe(0);
  db.exec("BEGIN IMMEDIATE"); db.prepare("INSERT INTO fixture_w5(body) VALUES(?)").run("fixture row");
  const open = samples.mock.calls.length;
  db.exec("COMMIT"); // inside the transaction nothing is sampled before it: only the commit's own sample can count here
  expect(samples.mock.calls.length - open, "W5a: the commit is still sampled (its frames are charged)").toBeGreaterThanOrEqual(1);
  const writes = samples.mock.calls.length;
  db.exec("PRAGMA incremental_vacuum(1)"); // adds frames with no word a write is known by (self-review High 1)
  expect(samples.mock.calls.length - writes, "W5a: a statement that adds frames without a write keyword is still sampled").toBeGreaterThanOrEqual(1);
});

it("W5b cached classification: the same statement text prepared 100 times is classified once", () => {
  const db = database();
  const sql = "SELECT 1 AS fixture_w5b WHERE ? IS NOT NULL";
  db.prepare(sql); // the first prepare may classify
  const tests = vi.spyOn(RegExp.prototype, "test");
  for (let index = 0; index < 100; index++) db.prepare(sql).get(index);
  const calls = tests.mock.calls.length;
  tests.mockRestore();
  console.log(`SQLITE-MEASURE W5b regex-tests-for-100-prepares=${calls}`);
  expect(calls, "W5b: no regex runs again for a text already classified (base: about 8 per prepare)").toBeLessThanOrEqual(10);
});
