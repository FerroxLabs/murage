// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.0.18 Part A WP1: the checked write path (index-wal.ts): F1, T2(8a)-(8e), C, charge-first over IPC (r3.2.2 D1, T14).
// Throwaway temp dirs only; the charge transport is injected.
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { helperRunId, IndexWalWriter, MEMW_C_BYTES, MEMW_W_STEP_BYTES, openIndexWal, parseWalHeader, readWalHeader, sameGeneration, walCheckpointModes, WalStop, walTestHooks, WalUnresolved, type ChargeTransport, type OpenedIndexWal, type WalCharge } from "./index-wal.ts";
import { walIndexReader } from "../io-written.ts";

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const roots: string[] = [];
// One -shm reader per path, kept open until every SQLite handle on that inode is closed (closing any descriptor on the shm drops this process's POSIX locks on it).
const frameReaders = new Map<string, ReturnType<typeof walIndexReader>>();
const frames = (path: string) => { let r = frameReaders.get(path); if (!r) { r = walIndexReader(path); frameReaders.set(path, r); } return r()?.mxFrame ?? -1; };
const closeFrameReaders = () => { for (const r of frameReaders.values()) { try { r.close(); } catch { /* closed */ } } frameReaders.clear(); };
const opened: OpenedIndexWal[] = [];
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Exited(code); }; });
afterEach(() => {
  for (const key of Object.keys(walTestHooks) as Array<keyof typeof walTestHooks>) delete walTestHooks[key];
  for (const o of opened.splice(0)) { try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ } }
  closeFrameReaders();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
function fresh(): string { const root = mkdtempSync(join(tmpdir(), "memw-wal-")); roots.push(root); return join(root, "memory-index.db"); }
/** A controller stand-in: records every charge it receives, grants unless told otherwise. */
function controller(answer: (c: WalCharge) => Promise<boolean> | boolean = () => true): ChargeTransport & { received: WalCharge[] } {
  const received: WalCharge[] = [];
  const transport = async (c: WalCharge) => { received.push(c); return answer(c); };
  return Object.assign(transport, { received });
}
async function open(path: string, charge: ChargeTransport = controller()): Promise<OpenedIndexWal> {
  const o = openIndexWal(path, { charge }); opened.push(o);
  if (o.verdict.state !== "stopped") o.verdict = await o.wal.openCheck();
  return o;
}
const MB = 1024 * 1024;
/** Writes about `bytes` of row data (4,000 B rows, about one per page) into table t inside a checked write, then its check. */
async function fill(o: OpenedIndexWal, kind: "fill" | "open" | "delete", reserve: number, bytes: number): Promise<void> {
  o.wal.write(kind, reserve, () => {
    o.writable.exec("CREATE TABLE IF NOT EXISTS t(x BLOB)");
    const put = o.writable.prepare("INSERT INTO t VALUES(randomblob(?))");
    for (let left = bytes; left > 0; left -= 4000) put.run(Math.min(4000, left));
  });
  await o.wal.check();
}

const Fz = (o: OpenedIndexWal) => o.wal.pageSize + 24;
/** Grows the log to about `mb` MB in 3 MB open writes (each within its 4 MiB reserve). */
async function grow(o: OpenedIndexWal, mb: number): Promise<void> {
  for (let i = 0; o.wal.L() < mb * MB; i++) { if (i > 20) throw new Error("log does not grow: hold a reader"); await fill(o, "open", 4 * MB, 3 * MB); }
}
/** A reader snapshot that pins the log (no restart, partial PASSIVE) until released. */
function pin(path: string): () => void {
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM sqlite_schema").get();
  return () => { try { reader.exec("COMMIT"); } finally { reader.close(); } };
}

/** A valid WAL header with the given checkpoint sequence and salts (checksum as SQLite computes it for the little-endian magic). */
function header(nCkpt: number, salt1: number, salt2: number): Buffer {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(0x377f0682, 0); raw.writeUInt32BE(3007000, 4); raw.writeUInt32BE(4096, 8);
  raw.writeUInt32BE(nCkpt, 12); raw.writeUInt32BE(salt1, 16); raw.writeUInt32BE(salt2, 20);
  let s0 = 0, s1 = 0;
  for (let i = 0; i < 24; i += 8) { s0 = (s0 + raw.readUInt32LE(i) + s1) >>> 0; s1 = (s1 + raw.readUInt32LE(i + 4) + s0) >>> 0; }
  raw.writeUInt32BE(s0, 24); raw.writeUInt32BE(s1, 28);
  return raw;
}

it("F1: the generation compare takes every byte of 12-23: salt-1 equal with nCkpt or salt-2 different is a new generation", () => {
  const a = parseWalHeader(header(5, 0x11111111, 0x22222222));
  const nckpt = parseWalHeader(header(6, 0x11111111, 0x22222222));
  const salt2 = parseWalHeader(header(5, 0x11111111, 0x33333333));
  expect(a.valid && nckpt.valid && salt2.valid).toBe(true);
  expect(sameGeneration(a.id, a.id)).toBe(true);
  expect(sameGeneration(a.id, nckpt.id)).toBe(false);
  expect(sameGeneration(a.id, salt2.id)).toBe(false);
  expect(sameGeneration(null, null)).toBe(false);
  // Base 32 B when the generation differs: a 10 MB base is never kept, so a breach after a restart is seen.
  const Lb = 10 * MB, Lafter = 13 * MB;
  expect(Lafter - (sameGeneration(a.id, salt2.id) ? Lb : 32) > MEMW_W_STEP_BYTES).toBe(true);
  const bad = header(5, 1, 2); bad[27] ^= 1;
  expect(parseWalHeader(bad).valid).toBe(false);
});

it("a write carries wal_check in its own txn, leaves the check owed, and check() charges first then runs one PASSIVE", async () => {
  const path = fresh(), ctl = controller(), o = await open(path, ctl);
  expect(o.verdict).toEqual({ state: "writable" });
  expect(ctl.received).toHaveLength(1); // the open rule's PASSIVE
  walCheckpointModes(true);
  o.wal.write("open", 4 * MB, () => { o.writable.exec("CREATE TABLE t(x BLOB); INSERT INTO t VALUES(randomblob(100000))"); });
  expect(o.wal.checkOwed()).toBe(true);
  expect(o.wal.admit("fill", 1)).toBe(false);
  expect(() => o.wal.write("fill", 1, () => undefined)).toThrow(WalUnresolved);
  expect(walCheckpointModes()).toEqual({ PASSIVE: 0, TRUNCATE: 0 });
  await o.wal.check();
  expect(o.wal.checkOwed()).toBe(false);
  expect(walCheckpointModes()).toEqual({ PASSIVE: 1, TRUNCATE: 0 });
  expect(ctl.received.map(c => c.attempt)).toEqual([1, 2]);
  expect(ctl.received[1]).toMatchObject({ fileId: o.wal.fileId.toString() });
  expect(ctl.received[1].bytes).toBe(frames(path) * o.wal.pageSize); // (log_p - confirmed) x page_size, nothing copied yet
  const row = JSON.parse(String(o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get()?.value));
  expect(row).toMatchObject({ seq: 1, Lb: 32, idb: null, kind: "open" });
  expect(o.writable.prepare("SELECT value FROM index_meta WHERE key='file_id'").get()?.value).toBe(o.wal.fileId.toString());
  for (const p of ["journal_size_limit", "cache_spill", "wal_autocheckpoint"]) expect(Object.values(o.writable.prepare(`PRAGMA ${p}`).get()!)[0]).toBe(0);
  expect(o.wal.L()).toBe(32 + frames(path) * Fz(o));
});

it("8a S1: a 3 MB fill at Lb 10 MB behind a reader (partial PASSIVE) rises by its own frames x Fz, no OVERRUN", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM t").get();
  try {
    await grow(o, 10);
    const Lb = o.wal.L(), before = frames(path);
    await fill(o, "fill", MEMW_W_STEP_BYTES, 3 * MB);
    expect(o.wal.stopped).toBe(false);
    expect(o.wal.L() - Lb).toBe((frames(path) - before) * Fz(o));
    expect(o.wal.L()).toBeGreaterThan(13 * MB);
  } finally { reader.exec("COMMIT"); reader.close(); }
});

it("8b S2: full PASSIVE with no reader at Lb 10 MB, then a 13 MB fill: the restart's new generation takes base 32 B -> OVERRUN", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const release = pin(path);
  await grow(o, 10);
  release();
  await fill(o, "fill", MEMW_W_STEP_BYTES, 4000); // its PASSIVE now copies the whole log: no reader, the next write restarts it
  expect(o.wal.L()).toBeGreaterThan(10 * MB);
  await expect(fill(o, "fill", MEMW_W_STEP_BYTES, 13 * MB)).rejects.toThrow(WalStop);
  expect(o.wal.stopped).toBe(true);
  expect(existsSync(`${path}-walstop`)).toBe(true);
  expect(String(o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_over_stop'").get()?.value)).toContain("\"kind\":\"fill\"");
  expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => undefined)).toThrow(WalStop);
});

it("8d S4: the only checkpoint modes are PASSIVE and the TRUNCATE inside sealAndTruncate", async () => {
  const o = await open(fresh());
  walCheckpointModes(true);
  await fill(o, "open", 4 * MB, 50_000);
  await fill(o, "fill", 4 * MB, 50_000);
  expect(walCheckpointModes()).toEqual({ PASSIVE: 2, TRUNCATE: 0 });
  expect(await o.wal.sealAndTruncate()).toEqual({ truncated: true });
  expect(walCheckpointModes()).toEqual({ PASSIVE: 3, TRUNCATE: 1 });
});

it("8e S5: after sealAndTruncate the next write's rise is exactly its frames x Fz from 32 B", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 2 * MB);
  expect((await o.wal.sealAndTruncate()).truncated).toBe(true);
  expect(o.wal.L()).toBe(32);
  expect(statSync(`${path}-wal`).size).toBe(0);
  await fill(o, "fill", MEMW_W_STEP_BYTES, 1 * MB);
  expect(o.wal.L() - 32).toBe(frames(path) * Fz(o));
  expect(readWalHeader(path)?.valid).toBe(true);
});

it("L > C is an OVERRUN even within the reserve; admission refuses before it", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM t").get();
  try {
    await grow(o, 22);
    expect(o.wal.admit("open", 7 * MB)).toBe(false); // L + reserve + S > C
    await expect(fill(o, "open", 12 * MB, 7 * MB)).rejects.toThrow(WalStop);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(MEMW_C_BYTES);
  } finally { reader.exec("COMMIT"); reader.close(); }
});

it("a sealed and closed index reopens writable with its file_id (open (e): -walok of the newest seal)", async () => {
  const path = fresh(), a = await open(path);
  await fill(a, "open", 4 * MB, 10_000);
  expect((await a.wal.sealAndTruncate()).truncated).toBe(true);
  const id = a.wal.fileId;
  (a.wal as IndexWalWriter).closeForQuarantine(); opened.splice(0);
  const b = await open(path);
  expect(b.verdict).toEqual({ state: "writable" });
  expect(b.wal.fileId).toBe(id);
});

it("T14: two partial-copy failures, then a kill after the third charge was sent and before its ack: all 3 charged, the 3rd never ran", async () => {
  const path = fresh();
  let hold = false;
  const ctl = controller(() => hold ? new Promise<boolean>(() => { /* never acked: the helper is killed */ }) : true);
  const o = await open(path, ctl);
  o.wal.write("open", 4 * MB, () => { o.writable.exec("CREATE TABLE t(x BLOB); INSERT INTO t VALUES(randomblob(200000))"); });
  let attempts = 0;
  walTestHooks.checkpoint = () => { attempts++; return { busy: 0, log: -1, checkpointed: -1 }; }; // a failed attempt: no usable counts
  const before = ctl.received.length;
  await o.wal.check(); await o.wal.check();
  expect(attempts).toBe(2);
  expect(o.wal.checkOwed()).toBe(true);
  hold = true;
  walTestHooks.chargeAckMs = 50;
  await o.wal.check(); // the ack never comes: no attempt
  expect(attempts).toBe(2);
  const charged = ctl.received.slice(before);
  expect(charged).toHaveLength(3);
  const full = frames(path) * o.wal.pageSize;
  expect(charged.map(c => c.bytes)).toEqual([full, full, full]); // zero WAL growth, each failure charged in full
  expect(o.wal.checkOwed()).toBe(true);
});

it("a refused or unanswered charge runs no checkpoint and leaves writes refused (the start stall); a later grant settles it", async () => {
  const path = fresh();
  let grant = true;
  const ctl = controller(() => grant);
  const o = await open(path, ctl);
  o.wal.write("open", 4 * MB, () => { o.writable.exec("CREATE TABLE t(x)"); });
  grant = false;
  walCheckpointModes(true);
  await o.wal.check();
  expect(walCheckpointModes().PASSIVE).toBe(0);
  expect(o.wal.checkOwed()).toBe(true);
  expect(o.wal.admit("fill", 1)).toBe(false);
  expect(o.wal.stopped).toBe(false);
  grant = true;
  await o.wal.check();
  expect(o.wal.checkOwed()).toBe(false);
  expect(walCheckpointModes().PASSIVE).toBe(1);
});

it("a refused charge at open leaves the verdict unresolved; the next tick's grant opens writable", async () => {
  const path = fresh();
  let grant = false;
  const o = openIndexWal(path, { charge: async () => grant }); opened.push(o);
  expect(o.verdict).toEqual({ state: "unresolved", reason: "open_check_owed" });
  expect(await o.wal.openCheck()).toEqual({ state: "unresolved", reason: "open_check_owed" });
  expect(() => o.wal.write("open", 1, () => undefined)).toThrow(WalUnresolved);
  grant = true;
  expect(await o.wal.openCheck()).toEqual({ state: "writable" });
});

it("T14h (A2'): every charge carries the helper run id; a helper-only restart reuses attempt numbers on the same fileId and a surviving controller debits each new attempt afresh, keyed (helperRunId, fileId, attempt)", async () => {
  expect(helperRunId()).toMatch(/^[0-9a-f]{16}$/);
  expect(helperRunId()).toBe(helperRunId());
  const debits = new Map<string, number>();
  const ctl = controller(c => { const key = `${c.helperRunId}:${c.fileId}:${c.attempt}`; if (!debits.has(key)) debits.set(key, c.bytes); return true; });
  walTestHooks.helperRunId = "run-1";
  const path = fresh(), o = await open(path, ctl);
  await fill(o, "open", 4 * MB, 100_000);
  const first = ctl.received.slice();
  // The helper dies (nothing closed) and starts again; the controller survives.
  walTestHooks.helperRunId = "run-2";
  const r = await open(path, ctl);
  await fill(r, "open", 4 * MB, 100_000);
  const second = ctl.received.slice(first.length);
  expect(first.length).toBeGreaterThan(0);
  expect(first.every(c => c.helperRunId === "run-1")).toBe(true);
  expect(second.every(c => c.helperRunId === "run-2")).toBe(true);
  expect(second.every(c => c.fileId === first[0]!.fileId)).toBe(true);
  expect(second.map(c => c.attempt)).toEqual(first.map(c => c.attempt)); // the numbers are reused
  expect(debits.size).toBe(first.length + second.length); // and every attempt is its own debit
});
