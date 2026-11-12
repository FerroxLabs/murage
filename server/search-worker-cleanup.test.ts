import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { settleTestHandles } from "./test-handle-registry.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const held = vi.hoisted(() => ({ workers: [] as Array<{ emit(event: string, code: number): boolean }> }));
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  class HeldSearchWorker extends EventEmitter {
    unref() { return this; }
    postMessage() {}
    terminate() { return new Promise<number>(resolve => this.once("exit", resolve)); }
  }
  return { ...actual, Worker: class {
    constructor(source: string, options: import("node:worker_threads").WorkerOptions) {
      if (!(options.workerData as { searchFile?: string })?.searchFile) return new actual.Worker(source, options);
      const worker = new HeldSearchWorker();
      held.workers.push(worker);
      return worker;
    }
  } };
});

it("test cleanup waits for a search thread already asked to stop", async () => {
  vi.resetModules();
  const { startSearchIndex, stopSearchIndex } = await import("./message-search-index.ts");
  const dir = mkdtempSync(join(tmpdir(), "search-cleanup-"));
  const file = join(dir, "messages.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY,done TEXT,cursor INTEGER,skipped INTEGER)");
  let stopping: Promise<boolean> = Promise.resolve(true);
  let cleanup: Promise<void> = Promise.resolve();
  try {
    startSearchIndex(db, file);
    expect(held.workers).toHaveLength(1);
    stopping = stopSearchIndex();
    let settled = false;
    cleanup = settleTestHandles(dir).then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    held.workers[0]!.emit("exit", 0);
    await cleanup;
    expect(settled).toBe(true);
    expect(await stopping).toBe(true);
  } finally {
    held.workers[0]?.emit("exit", 0);
    await stopping;
    await cleanup;
    db.close();
    held.workers.length = 0;
    removeTempDirSync(dir);
  }
});
