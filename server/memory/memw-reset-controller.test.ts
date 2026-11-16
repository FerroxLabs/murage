// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW r3.2.8 / 8b / 8c / 8d, the controller's side of a reset that runs only at a helper start (WP3, worker-controller.ts):
// - init carries R from the durable 'requested' row; only that start's `initialised` with resetDone = R and no stop completes R;
// - completeIndexReset: ONE transaction, "done" only from 'requested' with reset_id = R, "none" for every other row;
// - after "done": unlink the marker, then fsync the directory, then unblock the readers; an unlink failure is a planned reset-exit with the
//   helper never ready (S-FAILRESET unlink, mW); a directory fsync failure after the unlink is done (mX);
// - a start that carried R and did not finish it is a failed start, readers stay blocked;
// - a helper whose start did not carry R gets reset-exit only after the reader drain answers "drained"; "stuck" logs
//   MEMORY_INDEX_READER_STUCK, sends nothing and retries no sooner than 60 s;
// - a planned exit rejects the queries already sent to that helper with MEMORY_WORKER_EXITED (mY) and keeps the unsent ones;
// - the tick re-checks the helper after settleOverrun before any send (D5).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { OVERRUN_K_UNKNOWN } from "./memw-steps.ts";
import { blockMemoryIndexReader, memoryIndexReaderState, ownerIndexHandle, unblockMemoryIndexReader } from "./index-reader.ts";
import {
  completeIndexReset, indexResetDue, indexResetPending, indexResetRequested, MemoryWorkerController, noteIndexStop, RESET_DRAIN_RETRY_MS, resetCompletionIo,
} from "./worker-controller.ts";

type FakeChild = import("node:events").EventEmitter & { sent: Array<Record<string, unknown>>; killed: string[]; connected: boolean; stderr: null; send(m: Record<string, unknown>): boolean; kill(signal?: string): boolean };
const h = vi.hoisted(() => ({ children: [] as unknown[], drain: null as null | ((cap: number) => Promise<"drained" | "stuck">), drains: 0, logs: [] as string[] }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const fork = () => {
    const child = Object.assign(new EventEmitter(), { sent: [] as Array<Record<string, unknown>>, killed: [] as string[], connected: true, stderr: null,
      send(m: Record<string, unknown>) { child.sent.push(m); return true; }, kill(signal?: string) { child.killed.push(String(signal)); return true; } });
    h.children.push(child);
    return child;
  };
  return { ...real, fork, default: { ...real, fork } };
});
vi.mock("./index-reader.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./index-reader.ts")>();
  return { ...real, drainMemoryIndexReaders: (cap: number) => { h.drains++; return h.drain ? h.drain(cap) : real.drainMemoryIndexReaders(cap); } };
});
// WP1 exports removeStopMarker (r3.2.8 3.3 step 2); until WP1 is merged under this branch, its exact body stands in here.
vi.mock("./index-quarantine.ts", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  if (typeof real.removeStopMarker === "function") return real;
  const { closeSync, fsyncSync, openSync, unlinkSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const syncDirectory = (dir: string) => { if (process.platform === "win32") return; const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const removeStopMarker = (indexPath: string, io: { unlink?: (file: string) => void; fsyncDir?: (dir: string) => void } = {}) => {
    try { (io.unlink ?? unlinkSync)(`${indexPath}-walstop`); } catch (error) { if ((error as { code?: unknown })?.code !== "ENOENT") throw error; }
    (io.fsyncDir ?? syncDirectory)(dirname(indexPath));
  };
  return { ...real, removeStopMarker };
});
vi.mock("./worker-log.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./worker-log.ts")>();
  return { ...real, logSwallowed: (...args: Parameters<typeof real.logSwallowed>) => { h.logs.push(String(args[1] instanceof Error ? args[1].message : args[1])); return real.logSwallowed(...args); } };
});

type Internals = {
  child: FakeChild | null; ready: boolean; idleExit: unknown; resetDoneSeen: number | null; startReset: { child: unknown; resetId: number } | null; resetDrainRetryAt: number;
  spawn(): void; tick(requested?: boolean): void; onWorkerMessage(child: unknown, message: unknown): void; plannedResetExit(child: unknown): void;
};
const THREAD = "7f00a32e-17a4-426b-bdc6-910220ba66c9";
const roster = { bots: [{ id: "bot", threadId: THREAD }], groups: [] };
const MARKER = () => join(DATA_DIR, "memory-index.db-walstop");
let controller: MemoryWorkerController, internals: Internals;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("capture");
  h.children.length = 0; h.drain = null; h.drains = 0; h.logs.length = 0;
  delete resetCompletionIo.unlink; delete resetCompletionIo.fsyncDir;
  controller = new MemoryWorkerController({ startHoldMs: 0, manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } as never, modelDirectory: "/unused/model" });
  internals = controller as unknown as Internals;
});
afterEach(async () => { delete resetCompletionIo.unlink; delete resetCompletionIo.fsyncDir; await controller.stop().catch(() => {}); vi.useRealTimers(); unblockMemoryIndexReader(); closeDatabase(); });

/** One capture: a record with a pending projection receipt (so a tick would form an index batch). */
function pendingRecord() {
  const messageId = randomUUID();
  storeAnchorMessage(database(), THREAD, messageId, "the harbour gate code", "user");
  captureSource(database(), { id: `message:${THREAD}:${randomUUID()}`, threadId: THREAD, messageId, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: "the harbour gate code" });
  const work = claimMemoryJob("reset-fixture")!;
  publishMemoryWork(work, "reset-fixture", captureWork(work));
}
/** An open episode, due at once (no row: OVERRUN_K_UNKNOWN, due now) and made 'requested'; the marker present. */
function requestReset(): number {
  noteIndexStop({ fileId: "f1", seq: 0, kind: "stop" } as never);
  const due = indexResetDue()!;
  writeFileSync(MARKER(), JSON.stringify({ fileId: "f1", seq: 0, kind: "stop" }));
  return due.resetId;
}
const readerBlocked = () => { ownerIndexHandle(); return memoryIndexReaderState() === "blocked"; };
/** A helper started by the controller (fork is the fake), answered `ready` (init sent). */
function startHelper(): FakeChild {
  internals.spawn();
  const child = h.children.at(-1) as FakeChild;
  internals.onWorkerMessage(child, { type: "ready" });
  return child;
}
const types = (child: FakeChild) => child.sent.map(m => m.type);

it("r3.2.8 3.1.4 + 8b rule 1: init carries R from the 'requested' row; initialised(resetDone = R, no stop) completes it: marker gone, readers unblocked, ready", () => {
  const R = requestReset();
  const child = startHelper();
  const init = child.sent.find(m => m.type === "init")!;
  expect(init.reset).toEqual({ resetId: R, resets: expect.any(Number), kind: "stop" });
  expect(readerBlocked()).toBe(true);
  internals.onWorkerMessage(child, { type: "initialised", resetDone: R, walOverStop: null });
  expect(h.logs).toEqual([]);
  expect(indexResetPending()).toBe(false);
  expect(existsSync(MARKER())).toBe(false);
  expect(internals.ready).toBe(true);
  expect(types(child)).not.toContain("reset-exit");
  expect(readerBlocked()).toBe(false);
});

it("8b rule 1: completeIndexReset is \"done\" only from 'requested' with reset_id = R; a duplicate, another R, or 'waiting' is \"none\"", () => {
  noteIndexStop({ fileId: "f1", seq: 0, kind: "stop" } as never);
  const waiting = database().prepare("SELECT reset_id AS r FROM index_overrun WHERE id=1").get() as { r: number };
  database().prepare("UPDATE index_overrun SET state='waiting' WHERE id=1").run();
  expect(completeIndexReset(Number(waiting.r))).toBe("none");
  const R = indexResetDue(Number.MAX_SAFE_INTEGER)!.resetId;
  expect(completeIndexReset(R + 1)).toBe("none");
  expect(completeIndexReset(R)).toBe("done");
  expect(completeIndexReset(R)).toBe("none");
  expect(indexResetRequested()).toBeNull();
});

it("S-FAILRESET unlink (r3.2.8c M1, mW): the unlink fails after \"done\": UNLINK_FAILED, reset-exit, the helper never ready, no batch or job reaches it, readers stay blocked", () => {
  pendingRecord();
  const R = requestReset();
  const child = startHelper();
  resetCompletionIo.unlink = () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); };
  internals.onWorkerMessage(child, { type: "initialised", resetDone: R, walOverStop: null });
  expect(indexResetPending()).toBe(false); // "done" committed
  expect(existsSync(MARKER())).toBe(true);
  expect(h.logs).toContain("MEMORY_INDEX_RESET_UNLINK_FAILED");
  expect(types(child)).toContain("reset-exit");
  expect(internals.ready).toBe(false);
  expect(internals.idleExit).toBe(child);
  internals.tick(true);
  expect(types(child).filter(type => type === "index")).toEqual([]);
  expect(child.sent.filter(m => typeof m.jobId === "string" || m.type === "capture")).toEqual([]);
  expect(readerBlocked()).toBe(true);
});

it("mX: a directory fsync failure after the unlink IS done: no reset-exit, ready, readers unblocked, marker gone", () => {
  const R = requestReset();
  const child = startHelper();
  resetCompletionIo.fsyncDir = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
  internals.onWorkerMessage(child, { type: "initialised", resetDone: R, walOverStop: null });
  expect(existsSync(MARKER())).toBe(false);
  expect(types(child)).not.toContain("reset-exit");
  expect(internals.ready).toBe(true);
  expect(readerBlocked()).toBe(false);
});

it("r3.2.8 3.1.6: a start that carried R and answered without resetDone = R (or with a stop) is a failed start: killed, row still 'requested', readers blocked", () => {
  const R = requestReset();
  for (const answer of [{ resetDone: null, walOverStop: null }, { resetDone: R, walOverStop: { fileId: "f2", seq: 1, kind: "stop" } }]) {
    const child = startHelper();
    internals.onWorkerMessage(child, { type: "initialised", ...answer });
    expect(child.killed).toContain("SIGKILL");
    expect(internals.ready).toBe(false);
    expect(indexResetRequested()?.resetId).toBe(R);
    expect(existsSync(MARKER())).toBe(true);
    expect(readerBlocked()).toBe(true);
    child.emit("exit", null, "SIGKILL");
    (internals as unknown as { respawnAt: number }).respawnAt = 0;
  }
});

it("r3.2.8c M3 (mY): a planned exit rejects the query already sent to that helper with MEMORY_WORKER_EXITED at once and keeps an unsent one for the next helper", async () => {
  const child = startHelper();
  internals.onWorkerMessage(child, { type: "initialised", walOverStop: null });
  expect(internals.ready).toBe(true);
  const sent = controller.search({ query: "harbour", scopeIds: ["s"] } as never, new AbortController().signal);
  expect(types(child)).toContain("query");
  internals.plannedResetExit(child);
  const unsent = controller.search({ query: "gate", scopeIds: ["s"] } as never, new AbortController().signal);
  child.emit("exit", 0, null);
  const outcome = await Promise.race([sent.then(() => "answered", (error: Error) => error.message), new Promise(resolve => setTimeout(() => resolve("still waiting"), 200))]);
  expect(outcome).toBe("MEMORY_WORKER_EXITED");
  // the unsent query waits for the respawned helper and is sent at its initialised
  const next = h.children.at(-1) as FakeChild;
  expect(next).not.toBe(child);
  internals.onWorkerMessage(next, { type: "ready" });
  internals.onWorkerMessage(next, { type: "initialised", walOverStop: null });
  expect(types(next)).toContain("query");
  void unsent.catch(() => {});
});

it("r3.2.8 point 4: a helper whose start did not carry R gets reset-exit only after the drain answers \"drained\"; \"stuck\" logs READER_STUCK, sends nothing, retries no sooner than 60 s", async () => {
  const child = startHelper();
  internals.onWorkerMessage(child, { type: "initialised", walOverStop: null });
  requestReset();
  let answer: ((verdict: "drained" | "stuck") => void) | null = null;
  h.drain = () => new Promise(resolve => { answer = resolve; });
  internals.tick(true);
  expect(h.drains).toBe(1);
  expect(types(child)).not.toContain("reset-exit");
  answer!("stuck");
  await new Promise(resolve => setImmediate(resolve));
  expect(h.logs).toContain("MEMORY_INDEX_READER_STUCK");
  expect(types(child)).not.toContain("reset-exit");
  expect(internals.resetDrainRetryAt).toBeGreaterThanOrEqual(Date.now() + RESET_DRAIN_RETRY_MS - 1_000);
  // the next settle (what every tick runs first) inside the retry window starts no drain; past it, one
  const settle = () => (internals as unknown as { settleOverrun(child: unknown): boolean }).settleOverrun(child);
  settle();
  expect(h.drains).toBe(1); // not before the retry time
  internals.resetDrainRetryAt = 0;
  h.drain = () => Promise.resolve("drained");
  settle();
  await new Promise(resolve => setImmediate(resolve));
  expect(h.drains).toBe(2);
  expect(types(child)).toContain("reset-exit");
  expect(internals.idleExit).toBe(child);
  expect(internals.ready).toBe(false);
});

it("r3.2.8d D5: the tick re-checks the helper after settleOverrun: a receipt retried on the tick whose unlink fails sends reset-exit and no batch", () => {
  pendingRecord();
  const R = requestReset();
  const child = startHelper();
  // the initialised transaction was busy: the receipt is retried by the tick (resetDoneSeen kept), with the helper already ready
  internals.ready = true; internals.resetDoneSeen = R;
  blockMemoryIndexReader();
  // a claimable capture job too: batches are held by the reset, so only the re-check keeps the job off the exiting helper
  const messageId = randomUUID();
  storeAnchorMessage(database(), THREAD, messageId, "the second note", "user");
  captureSource(database(), { id: `message:${THREAD}:${randomUUID()}`, threadId: THREAD, messageId, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: "the second note" });
  resetCompletionIo.unlink = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
  const before = child.sent.length;
  internals.tick(true);
  expect(types(child).slice(before)).toEqual(["reset-exit"]);
  expect(internals.ready).toBe(false);
});

// Replaces controller-memw.test.ts "a stop reported by the helper sends one reset at once" (superseded: r3.2.8 deleted the controller's `reset`
// message; the reset rides in `init`). Design: handoffs/designs/MEMW-STAGED-BULK-r3.2.8-PARTA.md section 3.1 step 2 (line 48: a running helper
// whose init did not carry R gets reset-exit after the reader drain; the drain is capped at RESET_DRAIN_MAX_MS = 10 s, section 4, and answers at
// once when no scan is open) and step 4 (line 50: every spawn reads the row; while 'requested' the init carries reset {resetId, resets, kind}).
// The old row's bound ("at once") holds: no scan is open here, so reset-exit is out within 1 s, well inside the 10 s cap.
it("r3.2.8 3.1.2 + 3.1.4: a stop reported by a running helper (start without R) gets ONE reset-exit and no `reset` message; the NEXT init carries the reset exactly once (unknown history: resets = OVERRUN_K_UNKNOWN, kind fill); once completed no later init carries it", async () => {
  const child = startHelper();
  expect(child.sent.find(m => m.type === "init")!.reset).toBeUndefined();
  internals.onWorkerMessage(child, { type: "initialised", walOverStop: null });
  writeFileSync(MARKER(), JSON.stringify({ fileId: "a1", seq: 7, kind: "fill" }));
  internals.onWorkerMessage(child, { type: "index-stop", stop: { fileId: "a1", seq: 7, kind: "fill", reason: "live_breach" } });
  await vi.waitFor(() => expect(types(child)).toContain("reset-exit"), { timeout: 1_000 });
  expect(types(child).filter(type => type === "reset-exit")).toHaveLength(1);
  expect(types(child)).not.toContain("reset");
  const R = indexResetRequested()!.resetId;
  child.emit("exit", 0, null);
  const next = startHelper();
  expect(next).not.toBe(child);
  const inits = h.children.flatMap(c => (c as FakeChild).sent.filter(m => m.type === "init"));
  expect(inits.filter(m => m.reset !== undefined)).toHaveLength(1);
  expect(next.sent.find(m => m.type === "init")!.reset).toMatchObject({ resetId: R, resets: OVERRUN_K_UNKNOWN, kind: "fill" });
  internals.onWorkerMessage(next, { type: "initialised", reset: true, resetDone: R, walOverStop: null });
  expect(indexResetRequested()).toBeNull();
  next.emit("exit", 1, null);
  (internals as unknown as { respawnAt: number }).respawnAt = 0;
  const last = startHelper();
  expect(last.sent.find(m => m.type === "init")!.reset).toBeUndefined();
});
