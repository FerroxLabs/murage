// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 8 (lanes/msearch-review/r8/REPORT.md). Both fail on 349eff48b.
//  P2  scans were serialized even with a small log: a second search lost lexical recall after 200 ms despite remaining budget;
//  P2  the reader had no production checkpoint requester: admission resumed after a fixed wait with the log unchanged.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryIndex, walBytes, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, resetScanAdmission, setWalCheckpointRequester, setWalDrainThreshold } from "./index-reader.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const QUERY = "harbour lantern";
const same = "harbour lantern notes for the Friday review";
const entry = (id: string): IndexedMemory => ({ id, version: 1, scopeId: "s", text: same, deleted: false });
const ids = Array.from({ length: 6000 }, (_, n) => `d-${String(n).padStart(4, "0")}`);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function world(rows = ids) {
  closeMemoryIndexReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.upsert(rows.map(entry));
  return index;
}
beforeEach(() => { resetScanAdmission(); closeMemoryIndexReader(); closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { resetScanAdmission(); closeMemoryIndexReader(); setWalCheckpointRequester(null); setWalDrainThreshold(64 * 1024 * 1024); });

describe("P2: overlapping scans run side by side while the log is small", () => {
  it("a second scan started while the first is open (and held 400 ms) answers in full, not partial", async () => {
    const index = world();
    let second: ReturnType<typeof lexicalPageSliced> | null = null, secondYields = 0;
    const first = await lexicalPageSliced(QUERY, ["s"], 50, 0, async () => {
      if (!second) {
        second = lexicalPageSliced(QUERY, ["s"], 50, 0, async () => { secondYields++; await tick(); });
        await new Promise<void>(resolve => setTimeout(resolve, 400));
      }
    });
    const answer = await second!;
    index.close();
    expect(first?.partial).toBeUndefined();
    expect(answer?.partial).toBeUndefined();
    expect(answer?.hits).toHaveLength(50);
    expect(secondYields).toBeGreaterThan(0);
  }, 60_000);
});

describe("P2: a log over the threshold is checkpointed through the writer, and admission waits for the acknowledgement", () => {
  it("one request after the open scans finish; a new scan waits within its own budget and is admitted after the ack; the log is truncated", async () => {
    const index = world(Array.from({ length: 40_000 }, (_, n) => `e-${String(n).padStart(5, "0")}`));
    expect(walBytes(INDEX_PATH())).toBeGreaterThan(1);
    // the log grows past the threshold while the first scan is open
    const requests: number[] = [];
    let release!: () => void;
    const acknowledged = new Promise<void>(resolve => { release = resolve; });
    setWalCheckpointRequester(async () => {
      requests.push(Date.now());
      await acknowledged;
      return index.checkpointNow();
    });
    const events: string[] = [];
    let secondLogAtRead = -1, second: ReturnType<typeof lexicalPageSliced> | null = null;
    const first = lexicalPageSliced(QUERY, ["s"], 50, 0, async () => {
      if (!second) {
        setWalDrainThreshold(1);
        second = lexicalPageSliced(QUERY, ["s"], 50, 0, async () => { if (secondLogAtRead < 0) { secondLogAtRead = walBytes(INDEX_PATH()); events.push("second-reads"); } await tick(); }, { deadlineAt: Date.now() + 10_000 });
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        expect(requests).toHaveLength(0); // a snapshot is still open: nothing can be truncated yet
      }
      await tick();
    }).then(page => { events.push("first-done"); return page; });
    await first;
    expect(second).not.toBeNull(); // the first scan was long enough to yield, and the second began inside it
    await new Promise<void>(resolve => setTimeout(resolve, 600)); // longer than the old fixed 200 ms drain
    expect(requests).toHaveLength(1);
    expect(events).toEqual(["first-done"]); // still gated: no acknowledgement yet
    release();
    const page = await second!;
    index.close();
    expect(page?.partial).toBeUndefined();
    expect(page?.hits).toHaveLength(50);
    expect(requests).toHaveLength(1);
    expect(secondLogAtRead).toBe(0);
  }, 60_000);

  it("a gated scan answers partial only when its own budget is spent", async () => {
    const index = world();
    setWalDrainThreshold(1);
    setWalCheckpointRequester(() => new Promise<boolean>(() => { /* never acknowledged */ }));
    const page = await lexicalPageSliced(QUERY, ["s"], 50, 0, tick, { deadlineAt: Date.now() + 150 });
    index.close();
    expect(page?.partial).toBe(true);
  }, 30_000);

  it("a checkpoint never acknowledged lifts the gate after the bounded time, and is not asked again at once", async () => {
    const index = world();
    setWalDrainThreshold(1);
    let requests = 0;
    setWalCheckpointRequester(() => { requests++; return new Promise<boolean>(() => { /* never acknowledged */ }); });
    const started = Date.now();
    const page = await lexicalPageSliced(QUERY, ["s"], 50, 0, tick, { deadlineAt: Date.now() + 10_000 });
    const again = await lexicalPageSliced(QUERY, ["s"], 50, 0, tick, { deadlineAt: Date.now() + 10_000 });
    index.close();
    expect(page?.partial).toBeUndefined();
    expect(again?.partial).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(requests).toBe(1);
  }, 30_000);
});

describe("worker IPC: the controller forwards the request to the helper and resolves on its acknowledgement", () => {
  function controllerWith(reply: (sent: { type: string; requestId: string }, answer: (ok: boolean) => void) => void) {
    const controller = new MemoryWorkerController();
    const sent: Array<{ type: string; requestId: string }> = [];
    const child = { send: (message: { type: string; requestId: string }) => { sent.push(message); reply(message, ok => setImmediate(() => (controller as unknown as { onWorkerMessage(c: unknown, m: unknown): void }).onWorkerMessage(child, { type: "checkpoint-result", requestId: message.requestId, ok }))); return true; } };
    Object.assign(controller as object, { child, ready: true });
    return { controller, sent };
  }

  it("the helper truncates the log of the real index and acknowledges; the request resolves true", async () => {
    const index = world();
    setWalDrainThreshold(1);
    const { controller, sent } = controllerWith((message, answer) => { if (message.type === "checkpoint") answer(index.checkpointNow()); });
    setWalCheckpointRequester(() => controller.requestCheckpoint());
    expect(walBytes(INDEX_PATH())).toBeGreaterThan(1);
    const page = await lexicalPageSliced(QUERY, ["s"], 50, 0, tick, { deadlineAt: Date.now() + 10_000 });
    index.close();
    expect(page?.partial).toBeUndefined();
    expect(sent.filter(message => message.type === "checkpoint")).toHaveLength(1);
    expect(walBytes(INDEX_PATH())).toBe(0);
  }, 30_000);

  it("a helper that exits, or has none ready, answers false", async () => {
    const { controller } = controllerWith(() => { /* never answers */ });
    const pending = controller.requestCheckpoint();
    (controller as unknown as { settleCheckpoints(ok: boolean): void }).settleCheckpoints(false);
    expect(await pending).toBe(false);
    expect(await new MemoryWorkerController().requestCheckpoint()).toBe(false);
  });
});
