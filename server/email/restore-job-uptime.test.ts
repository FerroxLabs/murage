// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RestoreJobStore, type RestoreJobOptions } from "./restore-job.ts";
import { sqliteRestoreEffects, workerPublish, type PublishRequest } from "./restore-job-effects.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// Setup imports runtime modules before this suite installs its isolated I/O seams.
vi.hoisted(() => vi.resetModules());
vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, uptime: vi.fn(os.uptime) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restore-uptime-"));
  vi.mocked(uptime).mockReset().mockReturnValue(123.4567);
});
afterEach(() => removeTempDirSync(dir));

function fixture(readProc: NonNullable<RestoreJobOptions["readProc"]>) {
  const liveDb = join(dir, "messages.db");
  const db = new DatabaseSync(liveDb);
  db.exec("CREATE TABLE restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL); INSERT INTO restore_job_marks VALUES ('swapped', 'A')");
  db.close();
  writeFileSync(join(dir, "restore-job.json"), JSON.stringify({ version: 1, id: "A", archiveId: "arc", source: "owner", phase: "swapped", at: 1_800_000_000_000 }));
  const requests: PublishRequest[] = [], results: string[] = [];
  let mono = 0, attempts = 0;
  const store = new RestoreJobStore({
    dir, isLocalArchive: () => true, captureCarry: () => ({}),
    effects: sqliteRestoreEffects({ liveDb, archivesDir: dir }),
    now: () => 1_800_000_000_000, bootId: () => "boot-A", readProc,
    mono: () => mono, sleepSync: ms => { mono += ms; },
    dataOpsLock: { acquire: () => ++attempts > 1, release: () => {} }, log: () => {},
    publish: req => {
      requests.push(req);
      const handle = workerPublish(req);
      void handle.result.then(result => { results.push(result); });
      return handle;
    },
  });
  const row = () => {
    const check = new DatabaseSync(liveDb, { readOnly: true });
    try { return check.prepare("SELECT * FROM restore_boot_wait").all(); }
    finally { check.close(); }
  };
  return { store, requests, results, row };
}

const missingProc = () => { throw new Error("ENOENT: /proc/uptime"); };

it.each(["missing", "garbage", "", "   ", "Infinity 0"])("writes OS uptime when /proc is unavailable or unparsable: %j", async proc => {
  const f = fixture(proc === "missing" ? missingProc : () => proc);
  expect(f.store.recover()).toEqual({ action: "prepared" });
  await f.store.publishSettled();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].upMs).toBe(123457);
  expect(f.results).toEqual(["saved"]);
  expect(f.row()).toEqual([expect.objectContaining({ job_id: "A", up_ms: 123457 })]);
  expect(f.store.bootWaitLine()).toContain("Murage waited");
});

it("keeps the Linux /proc uptime path and millisecond rounding", async () => {
  const f = fixture(path => { expect(path).toBe("/proc/uptime"); return "987.6547 1234.00\n"; });
  expect(f.store.recover()).toEqual({ action: "prepared" });
  await f.store.publishSettled();
  expect(f.results).toEqual(["saved"]);
  expect(f.row()).toEqual([expect.objectContaining({ up_ms: 987655 })]);
  expect(f.store.bootWaitLine()).toContain("Murage waited");
  expect(uptime).not.toHaveBeenCalled();
});

it.each(["NaN", "Infinity", "throws"])("writes an unknown sentinel at the worker boundary when both sources fail: %s", async failure => {
  if (failure === "throws") vi.mocked(uptime).mockImplementation(() => { throw new Error("uptime unavailable"); });
  else vi.mocked(uptime).mockReturnValue(failure === "NaN" ? NaN : Infinity);
  const f = fixture(missingProc);
  expect(f.store.recover()).toEqual({ action: "prepared" });
  await f.store.publishSettled();
  expect(f.requests).toHaveLength(1);
  expect(Number.isFinite(f.requests[0].upMs)).toBe(false);
  expect(f.results).toEqual(["saved"]);
  expect(f.row()).toEqual([expect.objectContaining({ job_id: "A", up_ms: -1 })]);
  // Even after uptime becomes known again, unknown persisted metadata cannot authorize a notice.
  vi.mocked(uptime).mockReturnValue(124);
  expect(f.store.bootWaitLine()).toBeNull();
  expect(f.row()).toHaveLength(1);
});
