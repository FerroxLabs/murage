// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 lane 3 (stall r2 follow-ups) for the claim index while the history upgrade runs:
// - Astra r2: steady appends took the one range of every turn, so a reconcile of an older reopened job never ran (an in-memory probe missed one for
//   1,000 claims). A turn whose range a due reconcile lost to new rows hands the next turn to the reconcile.
// - Fable r2 L2: background steps paused a fixed 20 ms under the upgrade, once more after it had ended. The pause is now what the last read took
//   (none after a quick read), and a step still waiting out a pause runs at once when a turn finds the upgrade over.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { memoryClaimIndex, SCAN_CHUNK } from "./claim-index.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const NOW = 1_000_000;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); jobs.resetMemoryClaimCursor(); database().exec("PRAGMA synchronous=OFF"); memoryClaimIndex.invalidate(); });
afterEach(() => { vi.restoreAllMocks(); memoryClaimIndex.setUpgradeRunning(null); });

function addJob(i: number, status = "pending") {
  const db = database(), scope = `scope-${String(i % 4).padStart(3, "0")}`;
  db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(scope, `owner-${scope}`);
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${i}`, scope, `thread-${i % 50}`, `m${i}`, null, `h${i}`);
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `job ${i}` }), 1);
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1',?,0,0,0,0,0)")
    .run(`job-${String(i).padStart(6, "0")}`, `src-${i}`, status);
}
function seed(count: number) { const db = database(); db.exec("BEGIN"); for (let i = 0; i < count; i++) addJob(i, i === 5 ? "complete" : "pending"); db.exec("COMMIT"); }
async function settled() { for (let n = 0; n < 10_000 && memoryClaimIndex.warming; n++) await new Promise(resolve => setImmediate(resolve)); }
type Internals = { ready: Set<bigint>; buildTimer: { paused: boolean } | null };
const internals = () => memoryClaimIndex as unknown as Internals;

describe("claim index under the history upgrade (1.0.3 lane 3)", () => {
  it("a reopened older job is filed again within two turns while new jobs arrive before every turn (no starvation of the reconcile)", async () => {
    seed(200);
    const db = database();
    expect(memoryClaimIndex.next(db, NOW, "")).not.toBeNull();
    await settled();
    const reopenedRid = BigInt(Number(db.prepare("SELECT rowid AS r FROM memory_jobs WHERE id='job-000005'").get()!.r));
    expect(internals().ready.has(reopenedRid)).toBe(false); // complete: never filed
    // reopened behind the index's back (a park reopen), and the writer says so
    db.prepare("UPDATE memory_jobs SET status='pending' WHERE id='job-000005'").run();
    memoryClaimIndex.reopened();
    memoryClaimIndex.setUpgradeRunning(() => true);
    const before = memoryClaimIndex.stats.reconciled;
    let turns = 0;
    for (let i = 1_000; turns < 50 && !internals().ready.has(reopenedRid); i++) {
      addJob(i); // a steady append before every turn: each turn has new rows to read
      memoryClaimIndex.next(db, NOW, "");
      turns++;
    }
    expect(internals().ready.has(reopenedRid), `filed again after ${turns} turns`).toBe(true);
    expect(turns).toBeLessThanOrEqual(2);
    expect(memoryClaimIndex.stats.reconciled).toBeGreaterThan(before);
    // and the appends were not starved in turn: every appended job is filed once the turns go on
    for (let n = 0; n < 4; n++) memoryClaimIndex.next(db, NOW, "");
    await settled();
    const last = BigInt(Number(db.prepare("SELECT max(rowid) AS r FROM memory_jobs").get()!.r));
    expect(internals().ready.has(last)).toBe(true);
  });

  it("a quick read under the upgrade hands the loop back for one turn only (no fixed pause)", () => {
    seed(3 * SCAN_CHUNK);
    memoryClaimIndex.setUpgradeRunning(() => true);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1));
    memoryClaimIndex.next(database(), NOW, "");
    expect(memoryClaimIndex.warming).toBe(true);
    expect(internals().buildTimer?.paused).toBe(false);
  });

  it("a slow read pauses the next step for what it took (at most the target), and a turn after the upgrade ends runs the step at once", () => {
    seed(4 * SCAN_CHUNK);
    let upgrading = true;
    memoryClaimIndex.setUpgradeRunning(() => upgrading);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 30));
    memoryClaimIndex.next(database(), NOW, "");
    expect(memoryClaimIndex.warming).toBe(true);
    expect(internals().buildTimer?.paused).toBe(true);
    upgrading = false;
    memoryClaimIndex.next(database(), NOW, "");
    // the step that was waiting out the pause is now due on the next turn of the loop
    expect(memoryClaimIndex.warming).toBe(true);
    expect(internals().buildTimer?.paused).toBe(false);
  });
});
