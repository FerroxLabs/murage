// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 W5 (MEMORY-V2-DESIGN 4.9 W5, R1; owners: index-debt.ts, io-budget admitIndexDebt and this witness = memv2-D; the open rule's
// call = lane A (index-wal.ts); the grant transport = lane E (worker-controller.ts), stood in for here by the same carrier the helper uses).
// An unclean stop leaves the helper's index with a log larger than any background ticket (the ledger admits at most BG_MINUTE_BYTES a minute).
// Before W5 the open rule set such a file aside and rebuilt the index from every receipt although quick_check and the geometry passed. Now the
// open check copies it under one index-debt grant charged to the background bucket as debt, and quarantine stays for damage only.
// Real path: a real index file whose 20 MiB log was left by a process that exited without closing it, the real open rule and open check with
// the helper's admission enforced (the native meter caps the copy at its grant), the real ledger (IoBudget) answering the helper's asks.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { BACKGROUND_BUCKET_BYTES_PER_MINUTE, BG_MINUTE_BYTES, IoBudget } from "../io-budget.ts";
import { ownerFirst } from "../owner-first.ts";
import { ioGrantSnapshot, resetIoMeterForTest, withBgGrant } from "../io-meter.ts";
import { acceptHelperTicket, configureHelperAdmission, type AdmissionPurpose } from "./helper-admission.ts";
import { bgFrames, copyCeiling, indexDebtCap, indexDebtPage, indexDebtTestHooks, INDEX_BG_TICKET_BYTES, INDEX_FRAME_BYTES, INDEX_LOG_MAX_FRAMES } from "./index-debt-ceiling.ts";
import { IndexDamagedError } from "./index-quarantine.ts";
import { MEMW_C_BYTES, MEMW_TICK_TRUNCATE_BYTES, openIndexWal, quarantineCounts, walTestHooks, type IndexWalWriter } from "./index-wal.ts";
import { DatabaseSync } from "node:sqlite";

const MiB = 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "index-debt-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let serial = 0;
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
});
const opened: Array<{ wal: IndexWalWriter }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) { try { o.wal.closeForQuarantine(); } catch { /* closed */ } }
  configureHelperAdmission(undefined); delete indexDebtTestHooks.page;
  for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key];
});
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

/** An index file in the open rule's geometry whose writer wrote `mib` MiB and exited without closing (no close checkpoint: the log keeps it). */
function uncleanIndex(mib: number): string {
  const dir = join(root, `case-${++serial}`), file = join(dir, "memory-index.db");
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { mkdirSync } from "node:fs"; import { DatabaseSync } from "node:sqlite";
    mkdirSync(${JSON.stringify(dir)}, { recursive: true });
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE w5_rows(n INTEGER, v BLOB)");
    const ins = db.prepare("INSERT INTO w5_rows VALUES (?, randomblob(1048576))");
    for (let i = 0; i < ${mib}; i++) ins.run(i);
    process.exit(0);`], { stdio: "pipe" });
  return file;
}
/** The helper's carrier, answered by a real ledger: an index-debt ask goes to admitIndexDebt, any other to the background ledger. */
function ledger(now: () => number, at: () => number = () => 1_000) {
  const budget = new IoBudget({ read: () => ({ at: at(), fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
  const tickets = new Map<string, NonNullable<ReturnType<IoBudget["admit"]>>>(), asks: Array<{ ceiling: number; purpose: AdmissionPurpose; granted: boolean }> = [];
  let id = 0;
  configureHelperAdmission({
    request: (ceiling, _replan, purpose) => {
      const ticket = purpose === "index-debt" ? budget.admitIndexDebt(ceiling, now()) : budget.admit("BG", ceiling);
      asks.push({ ceiling, purpose, granted: ticket !== null });
      if (!ticket) { acceptHelperTicket(null, 1); return; }
      const key = `grant-${++id}`; tickets.set(key, ticket);
      acceptHelperTicket({ ...ticket, id: key, purpose });
    },
    settle: (receipt, used) => { const t = tickets.get(receipt.id); if (t) { budget.settle(t, used); tickets.delete(receipt.id); } },
  });
  return { budget, asks };
}
const rows = (db: { prepare(sql: string): { get(): Record<string, unknown> | undefined } }) => Number(db.prepare("SELECT count(*) AS n FROM w5_rows").get()?.n);
/** Index files set aside (the main file of each quarantined set; its logs move with it). */
const asideCount = (file: string) => readdirSync(dirname(file)).filter(name => /\.corrupt-\d+$/.test(name)).length;
/** The open rule (steps 0-2) under the helper's boot ticket, as the helper opens its index at start. */
function open(file: string, budget: IoBudget) {
  walTestHooks.exit = (code: number) => { throw new Error(`exit ${code}`); };
  const boot = budget.admit("BG", MiB);
  expect(boot, "the boot ticket").not.toBeNull();
  const o = withBgGrant(boot!, () => openIndexWal(file, { charge: async () => true }));
  budget.settle(boot!, ioGrantSnapshot().usedBytes);
  const wal = o.wal as IndexWalWriter;
  opened.push({ wal });
  return { o, wal };
}

it("the one formula's constants are the ledger's and the envelope's: G = the background minute, F_C = floor((C - 32) / 4120)", () => {
  expect(INDEX_BG_TICKET_BYTES).toBe(BG_MINUTE_BYTES);
  expect(INDEX_LOG_MAX_FRAMES).toBe(Math.floor((MEMW_C_BYTES - 32) / INDEX_FRAME_BYTES));
  // D-R4 1.1 table: F_B(p) and K_MAX(p) at 4, 16 and 64 KiB OS pages
  expect([4096, 16384, 65536].map(bgFrames)).toEqual([3070, 766, 190]);
  expect([4096, 16384, 65536].map(indexDebtCap)).toEqual([29_196_288, 116_772_864, 467_079_168]);
});

it("W5 R2/R3 (ASTRA be394275a5 H1): the grant's cap scales with the OS page; a 20 MiB and a whole-C log are granted at 4, 16 and 64 KiB, and only an exact K(F, p) with F_B < F <= F_C is", () => {
  for (const page of [4096, 16384, 65536]) {
    indexDebtTestHooks.page = page;
    const budget = new IoBudget({ read: () => ({ at: 1_000, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
    for (const frames of [Math.ceil(20 * MiB / 4096), INDEX_LOG_MAX_FRAMES]) {
      const ticket = budget.admitIndexDebt(copyCeiling(frames, page));
      expect(ticket, `${frames} frames at ${page / 1024} KiB pages (ceiling ${copyCeiling(frames, page)})`).not.toBeNull();
      budget.settle(ticket!, 0);
    }
    expect(budget.admitIndexDebt(copyCeiling(bgFrames(page), page)), `F_B frames: a background ticket covers it (${page})`).toBeNull();
    expect(budget.admitIndexDebt(copyCeiling(INDEX_LOG_MAX_FRAMES + 1, page)), `F_C + 1 frames: more than one bounded log (${page})`).toBeNull();
    expect(budget.admitIndexDebt(copyCeiling(5000, page) + 1), `not an exact K(F, p) (${page})`).toBeNull();
    expect(budget.indexDebtRefusals.shape, "every refusal above was the shape door").toBe(3);
  }
});

it("W5 R8: the bucket is charged F x 4,096 for a copy that ran, the same at every page; 0 for one that never ran; a grant left open is charged before the next", () => {
  const charged: number[] = [];
  for (const page of [4096, 16384, 65536]) {
    indexDebtTestHooks.page = page;
    const budget = new IoBudget({ read: () => ({ at: 1_000, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
    const none = budget.admitIndexDebt(copyCeiling(5000, page));
    budget.settle(none!, 0);
    expect(budget.indexDebtCharged, "a copy that never ran is charged nothing").toBe(0);
    const ran = budget.admitIndexDebt(copyCeiling(5000, page));
    expect(budget.admitIndexDebt(copyCeiling(5000, page)), "one grant open at a time").toBeNull();
    expect(budget.indexDebtRefusals.open, "refused because one is open (not closed, charged and refused by the bucket)").toBe(1);
    budget.settle(ran!, copyCeiling(5000, page)); // a dead helper's grant is settled at its whole ceiling (worker-controller gone())
    charged.push(budget.indexDebtCharged);
  }
  expect(charged, "F x 4,096 on every page (meter bytes would be 4x / 16x on 16 / 64 KiB)").toEqual([5000 * 4096, 5000 * 4096, 5000 * 4096]);
});

it("W5 R10/R11: no grant while the disk is low or short of the copy, and a refused ask is retried no sooner than 1 s", () => {
  const page = indexDebtPage(), ceiling = copyCeiling(5000, page);
  const budget = new IoBudget({ read: () => ({ at: 1_000, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
  budget.setIndexDebtDisk(() => ({ refusing: true, free: null }));
  expect(budget.admitIndexDebt(ceiling), "the W4 low-disk verdict is set").toBeNull();
  budget.setIndexDebtDisk(() => ({ refusing: false, free: 5000 * 4096 + 63 * MiB }));
  expect(budget.admitIndexDebt(ceiling), "free space is under the copy plus the 64 MiB floor").toBeNull();
  expect(budget.indexDebtRefusals.disk).toBe(2);
  expect(budget.indexDebtRetryMs(), "re-asked at the door's time, at least 1 s").toBeGreaterThanOrEqual(1000);
  budget.setIndexDebtDisk(() => ({ refusing: false, free: 5000 * 4096 + 65 * MiB }));
  expect(budget.admitIndexDebt(ceiling), "the disk is freed: granted").not.toBeNull();
});

it("W5 the grant is refused while the owner is active, at the main log's half gate, at or under a background ticket and over its ceiling", () => {
  const budget = new IoBudget({ read: () => ({ at: 1_000, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
  const endTurn = ownerFirst.beginOwnerTurn();
  const page = indexDebtPage(), K = (frames: number) => copyCeiling(frames, page), twenty = Math.ceil(20 * MiB / 4096);
  try { expect(budget.admitIndexDebt(K(twenty)), "the owner is active").toBeNull(); } finally { endTurn(); }
  budget.setWalBacklog(() => 300 * MiB);
  expect(budget.admitIndexDebt(K(twenty)), "the main log is at its half gate").toBeNull();
  budget.setWalBacklog(null);
  expect(budget.admitIndexDebt(K(bgFrames(page))), "a background ticket can cover it").toBeNull();
  expect(budget.admitIndexDebt(indexDebtCap(page) + 1), "over the grant's cap").toBeNull();
  const ticket = budget.admitIndexDebt(K(twenty));
  expect(ticket, "otherwise granted").not.toBeNull();
  budget.settle(ticket!, 0);
  expect(budget.admitIndexDebt(K(twenty)), "settled at 0: nothing was charged, the next is granted").not.toBeNull();
});

it("W5: an undamaged index log over a background ticket after an unclean stop is copied, not set aside and rebuilt", async () => {
  const file = uncleanIndex(20);
  expect(statSync(file + "-wal").size, "the unclean stop left the log").toBeGreaterThan(20 * MiB);
  const { budget, asks } = ledger(() => Date.now());
  const { o, wal } = open(file, budget);
  // base: helperEnforced && indexDebtBytes > 12 MiB set the whole set aside (rebuilt = true, a fresh empty file)
  expect(o.rebuilt, "not set aside").toBe(false);
  expect(asideCount(file), "no quarantined copy").toBe(0);
  expect(wal.indexDebtBytes() / 4096, "the log's un-copied frames: more than one background ticket copies").toBeGreaterThan(bgFrames(indexDebtPage()));
  let verdict = await wal.openCheck();
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck(); // a first ask may be answered on the next try
  console.log(`[W5] asks ${JSON.stringify(asks)}; verdict ${JSON.stringify(verdict)}; bucket wait ${budget.backgroundBucketWait()} ms`);
  expect(verdict.state, "the open check passed after its one copy").toBe("writable");
  const mark = wal.walMark();
  expect(mark && mark.mxFrame > 0 && mark.nBackfill === mark.mxFrame, "every frame of the log was copied").toBe(true);
  expect(budget.indexDebtGrants, "one index-debt grant").toBe(1);
  expect(asks.filter(a => a.purpose === "index-debt" && a.granted).length).toBe(1);
  // the copy was charged to the background bucket as debt: about 20 MiB at 8 MiB a minute
  expect(budget.backgroundBucketWait(), "the bucket is behind by the copy").toBeGreaterThanOrEqual(Math.floor(20 * MiB / BACKGROUND_BUCKET_BYTES_PER_MINUTE * 60_000 * 0.9));
  expect(rows(o.writable), "the index kept every row").toBe(20);
});

it("W5: the grant is refused while the background bucket is behind; the file is neither copied nor set aside, and is copied once it is not", async () => {
  const file = uncleanIndex(16);
  let ahead = 0;
  const { budget, asks } = ledger(() => Date.now() + ahead);
  budget.chargeBackgroundBucket(8 * MiB); // the bucket is a minute behind
  const { o, wal } = open(file, budget);
  expect(o.rebuilt).toBe(false);
  let verdict = await wal.openCheck();
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
  expect(verdict.state, "refused: the check stays owed").toBe("unresolved");
  expect(asks.some(a => a.purpose === "index-debt" && !a.granted), "asked for the index-debt grant and was refused").toBe(true);
  expect(budget.indexDebtGrants).toBe(0);
  expect(asideCount(file)).toBe(0);
  ahead = 61_000; // the bucket has caught up
  await new Promise(r => setTimeout(r, 5)); // the refusal's retry time (1 ms) has passed
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
  expect(verdict.state).toBe("writable");
  expect(budget.indexDebtGrants).toBe(1);
});

// Rewritten for ASTRA be394275a5 H2 (D-R4 1.2-1.3, R4/R5): r3 set this file aside before the open check, although it has no wal_check row
// and quick_check and the geometry pass (the open check's own no-row branch passes such a log). No row is never damage. A log over C that
// no row bounds is UK-U3: stopped in place (the -walstop marker binds), never quarantined, never copied under a grant.
it("W5 (ASTRA be394275a5 H2): a healthy no-row log over the file's bound C is stopped in place, not set aside and rebuilt, and no copy is asked", async () => {
  const file = uncleanIndex(Math.ceil(MEMW_C_BYTES / MiB) + 2);
  const { budget, asks } = ledger(() => Date.now());
  const before = { ...quarantineCounts };
  const { o, wal } = open(file, budget);
  expect(o.rebuilt, "not set aside").toBe(false);
  expect(asideCount(file), "no quarantined copy").toBe(0);
  expect(quarantineCounts, "no quarantine counted").toEqual(before);
  // the open check's stepZero stops a log over C in place before any copy (the -walstop marker binds; WalStop stop_in_place)
  const verdict = await wal.openCheck().then(v => v.state, (error: Error) => error.message);
  expect(verdict, "stopped in place").toMatch(/stop/);
  expect(wal.stopped, "the writer is stopped").toBe(true);
  expect(asks.filter(a => a.purpose === "index-debt"), "no index-debt copy was asked for").toEqual([]);
  expect(rows(o.writable), "the rows are still there to serve").toBe(Math.ceil(MEMW_C_BYTES / MiB) + 2);
});

it("W5 HO at 16 and 64 KiB pages (ASTRA be394275a5 H1): the 20 MiB log's copy costs more than 64 MiB of meter bytes and is still granted once and copied", async () => {
  for (const page of [16384, 65536]) {
    indexDebtTestHooks.page = page;
    const file = uncleanIndex(20);
    const { budget, asks } = ledger(() => Date.now());
    const { o, wal } = open(file, budget);
    expect(o.rebuilt, `not set aside (${page})`).toBe(false);
    let verdict = await wal.openCheck();
    for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
    const ask = asks.find(a => a.purpose === "index-debt");
    console.log(`[W5-PAGE] ${page}: ask ${JSON.stringify(ask)} cap ${indexDebtCap(page)} verdict ${verdict.state}`);
    expect(ask?.ceiling ?? 0, `the ask is over the old fixed 64 MiB cap (${page})`).toBeGreaterThan(64 * MiB);
    expect(ask?.granted, `granted (${page})`).toBe(true);
    expect(verdict.state, `writable after the one copy (${page})`).toBe("writable");
    expect(budget.indexDebtCharged % 4096, "charged in SQLite pages").toBe(0);
    expect(rows(o.writable)).toBe(20);
    delete indexDebtTestHooks.page;
  }
});

it("W5 R6: a quarantine writes its cause in the fresh file's first wal_check row", async () => {
  const file = uncleanIndex(2);
  const { budget } = ledger(() => Date.now());
  walTestHooks.geometry = (_db, rebuilt) => { if (!rebuilt) throw new IndexDamagedError("geometry:fixture-damage"); };
  const before = quarantineCounts.geometry;
  const { o, wal } = open(file, budget);
  expect(o.rebuilt).toBe(true);
  expect(quarantineCounts.geometry, "counted by its cause").toBe(before + 1);
  let verdict = await wal.openCheck();
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
  expect(verdict.state).toBe("writable");
  wal.write("group", 4 * INDEX_FRAME_BYTES, () => {});
  const row = JSON.parse(String((o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get() as { value: string }).value));
  expect(row.q, "the cause, a code only").toBe("geometry");
  await wal.check();
  wal.write("group", 4 * INDEX_FRAME_BYTES, () => {});
  const next = JSON.parse(String((o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get() as { value: string }).value));
  expect(next.q, "written once, in the first row only").toBeUndefined();
});

it("W5 R6: a fresh file beside a set-aside one with no recorded cause (a crash between the rename and the first row) writes q unrecorded", async () => {
  const dir = join(root, `case-${++serial}`), file = join(dir, "memory-index.db");
  execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(dir)},{recursive:true});require("node:fs").writeFileSync(${JSON.stringify(file + ".corrupt-1234")},"")`]);
  const { budget } = ledger(() => Date.now());
  const { o, wal } = open(file, budget);
  let verdict = await wal.openCheck();
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
  expect(verdict.state).toBe("writable");
  wal.write("group", 4 * INDEX_FRAME_BYTES, () => {});
  const row = JSON.parse(String((o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get() as { value: string }).value));
  expect(row.q).toBe("unrecorded");
  void DatabaseSync;
});

it("W5 R6 (Opus r4 review M2): a reset's own fresh file (the reset moved the old set aside itself) does not write q unrecorded", async () => {
  const dir = join(root, `case-${++serial}`), file = join(dir, "memory-index.db");
  execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(dir)},{recursive:true});require("node:fs").writeFileSync(${JSON.stringify(file + ".corrupt-1234")},"")`]);
  const { budget } = ledger(() => Date.now());
  walTestHooks.exit = (code: number) => { throw new Error(`exit ${code}`); };
  const boot = budget.admit("BG", MiB);
  const o = withBgGrant(boot!, () => openIndexWal(file, { charge: async () => true, ignoreMarker: true }));
  budget.settle(boot!, ioGrantSnapshot().usedBytes);
  const wal = o.wal as IndexWalWriter; opened.push({ wal });
  let verdict = await wal.openCheck();
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
  expect(verdict.state).toBe("writable");
  wal.write("group", 4 * INDEX_FRAME_BYTES, () => {});
  const row = JSON.parse(String((o.writable.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get() as { value: string }).value));
  expect(row.q, "a reset is not a quarantine").toBeUndefined();
});

it("W5: a damaged index is still set aside and rebuilt", () => {
  const file = uncleanIndex(14);
  const { budget } = ledger(() => Date.now());
  walTestHooks.geometry = (_db, rebuilt) => { if (!rebuilt) throw new IndexDamagedError("geometry:fixture-damage"); };
  const { o } = open(file, budget);
  expect(o.rebuilt, "damage still quarantines").toBe(true);
  expect(asideCount(file)).toBe(1);
  expect(existsSync(file)).toBe(true);
});

// W5-LIVE (D-R4 1.6, R14). Proof obligation: on 16 KiB OS pages, can a live log (writes while a reader pins the index so no copy lands)
// owe more frames than one background ticket copies? Before r4 the live bound was 8 MiB of SQLite bytes (2,048 frames), whose copy costs
// 32 MiB of meter bytes on 16 KiB pages, more than any ticket (12 MiB): the log reached HO live and its writes stopped for good. Now the
// bound is min(2,048, F_B(p)) frames, and once the reader lets go one background ticket copies it and writes resume.
it("W5-LIVE: at 64 KiB pages the live bound is F_B(p) frames, a pinned live log stays under it, and after the pin one background ticket copies it and writes resume", async () => {
  indexDebtTestHooks.page = 65536;
  const dir = join(root, `case-${++serial}`), file = join(dir, "memory-index.db");
  execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(dir)},{recursive:true})`]);
  let clock = 1_000;
  const { budget, asks } = ledger(() => Date.now(), () => clock);
  const { o, wal } = open(file, budget);
  let verdict = await wal.openCheck();
  for (let i = 0; i < 3 && verdict.state === "unresolved"; i++) verdict = await wal.openCheck();
  expect(verdict.state).toBe("writable");
  // the writer's own live bound at this page: F_B(64K) = 190 frames (base: 8 MiB = 2,048 frames, whose copy no background ticket covers)
  expect(wal.liveBound(), "the live bound is what one background ticket copies at 64 KiB").toBe(bgFrames(65536) * 4096);
  indexDebtTestHooks.page = 4096;
  expect(wal.liveBound(), "unchanged at 4 KiB pages (2,048 < F_B(4K) = 3,070)").toBe(MEMW_TICK_TRUNCATE_BYTES);
  indexDebtTestHooks.page = 65536;
  const reserve = 24 * INDEX_FRAME_BYTES, body = () => { o.writable.exec("CREATE TABLE IF NOT EXISTS live_rows(v BLOB)"); o.writable.exec("INSERT INTO live_rows VALUES (randomblob(65536))"); };
  wal.write("group", reserve, body); await wal.check();
  const pin = new DatabaseSync(file, { readOnly: true });
  pin.exec("BEGIN"); pin.prepare("SELECT count(*) FROM live_rows").get(); // the reader's snapshot: no copy passes it
  let writes = 0, maxFrames = 0;
  try {
    for (; writes < 600; writes++) {
      // a refused grant (the ledger's minute is spent: BgDeferred) waits for the next minute; only the live bound (admit false) stops the writes
      let admitted: boolean | null = null;
      for (let minute = 0; admitted === null && minute < 20; minute++) {
        try { admitted = wal.admit("group", reserve); } catch (error) { if (!(error instanceof BgDeferred)) throw error; clock += 61_000; await new Promise(r => setTimeout(r, 3)); }
      }
      if (admitted !== true) break;
      try { wal.write("group", reserve, body); } catch (error) { if (!(error instanceof BgDeferred)) throw error; clock += 61_000; await new Promise(r => setTimeout(r, 3)); wal.write("group", reserve, body); }
      await wal.check();
      maxFrames = Math.max(maxFrames, wal.indexDebtBytes() / 4096);
    }
  } finally { pin.exec("COMMIT"); pin.close(); }
  console.log(`[W5-LIVE] 64K: ${writes} pinned writes, live debt peaked at ${maxFrames} frames (F_B ${bgFrames(65536)}, old bound 2048)`);
  expect(writes, "the pinned writes stopped at the live bound").toBeLessThan(600);
  // base (8 MiB = 2,048 frames): the pinned writes run on until the ledger's minute is spent, far past F_B(64K) = 190
  expect(maxFrames, "the live debt never passed what one background ticket copies").toBeLessThanOrEqual(bgFrames(65536));
  clock += 61_000; // the next ledger minute
  const sealed = await wal.sealAndTruncate();
  expect(sealed.truncated, "after the pin, one background ticket copied the log").toBe(true);
  expect(asks.filter(a => a.purpose === "index-debt"), "no index-debt grant for a live log").toEqual([]);
  expect(wal.admit("group", reserve), "writes resume").toBe(true);
});
