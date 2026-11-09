// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.0.18 Part A WP1: state table T2(8f)-(8u), S20-S24, T14e (helper half), T14f. A "kill" leaves the connections open and
// unclosed (no close checkpoint, as a real exit), and the next open runs in the same process. Throwaway temp dirs only.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { MOVED_SUFFIXES, quarantineIndex, removeIndexQuarantines, removeStopMarker } from "./index-quarantine.ts";
import { INDEX_FILE_SUFFIXES, IndexWalWriter, MEMW_C_BYTES, MEMW_W_STEP_BYTES, openIndexWal, readSidecar, readWalHeader, runOpenRuleForDowngrade, walCheckpointModes, WalStop, walTestHooks, WalUnresolved, writeSidecar, type ChargeTransport, type OpenedIndexWal } from "./index-wal.ts";
import { walIndexReader } from "../io-written.ts";

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const roots: string[] = [];
// One -shm reader per path, kept open until every SQLite handle on that inode is closed (closing any descriptor on the shm drops this process's POSIX locks on it).
const frameReaders = new Map<string, ReturnType<typeof walIndexReader>>();
const frames = (path: string) => { let r = frameReaders.get(path); if (!r) { r = walIndexReader(path); frameReaders.set(path, r); } return r()?.mxFrame ?? -1; };
const closeFrameReaders = () => { for (const r of frameReaders.values()) { try { r.close(); } catch { /* closed */ } } frameReaders.clear(); };
const live: OpenedIndexWal[] = [];
const killed: OpenedIndexWal[] = [];
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Exited(code); }; });
afterEach(() => {
  for (const key of Object.keys(walTestHooks) as Array<keyof typeof walTestHooks>) delete walTestHooks[key];
  for (const o of [...live.splice(0), ...killed.splice(0)]) { try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ } }
  closeFrameReaders();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const MB = 1024 * 1024;
const grant: ChargeTransport = async () => true;
function fresh(): string { const root = mkdtempSync(join(tmpdir(), "memw-state-")); roots.push(root); return join(root, "memory-index.db"); }
async function open(path: string, charge: ChargeTransport = grant): Promise<OpenedIndexWal> {
  const o = openIndexWal(path, { charge }); live.push(o);
  if (o.verdict.state !== "stopped") o.verdict = await o.wal.openCheck();
  return o;
}
/** A kill: nothing closed, nothing sealed; the handles stay open until the test ends. */
function kill(o: OpenedIndexWal): void { live.splice(live.indexOf(o), 1); killed.push(o); }
/** Windows refuses to unlink an -shm whose handles are open (EBUSY): there the killed handles are closed first (writable first, so no
 * close checkpoint) and the unlink tolerates a file the close already removed. Elsewhere the handles stay open, as a real kill leaves them. */
function removeShm(path: string, o: OpenedIndexWal): void {
  if (process.platform === "win32") {
    const at = killed.indexOf(o); if (at >= 0) killed.splice(at, 1);
    const reader = frameReaders.get(path); if (reader) { try { reader.close(); } catch { /* closed */ } frameReaders.delete(path); } // the frames() reader holds the -shm too
    try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ }
  }
  try { unlinkSync(`${path}-shm`); } catch (error) { if (process.platform !== "win32" || (error as { code?: string }).code !== "ENOENT") throw error; }
}
async function fill(o: OpenedIndexWal, kind: "fill" | "open" | "delete", reserve: number, bytes: number): Promise<void> {
  o.wal.write(kind, reserve, () => rows(o.writable, bytes));
  await o.wal.check();
}
function rows(db: DatabaseSync, bytes: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS t(x BLOB)");
  const put = db.prepare("INSERT INTO t VALUES(randomblob(?))");
  for (let left = bytes; left > 0; left -= 4000) put.run(Math.min(4000, left));
}
function pin(path: string): () => void {
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM sqlite_schema").get();
  return () => { try { reader.exec("COMMIT"); } finally { reader.close(); } };
}

const walLen = (path: string) => { try { return statSync(`${path}-wal`).size; } catch { return 0; } };
const meta = (o: OpenedIndexWal, key: string) => o.writable.prepare("SELECT value FROM index_meta WHERE key=?").get(key)?.value as string | undefined;
const newestSeq = (o: OpenedIndexWal) => JSON.parse(String(meta(o, "wal_check"))).seq as number;
/** Extends the -wal by `bytes` past its end as a spilled, never-committed attempt does; writes a valid header when the log is empty. */
function spill(path: string, bytes: number): void {
  const len = walLen(path);
  truncateSync(`${path}-wal`, len + bytes);
  if (len >= 32) return;
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(0x377f0682, 0); raw.writeUInt32BE(3007000, 4); raw.writeUInt32BE(4096, 8);
  raw.writeUInt32BE(9, 12); raw.writeUInt32BE(0x0badf00d, 16); raw.writeUInt32BE(0x12345678, 20);
  let s0 = 0, s1 = 0;
  for (let i = 0; i < 24; i += 8) { s0 = (s0 + raw.readUInt32LE(i) + s1) >>> 0; s1 = (s1 + raw.readUInt32LE(i + 4) + s0) >>> 0; }
  raw.writeUInt32BE(s0, 24); raw.writeUInt32BE(s1, 28);
  const fd = openSync(`${path}-wal`, "r+"); try { writeSync(fd, raw, 0, 32, 0); } finally { closeSync(fd); }
}
const marker = (path: string) => { const m = readSidecar(path, "-walattempt"); return m.state === "ok" ? m.value : null; };

// ---- T2 state table ----
it("8f S6: a busy TRUNCATE is not a reset: the next write's rise is exactly its own frames on the seal's base", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 1 * MB);
  const release = pin(path);
  try {
    expect(await o.wal.sealAndTruncate()).toEqual({ truncated: false });
    const Lb = o.wal.L(), before = frames(path);
    expect(Lb).toBeGreaterThan(32);
    await fill(o, "fill", MEMW_W_STEP_BYTES, 1 * MB);
    expect(o.wal.L() - Lb).toBe((frames(path) - before) * (o.wal.pageSize + 24));
    expect(o.wal.stopped).toBe(false);
  } finally { release(); }
});

it("8g S7: a rolled-back write runs the live check before anything else (marker resolved); a later breach still stops", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => { rows(o.writable, 2 * MB); throw new Error("body failed"); })).toThrow("body failed");
  expect(o.wal.checkOwed()).toBe(true);
  expect(marker(path)).toMatchObject({ state: "in_flight", seq: newestSeq(o) + 1 });
  expect(() => o.wal.write("fill", 1, () => undefined)).toThrow(WalUnresolved);
  await o.wal.check();
  expect(o.wal.checkOwed()).toBe(false);
  expect(marker(path)).toMatchObject({ state: "resolved", seq: newestSeq(o) + 1 });
  await expect(fill(o, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
});

it("8h S8: exits leave the -wal with every frame: prepareExit seals best effort and closes nothing; a thrown body too", async () => {
  const path = fresh(), o = await open(path);
  const release = pin(path);
  try {
    await fill(o, "open", 4 * MB, 2 * MB);
    const n = frames(path);
    await o.wal.prepareExit(); // TRUNCATE busy behind the reader: the frames stay
    expect(frames(path)).toBeGreaterThanOrEqual(n);
    expect(walLen(path)).toBeGreaterThan(0);
    expect(o.writable.isOpen).toBe(true);
    expect(o.guard.isOpen).toBe(true);
  } finally { release(); }
});

it("8m S13: a non-seal write, a full PASSIVE, an exit and the -wal/-shm gone: the open stops (log 0 is not a pass without -walok)", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  kill(o);
  (o.wal as IndexWalWriter).closeForQuarantine(); killed.splice(killed.indexOf(o), 1); // the close removes the log, as an unlink would
  for (const s of ["-wal", "-shm"]) { try { unlinkSync(`${path}${s}`); } catch { /* gone */ } }
  const b = await open(path);
  expect(b.verdict).toMatchObject({ state: "stopped", reason: "no_walok" });
  expect(existsSync(`${path}-walstop`)).toBe(true);
});

it("8n S14: a seal over its 4 frames stops with no TRUNCATE; 8n2: a stale -walok (seq < newest seal) does not pass", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  walTestHooks.sealBody = db => rows(db, 40_000);
  walCheckpointModes(true);
  await expect(o.wal.sealAndTruncate()).rejects.toThrow(WalStop);
  expect(walCheckpointModes().TRUNCATE).toBe(0);
  expect(o.wal.stopped).toBe(true);
  delete walTestHooks.sealBody;

  const p2 = fresh(), a = await open(p2);
  await fill(a, "open", 4 * MB, 100_000);
  expect((await a.wal.sealAndTruncate()).truncated).toBe(true);
  walTestHooks.fault = (name, op) => { if (name === "-walok" && op === "write") throw new Error("EIO"); };
  expect((await a.wal.sealAndTruncate()).truncated).toBe(false); // the second seal committed; its -walok did not
  delete walTestHooks.fault;
  (a.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(a), 1); // writable first: no close checkpoint, the log stays
  // A full checkpoint outside MEMW then empties the log (log 0, header unreadable): only a -walok of the newest seal may pass (e).
  { const raw = new DatabaseSync(p2); raw.exec("PRAGMA wal_checkpoint(TRUNCATE)"); raw.close(); }
  const b = await open(p2);
  expect(b.verdict).toMatchObject({ state: "stopped", reason: "no_walok" });
});

it("8p S16: a marker write that fails starts no txn (exit); a stop sidecar that fails writes no stop row (exit, no TRUNCATE)", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const seq = newestSeq(o);
  walTestHooks.fault = (name, op) => { if (name === "-walattempt" && op === "write") throw new Error("EIO"); };
  expect(() => o.wal.write("fill", 1, () => rows(o.writable, 10))).toThrow(Exited);
  expect(newestSeq(o)).toBe(seq);
  walTestHooks.fault = (name, op) => { if (name === "-walstop" && op === "fsync") throw new Error("EIO"); };
  walCheckpointModes(true);
  expect(() => o.wal.stop("test", "fill", seq)).toThrow(Exited);
  expect(meta(o, "wal_over_stop")).toBeUndefined();
  expect(walCheckpointModes().TRUNCATE).toBe(0);
});

it("8q S17: an open over a breach is stopped and never TRUNCATEs; a clean 1.0.17 file opens writable", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "fill", MEMW_W_STEP_BYTES, 100_000);
  // An unchecked 6 MB write the rule must catch (same generation, over the newest row's reserve). No reader pin: a TRUNCATE run before
  // the rule would complete here and hide the breach.
  const raw = new DatabaseSync(path); raw.exec("PRAGMA wal_autocheckpoint=0"); rows(raw, 6 * MB);
  kill(o);
  walCheckpointModes(true);
  const b = await open(path);
  expect(b.verdict).toMatchObject({ state: "stopped", reason: "open_rise" });
  expect(walCheckpointModes().TRUNCATE).toBe(0);
  raw.close();

  const old = fresh(), db = new DatabaseSync(old);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(id TEXT); INSERT INTO entries VALUES('a'); CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;");
  db.close();
  expect((await open(old)).verdict).toEqual({ state: "writable" });
});

it("8r S18: a downgrade after a breach keeps the stop and writes nothing; after a pass it clears the checks, then reopens writable", async () => {
  const path = fresh(), o = await open(path);
  await expect(fill(o, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
  kill(o);
  expect(await runOpenRuleForDowngrade(path)).toMatchObject({ state: "stopped" });
  expect(existsSync(`${path}-walstop`)).toBe(true);

  const p2 = fresh(), a = await open(p2);
  await fill(a, "open", 4 * MB, 100_000);
  expect((await a.wal.sealAndTruncate()).truncated).toBe(true);
  (a.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(a), 1);
  expect(await runOpenRuleForDowngrade(p2)).toEqual({ state: "writable" });
  for (const s of ["-walstop", "-walok", "-walattempt"]) expect(existsSync(`${p2}${s}`)).toBe(false);
  const check = new DatabaseSync(p2, { readOnly: true });
  expect(check.prepare("SELECT count(*) AS n FROM index_meta WHERE key IN ('wal_check','verified_through')").get()?.n).toBe(0);
  check.close();
  expect((await open(p2)).verdict).toEqual({ state: "writable" });
});

it("8s S19: wal_autocheckpoint, journal_size_limit and cache_spill read 0 after every step", async () => {
  const o = await open(fresh());
  for (let i = 0; i < 3; i++) {
    await fill(o, "fill", MEMW_W_STEP_BYTES, 50_000);
    for (const p of ["wal_autocheckpoint", "journal_size_limit", "cache_spill"]) expect(Object.values(o.writable.prepare(`PRAGMA ${p}`).get()!)[0]).toBe(0);
  }
});

// ---- 8t guard, 8u set ----
it("8t: the guard is open on every path; header 1/1 without a log opens WAL; 1/1 beside a 64 KB log is unresolved (exit, nothing opened)", async () => {
  const path = fresh(), o = await open(path);
  expect(o.guard.isOpen && o.writable.isOpen).toBe(true);
  expect(String(o.guard.prepare("PRAGMA journal_mode").get()?.journal_mode)).toBe("wal");

  const rollback = fresh(), db = new DatabaseSync(rollback);
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE x(a)"); db.close();
  expect((await open(rollback)).verdict).toEqual({ state: "writable" });

  const torn = fresh(), db2 = new DatabaseSync(torn);
  db2.exec("PRAGMA journal_mode=DELETE; CREATE TABLE x(a)"); db2.close();
  writeFileSync(`${torn}-wal`, Buffer.alloc(64 * 1024, 7));
  expect(() => openIndexWal(torn, { charge: grant })).toThrow(Exited);
});

it("8u: quarantine moves the set (main file + MOVED_SUFFIXES) as `.corrupt-R` and leaves only the stop marker live (r3.2.8 point 1); 8u2 another file's -walstop binds (presence-only); 8u3 the sweep removes every moved member", async () => {
  expect(INDEX_FILE_SUFFIXES).toEqual(["-wal", "-shm", "-walstop", "-walok", "-walattempt"]);
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  expect((await o.wal.sealAndTruncate()).truncated).toBe(true);
  writeSidecar(path, "-walstop", { fileId: o.wal.fileId.toString(), seq: 99, kind: "fill" }, true);
  writeFileSync(`${path}-wal`, Buffer.alloc(0));
  (o.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(o), 1);
  for (const s of INDEX_FILE_SUFFIXES) if (!existsSync(`${path}${s}`)) writeFileSync(`${path}${s}`, "");
  const aside = quarantineIndex(path, 4242);
  const dir = dirname(path);
  expect(readdirSync(dir).filter(n => n.startsWith(basename(aside))).sort()).toEqual(["", ...MOVED_SUFFIXES].map(s => `${basename(aside)}${s}`).sort());
  expect(readdirSync(dir).filter(n => !n.includes(".corrupt-"))).toEqual([basename(`${path}-walstop`)]);
  expect(readSidecar(path, "-walstop")).toMatchObject({ state: "ok", value: { seq: 99, kind: "fill" } });

  const p2 = fresh(), a = await open(p2);
  await fill(a, "open", 4 * MB, 10_000);
  expect((await a.wal.sealAndTruncate()).truncated).toBe(true);
  (a.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(a), 1);
  writeSidecar(p2, "-walstop", { fileId: "12345", seq: 1, kind: "fill" }, true); // another file's stop: a marker means stopped, whoever wrote it
  const b = await open(p2);
  expect(b.verdict).toMatchObject({ state: "stopped", seq: 1 });
  expect(readSidecar(p2, "-walstop")).toMatchObject({ state: "ok", value: { fileId: "12345", seq: 1, kind: "fill" } });

  expect(removeIndexQuarantines(path).removed.sort()).toEqual(["", ...MOVED_SUFFIXES].map(s => `${basename(aside)}${s}`).sort());
});

// ---- S20-S24 ----
it("S20: the header unreadable at Lb 10 MB: no write starts, the check stays owed, exit after 3; the file reopens writable", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const release = pin(path);
  for (let i = 0; i < 4; i++) await fill(o, "open", 4 * MB, 3 * MB);
  release();
  const seq = newestSeq(o);
  o.wal.write("open", 4 * MB, () => rows(o.writable, 4000));
  walTestHooks.walHeader = () => null;
  await o.wal.check(); await o.wal.check();
  expect(o.wal.checkOwed()).toBe(true);
  expect(() => o.wal.write("fill", 1, () => undefined)).toThrow(WalUnresolved);
  await expect(o.wal.check()).rejects.toThrow(Exited);
  expect(newestSeq(o)).toBe(seq + 1);
  delete walTestHooks.walHeader;
  kill(o);
  expect((await open(path)).verdict).toEqual({ state: "writable" });
});

it("S24: unresolved checkpoint answers (BUSY, missing counts, log < ckpt, -1/-1, a thrown IOERR) write nothing and never TRUNCATE", async () => {
  const answers: Array<() => { busy: unknown; log: unknown; checkpointed: unknown } | undefined> = [
    () => ({ busy: 1, log: 5, checkpointed: 5 }), () => undefined, () => ({ busy: 0, log: 3, checkpointed: 5 }),
    () => ({ busy: 0, log: -1, checkpointed: -1 }), () => { throw Object.assign(new Error("disk I/O error"), { errcode: 10 }); },
  ];
  for (const answer of answers) {
    const path = fresh(), o = await open(path);
    await fill(o, "open", 4 * MB, 10_000);
    o.wal.write("open", 4 * MB, () => rows(o.writable, 4000));
    const seq = newestSeq(o);
    walTestHooks.checkpoint = answer;
    walCheckpointModes(true);
    await o.wal.check();
    expect(o.wal.checkOwed()).toBe(true);
    expect(o.wal.admit("fill", 1)).toBe(false);
    expect(await o.wal.sealAndTruncate()).toEqual({ truncated: false });
    expect(walCheckpointModes().TRUNCATE).toBe(0);
    expect(newestSeq(o)).toBe(seq);
    delete walTestHooks.checkpoint;
  }
});

it("S23: a breach whose PASSIVE copied it fully, then the stop: sidecar present -> stopped; the reopen stays stopped", async () => {
  const path = fresh(), o = await open(path);
  await expect(fill(o, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
  kill(o);
  expect((await open(path)).verdict).toMatchObject({ state: "stopped" });
});

// ---- S21 attempts and tails ----
it("S21a: a 1 MB tail after a TRUNCATE and a failed attempt is resolved by the live check; the reopen goes on ((R)(i))", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 2 * MB);
  expect((await o.wal.sealAndTruncate()).truncated).toBe(true);
  expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => { rows(o.writable, 100_000); throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
  spill(path, 1 * MB); // the spilled frames a failed statement left (a valid header, no committed frame)
  await o.wal.check();
  expect(o.wal.stopped).toBe(false);
  expect(marker(path)).toMatchObject({ state: "resolved", seq: newestSeq(o) + 1, checkedEnd: walLen(path) });
  kill(o);
  expect((await open(path)).verdict).toEqual({ state: "writable" });
});

it("S21b: a 20 MB tail after a failed attempt is a live OVERRUN, marker left in_flight; S21c: the reopen is stopped", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
  truncateSync(`${path}-wal`, walLen(path) + 20 * MB);
  await expect(o.wal.check()).rejects.toThrow(WalStop);
  expect(marker(path)).toMatchObject({ state: "in_flight" });
  kill(o);
  expect((await open(path)).verdict).toMatchObject({ state: "stopped" });
});

it("S21c: S21b's tail with the helper killed before any check: the reopen's stop sidecar fails (exit, no stop row, shm kept), the next reopen is stopped", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
  truncateSync(`${path}-wal`, walLen(path) + 20 * MB);
  kill(o);
  walTestHooks.fault = (name: string, op: string) => { if (name === "-walstop" && op === "write") throw new Error("EIO"); };
  await expect(open(path)).rejects.toThrow(Exited);
  delete walTestHooks.fault;
  expect(o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_over_stop'").get()).toBeUndefined();
  expect(readSidecar(path, "-walstop").state).not.toBe("ok"); // created, never written: reads torn, which binds as a stop
  expect(existsSync(`${path}-shm`)).toBe(true);
  expect((await open(path)).verdict).toMatchObject({ state: "stopped" });
});

it("S21e: a kill after the marker before the first frame: the open goes on", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  walTestHooks.fault = (name, op) => { if (name === "-walattempt" && op === "fsync") { /* marker written */ } };
  writeSidecar(path, "-walattempt", { fileId: o.wal.fileId.toString(), seq: newestSeq(o) + 1, kind: "fill", reserve: MEMW_W_STEP_BYTES, state: "in_flight", checkedEnd: 0 }, false);
  kill(o);
  expect((await open(path)).verdict).toEqual({ state: "writable" });
});

it("S21g: a resolved rollback then a commit at the same seq leaves a tail: the open goes on ((R)(ii)); one frame past checked_end stops", async () => {
  for (const past of [0, 1]) {
    const path = fresh(), o = await open(path);
    await fill(o, "open", 4 * MB, 1 * MB);
    expect((await o.wal.sealAndTruncate()).truncated).toBe(true);
    expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => { throw new Error("SQLITE_FULL"); })).toThrow();
    truncateSync(`${path}-wal`, 3 * MB);
    await o.wal.check();
    o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 4000)); // commits at the marker's seq; the tail stays past its frames
    if (past) truncateSync(`${path}-wal`, 3 * MB + (o.wal.pageSize + 24));
    kill(o);
    const b = await open(path);
    expect(b.verdict.state).toBe(past ? "stopped" : "writable");
  }
});

it("S21h: an in_flight marker with seq = newest - 1 and Lw <= checked_end stops (an older seq never resolves a tail)", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 1 * MB);
  await fill(o, "fill", MEMW_W_STEP_BYTES, 4000);
  truncateSync(`${path}-wal`, walLen(path) + 64 * 1024);
  writeSidecar(path, "-walattempt", { fileId: o.wal.fileId.toString(), seq: newestSeq(o) - 1, kind: "fill", reserve: MEMW_W_STEP_BYTES, state: "in_flight", checkedEnd: walLen(path) }, false);
  kill(o);
  expect((await open(path)).verdict).toMatchObject({ state: "stopped", reason: "open_tail" });
});

// ---- T14e helper half, T14f ----
it("T14e (i)-(iv): no write before openCheck is writable; one admitted txn then an ack timeout refuses every later write; admission refusal apart from the stall; OVERRUN still fires", async () => {
  // (i)
  let grantNow = false;
  const path = fresh(), o = openIndexWal(path, { charge: async () => grantNow }); live.push(o);
  walTestHooks.chargeAckMs = 30;
  expect(await o.wal.openCheck()).toMatchObject({ state: "unresolved" });
  expect(() => o.wal.write("open", 1, () => undefined)).toThrow(WalUnresolved);
  expect(o.wal.admit("open", 1)).toBe(false);
  // (ii)
  grantNow = true;
  expect(await o.wal.openCheck()).toEqual({ state: "writable" });
  o.wal.write("open", 4 * MB, () => rows(o.writable, 100_000));
  let ackNever = false;
  const p2 = fresh(), s = openIndexWal(p2, { charge: () => ackNever ? new Promise<boolean>(() => undefined) : Promise.resolve(true) }); live.push(s);
  expect(await s.wal.openCheck()).toEqual({ state: "writable" });
  ackNever = true;
  s.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(s.writable, 10_000));
  for (let i = 0; i < 3; i++) { await s.wal.check(); expect(() => s.wal.write("fill", 1, () => undefined)).toThrow(WalUnresolved); }
  ackNever = false; await s.wal.check();
  expect(s.wal.checkOwed()).toBe(false);
  // (iii) acks flowing, the bound refuses
  await o.wal.check();
  const release = pin(path);
  try {
    for (let i = 0; o.wal.L() < 22 * MB && i < 20; i++) { o.wal.write("open", 4 * MB, () => rows(o.writable, 3 * MB)); await o.wal.check(); }
    expect(o.wal.checkOwed()).toBe(false);
    expect(o.wal.admit("fill", MEMW_W_STEP_BYTES)).toBe(false); // L > 16 MiB step line / C bound, acks flowing
    expect(o.wal.L()).toBeLessThanOrEqual(MEMW_C_BYTES);
    expect(o.wal.stopped).toBe(false);
  } finally { release(); }
  // (iv)
  const p3 = fresh(), v = await open(p3);
  expect(v.wal.admit("fill", MEMW_W_STEP_BYTES)).toBe(true);
  await expect(fill(v, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
});

it("T14f-b fast: a check never acked (faked by 200 timeouts) refuses admission, never stops, the log stays where it was", async () => {
  const path = fresh();
  let acks = true;
  const o = await open(path, () => acks ? Promise.resolve(true) : new Promise<boolean>(() => undefined));
  await fill(o, "open", 4 * MB, 100_000);
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 100_000));
  acks = false; walTestHooks.chargeAckMs = 5;
  const len = walLen(path);
  for (let i = 0; i < 200; i++) await o.wal.check();
  expect(o.wal.stopped).toBe(false);
  expect(o.wal.admit("fill", 1)).toBe(false);
  expect(walLen(path)).toBe(len);
  expect(len).toBeLessThanOrEqual(MEMW_C_BYTES);
  acks = true; await o.wal.check();
  expect(o.wal.checkOwed()).toBe(false);
  expect(o.wal.admit("fill", MEMW_W_STEP_BYTES)).toBe(true);
});

// ---- r3.2.4 A1: step 0 and the local reset (fast rows; the 10 min real-clock T14f is index-wal-t14f.test.ts) ----
// ---- T2 state rows 8c, 8i/8j, 8k, 8l, 8o and S21d (kills before any check: the open rule decides) ----
const Fz = (o: OpenedIndexWal) => o.wal.pageSize + 24;
type CheckpointRow = { busy: unknown; log: unknown; checkpointed: unknown };
const realCheckpoint = (db: DatabaseSync, mode: string) => db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as CheckpointRow;
const failStopWrite = () => { walTestHooks.fault = (name: string, op: string) => { if (name === "-walstop" && op === "write") throw new Error("EIO"); }; };

it("8c S3: a full PASSIVE while a reader holds the log end: the restart is blocked, the next 3 MB write appends in the same generation, rise = its frames, no OVERRUN", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const release = pin(path);
  for (let i = 0; i < 3; i++) await fill(o, "open", 4 * MB, 3 * MB);
  release();
  const seen: CheckpointRow[] = [];
  walTestHooks.checkpoint = (db, mode) => { const row = realCheckpoint(db, mode); seen.push(row); return row; };
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 4000));
  const reader = pin(path); // its read mark is the log end (> 0): a later writer cannot restart the log
  try {
    await o.wal.check();
    expect(Number(seen.at(-1)!.checkpointed)).toBe(Number(seen.at(-1)!.log)); // checkpointed = log
    const id0 = readWalHeader(path)!.id, La = o.wal.L(), f0 = frames(path);
    expect(La).toBeGreaterThan(8 * MB);
    await fill(o, "fill", MEMW_W_STEP_BYTES, 3 * MB);
    expect(o.wal.stopped).toBe(false);
    expect(readWalHeader(path)!.id).toBe(id0);
    expect(o.wal.L() - La).toBe((frames(path) - f0) * Fz(o));
    expect(o.wal.L() - La).toBeGreaterThan(3 * MB);
    expect(o.wal.L() - La).toBeLessThan(MEMW_W_STEP_BYTES);
  } finally { reader(); }
});

for (const shm of ["kept", "removed"] as const) {
  it(`${shm === "kept" ? "8i S9" : "8j S10"}: kills after a passing commit, after a breaching commit, a failed stop write; the rule reads the log, not the -wal length (-shm ${shm})`, async () => {
    const drop = (p: string, o: OpenedIndexWal) => { expect(existsSync(`${p}-shm`)).toBe(true); if (shm === "removed") removeShm(p, o); };
    // A passing commit killed before its check reopens writable.
    const p1 = fresh(), a = await open(p1);
    await fill(a, "open", 4 * MB, 100_000);
    a.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(a.writable, 3 * MB));
    kill(a); drop(p1, a);
    expect((await open(p1)).verdict).toEqual({ state: "writable" });
    // A breaching commit killed before its check: the first reopen's stop sidecar fails (exit, no stop row); the next reopen is stopped.
    const p2 = fresh(), b = await open(p2);
    await fill(b, "open", 4 * MB, 100_000);
    b.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(b.writable, 6 * MB));
    kill(b); drop(p2, b);
    failStopWrite();
    await expect(open(p2)).rejects.toThrow(Exited);
    delete walTestHooks.fault;
    if (process.platform !== "win32" || shm === "kept") expect(b.writable.prepare("SELECT value FROM index_meta WHERE key='wal_over_stop'").get()).toBeUndefined(); // (a closed handle on Windows)
    expect((await open(p2)).verdict).toMatchObject({ state: "stopped" });
    // A 3 MB commit (restart, base 32 B), then a resolved 2 MB spill tail: E - base = 3 MB passes; Lw - base would be 5 MB.
    const p3 = fresh(), c = await open(p3);
    await fill(c, "open", 4 * MB, 100_000);
    await fill(c, "fill", MEMW_W_STEP_BYTES, 3 * MB);
    expect(() => c.wal.write("fill", MEMW_W_STEP_BYTES, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
    spill(p3, 2 * MB);
    await c.wal.check();
    expect(marker(p3)).toMatchObject({ state: "resolved" });
    kill(c); drop(p3, c);
    expect((await open(p3)).verdict).toEqual({ state: "writable" });
  });
}

it("8k S11: s+1 died after the log restarted (new generation, base 32 B): the reopen is writable", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const release = pin(path);
  for (let i = 0; i < 3; i++) await fill(o, "open", 4 * MB, 3 * MB);
  release();
  await fill(o, "fill", MEMW_W_STEP_BYTES, 4000); // a full PASSIVE: the next write restarts the log
  const id0 = readWalHeader(path)!.id;
  expect(o.wal.L()).toBeGreaterThan(8 * MB);
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 3 * MB));
  expect(readWalHeader(path)!.id).not.toBe(id0);
  kill(o);
  expect((await open(path)).verdict).toEqual({ state: "writable" });
});

it("8l S12: a kill inside the seal's TRUNCATE (every frame copied, the file not cut): H is valid with the seal row's idb; the reopen is writable", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  const release = pin(path); // the seal appends in the same generation
  await fill(o, "open", 4 * MB, 2 * MB);
  walTestHooks.checkpoint = (db, mode) => {
    if (mode !== "TRUNCATE") return realCheckpoint(db, mode);
    release(); realCheckpoint(db, "PASSIVE");
    throw new Error("killed inside TRUNCATE");
  };
  expect(await o.wal.sealAndTruncate()).toEqual({ truncated: false });
  delete walTestHooks.checkpoint;
  kill(o);
  const seal = JSON.parse(String(meta(o, "wal_check"))) as { kind: string; idb: string | null };
  const H = readWalHeader(path)!;
  expect(seal.kind).toBe("seal");
  expect(H.valid).toBe(true);
  expect(H.id).toBe(seal.idb);
  expect(walLen(path)).toBeGreaterThan(2 * MB);
  expect((await open(path)).verdict).toEqual({ state: "writable" });
});

it("8o S15: a seal over its 4 frames killed before its check: the reopen is stopped", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  walTestHooks.sealBody = db => rows(db, 200_000);
  walTestHooks.point = name => { if (name === "after-commit") throw new Error("killed"); };
  await expect(o.wal.sealAndTruncate()).rejects.toThrow("killed");
  delete walTestHooks.point; delete walTestHooks.sealBody;
  expect(JSON.parse(String(meta(o, "wal_check"))).kind).toBe("seal");
  kill(o);
  expect((await open(path)).verdict).toMatchObject({ state: "stopped", reason: "open_rise" });
});

for (const shm of ["kept", "removed"] as const) {
  it(`S21d (-shm ${shm}): a breached seal (over 4 frames), a breached small group, a fill rollback just over 4 MiB and under 4 MiB + S, each killed, the first reopen's stop sidecar failing: none reopens writable`, async () => {
    const cases: Array<[string, (o: OpenedIndexWal, path: string) => Promise<void>]> = [
      ["seal", async (o) => {
        const ip = (o.wal as IndexWalWriter).indexPath, f0 = frames(ip), id0 = readWalHeader(ip)?.id;
        walTestHooks.sealBody = db => rows(db, 12_000);
        walTestHooks.point = name => { if (name === "after-commit") throw new Error("killed"); };
        await o.wal.sealAndTruncate().then(() => { throw new Error("not killed"); }, (e: Error) => { if (e.message !== "killed") throw e; });
        const rise = readWalHeader(ip)?.id === id0 ? frames(ip) - f0 : frames(ip); // a restart counts from frame 0
        expect(rise).toBeGreaterThan(4); expect(rise).toBeLessThanOrEqual(8);
      }],
      ["group", async (o) => { o.wal.write("group", 64 * 1024, () => rows(o.writable, 200_000)); }],
      ["rollback", async (o, path) => {
        expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
        spill(path, MEMW_W_STEP_BYTES + Fz(o)); // over W, under W + S (S = 4 frames)
      }],
    ];
    for (const [name, breach] of cases) {
      const path = fresh(), o = await open(path);
      await fill(o, "open", 4 * MB, 100_000);
      await breach(o, path);
      delete walTestHooks.point; delete walTestHooks.sealBody;
      kill(o);
      expect(existsSync(`${path}-shm`)).toBe(true);
      if (shm === "removed") removeShm(path, o);
      failStopWrite();
      await expect(open(path), name).rejects.toThrow(Exited);
      delete walTestHooks.fault;
      expect((await open(path)).verdict.state, name).toBe("stopped");
      expect((await open(path)).verdict.state, name).toBe("stopped");
    }
  });
}

it("8t-damaged: a damaged index (quick_check fails) is closed writable first then guard, its whole set moved aside by a real rename, and opened fresh (rebuilt:true)", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 400_000);
  expect((await o.wal.sealAndTruncate()).truncated).toBe(true);
  (o.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(o), 1);
  expect(statSync(path).size).toBeGreaterThan(40 * 4096);
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 20 * 4096); } finally { closeSync(fd); }
  const r = await open(path);
  expect(r.rebuilt).toBe(true);
  expect(r.verdict).toEqual({ state: "writable" });
  const names = readdirSync(dirname(path)).filter(n => n.startsWith(`${basename(path)}.corrupt-`));
  expect(names.filter(n => /\.corrupt-\d+$/.test(n))).toHaveLength(1);
  for (const n of names) expect(statSync(join(dirname(path), n)).isFile()).toBe(true);
  expect(r.writable.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='t'").get()?.n).toBe(0);
});

// ---- r3.2.6 A1': stop in place (fast rows; the 10 min real clock T14f' is index-wal-t14f.test.ts) ----
const shaOf = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Counts every statement on the writer's two connections from now on. */
function statements(o: OpenedIndexWal): () => number {
  let n = 0;
  for (const db of [o.writable, o.guard]) {
    const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
    Object.assign(db, { exec: (sql: string) => { n++; return exec(sql); }, prepare: (sql: string) => { n++; return prepare(sql); } });
  }
  return () => n;
}

it("S-STOPDUR: a stop in place is durable: a kill right after the sidecar's directory fsync, then a restart: stopped; a stop in the file's first transaction (no file_id stored) binds too; a failed sidecar fsync exits with no statement and no close", async () => {
  // (1) a breach past C, killed after the sidecar
  const p1 = fresh(), a = await open(p1);
  await fill(a, "open", 4 * MB, 100_000);
  a.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(a.writable, 100_000));
  spill(p1, MEMW_C_BYTES);
  walTestHooks.point = name => { if (name === "after-walstop") throw new Error("kill -9"); };
  await expect(a.wal.check()).rejects.toThrow("kill -9");
  delete walTestHooks.point;
  kill(a);
  expect(a.writable.prepare("SELECT value FROM index_meta WHERE key='wal_over_stop'").get()).toBeUndefined(); // no SQLite write
  expect((await open(p1)).verdict).toMatchObject({ state: "stopped", fileId: a.wal.fileId });
  // (2) a 1.0.17 file's first MEMW transaction fails and leaves a log past C: no file_id was ever stored
  const p2 = fresh();
  { const db = new DatabaseSync(p2); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;"); db.close(); }
  const b = await open(p2);
  expect(() => b.wal.write("open", 4 * MB, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
  spill(p2, MEMW_C_BYTES);
  await expect(b.wal.check()).rejects.toThrow(WalStop);
  expect(readSidecar(p2, "-walstop").state).toBe("ok");
  kill(b);
  expect((await open(p2)).verdict).toMatchObject({ state: "stopped", reason: "stopped" }); // the sidecar binds (not the (U) tail)
  expect(existsSync(`${p2}-walstop`)).toBe(true);
  // (3) the sidecar's fsync fails: exit(1), no statement, no close
  const p3 = fresh(), c = await open(p3);
  await fill(c, "open", 4 * MB, 100_000);
  c.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(c.writable, 100_000));
  spill(p3, MEMW_C_BYTES);
  const n = statements(c);
  walTestHooks.fault = (name: string, op: string) => { if (name === "-walstop" && op === "fsync") throw new Error("EIO"); };
  await expect(c.wal.check()).rejects.toThrow(Exited);
  delete walTestHooks.fault;
  expect(n()).toBe(0);
  expect(c.wal.stopped).toBe(false);
  expect(() => c.guard.prepare("SELECT 1").get()).not.toThrow(); // still open
});

it("S-CLEAR: a stopped set keeps its -walstop through the S18 downgrade pass, a clean reopen, 3 restarts and the damaged-branch move; the reset's fresh open leaves it; only removeStopMarker removes it", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 100_000));
  spill(path, MEMW_C_BYTES);
  await expect(o.wal.check()).rejects.toThrow(WalStop);
  (o.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(o), 1);
  expect(await runOpenRuleForDowngrade(path)).toMatchObject({ state: "stopped" });
  expect(existsSync(`${path}-walstop`)).toBe(true);
  for (let i = 0; i < 4; i++) {
    const r = await open(path);
    expect(r.verdict.state).toBe("stopped");
    (r.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(r), 1);
    expect(existsSync(`${path}-walstop`)).toBe(true);
  }
  const m = shaOf(`${path}-walstop`);
  const aside = quarantineIndex(path);
  expect(existsSync(`${aside}-walstop`)).toBe(false);
  expect(shaOf(`${path}-walstop`)).toBe(m);
  const rebuilt = await open(path); // a fresh file beside the marker (the damaged branch's rebuild) is stopped too
  expect(rebuilt.verdict.state).toBe("stopped");
  (rebuilt.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(rebuilt), 1);
  const reset = openIndexWal(path, { charge: grant, reset: true, ignoreMarker: true }); live.push(reset);
  expect(await reset.wal.openCheck()).toEqual({ state: "writable" });
  (reset.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(reset), 1);
  expect(shaOf(`${path}-walstop`)).toBe(m);
  removeStopMarker(path);
  expect(existsSync(`${path}-walstop`)).toBe(false);
  expect((await open(path)).verdict).toEqual({ state: "writable" });
});

it("S-CLOSE: the reset's close (writable first, read-only guard last) runs no checkpoint: the main file's sha256 and the -wal length are unchanged", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 2 * MB)); // frames in the log, no check run
  const main = shaOf(path), lw = walLen(path);
  expect(lw).toBeGreaterThan(2 * MB);
  (o.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(o), 1);
  expect(shaOf(path)).toBe(main);
  expect(walLen(path)).toBe(lw);
});

it("F-STAT: a -wal stat that throws EACCES, throws ENOENT, or names a non-regular file is a stop in place", async () => {
  for (const fault of ["EACCES", "ENOENT", "dir"] as const) {
    const path = fresh(), o = await open(path);
    await fill(o, "open", 4 * MB, 100_000);
    o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 4000));
    walTestHooks.walStat = () => {
      if (fault === "dir") return { isFile: () => false, size: 0 };
      throw Object.assign(new Error(fault), { code: fault });
    };
    await expect(o.wal.check(), fault).rejects.toThrow(WalStop);
    delete walTestHooks.walStat;
    expect(readSidecar(path, "-walstop").state, fault).toBe("ok");
    expect(o.wal.stopped, fault).toBe(true);
  }
});

it("T14f'-m: with acks stuck the stop is decided before any charge, at once; a refused check, then the log past C: the next check stops in place", async () => {
  let stuck = false;
  const sent: number[] = [];
  const path = fresh(), o = await open(path, ch => { sent.push(ch.attempt); return stuck ? new Promise<boolean>(() => undefined) : Promise.resolve(true); });
  await fill(o, "open", 4 * MB, 100_000);
  stuck = true; walTestHooks.chargeAckMs = 20;
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 100_000));
  await o.wal.check(); // timed out: still owed
  expect((o.wal as IndexWalWriter).counters.charge_refused).toBe(1);
  spill(path, MEMW_C_BYTES);
  const before = sent.length, t0 = Date.now();
  await expect(o.wal.check()).rejects.toThrow(WalStop);
  expect(Date.now() - t0).toBeLessThan(500);
  expect(sent.length).toBe(before);
  expect(readSidecar(path, "-walstop").state).toBe("ok");
});

it("S21i (1): a truncate that did not shorten the file after a restart (emulated at the stat seam): the commit is ok, the file keeps its length, the next failed attempt is a false OVERRUN counted truncate_failed, stopped", async () => {
  const path = fresh(), o = await open(path), w = o.wal as IndexWalWriter;
  await fill(o, "open", 4 * MB, 100_000);
  await fill(o, "fill", MEMW_W_STEP_BYTES, 3 * MB); // checked: a full PASSIVE, so the next commit restarts the log
  const floor = walLen(path);
  expect(floor).toBeGreaterThan(3 * MB);
  // the truncate after the restart fails: the file keeps its old length although the log restarted
  walTestHooks.walStat = p => { const st = statSync(p); return { isFile: () => st.isFile(), size: Math.max(st.size, floor) }; };
  w.write("fill", MB, () => rows(o.writable, 50_000));
  await w.check();
  expect(w.counters.truncate_failed).toBe(0); // the commit is fine: nothing stopped
  expect((w as unknown as { truncateFailed: boolean }).truncateFailed).toBe(true);
  expect(readSidecar(path, "-walstop").state).toBe("absent");
  // the next attempt fails: the tail past the log is a stale tail, a false OVERRUN counted as truncate_failed
  expect(() => w.write("fill", MB, () => { throw new Error("SQLITE_FULL"); })).toThrow("SQLITE_FULL");
  await expect(w.check()).rejects.toThrow(WalStop);
  expect(w.counters.truncate_failed).toBe(1);
  expect(w.counters.false_bound_stops).toBe(1);
  expect(readSidecar(path, "-walstop").state).toBe("ok");
});
