// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2a: spec 4 surface WP3's helper uses on the real WAL core: stopInfo, the start with R (r3.2.8 3.2: create({charge, reset}), trigger A/B), resetDone, fileId,
// sealAndTruncate, prepareExit; one source for the shared constants.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStopMarker } from "./index-quarantine.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import * as steps from "./memw-steps.ts";
import * as core from "./index-wal.ts";
import { walTestHooks, WalStop, type WalCharge } from "./index-wal.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-wp2a-r-")); dirs.push(d); return d; };
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Error(`MEMW_TEST_EXIT ${code}`); }; walTestHooks.chargeAckMs = 200; });
afterEach(() => { for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key]; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const meta = (path: string, key: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { const r = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return r ? String(r.value) : undefined; } finally { db.close(); } };
const count = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(sql).get()!.n); } finally { db.close(); } };
const rec = (i: number): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: `scope:${i % 5}`, text: `words of record ${i} alpha`, deleted: false });
const grant = (seen: WalCharge[] = []) => (c: WalCharge) => { seen.push(c); return Promise.resolve(true); };
type Core = { stop(reason: string, kind: string, seq: number): never; seq: number; check(): Promise<void>; closeForQuarantine(): void };
const coreOf = (index: MemoryIndex) => (index as unknown as { core: Core }).core;
/** A stopped index: the real durable stop (sidecar first, then wal_over_stop), as an OVERRUN writes it. */
async function stopped(path: string) {
  const index = await MemoryIndex.create(path, { charge: grant() });
  await index.applyBatch([rec(1), rec(2)]);
  expect(() => coreOf(index).stop("test_overrun", "group", coreOf(index).seq)).toThrow(WalStop);
  return index;
}

describe("stopInfo / start with R / resetDone on the real core (1.7, r3.2.8 3.2)", () => {
  it("a stopped index reports its stop, answers batches wal-over, and a reopen of the file is still stopped", async () => {
    const path = join(dir(), "i.db"), index = await stopped(path);
    const info = index.stopInfo();
    expect(info).toMatchObject({ fileId: index.fileId, kind: "group", reason: "test_overrun" });
    expect(await index.applyBatch([rec(3)])).toEqual({ status: "failed", reason: "wal-over", committed: 0 });
    expect(await index.maintenanceStep()).toEqual({ ran: null });
    expect(await index.sealAndTruncate()).toEqual({ truncated: false });
    index.close();
    const again = await MemoryIndex.create(path, { charge: grant() });
    expect(again.opened()).toBe(false);
    expect(again.stopInfo()).toMatchObject({ fileId: info!.fileId, seq: info!.seq });
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(2); // searches read the committed index
    again.close();
  });
  it("a start that carries R on a stopped file (trigger A): the set goes aside, the marker stays at its live name, a new file_id opens writable with reset_done = R and overrun_k; the same R again is no-op", async () => {
    const d = dir(), path = join(d, "i.db"), index = await stopped(path);
    const oldId = index.fileId;
    index.close();
    expect(existsSync(`${path}-walstop`)).toBe(true);
    const again = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 41, resets: 2, kind: "group" } });
    expect(again.rebuilt).toBe(true);
    expect(again.opened()).toBe(true);
    expect(again.fileId).not.toBe(oldId);
    expect(again.stopInfo()).toBeNull();
    expect(existsSync(`${path}-walstop`)).toBe(true); // only completeIndexReset removes it (r3.2.8 3.3)
    expect(again.resetDone()).toBe(41);
    expect(meta(path, "reset_done")).toBe("41");
    expect(meta(path, "overrun_k:group")).toBe("2");
    expect(meta(path, "overrun_k:fill")).toBe("0");
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(0); // the stopped set's records went aside with it
    expect(await again.applyBatch([rec(1), rec(2), rec(3)])).toEqual({ status: "done" });
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(3);
    again.close();
  });
  it.skipIf(process.platform === "win32")("trigger A: a set-aside that cannot be moved exits(1) before any open; the main file and the marker stay at their live names and the next start finishes R", async () => {
    const d = dir(), path = join(d, "i.db"), index = await stopped(path), oldId = index.fileId;
    index.close();
    chmodSync(d, 0o555); // renames in this directory now fail (EACCES): the EBUSY / EPERM of 3.2.5
    try {
      await expect(MemoryIndex.create(path, { charge: grant(), reset: { resetId: 46, resets: 1, kind: "group" } })).rejects.toThrow("MEMW_TEST_EXIT 1");
    } finally { chmodSync(d, 0o755); }
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}-walstop`)).toBe(true);
    expect(readdirSync(d).some(f => f.includes(".corrupt-"))).toBe(false);
    const again = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 46, resets: 1, kind: "group" } });
    expect(again.opened()).toBe(true);
    expect(again.fileId).not.toBe(oldId);
    expect(again.resetDone()).toBe(46);
    again.close();
  });
  it("a kill after the marker unlink and before the commit (no marker, file has reset_done = R): the next start with R quarantines nothing and reports resetDone = R", async () => {
    const d = dir(), path = join(d, "i.db"), index = await stopped(path);
    index.close();
    const first = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 44, resets: 1, kind: "group" } });
    const id = first.fileId;
    first.close();
    removeStopMarker(path); // completeIndexReset step 2 ran, step 3 did not
    const second = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 44, resets: 1, kind: "group" } });
    expect(second.fileId).toBe(id);
    expect(second.rebuilt).toBe(false);
    expect(second.resetDone()).toBe(44);
    expect(second.opened()).toBe(true);
    second.close();
  });
  it("trigger B: stopped by index_meta with no marker, a start with R takes the damaged-file branch; without R the file stays stopped", async () => {
    const d = dir(), path = join(d, "i.db"), index = await stopped(path), oldId = index.fileId;
    index.close();
    removeStopMarker(path); // the marker lost outside our code
    const plain = await MemoryIndex.create(path, { charge: grant() });
    expect(plain.opened()).toBe(false);
    expect(plain.stopInfo()).toMatchObject({ fileId: oldId });
    plain.close();
    const again = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 45, resets: 1, kind: "group" } });
    expect(again.rebuilt).toBe(true);
    expect(again.opened()).toBe(true);
    expect(again.fileId).not.toBe(oldId);
    expect(again.resetDone()).toBe(45);
    again.close();
  });
  it("a start with R and kind unknown: overrun_k = OVERRUN_K_UNKNOWN for every kind in the new file's open txn (x8 everywhere)", async () => {
    const path = join(dir(), "i.db"), index = await stopped(path);
    index.close();
    const again = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 12, resets: 1, kind: "unknown" } });
    for (const kind of ["group", "fill", "keys", "stage_drop", "delete", "merge", "tier", "seal", "open", "stop"]) expect(meta(path, `overrun_k:${kind}`)).toBe(String(steps.OVERRUN_K_UNKNOWN));
    expect((again as unknown as { sizer: { rho(k: string): number } }).sizer.rho("fill")).toBeCloseTo(3.11 * 8, 9);
    expect(again.resetDone()).toBe(12);
    again.close();
  });
  it("a start with R on a writable file writes reset_done = R and overrun_k in its open txn; no quarantine, same file", async () => {
    const d = dir(), path = join(d, "i.db"), index = await MemoryIndex.create(path, { charge: grant() });
    const id = index.fileId;
    expect(index.resetDone()).toBeNull();
    index.close();
    const again = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 5, resets: 1, kind: "fill" } });
    expect(again.fileId).toBe(id);
    expect(again.resetDone()).toBe(5);
    expect(meta(path, "overrun_k:fill")).toBe("1");
    expect(readdirSync(d).some(f => f.includes(".corrupt-"))).toBe(false);
    again.close();
  });
  it("sealAndTruncate and prepareExit seal, write -walok and empty the log; never close", async () => {
    const path = join(dir(), "i.db"), index = await MemoryIndex.create(path, { charge: grant() });
    await index.applyBatch(Array.from({ length: 20 }, (_, i) => rec(i)));
    expect(await index.sealAndTruncate()).toEqual({ truncated: true });
    expect(existsSync(`${path}-walok`)).toBe(true);
    await index.applyBatch([rec(50)]);
    await index.prepareExit();
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(21);
    expect(index.search("alpha", [{ id: "memory:50", version: 1 }], null, "m").hits.length).toBe(1); // still open
    index.close();
  });
});

describe("r3.2.8 stop in place: the segment-limit stop, nothing written while a check is owed", () => {
  it("(a) a forced FTS_SEGMENT_LIMIT state stops (no raw rebuild, no TRUNCATE); a start with R rebuilds it writable", async () => {
    const path = join(dir(), "i.db"), index = await MemoryIndex.create(path, { charge: grant() });
    await index.applyBatch([rec(1), rec(2)]);
    const sql: string[] = [], db = (index as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db);
    db.exec = (q: string) => { sql.push(q); return exec(q); };
    const real = index.segmentCount.bind(index);
    index.segmentCount = () => 1950;
    core.walCheckpointModes(true);
    expect(await index.maintenanceStep()).toEqual({ ran: null });
    expect(index.stopInfo()).toMatchObject({ reason: "segment_limit:lexical", kind: "merge" });
    expect(core.walCheckpointModes().TRUNCATE).toBe(0);
    expect(sql.some(q => /rebuild|optimize|wal_checkpoint/i.test(q))).toBe(false);
    expect(await index.applyBatch([rec(3)])).toEqual({ status: "failed", reason: "wal-over", committed: 0 });
    index.segmentCount = real;
    index.close();
    const again = await MemoryIndex.create(path, { charge: grant(), reset: { resetId: 31, resets: 1, kind: "merge" } }); // the reset is a start that carries R
    expect(again.opened()).toBe(true);
    expect(await again.applyBatch([rec(1), rec(2), rec(3)])).toEqual({ status: "done" });
    again.close();
  });
  it("(b) with a check owed, no sub-step writes: scrub, rolled purge, recount, postings, merges all wait", async () => {
    const path = join(dir(), "i.db");
    let granted = true;
    const index = await MemoryIndex.create(path, { charge: c => { void c; return Promise.resolve(granted); } });
    await index.applyBatch([rec(1), rec(2), { ...rec(3), id: "checkpoint:a", version: 1 }, { ...rec(4), id: "checkpoint:a", version: 2 }]);
    await index.applyBatch([{ ...rec(1), deleted: true }]); // a forget: scrub debt + merge owed
    index.beginRolledPass();
    granted = false;
    await index.applyBatch([rec(9)]); // commits, its check refused: owed
    const c = coreOf(index), seq = c.seq;
    expect((c as unknown as { checkOwed(): boolean }).checkOwed()).toBe(true);
    for (let n = 0; n < 3; n++) expect(await index.maintenanceStep()).toEqual({ ran: null });
    expect(await index.scrubDeleted()).toBe(false);
    expect((await index.purgeRolledCheckpoints()).done).toBe(false);
    expect(await index.fillPostings()).toEqual({ done: false, filled: 0, busy: true });
    expect(await index.recountStep()).toBe(true); // nothing to recount: no write either way
    expect(await index.finishRewrite()).toBe(false);
    expect(c.seq).toBe(seq);
    granted = true;
    for (let n = 0; n < 50 && index.deletionScrubPending(); n++) await index.maintenanceStep();
    expect(index.deletionScrubPending()).toBe(false);
    expect(c.seq).toBeGreaterThan(seq);
    index.close();
  });
});

describe("one source for the shared constants (owner ruling)", () => {
  it("memw-steps re-exports index-wal's values and defines none of them itself", () => {
    const shared = ["MEMW_W_STEP_BYTES", "MEMW_W_MERGE_BYTES", "MEMW_C_BYTES", "MEMW_STEP_ADMIT_BYTES", "MEMW_TICK_TRUNCATE_BYTES", "MEMW_SEAL_FRAMES", "MEMW_HDR_RETRIES", "WAL_HEADER_BYTES"] as const;
    const source = readFileSync(new URL("./memw-steps.ts", import.meta.url), "utf8");
    for (const name of shared) {
      expect(source).not.toMatch(new RegExp(`(const|let|var)\\s+${name}\\s*=`));
      expect((steps as Record<string, unknown>)[name]).toBe((core as Record<string, unknown>)[name]);
    }
    expect(steps.MEMW_C_BYTES).toBe(28 * 1024 * 1024);
    expect(steps.OVERRUN_K_UNKNOWN).toBe(3);
    expect(steps.resetMultiplier(steps.overrunK(undefined))).toBe(8);
  });
});
