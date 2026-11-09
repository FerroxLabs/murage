// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.0.18 Part A WP1, r3.2.8 point 1 (+ r3.2.8a Ma, 3.2.3, 3.2.4, 3.3 step 2): the -walstop marker is PRESENCE-ONLY. Any content
// binds as stopped, whoever wrote it; nothing on the open path moves, unlinks or rewrites it; a stop beside it never rewrites it; only
// removeStopMarker removes it. Replaces S-STOPID and its m16-m18 (the identity rules are deleted). Throwaway temp dirs only.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { LOG_SUFFIXES, MOVED_SUFFIXES, prepareIndexOpen, quarantineIndex, removeIndexQuarantines, removeStopMarker } from "./index-quarantine.ts";
import { IndexWalWriter, MEMW_C_BYTES, MEMW_W_STEP_BYTES, openIndexWal, readSidecar, WalStop, walTestHooks, writeSidecar, type ChargeTransport, type OpenedIndexWal, type OpenRuleOptions } from "./index-wal.ts";

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const roots: string[] = [], live: OpenedIndexWal[] = [], killed: OpenedIndexWal[] = [];
beforeEach(() => { walTestHooks.exit = (code: number) => { throw new Exited(code); }; });
afterEach(() => {
  for (const key of Object.keys(walTestHooks) as Array<keyof typeof walTestHooks>) delete walTestHooks[key];
  // killed handles stay open for the test (as a real kill leaves them) and are closed only here, before the temp dirs go (Windows: EBUSY)
  for (const o of [...live.splice(0), ...killed.splice(0)]) { try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const MB = 1024 * 1024;
const grant: ChargeTransport = async () => true;
const STOP = "-walstop";
function fresh(): string { const root = mkdtempSync(join(tmpdir(), "memw-marker-")); roots.push(root); return join(root, "memory-index.db"); }
async function open(path: string, extra: Omit<OpenRuleOptions, "charge"> = {}): Promise<OpenedIndexWal> {
  const o = openIndexWal(path, { charge: grant, ...extra }); live.push(o);
  if (o.verdict.state !== "stopped") o.verdict = await o.wal.openCheck();
  return o;
}
/** The writer's permitted close (writable first, read-only guard last: no close checkpoint, S-CLOSE). */
function close(o: OpenedIndexWal): void { (o.wal as IndexWalWriter).closeForQuarantine(); live.splice(live.indexOf(o), 1); }
function rows(db: DatabaseSync, bytes: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS t(x BLOB)");
  const put = db.prepare("INSERT INTO t VALUES(randomblob(?))");
  for (let left = bytes; left > 0; left -= 4000) put.run(Math.min(4000, left));
}
async function fill(o: OpenedIndexWal, kind: "fill" | "open", reserve: number, bytes: number): Promise<void> {
  o.wal.write(kind, reserve, () => rows(o.writable, bytes));
  await o.wal.check();
}
const walLen = (path: string) => { try { return statSync(`${path}-wal`).size; } catch { return 0; } };
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const markerStamp = (path: string) => ({ sha: sha(`${path}${STOP}`), mtime: statSync(`${path}${STOP}`).mtimeMs, size: statSync(`${path}${STOP}`).size });
/** Extends the -wal past its end, as a spilled attempt does (the log already has a header here). */
const spill = (path: string, bytes: number) => truncateSync(`${path}-wal`, walLen(path) + bytes);
function metaRow(file: string, key: string): string | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT value FROM index_meta WHERE key=?").get(key)?.value as string | undefined; } finally { db.close(); }
}

type MarkerState = "v" | "v-foreign" | "t-short" | "t-zero" | "v-null" | "m" | "m-nokind" | "m-badkind";
/** A stopped set in one marker state. `stored`: a file whose MEMW write stored a file_id; else a 1.0.17 file with no file_id. */
async function stoppedSet(state: MarkerState, stored: boolean): Promise<{ path: string; storedId: string | null }> {
  const path = fresh();
  let storedId: string | null = null;
  if (stored) {
    const o = await open(path);
    await fill(o, "open", 4 * MB, 100_000);
    storedId = o.wal.fileId.toString();
    close(o);
  } else {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;");
    db.close();
  }
  if (state === "v") writeSidecar(path, STOP, { fileId: storedId ?? "777", seq: 5, kind: "merge" }, true);
  if (state === "v-foreign") writeSidecar(path, STOP, { fileId: "12345", seq: 7, kind: "fill" }, true); // another file's stop: binds
  if (state === "t-short") { writeSidecar(path, STOP, { fileId: storedId ?? "777", seq: 5, kind: "merge" }, true); truncateSync(`${path}${STOP}`, 100); }
  if (state === "t-zero") writeFileSync(`${path}${STOP}`, "");
  if (state === "v-null") writeSidecar(path, STOP, null as unknown as object, true); // a checksum-valid marker whose body is JSON null
  if (state.startsWith("m")) {
    const body = state === "m" ? { reason: "over", kind: "delete", seq: 3 } : state === "m-badkind" ? { reason: "over", kind: "bogus", seq: "x" } : { reason: "over" };
    const db = new DatabaseSync(path);
    db.prepare("INSERT OR REPLACE INTO index_meta VALUES('wal_over_stop',?)").run(JSON.stringify(body));
    db.close();
  }
  return { path, storedId };
}
const EXPECT: Record<MarkerState, { kind: string; seq: number }> = {
  "v": { kind: "merge", seq: 5 }, "v-foreign": { kind: "fill", seq: 7 }, "t-short": { kind: "unknown", seq: -1 }, "t-zero": { kind: "unknown", seq: -1 }, "v-null": { kind: "unknown", seq: -1 },
  "m": { kind: "delete", seq: 3 }, "m-nokind": { kind: "unknown", seq: -1 }, "m-badkind": { kind: "unknown", seq: -1 },
};

it("S-RESTART (WP1): a valid, another file's, torn, zero-length or JSON-null marker, or index_meta with no marker, binds as stopped through 3 helper restarts and 1 app restart; the marker is never rewritten and nothing is written", async () => {
  for (const state of Object.keys(EXPECT) as MarkerState[]) {
    for (const stored of [true, false]) {
      const label = `${state} stored=${stored}`;
      const { path, storedId } = await stoppedSet(state, stored);
      const hasMarker = !state.startsWith("m");
      const before = hasMarker ? markerStamp(path) : null, main = sha(path), lw = walLen(path);
      for (let start = 0; start < 4; start++) {
        const o = openIndexWal(path, { charge: grant }); live.push(o);
        expect(o.verdict, label).toEqual({ state: "stopped", reason: "stopped", fileId: storedId === null ? null : BigInt(storedId), seq: EXPECT[state].seq });
        expect(o.wal.stopped, label).toBe(true);
        expect((o.wal as IndexWalWriter).stopInfo(), label).toEqual({ kind: EXPECT[state].kind, seq: EXPECT[state].seq, reason: "stopped" });
        expect(() => o.wal.write("fill", MEMW_W_STEP_BYTES, () => undefined), label).toThrow(WalStop);
        if (start < 3) close(o); // helper-only restarts: the permitted close; the 4th is left open, as an app kill leaves it
        else killed.push(...live.splice(live.indexOf(o), 1));
        expect(existsSync(`${path}${STOP}`), label).toBe(hasMarker);
        if (before) expect(markerStamp(path), label).toEqual(before);
        expect(sha(path), label).toBe(main); // no index write
        expect(walLen(path), label).toBe(lw);
      }
    }
  }
});

it("Ma: a stop beside an existing marker (the reset's fresh open) never rewrites it: stop in place and the post-ack stop; with no marker the stop writes one", async () => {
  // (1) stop in place (step 0, log past C)
  const p1 = fresh();
  writeSidecar(p1, STOP, { fileId: "999", seq: 5, kind: "merge" }, true);
  const m1 = markerStamp(p1);
  const a = await open(p1, { ignoreMarker: true });
  expect(a.verdict).toEqual({ state: "writable" });
  await fill(a, "open", 4 * MB, 100_000);
  a.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(a.writable, 100_000));
  spill(p1, MEMW_C_BYTES);
  await expect(a.wal.check()).rejects.toThrow("stop_in_place");
  expect(a.wal.stopped).toBe(true);
  expect(markerStamp(p1)).toEqual(m1);
  expect(readSidecar(p1, STOP)).toMatchObject({ state: "ok", value: { fileId: "999", seq: 5, kind: "merge" } });
  // (2) the post-ack stop (a rise over its reserve): index_meta wal_over_stop is still written, the marker is not
  const p2 = fresh();
  writeFileSync(`${p2}${STOP}`, ""); // a torn (zero-length) marker counts as present too
  const m2 = markerStamp(p2);
  const b = await open(p2, { ignoreMarker: true });
  await fill(b, "open", 4 * MB, 100_000);
  await expect(fill(b, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
  expect(b.wal.stopped).toBe(true);
  expect(markerStamp(p2)).toEqual(m2);
  expect(String(b.writable.prepare("SELECT value FROM index_meta WHERE key='wal_over_stop'").get()?.value)).toContain("\"kind\":\"fill\"");
  // (3) control: no marker, the same stop writes it
  const p3 = fresh(), c = await open(p3);
  await fill(c, "open", 4 * MB, 100_000);
  await expect(fill(c, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
  expect(readSidecar(p3, STOP)).toMatchObject({ state: "ok", value: { fileId: c.wal.fileId.toString(), kind: "fill" } });
});

it("M-MOVE: MOVED_SUFFIXES is LOG_SUFFIXES minus -walstop; quarantineIndex leaves the marker at its live name; prepareIndexOpen with no main file unlinks the stray logs and keeps the marker; a linked marker is UNSAFE", async () => {
  expect(LOG_SUFFIXES).toEqual(["-wal", "-shm", "-walstop", "-walok", "-walattempt"]);
  expect(MOVED_SUFFIXES).toEqual(["-wal", "-shm", "-walok", "-walattempt"]);
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  expect((await o.wal.sealAndTruncate()).truncated).toBe(true);
  close(o);
  writeSidecar(path, STOP, { fileId: "1", seq: 2, kind: "fill" }, true);
  for (const s of LOG_SUFFIXES) if (!existsSync(`${path}${s}`)) writeFileSync(`${path}${s}`, "");
  const m = markerStamp(path), dir = dirname(path);
  const aside = quarantineIndex(path, 4242);
  expect(readdirSync(dir).filter(n => n.startsWith(basename(aside))).sort()).toEqual(["", ...MOVED_SUFFIXES].map(s => `${basename(aside)}${s}`).sort());
  expect(readdirSync(dir).filter(n => !n.includes(".corrupt-"))).toEqual([basename(`${path}${STOP}`)]);
  expect(markerStamp(path)).toEqual(m);
  // stray logs at the live name with no main file: removed; the marker stays
  for (const s of ["-wal", "-shm", "-walok", "-walattempt"]) writeFileSync(`${path}${s}`, "x");
  prepareIndexOpen(path);
  expect(readdirSync(dir).filter(n => !n.includes(".corrupt-"))).toEqual([basename(`${path}${STOP}`)]);
  expect(markerStamp(path)).toEqual(m);
  // the open rule's step 0 is the same: a fresh file beside the marker is stopped, and the marker is unchanged
  const r = await open(path);
  expect(r.verdict).toMatchObject({ state: "stopped" });
  expect(markerStamp(path)).toEqual(m);
  close(r);
  expect(removeIndexQuarantines(path).removed.sort()).toEqual(["", ...MOVED_SUFFIXES].map(s => `${basename(aside)}${s}`).sort());
  if (process.platform !== "win32") {
    const p2 = fresh();
    writeFileSync(`${p2}.target`, "");
    symlinkSync(`${p2}.target`, `${p2}${STOP}`);
    expect(() => prepareIndexOpen(p2)).toThrow("UNSAFE_MEMORY_INDEX");
    expect(existsSync(`${p2}${STOP}`)).toBe(true);
  }
});

it("RM-STOP: removeStopMarker unlinks the marker, then fsyncs the directory; ENOENT counts as done; an unlink or fsync fault is thrown", () => {
  const path = fresh(), calls: Array<[string, boolean]> = [];
  const fsyncDir = (dir: string) => { calls.push([dir, existsSync(`${path}${STOP}`)]); };
  writeSidecar(path, STOP, { fileId: "1", seq: 2, kind: "fill" }, true);
  removeStopMarker(path, { fsyncDir });
  expect(existsSync(`${path}${STOP}`)).toBe(false);
  expect(calls).toEqual([[dirname(path), false]]); // the directory fsync runs after the unlink
  removeStopMarker(path, { fsyncDir }); // ENOENT: done, and the directory is still synced
  expect(calls).toHaveLength(2);
  removeStopMarker(path); // the real directory fsync
  writeSidecar(path, STOP, { fileId: "1", seq: 2, kind: "fill" }, true);
  const busy = () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); };
  expect(() => removeStopMarker(path, { unlink: busy, fsyncDir })).toThrow("EBUSY");
  expect(existsSync(`${path}${STOP}`)).toBe(true);
  expect(calls).toHaveLength(2);
  expect(() => removeStopMarker(path, { fsyncDir: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } })).toThrow("EIO");
  expect(existsSync(`${path}${STOP}`)).toBe(false);
});

it("R-OPEN: ignoreMarker opens the reset's fresh file beside the marker; trigger B sets aside a file stopped by index_meta with no marker; a marker with the main file present stays stopped even for a reset start", async () => {
  // ignoreMarker (3.2.3): the main file is aside, the marker at its live name
  const p1 = fresh(), a = await open(p1);
  await fill(a, "open", 4 * MB, 100_000);
  a.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(a.writable, 100_000));
  spill(p1, MEMW_C_BYTES);
  await expect(a.wal.check()).rejects.toThrow(WalStop);
  close(a);
  const m1 = markerStamp(p1);
  quarantineIndex(p1);
  const plain = await open(p1);
  expect(plain.verdict).toMatchObject({ state: "stopped" }); // without ignoreMarker the marker binds the fresh file
  close(plain);
  const freshOpen = await open(p1, { reset: true, ignoreMarker: true });
  expect(freshOpen.verdict).toEqual({ state: "writable" });
  expect(markerStamp(p1)).toEqual(m1);
  await fill(freshOpen, "open", 4 * MB, 10_000);
  close(freshOpen);
  removeStopMarker(p1);
  expect((await open(p1)).verdict).toEqual({ state: "writable" });

  // trigger B (3.2.4): stopped by index_meta, marker lost outside our code
  const p2 = fresh(), b = await open(p2);
  await fill(b, "open", 4 * MB, 100_000);
  await expect(fill(b, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
  close(b);
  unlinkSync(`${p2}${STOP}`);
  const noReset = await open(p2);
  expect(noReset.verdict).toMatchObject({ state: "stopped" });
  expect((noReset.wal as IndexWalWriter).stopInfo()).toMatchObject({ kind: "fill" });
  close(noReset);
  const before = readdirSync(dirname(p2)).filter(n => n.includes(".corrupt-"));
  expect(before).toEqual([]);
  const rb = await open(p2, { reset: true });
  expect(rb.rebuilt).toBe(true);
  expect(rb.verdict).toEqual({ state: "writable" });
  // the fresh file holds no stop row (it has no index_meta table until its first write)
  expect(rb.writable.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='index_meta'").get()).toBeUndefined();
  const asideMain = readdirSync(dirname(p2)).filter(n => /\.corrupt-\d+$/.test(n));
  expect(asideMain).toHaveLength(1);
  expect(String(metaRow(join(dirname(p2), asideMain[0]!), "wal_over_stop"))).toContain("\"kind\":\"fill\"");
  expect(existsSync(`${p2}${STOP}`)).toBe(false);

  // a reset start with the marker AND the main file present: trigger A is the start's job (before any SQLite open); the rule stays stopped
  const p3 = fresh(), c = await open(p3);
  await fill(c, "open", 4 * MB, 100_000);
  close(c);
  writeSidecar(p3, STOP, { fileId: "5", seq: 1, kind: "seal" }, true);
  const m3 = markerStamp(p3), main3 = sha(p3);
  const r3 = await open(p3, { reset: true });
  expect(r3.verdict).toMatchObject({ state: "stopped" });
  expect(r3.rebuilt).toBe(false);
  expect(markerStamp(p3)).toEqual(m3);
  expect(sha(p3)).toBe(main3);
  expect(readdirSync(dirname(p3)).filter(n => n.includes(".corrupt-"))).toEqual([]);
});

it("TB-CLOSE: trigger B closes every handle of the stopped set (writable, guard, the writer's -shm reader, opened here by a read) before it is renamed aside: no descriptor is left on the .corrupt copy", async () => {
  const path = fresh(), b = await open(path);
  await fill(b, "open", 4 * MB, 100_000);
  await expect(fill(b, "fill", MEMW_W_STEP_BYTES, 6 * MB)).rejects.toThrow(WalStop);
  close(b);
  unlinkSync(`${path}${STOP}`); // the marker lost outside our code: stopped by index_meta alone
  const fds = () => process.platform === "linux" ? readdirSync("/proc/self/fd").map(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } }) : [];
  let primed = false;
  // a read through the stopped writer just before trigger B opens its lazy -shm reader (io-written.ts walIndexReader)
  walTestHooks.triggerB = w => { (w as unknown as { shm: () => unknown }).shm(); primed = process.platform !== "linux" || fds().includes(`${path}-shm`); };
  const rb = await open(path, { reset: true });
  expect(primed).toBe(true);
  expect(rb.rebuilt).toBe(true);
  const aside = readdirSync(dirname(path)).filter(n => n.includes(".corrupt-"));
  expect(aside.length).toBeGreaterThan(0);
  if (process.platform === "linux") expect(fds().filter(target => target.startsWith(`${path}.corrupt-`))).toEqual([]);
  // elsewhere the rename itself proves it: Windows refuses to rename a file with an open handle (EBUSY -> exit, the test fails above)
});

it("TB-IGNORE: a reset start with ignoreMarker on a non-fresh stopped file whose marker is on disk binds as stopped; trigger B does not fire (no quarantine, marker untouched)", async () => {
  const { path } = await stoppedSet("v", true);
  { const db = new DatabaseSync(path); db.prepare("INSERT OR REPLACE INTO index_meta VALUES('wal_over_stop',?)").run(JSON.stringify({ reason: "over", kind: "delete", seq: 3 })); db.close(); } // stopped by index_meta AND a marker on disk
  const stamp = markerStamp(path), main = sha(path);
  const o = await open(path, { reset: true, ignoreMarker: true });
  expect(o.rebuilt).toBe(false);
  expect(o.verdict.state).toBe("stopped");
  expect(markerStamp(path)).toEqual(stamp);
  expect(sha(path)).toBe(main);
  expect(readdirSync(dirname(path)).filter(n => n.includes(".corrupt-"))).toEqual([]);
});

it("R-OPEN-FAIL: a failed fresh open after trigger A leaves the marker at its live name; the next start opens forward", async () => {
  const path = fresh(), o = await open(path);
  await fill(o, "open", 4 * MB, 100_000);
  o.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(o.writable, 100_000));
  spill(path, MEMW_C_BYTES);
  await expect(o.wal.check()).rejects.toThrow(WalStop);
  close(o);
  const m = markerStamp(path);
  quarantineIndex(path);
  // the fresh start fails at its first write (the attempt marker's write faults): exit(1), no close
  const f = await open(path, { reset: true, ignoreMarker: true });
  expect(f.verdict).toEqual({ state: "writable" });
  walTestHooks.fault = (name: string, op: string) => { if (name === "-walattempt" && op === "write") throw new Error("EIO"); };
  expect(() => f.wal.write("open", 4 * MB, () => rows(f.writable, 10_000))).toThrow(Exited);
  delete walTestHooks.fault;
  expect(markerStamp(path)).toEqual(m);
  killed.push(...live.splice(live.indexOf(f), 1)); // killed: its handles stay open
  const again = await open(path, { reset: true, ignoreMarker: true });
  expect(again.verdict).toEqual({ state: "writable" });
  expect(markerStamp(path)).toEqual(m);
});
