// SPDX-License-Identifier: AGPL-3.0-or-later
// SMOOTH-FTS-MERGE R6 batch 1 (designs/SMOOTH-FTS-MERGE-R6.md §1, §2): a conversation deletion writes tombstones and the marker in its own
// transaction with no inline optimize; the checkpointer worker pays the merge in committed slices, proves it with a `-N` that writes nothing,
// then the WAL scrub, then deletes the marker. Every fixture commits kept and deleted rows in the SAME transactions, and every residue
// assertion scans the raw `messages_fts_data` blocks or the -wal bytes for a one-trigram text (testing/search-merge-fixtures.ts).
// T1 delete, T3 proof, T4 drop failure, T6 lifecycle, T7 tidy, T8 receipt. Real worker thread throughout (no mocked scrub).
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, startBackgroundUpgrade, transaction } from "./database.ts";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { closeMessageDb, deleteThread, insertMessage, searchMessages } from "./message-db.ts";
import { afterCommit } from "./tx-scope.ts";
import { dropTestHooks, messageSearchIndexReady } from "./message-search-index.ts";
import { readIndexState } from "./transcript-backfill.ts";
import { resumeSearchMerge, searchMergeBusy, searchMergeFastPath, searchMergeOwing, searchMergeTestHooks, type SearchMergeEvent, SEARCH_MERGE_PAGES } from "./search-merge-runner.ts";
import { mergeOpTestHooks, scrubWalAfterDelete, stopWalMaintenance, walActivationToken, walMaintenanceReady, walMaintenanceTestHooks, walMark, walScrubbed, type WalSince } from "./wal-maintenance.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fileHas, ftsLevels, markerRow, rawBlocksWith, spread, tombstonePages, type Group } from "./testing/search-merge-fixtures.ts";

let clock = 1_000;
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });
const found = (query: string) => searchMessages(query, 400).map(hit => `${hit.threadId}/${hit.messageId}`);
const walFile = () => join(DATA_DIR, "messages.db-wal");
const events: SearchMergeEvent[] = [];
/** Every settled prove, with the probe and the detector read at that moment on the main connection: a proof must never lie. */
const lies: string[] = [];
let watchGroups: Group[] = [];

function resetHooks() {
  searchMergeTestHooks.onEvent = null; searchMergeTestHooks.halt = false; searchMergeTestHooks.kickMs = 10; searchMergeTestHooks.startPages = SEARCH_MERGE_PAGES;
  searchMergeTestHooks.backoffFirstMs = 200; searchMergeTestHooks.replyLostMs = 60_000; searchMergeTestHooks.segments = false;
  walMaintenanceTestHooks.retryMs = 50; walMaintenanceTestHooks.holdMs = 0; walMaintenanceTestHooks.restartDelaysMs = [50, 100, 200];
  walMaintenanceTestHooks.failPragma = null; mergeOpTestHooks.extra = {};
  dropTestHooks.failDrop = false; dropTestHooks.failDeleteAll = false;
}
beforeEach(async () => {
  closeMessageDb(); closeDatabase(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  resetHooks(); events.length = 0; lies.length = 0; watchGroups = [];
  searchMergeTestHooks.onEvent = watch;
});
/** The default event watch: records the event and checks every settled prove for residue (a replacement callback calls it first). */
function watch(event: SearchMergeEvent) {
  events.push(event);
  if (event.kind === "prove" && event.reply?.settled) {
    const db = database();
    if (tombstonePages(db)) lies.push("tombstone pages left at a settled proof");
    for (const group of watchGroups) if (rawBlocksWith(db, group)) lies.push(`${group} bytes left at a settled proof`);
  }
}
afterEach(async () => { resetHooks(); searchMergeTestHooks.kickMs = 250; walMaintenanceTestHooks.retryMs = 30_000; walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; closeMessageDb(); closeDatabase(); await stopWalMaintenance(); });

/** The app's connection with the worker up and the fast path read back. */
async function ready() {
  const db = database();
  await vi.waitFor(() => { expect(walMaintenanceReady()).toBe(true); expect(searchMergeFastPath()).toBe(true); }, { timeout: 10_000 });
  return db;
}
/** `rounds` transactions, each with `kept` ASCII rows of thread `keep` and `gone` rows of thread `thread` whose text is exactly `group`. */
function fillMixed(thread: string, group: Group, rounds: number, kept = 8, gone = 4, keep = "keep") {
  for (let r = 0; r < rounds; r++) transaction(() => {
    for (let i = 0; i < kept; i++) insertMessage(keep, msg(`${keep}-${thread}-${r}-${i}`, `kept${r}x${i} alpha bravo charlie ${r * 31 + i}`));
    for (let i = 0; i < gone; i++) insertMessage(thread, msg(`${thread}-${r}-${i}`, group));
  });
}
const proveResults = () => events.filter(e => e.kind === "prove" && e.reply && !e.reply.busy && !e.reply.error).map(e => Boolean(e.reply!.settled));
async function untilPaid(timeout = 20_000) {
  const db = database();
  await vi.waitFor(() => { expect(markerRow(db)).toBeUndefined(); expect(searchMergeOwing()).toBe(false); }, { timeout, interval: 20 });
}
/** The tidy after the fixtures' own writes has ended: the test starts from the idle phase. */
async function quiet() {
  await vi.waitFor(() => expect(searchMergeBusy()).toBe(false), { timeout: 15_000, interval: 20 });
}

describe("T1 delete: tombstones and the marker in the deletion's transaction, no inline optimize", () => {
  it("the text is unfindable at once; the raw blocks hold it while owed, done=0 then done=1 after the prove, absent after the scrub", async () => {
    const db = await ready();
    watchGroups = ["жжж"];
    fillMixed("gone", "жжж", 12);
    await quiet();
    expect(found("жжж")).toHaveLength(48);
    expect(rawBlocksWith(db, "жжж")).toBeGreaterThan(0);
    let atProve: { done: number } | undefined;
    searchMergeTestHooks.onEvent = (event => { const prior = event; events.push(prior); if (prior.kind === "prove" && prior.reply?.settled) atProve = markerRow(database()); });
    searchMergeTestHooks.halt = true; // hold the run so the owed state can be read
    const started = performance.now();
    deleteThread("gone");
    const deleteMs = performance.now() - started;
    expect(markerRow(db)).toEqual({ done: 0 });
    expect(searchMergeOwing()).toBe(true);
    expect(found("жжж")).toEqual([]);
    expect(found("kept3x2 alpha")).toEqual(["keep/keep-gone-3-2"]);
    expect(rawBlocksWith(db, "жжж")).toBeGreaterThan(0); // owed: tombstoned, still in the mixed segments
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await untilPaid();
    expect(atProve).toEqual({ done: 1 });
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(tombstonePages(db)).toBe(false);
    expect(fileHas(walFile(), "жжж")).toBe(false);
    expect(found("kept3x2 alpha")).toEqual(["keep/keep-gone-3-2"]);
    expect(found("alpha bravo")).toHaveLength(96);
    console.log(`[T1] small fixture deleteThread main-thread ms=${deleteMs.toFixed(2)}`);
  });

  it("a deletion that rolls back leaves no marker and owes nothing", async () => {
    const db = await ready();
    fillMixed("gone", "жжж", 3);
    expect(() => transaction(() => { deleteThread("gone"); throw new Error("rolled back"); })).toThrow("rolled back");
    expect(markerRow(db)).toBeUndefined();
    expect(searchMergeOwing()).toBe(false);
    expect(found("жжж")).toHaveLength(12);
  });

  it("a deletion runs no optimize: the delete's own transaction leaves the merge owed (the structure keeps its segments)", async () => {
    const db = await ready();
    searchMergeTestHooks.halt = true;
    fillMixed("gone", "жжж", 6);
    const before = ftsLevels(db).reduce((n, level) => n + level.segments, 0);
    expect(before).toBeGreaterThan(1);
    deleteThread("gone");
    expect(ftsLevels(db).reduce((n, level) => n + level.segments, 0)).toBe(before);
    expect(markerRow(db)).toEqual({ done: 0 });
  });
});

describe("T3 proof: the -N that writes nothing is the only clearing criterion; it can be delayed, never fooled", () => {
  it("(a) a write during an in-progress merge: the run still ends settled and no proof lies", async () => {
    const db = await ready();
    watchGroups = ["жжж"];
    searchMergeTestHooks.startPages = 1;
    fillMixed("gone", "жжж", 16, 30, 6);
    await quiet();
    let halted = false;
    searchMergeTestHooks.onEvent = event => { events.push(event); if (event.kind === "first" && !halted) { halted = true; searchMergeTestHooks.halt = true; } };
    deleteThread("gone");
    await vi.waitFor(() => expect(halted).toBe(true), { timeout: 10_000 });
    insertMessage("keep", msg("late", "a late kept row written mid merge")); // one small level-0 segment while the merge is in progress
    searchMergeTestHooks.onEvent = event => { events.push(event); if (event.kind === "prove" && event.reply?.settled && (tombstonePages(database()) || rawBlocksWith(database(), "жжж"))) lies.push("lied"); };
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await untilPaid();
    expect(lies).toEqual([]);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(found("late kept row")).toEqual(["keep/late"]);
    console.log(`[T3a] proves=${JSON.stringify(proveResults())}`);
  });

  it("(b) a delete of rows already emitted into the in-progress merge output: not settled first, settled later, never fooled", async () => {
    const db = await ready();
    watchGroups = ["жжж", "ффф"];
    searchMergeTestHooks.startPages = 2;
    fillMixed("first", "ффф", 6, 40, 6);
    fillMixed("second", "жжж", 6, 40, 6, "keep2");
    await quiet();
    let slices = 0;
    searchMergeTestHooks.onEvent = event => { events.push(event); if ((event.kind === "first" || event.kind === "slice") && ++slices === 3) searchMergeTestHooks.halt = true; };
    deleteThread("first"); // the run starts merging every segment, the ж rows' postings among its output
    await vi.waitFor(() => expect(slices).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    events.length = 0;
    deleteThread("second"); // tombstones now land on postings the in-progress merge already emitted
    searchMergeTestHooks.onEvent = event => { events.push(event); if (event.kind === "prove" && event.reply?.settled && (tombstonePages(database()) || rawBlocksWith(database(), "жжж") || rawBlocksWith(database(), "ффф"))) lies.push("lied"); };
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await untilPaid();
    expect(lies).toEqual([]);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(rawBlocksWith(db, "ффф")).toBe(0);
    console.log(`[T3b] proves=${JSON.stringify(proveResults())}`);
    expect(proveResults()).toContain(false);
    expect(proveResults().at(-1)).toBe(true);
  });

  it("(c) a delete mid-run writes done=0 again; both threads are clean at the end", async () => {
    const db = await ready();
    watchGroups = ["жжж", "щщщ"];
    searchMergeTestHooks.startPages = 1;
    fillMixed("a", "жжж", 8, 20, 5);
    fillMixed("b", "щщщ", 8, 20, 5, "keep2");
    await quiet();
    let halted = false;
    searchMergeTestHooks.onEvent = event => { watch(event); if (event.kind === "slice" && !halted) { halted = true; searchMergeTestHooks.halt = true; } };
    deleteThread("a");
    await vi.waitFor(() => expect(halted).toBe(true), { timeout: 10_000 });
    deleteThread("b");
    expect(markerRow(db)).toEqual({ done: 0 });
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await untilPaid();
    expect(proveResults().filter(Boolean).length).toBeGreaterThanOrEqual(1); // the residue check above ran on a settled prove
    expect(lies).toEqual([]);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(rawBlocksWith(db, "щщщ")).toBe(0);
    expect(fileHas(walFile(), "жжж")).toBe(false);
    expect(fileHas(walFile(), "щщщ")).toBe(false);
  });
});

describe("T4 drop failure: delete-all and the fill reset in the same transaction, the backfill queued again after COMMIT", () => {
  it("a thrown drop empties the index, the handle stops trusting it at once, the scan finds what is kept, and the re-queued fill restores it", async () => {
    const db = await ready();
    fillMixed("gone", "жжж", 5);
    const background = startBackgroundUpgrade();
    await background.done;
    expect(messageSearchIndexReady(db)).toBe(true);
    dropTestHooks.failDrop = true;
    deleteThread("gone");
    dropTestHooks.failDrop = false;
    expect(messageSearchIndexReady(db)).toBe(false);
    expect(readIndexState(db, "search_fts")).toEqual({ done: 0, cursor: 0, skipped: 0 });
    expect(Number(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id = 'gone'").get()!.n)).toBe(0);
    expect(found("kept2x5 alpha")).toEqual(["keep/keep-gone-2-5"]); // the scan
    expect(found("жжж")).toEqual([]);
    await vi.waitFor(() => expect(messageSearchIndexReady(db)).toBe(true), { timeout: 15_000 });
    expect(Number(db.prepare("SELECT count(*) AS n FROM messages_fts_docsize").get()!.n)).toBe(40);
    expect(found("kept2x5 alpha")).toEqual(["keep/keep-gone-2-5"]);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
  });

  it("a thrown drop whose delete-all throws too rolls the deletion back and the delete fails", async () => {
    const db = await ready();
    fillMixed("gone", "жжж", 2);
    dropTestHooks.failDrop = true; dropTestHooks.failDeleteAll = true;
    expect(() => deleteThread("gone")).toThrow(/delete-all failed/);
    expect(Number(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id = 'gone'").get()!.n)).toBe(8);
    expect(markerRow(db)).toBeUndefined();
  });
});

describe("T6 lifecycle: activation tokens, stale replies, killed workers, lost replies", () => {
  it("a same-path replacement starts the scheduler for the new token; the old worker's late reply is dropped; the marker in the new file is paid", async () => {
    await ready();
    watchGroups = ["жжж"];
    fillMixed("gone", "жжж", 8);
    await quiet();
    mergeOpTestHooks.extra = { holdMs: 400 }; // each op holds its transaction open
    deleteThread("gone");
    const token = walActivationToken();
    await vi.waitFor(() => expect(events.some(e => e.kind === "config" && e.token === token && e.reply?.marker === 0)).toBe(true), { timeout: 10_000 });
    // replace the file under the same path while an op is in flight: a copy that still owes the merge
    closeMessageDb(); closeDatabase(); await stopWalMaintenance();
    mergeOpTestHooks.extra = {};
    const owedCopy = join(DATA_DIR, "owed.db");
    copyFileSync(join(DATA_DIR, "messages.db"), owedCopy);
    copyFileSync(owedCopy, join(DATA_DIR, "messages.db"));
    const fresh = await ready();
    const next = walActivationToken();
    expect(next).toBeGreaterThan(token);
    await untilPaid();
    expect(events.filter(e => e.kind === "stale" && e.reply?.token === token).length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.kind === "prove" && e.token === next && e.reply?.settled)).toBe(true);
    expect(rawBlocksWith(fresh, "жжж")).toBe(0);
    expect(lies).toEqual([]);
  });

  it("a worker killed while a slice holds its transaction: nothing commits from it, the restarted worker resumes from the marker", { timeout: 40_000 }, async () => {
    const db = await ready();
    watchGroups = ["жжж"];
    fillMixed("gone", "жжж", 8);
    await quiet();
    // the worker sets `held` inside the first slice's open transaction (after its merge, before COMMIT) and then holds the lock: the
    // kill lands there, so the slice's COMMIT never runs and no reply comes for it
    const held = new Int32Array(new SharedArrayBuffer(4));
    mergeOpTestHooks.extra = { holdMs: 5000, held };
    const structureBlock = () => Buffer.from((db.prepare("SELECT block FROM messages_fts_data WHERE id = 10").get() as { block: Uint8Array }).block);
    const firstToken = walActivationToken();
    const from = events.length; // the fixtures' own tidy answered before this: only the deletion's run counts
    const answered = () => events.slice(from).filter(e => e.kind === "first" || e.kind === "slice" || e.kind === "prove").length;
    deleteThread("gone");
    // (a PASSIVE posted meanwhile also holds 5 s: the wait allows for one)
    await vi.waitFor(() => expect(Atomics.load(held, 0)).toBe(1), { timeout: 20_000, interval: 5 });
    const before = structureBlock();
    const answeredBefore = answered();
    mergeOpTestHooks.extra = {};
    searchMergeTestHooks.halt = true; // the restarted worker reads nothing until the check below
    walMaintenanceTestHooks.terminate();
    // past the 5 s hold: had the kill not landed inside the transaction, its COMMIT would have run by now. It rolled back: the committed
    // structure is the one read while it held the lock, and the slice never answered
    await new Promise(resolve => setTimeout(resolve, 6000));
    expect(structureBlock().equals(before)).toBe(true);
    expect(answeredBefore).toBe(0);
    expect(answered()).toBe(0);
    expect(markerRow(db)).toEqual({ done: 0 });
    await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await untilPaid();
    expect(walActivationToken()).toBe(firstToken); // the same activation: the restarted worker resumed from the marker
    expect(proveResults().filter(Boolean).length).toBeGreaterThanOrEqual(1); // the residue check ran on the restarted worker's settled prove
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(lies).toEqual([]);
  });

  it("a lost reply is given up, the sequence starts again from the marker read, and a late answer is dropped", async () => {
    const db = await ready();
    watchGroups = ["жжж"];
    fillMixed("gone", "жжж", 6);
    await quiet();
    searchMergeTestHooks.replyLostMs = 300;
    mergeOpTestHooks.extra = { drop: true };
    deleteThread("gone");
    await vi.waitFor(() => expect(events.some(e => e.kind === "lost")).toBe(true), { timeout: 10_000 });
    mergeOpTestHooks.extra = {};
    await untilPaid();
    expect(events.some(e => e.kind === "backoff")).toBe(true);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
  });

  it("a worker whose pragma readback is wrong fails and is restarted; the next one runs the merge", async () => {
    walMaintenanceTestHooks.failPragma = "journal_size_limit";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = await ready(); // the first worker refused its readback and ended; this is the restarted one
      expect(walMaintenanceTestHooks.failPragma).toBeNull();
      fillMixed("gone", "жжж", 4);
      deleteThread("gone");
      await untilPaid();
      expect(rawBlocksWith(db, "жжж")).toBe(0);
    } finally { warn.mockRestore(); }
  });
});

describe("T7 tidy: with automerge=0 the worker's positive slices keep the levels low", () => {
  it("5,000 inserts at a steady cadence: no level reaches 16 while the worker is up and no insert commit takes over 20 ms; stopped, the crossing COMMIT is timed and reported", { tags: ["nightly"], timeout: 400_000 }, async () => {
    searchMergeTestHooks.kickMs = 250; // production kick
    const db = await ready();
    // the same connection's bare commit cost (synchronous=FULL, one fsync), with no index write: the floor under every insert below
    db.exec("CREATE TABLE IF NOT EXISTS t7_floor(n INTEGER)");
    const floor: number[] = [];
    for (let i = 0; i < 300; i++) { const began = performance.now(); db.exec("BEGIN IMMEDIATE"); db.prepare("INSERT INTO t7_floor VALUES(?)").run(i); db.exec("COMMIT"); floor.push(performance.now() - began); await new Promise(resolve => setTimeout(resolve, 20)); }
    const ms: number[] = [];
    // the insert's commit: the wait for the write lock (BEGIN IMMEDIATE, where a worker slice can hold it) plus the COMMIT itself,
    // apart from the app's own work inside the transaction (timed separately as `wall`)
    const commit: number[] = [];
    // every commit is checked, not a sample: inside the insert's own write transaction (no worker slice can commit meanwhile) level 0
    // is read before the insert; a foreground crisismerge needs this commit to bring level 0 to 16, so a level 0 below 15 there proves
    // this commit ran none. The highest level after every commit is kept too.
    let highest = 0, highestLevel0BeforeCommit = 0;
    for (let i = 0; i < 5000; i++) {
      const began = performance.now();
      let opStart = 0, opEnd = 0, committed = 0;
      transaction(() => {
        opStart = performance.now();
        highestLevel0BeforeCommit = Math.max(highestLevel0BeforeCommit, ftsLevels(db)[0]?.segments ?? 0);
        insertMessage(`t${i % 7}`, msg(`m${i}`, `steady insert ${i} delta echo foxtrot ${i * 17}`));
        afterCommit(() => { committed = performance.now(); });
        opEnd = performance.now();
      });
      ms.push(performance.now() - began);
      commit.push((opStart - began) + (committed - opEnd));
      highest = Math.max(highest, ...ftsLevels(db).map(level => level.segments));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const levels = ftsLevels(db);
    console.log(`[T7] commit floor ${JSON.stringify(spread(floor))} insert lock-wait+commit ${JSON.stringify(spread(commit))} over20=${commit.filter(x => x > 20).length} insert wall ${JSON.stringify(spread(ms))} highest level segments=${highest} level 0 before a commit at most=${highestLevel0BeforeCommit} levels=${JSON.stringify(levels.map(l => l.segments))}`);
    expect(highest).toBeLessThan(16);
    expect(highestLevel0BeforeCommit, "no foreground commit could cross the crisismerge threshold").toBeLessThan(15);
    expect(Math.max(...commit)).toBeLessThanOrEqual(20);
    // the worker stopped (no merge op posted): inserts until level 0 crosses 16 and crisismerge fires inside a COMMIT
    searchMergeTestHooks.halt = true;
    let crossing = -1, crossingMs = 0;
    for (let i = 0; i < 64 && crossing < 0; i++) {
      const before = ftsLevels(db)[0]?.segments ?? 0;
      const began = performance.now();
      insertMessage("crisis", msg(`c${i}`, `crisis insert ${i} golf hotel`));
      const took = performance.now() - began;
      const after = ftsLevels(db)[0]?.segments ?? 0;
      if (after < before) { crossing = i; crossingMs = took; }
    }
    console.log(`[T7] worker stopped: crisismerge COMMIT after ${crossing + 1} inserts took ${crossingMs.toFixed(2)} ms (reported, not budgeted)`);
    expect(crossing).toBeGreaterThanOrEqual(0);
  });
});

describe("T8 receipt: the leftover line shows while owed and clears after scrub-done", () => {
  it("unchanged receipt; the line shows while owed (through the prove) and is gone once scrub-done answered", async () => {
    const db = await ready();
    fillMixed("gone", "жжж", 6);
    await quiet();
    searchMergeTestHooks.halt = true;
    const deletions = new ConversationDeletions({ dataDir: DATA_DIR, database });
    try {
      const started = performance.now();
      const { report } = await runConversationDeletion(deletions, { threadIds: ["gone"] }, () => { deleteThread("gone"); return true; });
      const receiptMs = performance.now() - started;
      expect(report.leftovers.some(item => item.what === "Removed; finishing cleanup")).toBe(true);
      console.log(`[T8] receipt ms=${receiptMs.toFixed(1)} (no new wait)`);
      expect(receiptMs).toBeLessThan(5000);
      let owingAtProve: boolean | null = null;
      searchMergeTestHooks.onEvent = event => { events.push(event); if (event.kind === "prove" && event.reply?.settled) owingAtProve = searchMergeOwing(); };
      searchMergeTestHooks.halt = false; resumeSearchMerge();
      await untilPaid();
      expect(owingAtProve).toBe(true);
      expect(searchMergeOwing()).toBe(false);
      expect(markerRow(db)).toBeUndefined();
    } finally { deletions.dispose(); }
  });

  it("a deletion committed between the proof's COMMIT and the scrub-done reply keeps the line through the sequence and the next run finds done=0", async () => {
    const db = await ready();
    watchGroups = [];
    fillMixed("a", "жжж", 5);
    fillMixed("b", "ффф", 5, 8, 4, "keep2");
    await quiet();
    let stage = 0, scrubDoneSeen = false;
    const owingSeen: boolean[] = [];
    searchMergeTestHooks.onEvent = event => {
      events.push(event);
      if (stage === 0 && event.kind === "prove" && event.reply?.settled) { stage = 1; searchMergeTestHooks.halt = true; }
      if (stage === 2 && event.kind === "scrub-done") scrubDoneSeen = true;
      // the marker read that follows the first scrub-done: the mirror as that reply left it
      else if (stage === 2 && scrubDoneSeen && event.kind === "config" && !owingSeen.length) owingSeen.push(searchMergeOwing());
    };
    deleteThread("a");
    await vi.waitFor(() => expect(stage).toBe(1), { timeout: 10_000 });
    expect(markerRow(db)).toEqual({ done: 1 });
    deleteThread("b"); // between the proof and scrub-done
    expect(markerRow(db)).toEqual({ done: 0 });
    stage = 2;
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await vi.waitFor(() => expect(owingSeen.length).toBeGreaterThanOrEqual(1), { timeout: 20_000 });
    expect(owingSeen[0]).toBe(true); // the first scrub-done answered with an older epoch: the line stays
    await untilPaid();
    expect(events.filter(e => e.kind === "config" && e.reply?.marker === 0).length).toBeGreaterThanOrEqual(2);
    expect(rawBlocksWith(db, "ффф")).toBe(0);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
  });

  it("two deletions in two log generations with a worker restart between: the first scrub's late wait never completes the second", { timeout: 60_000 }, async () => {
    const db = await ready();
    fillMixed("a", "жжж", 5);
    fillMixed("b", "ффф", 5, 8, 4, "keep2");
    await quiet();
    // nothing proves an owed mark on its own in this test: the retry is far out, and the test settles the log itself at the end
    walMaintenanceTestHooks.retryMs = 600_000;
    const marks: WalSince[] = [];
    let doneAfterSecond = 0;
    searchMergeTestHooks.onEvent = event => {
      watch(event);
      if (event.kind === "scrub") marks.push(walMark(walFile()));
      if (event.kind === "scrub-done" && marks.length >= 2) doneAfterSecond++;
    };
    // deletion A: settled, its scrub waits on the log of generation A
    deleteThread("a");
    await vi.waitFor(() => expect(marks.length).toBe(1), { timeout: 10_000 });
    expect(markerRow(db)).toEqual({ done: 1 });
    // the log is emptied on the app's own connection (no waiter is woken): A's mark is now proven gone, but nobody has looked
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // deletion B writes generation B; the worker restarts, so the run for B starts while A's wait is still registered
    deleteThread("b");
    expect(walScrubbed(walFile(), marks[0]!)).toBe(true);
    walMaintenanceTestHooks.terminate();
    await vi.waitFor(() => expect(marks.length).toBe(2), { timeout: 20_000 });
    const markB = marks[1]!;
    expect(markB).not.toEqual(marks[0]);
    // registering B's wait proved A's mark and resolved A's waiter; A belongs to an earlier generation, so nothing completes
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(walScrubbed(walFile(), markB)).toBe(false);
    expect(doneAfterSecond).toBe(0);
    expect(markerRow(db)).toEqual({ done: 1 });
    expect(searchMergeOwing()).toBe(true);
    // the log of generation B is proven restarted: B's own wait completes the sequence
    expect(await scrubWalAfterDelete()).toBe(true);
    await untilPaid();
    expect(doneAfterSecond).toBe(1);
    expect(lies).toEqual([]);
    expect(rawBlocksWith(db, "жжж")).toBe(0);
    expect(rawBlocksWith(db, "ффф")).toBe(0);
  });
});
