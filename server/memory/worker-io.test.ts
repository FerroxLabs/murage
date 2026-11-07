// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 rehearsal 2 (memory worker write storm): the helper writes the index in its own process, so the parent's io-budget never
// saw those bytes. The helper now reports its own write count (process.resourceUsage().fsWrite, the same reading the parent takes
// of itself) with every index acknowledgement and from its idle maintenance, so the budget can pace index work like any other writer.
import { expect, it, vi } from "vitest";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "../testing/cleanup.ts";

const state = vi.hoisted(() => ({ fsWrite: 0, owed: false, purges: 0, platform: undefined as string | undefined, real: false, opened: [] as Array<{ close(): void }> }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; backend = "native"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", async () => { const { DatabaseSync } = await import("node:sqlite"); const { walFrameReader } = await import("../io-written.ts"); return { MemoryIndex: class {
  rebuilt = false;
  // WIN-IOB-QUICK: with state.real the stub writes a real WAL index at the path it is given, as the real index does, and owns its log reader
  db: InstanceType<typeof DatabaseSync> | null = null;
  wal: ReturnType<typeof walFrameReader> | null = null;
  ioBytes() { return this.wal?.() ?? 0; }
  // as the real index does: read the log, then restart it
  truncateLog() { this.wal?.(); this.db?.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  constructor(path: string) { state.opened.push(this); if (state.real) { this.db = new DatabaseSync(path); this.wal = walFrameReader(path); this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS r(x)"); } }
  prepareModel() {}
  upsert() { state.fsWrite += 100; this.db?.exec("INSERT INTO r SELECT randomblob(4096) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32) SELECT i FROM n)"); }
  vector() { state.fsWrite += 1; }
  checkpointNow() { return true; }
  // the helper starts a pass at init and after every batch that owes a merge; only an owed merge writes
  purgeRolledCheckpoints() { if (state.owed) { state.purges++; state.fsWrite += 10; } return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return state.owed; }
  purgeRecords() {}
  close() { this.db?.close(); this.db = null; this.wal?.close(); this.wal = null; }
} }; });
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));

type Sent = { type: string; requestId?: string; fsWriteBlocks?: number; ioBytes?: number };
async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Sent[] }) => Promise<void>, options: { platform?: string; indexPath?: string } = {}) {
  vi.resetModules(); state.fsWrite = 0; state.owed = false; state.purges = 0; state.platform = options.platform; state.real = Boolean(options.indexPath);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const timer = realSetTimeout(...args); timers.push(timer); return timer;
  }) as typeof setTimeout);
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Sent[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect" || event === "error") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: (message: Sent) => { sent.push(message); return true; } },
    exit: { value: vi.fn() },
    resourceUsage: { value: () => ({ ...realProcess.resourceUsage(), fsWrite: state.fsWrite }) },
    ...(state.platform ? { platform: { value: state.platform } } : {}),
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    emit({ type: "init", indexPath: options.indexPath ?? "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent });
  } finally {
    try { listeners.get("disconnect")?.(undefined); }
    finally {
      timers.forEach(clearTimeout); timeoutSpy.mockRestore(); state.opened.length = 0;
      vi.unstubAllGlobals(); vi.resetModules();
    }
  }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

it("an index acknowledgement carries the helper's cumulative write count, taken after the batch was written", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "index", requestId: "b1", records: [{ id: "r1", version: 1, scopeId: "s", text: "one", deleted: false }] });
    await settle();
    const result = sent.find(message => message.type === "index-result" && message.requestId === "b1");
    expect(result).toBeDefined();
    // the batch wrote (upsert 100 + one vector): the count reported is what the process had written once the batch was done
    expect(result!.fsWriteBlocks).toBe(101);
    emit({ type: "index", requestId: "b2", records: [{ id: "r2", version: 1, scopeId: "s", text: "two", deleted: false }] });
    await settle();
    expect(sent.find(message => message.type === "index-result" && message.requestId === "b2")!.fsWriteBlocks).toBe(202);
  });
});

it("idle maintenance that wrote reports its count too, so a merge paid between batches is budgeted", async () => {
  await withWorker(async ({ emit, sent }) => {
    state.owed = true;
    emit({ type: "index", requestId: "b1", records: [{ id: "r1", version: 1, scopeId: "s", text: "one", deleted: false }] });
    // the maintenance waits for the helper to be idle (MAINTENANCE_POLL_MS), then runs its pass and reports
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !sent.some(message => message.type === "io")) await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(state.purges).toBeGreaterThan(0);
    const reports = sent.filter(message => message.type === "io").map(message => message.fsWriteBlocks);
    expect(reports.length).toBeGreaterThan(0);
    expect(Math.max(...reports.map(Number))).toBe(state.fsWrite);
  });
});

it("WIN-IOB-QUICK: on win32 the helper reports 0 blocks (pipe writes are not disk) and its index's WAL frames as ioBytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-worker-"));
  try {
    await withWorker(async ({ emit, sent }) => {
      emit({ type: "index", requestId: "b1", records: [{ id: "r1", version: 1, scopeId: "s", text: "one", deleted: false }] });
      await settle();
      const first = sent.find(message => message.type === "index-result" && message.requestId === "b1");
      expect(first).toBeDefined();
      // the stub's fsWrite moved by 101 (a pipe storm on Windows reads the same way): win32 reports none of it
      expect(state.fsWrite).toBe(101);
      expect(first!.fsWriteBlocks).toBe(0);
      // 32 rows of 4 KiB through the WAL: at least that many bytes of frames
      expect(first!.ioBytes).toBeGreaterThanOrEqual(32 * 4096);
      emit({ type: "index", requestId: "b2", records: [{ id: "r2", version: 1, scopeId: "s", text: "two", deleted: false }] });
      await settle();
      const second = sent.find(message => message.type === "index-result" && message.requestId === "b2")!;
      expect(second.fsWriteBlocks).toBe(0);
      expect(second.ioBytes! - first!.ioBytes!).toBeGreaterThanOrEqual(32 * 4096);
    }, { platform: "win32", indexPath: join(dir, "memory-index.db") });
  } finally {
    while (state.opened.length) state.opened.pop()!.close();
    removeTempDirSync(dir);
  }
});

it("WIN-IOB-QUICK: log checkpoints inside one report interval lose no frames (the worker samples before each checkpoint)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-ckpt-"));
  try {
    await withWorker(async ({ emit, sent }) => {
      const stub = state.opened[0] as unknown as { upsert(): void; truncateLog(): void };
      // four generations of the log (32 x 4 KiB each), the log restarted between them, no report in between
      for (let i = 0; i < 3; i++) { stub.upsert(); stub.truncateLog(); }
      stub.upsert();
      emit({ type: "index", requestId: "b1", records: [{ id: "r1", version: 1, scopeId: "s", text: "one", deleted: false }] });
      await settle();
      const result = sent.find(message => message.type === "index-result" && message.requestId === "b1");
      expect(result).toBeDefined();
      // 4 stub generations plus the batch's own upsert: well above one generation
      expect(result!.ioBytes).toBeGreaterThanOrEqual(5 * 32 * 4096);
    }, { platform: "win32", indexPath: join(dir, "memory-index.db") });
  } finally {
    while (state.opened.length) state.opened.pop()!.close();
    removeTempDirSync(dir);
  }
});
