// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2a: MemoryIndex.create()/init() on the real WAL core (index-wal.ts, WP1): the IPC charge transport, file_id in the
// first `open` txn, no index write before the open rule passes (T14e(i)), an ack stall after one admitted txn refuses every later write
// (T14e(ii)), and every pending record indexed after recovery.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { walTestHooks, type WalCharge } from "./index-wal.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-wp2a-")); dirs.push(d); return d; };
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Error(`MEMW_TEST_EXIT ${code}`); }; walTestHooks.chargeAckMs = 200; });
afterEach(() => { for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key]; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const meta = (path: string, key: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { const r = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return r ? String(r.value) : undefined; } finally { db.close(); } };
const count = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(sql).get()!.n); } finally { db.close(); } };
const tableExists = (path: string, name: string) => { if (!existsSync(path)) return false; const db = new DatabaseSync(path, { readOnly: true }); try { return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name)); } finally { db.close(); } };
const rec = (i: number, extra: Partial<IndexedMemory> = {}): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: `scope:${i % 5}`, text: `words of record ${i} alpha`, deleted: false, ...extra });
/** The controller side of the charge (WP3 owns it): records every charge, answers with `grant`. */
function controller(grant: () => boolean | "hang" = () => true) {
  const seen: WalCharge[] = [];
  return { seen, charge: (c: WalCharge) => { seen.push(c); const g = grant(); return g === "hang" ? new Promise<boolean>(() => {}) : Promise.resolve(g); } };
}

describe("create()/init(): the charge path on the real IndexWal", () => {
  it("a fresh file opens writable; every checkpoint attempt is charged first over the transport; file_id lands in the first open txn", async () => {
    const path = join(dir(), "i.db"), ctl = controller();
    const index = await MemoryIndex.create(path, { charge: ctl.charge });
    expect(index.opened()).toBe(true);
    expect(index.fileId).toMatch(/^\d+$/);
    expect(meta(path, "file_id")).toBe(index.fileId);
    const afterOpen = ctl.seen.length;
    expect(afterOpen).toBeGreaterThanOrEqual(3); // open rule PASSIVE, the open txn's check, the seal's check + TRUNCATE
    expect(await index.applyBatch(Array.from({ length: 40 }, (_, i) => rec(i)))).toEqual({ status: "done" });
    expect(ctl.seen.length).toBeGreaterThan(afterOpen); // each group's check charged before its PASSIVE
    expect(new Set(ctl.seen.map(c => c.fileId))).toEqual(new Set([index.fileId]));
    ctl.seen.forEach((c, n) => { expect(c.attempt).toBe(n + 1); expect(Number.isInteger(c.bytes) && c.bytes >= 0).toBe(true); });
    expect(ctl.seen.some(c => c.bytes > 0)).toBe(true);
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(40);
    expect(index.search("alpha", [{ id: "memory:3", version: 1 }], null, "m").hits.map(h => h.id)).toEqual(["memory:3"]);
    index.close();
  });
  it("T14e(i) startup stall: no index write before openCheck returns writable; records indexed once acks flow", async () => {
    const path = join(dir(), "i.db");
    let grant = false;
    const ctl = controller(() => grant);
    const index = await MemoryIndex.create(path, { charge: ctl.charge });
    expect(index.opened()).toBe(false);
    expect(ctl.seen.length).toBe(1); // the open rule's PASSIVE charge, refused: no attempt ran
    expect(tableExists(path, "entries")).toBe(false);
    expect(tableExists(path, "index_meta")).toBe(false);
    expect(existsSync(`${path}-walattempt`)).toBe(false);
    expect(await index.applyBatch([rec(1)])).toEqual({ status: "failed", reason: "check-owed", committed: 0 });
    expect(index.search("alpha", [{ id: "memory:1", version: 1 }], null, "m").hits).toEqual([]);
    expect(await index.maintenanceStep()).toMatchObject({ ran: null });
    expect(tableExists(path, "entries")).toBe(false);
    grant = true;
    expect(await index.maintenanceStep()).toMatchObject({ ran: "open", gateClear: true });
    expect(index.opened()).toBe(true);
    expect(await index.applyBatch([rec(1), rec(2)])).toEqual({ status: "done" });
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(2);
    index.close();
  });
  it("T14e(ii) ack timeout after ONE admitted txn: every later write refused until that check passes; nothing lost", async () => {
    const path = join(dir(), "i.db");
    let mode: boolean | "hang" = true;
    const ctl = controller(() => mode);
    const index = await MemoryIndex.create(path, { charge: ctl.charge });
    mode = "hang";
    // group 1 commits, its check times out: it is not reported committed (receipts stay pending; the replay is idempotent by key)
    expect(await index.applyBatch(Array.from({ length: 20 }, (_, i) => rec(i)))).toEqual({ status: "failed", reason: "check-owed", committed: 0 });
    const inFile = count(path, "SELECT count(*) AS n FROM entries");
    expect(inFile).toBeGreaterThan(0);
    expect(await index.applyBatch([rec(100)])).toEqual({ status: "failed", reason: "check-owed", committed: 0 });
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(inFile); // no second write while the check is owed
    mode = true;
    await index.maintenanceStep(); // the owed check passes
    expect(await index.applyBatch([...Array.from({ length: 20 }, (_, i) => rec(i)), rec(100)])).toEqual({ status: "done" });
    expect(count(path, "SELECT count(*) AS n FROM entries")).toBe(21);
    index.close();
  });
  it("a reopen of the same file keeps its file_id and opens writable (the rule passes on its own sealed file)", async () => {
    const path = join(dir(), "i.db"), ctl = controller();
    const index = await MemoryIndex.create(path, { charge: ctl.charge });
    await index.applyBatch([rec(1)]);
    const id = index.fileId;
    await index.prepareExit(); // seal + -walok + TRUNCATE: a close without it is S13 (non-seal, log gone) and the next open stops
    index.close();
    const again = await MemoryIndex.create(path, { charge: ctl.charge });
    expect(again.opened()).toBe(true);
    expect(again.fileId).toBe(id);
    expect(again.entriesLive()).toBe(1);
    again.close();
  });
});
