// SPDX-License-Identifier: AGPL-3.0-or-later
// Behavioural witnesses for the REAL spawn expression in wal-maintenance.ts (walseam-19m): P1/P2 (the ledger the worker gets) and P4 (the meter copy the worker gets).
// Runs untransformed (vitest.walprod.config.ts): the test transform anchors on the spawn line itself, so a mutant of that line would die in the transform, not by assertion.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as workerThreads from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { IoMeterFileId } from "./engine-exclusion.ts";
import { ensureIoMeter, ioMeterNativeId, ioMeterNativePath, resetIoMeterForTest } from "./io-meter.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20_000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(25); } return cond(); }
const syncEsm = async () => (await import("node:module") as unknown as { syncBuiltinESMExports(): void }).syncBuiltinESMExports();
const saved = { ...process.env };
let dir = "";
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); if (dir) removeTempDirSync(dir); });

interface Spawned { workerData: Record<string, unknown>; worker: workerThreads.Worker }
/** Starts the REAL maintenance (real spawn expression, real worker) over a WAL database that has a backlog, records what the spawn handed the worker, runs `body`, and stops. */
async function withRealMaintenance<T>(body: (ctx: { seen: Spawned[]; wal: typeof import("./wal-maintenance.ts"); db: DatabaseSync }) => Promise<T>, extra?: Record<string, unknown>): Promise<T> {
  const seen: Spawned[] = [];
  const real = workerThreads.Worker;
  const builtin = process.getBuiltinModule("node:worker_threads") as typeof workerThreads;
  builtin.Worker = class extends real { constructor(source: string | URL, options?: ConstructorParameters<typeof real>[1]) { if (extra && options?.workerData) Object.assign(options.workerData as object, extra); super(source as string, options); seen.push({ workerData: options?.workerData as Record<string, unknown>, worker: this }); } } as typeof real;
  await syncEsm();
  const dir = mkdtempSync(join(tmpdir(), "wal-seam-b-"));
  let db: DatabaseSync | undefined, wal: typeof import("./wal-maintenance.ts") | undefined;
  try {
    wal = await import("./wal-maintenance.ts");
    const file = join(dir, "messages.db");
    db = new DatabaseSync(file); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x)");
    wal.startWalMaintenance(file, { setAutocheckpoint() {}, nudge: async () => false } as never);
    await until(() => wal!.walMaintenanceReady(), 20_000);
    db.exec("BEGIN"); const st = db.prepare("INSERT INTO t VALUES (?)"); for (let i = 0; i < 3000; i++) st.run("x".repeat(1000)); db.exec("COMMIT");
    return await body({ seen, wal, db });
  } finally {
    await wal?.stopWalMaintenance().catch(() => undefined);
    try { db?.close(); } catch { /* closed */ }
    builtin.Worker = real; await syncEsm(); removeTempDirSync(dir);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------- P1 / P2
describe("B19m-ledger: the real worker runs the shipped checkpointLedger", () => {
  it("P1/P2: a log backlog is copied by the real worker AND the shared ledger records the charge (closure, identity and producer of admissionSource)", async () => {
    await withRealMaintenance(async ({ seen }) => {
      const s = seen[0]!;
      const slots = new BigInt64Array(s.workerData.admission as SharedArrayBuffer), copied = new BigInt64Array(s.workerData.copied as SharedArrayBuffer);
      let charged = 0n;
      const ok = await until(() => { charged = charged > slots[8]! ? charged : slots[8]!; return copied[0]! > 0n && charged > 0n; });
      expect(copied[0], "the real worker copied the backlog (an unusable ledger refuses every copy)").toBeGreaterThan(0n);
      expect(charged, "the copy was charged to the shared ledger by the shipped checkpointLedger (slot 8, settled charge)").toBeGreaterThan(0n);
      expect(ok).toBe(true);
      expect(String(s.workerData.admissionSource), "the producer handed to the worker is the shipped function").toBe(checkpointLedger.toString());
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------- P4 (real addon)
describe.skipIf(process.platform !== "linux")("B19m-p4: the spawn hands the worker the published private copy of the real addon", () => {
  it("P4: workerData.nativeMeterPath is ioMeterNativePath() (the private copy), its identity is ioMeterNativeId(), and the worker loads it", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wal-seam-p4-")));
    const binary = join(dir, "engine-exclusion.node");
    execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; resetIoMeterForTest();
    expect(ensureIoMeter(), "the real addon loads into SQLite").toBe(true);
    const published = ioMeterNativePath(), id = ioMeterNativeId();
    expect(published).toBeTypeOf("string"); expect(published).not.toBe(binary);
    await withRealMaintenance(async ({ seen, wal }) => {
      const s = seen[0]!;
      expect(s.workerData.nativeMeterPath, "the spawn passes the published private copy").toBe(published);
      expect(s.workerData.nativeMeterId).toEqual(id);
      expect(createHash("sha256").update(readFileSync(s.workerData.nativeMeterPath as string)).digest("hex")).toBe((s.workerData.nativeMeterId as IoMeterFileId).sha256);
      expect(await until(() => wal.walMaintenanceReady()), "the real worker loaded that copy and came up").toBe(true);
    });
    expect(existsSync(published!)).toBe(true);
  });
});
