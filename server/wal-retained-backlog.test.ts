// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { walHeaderFixture, walIndexFixture } from "./testing/wal-header-fixture.ts";
import { checkpointLedger } from "./admission-shared.ts";

// Drive the production worker with a restarted WAL whose old allocation remains.
// Neither the clock nor the SQLite writer depends on host scheduling or disk speed.
function retainedWal() {
  const source = readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
  const program = source.match(/const WORKER_SOURCE = `([\s\S]*?)`;/)![1]!;
  const shared = new Int32Array(new SharedArrayBuffer(28 * 4));
  const frameSize = 4096 + 24, allocatedFrames = 22000;
  let liveFrames = 1024, version = 1, now = 1000, passes = 0;
  let tick!: () => void;
  runInNewContext(program, {
    Buffer, performance, Date: { now: () => now },
    setInterval(fn: () => void) { const prior = tick; tick = prior ? () => { prior(); fn(); } : fn; return { unref() {} }; }, clearInterval() {},
    require(name: string) {
      if (name === "node:worker_threads") return {
        threadId: 1,
        workerData: { admission: new SharedArrayBuffer(256), admissionSource: checkpointLedger.toString(), shared: shared.buffer, copied: new SharedArrayBuffer(8), file: "fixture.db", stepBytes: 4 * 1024 * 1024, pollMs: 25, dueMs: 250, debtBytes: 8 * 1024 * 1024, debtFd: program.includes("const { debt: debtFd") ? { debt: -1, index: 11 } : -1 },
        parentPort: { postMessage() {}, on() {} },
      };
      if (name === "node:sqlite") return { DatabaseSync: class {
        exec() {}
        prepare(sql: string) { return { all: () => {
          if (sql.includes("data_version")) return [{ data_version: version }];
          if (sql.includes("wal_checkpoint")) { passes++; return [{ busy: 0, log: liveFrames, checkpointed: liveFrames }]; }
          return [{ n: 1 }];
        } }; }
      } };
      if (name === "node:fs") return {
        statSync: () => ({dev: 1, ino: 1}),
        openSync: () => 10, closeSync() {}, fdatasyncSync() {},
        statfsSync: () => ({ bavail: 1e9, bsize: 4096 }),
        fstatSync: () => ({ size: 32 + allocatedFrames * frameSize, isFile: () => true, dev: 1, ino: 1 }),
        readSync(fd: number, out: Buffer, offset: number, length: number, position: number) {
          if (fd === 11) { walIndexFixture(7, 9, liveFrames).copy(out, offset); return length; }
          out.fill(0, offset, offset + length);
          if (position === 0) {
            walHeaderFixture(7, 9).copy(out, offset);
          } else {
            const current = Math.floor((position - 32) / frameSize) < liveFrames;
            out.writeUInt32BE(current ? 7 : 3, offset + 8); out.writeUInt32BE(current ? 9 : 5, offset + 12);
          }
          return length;
        },
      };
      throw new Error(`Unexpected worker dependency ${name}`);
    },
  });
  return {
    shared, passes: () => passes, liveBytes: () => 32 + liveFrames * frameSize,
    commit() { liveFrames += 1024; version++; now += 25; tick(); },
    allocatedBytes: 32 + allocatedFrames * frameSize,
  };
}

it("a restarted WAL counts only its generation's frames as copy backlog", () => {
  const wal = retainedWal();
  expect(wal.shared[5]).toBe(Math.ceil(wal.liveBytes() / 1024));
  expect(wal.shared[9]).toBe(Math.ceil(wal.allocatedBytes / 1024));
});

it("committed growth within retained allocation starts a step on the first poll", () => {
  const wal = retainedWal();
  wal.commit();
  expect(wal.passes()).toBe(1);
  expect(wal.shared[6]).toBe(1);
  expect(wal.shared[10]).toBe(0);
});
