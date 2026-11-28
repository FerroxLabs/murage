// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: revoke-budget (the paced drain) + revoke-marker (the walker) + deny-read (the pending windows). 1.0.21 mem-f3.
// The field (a copy of the owner's file, before 1.0.21): 2,376 active revoke jobs (2,247 inherit/mark, 124 bulk, 4 thread/mark, 1 line/mark),
// no queued receipt flip, 127 recall views, and "checking:pending" open for hours. Three ways the queue stops draining (a, b, c), and the
// standing backlog itself. Each test prints one MEMF3 line with what it measured.
// What this does NOT model: the Mac's storage and its real diskWritten counter (injected here), fan-out per job (each job here holds one
// line), and the 127 recall views (the revoke drain never reads them; they are seeded so the file has them).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refsLookup } from "./deny-read.ts";
import { PENDING_ALL_SCOPES, PENDING_ALL_THREADS, type MemoryRef } from "./lineage-types.ts";
import { drainRevokeMarkerBounded, INLINE_REVOCATION, memoryRevocationIdle, noteFenceWaiter, memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { assertSendFence } from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, revokeBacklogBurst, revokeBytesWritten, revokeChangeCeiling, revokePacedBytes, revokePaceNeed, revokePaceTestHooks, revokePaceWaitMs, revokeSliceNeed, revokeWriteMeter, revokeWriteWaitMs, setRevokeBudgetClock, REVOKE_PACE, REVOKE_PACE_COMMIT, REVOKE_WRITE_BUDGET } from "./revoke-budget.ts";
import { activateBulkRevoke, commitRevoke, openBulkRevoke } from "./revoke-commit.ts";
import * as marker from "./revoke-marker.ts";
import { buildWindowSummariesNow } from "./window-summary.ts";
import { storm, THREADS } from "./testing/revoke-storm-fixture.ts";
import { CONTENT, MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const OWNER = "zz-owner", MB = 1024 * 1024;
const inline = { ...INLINE_REVOCATION }, budget0 = REVOKE_WRITE_BUDGET.bytesPerMinute;
let f: WritetimeFixture, now = 0, head = 0;
beforeEach(() => {
  now = 1_000_000;
  setRevokeBudgetClock(() => now);
  resetRevokeWriteBudget(); resetMemoryRevocationStats();
  f = new WritetimeFixture().cert(true);
});
afterEach(() => {
  vi.useRealTimers(); stopMemoryRevocation(); f.close();
  setRevokeBudgetClock(); resetRevokeWriteBudget(); resetMemoryRevocationStats();
  Object.assign(revokePaceTestHooks, { osUnknown: false, platform: null, osBlocks: null });
  Object.assign(INLINE_REVOCATION, inline); REVOKE_WRITE_BUDGET.bytesPerMinute = budget0;
});

const count = (db: WritetimeFixture["db"], sql: string, ...args: Array<string | number>) => Number(Object.values(db.prepare(sql).get(...args) ?? { n: NaN })[0]);
const activeJobs = () => count(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')");
const lineVerdict = (thread: string, id = "reply") => refsLookup(f.db, [{ kind: "line", threadId: thread, messageId: id }], CONTENT).state;
const refused = (): string | null => {
  const built = buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [{ kind: "prefix", threadId: OWNER, headLsn: head }])]);
  try { assertSendFence(built, CONTENT, f.db); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
};
/** A line revoke already in mark with its line on the frontier and its own thread's window (revoke-queue-converges-1020 seedMacQueue). */
function lineJob(id: number, kind: "line" | "thread" = "line"): void {
  f.reply(`line-${id}`, "reply", id * 10).job(id, id * 10 + 1).pending(`line-${id}`, 1, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark',kind=? WHERE revoke_id=?").run(kind, id);
  marker.enqueueNode(f.db, id, { kind: "line", threadId: `line-${id}`, lsn: id * 10 });
}
/** One runner tick's transaction (memory-revocation.ts tick), admitted exactly as the tick admits it. */
function runnerCommit(): boolean {
  if (Math.max(revokePaceWaitMs(revokePaceNeed(f.db)), revokeWriteWaitMs(revokeSliceNeed(f.db))) > 0) return false;
  f.db.exec("BEGIN IMMEDIATE");
  const measure = beginRevokeMeasure(f.db);
  try {
    const moved = budgetedMarkerSlice(f.db, 4096, 30_000, null);
    f.db.exec("COMMIT"); endRevokeMeasure(f.db, measure, moved === true);
    return moved === true;
  } catch (error) { if (f.db.isTransaction) f.db.exec("ROLLBACK"); endRevokeMeasure(f.db, measure, false, false); throw error; }
}

// ---- a: the macOS byte charge. On macOS the OS counter is the WHOLE PROCESS's bytes (revoke-budget.ts txOsBlocks), so a drain transaction
// is charged what the reclaim, checkpoint and search threads wrote while it was open. The counter is injected: every read finds OTHER_BYTES
// more than the last, as a busy process leaves it.
const OTHER_BYTES = 8 * MB;
function asMacWithBusyThreads(): void {
  let blocks = 0;
  Object.assign(revokePaceTestHooks, { platform: "darwin", osBlocks: () => (blocks += OTHER_BYTES / 512) });
}

it("a1: a drain transaction that changed no row charges nothing, though the process wrote 8 MB meanwhile (macOS counter)", () => {
  asMacWithBusyThreads();
  expect(marker.markerWorkPending(f.db)).toBe(false);
  drainRevokeMarkerBounded(f.db); // a turn's start with nothing to walk: BEGIN, no row, COMMIT
  const pace = revokePacedBytes(), ledger = revokeBytesWritten();
  console.log(`MEMF3 a1 zero-row drain: pace=${pace} ledger=${ledger} osBeyond=${revokeWriteMeter.osBeyond} (pace limit ${REVOKE_PACE.bytesPerMinute})`);
  expect(pace).toBe(0);
  expect(ledger).toBe(0);
  expect(revokePaceWaitMs(revokePaceNeed(f.db))).toBe(0);
});

it("a2: a commit that changed rows is charged at most rows x W for the OS term on macOS, never the whole process's bytes", () => {
  asMacWithBusyThreads();
  f.db.exec("BEGIN"); for (let id = 1; id <= 8; id++) lineJob(id); f.db.exec("COMMIT");
  const before = marker.totalChanges(f.db);
  expect(runnerCommit()).toBe(true);
  const rows = marker.totalChanges(f.db) - before, pace = revokePacedBytes();
  console.log(`MEMF3 a2 commit rows=${rows} pace=${pace} bound=${2 * rows * revokeChangeCeiling(f.db)}`);
  expect(rows).toBeGreaterThan(0);
  // write half and copy half, each at most its rows at the ceiling (plus the frames the commit really wrote, which the copy half holds)
  expect(pace).toBeLessThan(OTHER_BYTES);
  expect(revokeWriteMeter.osBeyond).toBeLessThanOrEqual(rows * revokeChangeCeiling(f.db));
});

it("a3: 300 queued jobs drain on a busy Mac while a turn starts every 10 s (each start a drain transaction of its own)", () => {
  const JOBS = 300, MINUTES = 40;
  asMacWithBusyThreads();
  f.db.exec("BEGIN"); for (let id = 1; id <= JOBS; id++) lineJob(id); f.db.exec("COMMIT");
  let commits = 0, turnDrains = 0;
  for (let second = 0; second < MINUTES * 60 && marker.markerWorkPending(f.db); second++, now += 1000) {
    if (runnerCommit()) commits++;
    if (second % 10 === 5) { drainRevokeMarkerBounded(f.db); turnDrains++; }
  }
  console.log(`MEMF3 a3 jobs=${JOBS} minutes=${MINUTES} left=${activeJobs()} runnerCommits=${commits} turnDrains=${turnDrains} paceDated=${revokeWriteMeter.paceDated}`);
  expect(activeJobs()).toBe(0);
  expect(count(f.db, "SELECT count(*) AS n FROM memory_deny_pending")).toBe(0);
  // privacy: every revoked line took its permanent mark
  expect(count(f.db, "SELECT count(DISTINCT revoke_id) AS n FROM memory_deny_point")).toBe(JOBS);
  for (const id of [1, 150, JOBS]) expect(lineVerdict(`line-${id}`)).toBe("withheld");
}, 300_000);

// ---- b: more than 256 `*` rows. The read dropped every cap (since 0, cap Infinity), so lines of turns begun AFTER every revoke read checking too.
function seedStarWindows(n: number, firstCap = 5001): void {
  f.db.exec("BEGIN");
  for (let j = 1; j <= n; j++) f.job(j, firstCap + j - 1).pending(PENDING_ALL_THREADS, 4000, j);
  f.reply("th-early", "reply", 100, { turnLsn: 99 });     // written before every window's since
  f.reply("th-old", "reply", 4500, { turnLsn: 4400 });    // inside: its turn began before every cap
  f.reply("th-mid", "reply", firstCap + n - 1, { turnLsn: firstCap + n - 2 }); // its turn began before the NEWEST cap only
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });    // a turn begun after every revoke committed
  f.db.exec("COMMIT");
}
// Memory V2 V5 (MEMORY-V2-DESIGN 4.3) replaces the mem-f3 read-time aggregate these b tests were written for: "More than 256 rows: today
// the reader holds everything. V2 keeps that answer unless a summary exists for the key [...] The first overflow read of a key answers
// 'hold everything' and queues a paged build of the summary as closing work [...] No reader ever runs an aggregate over the queue."
// So each b test now reads once (held, the answer before mem-f3), runs the queued build as the wake would, and then asserts what it
// asserted before. Nothing is weakened: every "checking" these tests expected is still expected, and the first read is stricter.
/** The first overflow read holds everything; the build it queued then runs (closing work, here run at once). */
function overflowReadThenBuild(thread = "th-new"): void {
  expect(lineVerdict(thread)).toBe("checking");
  expect(buildWindowSummariesNow(f.db)).toBeGreaterThan(0);
}
it("b1: 300 `*` windows keep their caps: a turn begun after every revoke reads its line, a line inside any window still reads checking", () => {
  seedStarWindows(300);
  expect(lineVerdict("th-early")).toBe("checking"); // V5: no summary yet, everything held
  overflowReadThenBuild();
  const got = { early: lineVerdict("th-early"), old: lineVerdict("th-old"), mid: lineVerdict("th-mid"), fresh: lineVerdict("th-new") };
  console.log(`MEMF3 b1 windows=300 ${JSON.stringify(got)}`);
  expect(got.old).toBe("checking");
  expect(got.mid).toBe("checking");
  expect(got.fresh).toBe("shown");
  expect(got.early).toBe("shown");
});
it("b2: fail closed on overflow: one window still seeding, or one with no job, holds every line from the lowest since", () => {
  seedStarWindows(300);
  f.db.prepare("UPDATE memory_revoke_jobs SET state='seeding' WHERE revoke_id=7").run();
  overflowReadThenBuild();
  expect(lineVerdict("th-new")).toBe("checking");
  f.db.prepare("UPDATE memory_revoke_jobs SET state='active' WHERE revoke_id=7").run();
  // V5: "Any DELETE on memory_revoke_jobs or UPDATE of its state or started_lsn puts every summary back to 'hold everything' until rebuilt"
  overflowReadThenBuild();
  expect(lineVerdict("th-new")).toBe("shown");
  f.db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=9").run();
  expect(lineVerdict("th-new")).toBe("checking");
  expect(lineVerdict("th-early")).toBe("checking"); // V5: held with everything else until the rebuild
  overflowReadThenBuild();
  expect(lineVerdict("th-new")).toBe("checking");
  expect(lineVerdict("th-early")).toBe("shown"); // before the lowest since: no window reaches it
});
// V5 has no 4,096-row cliff (the aggregate and its bound are gone): past 256 rows every line is held until the key's summary is built,
// "as before", and once it is built the caps hold at any queue length. The old assertions stand for the read before the build.
it("b3: 4,200 rows: every line is held, as before, until the summary is built; then the caps hold (no 4,096 cliff)", () => {
  seedStarWindows(4200);
  // with 4,200 windows the newest cap is 9200, past th-new's turn (8990): th-new is inside. A turn begun after every cap:
  f.reply("th-after", "reply", 9990, { turnLsn: 9980 });
  expect(lineVerdict("th-after")).toBe("checking");
  expect(lineVerdict("th-new")).toBe("checking");
  expect(lineVerdict("th-early")).toBe("checking");
  expect(buildWindowSummariesNow(f.db)).toBeGreaterThan(0);
  expect(lineVerdict("th-old")).toBe("checking");
  expect(lineVerdict("th-new")).toBe("checking"); // its turn began before the newest caps: still inside, summary or not
  expect(lineVerdict("th-after")).toBe("shown");
  expect(lineVerdict("th-early")).toBe("shown");
});
it("b4: the same rule for memory under more than 256 `*` scope windows: a record made before every window reads, one made inside reads checking", () => {
  f.db.exec("BEGIN");
  for (let j = 1; j <= 300; j++) f.job(j, 5000 + j).pendingScope(PENDING_ALL_SCOPES, 4000, j);
  f.db.prepare("UPDATE memory_lsn SET next=100 WHERE id=1").run();
  f.record("rec-early", 1, "s-room");
  f.db.prepare("UPDATE memory_lsn SET next=4500 WHERE id=1").run();
  f.record("rec-inside", 1, "s-room");
  f.db.prepare("UPDATE memory_lsn SET next=9000 WHERE id=1").run();
  f.db.exec("COMMIT");
  const verdict = (id: string) => refsLookup(f.db, [{ kind: "memory", ref: { kind: "record", id, version: 1, scopeId: "s-room" } }], CONTENT).state;
  expect(verdict("rec-early")).toBe("checking"); // V5: the first overflow read holds everything
  expect(buildWindowSummariesNow(f.db)).toBeGreaterThan(0);
  const got = { early: verdict("rec-early"), inside: verdict("rec-inside") };
  console.log(`MEMF3 b4 scopeWindows=300 ${JSON.stringify(got)}`);
  expect(got.inside).toBe("checking");
  expect(got.early).toBe("shown");
});

/** Lines at every position the windows below can split: before every since, inside, between caps, after every cap. */
const PROBES: Array<[string, number, number]> = [["p-100", 100, 99], ["p-4100", 4100, 4050], ["p-4500", 4500, 4400], ["p-5100", 5100, 5050], ["p-5200", 5200, 5190], ["p-5252", 5252, 5250], ["p-5300", 5300, 5290], ["p-6100", 6100, 6050], ["p-6100-old", 6101, 4400], ["p-9000", 9000, 8990]];
function seedMixedWindows(n: number, since: (j: number) => number): void {
  f.db.exec("BEGIN");
  for (let j = 1; j <= n; j++) {
    f.job(j, 5000 + j);
    // binds audience readers only: every 7th, and the 16 newest (so the highest cap a content reader counts is lower than a member's)
    if (j % 7 === 0 || j > n - 16) f.db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(j);
    f.pending(PENDING_ALL_THREADS, j % 11 === 0 ? 6000 + j : since(j), j);                                       // every 11th: a hold after its commit (no cap)
  }
  for (const [thread, lsn, turn] of PROBES) f.reply(thread, "reply", lsn, { turnLsn: turn });
  f.db.exec("COMMIT");
}
const probe = (reader: Parameters<typeof refsLookup>[2]) => PROBES.map(([thread]) => refsLookup(f.db, [{ kind: "line", threadId: thread, messageId: "reply" }], reader).state);
/** One more `*` row with the very window row 1 has (same since, same cap; row 1 binds every reader): it adds nothing to what is held and
 * only pushes the key past the row limit, so the aggregate is read. */
function overflowByOneNeutralRow(since: number): void { f.job(100_000, 5001).pending(PENDING_ALL_THREADS, since, 100_000); }
for (const [name, reader] of [["content", CONTENT], ["member", MEMBER]] as const) {
  it(`b5 (${name} reader): 256 mixed rows (audience-only, uncapped holds, capped) read the same row by row and aggregated`, () => {
    seedMixedWindows(256, () => 4000);
    const rowByRow = probe(reader);
    overflowByOneNeutralRow(4000);
    expect(new Set(probe(reader))).toEqual(new Set(["checking"])); // V5: the first overflow read holds everything
    expect(buildWindowSummariesNow(f.db)).toBeGreaterThan(0);
    const aggregated = probe(reader);
    console.log(`MEMF3 b5 ${name} rowByRow=${rowByRow.join(",")} aggregated=${aggregated.join(",")}`);
    expect(new Set(rowByRow).size).toBeGreaterThan(1); // the fixture splits: some lines read, some do not
    // Was `toEqual(rowByRow)` for the two-window SQL aggregate. The V5 summary is ONE window for every reader kind ("count, lowest since,
    // highest finite cap, count of uncapped rows"; "The summary is always at least as strict as the exact rows"), so it may hold a line
    // the 256 rows release (here: the uncapped holds start at 6011, and a content reader no longer skips audience-only rows). It may
    // never read one they hold, and it still reads the line no window reaches.
    for (let i = 0; i < PROBES.length; i++) if (rowByRow[i] !== "shown") expect(aggregated[i], PROBES[i]![0]).toBe(rowByRow[i]);
    expect(aggregated[0]).toBe("shown");
  });
  it(`b6 (${name} reader): with a different since on every row the aggregate never reads a line the row-by-row read withholds`, () => {
    seedMixedWindows(256, j => 4000 + j * 3);
    const rowByRow = probe(reader);
    overflowByOneNeutralRow(4003);
    expect(new Set(probe(reader))).toEqual(new Set(["checking"])); // V5: the first overflow read holds everything
    expect(buildWindowSummariesNow(f.db)).toBeGreaterThan(0);
    const aggregated = probe(reader);
    for (let i = 0; i < PROBES.length; i++) if (rowByRow[i] !== "shown") expect(aggregated[i], PROBES[i]![0]).toBe(rowByRow[i]);
    expect(rowByRow).toContain("checking");
  });
}

// ---- c: one queued receipt flip. No revoke advanced, inline or not, and every import chunk counted as shown.
const flips = (fx: WritetimeFixture) => count(fx.db, "SELECT count(*) AS n FROM memory_receipt_flips");
const jobState = (fx: WritetimeFixture, R: number) => String((fx.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R) as { state?: string } | undefined)?.state ?? "done");
const slice = <T>(fx: WritetimeFixture, run: () => T): T => { fx.db.exec("BEGIN IMMEDIATE"); try { return run(); } finally { fx.db.exec("COMMIT"); } };
function cite(fx: WritetimeFixture, bundle: string, ids: string[]): void {
  fx.db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=?").run(JSON.stringify(ids.map(id => ({ id, version: 1 }))), bundle);
}
it("c1: an owner's inline walk commits the queued head flips first, inside its own cap, then closes its own window", () => {
  f.close(); f = storm(2);
  INLINE_REVOCATION.ms = 5_000; // the deadline is not under test (a loaded box)
  const X: MemoryRef = { kind: "record", id: "rec-x", version: 1 };
  f.record(X.id, 1, "s-room");
  const older = slice(f, () => commitRevoke(f.db, { kind: "memory", ref: X, cause: "forget" }, { inline: false }));
  const cursor = () => String((f.db.prepare("SELECT phase||':'||cursor AS c FROM memory_revoke_jobs WHERE revoke_id=?").get(older) as { c: string }).c);
  const held = cursor();
  f.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b0'").run();
  expect(flips(f)).toBe(1);
  const before = marker.totalChanges(f.db);
  const mine = slice(f, () => commitRevoke(f.db, { kind: "line", threadId: THREADS[1]!, messageIds: ["r1"], cause: "forget" }));
  const rows = marker.totalChanges(f.db) - before;
  console.log(`MEMF3 c1 flipsLeft=${flips(f)} mine=${jobState(f, mine)} older=${jobState(f, older)} rows=${rows} minePending=${count(f.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", mine)}`);
  expect(flips(f)).toBe(0);                       // the flip is committed as a receipt root (its bulk now holds its window)
  expect(jobState(f, mine)).toBe("done");         // and the owner's own revoke walked to its end
  expect(count(f.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", mine)).toBe(0);
  expect(lineVerdict(THREADS[1]!, "r1")).toBe("withheld");
  // never another revoke: the older forget and the flip's new bulk are the runner's
  expect(jobState(f, older)).toBe("active");
  expect(cursor()).toBe(held);
  expect(count(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='bulk' AND state='active'")).toBe(1);
  // the charge: every row the walk changed, the flip's commit included, is in the ledger
  expect(revokeBytesWritten()).toBeGreaterThanOrEqual(rows * revokeChangeCeiling(f.db) / 8);
});
it("c2: fail closed: a head flip the walk's cap has no room for stays queued and the owner's revoke does not advance past it", () => {
  f.close(); f = storm(1);
  cite(f, "b0", Array.from({ length: 400 }, (_, i) => `cited-${i}`)); // its commit: about 800 rows, under the flip cutoff (not cut to the wildcard)
  f.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b0'").run();
  f.owner("th-c2", "u", 500).reply("th-c2", "r", 501, { turnLsn: 500 });
  const mine = slice(f, () => commitRevoke(f.db, { kind: "line", threadId: "th-c2", messageIds: ["r"], cause: "forget" }, { inline: false }));
  const cursor = () => String((f.db.prepare("SELECT phase||':'||cursor AS c FROM memory_revoke_jobs WHERE revoke_id=?").get(mine) as { c: string }).c);
  const held = cursor();
  // a cap of 4 rows (plus the step reserve of 512): no room for the flip's commit, so nothing moves, the owner's revoke included
  for (let n = 0; n < 5; n++) expect(slice(f, () => marker.markerSlice(f.db, 256, Number.POSITIVE_INFINITY, null, 4, { only: mine, headFlips: true }))).toBe(false);
  expect(flips(f)).toBe(1);
  expect(jobState(f, mine)).toBe("active");
  expect(cursor()).toBe(held);
  expect(lineVerdict("th-c2", "r")).not.toBe("shown");
  // without the option (the targeted settle's walk, admitMarkerSlice) a queued flip still blocks an `only` walk outright
  expect(slice(f, () => marker.markerSliceDetailed(f.db, 256, Number.POSITIVE_INFINITY, null, 4096, { only: mine }))).toEqual({ outcome: "blocked", cause: "flip-queued" });
  expect(flips(f)).toBe(1);
  // with room: the flip first, the owner's revoke only in a later slice
  expect(slice(f, () => marker.markerSlice(f.db, 256, Number.POSITIVE_INFINITY, null, 4096, { only: mine, headFlips: true }))).toBe(true);
  expect(flips(f)).toBe(0);
  expect(cursor()).toBe(held);
});
it("c3: with a flip queued, a re-import withdraws only the chunks the queued receipt cites; an unshown chunk opens no window", () => {
  f.close(); f = storm(1);
  f.db.prepare("INSERT OR REPLACE INTO memory_revocation_index_build(id,ready) VALUES(1,1)").run();
  f.record("nb:chunk:1", 1, "s-room").record("nb:chunk:2", 1, "s-room");
  cite(f, "b0", ["nb:chunk:1"]);
  f.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b0'").run();
  expect(flips(f)).toBe(1);
  const memoryJobs = () => count(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='memory'");
  INLINE_REVOCATION.ms = 0; // count the commits, not the walks
  vi.spyOn(console, "warn").mockImplementation(() => {});
  slice(f, () => revokeRecordDisclosures(f.db, "import", { recordIds: ["nb:chunk:2"], versions: { "nb:chunk:2": 1 }, receiptsByRecordOnly: true }));
  const unshown = memoryJobs();
  slice(f, () => revokeRecordDisclosures(f.db, "import", { recordIds: ["nb:chunk:1"], versions: { "nb:chunk:1": 1 }, receiptsByRecordOnly: true }));
  const shown = memoryJobs() - unshown;
  vi.restoreAllMocks();
  console.log(`MEMF3 c3 revokes committed: unshown chunk=${unshown} cited chunk=${shown}`);
  expect(unshown).toBe(0);
  expect(shown).toBe(1); // the chunk the queued receipt was shown is still withdrawn
});
it("c4: fail closed: a queued flip whose receipt cannot be read (no row, or lists that do not parse) still counts every chunk as shown", () => {
  f.close(); f = storm(1);
  f.db.prepare("INSERT OR REPLACE INTO memory_revocation_index_build(id,ready) VALUES(1,1)").run();
  f.record("nb:chunk:2", 1, "s-room");
  f.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b0'").run();
  f.db.prepare("UPDATE memory_disclosures SET record_versions='{}' WHERE bundle_id='b0'").run();
  expect(flips(f)).toBe(1);
  INLINE_REVOCATION.ms = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  slice(f, () => revokeRecordDisclosures(f.db, "import", { recordIds: ["nb:chunk:2"], versions: { "nb:chunk:2": 1 }, receiptsByRecordOnly: true }));
  vi.restoreAllMocks();
  expect(count(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='memory'")).toBe(1);
});

// ---- the standing backlog: the owner's file at upgrade, through the REAL runner (memory-revocation.ts tick) on a fake clock.
const SHAPE = { inherit: 2247, bulkMark: 112, bulkFlow: 12, thread: 4, line: 1 }, VIEWS = 127;
const BACKLOG = SHAPE.inherit + SHAPE.bulkMark + SHAPE.bulkFlow + SHAPE.thread + SHAPE.line;
function seedBacklog(): void {
  f.db.exec("PRAGMA journal_mode=WAL"); // as the app's file: a drain commit is measured by its log frames
  f.db.exec("BEGIN");
  let id = 0;
  // an inherit job as revoke-commit.ts inheritMarks leaves it: the child line's deny row, its frontier node, its hold on its own thread
  for (let i = 0; i < SHAPE.inherit; i++) {
    id++;
    const thread = `line-${id}`, lsn = id * 10;
    f.reply(thread, "reply", lsn).denyLine(thread, lsn, id).pending(thread, lsn, id);
    f.db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(id, JSON.stringify({ kind: "inherit", cause: "inherit" }), lsn, lsn + 1);
    marker.enqueueNode(f.db, id, { kind: "line", threadId: thread, lsn });
  }
  for (let i = 0; i < SHAPE.thread; i++) lineJob(++id, "thread");
  for (let i = 0; i < SHAPE.line; i++) lineJob(++id);
  f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run((id + 1) * 10);
  // the bulks through the real bulk API: each one line root, with its `*` thread and scope windows (revoke-commit.ts)
  for (let i = 0; i < SHAPE.bulkMark + SHAPE.bulkFlow; i++) {
    const thread = `bulk-${i}`, lsn = count(f.db, "SELECT next FROM memory_lsn WHERE id=1");
    f.owner(thread, "u", lsn).reply(thread, "reply", lsn + 1, { turnLsn: lsn });
    const bulk = openBulkRevoke(f.db, "seed", false);
    commitRevoke(f.db, { kind: "line", threadId: thread, messageIds: ["reply"], cause: "forget" }, { inline: false, into: bulk });
    activateBulkRevoke(f.db, bulk);
    // the first 112 are past their flow phase, as the owner's were (the marker's own flow steps); the last 12 stay in flow
    if (i < SHAPE.bulkMark) for (let n = 0; n < 1000 && String(f.db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(bulk)!.phase) === "flow"; n++) marker.markerSlice(f.db, 1, Number.POSITIVE_INFINITY, null, 1, { only: bulk });
  }
  head = count(f.db, "SELECT next FROM memory_lsn WHERE id=1") + 10;
  f.reply(OWNER, "delegated", head, { turnLsn: 10 });
  if (f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_views'").get()) {
    const cols = (f.db.prepare("PRAGMA table_info(memory_recall_views)").all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>);
    const need = cols.filter(col => col.notnull && col.dflt_value === null);
    try { for (let v = 0; v < VIEWS; v++) f.db.prepare(`INSERT INTO memory_recall_views(${need.map(col => col.name).join(",")}) VALUES(${need.map(() => "?").join(",")})`).run(...need.map(col => /INT/i.test(col.type) ? v + 1 : `view-${v}`)); } catch { /* a view row this file's checks refuse: the drain does not read them */ }
  }
  f.db.exec("COMMIT");
}
/** `minutes` of the wall clock with the real runner awake; every 30 s every seeded line is judged (never shown). */
async function runRunner(minutes: number, busy: () => boolean, eachSecond?: (second: number) => void): Promise<{ at: number[]; neverShown: boolean }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  setRevokeBudgetClock(); // the wall clock, which is the fake one now
  vi.spyOn(console, "warn").mockImplementation(() => {});
  wakeMemoryRevocation(() => f.db, { busy });
  const at: number[] = [];
  let neverShown = true;
  const ids = [...Array.from({ length: 40 }, (_, i) => 1 + i * 56), SHAPE.inherit];
  for (let second = 0; second < minutes * 60; second++) {
    await vi.advanceTimersByTimeAsync(1000);
    eachSecond?.(second);
    if (second % 60 === 59) at.push(activeJobs());
    if (second % 30 === 29) for (const id of ids) if (lineVerdict(`line-${id}`) === "shown") neverShown = false;
  }
  stopMemoryRevocation(); await memoryRevocationIdle();
  vi.restoreAllMocks(); vi.useRealTimers();
  return { at, neverShown };
}

it(`backlog: the owner's file at upgrade (${BACKLOG} active jobs, ${SHAPE.inherit} inherit/mark) drains to near zero within 10 idle minutes and its windows close`, async () => {
  seedBacklog();
  expect(activeJobs()).toBe(BACKLOG);
  expect(f.db.prepare("SELECT kind||'/'||phase AS k,count(*) AS n FROM memory_revoke_jobs WHERE state='active' GROUP BY 1 ORDER BY 2 DESC").all().map(row => `${row.k}=${row.n}`).join(" ")).toBe("inherit/mark=2247 bulk/mark=112 bulk/flow=12 thread/mark=4 line/mark=1");
  expect(refused()).toMatch(/MEMORY_/);
  const pendingBefore = count(f.db, "SELECT count(*) AS n FROM memory_deny_pending") + count(f.db, "SELECT count(*) AS n FROM memory_deny_pending_scope");
  const rows0 = marker.totalChanges(f.db);
  const { at, neverShown } = await runRunner(10, () => false);
  const left = activeJobs(), rows = marker.totalChanges(f.db) - rows0;
  const pendingLeft = count(f.db, "SELECT count(*) AS n FROM memory_deny_pending") + count(f.db, "SELECT count(*) AS n FROM memory_deny_pending_scope");
  console.log(`MEMF3 backlog jobs=${BACKLOG} idleMinutes=10 left=${left} byMinute=${at.join(",")} commits=${memoryRevocationStats.slices} rows=${rows} pacedBytes=${revokeWriteMeter.paceDated} largestCommitBytes=${revokeWriteMeter.maxSliceBytes} pending=${pendingBefore}->${pendingLeft} budgetWaits=${memoryRevocationStats.budgetWaits} paceWaits=${revokeWriteMeter.paceWaits} charged=${revokeWriteMeter.charged} measured=${revokeWriteMeter.paceMeasured} unmeasured=${revokeWriteMeter.paceUnmeasured} errors=${memoryRevocationStats.errorRetries} locked=${memoryRevocationStats.lockedRetries} workMs=${Math.round(memoryRevocationStats.workMs)} pauseMs=${Math.round(memoryRevocationStats.pauseMs)}`);
  expect(neverShown).toBe(true);
  expect(left).toBeLessThanOrEqual(16);
  expect(pendingLeft).toBeLessThanOrEqual(left * 2);
  // no commit grew: the cap of one drain commit is what it was (rows, so bytes at the ceiling)
  expect(revokeWriteMeter.maxSliceBytes).toBeLessThanOrEqual((REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE) * revokeChangeCeiling(f.db));
  // every minute stayed inside the marker's write budget (the 1.0.3 storm bound), one commit's excess at most
  expect(revokeWriteMeter.paceDated).toBeLessThanOrEqual(10 * (REVOKE_WRITE_BUDGET.bytesPerMinute + 2 * (REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE) * revokeChangeCeiling(f.db)));
  // privacy at the end: every inherit child keeps its mark
  for (const id of [1, 1000, SHAPE.inherit]) expect(lineVerdict(`line-${id}`)).toBe("withheld");
  if (left === 0) expect(refused()).toBeNull();
}, 600_000);

// MEMORY V2 V8 (design 4.3) replaces the mem-f3 "burst only on an idle machine" rule that the next three tests asserted (no burst under a live
// turn; the burst ends when a turn goes live; a waiting turn keeps the idle pace). Closing work, the walk of a job that still holds a
// pending row, is no longer paced per minute: it has the write budget whether or not a turn is live (half slices under one), and V14 gives
// the runner the full ledger while a turn waits. The three tests keep their scenarios and now assert the new rule, with the same byte bound
// a burst minute always had. The idle pace is still asserted for work no reader waits on (memv2-c-pace-1021.test.ts and revoke-budget tests).
it("backlog, a turn live throughout: closing work keeps the write budget in half slices and the queue still drains (V8)", async () => {
  seedBacklog();
  let closing = 0;
  const { at } = await runRunner(3, () => true, () => { if (revokeBacklogBurst()) closing++; });
  console.log(`MEMF3 backlog-live jobs=${BACKLOG} liveMinutes=3 left=${activeJobs()} byMinute=${at.join(",")} pacedBytes=${revokeWriteMeter.paceDated} closingSeconds=${closing} largestCommitBytes=${revokeWriteMeter.maxSliceBytes} yields=${memoryRevocationStats.markerYields}`);
  expect(closing).toBeGreaterThan(0);
  expect(memoryRevocationStats.markerYields).toBeGreaterThan(0); // the half slices under a live turn
  // every minute inside the marker's write budget, one commit's excess at most
  expect(revokeWriteMeter.paceDated).toBeLessThanOrEqual(3 * (REVOKE_WRITE_BUDGET.bytesPerMinute + 2 * (REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE) * revokeChangeCeiling(f.db)));
  expect(revokeWriteMeter.maxSliceBytes).toBeLessThanOrEqual((REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE) * revokeChangeCeiling(f.db));
  // it drains every minute under the live turn. How far in three minutes is set by the write budget (20 MiB a minute of rows x C, which the
  // idle drain also runs into: about 650 jobs in its first three minutes) in half slices, so "half the queue" is not a bound the design
  // gives; the end state is G-BACKLOG's (memv2-c-pace-backlog-1021.test.ts: empty within 45 minutes with turns).
  expect(at[0]!).toBeLessThan(BACKLOG);
  expect(at[1]!).toBeLessThan(at[0]!);
  expect(at[2]!).toBeLessThan(at[1]!);
  expect(BACKLOG - activeJobs()).toBeGreaterThanOrEqual(300);
}, 600_000);

it("backlog, a turn goes live mid-drain: closing work keeps its budget through the turn and its own drain (V8)", async () => {
  seedBacklog();
  let live = false, before = false, afterDrain = false, leftAtLive = 0;
  await runRunner(4, () => live, second => {
    if (second === 30) {
      live = true; before = revokeBacklogBurst();
      drainRevokeMarkerBounded(f.db);
      afterDrain = revokeBacklogBurst(); leftAtLive = activeJobs();
    }
  });
  console.log(`MEMF3 backlog-turn closingBefore=${before} closingAfterTurnDrain=${afterDrain} left: atTurn=${leftAtLive} end=${activeJobs()} pacedBytes=${revokeWriteMeter.paceDated}`);
  expect(before).toBe(true);
  expect(afterDrain).toBe(true);
  expect(activeJobs()).toBeLessThan(Math.max(1, leftAtLive));
  expect(revokeWriteMeter.paceDated).toBeLessThanOrEqual(4 * (REVOKE_WRITE_BUDGET.bytesPerMinute + 2 * (REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE) * revokeChangeCeiling(f.db)));
}, 600_000);

it("backlog, a live turn waiting on the fence: the runner has the full ledger and full slices (V14)", async () => {
  seedBacklog();
  const done = noteFenceWaiter();
  let closing = 0;
  try { await runRunner(2, () => true, () => { if (revokeBacklogBurst()) closing++; }); } finally { done(); }
  console.log(`MEMF3 backlog-waiter closingSeconds=${closing} left=${activeJobs()} pacedBytes=${revokeWriteMeter.paceDated}`);
  expect(closing).toBeGreaterThan(0);
  expect(memoryRevocationStats.markerYields).toBe(0); // not slowed for the waiting turn
  expect(revokeWriteMeter.paceDated).toBeLessThanOrEqual(2 * (REVOKE_WRITE_BUDGET.bytesPerMinute + 2 * (REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE) * revokeChangeCeiling(f.db)));
}, 600_000);

// q1023-ownerfence (MAIN-RULING 2026-11-27T02:36:43Z: 55.5 MiB written in a turn minute on the real copy against the 50 MiB gate): closing
// work beside a live turn keeps a measured minute, REVOKE_CLOSING_PACE (40 MiB in the app). The pace is scaled down here so this fixture's
// walk reaches it: through the real runner, no wall-clock minute of measured drain bytes reaches twice the pace (its own room plus copies dated from the minute before), and
// the queue still drains. (Read through the module namespace: a build without the pace has nothing to scale, and its walk is unpaced.)
it("OWNERFENCE-PACE backlog, a turn live throughout: closing work's measured bytes stay inside the closing pace every minute", async () => {
  seedBacklog();
  const budget = await import("./revoke-budget.ts") as { REVOKE_CLOSING_PACE?: { bytesPerMinute: number } };
  const pace = Number(process.env.OWNERFENCE_PACE ?? 1024 * 1024), prior = budget.REVOKE_CLOSING_PACE?.bytesPerMinute;
  if (budget.REVOKE_CLOSING_PACE) budget.REVOKE_CLOSING_PACE.bytesPerMinute = pace;
  const minutes: number[] = [];
  let last = 0, closing = 0;
  try {
    await runRunner(3, () => true, second => {
      if (revokeBacklogBurst()) closing++;
      if (second % 60 === 59) { minutes.push(revokeWriteMeter.paceDated - last); last = revokeWriteMeter.paceDated; }
    });
  } finally { if (budget.REVOKE_CLOSING_PACE && prior !== undefined) budget.REVOKE_CLOSING_PACE.bytesPerMinute = prior; }
  // a minute holds what the pace admitted in it plus copy halves dated into it from the minute before: at most one more pace
  const excess = pace;
  console.log(`OWNERFENCE-PACE pace=${pace} excess=${excess} minutes=${minutes.join(",")} closingSeconds=${closing} left=${activeJobs()}`);
  expect(closing).toBeGreaterThan(0);
  expect(Math.max(...minutes), "a minute of closing work passed the closing pace").toBeLessThan(pace + excess);
  expect(BACKLOG - activeJobs()).toBeGreaterThan(0);
}, 600_000);

// q1023-leftout (MAIN-RULING 2026-11-27T02:36:43Z; real copy c18a83804d: 110 MiB written in a turn minute against the 50 MiB gate, 4 MiB in an
// idle one): closing work on a minute that is not idle, with no turn waiting on a window, keeps a wall-clock budget of its own commits' log
// bytes (REVOKE_LIVE_CLOSING, 16 MiB in the app). Scaled down here so this fixture's walk reaches it, through the real runner with a turn
// live throughout. Own bytes = half of what endRevokeMeasure metered (it meters each commit as write + copy). A minute holds the budget plus
// at most the commit that crossed it. (Read through the module namespace: a build without the budget has nothing to scale.)
const LIVE_CAP = 512 * 1024;
async function liveClosingMinutes(waiter: boolean): Promise<{ minutes: number[]; closing: number; waits: number }> {
  seedBacklog();
  const budget = await import("./revoke-budget.ts") as { REVOKE_LIVE_CLOSING?: { bytesPerMinute: number } };
  const prior = budget.REVOKE_LIVE_CLOSING?.bytesPerMinute;
  if (budget.REVOKE_LIVE_CLOSING) budget.REVOKE_LIVE_CLOSING.bytesPerMinute = LIVE_CAP;
  const done = waiter ? noteFenceWaiter() : () => {};
  const minutes: number[] = [];
  const own = () => (revokeWriteMeter.paceMeasured + revokeWriteMeter.paceUnmeasured) / 2;
  let last = 0, closing = 0;
  try {
    await runRunner(3, () => true, second => {
      if (revokeBacklogBurst()) closing++;
      if (second % 60 === 59) { minutes.push(own() - last); last = own(); }
    });
  } finally { done(); if (budget.REVOKE_LIVE_CLOSING && prior !== undefined) budget.REVOKE_LIVE_CLOSING.bytesPerMinute = prior; }
  return { minutes, closing, waits: (memoryRevocationStats as { liveClosingWaits?: number }).liveClosingWaits ?? 0 };
}
it("LEFTOUT-LIVE backlog, a turn live throughout and no reader waiting: closing commits' own log bytes stay inside the live closing budget every minute, and the queue still drains", async () => {
  const run = await liveClosingMinutes(false);
  console.log(`LEFTOUT-LIVE cap=${LIVE_CAP} minutes=${run.minutes.join(",")} closingSeconds=${run.closing} waits=${run.waits} left=${activeJobs()}`);
  expect(run.closing).toBeGreaterThan(0);
  expect(Math.max(...run.minutes), "a minute of closing work beside a turn passed the live closing budget").toBeLessThanOrEqual(1.5 * LIVE_CAP);
  expect(BACKLOG - activeJobs()).toBeGreaterThan(0);
}, 600_000);
it("LEFTOUT-LIVE twin, a turn waiting on a window: its walk is never held to the live closing budget", async () => {
  const run = await liveClosingMinutes(true);
  console.log(`LEFTOUT-LIVE-WAITER cap=${LIVE_CAP} minutes=${run.minutes.join(",")} closingSeconds=${run.closing} waits=${run.waits} left=${activeJobs()}`);
  expect(run.waits).toBe(0);
  expect(Math.max(...run.minutes), "a waited walk was held to the live closing budget").toBeGreaterThan(4 * LIVE_CAP);
}, 600_000);
