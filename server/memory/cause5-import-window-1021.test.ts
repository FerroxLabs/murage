// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: cause5-1021 (the marker's inline walk of an owner commit when its write minute is spent: revoke-budget.ts budgetedMarkerSlice).
// Producer side (tracked notebook re-import, its write-time revoke): import.ts / revocation.ts owners. Consumer side (retained fence,
// consuming response gate): send-fence.ts owners. Admission ledger lock: io-budget.ts / admission-shared.ts owners (unchanged here).
// 1.0.21 field (a long real profile under load): the marker's write minute is always spent ("settle outcome=budget"), so the write-time
// revoke a routine's once-a-minute notebook re-import commits ("memory receipts revoked scope=records cause=import count=0": no receipt
// ends) cannot walk inline and stays an active job. Its all-threads, all-scopes window makes every receipt written after it read
// checking:pending: a bot-to-bot hand-off cannot set up its turn, and a running hand-off's finished reply is refused after a lookup.
// Every test holds the admission ledger lock from another thread's token for its whole length (the injected lock delay).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { bindConsumingTurn, emitConsumingTurnResponse, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { maintainRecallViewSlice, prepareRecallContextSync } from "./recall-view.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { searchMemory } from "./search.ts";
import { resetSessionHolds } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { INLINE_FLOOR, REVOKE_WRITE_BUDGET, resetRevokeWriteBudget, revokeBytesWritten, revokeCostPerChange, setRevokeBudgetClock } from "./revoke-budget.ts";
import { INLINE_PRUNE, MARKER_STEP_RESERVE } from "./revoke-marker.ts";
import { INLINE_REVOCATION } from "./memory-revocation.ts";
import { ioBudget } from "../io-budget.ts";
import { checkpointLedger } from "../admission-shared.ts";
import { addTurnParents, checkedOpenTurns, closeTurnLineage, openTurnLineage, refuseRetainedTurn } from "./lineage-write.ts";
import { assertRetainedFence, prepareRetainedFence } from "./send-fence.ts";
import { PENDING_ALL_SCOPES, PENDING_ALL_THREADS, type LineageReader, type LineageVerdict } from "./lineage-types.ts";

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
const OWNER: LineageReader = { audience: { owner: true, scopeIds: [] } };
const budget = REVOKE_WRITE_BUDGET.bytesPerMinute, floor = INLINE_FLOOR.changesPerMinute;
let warnings: string[] = [];
beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); resetSessionHolds();
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); });
});
afterEach(() => { REVOKE_WRITE_BUDGET.bytesPerMinute = budget; vi.restoreAllMocks(); closeMessageDb(); closeDatabase(); });

// 64-byte lines, 32 to a 2048-byte chunk (chunks.ts), each chunk on its own subject: chunks 0-2 are full, chunk 3 (4 lines) is the last
const SUBJECTS = ["anchor", "harbor", "orchard", "granite"];
const line = (i: number) => `Line ${String(i).padStart(4, "0")}: ${SUBJECTS[Math.floor(i / 32)]} notes the owner keeps here`.padEnd(63, ".");
const lines = Array.from({ length: 100 }, (_, i) => line(i));
const LAST = 3;
/** A routine's same-length status rewrite of the notebook's first line: chunk 0 changes, no chunk boundary moves. */
const stamped = (day: number) => [`Line 0000: status checked 2026-11-${String(day).padStart(2, "0")} by the routine`.padEnd(63, "."), ...lines.slice(1)];
let path = "";
function seed(text: string) {
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  path = join(root, "MEMORY.md");
  writeFileSync(path, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
/** The routine writes the notebook; the tracked sync's next look (import.ts syncTrackedMemoryImports) re-imports it. */
function routineWrites(text: string) {
  writeFileSync(path, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  syncTrackedMemoryImports(roster);
}
function access(bot = "a", thread = "thread-a") {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  prepareRecallContextSync(bot, thread, roster);
  const a = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  while (!maintainRecallViewSlice(a.view)) { /* the recall view is built before the turn */ }
  return a;
}
const chunkOf = (index: number) => database().prepare("SELECT id,version,state FROM memory_records WHERE id LIKE ? ORDER BY version").all(`%:chunk:${index}`) as Array<{ id: string; version: number; state: string }>;
const active = (index: number) => chunkOf(index).find(row => row.state === "active")!;

// ---- the injected lock delay: another thread's token holds the admission ledger lock word for the whole test (admission-shared.ts: the
// main thread never waits for it; every main operation that needs it is refused and counted, io-budget.ts critical).
let foreign: ReturnType<typeof checkpointLedger> | null = null;
function holdLedgerLock() {
  const before = ioBudget.admissionHealth().lockTimeouts;
  foreign = checkpointLedger(ioBudget.checkpointAdmissionBuffer(), 7);
  foreign.lock();
  // proof the delay is real: the main thread's next ledger operation is refused with AdmissionLockTimeout
  ioBudget.checkpointAdmissionBuffer();
  expect(ioBudget.admissionHealth().lockTimeouts).toBe(before + 1);
}
const prunePage = INLINE_PRUNE.rows, inlineMs = INLINE_REVOCATION.ms;
afterEach(() => { foreign?.unlock(); foreign = null; INLINE_FLOOR.changesPerMinute = floor; INLINE_PRUNE.rows = prunePage; INLINE_REVOCATION.ms = inlineMs; setRevokeBudgetClock(); resetRevokeWriteBudget(); });
/** Sean's Mac: the marker's write minute is spent by the queue it already has ("settle outcome=budget ms=0 ... activeJobs=>1000"). */
const minuteSpent = () => { REVOKE_WRITE_BUDGET.bytesPerMinute = 1; };
/** A hand-off's turn. What refuses it is not its audience (a pending check is judged before any audience rule) but that it has no owner
 * keep rule: index.ts passes prepareRetainedFence a continuePending callback for owner direct turns only, and turnOf passes none. */
const DELEGATED: LineageReader = OWNER;
const activeJobs = () => (database().prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')").get() as { n: number }).n;
const windows = () => (database().prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=?").get(PENDING_ALL_THREADS) as { n: number }).n
  + (database().prepare("SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id=?").get(PENDING_ALL_SCOPES) as { n: number }).n;
/** Bot b (the hand-off's worker) keeps its own short notebook, which nothing rewrites: its turns recall that one chunk. */
function seedWorker() {
  const root = ensureWorkspace("b"), ticket = ownerMemoryTicket();
  writeFileSync(join(root, "MEMORY.md"), Array.from({ length: 4 }, (_, i) => `Line ${i}: lantern notes the worker keeps here`.padEnd(63, ".")).join("\n"));
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "b" }], roster).previewId, roster, true);
}
const LANTERN = -1;
const lantern = () => database().prepare("SELECT id,version FROM memory_records WHERE state='active' AND text LIKE '%lantern%'").get() as { id: string; version: number };
const hits = (index: number | null) => index === null ? [] : [index === LANTERN ? lantern() : active(index)].map(row => ({ id: row.id, version: row.version, score: 1, similarity: 0.9 }));
const finder = (index: number | null) => ({ search: async () => ({ hits: hits(index), vectorRows: 1, coverageComplete: true }) });
const ask = (index: number | null) => index === null ? "anything new today" : `what are my ${index === LANTERN ? "lantern" : SUBJECTS[index]} notes`;
const refused = () => warnings.filter(text => text.startsWith("[memory] retained fence refused"));
const importLines = () => warnings.filter(text => text.startsWith("memory receipts revoked scope=records cause=import"));

/** A turn of `bot` in `thread`. Its frame receipt is made by the real path and joins the turn; replies go through the consuming gate, which
 * runs the retained fence. A hand-off's turn (DELEGATED, no owner keep rule: index.ts passes continuePending for owner direct turns only). */
async function turnOf(bot: string, thread: string, reader: LineageReader, frame: number | null, session: string) {
  const db = database(), turnId = `turn-${session}`, a = access(bot, thread);
  const turn = openTurnLineage(db, { threadId: thread, turnId });
  const refusedWith: LineageVerdict[] = [];
  prepareRetainedFence(turn, reader, verdict => { refusedWith.push(verdict); }, db);
  addTurnParents(turn, [{ kind: "none", reason: "owner-turn" }]);
  const dispatch = new MemoryDispatchReceipt(await buildMemoryBundle(ask(frame), a, finder(frame), { allowance: LineageAllowance.tool() }), a, "fixture", turn);
  dispatch.sessionStarted(session); dispatch.accepted();
  const members = checkedOpenTurns(turn);
  const binding = bindConsumingTurn({
    identity: { botId: bot, threadId: thread, dispatchGeneration: turnId, lineageTurnIds: members.map(m => m.turnId), adapterLeaseId: turnId },
    turn, db, isCurrent: () => true,
    onLedgerRefused: verdict => { for (const member of members) refuseRetainedTurn(member, verdict); },
  });
  const reply = () => { const write = vi.fn(() => "written"); emitConsumingTurnResponse(binding, registerConsumingDescriptor("native:openai:tool-append", "native"), { bytes: 8, refs: [], write }); return write; };
  const lookup = async (index: number | null) => {
    const found = await searchMemory(ask(index), a, finder(index), { allowance: LineageAllowance.tool() });
    expect(found.hits.length).toBe(hits(index).length);
    dispatch.noteLookup(found.hits.map(hit => ({ id: hit.id, version: hit.version, evidence: hit.evidence.map(handle => ({ sourceId: String(handle.sourceId), revision: Number(handle.revision) })) })), a);
  };
  return { turn, bundle: dispatch.bundle, refusedWith, reply, lookup, setUp: () => assertRetainedFence(turn, db), close: () => closeTurnLineage(turn) };
}
const fenceOf = (error: unknown) => (error as { fence?: LineageVerdict } | undefined)?.fence;
function caught(work: () => unknown): unknown { try { work(); return undefined; } catch (error) { return error; } }
async function caughtAsync(work: () => Promise<unknown>): Promise<unknown> { try { await work(); return undefined; } catch (error) { return error; } }

it("C5-1 delegation setup: a hand-off's turn sets up after a routine's count=0 re-import, with the marker's minute spent and the ledger lock held", async () => {
  seed(lines.join("\n")); seedWorker();
  const shown = await turnOf("a", "thread-a", OWNER, LAST, "session-a");
  shown.reply(); shown.close();
  holdLedgerLock();
  minuteSpent();
  // the hand-off's worker has recalled its own notebook; the routine's re-import lands before the turn's dispatch fence
  const w = await turnOf("b", "thread-b", DELEGATED, LANTERN, "session-b");
  try {
    expect(w.bundle.recordVersions).toEqual([{ id: lantern().id, version: lantern().version }]);
    routineWrites(stamped(19).join("\n"));
    expect(importLines()).toEqual(["memory receipts revoked scope=records cause=import count=0"]);
    const failed = caught(() => w.setUp());
    expect(failed === undefined ? "set up" : `${(failed as Error).message} ${JSON.stringify(fenceOf(failed))}`).toBe("set up");
    expect(refused()).toEqual([]);
    expect(w.reply()).toHaveBeenCalledTimes(1);
    expect(w.refusedWith).toEqual([]);
    // the re-import's revoke ended no receipt and nothing consumes the withdrawn chunk: its walk finished at the commit, no job, no window
    expect({ activeJobs: activeJobs(), windows: windows() }).toEqual({ activeJobs: 0, windows: 0 });
  } finally { w.close(); }
  // and the next hand-off, set up after the re-import, is given its worker's memory (on base: recalled empty, "recall=withheld")
  const next = await turnOf("b", "thread-b", DELEGATED, LANTERN, "session-c");
  try {
    expect(next.bundle.recordVersions).toEqual([{ id: lantern().id, version: lantern().version }]);
    expect(() => next.setUp()).not.toThrow();
  } finally { next.close(); }
});

it("C5-2 finished reply: a running hand-off that looks memory up after the count=0 re-import still delivers its reply", async () => {
  seed(lines.join("\n")); seedWorker();
  const shown = await turnOf("a", "thread-a", OWNER, LAST, "session-a");
  shown.reply(); shown.close();
  const w = await turnOf("b", "thread-b", DELEGATED, LANTERN, "session-b");
  try {
    expect(w.bundle.recordVersions).toEqual([{ id: lantern().id, version: lantern().version }]);
    expect(w.reply()).toHaveBeenCalledTimes(1);
    holdLedgerLock();
    minuteSpent();
    for (const day of [19, 20, 21]) routineWrites(stamped(day).join("\n"));
    expect(importLines()).toEqual(Array.from({ length: 3 }, () => "memory receipts revoked scope=records cause=import count=0"));
    const early = caught(() => w.reply());
    expect(early === undefined ? "delivered" : `${(early as Error).message} ${JSON.stringify(fenceOf(early))}`).toBe("delivered");
    const looked = await caughtAsync(() => w.lookup(LANTERN));
    expect(looked === undefined ? "looked up" : `${(looked as Error).message} ${JSON.stringify(fenceOf(looked))}`).toBe("looked up");
    let write: ReturnType<typeof vi.fn> | undefined;
    const failed = caught(() => { write = w.reply(); });
    expect(failed === undefined ? "delivered" : `${(failed as Error).message} ${JSON.stringify(fenceOf(failed))}`).toBe("delivered");
    expect(write).toHaveBeenCalledTimes(1);
    expect(w.refusedWith).toEqual([]);
    expect(refused()).toEqual([]);
    expect({ activeJobs: activeJobs(), windows: windows() }).toEqual({ activeJobs: 0, windows: 0 });
  } finally { w.close(); }
});

it("C5-3 control (fail closed kept): a re-import of the chunk a running turn WAS shown still ends its receipt and refuses its next reply", async () => {
  seed(lines.join("\n"));
  const shown = await turnOf("a", "thread-a", OWNER, LAST, "session-a");
  try {
    expect(shown.reply()).toHaveBeenCalledTimes(1);
    holdLedgerLock();
    minuteSpent();
    routineWrites([...lines.slice(0, 96), line(96).replace("granite", "revised"), ...lines.slice(97)].join("\n"));
    expect(importLines()).toContain("memory receipts revoked scope=records cause=import count=1");
    expect((database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(shown.bundle.bundleId) as { state: string }).state).toBe("revoked");
    const failed = caught(() => shown.reply());
    expect((failed as Error | undefined)?.message).toBe("MEMORY_CONTEXT_REVOKED");
    expect(fenceOf(failed)?.state).not.toBe("shown");
    expect(refused().length).toBe(1);
  } finally { shown.close(); }
});

// MEMORY V2 lane C changed one step of this on purpose. Design 4.3 V13: "Owner roots always walk inline up to the inline cap, whatever the
// minute holds (F31)" (cause5's floor "is kept and generalised by V8, V13, V15": INLINE_FLOOR is a meter now, no longer the condition), so
// a re-import after the floor's rows no longer waits as a job: it walks at its commit like the first, and is charged like the first. What
// bounds a commit's walk now is the inline cap itself (576 rows, 8 ms; V3: "A walk that does not fit stays queued exactly as today, window
// open"), so the "waits as a job with its window, memory withheld under it" half is kept on that bound: the same second re-import, its
// walk with none of its 8 ms left, leaves the same job and the same windows the spent floor left before.
it("C5-5 the floor is bounded and charged: past the inline cap the next revoke waits as a job with its window, as before", async () => {
  seed(lines.join("\n")); seedWorker();
  const shown = await turnOf("a", "thread-a", OWNER, LAST, "session-a");
  shown.reply(); shown.close();
  holdLedgerLock();
  minuteSpent();
  INLINE_FLOOR.changesPerMinute = 1;
  let now = 9_000_000;
  setRevokeBudgetClock(() => now);
  const before = revokeBytesWritten();
  routineWrites(stamped(19).join("\n"));
  // the first walk ran under the floor, and what it changed is in the minute's ledger like any other slice
  expect({ activeJobs: activeJobs(), windows: windows() }).toEqual({ activeJobs: 0, windows: 0 });
  expect(revokeBytesWritten()).toBeGreaterThan(before);
  // past the inline cap (was: past the floor's rows a minute) the next revoke waits as a job with its window
  INLINE_REVOCATION.ms = Number.MIN_VALUE;
  try { routineWrites(stamped(20).join("\n")); } finally { INLINE_REVOCATION.ms = inlineMs; }
  expect({ activeJobs: activeJobs(), windows: windows() }).toEqual({ activeJobs: 1, windows: 2 });
  // under that window the worker's own memory stays withheld from its turn (fail closed, as before the floor)
  const w = await turnOf("b", "thread-b", DELEGATED, LANTERN, "session-b");
  try { expect(w.bundle.recordVersions).toEqual([]); } finally { w.close(); }
  // V13: in the same minute, the floor's rows long spent, the next count=0 re-import still walks at its commit and is charged (before: it
  // waited as a second job until the floor had room a minute later); the earlier job still waits for the runner
  const charged = revokeBytesWritten();
  routineWrites(stamped(21).join("\n"));
  expect(activeJobs()).toBe(1);
  expect(revokeBytesWritten()).toBeGreaterThan(charged);
  // and a minute later likewise, as before
  now += 61_000;
  routineWrites(stamped(22).join("\n"));
  expect(activeJobs()).toBe(1);
});

// ---- r2 (Astra, cause5 4ae3fb12c5): finished job rows are global. A targeted completion leaves its finished row to the runner
// (revoke-marker.ts markerSliceDetailed, prune off), so a backlog of them can stand; the floored inline walk of a count=0 re-import then
// removed ALL of it in one statement inside the owner's transaction, in a spent minute, past the floor's stated ceiling.
/** The state those completions leave: `n` finished rows above every id in use (written as rows; nothing reads a finished row). */
function finishedBacklog(n: number) {
  database().prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?)
    INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state)
    SELECT (SELECT coalesce(max(revoke_id),0) FROM memory_revoke_jobs)+i,'content','{}',0,0,'done','','done' FROM k`).run(n);
}
const finished = () => (database().prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('done','undone')").get() as { n: number }).n;
const newestJob = () => Number((database().prepare("SELECT coalesce(max(revoke_id),0) AS n FROM memory_revoke_jobs").get() as { n: number }).n);
/** The most rows one floored inline slice may change: its least slice and the step reserve (revoke-budget.ts needRows). */
const SLICE_CEILING = 64 + MARKER_STEP_RESERVE;
/** One count=0 re-import in a spent minute over a backlog; what its commit changed, in rows as the minute's ledger was charged. */
function reimportOverBacklog(day: number) {
  const db = database(), bytes = revokeBytesWritten(), newest = newestJob(), had = finished();
  routineWrites(stamped(day).join("\n"));
  const revokes = newestJob() - newest;
  return { revokes, pruned: had + revokes - finished(), charged: Math.round((revokeBytesWritten() - bytes) / revokeCostPerChange(db)) };
}

it("C5-6 the floored walk removes finished rows a page at a time: a 1000-row backlog is not deleted in the owner's commit", async () => {
  seed(lines.join("\n"));
  // a receipt exists, as in C5-1: the re-import commits its write-time revoke
  const shown = await turnOf("a", "thread-a", OWNER, LAST, "session-a");
  shown.reply(); shown.close();
  holdLedgerLock();
  minuteSpent();
  let now = 9_000_000;
  setRevokeBudgetClock(() => now);
  finishedBacklog(1000);
  const first = reimportOverBacklog(19);
  // the walk itself still finishes at its commit (the cause5 fix is kept)
  expect(importLines()).toEqual(["memory receipts revoked scope=records cause=import count=0"]);
  expect({ activeJobs: activeJobs(), windows: windows() }).toEqual({ activeJobs: 0, windows: 0 });
  expect(first.revokes).toBeGreaterThan(0);
  // a page for each finished revoke, never the backlog; and the commit stays inside one floored slice for each of its revokes
  expect(first.pruned).toBeGreaterThan(0);
  expect(first.pruned).toBeLessThanOrEqual(first.revokes * INLINE_PRUNE.rows);
  expect(first.charged).toBeLessThanOrEqual(first.revokes * SLICE_CEILING);
  expect(finished()).toBeGreaterThanOrEqual(1000 - first.revokes * INLINE_PRUNE.rows);
  // batched: the next minute's re-import takes the next page
  now += 61_000;
  const left = finished(), second = reimportOverBacklog(20);
  expect(activeJobs()).toBe(0);
  expect(second.pruned).toBeGreaterThan(0);
  expect(second.pruned).toBeLessThanOrEqual(second.revokes * INLINE_PRUNE.rows);
  expect(finished()).toBeLessThan(left);
});

it("C5-7 the page is inside the slice's write cap: a page larger than the cap removes only what the cap and its reserve have left", async () => {
  seed(lines.join("\n"));
  const shown = await turnOf("a", "thread-a", OWNER, LAST, "session-a");
  shown.reply(); shown.close();
  holdLedgerLock();
  minuteSpent();
  setRevokeBudgetClock(() => 9_000_000);
  INLINE_PRUNE.rows = 100_000;
  finishedBacklog(1000);
  const one = reimportOverBacklog(19);
  expect({ activeJobs: activeJobs(), windows: windows() }).toEqual({ activeJobs: 0, windows: 0 });
  expect(one.revokes).toBeGreaterThan(0);
  expect(one.pruned).toBeGreaterThan(0);
  expect(one.charged).toBeLessThanOrEqual(one.revokes * SLICE_CEILING);
  expect(finished()).toBeGreaterThanOrEqual(1000 - one.revokes * SLICE_CEILING);
});

it("C5-4 control: the held ledger lock alone refuses no turn and no reply (it is counted, and nothing in the memory fence reads it)", async () => {
  seed(lines.join("\n")); seedWorker();
  holdLedgerLock();
  minuteSpent();
  const w = await turnOf("b", "thread-b", DELEGATED, LANTERN, "session-b");
  try {
    expect(() => w.setUp()).not.toThrow();
    expect(w.reply()).toHaveBeenCalledTimes(1);
    await w.lookup(LANTERN);
    expect(w.reply()).toHaveBeenCalledTimes(1);
    expect(refused()).toEqual([]);
    expect(ioBudget.admissionHealth().lockTimeouts).toBeGreaterThan(0);
  } finally { w.close(); }
});
