// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 W5, the generated matrix of D-R4 3.1 (owner: memv2-D). Every cell is <state>.<event>.<page> of the helper index log
// state machine (D-R4 1.2-1.4) and asserts its verdict, quarantine (and the cause row), grant purpose, ceiling, bucket charge and the
// forbidden effects. Real path only: every fixture is a real index file left by a real writer in a child process that exited without
// closing it, opened by the real open rule and open check with the helper's admission enforced (the native meter caps every copy at its
// grant) and answered by a real ledger (IoBudget). The page column is the meter page every W5 decision uses (indexDebtTestHooks.page).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { IoBudget } from "../io-budget.ts";
import { ioGrantSnapshot, resetIoMeterForTest, withBgGrant } from "../io-meter.ts";
import { ownerFirst } from "../owner-first.ts";
import { acceptHelperTicket, configureHelperAdmission, type AdmissionPurpose } from "./helper-admission.ts";
import { bgFrames, copyCeiling, INDEX_FRAME_BYTES, INDEX_SQLITE_PAGE, indexDebtCap, indexDebtTestHooks } from "./index-debt-ceiling.ts";
import { IndexDamagedError } from "./index-quarantine.ts";
import { MEMW_C_BYTES, openIndexWal, quarantineCounts, walTestHooks, type IndexWalWriter, type OpenVerdict } from "./index-wal.ts";

const MiB = 1024 * 1024;
const NAME = "memory-index.db";
const root = mkdtempSync(join(tmpdir(), "index-debt-matrix-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type State = "HU" | "HP-page" | "HO-norow" | "HO-row" | "DM-geo" | "DM-rise-over" | "UK-overC-norow";
type Event = "open" | "refuse-bucket" | "refuse-owner" | "refuse-half" | "refuse-disk" | "ck-err" | "crash";
type Cls = "HU" | "HO" | "DM" | "UK";
const STATES: State[] = ["HU", "HP-page", "HO-norow", "HO-row", "DM-geo", "DM-rise-over", "UK-overC-norow"];
const EVENTS: Event[] = ["open", "refuse-bucket", "refuse-owner", "refuse-half", "refuse-disk", "ck-err", "crash"];
const PAGES = [4096, 16384, 65536] as const;
const pageTag = (p: number) => `${p / 1024}K`;
/** D-R4 1.2: the state a fixture is in at page p. HP-page is the page column's own fixture: HU at 4 KiB, HO at 16 and 64 KiB. */
const classOf = (state: State, p: number): Cls =>
  state === "HU" ? "HU" : state === "HP-page" ? (p === 4096 ? "HU" : "HO") : state.startsWith("HO") ? "HO" : state.startsWith("DM") ? "DM" : "UK";
const CASES = STATES.flatMap(state => EVENTS.flatMap(event => PAGES.map(p => ({ id: `${state}.${event}.${pageTag(p)}`, state, event, p }))));

// ---- fixtures: real files left by a real writer that exited without closing (built once, copied per case) ----
const fx = {} as Record<State, { dir: string; frames: number }>;
function child(script: string, ts = false): void {
  execFileSync(process.execPath, [...ts ? ["--experimental-strip-types"] : [], "--input-type=module", "-e", script], { env: { ...process.env, MURAGE_BG_BOOT: "" }, stdio: "pipe" });
}
/** A no-row index (no MEMW check ever ran: an older build or an unenforced run) whose writer inserted `rows` blobs of `bytes` and exited. */
function noRow(state: State, rows: number, bytes: number): void {
  const dir = join(root, "fx", state), file = join(dir, NAME);
  mkdirSync(dir, { recursive: true });
  child(`
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE w5_rows(n INTEGER, v BLOB)");
    const ins = db.prepare("INSERT INTO w5_rows VALUES (?, randomblob(${bytes}))");
    for (let i = 0; i < ${rows}; i++) ins.run(i);
    process.exit(0);`);
}
/** A row-bearing index written by the real MEMW writer (open rule, open check, wal.write), then `tail` run raw on its connection, then exit. */
function withRow(state: State, reserve: number, inWrite: string, tail: string): void {
  const dir = join(root, "fx", state), file = join(dir, NAME);
  mkdirSync(dir, { recursive: true });
  child(`
    import { openIndexWal } from ${JSON.stringify(resolve("server/memory/index-wal.ts"))};
    const o = openIndexWal(${JSON.stringify(file)}, { charge: async () => true });
    const v = await o.wal.openCheck();
    if (v.state !== "writable") throw new Error("fixture open " + JSON.stringify(v));
    const db = o.writable;
    o.wal.write("open", ${reserve}, () => { ${inWrite} });
    ${tail}
    process.exit(0);`, true);
}
const framesOf = (state: State) => {
  const lw = statSync(join(root, "fx", state, `${NAME}-wal`)).size, frames = (lw - 32) / INDEX_FRAME_BYTES;
  expect(Number.isInteger(frames), `${state}: the log ends on a frame`).toBe(true);
  return frames;
};

beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
  noRow("HU", 40, 3000);
  noRow("HP-page", 4, MiB);
  noRow("HO-norow", 20, MiB);
  withRow("HO-row", 24 * MiB, `db.exec("CREATE TABLE w5_rows(n INTEGER, v BLOB)"); const ins = db.prepare("INSERT INTO w5_rows VALUES (?, randomblob(1048576))"); for (let i = 0; i < 20; i++) ins.run(i);`, "");
  noRow("DM-geo", 14, MiB);
  withRow("DM-rise-over", 8 * INDEX_FRAME_BYTES, "", `db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE legacy_tail(v); INSERT INTO legacy_tail VALUES(zeroblob(14680064))");`);
  noRow("UK-overC-norow", 30, MiB);
  for (const state of STATES) fx[state] = { dir: join(root, "fx", state), frames: framesOf(state) };
  // the fixtures are the states they are named for, by the one formula (D-R4 1.1)
  expect(fx.HU.frames, "HU: under a background ticket at every page").toBeLessThanOrEqual(bgFrames(65536));
  expect(fx["HP-page"].frames, "HP-page: HU at 4 KiB").toBeLessThanOrEqual(bgFrames(4096));
  expect(fx["HP-page"].frames, "HP-page: HO at 16 KiB").toBeGreaterThan(bgFrames(16384));
  for (const s of ["HO-norow", "HO-row", "DM-geo", "DM-rise-over"] as const) expect(fx[s].frames, `${s}: over a background ticket at every page`).toBeGreaterThan(bgFrames(4096));
  expect(statSync(join(fx["UK-overC-norow"].dir, `${NAME}-wal`)).size, "UK: the no-row log is over C").toBeGreaterThan(MEMW_C_BYTES);
}, 120_000);

// ---- per case: the ledger, the open, the doors ----
let serial = 0;
const opened: IndexWalWriter[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) { try { undo(); } catch { /* released */ } }
  for (const wal of opened.splice(0)) { try { wal.closeForQuarantine(); } catch { /* closed */ } }
  configureHelperAdmission(undefined);
  for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key];
  delete indexDebtTestHooks.page;
  for (const name of readdirSync(root)) if (name.startsWith("case-")) rmSync(join(root, name), { recursive: true, force: true });
});
afterAll(() => {
  if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior;
  forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true });
});
function caseCopy(from: string): string {
  const dir = join(root, `case-${++serial}`);
  cpSync(from, dir, { recursive: true });
  return join(dir, NAME);
}
/** The helper's carrier answered by a real ledger: an index-debt ask goes to admitIndexDebt, any other to the background ledger. "dead":
 * the ledger answers but the helper died before the reply reached it (the controller holds the ticket). */
function ledger(now: () => number) {
  let at = 1_000;
  const budget = new IoBudget({ read: () => ({ at, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
  const tickets = new Map<string, NonNullable<ReturnType<IoBudget["admit"]>>>(), dead: Array<NonNullable<ReturnType<IoBudget["admit"]>>> = [];
  const asks: Array<{ ceiling: number; purpose: AdmissionPurpose; granted: boolean }> = [];
  let id = 0, alive = true;
  const connect = () => configureHelperAdmission({
    request: (ceiling, _replan, purpose) => {
      const ticket = purpose === "index-debt" ? budget.admitIndexDebt(ceiling, now()) : budget.admit("BG", ceiling);
      asks.push({ ceiling, purpose, granted: ticket !== null });
      if (!alive) { if (ticket) dead.push(ticket); return; }
      if (!ticket) { acceptHelperTicket(null, 1); return; }
      const key = `grant-${++id}`; tickets.set(key, ticket);
      acceptHelperTicket({ ...ticket, id: key, purpose });
    },
    settle: (receipt, used) => { const t = tickets.get(receipt.id); if (t) { budget.settle(t, used); tickets.delete(receipt.id); } },
  });
  connect();
  return { budget, asks, dead, die() { alive = false; }, restart() { alive = true; connect(); }, nextMinute() { at += 60_000; } };
}
/** The open rule (steps 0-2) under the helper's boot ticket, as the helper opens its index at start. */
function open(file: string, budget: IoBudget) {
  walTestHooks.exit = (code: number) => { throw new Error(`exit ${code}`); };
  const boot = budget.admit("BG", MiB);
  expect(boot, "the boot ticket").not.toBeNull();
  const o = withBgGrant(boot!, () => openIndexWal(file, { charge: async () => true }));
  budget.settle(boot!, ioGrantSnapshot().usedBytes);
  const wal = o.wal as IndexWalWriter;
  opened.push(wal);
  return { o, wal };
}
/** The open check until it settles (a refused or first ask is answered on a later try; at most `tries`). A stop thrown is a stopped verdict. */
async function settle(wal: IndexWalWriter, tries = 5): Promise<OpenVerdict> {
  let v: OpenVerdict = { state: "unresolved", reason: "not_run" };
  for (let i = 0; i < tries; i++) {
    try { v = await wal.openCheck(); } catch (error) { return { state: "stopped", reason: String((error as Error).message), fileId: null, seq: null }; }
    if (v.state !== "unresolved") return v;
    await sleep(5);
  }
  return v;
}
/** The fresh file's first MEMW write (retried while its background grant is on the way), then its wal_check row's q. */
async function firstRowQ(o: { writable: { prepare(sql: string): { get(): Record<string, unknown> | undefined } } }, wal: IndexWalWriter): Promise<unknown> {
  for (let i = 0; ; i++) {
    try { wal.write("open", 4 * INDEX_FRAME_BYTES, () => {}); break; } catch (error) { if (!(error instanceof BgDeferred) || i >= 5) throw error; await sleep(5); }
  }
  const text = o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get()?.value;
  return JSON.parse(String(text)).q;
}
const asideCount = (file: string) => readdirSync(dirname(file)).filter(name => /\.corrupt-\d+$/.test(name)).length;
const owed = (wal: IndexWalWriter) => { const m = wal.walMark(); return m ? m.mxFrame - m.nBackfill : -1; };
type Door = Exclude<Event, "open" | "ck-err" | "crash">;
const DOOR_NAME: Record<Door, "bucket" | "owner" | "half" | "disk"> = { "refuse-bucket": "bucket", "refuse-owner": "owner", "refuse-half": "half", "refuse-disk": "disk" };
/** Closes one door of admitIndexDebt (D-R4 1.5) and returns its release. */
function closeDoor(door: Door, budget: IoBudget, now: () => number, advance: (ms: number) => void): () => void {
  if (door === "refuse-bucket") { budget.chargeBackgroundBucket(8 * MiB, now()); return () => advance(61_000); } // a minute behind
  if (door === "refuse-owner") { const end = ownerFirst.beginOwnerTurn(); cleanup.push(end); return end; }
  if (door === "refuse-half") { budget.setWalBacklog(() => 300 * MiB); return () => budget.setWalBacklog(null); }
  budget.setIndexDebtDisk(() => ({ refusing: true, free: null }));
  return () => budget.setIndexDebtDisk(null);
}

describe.each(STATES)("W5 matrix %s", state => {
  it.each(CASES.filter(c => c.state === state))("$id", async ({ id, event, p }) => {
    indexDebtTestHooks.page = p;
    const k = classOf(state, p), F = fx[state].frames, S = INDEX_SQLITE_PAGE;
    let ahead = 0;
    const now = () => Date.now() + ahead;
    const L = ledger(now), { budget, asks } = L;
    let file = caseCopy(fx[state].dir);
    // every checkpoint statement records how many sets were aside when it ran (DM: none before the rename); ck-err loses one result
    const ckAside: number[] = [];
    let ckErr = event === "ck-err";
    walTestHooks.checkpoint = (db, mode) => {
      ckAside.push(asideCount(file));
      const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as { busy: number; log: number; checkpointed: number };
      if (ckErr) { ckErr = false; throw new Error("ck-err fixture: the copy ran, its result was lost"); }
      return r;
    };
    let geoDamaged = state === "DM-geo";
    walTestHooks.geometry = (_db, rebuilt) => { if (geoDamaged && !rebuilt) throw new IndexDamagedError("geometry:fixture"); };
    const q0 = { ...quarantineCounts };
    const cause = state === "DM-geo" ? "geometry" : "open_rise";

    let { o, wal } = open(file, budget);
    let verdict: OpenVerdict;
    let expectQ: string = cause, quarantines = k === "DM" ? 1 : 0, grants = k === "HO" ? 1 : 0;
    // ---- D-R4 1.4 open: the classification at open (before any copy) ----
    expect(o.rebuilt, `${id}: set aside and rebuilt only when DM`).toBe(k === "DM");
    expect(asideCount(file), `${id}: quarantine only in DM`).toBe(k === "DM" ? 1 : 0);
    if (k === "HU" || k === "HO") expect(owed(wal), `${id}: F = the log's frames`).toBe(F);

    if (event === "crash") {
      // the first helper reaches its ask, the ledger answers, and it is killed before the reply arrives: its handle is abandoned (no close)
      L.die();
      const first = await settle(wal, 2);
      expect(first.state, `${id}: the killed helper never became writable`).toBe(k === "UK" ? "stopped" : "unresolved");
      if (k === "HO") {
        expect(L.dead.length, `${id}: the ledger granted the killed helper's copy`).toBe(1);
        expect(budget.admitIndexDebt(copyCeiling(F, p), now()), `${id}: never two index-debt grants open`).toBeNull();
        expect(budget.indexDebtRefusals.open, `${id}: refused at the open-grant door`).toBe(1);
      }
      // the controller settles the dead helper's grants at their whole bytes before the next helper starts (worker-controller helper exit):
      // an index-debt one is charged F x S to the bucket, never 0 and never meter bytes
      for (const t of L.dead) budget.settle(t, t.bytes);
      if (k === "HO") {
        expect(budget.indexDebtCharged, `${id}: the dead helper's grant charged F x S`).toBe(F * S);
        expect(budget.backgroundBucketWait(now()), `${id}: the bucket is behind by the dead copy`).toBeGreaterThan(0);
      }
      // the dead helper's settled grants fill this minute's ledger (planned bytes); the next helper's asks land in the next minute
      L.nextMinute();
      // the next helper starts on the file set exactly as the dead one left it
      file = caseCopy(dirname(file));
      geoDamaged = false; // the fresh file the dead helper made is undamaged
      L.restart();
      ({ o, wal } = open(file, budget));
      expect(o.rebuilt, `${id}: never a second quarantine`).toBe(false);
      expect(asideCount(file), `${id}: the set aside before the crash is still the only one`).toBe(k === "DM" ? 1 : 0);
      if (k === "HU" || k === "HO") expect(owed(wal), `${id}: F re-measured, nothing was copied`).toBe(F);
      if (k === "HO") {
        // the new grant waits out the bucket debt of the dead one (re-ask after backgroundBucketWait), then is the one grant
        expect((await settle(wal, 1)).state, `${id}: the bucket door holds the re-ask`).toBe("unresolved");
        expect(budget.indexDebtRefusals.bucket, `${id}: refused at the bucket door`).toBeGreaterThanOrEqual(1);
        ahead += budget.backgroundBucketWait(now()) + 1;
      }
      if (k === "HO") grants = 2;
      if (k === "DM") expectQ = "unrecorded";
    } else if (event.startsWith("refuse-")) {
      const door = event as Door;
      const release = closeDoor(door, budget, now, ms => { ahead += ms; });
      verdict = await settle(wal, 3);
      if (k === "HO") {
        expect(verdict.state, `${id}: refused, the open check stays owed`).toBe("unresolved");
        expect(budget.indexDebtRefusals[DOOR_NAME[door]], `${id}: refused at the ${DOOR_NAME[door]} door`).toBeGreaterThanOrEqual(1);
        expect(asks.some(a => a.purpose === "index-debt" && !a.granted), `${id}: the index-debt ask was refused`).toBe(true);
        expect(budget.indexDebtGrants, `${id}: no grant`).toBe(0);
      }
      if (k === "HU" || k === "HO") {
        if (verdict.state === "unresolved") expect(owed(wal), `${id}: a refused ask leaves the file un-copied`).toBe(F);
        expect(asideCount(file), `${id}: a refused ask never sets the file aside`).toBe(0);
        expect(existsSync(file)).toBe(true);
      }
      if (k === "HU" && door === "refuse-half") expect(verdict.state, `${id}: the half gate stops background work`).toBe("unresolved");
      if (k === "UK") expect(verdict.state, `${id}: UK stays stopped`).toBe("stopped");
      release();
    }
    verdict = await settle(wal);

    // ---- the cell's outcome (D-R4 1.4) ----
    const debtAsks = asks.filter(a => a.purpose === "index-debt");
    expect(verdict.state, `${id}: verdict ${JSON.stringify({ verdict, asks, refusals: budget.indexDebtRefusals })}`).toBe(k === "UK" ? "stopped" : "writable");
    expect(asideCount(file), `${id}: quarantine yes/no`).toBe(quarantines);
    expect(budget.indexDebtGrants, `${id}: index-debt grants`).toBe(grants);
    if (k === "HO") {
      expect(debtAsks.length, `${id}: the copy asked for the index-debt grant`).toBeGreaterThanOrEqual(1);
      for (const a of debtAsks) expect(a.ceiling, `${id}: the ask is K(F, p)`).toBe(copyCeiling(F, p));
      expect(budget.indexDebtCharged, `${id}: the bucket is charged F x 4096 per grant, the same at every page`).toBe(grants * F * S);
      const mark = wal.walMark();
      expect(mark && mark.mxFrame > 0 && mark.nBackfill === mark.mxFrame, `${id}: every frame was copied`).toBe(true);
    }
    if (k === "HU") {
      expect(asks[0], `${id}: the copy asks one background ticket of K(F, p)`).toMatchObject({ purpose: "bg", ceiling: copyCeiling(F, p) });
      const mark = wal.walMark();
      expect(mark && mark.nBackfill === mark.mxFrame, `${id}: copied under the background ticket`).toBe(true);
    }
    if (k === "DM") {
      expect(ckAside.every(n => n === 1), `${id}: no checkpoint statement before the rename`).toBe(true);
      const q0n = quarantineCounts[cause] - q0[cause];
      expect(q0n, `${id}: one quarantine counted by its cause`).toBe(1);
      expect(await firstRowQ(o, wal), `${id}: the fresh file's first wal_check row carries the cause`).toBe(expectQ);
    }
    if (k === "UK") {
      expect(ckAside.length, `${id}: no copy in UK`).toBe(0);
      expect(asks.filter(a => a.purpose !== "bg" || a.ceiling >= copyCeiling(1, p)), `${id}: no copy ask in UK (only the stop marker's sidecar write)`).toEqual([]);
    }
    // ---- forbidden effects ----
    if (k !== "HO") {
      expect(debtAsks, `${id}: no index-debt ask outside HO`).toEqual([]);
      expect(budget.indexDebtCharged, `${id}: no index-debt charge outside HO`).toBe(0);
    }
    for (const a of debtAsks) expect(a.ceiling, `${id}: no ask over the cap K_MAX(p)`).toBeLessThanOrEqual(indexDebtCap(p));
    if (k !== "DM") expect(Object.values(quarantineCounts).reduce((x, y) => x + y, 0) - Object.values(q0).reduce((x, y) => x + y, 0), `${id}: no quarantine outside DM`).toBe(0);
  }, 60_000);
});

it("the matrix is the whole cross product: 7 states x 7 events x 3 pages", () => {
  expect(CASES.length).toBe(147);
  expect(new Set(CASES.map(c => c.id)).size).toBe(147);
});
