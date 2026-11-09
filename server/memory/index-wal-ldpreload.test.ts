// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.0.18 Part A WP1, S21i leg 2: a REAL failing truncate of the -wal (an LD_PRELOAD shim, index-wal-ldpreload.c, makes ftruncate on
// *-wal fail with EIO while a flag file exists). Runs only when the runner built and loaded the shim (MEMW_SHIM_FLAG is set); on every
// Linux command (in the node:24-bookworm runner): gcc -shared -fPIC -o /tmp/memw-shim.so server/memory/index-wal-ldpreload.c -ldl, then
// MEMW_SHIM_FLAG=/tmp/memw-shim-flag LD_PRELOAD=/tmp/memw-shim.so vitest run server/memory/index-wal-ldpreload.test.ts. On every
// other host the suite skips and S21i (1) in index-wal-state.test.ts carries the emulation. Throwaway temp dirs only.
import { existsSync, mkdtempSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { IndexWalWriter, MEMW_W_STEP_BYTES, openIndexWal, readSidecar, WalStop, walTestHooks, type ChargeTransport, type OpenedIndexWal } from "./index-wal.ts";

const FLAG = process.env.MEMW_SHIM_FLAG ?? "";
const roots: string[] = [];
const handles: OpenedIndexWal[] = [];
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Error(`exit ${code}`); }; });
afterEach(() => {
  for (const key of Object.keys(walTestHooks) as Array<keyof typeof walTestHooks>) delete walTestHooks[key];
  if (FLAG) { try { unlinkSync(FLAG); } catch { /* absent */ } }
  for (const o of handles.splice(0)) { try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const MB = 1024 * 1024;
const grant: ChargeTransport = async () => true;
const walLen = (path: string) => { try { return statSync(`${path}-wal`).size; } catch { return 0; } };
function rows(db: DatabaseSync, bytes: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS t(x BLOB)");
  const put = db.prepare("INSERT INTO t VALUES(randomblob(?))");
  for (let left = bytes; left > 0; left -= 4000) put.run(Math.min(4000, left));
}
async function scenario(fail: boolean): Promise<{ path: string; w: IndexWalWriter; floor: number; after: number }> {
  const root = mkdtempSync(join(tmpdir(), "memw-ldp-")); roots.push(root);
  const path = join(root, "memory-index.db");
  const o = openIndexWal(path, { charge: grant }); handles.push(o);
  o.verdict = await o.wal.openCheck();
  const w = o.wal as IndexWalWriter;
  w.write("open", 4 * MB, () => rows(o.writable, 100_000)); await w.check();
  w.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 3 * MB)); await w.check(); // a full PASSIVE: the next commit restarts the log
  const floor = walLen(path);
  if (fail) writeFileSync(FLAG, "1");
  w.write("fill", MB, () => rows(o.writable, 50_000)); await w.check();
  if (fail) unlinkSync(FLAG);
  return { path, w, floor, after: walLen(path) };
}

it.skipIf(!FLAG)("S21i (2): a real ftruncate failure on the -wal after a restart: the commit is ok, the file keeps its length, the next failed attempt is a false OVERRUN counted truncate_failed (control: without the failure the same restart shortens the file)", async () => {
  const control = await scenario(false);
  expect(control.floor).toBeGreaterThan(3 * MB);
  expect(control.after).toBeLessThan(control.floor); // the truncate works when the shim is off
  expect((control.w as unknown as { truncateFailed: boolean }).truncateFailed).toBe(false);
  const bad = await scenario(true);
  expect(bad.after).toBeGreaterThanOrEqual(bad.floor); // the truncate failed: the file kept its length
  expect(bad.w.counters.truncate_failed).toBe(0);
  expect((bad.w as unknown as { truncateFailed: boolean }).truncateFailed).toBe(true);
  expect(existsSync(`${bad.path}-walstop`)).toBe(false);
  expect(() => bad.w.write("fill", MB, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
  await expect(bad.w.check()).rejects.toThrow(WalStop);
  expect(bad.w.counters.truncate_failed).toBe(1);
  expect(readSidecar(bad.path, "-walstop").state).toBe("ok");
});
