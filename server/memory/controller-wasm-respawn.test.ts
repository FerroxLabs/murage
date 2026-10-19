// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A helper on ONNX Runtime WebAssembly leaves when it has been idle (worker.ts) and the controller starts a new one on demand. Whatever
// arrives while the helper is leaving (a search, a record to work on) waits for the next helper and succeeds; a turn's start warms the
// next helper so its model is loaded before recall asks; a helper that never leaves (native) changes nothing.
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
type Sent = { type?: string; requestId?: string };
class Helper extends EventEmitter {
  sent: Sent[] = [];
  /** How long after "idle-exit" the process is gone (a real process takes a moment to end). */
  exitAfterMs = 50;
  /** Whether this helper runs the model on WebAssembly (a native helper never idle-exits and ignores "warm"). */
  wasm = true;
  send = vi.fn((message: Sent) => {
    this.sent.push(message);
    if (message.type === "init") setTimeout(() => this.emit("message", { type: "initialised", wasm: this.wasm }), 0);
    if (message.type === "warm") setTimeout(() => this.emit("message", { type: "model-ready" }), 0);
    if (message.type === "query") setTimeout(() => this.emit("message", { type: "query-result", requestId: message.requestId, result: { hits: [], vectorRows: 0, unvectored: [] } }), 0);
    if (message.type === "idle-exit") setTimeout(() => this.emit("exit", 0), this.exitAfterMs);
    return true;
  });
  kill = vi.fn(() => { this.emit("exit", 0); return true; });
  disconnect() { this.emit("exit", 0); }
}
let helpers: Helper[];
let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  setMemoryMode("capture");
  helpers = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  controller = new MemoryWorkerController();
});
afterEach(async () => { await controller.stop(); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const input = { query: "car fuel", scopeIds: ["s"], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: true } as const;
const search = () => controller.search(input as never, new AbortController().signal);
const settle = (ms = 20) => vi.advanceTimersByTimeAsync(ms);
const enqueue = (id: string) => captureSource(database(), { id, threadId: "thread", kind: "text", speaker: "owner", outcome: "recorded", text: "A notebook remembers the owner's context" });
/** A search starts the first helper; the helper then asks to leave and is given leave. Returns once leave is given, before the process ends. */
async function leaving() {
  controller.start();
  const first = search();
  await settle();
  await first;
  const old = helpers[0];
  old.emit("message", { type: "idle-exit-request" });
  expect(old.sent.some(m => m.type === "idle-exit")).toBe(true);
  return old;
}

it("a search that arrives while the helper is leaving waits for the next helper and succeeds", async () => {
  const old = await leaving();
  const late = search();                                   // the process has not ended yet
  expect(helpers).toHaveLength(1);
  await settle(200);                                       // it ends; the controller starts the next helper, which answers
  expect(helpers).toHaveLength(2);
  await expect(late).resolves.toMatchObject({ vectorRows: 0 });
  expect(old.sent.filter(m => m.type === "query")).toHaveLength(1);   // the first search only
  expect(helpers[1].sent.filter(m => m.type === "query")).toHaveLength(1);
});

it("a record that arrives while the helper is leaving is worked by the next helper, not after the 30 s sweep", async () => {
  const old = await leaving();
  enqueue("late");                                         // wakes the worker; the tick finds no ready helper and does nothing
  await settle(5);
  expect(helpers).toHaveLength(1);
  await settle(300);                                       // far inside the 30 s sweep
  expect(helpers).toHaveLength(2);
  expect(helpers[1].sent.some(m => m.type === "init")).toBe(true);
  expect(helpers[1].sent.some(m => m.type !== "init")).toBe(true);
  expect(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='leased'").get()!.n).toBe(1);
  expect(old.sent.some(m => m.type === "work")).toBe(false);
});

it("leave is refused while a search is owed", async () => {
  controller.start();
  const first = search();
  await settle();
  await first;
  const helper = helpers[0];
  helper.send.mockImplementation((message: Sent) => { helper.sent.push(message); return true; });   // this helper never answers
  const pending = search();
  pending.catch(() => {});
  await settle();
  helper.emit("message", { type: "idle-exit-request" });
  expect(helper.sent.some(m => m.type === "idle-exit")).toBe(false);
});

it("a turn that starts after the helper left warms the next helper at once; a second turn does not start another", async () => {
  const old = await leaving();
  await settle(200);
  expect(helpers).toHaveLength(1);
  expect(old.sent.some(m => m.type === "idle-exit")).toBe(true);
  const release = controller.holdForTurn();
  expect(helpers).toHaveLength(2);                         // started by the turn, before recall asks
  const release2 = controller.holdForTurn();
  expect(helpers).toHaveLength(2);
  await settle(20);
  const answered = search();                                // the helper is already loaded: the query goes out at once, not after a start
  expect(helpers[1].sent.filter(m => m.type === "query")).toHaveLength(1);
  await settle(5);
  await expect(answered).resolves.toMatchObject({ vectorRows: 0 });
  release(); release2();
});

it("a helper that never left (native, or not yet idle) is not started again by a turn", async () => {
  controller.start();
  const first = search();
  await settle();
  await first;
  const release = controller.holdForTurn();
  expect(helpers).toHaveLength(1);
  release();
});

it("a turn that starts after the helper left asks the next helper to load and warm its model, and the controller learns when it is ready", async () => {
  await leaving();
  await settle(200);
  expect(controller.modelWarm).toBe(false);
  const release = controller.holdForTurn();
  await settle(20);
  expect(helpers[1].sent.filter(m => m.type === "warm")).toHaveLength(1);
  expect(controller.modelWarm).toBe(true);
  controller.warmForIntent();                              // already warm: nothing more is sent
  expect(helpers[1].sent.filter(m => m.type === "warm")).toHaveLength(1);
  release();
});

it("the owner's first key or window focus warms a live WebAssembly helper whose model is not loaded; a native helper is never asked", async () => {
  controller.start();
  const first = search();
  await settle();
  await first;
  controller.warmForIntent();
  expect(helpers[0].sent.filter(m => m.type === "warm")).toHaveLength(1);
  await settle(5);
  expect(controller.modelWarm).toBe(true);
  await controller.stop();
  helpers = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helper.wasm = false; helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  controller = new MemoryWorkerController();
  controller.start();
  const second = search();
  await settle();
  await second;
  controller.warmForIntent();
  expect(helpers[0].sent.some(m => m.type === "warm")).toBe(false);
});

it("a search that arrives before the model is warm is sent at once (the helper answers from words past the cutoff); it does not wait for the warm-up", async () => {
  await leaving();
  await settle(200);
  const release = controller.holdForTurn();
  helpers[1].send.mockImplementation((message: Sent) => { helpers[1].sent.push(message); if (message.type === "init") setTimeout(() => helpers[1].emit("message", { type: "initialised", wasm: true }), 0); if (message.type === "query") setTimeout(() => helpers[1].emit("message", { type: "query-result", requestId: message.requestId, result: { hits: [], vectorRows: 0, unvectored: [] } }), 0); return true; });   // never says model-ready
  await settle(5);
  const early = search();
  await settle(5);
  await expect(early).resolves.toMatchObject({ vectorRows: 0 });
  expect(controller.modelWarm).toBe(false);
  release();
});
