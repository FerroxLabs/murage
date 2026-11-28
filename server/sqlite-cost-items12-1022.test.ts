// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (MAIN-RULING SQLITE-1022 2026-11-25T18:12:59Z items 1 and 2; owner: q1022-sqlite-opus). The real database handle
// (database.ts open), the real checkpoint worker and supervisor, the real deleteThread and deletion scrub.
//  W1a-FAST  an ordinary delete on the server connection no longer zero-writes every page it frees (secure_delete=FAST by default).
//  W1a-SITE  deleteThread (message-db.ts) still zeroes the pages it frees: after its scrub no byte of the deleted text is left in the files.
//  W1b-LIMIT a restarted log keeps its file up to 16 MiB (journal_size_limit), and the kept tail is no copy debt (walBacklog).
//  W1b-SCRUB in a kept 16 MiB log the deletion scrub still cuts the log to its own frames (its nudge commits at limit 0).
//  W2        a burst of small commits 150 ms apart makes no checkpoint pass while it comes; one pass follows the quiet.
//  W2-TRICKLE commits 1 s apart (never quiet) still get a pass within the 30 s max age.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { ioBudget } from "./io-budget.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { deleteThread } from "./message-db.ts";
import { scrubWalAfterDelete, settleWal, stopWalMaintenance, walBacklog, walMaintenanceCounters, walMaintenanceReady } from "./wal-maintenance.ts";
import { searchCleanupPending, stopSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const file = () => join(DATA_DIR, "messages.db");
const walBytes = () => { try { return statSync(file() + "-wal").size; } catch { return 0; } };
async function cleanSlate() { closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
async function ready() {
  await cleanSlate();
  const db = database();
  await vi.waitFor(() => expect(searchCleanupPending(db)).toBe(false), { timeout: 10_000, interval: 10 });
  await stopSearchIndex();
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  db.exec("CREATE TABLE IF NOT EXISTS canary(id INTEGER PRIMARY KEY, body TEXT)");
  expect(await settleWal({ nudge: true })).toBe(true);
  return db;
}
/** Grows the log past 16 MiB in one transaction, copies it (no nudge), and makes one small commit, which restarts it. */
async function keptLog() {
  const db = await ready();
  transaction(d => { const put = d.prepare("INSERT INTO canary(body) VALUES(?)"); for (let i = 0; i < 24; i++) put.run("k".repeat(1024 * 1024)); });
  transaction(d => { d.exec("DELETE FROM canary"); });
  await vi.waitFor(async () => expect(await settleWal()).toBe(true), { timeout: 20_000, interval: 50 });
  const polls = walMaintenanceCounters()!.polls;
  transaction(d => { d.prepare("INSERT INTO canary(body) VALUES(?)").run("small"); });
  // the worker has read the restarted log (its quiet holds the pass itself for 5 s after this commit)
  await vi.waitFor(() => expect(walMaintenanceCounters()!.polls).toBeGreaterThan(polls), { timeout: 5_000, interval: 5 });
  return db;
}
beforeEach(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(async () => { ioBudget.stop(); await cleanSlate(); });

it("W1a-FAST: an ordinary delete of a 2 MiB row writes a few pages to the log, not every page it frees", { timeout: 60_000 }, async () => {
  const db = await ready();
  transaction(d => { d.prepare("INSERT INTO canary(body) VALUES(?)").run("f".repeat(2 * 1024 * 1024)); });
  expect(await settleWal({ nudge: true })).toBe(true);
  const before = walBytes();
  transaction(d => { d.exec("DELETE FROM canary"); });
  const grew = walBytes() - before;
  console.log(`SQLITE-MEASURE W1a-FAST delete-log-bytes=${grew} mode=${JSON.stringify(db.prepare("PRAGMA secure_delete").get())}`);
  expect(grew, "W1a-FAST: freeing 512 overflow pages writes no zeroed copy of each (secure_delete=FAST)").toBeLessThan(256 * 1024);
});

it("W1a-SITE: deleteThread zeroes what it frees: after its scrub no byte of the deleted text is in messages.db or its log", { timeout: 60_000 }, async () => {
  const db = await ready();
  const secret = "ZQX-forget-marker-";
  const body = Array.from({ length: 3000 }, (_, i) => `${secret}${i} `).join("");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("T1", "m1", 1000, "user", "text", `start ${body}`, "{}");
  expect(await settleWal({ nudge: true })).toBe(true);
  deleteThread("T1");
  expect(await scrubWalAfterDelete(10_000), "the scrub itself finished").toBe(true);
  const left = [file(), file() + "-wal"].map(path => { try { return readFileSync(path).includes(Buffer.from(`${secret}1500 `)); } catch { return false; } });
  expect(left, "W1a-SITE: deleteThread's freed pages hold none of the deleted text (secure_delete=ON for its transaction)").toEqual([false, false]);
});

it("W1b-LIMIT: a restarted log keeps its file up to 16 MiB, and the kept tail is no copy debt", { timeout: 90_000 }, async () => {
  await keptLog();
  const size = walBytes();
  console.log(`SQLITE-MEASURE W1b-LIMIT kept-wal-bytes=${size} backlog=${walBacklog()?.backlog}`);
  expect(size, "W1b-LIMIT: the restart cut the file to 16 MiB, not to its own frames (journal_size_limit 16 MiB)").toBeGreaterThan(8 * 1024 * 1024);
  expect(size).toBeLessThanOrEqual(16 * 1024 * 1024 + 70_000);
  expect(walBacklog()!.backlog, "W1b-LIMIT: only the restarted log's own frames are copy debt").toBeLessThan(1024 * 1024);
});

it("W1b-SCRUB: in a kept log the deletion scrub still cuts the file to its own frames", { timeout: 90_000 }, async () => {
  await keptLog();
  const secret = "ZQX-scrub-marker-";
  transaction(d => { d.prepare("INSERT INTO canary(body) VALUES(?)").run(Array.from({ length: 2000 }, (_, i) => `${secret}${i} `).join("")); });
  transaction(d => { d.exec("DELETE FROM canary WHERE body LIKE 'ZQX-scrub%'"); });
  expect(await scrubWalAfterDelete(10_000), "W1b-SCRUB: the scrub proves the old frames gone").toBe(true);
  const size = walBytes();
  console.log(`SQLITE-MEASURE W1b-SCRUB wal-bytes-after-scrub=${size}`);
  expect(size, "W1b-SCRUB: the nudge commits at limit 0 and cuts the log to its own frames").toBeLessThan(64 * 1024);
  expect(readFileSync(file() + "-wal").includes(Buffer.from(`${secret}1000 `))).toBe(false);
});

it("W2 cadence: commits 150 ms apart make no checkpoint pass while they come; one pass follows the quiet", { timeout: 60_000 }, async () => {
  await ready();
  await sleep(1500); // the settle's own pass and any tick it asked for are over
  const before = walMaintenanceCounters()!.passDone;
  for (let index = 0; index < 12; index++) { transaction(db => { db.prepare("INSERT INTO canary(body) VALUES(?)").run(`row ${index}`); }); await sleep(150); }
  const during = walMaintenanceCounters()!.passDone - before;
  console.log(`SQLITE-MEASURE W2 passes-during-burst=${during}`);
  expect(during, "W2: no pass while small commits keep coming (the old clock ran one 250 ms after each)").toBe(0);
  await vi.waitFor(() => expect(walMaintenanceCounters()!.passDone - before, "W2: the quiet log is still copied").toBeGreaterThanOrEqual(1), { timeout: 15_000, interval: 100 });
});

it("W2-TRICKLE: a steady trickle of small commits closer than the quiet is still copied within the 30 s bound", { timeout: 90_000 }, async () => {
  await ready();
  await sleep(1500);
  const before = walMaintenanceCounters()!.passDone, started = Date.now();
  let copiedAt = 0;
  for (let index = 0; index < 45 && !copiedAt; index++) {
    transaction(db => { db.prepare("INSERT INTO canary(body) VALUES(?)").run(`trickle ${index}`); });
    await sleep(1000);
    if (walMaintenanceCounters()!.passDone > before) copiedAt = Date.now() - started;
  }
  console.log(`SQLITE-MEASURE W2-TRICKLE first-pass-after-ms=${copiedAt}`);
  expect(copiedAt, "W2-TRICKLE: commits 1 s apart (never 5 s quiet) still get a pass inside about 30 s").toBeGreaterThan(0);
  expect(copiedAt).toBeLessThan(40_000);
});
