import { expect, it, vi } from "vitest";
const control = vi.hoisted(() => {
  vi.resetModules();
  return { workers: new Set<object>(), exited: new Set<object>(), releases: [] as Array<() => void>, requested: 0 };
});
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    private search = false;
    private ending?: Promise<number>;
    constructor(file: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      super(file, options);
      this.search = typeof options?.workerData?.token === "string";
      if (this.search) { control.workers.add(this); this.once("exit", () => control.exited.add(this)); }
    }
    override postMessage(value: unknown, transferList?: Parameters<import("node:worker_threads").Worker["postMessage"]>[1]): void {
      if (this.search && (value as { type?: string })?.type === "stop") {
        control.releases.push(() => super.postMessage(value, transferList));
      } else super.postMessage(value, transferList);
    }
    override terminate(): Promise<number> {
      if (!this.search) return super.terminate();
      return this.ending ??= new Promise((resolve, reject) => {
        control.requested++;
        control.releases.push(() => { void super.terminate().then(resolve, reject); });
      });
    }
  } };
});
import { database } from "./database.ts";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { settleTestHandles } from "./test-handle-registry.ts";

it("fixture cleanup waits for the search writer's actual exit before its database path can be reused", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  database();
  await vi.waitFor(() => expect(control.workers.size).toBe(1));
  await stopWalMaintenance();
  let settled = false;
  const cleanup = settleTestHandles(DATA_DIR).then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(control.requested).toBe(1));
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(control.exited.size).toBe(0);
    expect(settled).toBe(false);
    for (const release of control.releases.splice(0)) release();
    await cleanup;
    expect(control.exited.size).toBe(1);
    expect(settled).toBe(true);
  } finally {
    for (const release of control.releases.splice(0)) release();
    await cleanup;
    await stopSearchIndex();
  }
});
