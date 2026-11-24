// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, W4 / B2 (MEMORY-V2-DESIGN 4.8, 4.9; owners: witness and WAL maintenance = memv2-D; the commit notice = lane W).
// The checkpointer worker polled data_version and the log header every 25 ms for ever (about 2,400 SQL reads an idle minute, G-IDLE-PROCESS).
// With the wake bus installed on the server connection it now waits on the commit notice: no SQL while nothing commits, a pass within
// DUE_MS of a commit, and a write on another connection is still seen at the idle check (one stat of the log, no SQL).
// Real path: the real server connection (database()), the real worker, the real wake bus; only the idle check is shortened.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "./database.ts";
import { DATA_DIR } from "./config.ts";
import { freshDataDir } from "./memory/testing/recall-fixture.ts";
import * as wal from "./wal-maintenance.ts";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(20); }
  return check();
}
const counters = () => wal.walMaintenanceCounters() as (ReturnType<typeof wal.walMaintenanceCounters> & { polls?: number; eventDriven?: boolean }) | null;
const idleCheck = (wal as unknown as { WAL_IDLE_CHECK?: { ms: number } }).WAL_IDLE_CHECK;
const idleCheck0 = idleCheck?.ms;

afterEach(() => { closeDatabase(); if (idleCheck && idleCheck0 !== undefined) idleCheck.ms = idleCheck0; });

describe("W4 the checkpointer waits on commits, not on a 25 ms clock (lane D)", { timeout: 60_000 }, () => {
  async function opened(idleMs: number) {
    if (idleCheck) idleCheck.ms = idleMs;
    freshDataDir();
    const db = database();
    db.exec("CREATE TABLE IF NOT EXISTS w4_probe(v BLOB)");
    expect(await until(() => counters() !== null, 5_000)).toBe(true);
    await sleep(600); // settle: the open's own writes are copied
    return db;
  }
  it("a 20 s idle check: one poll per observed commit, and a server commit gets a worker-timed pass within 500 ms", async () => {
    const db = await opened(20_000); // neither the idle check nor its size look can stand in for the notice inside this test
    // the notice is lane W's (wake.ts); on a base without it no commit is counted (and the worker polls on its 25 ms clock there)
    const wake = await import("./memory/wake.ts").catch(() => null) as { commitNotice(): SharedArrayBuffer } | null;
    const notice = wake ? new Int32Array(wake.commitNotice()) : null, cell = () => (notice ? Atomics.load(notice, 0) : 0);
    const p0 = counters()!.polls ?? 0, c0 = cell();
    await sleep(2_000);
    const idlePolls = (counters()!.polls ?? 0) - p0, commits = cell() - c0;
    const last = (wal as unknown as { walMaintenanceTestHooks?: { lastResult?: () => unknown } }).walMaintenanceTestHooks?.lastResult?.();
    console.log(`[W4-MEASURE] worker polls in 2 s: ${idlePolls} for ${commits} server commits (25 ms clock: 80); eventDriven=${counters()!.eventDriven} last=${JSON.stringify(last)}`);
    // base f6ae52c670 (+ the poll counter): 80 polls in 2 s whatever commits. Now one poll per observed commit (the app's own background
    // work after open may commit), plus at most 3 for a held-back retry's doubling wait
    expect(idlePolls).toBeLessThanOrEqual(commits + 3);
    expect(idlePolls).toBeLessThan(40);
    // effect: the WORKER's own timed pass (the main thread's 1 s watch only ever requests passes, which do not count here) follows the commit
    const timed0 = counters()!.timedPasses, at = Date.now();
    db.prepare("INSERT INTO w4_probe VALUES (randomblob(20000))").run();
    expect(await until(() => counters()!.timedPasses > timed0, 2_000)).toBe(true);
    const ms = Date.now() - at;
    console.log(`[W4-MEASURE] commit to worker-timed pass ${ms} ms (DUE_MS ${wal.DUE_MS})`);
    expect(ms).toBeLessThanOrEqual(500);
  });
  it("a write on another connection (no commit notice) is seen at the idle check and copied", async () => {
    await opened(400);
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      await sleep(300);
      const done1 = counters()!.passDone;
      other.exec("INSERT INTO w4_probe VALUES (randomblob(20000))");
      expect(await until(() => counters()!.passDone > done1, 3_000)).toBe(true);
    } finally { other.close(); }
  });
});
