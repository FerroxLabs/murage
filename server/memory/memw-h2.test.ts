// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2a, r3.2.8-H.1 / H.2: A' (kind "open"), the trigger A holds-R guard, the whole-set probe's unsafe route, the opening flag on
// every charge. Rows: G1, G2, G3, G3c, G5, K-KILL-A and the opening flag. Controller rows (H*, G4, G6, G7, K-KILL-A2) live with WP3.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { walTestHooks, type WalCharge } from "./index-wal.ts";
import { probeIndexFile } from "./index-quarantine.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-h2-")); dirs.push(d); return d; };
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Error(`MEMW_TEST_EXIT ${code}`); }; walTestHooks.chargeAckMs = 200; });
afterEach(() => { for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key]; for (const d of dirs.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const meta = (path: string, key: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { const r = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return r ? String(r.value) : undefined; } finally { db.close(); } };
const count = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(sql).get()!.n); } finally { db.close(); } };
const rec = (i: number): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: `scope:${i % 5}`, text: `words of record ${i} alpha`, deleted: false });
const grant = (seen: WalCharge[] = []) => (c: WalCharge) => { seen.push(c); return Promise.resolve(true); };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sets = (d: string) => readdirSync(d).filter(f => /\.corrupt-\d+$/.test(f));
/** A finished open removes every set-aside copy (index.ts init: removeIndexQuarantines), so a start's copies are read at its first open txn. */
type Seen = { sets: string[]; links: string[] };
const observe = (d: string): Seen[] => {
  const seen: Seen[] = [];
  (walTestHooks as { afterFirstOpenTxn?: () => void }).afterFirstOpenTxn = () => {
    const names = readdirSync(d);
    seen.push({ sets: names.filter(f => /\.corrupt-\d+$/.test(f)), links: names.filter(n => lstatSync(join(d, n)).isSymbolicLink()) });
  };
  return seen;
};
const tick =() => new Promise<void>(resolve => setTimeout(resolve, 5)); // a set-aside name is `.corrupt-<ms>`: two moves never share a millisecond
type Core = { stop(reason: string, kind: string, seq: number): never; seq: number };
const coreOf = (index: MemoryIndex) => (index as unknown as { core: Core }).core;
/** A stopped index (the real durable stop), closed: the main file with its stop marker beside it. */
async function stoppedFile(path: string) {
  const index = await MemoryIndex.create(path, { charge: grant() });
  await index.applyBatch([rec(1), rec(2)]);
  try { coreOf(index).stop("test_overrun", "group", coreOf(index).seq); } catch { /* WalStop */ }
  index.close();
}
const R = (resetId: number, kind: "open" | "group" = "open") => ({ resetId, resets: 1, kind });

describe("A' (H.1 7): a start that carries R with kind open", () => {
  it("G1: a damaged file (64 KiB of noise) is set aside once and R completes into a fresh file; a healthy file through the same start is not moved", async () => {
    const d = dir(), path = join(d, "i.db");
    writeFileSync(path, Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 2654435761) >>> 24)));
    const seen = observe(d);
    const index = await MemoryIndex.create(path, { charge: grant(), reset: R(7) });
    expect(index.opened()).toBe(true);
    expect(index.rebuilt).toBe(true);
    expect(index.resetDone()).toBe(7);
    expect(seen[0]!.sets).toHaveLength(1);
    expect(await index.applyBatch([rec(1), rec(2)])).toEqual({ status: "done" });
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(2);
    index.close();
    // control: a healthy file through the same start
    const d2 = dir(), healthy = join(d2, "i.db");
    const first = await MemoryIndex.create(healthy, { charge: grant() });
    await first.applyBatch([rec(1), rec(2), rec(3)]);
    first.close();
    const seen2 = observe(d2);
    const again = await MemoryIndex.create(healthy, { charge: grant(), reset: R(8) });
    expect(again.opened()).toBe(true);
    expect(again.rebuilt).toBe(false);
    expect(seen2[0]!.sets).toHaveLength(0);
    expect(again.resetDone()).toBe(8);
    expect(count(healthy, "SELECT count(*) AS n FROM entries")).toBe(3);
    again.close();
  });
  it.skipIf(process.platform === "win32")("G2: a set-aside that cannot be moved exits(1) with no move; with the fault cleared, one copy and R done; a plain open (no fault) takes one attempt", async () => {
    for (const fixture of ["link"]) {
      const d = dir(), path = join(d, "i.db");
      if (fixture === "damaged") writeFileSync(path, Buffer.alloc(8192, 7)); else { const target = join(dir(), "target"); writeFileSync(target, "x"); symlinkSync(target, path); }
      chmodSync(d, 0o555);
      try { await expect(MemoryIndex.create(path, { charge: grant(), reset: R(9) })).rejects.toThrow("MEMW_TEST_EXIT 1"); }
      finally { chmodSync(d, 0o755); }
      expect(readdirSync(d)).toEqual(["i.db"]); // nothing moved, the link or file still at its live name
      expect(sets(d)).toHaveLength(0);
      const seen = observe(d);
      const index = await MemoryIndex.create(path, { charge: grant(), reset: R(9) });
      expect(index.opened()).toBe(true);
      expect(index.resetDone()).toBe(9);
      expect(seen[0]!.sets).toHaveLength(1);
      index.close();
    }
  });
  it.skipIf(process.platform === "win32")("G3: a live link and a dangling link at the path are each set aside (the link moves, never its target); a regular healthy file is not moved", async () => {
    for (const dangling of [false, true]) {
      const d = dir(), outside = join(dir(), "target.db"), path = join(d, "i.db");
      let before = "";
      if (!dangling) {
        const seed = await MemoryIndex.create(outside, { charge: grant() });
        await seed.applyBatch([rec(1)]);
        seed.close();
        before = sha(outside);
      }
      symlinkSync(outside, path);
      const seen = observe(d);
      const index = await MemoryIndex.create(path, { charge: grant(), reset: R(11) });
      expect(index.opened()).toBe(true);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(seen[0]!.sets).toHaveLength(1);
      expect(seen[0]!.links).toEqual(seen[0]!.sets); // the link itself moved aside
      if (!dangling) expect(sha(outside)).toBe(before);
      else expect(existsSync(outside)).toBe(false);
      index.close();
    }
  });
  it.skipIf(process.platform === "win32")("G3c: a healthy main file with a link at -wal reads unsafe and the whole set goes aside, target unchanged; the same with the stop marker present (trigger A)", async () => {
    for (const marker of [false, true]) {
      const d = dir(), outside = join(dir(), "outside-wal"), path = join(d, "i.db");
      writeFileSync(outside, "outside-content");
      if (marker) await stoppedFile(path);
      else { const seed = await MemoryIndex.create(path, { charge: grant() }); await seed.applyBatch([rec(1)]); seed.close(); }
      rmSync(`${path}-wal`, { force: true });
      symlinkSync(outside, `${path}-wal`);
      const seen = observe(d);
      const index = await MemoryIndex.create(path, { charge: grant(), reset: R(12, marker ? "group" : "open") });
      expect(index.opened()).toBe(true);
      expect(index.resetDone()).toBe(12);
      expect(seen[0]!.sets).toHaveLength(1);
      expect(seen[0]!.links).toContain(`${seen[0]!.sets[0]}-wal`);
      expect(readFileSync(outside, "utf8")).toBe("outside-content");
      index.close();
    }
  });
  it.skipIf(process.platform === "win32")("G6 (A' side): a healthy file held by an outside writer reads busy: exit(1), no move; released, it reads healthy", async () => {
    const d = dir(), path = join(d, "i.db");
    const seed = await MemoryIndex.create(path, { charge: grant() });
    await seed.applyBatch([rec(1)]);
    seed.close();
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA locking_mode=EXCLUSIVE");
    holder.prepare("SELECT count(*) AS n FROM entries").get(); // the first read takes the exclusive lock; nothing is written
    try {
      await expect(MemoryIndex.create(path, { charge: grant(), reset: R(15) })).rejects.toThrow("MEMW_TEST_EXIT 1");
      expect(existsSync(path)).toBe(true);
      expect(sets(d)).toHaveLength(0);
    } finally { holder.close(); }
    expect(probeIndexFile(path, 15)).toBe("healthy"); // released: the file reads healthy again, never damaged
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(1);
  });
  it("G5: a file that already holds this R is kept (no move) and reported rebuilt, so every record stays owed", async () => {
    const d = dir(), path = join(d, "i.db");
    const first = await MemoryIndex.create(path, { charge: grant(), reset: R(13) });
    expect(first.resetDone()).toBe(13);
    first.close();
    const seen = observe(d);
    const again = await MemoryIndex.create(path, { charge: grant(), reset: R(13) });
    expect(again.opened()).toBe(true);
    expect(again.rebuilt).toBe(true);
    expect(seen[0]!.sets).toHaveLength(0);
    again.close();
    // control: a different R on the same healthy file is not moved either, and is not reported rebuilt
    const other = await MemoryIndex.create(path, { charge: grant(), reset: R(14) });
    expect(other.rebuilt).toBe(false);
    expect(seen[1]!.sets).toHaveLength(0);
    other.close();
  });
});

describe("trigger A holds-R guard (H.2 1)", () => {
  async function killedAfterFirstOpenTxn(path: string, resetId: number) {
    (walTestHooks as { afterFirstOpenTxn?: () => void }).afterFirstOpenTxn = () => {
      expect(meta(path, "reset_done")).toBe(String(resetId)); // the first open txn already holds R
      throw new Error("MEMW_TEST_KILL");
    };
    await expect(MemoryIndex.create(path, { charge: grant(), reset: R(resetId, "group") })).rejects.toThrow("MEMW_TEST_KILL");
    delete (walTestHooks as { afterFirstOpenTxn?: () => void }).afterFirstOpenTxn;
  }
  it("K-KILL-A: killed after the fresh file's first open txn, the restart finds holds-R: exactly one set-aside across both starts, R done; control: no kill, one set-aside", async () => {
    const d = dir(), path = join(d, "i.db");
    await stoppedFile(path);
    await killedAfterFirstOpenTxn(path, 41);
    expect(sets(d)).toHaveLength(1);
    expect(existsSync(`${path}-walstop`)).toBe(true);
    await tick();
    const seen = observe(d);
    const again = await MemoryIndex.create(path, { charge: grant(), reset: R(41, "group") });
    expect(again.opened()).toBe(true);
    expect(again.rebuilt).toBe(true);
    expect(again.resetDone()).toBe(41);
    expect(seen[0]!.sets).toHaveLength(1); // still the first start's single set: the fresh file was kept
    expect(await again.applyBatch([rec(1)])).toEqual({ status: "done" });
    again.close();
    // control: no kill
    const d2 = dir(), path2 = join(d2, "i.db");
    await stoppedFile(path2);
    const seen2 = observe(d2);
    const plain = await MemoryIndex.create(path2, { charge: grant(), reset: R(42, "group") });
    expect(plain.resetDone()).toBe(42);
    expect(seen2[0]!.sets).toHaveLength(1);
    plain.close();
  });
});

describe("the opening flag (H.1 1)", () => {
  it("every charge before the open passes carries opening: true; a charge after it carries opening: false", async () => {
    const d = dir(), path = join(d, "i.db"), seen: Array<WalCharge & { opening?: boolean }> = [];
    const index = await MemoryIndex.create(path, { charge: grant(seen) });
    expect(index.opened()).toBe(true);
    const during = seen.length;
    expect(during).toBeGreaterThan(0);
    expect(seen.every(c => c.opening === true)).toBe(true);
    await index.applyBatch(Array.from({ length: 40 }, (_, i) => rec(i)));
    await index.sealAndTruncate();
    const after = seen.slice(during);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(c => c.opening === false)).toBe(true);
    index.close();
  });
});
