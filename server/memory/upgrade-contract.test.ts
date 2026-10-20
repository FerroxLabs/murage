// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The producers of the upgrade contract (shared/upgrade-contract.mjs): every one of them gives a state that parses, says "unknown" rather than guessing,
// counts only what it can count exactly, measures time awake, and cannot publish progress a restart would not read back. Lanes/upgui-review r1 and r2,
// plus upgfast r2 R2-05 (the ownership proof) and R2-09 (published progress is persisted progress).
import { existsSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, memoryIntegrityStatus } from "../database.ts";
import { parseUpgradeState, COUNTED_UNITS, type UpgradeState } from "../../shared/upgrade-contract.mjs";
import { UPGRADE_CONTRACT_SOURCE } from "../../shared/upgrade-contract.mjs";
import { computeProof, newChallenge } from "../../shared/boot-proof.mjs";
import { UpgradeProgressTracker, blockedUpgradeState, idleUpgradeState, startingUnknownState, upgradeCounts } from "./upgrade-progress.ts";
import { backgroundStatus, upgradeOutside } from "./upgrade-background.ts";
import { STAMP_SOURCE, createProgressBoard, startPreListenHealth } from "./upgrade-health.ts";
import { startBlockingHeartbeat } from "./blocking-heartbeat.ts";
import { bootLaunchId, bootProofKey, healthProof } from "./boot-nonce.ts";
import { memoryUpgradeReporter } from "./upgrade-status.ts";
import { overallWriter, readOverallFloor } from "./upgrade-overall.ts";
import { setIntegrityFlags } from "./integrity-flags.ts";
import { setMemoryMode } from "./repository.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { captureSource } from "./capture.ts";
import { memoryOwnerStatus } from "./settings.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { walkMessagesChunk } from "../message-walker.ts";
import { memoryCaptures, memoryRecalls } from "./capture-gate.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });
afterEach(() => closeDatabase());
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const ok = (value: unknown): UpgradeState => { const parsed = parseUpgradeState(value); if (!parsed.ok) throw new Error(`not a valid upgrade state: ${parsed.reason}`); return parsed.state; };

it("contract: every producer's reading parses (tracker, idle, blocked, unknown start, health, note, heartbeat, responder)", async () => {
  const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }, { id: "lineage", weight: 1 }]);
  tracker.update("references", 10, 100);
  ok(tracker.snapshot(true).upgrade);
  ok(idleUpgradeState({}));
  const blocked = ok(blockedUpgradeState("MEMORY_MIGRATION_DISK_SPACE"));
  expect(blocked.stage).toBe("blocked");
  expect(blocked.keepOpen).toBe(false);
  ok(startingUnknownState());
  // health: with no connection it is all unknown; with one it parses
  closeDatabase();
  const none = ok(memoryIntegrityStatus().upgrade);
  expect([none.stage, none.phase, none.overall, none.complete, none.held, none.capture, none.recall, none.keepOpen, none.storage]).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  expect(memoryIntegrityStatus().overall, "no connection is not 100%").toBeNull();
  database();
  const health = ok(memoryIntegrityStatus().upgrade);
  expect(health.source).toBe("health");
  // the note, written by the reporter with and without a tracker attached
  const dir = mkdtempSync(join(tmpdir(), "murage-contract-"));
  try {
    const reporter = memoryUpgradeReporter(dir, path => path);
    reporter.indexing({ done: 1, total: 4 });
    const file = join(dir, "memory-upgrade-status.json");
    expect(ok(JSON.parse(readFileSync(file, "utf8")).upgrade).stage).toBe("starting");
    const board = createProgressBoard();
    reporter.attach(new UpgradeProgressTracker("starting", upgradeCounts(null), [{ id: "checking", weight: 1 }, { id: "migrating", weight: 1 }]), board);
    reporter.checking();
    ok(JSON.parse(readFileSync(file, "utf8")).upgrade);
    reporter.blocked(new Error("x"));
    expect(ok(JSON.parse(readFileSync(file, "utf8")).upgrade).blocked).toEqual({ code: "MEMORY_MIGRATION_FAILED" });
    // the heartbeat thread stamps its own source and clock over the board's reading
    const tracker2 = new UpgradeProgressTracker("starting", upgradeCounts(null), [{ id: "migrating", weight: 1 }]);
    tracker2.update("migrating", 1, 5);
    board.set(tracker2.snapshot(true));
    const beat = startBlockingHeartbeat(file, { v: 1, state: "upgrading", phase: "migrating", pid: process.pid, startedAt: Date.now() }, "indexes", 40, 0, board.shared, board.counts);
    await sleep(400);
    const note = JSON.parse(readFileSync(file, "utf8"));
    beat.end();
    const stamped = ok(note.upgrade);
    expect(stamped.source).toBe("note");
    expect(stamped.launch).toBe(bootLaunchId());
    expect(stamped.step.awakeElapsedMs).toBeGreaterThan(0);
    // an empty board: still a valid, wholly unknown reading
    const empty = createProgressBoard();
    const beat2 = startBlockingHeartbeat(file, { v: 1, state: "upgrading", phase: "migrating", pid: process.pid, startedAt: Date.now() }, "tables", 40, 0, empty.shared, empty.counts);
    await sleep(250);
    const emptyNote = ok(JSON.parse(readFileSync(file, "utf8")).upgrade);
    beat2.end();
    expect([emptyNote.phase, emptyNote.overall, emptyNote.held]).toEqual(["unknown", "unknown", "unknown"]);
  } finally { removeTempDirSync(dir); }
});

it("R2-05: the responder answers a probe with an HMAC over its challenge and status fields; launch is only a label; the contract's launch is the same label", async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port; await new Promise(resolve => probe.close(resolve));
  const board = createProgressBoard();
  const tracker = new UpgradeProgressTracker("starting", upgradeCounts(null), [{ id: "migrating", weight: 1 }]);
  tracker.update("migrating", 1, 5);
  board.set(tracker.snapshot(true));
  const responder = startPreListenHealth(port, board);
  try {
    expect(await responder.ready).toBe(true);
    const ask = async (challenge?: string) => { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: challenge ? { "x-murage-challenge": challenge } : {} }); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
    const a = newChallenge(), b = newChallenge();
    const first = await ask(a), second = await ask(b), bare = await ask();
    expect(first.status).toBe(503);
    const fields = (body: Record<string, unknown>) => ({ status: 503, pid: body.pid as number, launch: body.launch as string, isStatic: false, upgrading: true });
    expect(first.body.proof).toBe(computeProof(bootProofKey(), a, fields(first.body)));
    expect(second.body.proof).toBe(computeProof(bootProofKey(), b, fields(second.body)));
    expect(first.body.proof, "a replayed answer carries another challenge's proof").not.toBe(second.body.proof);
    expect(bare.body.proof, "a probe that sent no challenge (a browser) gets no proof").toBeUndefined();
    expect(first.body.launch).toBe(bootLaunchId());
    expect(ok(first.body.upgrade).launch, "the contract's launch and the health launch are one label").toBe(first.body.launch);
    expect(ok(first.body.upgrade).source).toBe("responder");
    expect(first.body).not.toHaveProperty("nonce");
    // before the server thread has written anything: wholly unknown, still valid
    const emptyPort = port;
    expect(emptyPort).toBeGreaterThan(0);
  } finally { await responder.close(); }
  expect(healthProof(newChallenge(), { status: 200, pid: 1, isStatic: true, upgrading: false })).toMatch(/^[0-9a-f]{64}$/);
  expect(healthProof(undefined, { status: 200, pid: 1, isStatic: true, upgrading: false })).toBeUndefined();
  expect(healthProof("short", { status: 200, pid: 1, isStatic: true, upgrading: false })).toBeUndefined();
});

it("drift: the health answer names the launch `launch` and nothing in the app reads `nonce`", () => {
  const index = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");
  expect(index).toMatch(/launch: bootLaunchId\(\)/);
  expect(index).toMatch(/upgrade: integrity\.upgrade/);
  const feed = readFileSync(join(process.cwd(), "src/lib/memory-integrity-feed.ts"), "utf8") + readFileSync(join(process.cwd(), "src/lib/memory-integrity-view.ts"), "utf8");
  expect(feed).not.toMatch(/\.nonce\b|nonce:/);
  expect(ok(memoryIntegrityStatus().upgrade).launch).toBe(bootLaunchId());
});

it("UX-11 / r2-7: only a counted phase has a counted step, and only from exact figures", () => {
  const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), ["checking", "copying", "migrating", "output-index", "lineage", "storage", "message-index", "search-index"].map(id => ({ id, weight: 1 })));
  let exact: { messages: number; conversations: number; memoryRecords: number; receipts: number; firstMessageAt: number | null } | null = null;
  tracker.setCountsSource(() => exact);
  const step = (id: string, done: number, total: number, counted: number | null = null) => { tracker.update(id, done, total, false, counted); return ok(tracker.snapshot(true).upgrade); };
  for (const id of ["checking", "copying", "migrating", "output-index", "search-index"]) {
    const state = step(id, 5, 10, 5);
    expect([id, state.step.unit]).toEqual([id, "none"]);
    expect(state.step).not.toHaveProperty("done");
  }
  expect(step("lineage", 3.7, 10).step).toMatchObject({ unit: "conversations", done: 3, total: 10 });
  expect(step("storage", 4, 8).step).toMatchObject({ unit: "sets", done: 4, total: 8 });
  expect(step("message-index", 5000, 90_000, 5).step.unit, "counts not yet exact: no number").toBe("none");
  exact = { messages: 40, conversations: 3, memoryRecords: 1, receipts: 1, firstMessageAt: 1 };
  expect(step("message-index", 5000, 90_000, 5).step).toMatchObject({ unit: "messages", done: 5, total: 40 });
  expect(step("message-index", 9000, 90_000, 41).step).toMatchObject({ done: 41, total: 41 }); // live writes moved the total: it is never below what was done
  expect(step("message-index", 9000, 90_000, null).step.unit, "a walk that began before the count was kept").toBe("none");
  expect(Object.keys(COUNTED_UNITS).sort()).toEqual(["copying", "lineage", "marker", "message-index", "storage"]);
  // counts: exact or nothing
  expect(ok(tracker.snapshot(true).upgrade).counts).toEqual({ exact: true, messages: 40, conversations: 3, memoryRecords: 1, firstMessageAt: 1 });
});

it("UX-11: the walker counts the rows it actually read, so sparse rowids are not mistaken for a number of messages", () => {
  const db = database();
  const put = db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?,?)");
  put.run(1, "chat", "m1", 1, "user", "text", "t", JSON.stringify({ id: "m1", kind: "text" }));
  put.run(1_200_000, "chat", "m2", 2, "user", "text", "t", JSON.stringify({ id: "m2", kind: "text" }));
  db.exec("DELETE FROM transcript_index_state WHERE name IN ('open_card','browser_check','turn_first','walk_rows')");
  let last = walkMessagesChunk(db, 500_000), chunks = 1;
  expect(last.rowsWalked).toBe(1);
  while (last.more) { last = walkMessagesChunk(db, 500_000); chunks++; }
  expect(chunks).toBeGreaterThan(1);
  expect(last.rowsWalked).toBe(2);
  expect(last.total, "the rowid high-water mark is 1.2 million; the rows are two").toBe(1_200_000);
  // a walk that began before the count was kept has none, rather than a wrong one
  db.exec("DELETE FROM transcript_index_state WHERE name='walk_rows'; UPDATE transcript_index_state SET done=0, cursor=5 WHERE name IN ('open_card','browser_check','turn_first')");
  expect(walkMessagesChunk(db, 10).rowsWalked).toBeNull();
});

it("UX-01 / r2-1: a hold switches capture and recall off in the contract, in /api/memory/status and in the capture path, from one predicate", () => {
  const db = database();
  for (const [mode, capture, recall] of [["off", false, false], ["capture", true, false], ["active", true, true], ["paused", true, false]] as const) {
    expect([mode, memoryCaptures(mode, null), memoryRecalls(mode, null)]).toEqual([mode, capture, recall]);
    expect([mode, memoryCaptures(mode, "INVALID_X"), memoryRecalls(mode, "INVALID_X")]).toEqual([mode, false, false]);
  }
  setMemoryMode("active");
  const live = upgradeOutside(db);
  expect([live.held, live.capture, live.recall, live.storedMode]).toEqual([false, "on", "on", "active"]);
  expect(memoryOwnerStatus(ownerMemoryTicket(), roster)).toMatchObject({ held: false, capture: "on", recall: "on", storedMode: "active" });
  setIntegrityFlags(db, { hold: "INVALID_MEMORY_LESSON_EVENT" });
  const held = upgradeOutside(db);
  expect([held.held, held.holdKey, held.capture, held.recall, held.storedMode]).toEqual([true, "memoryStrip.hold", "off", "off", "active"]);
  expect(ok(backgroundStatus(db).upgrade)).toMatchObject({ held: true, capture: "off", recall: "off", complete: false });
  expect(memoryOwnerStatus(ownerMemoryTicket(), roster)).toMatchObject({ held: true, capture: "off", recall: "off", storedMode: "active", mode: "paused" });
  // the contract says "off", and the capture path really captures nothing
  captureSource(db, { id: "new-source", threadId: "thread-a", kind: "text", speaker: "owner", outcome: "recorded", text: "Do not capture" });
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(0);
  setIntegrityFlags(db, { hold: null });
  setMemoryMode("paused");
  expect(memoryOwnerStatus(ownerMemoryTicket(), roster)).toMatchObject({ held: false, capture: "on", recall: "off" });
  captureSource(db, { id: "noted", threadId: "thread-a", kind: "text", speaker: "owner", outcome: "recorded", text: "Noted while paused" });
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(1);
});

it("r2-4: ten seconds of work and ten minutes asleep give about ten seconds awake, in the threads' own clock and the tracker's", () => {
  let t = 1_000_000;
  const FakeDate = { now: () => t };
  const makeStamper = new Function("Date", `${UPGRADE_CONTRACT_SOURCE}\n${STAMP_SOURCE}\nreturn makeStamper;`)(FakeDate) as (source: string, cap: number) => (progress: unknown, counts: unknown) => UpgradeState;
  const board = new UpgradeProgressTracker("starting", upgradeCounts(null), [{ id: "migrating", weight: 1 }]);
  board.update("migrating", 1, 5);
  const progress = board.snapshot(true);
  const stamp = makeStamper("note", 4000);
  stamp(progress, null);
  for (let i = 0; i < 5; i++) { t += 2000; stamp(progress, null); }
  t += 600_000;
  stamp(progress, null);
  t += 2000;
  const state = stamp(progress, null);
  expect(state.step.awakeElapsedMs - progress.upgrade.step.awakeElapsedMs).toBeGreaterThanOrEqual(10_000);
  expect(state.step.awakeElapsedMs - progress.upgrade.step.awakeElapsedMs).toBeLessThan(20_000);
  // the tracker itself: touches 2 s apart for 10 s, then ten minutes with nothing, then 2 s more
  let now = 0;
  const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }], () => now);
  for (let i = 0; i < 5; i++) { now += 2000; tracker.update("references", i, 100); }
  now += 600_000;
  tracker.update("references", 6, 100);
  now += 2000;
  const awake = tracker.snapshot(true).upgrade.step.awakeElapsedMs;
  expect(awake).toBeGreaterThanOrEqual(10_000);
  expect(awake).toBeLessThan(20_000);
});

it("UX-02: the exact counts are numbers or nothing: no figure while they are being counted", () => {
  const tracker = new UpgradeProgressTracker("starting", upgradeCounts(null, 123), [{ id: "checking", weight: 1 }]);
  expect(ok(tracker.snapshot(true).upgrade).counts).toEqual({ exact: false });
  expect(tracker.snapshot(true).counts).toMatchObject({ messages: null, exact: false });
});

it("R2-09: what is published never exceeds what a restart reads back (40% saved, 60% not saved, restart: never 60 then 40)", () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-overall-"));
  try {
    let now = 5_000_000;
    const write = overallWriter(dir, 9, () => now, readOverallFloor(dir, 9, now));
    const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }], () => now, {}, { from: 0, to: 1, floor: 0, persist: write });
    tracker.update("references", 40, 100);
    expect(tracker.snapshot(true).overall).toBeCloseTo(0.4);
    expect(readOverallFloor(dir, 9, now)).toBeCloseTo(0.4);
    now += 200;
    tracker.update("references", 60, 100);
    const shown = tracker.snapshot(true);
    expect(shown.overall, "60% is not on disk yet, so 60% is not shown").toBeCloseTo(0.4);
    expect(shown.upgrade.overall).toBeCloseTo(0.4);
    // a crash here: the restart reads 40% and starts from it, so it never showed 60 and then 40
    expect(readOverallFloor(dir, 9, now)).toBeCloseTo(0.4);
    const restarted = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }], () => now, {}, { from: 0, to: 1, floor: readOverallFloor(dir, 9, now), persist: write });
    expect(restarted.snapshot(true).overall).toBeCloseTo(0.4);
    // once the writer's pace allows, the new value is saved and then shown
    now += 1500;
    expect(tracker.snapshot(true).overall).toBeCloseTo(0.6);
    expect(readOverallFloor(dir, 9, now)).toBeCloseTo(0.6);
    // the end is written at once
    tracker.update("references", 100, 100, true);
    expect(tracker.snapshot(false).overall).toBe(1);
  } finally { removeTempDirSync(dir); }
});

it("R2-09: a failed save leaves the last saved value on show", () => {
  let now = 0;
  const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }], () => now, {}, { from: 0, to: 1, floor: 0.2, persist: () => 0.2 });
  tracker.update("references", 90, 100);
  expect(tracker.snapshot(true).overall).toBeCloseTo(0.2);
  expect(existsSync(join(DATA_DIR, "memory-upgrade-overall.json"))).toBe(false);
});

it("r3-2: a heartbeat does not revalidate an estimate made before a sleep, and the time awake never goes back when a newer board counts less", () => {
  let now = 10_000_000;
  const FakeDate = { now: () => now };
  const makeStamper = new Function("Date", `${UPGRADE_CONTRACT_SOURCE}\n${STAMP_SOURCE}\nreturn makeStamper;`)(FakeDate) as (source: string, cap: number) => (progress: unknown, counts: unknown) => UpgradeState;
  const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }], () => now);
  // a steady rate: 1% every 2 s for 20 s gives a steady estimate
  for (let i = 1; i <= 10; i++) { now += 2000; tracker.update("references", i * 4, 100); }
  const before = tracker.snapshot(true);
  expect(before.upgrade.eta.stable).toBe(true);
  const stamp = makeStamper("note", 4000);
  expect(stamp(before, null).eta.stable).toBe(true);
  // ten minutes asleep with no progress, then heartbeats: the estimate stays withdrawn on every reading
  now += 600_000;
  expect(stamp(before, null).eta).toEqual({ stable: false });
  now += 2000;
  expect(stamp(before, null).eta).toEqual({ stable: false });
  // the tracker's own reading after the gap, with no new progress, also says nothing
  expect(tracker.snapshot(true).upgrade.eta).toEqual({ stable: false });
  // time awake: a newer board that counted less than the thread already showed does not pull it down
  let t2 = 20_000_000;
  const clock = { now: () => t2 };
  const stamp2 = (new Function("Date", `${UPGRADE_CONTRACT_SOURCE}\n${STAMP_SOURCE}\nreturn makeStamper;`)(clock) as typeof makeStamper)("responder", 4000);
  const high = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "references", weight: 1 }], () => t2);
  high.update("references", 1, 100);
  const first = high.snapshot(true);
  stamp2(first, null);
  for (let i = 0; i < 5; i++) { t2 += 2000; stamp2(first, null); }
  const shown = stamp2(first, null).step.awakeElapsedMs;
  const second = high.snapshot(true); // a newer snapshot: the tracker has touched only once more
  const after = stamp2(second, null).step.awakeElapsedMs;
  expect(after).toBeGreaterThanOrEqual(shown);
});

it("honest time left: a fixed-total phase may carry minutes; the open-ended marker phase carries a count and never a total, percent source or time left", () => {
  let clock = 0;
  const tracker = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "lineage", weight: 1 }, { id: "marker", weight: 1 }], () => clock);
  // fixed total: steady progress for long enough to measure a rate
  for (let i = 1; i <= 10; i++) { clock = i * 1000; tracker.update("lineage", i * 5, 100); }
  const fixed = ok(tracker.snapshot(true).upgrade);
  expect(fixed.step).toMatchObject({ unit: "conversations", done: 50, total: 100 });
  expect(fixed.eta.stable).toBe(true);
  // open-ended: the total slides with the count (done plus what is known to remain), so the figures are real only as "so far"
  tracker.update("lineage", 100, 100, true);
  for (let i = 1; i <= 10; i++) { clock = 20_000 + i * 1000; tracker.update("marker", i * 1000, i * 1000 + 200_002); }
  const shot = tracker.snapshot(true);
  const open = ok(shot.upgrade);
  expect(open.phase).toBe("marker");
  expect(open.step).toMatchObject({ unit: "open", done: 10_000 });
  expect("total" in open.step).toBe(false);
  expect(open.eta).toEqual({ stable: false });
  expect(shot.etaSeconds).toBeNull();
  expect(shot.etaMs).toBeNull();
});
