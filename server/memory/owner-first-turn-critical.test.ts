// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 bgwork: the owner-first gate holds background work from a turn's admission to its engine send
// (owner-first.ts beginStart). What the starting turn itself depends on is not background: its own prompt's
// capture, published with the thread checkpoint it rolls inside the dispatch window
// (turn-refused-at-acceptance-api.test.ts, "prompt capture rolls the thread checkpoint"). With the real
// MemoryWorkerController and a stand-in child: the starting thread's capture is claimed, published and its
// checkpoint refreshed while the hold stands; another thread's capture, a routine start's hold and typing
// keep everything else back until the hold ends.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ownerFirst } from "../owner-first.ts";
import { resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { resetMemoryClaimCursor } from "./jobs.ts";
import type { MemoryWork } from "./worker-protocol.ts";

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals, sent: Array<Record<string, any>>, releases: Array<() => void>;

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); resetParkSweep(); resetMemoryClaimCursor(); resetWorkerLog();
  sent = []; releases = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => { sent.push(message); } };
  internals.ready = true;
});
afterEach(async () => { for (const release of releases.splice(0)) release(); await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });

const say = (threadId: string, id: string, text: string) => appendMessage(threadId, { id, at: Date.now(), role: "user", kind: "text", text });
const captures = () => sent.filter(message => message.stage === "capture") as MemoryWork[];
const threadOf = (work: MemoryWork) => String(database().prepare("SELECT s.thread_id AS t FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").get(work.id)?.t);
const statusOf = (threadId: string) => database().prepare("SELECT j.status FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? ORDER BY j.rowid DESC LIMIT 1").get(threadId)?.status;
const checkpoint = (threadId: string) => database().prepare("SELECT r.version FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.owner_key=? AND r.state='active'").get(threadId);
const resultFor = (work: MemoryWork) => ({ type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes, chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });
const start = (threadId?: string) => { const release = ownerFirst.beginStart(threadId); releases.push(release); return release; };

it("a starting turn's own prompt capture is claimed, published and rolls its checkpoint while the start holds background work", async () => {
  say("turn-thread", "p1", "The owner's prompt that this turn sends to its engine");
  const release = start("turn-thread");
  controller.start();
  await vi.advanceTimersByTimeAsync(200);
  expect(captures()).toHaveLength(1);
  expect(threadOf(captures()[0]!)).toBe("turn-thread");
  internals.onWorkerMessage(internals.child, resultFor(captures()[0]!));
  await vi.advanceTimersByTimeAsync(200);
  expect(statusOf("turn-thread")).toBe("complete");
  expect(checkpoint("turn-thread")).toBeDefined();
  release();
});

it("another thread's capture stays held while a turn starts, and goes once the start ends", async () => {
  say("other-thread", "o1", "Background evidence from a different conversation");
  const release = start("turn-thread");
  controller.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(captures()).toHaveLength(0);
  release();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(captures().map(threadOf)).toEqual(["other-thread"]);
});

it("with both pending, only the starting turn's capture is claimed during the start", async () => {
  say("other-thread", "o1", "Background evidence from a different conversation");
  say("turn-thread", "p1", "The owner's prompt that this turn sends to its engine");
  start("turn-thread");
  controller.start();
  await vi.advanceTimersByTimeAsync(200);
  expect(captures().map(threadOf)).toEqual(["turn-thread"]);
  internals.onWorkerMessage(internals.child, resultFor(captures()[0]!));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(captures().map(threadOf)).toEqual(["turn-thread"]);
  expect(statusOf("other-thread")).toBe("pending");
});

it("a routine start (no turn thread) and typing hold every capture; the starting turn's own still goes while the owner types", async () => {
  say("turn-thread", "p1", "The owner's prompt that this turn sends to its engine");
  const routine = start();
  ownerFirst.noteOwnerInteraction();
  controller.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(captures()).toHaveLength(0);
  routine();
  start("turn-thread");
  ownerFirst.noteOwnerInteraction();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(captures().map(threadOf)).toEqual(["turn-thread"]);
});

it("the 3 s turn hold does not hold the starting turn's own capture either", async () => {
  say("turn-thread", "p1", "The owner's prompt that this turn sends to its engine");
  releases.push(controller.holdForTurn());
  start("turn-thread");
  controller.start();
  await vi.advanceTimersByTimeAsync(200);
  expect(captures().map(threadOf)).toEqual(["turn-thread"]);
});
