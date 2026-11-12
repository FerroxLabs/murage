// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const source = fs.readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
const MB = 1024 * 1024;

it.each([false, true])("T-DEBT-IDENTITY-FAIL preserves process locks across restart (recover=%s)", recover => {
  const dir = fs.mkdtempSync(join(tmpdir(), "wal-identity-"));
  const file = join(dir, "messages.db");
  const db = new DatabaseSync(file);
  const held = new Set<number>();
  let failures = 0;
  // Exercise the production descriptor lifecycle with real descriptors and a real
  // SQLite lock; inject only fstat failure, including another failed restart read.
  const lifecycle = source.slice(source.indexOf("interface DebtFd"), source.indexOf("/** One PASSIVE checkpoint in the worker."));
  const owner = { exitedFlag: false };
  const live = new Set([owner]);
  const api = runInNewContext(ts.transpile(lifecycle + "\n({ debtFdFor, releaseDebtFds, closeDebtFd })"), {
    ...fs, performance, console: { warn() {} }, live,
    walMaintenanceTestHooks: { failureLogGapMs: 600_000 },
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); held.add(fd); return fd; },
    closeSync(fd: number) { fs.closeSync(fd); held.delete(fd); },
    fstatSync(fd: number) {
      if (!recover || failures++ < 2) throw Object.assign(new Error("injected identity read failure"), { code: "EIO" });
      return fs.fstatSync(fd, { bigint: true });
    },
  }) as { debtFdFor(file: string): number; releaseDebtFds(): void; closeDebtFd(): void };
  try {
    db.exec("CREATE TABLE item(value); BEGIN IMMEDIATE; INSERT INTO item VALUES(1)");
    const fd = api.debtFdFor(file);
    expect(fd).toBeGreaterThanOrEqual(0);
    for (let restart = 0; restart < 3; restart++) {
      api.debtFdFor(file);
      owner.exitedFlag = true; live.clear(); api.releaseDebtFds();
      const child = spawnSync(process.execPath, ["-e", `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA busy_timeout=0');
        try { db.exec('BEGIN IMMEDIATE; ROLLBACK'); console.log('unlocked'); }
        catch (error) { if (!/locked/.test(error.message)) throw error; console.log('locked'); }
        finally { db.close(); }
      `, file], { encoding: "utf8", timeout: 10_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim(), "restart must preserve the server's database lock").toBe("locked");
      expect([...held]).toEqual([fd]);
      expect(fs.fstatSync(fd).isFile()).toBe(true);
    }
    if (recover) expect(api.debtFdFor(file)).toBe(fd);
  } finally {
    db.exec("ROLLBACK"); db.close(); api.closeDebtFd(); api.releaseDebtFds();
    for (const fd of held) fs.closeSync(fd);
    removeTempDirSync(dir);
  }
  expect(held.size).toBe(0);
});

function debtWorker() {
  const shared = new Int32Array(new SharedArrayBuffer(24 * 4));
  let now = 1000, checkpointed = 2048, complete = false, failing = true, attempts = 0;
  let tick!: () => void;
  let message!: (value: { op: string; reqId: number }) => void;
  const pages = 8192, frameSize = 4096 + 24;
  const workerSource = source.match(/const WORKER_SOURCE = `([\s\S]*?)`;/)![1]!;
  runInNewContext(workerSource, {
    Buffer, Atomics, Int32Array, performance, Date: { now: () => now },
    setInterval(fn: () => void) { tick = fn; return { unref() {} }; }, clearInterval() {},
    require(name: string) {
      if (name === "node:worker_threads") return {
        workerData: { shared: shared.buffer, copied: new SharedArrayBuffer(8), file: "fixture.db", stepBytes: 4 * MB, pollMs: 25, dueMs: 250, debtBytes: 8 * MB, debtFd: 9 },
        parentPort: { postMessage() {}, on(_event: string, fn: typeof message) { message = fn; } },
      };
      if (name === "node:sqlite") return { DatabaseSync: class {
        exec() {}
        prepare(sql: string) { return { all: () => sql.includes("data_version") ? [{ data_version: 1 }] : sql.includes("wal_checkpoint") ? [{ busy: 0, log: pages, checkpointed: complete ? pages : checkpointed }] : [{ n: 1 }] }; }
      } };
      if (name === "node:fs") return {
        openSync: () => 10, closeSync() {},
        fstatSync: () => ({ size: 32 + pages * frameSize, isFile: () => true }),
        readSync(_fd: number, out: Buffer, _offset: number, length: number, position: number) {
          out.fill(0);
          if (position === 0) { out.writeUInt32BE(0x377f0682, 0); out.writeUInt32BE(4096, 8); out.writeUInt32BE(1, 16); out.writeUInt32BE(2, 20); }
          return length;
        },
        fdatasyncSync() { attempts++; if (failing) throw new Error("injected sync failure"); },
      };
      throw new Error(`unexpected module ${name}`);
    },
  });
  return {
    shared, attempts: () => attempts,
    pass() { message({ op: "passive", reqId: 1 }); },
    advance(ms: number) { now += ms; tick(); },
    copyMore() { checkpointed += 256; },
    recover() { failing = false; },
    complete() { complete = true; },
  };
}

it("T-DEBT-FLUSH-FAIL retains unpaid bytes and retries without new copy at a bounded rate", () => {
  const worker = debtWorker();
  worker.pass();
  const debt = worker.shared[13]!;
  expect(worker.shared[17]).toBe(1);
  expect(debt).toBeGreaterThanOrEqual(8 * 1024);
  for (let attempt = 0; attempt < 20; attempt++) worker.pass();
  expect(worker.attempts()).toBe(1);
  expect(worker.shared[13]).toBe(debt);
  worker.copyMore(); worker.pass();
  expect(worker.shared[13]).toBeGreaterThan(debt);
  worker.advance(249); expect(worker.attempts()).toBe(1);
  worker.advance(1); expect(worker.attempts()).toBe(2);
  expect(worker.shared[13]).toBeGreaterThan(debt);
  worker.recover(); worker.advance(250);
  expect(worker.attempts()).toBe(3);
  expect(worker.shared[15]).toBe(1);
  expect(worker.shared[17]).toBe(2);
  expect(worker.shared[13]).toBe(0);
  worker.advance(250); expect(worker.attempts()).toBe(3);
});

it("T-DEBT-FLUSH-FAIL full SQLite sync pays retained debt before the next retry", () => {
  const worker = debtWorker(); worker.pass();
  expect(worker.shared[13]).toBeGreaterThanOrEqual(8 * 1024);
  worker.complete(); worker.pass();
  expect(worker.shared[13]).toBe(0);
  worker.advance(250);
  expect(worker.attempts()).toBe(1);
});

it("T-STEP-SERIAL-PUBLICATION waits through running, sequence and timed-counter publication", async () => {
  const tests = fs.readFileSync(new URL("./wal-maintenance.test.ts", import.meta.url), "utf8");
  const serial = tests.slice(tests.indexOf('it("T-STEP-SERIAL work"'), tests.indexOf('it("T-STEP-CLOSE work"'));
  // Run the serialization test's actual acquisition and assertions, stopping
  // before requesting work. Advance each atomic publication only when it waits.
  const acquisition = serial.slice(serial.indexOf("    await vi.waitFor"), serial.indexOf("    let resolved"));
  let stage = 0;
  await runInNewContext(`(async () => { ${acquisition} })()`, {
    expect,
    stepCounters: () => ({ running: 1, passSeq: stage >= 1 ? 1 : 0, passDone: 0, timedPasses: stage >= 2 ? 1 : 0 }),
    vi: { async waitFor(check: () => void) {
      for (;;) { try { check(); return; } catch (error) { if (stage++ >= 2) throw error; } }
    } },
  });
  expect(stage).toBe(2);
});
