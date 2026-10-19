// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 2 (a): while the history upgrade runs, the claim index reads at most one range per turn, and the range follows time (PagedScan's rule).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { CLAIM_SCAN_MIN_ROWS, memoryClaimIndex, SCAN_CHUNK } from "./claim-index.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const NOW = 1_000_000;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); jobs.resetMemoryClaimCursor(); database().exec("PRAGMA synchronous=OFF"); memoryClaimIndex.invalidate(); });
afterEach(() => { vi.restoreAllMocks(); memoryClaimIndex.setUpgradeRunning(null); });

function seed(count: number, scopes: number) {
  const db = database();
  db.exec("BEGIN");
  for (let s = 0; s < scopes; s++) db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(`scope-${String(s).padStart(3, "0")}`, `owner-${s}`);
  for (let i = 0; i < count; i++) {
    const scope = `scope-${String((i * 7) % scopes).padStart(3, "0")}`;
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${i}`, scope, `thread-${i % 50}`, `m${i}`, null, `h${i}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `job ${i}` }), 1);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)")
      .run(`job-${String(i).padStart(6, "0")}`, `src-${i}`);
  }
  db.exec("COMMIT");
}
/** The reads of the table the index makes while `work` runs: rowid ranges of new rows and pages of the open walk. */
function walksDuring<T>(work: () => T): { result: T; walks: number } {
  const index = memoryClaimIndex as unknown as { walk: (...args: unknown[]) => unknown; page: (...args: unknown[]) => unknown };
  const walk = index.walk.bind(memoryClaimIndex), page = index.page.bind(memoryClaimIndex);
  let walks = 0;
  index.walk = (...args: unknown[]) => { walks++; return walk(...args); };
  index.page = (...args: unknown[]) => { walks++; return page(...args); };
  try { return { result: work(), walks }; } finally { delete (index as { walk?: unknown }).walk; delete (index as { page?: unknown }).page; }
}
/** Let the background steps finish (paced by timers while the upgrade runs). */
async function settled() { for (let n = 0; n < 2_000 && memoryClaimIndex.warming; n++) await new Promise(resolve => setTimeout(resolve, 5)); }

describe("claim index under the history upgrade (rc13 round 2)", () => {
  it("reads at most one range per claim while the upgrade runs, and every open job is still filed", async () => {
    seed(3 * SCAN_CHUNK + 100, 20);
    memoryClaimIndex.setUpgradeRunning(() => true);
    const first = walksDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(first.walks).toBeLessThanOrEqual(1);
    for (let n = 0; n < 5; n++) expect(walksDuring(() => jobs.claimMemoryJob("w", NOW)).walks).toBeLessThanOrEqual(1);
    await settled();
    expect(memoryClaimIndex.warming).toBe(false);
    // six claimed, the rest filed: nothing was skipped by the smaller ranges
    expect(memoryClaimIndex.size().ready + memoryClaimIndex.size().waiting).toBeGreaterThanOrEqual(3 * SCAN_CHUNK + 100 - 6);
  });

  it("a job due after the build is claimed within a few turns while a job arrives every turn under the upgrade (Astra build3 H2)", async () => {
    seed(20, 4);
    const db = database();
    db.exec(`UPDATE memory_jobs SET status='deferred', retry_at=${NOW + 5_000} WHERE id='job-000003'`);
    expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull();
    await settled();
    while (jobs.claimMemoryJob("w", NOW)) { /* the backlog the build filed, so a turn chooses between the arrival and the due job */ }
    memoryClaimIndex.setUpgradeRunning(() => true);
    const claimed: string[] = [];
    // one new pending job before every claim: its rowid range would take the turn's one read every time
    for (let n = 0; n < 12 && !claimed.includes("job-000003"); n++) {
      const i = 1_000 + n;
      db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${i}`, "scope-000", "thread-x", `m${i}`, null, `h${i}`);
      db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `job ${i}` }), 1);
      db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)").run(`job-${String(i).padStart(6, "0")}`, `src-${i}`);
      const { result, walks } = walksDuring(() => jobs.claimMemoryJob("w", NOW + 5_000 + n));
      expect(walks).toBeLessThanOrEqual(1);
      if (result) claimed.push(result.id);
    }
    // the frontier had its turn at the read: the job due at NOW + 5,000 was filed and claimed, with arrivals every turn
    expect(claimed).toContain("job-000003");
    expect(claimed.indexOf("job-000003")).toBeLessThanOrEqual(3);
  });

  it("without the upgrade a claim reads as before (more than one range when a large append waits)", async () => {
    seed(10, 4);
    expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull();
    await settled();
    const db = database();
    db.exec("BEGIN");
    for (let i = 10; i < 10 + 3 * SCAN_CHUNK; i++) {
      db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${i}`, "scope-000", "thread-x", `m${i}`, null, `h${i}`);
      db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, "{}", 1);
      db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)").run(`job-${String(i).padStart(6, "0")}`, `src-${i}`);
    }
    db.exec("COMMIT");
    expect(walksDuring(() => jobs.claimMemoryJob("w", NOW)).walks).toBeGreaterThan(1);
  });

  it("halves the range when a read takes longer than the target and grows it back when reads are quick", async () => {
    seed(3 * SCAN_CHUNK, 8);
    memoryClaimIndex.setUpgradeRunning(() => true);
    let clock = 0, step = 30;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += step));
    jobs.claimMemoryJob("w", NOW);
    for (let n = 0; n < 4; n++) jobs.claimMemoryJob("w", NOW);
    const slow = memoryClaimIndex.upgradeScanRows;
    expect(slow).toBeLessThan(SCAN_CHUNK);
    expect(slow).toBeGreaterThanOrEqual(CLAIM_SCAN_MIN_ROWS);
    step = 1; // each read now looks like ~1 ms
    for (let n = 0; n < 4; n++) jobs.claimMemoryJob("w", NOW);
    expect(memoryClaimIndex.upgradeScanRows).toBeGreaterThan(slow);
  });
});
