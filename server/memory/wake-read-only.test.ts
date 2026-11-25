// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W (design 3.1, GAP 39): a read-only process. A file of its own, because a process turns read-only for good.
//   1. a process that turns read-only AFTER the open (low disk at a boot step) stops draining and probing: its connection refuses every
//      write, the TEMP wake table included, so the bus must go quiet instead of failing a drain on every later event;
//   2. a read-only START installs nothing at all and sets nothing aside: memory is read as before.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, memoryHoldCode } from "../database.ts";
import { enterReadOnly } from "../read-only-start.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { memoVersion, onWake, probeWakes, resetWakeForTest, wakeInstalled, wakeStats, watchMemo } from "./wake.ts";

const turns = async (count = 6) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
beforeAll(() => { resetWakeForTest(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterAll(() => { closeDatabase(); resetWakeForTest(); });

it("a process that turns read-only after the open: the bus goes quiet (no drain, no probe, no warning), and nothing is set aside", async () => {
  const db = database();
  expect(wakeInstalled(db)).toBe(true);
  const runs: string[] = []; onWake("window", () => { runs.push("window"); });
  db.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-a',1,1)"); // work that exists on disk
  await turns();
  expect(runs).toEqual(["window"]); runs.length = 0;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  enterReadOnly("wake witness");
  expect(wakeInstalled(db)).toBe(false);
  const before = wakeStats();
  expect(() => db.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-b',1,2)")).toThrow(); // refused by the engine
  db.exec("BEGIN"); db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get(); db.exec("COMMIT"); // a read transaction ends
  await turns();
  expect(probeWakes("witness")).toEqual([]);
  const after = wakeStats();
  expect(after.drains).toBe(before.drains); expect(after.probes).toBe(before.probes); expect(after.timerArmed).toBe(false);
  expect(runs).toEqual([]);
  expect(warn.mock.calls.filter(call => String(call[0]).includes("[memory-wake]"))).toEqual([]);
  warn.mockRestore();
  expect(memoryHoldCode()).toBeNull();
});

it("a read-only start installs nothing (no TEMP object, no function, no probe) and memory is not set aside", async () => {
  closeDatabase();
  const before = wakeStats();
  watchMemo("read_only_witness", ["memory_deny_pending"]);
  const db = database();
  expect(wakeInstalled(db)).toBe(false);
  expect(Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema").get()!.n)).toBe(Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE name NOT LIKE 'mem\\_%' ESCAPE '\\' AND name NOT LIKE 'recall\\_job\\_same%' ESCAPE '\\'").get()!.n));
  expect(() => db.prepare("SELECT murage_presenting()").get()).toThrow(/no such function/);
  const after = wakeStats();
  expect(after.installs).toBe(before.installs); expect(after.setupStatements).toBe(before.setupStatements); expect(after.probes).toBe(before.probes);
  // the rows are still read as before, and a memo can never match on a connection without the watch
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()!.n)).toBe(1);
  expect(memoVersion("read_only_witness")).not.toBe(memoVersion("read_only_witness"));
  expect(memoryHoldCode()).toBeNull();
  await turns();
  expect(wakeStats().drains).toBe(after.drains);
});
