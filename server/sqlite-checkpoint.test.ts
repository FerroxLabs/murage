// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeTempDirSync } from "./testing/cleanup.ts";
const state = vi.hoisted(() => ({ fail: false, workers: [] as Array<{ emit(event: string, ...args: unknown[]): boolean }> }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    postMessage() {}
    constructor() { super(); if (state.fail) throw new Error("worker unavailable"); state.workers.push(this); }
  } };
});
beforeEach(() => { vi.resetModules(); state.fail = false; state.workers.length = 0; });

it("W-FILE-EXIT: success messages never release a file worker before its actual exit, and shutdown refuses new folds", async () => {
  const { checkpointFile, stopFileCheckpoints } = await import("./sqlite-checkpoint.ts");
  let done = false, stopped = false;
  const fold = checkpointFile("receipts.db").then(result => { done = true; return result; });
  state.workers[0].emit("message", true);
  const stop = stopFileCheckpoints().then(result => { stopped = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  expect(done).toBe(false); expect(stopped).toBe(false);
  expect(await checkpointFile("receipts.db")).toBe(false);
  expect(state.workers).toHaveLength(1);
  state.workers[0].emit("exit", 0);
  expect(await fold).toBe(true); expect(await stop).toBe(true);
});

it.each(["start", "error", "exit"])("a file checkpoint failing at %s leaves the privacy fold owed", async failure => {
  const { checkpointFile } = await import("./sqlite-checkpoint.ts");
  state.fail = failure === "start";
  const fold = checkpointFile("receipts.db");
  if (failure !== "start") {
    state.workers[0].emit("message", true);
    if (failure === "error") state.workers[0].emit("error", new Error("checkpoint failed"));
    state.workers[0].emit("exit", failure === "exit" ? 1 : 0);
  }
  expect(await fold).toBe(false);
});


it("W-FILE-READY: closing a serving connection waits for the worker's live connection, then joins its exit", async () => {
  const { checkpointFile } = await import("./sqlite-checkpoint.ts");
  const close = vi.fn(); let done = false;
  const fold = checkpointFile("receipts.db", { beforeFold: close }).then(result => { done = true; return result; });
  expect(close).not.toHaveBeenCalled();
  state.workers[0].emit("message", "ready");
  expect(close).toHaveBeenCalledTimes(1);
  state.workers[0].emit("message", true);
  await new Promise(resolve => setImmediate(resolve));
  expect(done).toBe(false);
  state.workers[0].emit("exit", 0);
  expect(await fold).toBe(true);
});

it.each([true, false])("W-FILE-GATE-EXIT: a failed worker releases only its own reset gate (owns=%s)", async owns => {
  const { checkpointFile } = await import("./sqlite-checkpoint.ts");
  const gate = new Int32Array(new SharedArrayBuffer(12));
  const fold = checkpointFile("receipts.db", { gate });
  Atomics.store(gate, 0, owns ? -1 : -2);
  state.workers[0].emit("error", new Error("worker lost"));
  state.workers[0].emit("exit", 1);
  expect(await fold).toBe(false);
  expect(Atomics.load(gate, 0)).toBe(owns ? 0 : -2);
});

it("W-FILE-CLOSE-JOIN: shutdown joins an owned close even before its final worker starts", async () => {
  const { checkpointFile, stopFileCheckpoints, trackFileClose } = await import("./sqlite-checkpoint.ts");
  let finish!: () => void, stopped = false;
  trackFileClose(new Promise<void>(resolve => { finish = resolve; }));
  const stop = stopFileCheckpoints().then(result => { stopped = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  expect(stopped).toBe(false);
  expect(await checkpointFile("new-receipts.db")).toBe(false);
  const close = checkpointFile("receipts.db", { beforeFold: () => {} });
  state.workers[0].emit("message", "ready");
  state.workers[0].emit("message", true);
  state.workers[0].emit("exit", 0);
  expect(await close).toBe(true);
  expect(stopped).toBe(false);
  finish(); expect(await stop).toBe(true);
});


it("W-FILE-ADMISSION: a new ledger after shutdown creates no serving connection or files", async () => {
  const { stopFileCheckpoints } = await import("./sqlite-checkpoint.ts");
  const { LedgerStore } = await import("./channels/delivery-ledger-store.ts");
  const root = mkdtempSync(join(tmpdir(), "receipt-stopped-"));
  const opened: { store?: InstanceType<typeof LedgerStore> } = {};
  try {
    await stopFileCheckpoints();
    expect(() => { opened.store = new LedgerStore(join(root, "chat.json")); }).toThrow();
    expect(readdirSync(root)).toEqual([]);
  } finally {
    if (opened.store) {
      const closing = opened.store.release();
      state.workers[0].emit("message", "ready"); state.workers[0].emit("message", true); state.workers[0].emit("exit", 0);
      await closing;
    }
    removeTempDirSync(root);
  }
});
