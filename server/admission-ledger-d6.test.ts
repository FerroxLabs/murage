// SPDX-License-Identifier: AGPL-3.0-or-later
// WAL-ADMISSION-HANG r3 (MC63 DESIGN-D6.md D6.1 + DESIGN-D6.2-DELTA.md D6.2/D6.2a): one settlement and reservation ledger.
// Every test here is RED by behavior on the pre-D6 code and GREEN on D6. Test names carry the design ids so a mutation runner can
// check the NAMED test, not just a non-zero exit. Clocks are the IoBudget `read` option (a fixture), never the wall clock.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import * as budgetModule from "./io-budget.ts";
import { BLOCK_BYTES, IoBudget, osWriteBlocks } from "./io-budget.ts";

const MIN = 60_000, M0 = 1_000_000 * MIN;
type Any = any; // the D6 surface is absent on the pre-D6 code: calls are made through `any` so the failure is behavioral

function fx(startAt = M0 - 2 * MIN, realOs = false) {
  const st = { at: startAt, os: 0, osKnown: true, meter: 0, meterKnown: true };
  const read = () => {
    if (realOs) { const blocks = osWriteBlocks(process.resourceUsage()); return { at: st.at, cpuMicros: 0, fsWriteBlocks: blocks, osKnown: st.osKnown, os: { total: blocks * BLOCK_BYTES, known: st.osKnown } } as never; }
    return { at: st.at, cpuMicros: 0, fsWriteBlocks: st.os / BLOCK_BYTES, osKnown: st.osKnown, meterBytes: st.meter, meter: { total: st.meter, known: st.meterKnown }, os: { total: st.os, known: st.osKnown } } as never;
  };
  const lines: string[] = [];
  const b = new IoBudget({ read, log: l => lines.push(l), isIdle: () => false });
  const buf = b.checkpointAdmissionBuffer(), s = new BigInt64Array(buf);
  return { st, b, a: b as Any, lines, buf, s, n: (i: number) => Number(s[i]), owners: () => [18, 21, 24, 27].map(i => s[i]!).filter(o => o !== 0n) };
}
type Fx = ReturnType<typeof fx>;
/** A worker that takes the ledger lock and holds it until told to let go. */
async function hold(buf: SharedArrayBuffer) {
  const w = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const l = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    l.lock(); parentPort.postMessage({ held: Atomics.load(l.slots, 0) });
    parentPort.once("message", () => { l.unlock(); parentPort.postMessage("released"); });`, { eval: true, workerData: { buf, src: checkpointLedger.toString() } });
  const token = await new Promise<bigint>((resolve, reject) => { w.once("message", (m: { held: bigint }) => resolve(m.held)); w.once("error", reject); });
  return { token, release: async () => { await new Promise<void>(resolve => { w.once("message", () => resolve()); w.postMessage("go"); }); await w.terminate(); } };
}
/** A checkpointer stand-in built from the production ledger source: reserves, then spins outside the lock (or writes real bytes first). */
async function dying(buf: SharedArrayBuffer, ceiling: number, now: number, gen: number, writeBytes = 0) {
  const w = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const fs = require("node:fs");
    const l = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId, 2000, { gen: workerData.gen });
    const t = l.beginCopy(workerData.ceiling, workerData.now);
    if (workerData.writeBytes) { parentPort.once("message", () => { const fd = fs.openSync(workerData.file, "w"); fs.writeSync(fd, Buffer.alloc(workerData.writeBytes, 7)); fs.fsyncSync(fd); fs.closeSync(fd); parentPort.postMessage("wrote"); for (;;) {} }); parentPort.postMessage({ id: threadId, ok: !!t }); }
    else { parentPort.postMessage({ id: threadId, ok: !!t }); for (;;) {} }`,
  { eval: true, workerData: { buf, src: checkpointLedger.toString(), ceiling, now, gen, writeBytes, file: join(tmpdir(), `d6-${process.pid}-${now}.bin`) } });
  const first = await new Promise<{ id: number; ok: boolean }>((resolve, reject) => { w.once("message", m => resolve(m)); w.once("error", reject); });
  return { w, id: first.id, ok: first.ok, write: async () => { if (!writeBytes) return; await new Promise<void>(resolve => { w.once("message", () => resolve()); w.postMessage("go"); }); } };
}
/** The confirmed exit: terminate, await the exit, then the same calls the checkpointer's exit handler makes. */
async function exitOf(f: Fx, d: { w: Worker; id: number }, gen: number) {
  await d.w.terminate();
  if (typeof f.a.checkpointerExited === "function") f.a.checkpointerExited(d.id, gen); else (f.a.recoverAdmissionAfterExit as ((id: number) => boolean) | undefined)?.(d.id);
}
const reg = (f: Fx, id: number, gen: number) => { if (typeof f.a.registerCheckpointer === "function") f.a.registerCheckpointer(id, gen); };
const section = (f: Fx) => { f.b.copyRoom(); };

it("D6-H1 settle timeout, rollover, backfill: the charge and the debt land in the new minute, nothing is lost", { timeout: 30_000 }, async () => {
  const f = fx(); f.st.at = M0 + 10_000; section(f);
  const t = f.b.admit("BG", 100_000, 50_000)!;
  const other = f.b.admit("BG", 20_000, 0)!; // a live reservation that is not part of the settlement
  expect(t).not.toBeNull();
  const h = await hold(f.buf);
  f.b.settle(t, 40_000, { salt: "aa", frame: 10 }, 50_000, 0);
  expect(f.s[0], "the holder was not taken over").toBe(h.token);
  f.st.at = M0 + MIN + 1000;
  await h.release();
  section(f); // one tick
  f.b.backfilled({ salt: "aa", frame: 10 });
  expect(f.n(8), "slot 8 holds the settled charge (included 0)").toBe(40_000);
  expect(f.n(3), "slot 3 = observed + settled").toBe(f.n(11) + 40_000);
  expect(f.n(2), "slot 2 = used + debt").toBe(90_000);
  expect(f.n(4), "debt moved").toBe(0);
  expect(f.n(5), "slot 5: only the other live reservation (not zeroed by the rollover)").toBe(20_000);
  expect(f.n(6), "slot 6: only the other live reservation").toBe(20_000);
  f.b.settle(other, 0);
  expect(f.n(5)).toBe(0); expect(f.n(6)).toBe(0);
});

it("D6-H1b a live ticket crosses the minute: it stays reserved until it settles, released exactly once", async () => {
  const f = fx(); f.st.at = M0 + 10_000; section(f);
  const t = f.b.admit("BG", 100_000, 20_000)!;
  expect(f.n(6)).toBe(100_000);
  f.st.at = M0 + MIN + 2000; section(f);
  expect(f.a.reserved.has(t), "still open after the flip").toBe(true);
  expect(f.n(6), "its reservation was not zeroed by the rollover").toBe(100_000);
  expect(f.n(5)).toBe(120_000);
  f.b.settle(t, 30_000, { salt: "bb", frame: 3 }, 20_000, 0);
  expect(f.n(6)).toBe(0); expect(f.n(5)).toBe(0);
  expect(f.n(8), "the charge lands in the minute it settles in").toBe(30_000);
  expect(f.n(2)).toBe(30_000);
  expect(f.n(4), "sum invariant: debt published once").toBe(20_000);
  f.b.settle(t, 30_000, { salt: "bb", frame: 3 }, 20_000, 0);
  expect(f.n(8), "a second settle releases nothing").toBe(30_000);
});

it("D6-H2 deferred settlements apply exactly once: three settles, five drains, sums exact", async () => {
  const f = fx(); f.st.at = M0 + 10_000; section(f);
  const ts = [1, 2, 3].map(i => f.b.admit("BG", 10_000 * i, 5_000)!);
  const h = await hold(f.buf);
  ts.forEach((t, i) => f.b.settle(t, 8_000, { salt: "s" + i, frame: 1 }, 5_000, 0));
  expect(f.s[0], "the holder was not taken over").toBe(h.token);
  await h.release();
  for (let i = 0; i < 5; i++) section(f);
  expect(f.n(8)).toBe(24_000); expect(f.n(2)).toBe(24_000); expect(f.n(4)).toBe(15_000);
  expect(f.n(5)).toBe(0); expect(f.n(6)).toBe(0);
  expect(f.n(3)).toBe(f.n(11) + f.n(8));
});

it("D6-H3 a drain in the section that crosses the minute lands in the NEW minute", async () => {
  const f = fx(); f.st.at = M0 + 10_000; section(f);
  const t = f.b.admit("BG", 60_000, 0)!;
  const h = await hold(f.buf);
  f.b.settle(t, 33_000, undefined, 0, 0);
  f.st.at = M0 + MIN + 500;
  await h.release();
  f.b.copyRoom(); // the one section that rotates and drains
  expect(f.n(1)).toBe(M0 / MIN + 1);
  expect(f.n(8), "charge in the new minute's slot 8").toBe(33_000);
  expect(f.n(3), "and slot 3").toBe(f.n(11) + 33_000);
});

it("D6-F1 foreground progress while settlement is stuck: BG refused (predicate at section entry), FGCOPY admitted", async () => {
  const run = async (cls: "BG" | "FGCOPY") => {
    const f = fx(); f.st.at = M0 + 5_000; section(f);
    const t = f.b.admit("BG", 50_000, 0)!;
    const h = await hold(f.buf);
    f.b.settle(t, 10_000, undefined, 0, 0);
    f.st.at += 11_000; // pending aged 11 s, frozen clock
    await h.release();
    const ticket = f.b.admit(cls, 4096);
    return { f, ticket };
  };
  const a = await run("BG");
  expect(a.ticket, "BG refused while the settlement was stuck at the section's entry").toBeNull();
  expect(a.f.a.admissionHealth().settlementStuck).toBe(true);
  expect(a.f.lines.some(l => /settlement pending/.test(l)), "loud line").toBe(true);
  expect(a.f.n(6), "and the pending settlement drained in that same section").toBe(0);
  const b = await run("FGCOPY");
  expect(b.ticket, "FGCOPY is admitted under its usual budget").not.toBeNull();
  expect(b.f.n(8), "its pending settlement drained too").toBe(10_000);
});

it("D6-R1 death outside the lock: the exit reconcile charges the ceiling once and empties the table", async () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const d = await dying(f.buf, 3_000_000, f.st.at, 7); reg(f, d.id, 7);
  expect(d.ok).toBe(true);
  await exitOf(f, d, 7);
  expect(f.n(6), "slot 6 back to baseline").toBe(0);
  expect(f.n(8), "ceiling charged once").toBe(3_000_000);
  expect(f.owners(), "table empty").toEqual([]);
  f.a.admissionShared.poison(); f.b.rebuildAdmissionIfPoisoned();
  expect(f.n(8), "a later rebuild adds nothing").toBe(3_000_000); expect(f.n(6)).toBe(0);
});

async function r2(f: Fx, mutate: (f: Fx) => void, afterBreak?: (f: Fx) => void) {
  f.st.at = M0 + 5_000; section(f);
  const d = await dying(f.buf, 1_000_000, f.st.at, 7); reg(f, d.id, 7);
  afterBreak?.(f);
  f.st.at = M0 + 2 * MIN + 5_000; mutate(f);
  await exitOf(f, d, 7);
  return d;
}
it("D6-R2 covered historical release: a valid continuous post-exit reading shows the bytes, nothing is charged", async () => {
  const f = fx();
  await r2(f, f => { f.st.meter += 777; f.st.os += 777; });
  expect(f.n(8), "no charge").toBe(0); expect(f.n(6), "released").toBe(0);
  expect(f.n(11), "the bytes are in slot 11").toBeGreaterThanOrEqual(777);
  expect(f.owners()).toEqual([]);
});
it("D6-R2u unknown-but-numeric post-exit data is a charge, not a release", async () => {
  const f = fx();
  await r2(f, f => { f.st.meter += 777; f.st.os += 777; f.st.meterKnown = false; f.st.osKnown = false; });
  expect(f.n(8), "ceiling charged now").toBe(1_000_000); expect(f.n(6)).toBe(0); expect(f.owners()).toEqual([]);
});
it("D6-R2b a measurement break inside the entry's minute: charge, not release", async () => {
  const f = fx();
  await r2(f, f => { f.st.meter += 777; f.st.os += 777; }, f => { f.st.at = M0 + 30_000; f.st.meterKnown = false; f.st.osKnown = false; section(f); f.st.meterKnown = true; f.st.osKnown = true; section(f); });
  expect(f.n(8)).toBe(1_000_000); expect(f.n(6)).toBe(0);
});
function winFx(snap: () => { total: number; known?: boolean } | null) {
  const st = { at: M0 - 2 * MIN };
  const mod = budgetModule as Any;
  const read = () => ({ ...(mod.readAdmissionProcess as unknown as (...a: unknown[]) => object)("win32", snap, () => null, () => null), at: st.at }) as never;
  const b = new IoBudget({ read, log: () => {}, isIdle: () => false });
  const buf = b.checkpointAdmissionBuffer();
  return { st, b, a: b as Any, buf, n: (i: number) => Number(new BigInt64Array(buf)[i]!) };
}
async function winCase(known: boolean | undefined, growAs: "known" | "unknown") {
  let total = 1000;
  const snap = () => (growAs === "known" ? { total, known: true } : known === undefined ? { total } : { total, known });
  const w = winFx(() => ({ total, ...(growAs === "known" ? { known: true } : known === undefined ? {} : { known }) }));
  w.st.at = M0 + 5_000; w.b.copyRoom();
  const ledgerOwner = checkpointLedger(w.buf, 4242, 2000, { gen: 9 });
  ledgerOwner.beginCopy(500_000, w.st.at);
  w.a.registerCheckpointer?.(4242, 9);
  w.st.at = M0 + 2 * MIN + 5_000; total += 4096;
  void snap;
  if (typeof w.a.checkpointerExited === "function") w.a.checkpointerExited(4242, 9);
  return w;
}
it("D6-R2w win32: the meter is the only source; unknown-but-numeric meter data charges (production conversion)", async () => {
  expect(typeof (budgetModule as Any).readAdmissionProcess, "readAdmissionProcess is exported").toBe("function");
  const unknown = await winCase(false, "unknown");
  expect(unknown.n(8), "known:false charges").toBe(500_000); expect(unknown.n(6)).toBe(0);
  const known = await winCase(true, "known");
  expect(known.n(8), "control: a valid continuous meter releases").toBe(0); expect(known.n(6)).toBe(0);
});
it("D6-R2a win32: an absent known flag is NOT known and charges", async () => {
  const r = (budgetModule as Any).readAdmissionProcess?.("win32", () => ({ total: 10 }), () => null, () => null);
  expect(r?.meter?.known, "absent flag copied as not known").toBe(false);
  const absent = await winCase(undefined, "unknown");
  expect(absent.n(8)).toBe(500_000); expect(absent.n(6)).toBe(0);
});
it("D6-R6w is a Windows-required witness: it exists in wal-maintenance.test.ts and is listed in ci/WINDOWS-REQUIRED.txt, so another OS can only skip it", () => {
  const manifest = readFileSync(new URL("../ci/WINDOWS-REQUIRED.txt", import.meta.url), "utf8").split("\n").filter(l => l && !l.startsWith("#")).map(l => l.split("\t"));
  const row = manifest.find(r => r[2] === "D6-R6w");
  expect(row, "the manifest lists D6-R6w").toBeDefined();
  expect(row![0], "with its test file").toBe("server/wal-maintenance.test.ts");
  const text = readFileSync(new URL("./wal-maintenance.test.ts", import.meta.url), "utf8");
  expect(text, "the witness is gated to win32 only and carries the marker").toMatch(/it\.skipIf\(!r6wRuns\)\("D6-R6w \[WINDOWS-REQUIRED\]/);
  expect(text).toMatch(/const r6wRuns = process\.platform === "win32" \|\| process\.env\.D6_R6W_ON_HOST === "1"/);
  expect(text, "and it runs the real checkpointer and kills it before endCopy").toMatch(/parkNextPass\(db, slots, 2\)[\s\S]*walMaintenanceTestHooks\.terminate\(\)/);
});

it("D6-R3 table full: four live owners, the fifth beginCopy is refused and counted", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const ls = [1, 2, 3, 4, 5].map(i => checkpointLedger(f.buf, 6000 + i, 2000, { gen: i }));
  const tickets = ls.slice(0, 4).map(l => l.beginCopy(1000, f.st.at));
  expect(tickets.every(t => t !== null)).toBe(true);
  expect(ls[4]!.beginCopy(1000, f.st.at), "fifth refused").toBeNull();
  expect(f.n(16), "slot 16 counts").toBe(1);
  expect(f.owners().length).toBe(4);
  expect(f.n(6), "the refused copy reserved nothing").toBe(4000);
  f.b.noteTableFull();
  expect(f.a.admissionHealth().tableFull).toBe(1);
});

it("D6-R5 a live owner is never released by anyone else, however old; a replacement worker infers no exit", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const L = checkpointLedger(f.buf, 5001, 2000, { gen: 3 }); L.beginCopy(1000, f.st.at); reg(f, 5001, 3);
  f.st.at = M0 + 3 * MIN + 5_000;
  if (typeof f.a.admissionTick === "function") f.a.admissionTick(); else section(f);
  expect(f.owners().length, "entry kept").toBe(1); expect(f.n(6), "still reserved").toBeGreaterThanOrEqual(1000);
  expect(f.a.admissionHealth().staleReservation, "raised").toBeGreaterThanOrEqual(1);
  reg(f, 5002, 4); // a replacement starts while the old one is alive
  if (typeof f.a.admissionTick === "function") f.a.admissionTick(); else section(f);
  expect(f.owners().length, "the old entry stays: no exit was inferred").toBe(1);
  f.a.admissionShared.poison(); f.b.rebuildAdmissionIfPoisoned();
  expect(f.owners().length, "a rebuild keeps a live owner's entry").toBe(1); expect(f.n(6), "and counts it").toBeGreaterThanOrEqual(1000);
});

it("D6-R6 cross-minute execution: reserved at m:59.9, executed in m+1, dead before endCopy: never nothing charged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d6-r6-"));
  try {
    const run = async (known: boolean) => {
      const f = fx(M0 - 2 * MIN, true); f.st.osKnown = true; section(f);
      f.st.at = M0 + 59_900; section(f);
      const d = await dying(f.buf, 4_000_000, f.st.at, 7, 3 * 1024 * 1024); reg(f, d.id, 7);
      f.st.at = M0 + MIN + 200;
      await d.write();
      f.st.osKnown = known;
      await exitOf(f, d, 7);
      return f;
    };
    const measured = await run(true);
    expect(measured.n(6)).toBe(0); expect(measured.owners()).toEqual([]);
    expect(measured.n(8), "covered: no charge").toBe(0);
    expect(measured.n(11), "the real bytes are visible in the new minute's slot 11").toBeGreaterThan(0);
    const unmeasured = await run(false);
    expect(unmeasured.n(8), "unmeasured: the ceiling is in slot 8 of m+1").toBe(4_000_000);
    expect(unmeasured.n(6)).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("D6-R7 death before EACH production store of a copy cycle: every row of the crash table holds", { timeout: 120_000 }, async () => {
  const SRC = `const { parentPort, workerData, threadId } = require("node:worker_threads");
    const real = Atomics; let count = 0; const K = workerData.k; const flag = new Int32Array(workerData.park);
    const kinds = ["store", "compareExchange", "add", "sub"];
    const A = new Proxy(real, { get(t, p) { const f = t[p]; if (typeof f !== "function") return f;
      if (!kinds.includes(p)) return f.bind(t);
      return (ta, i, ...r) => { if (ta.buffer === workerData.buf && ++count === K) { parentPort.postMessage({ k: count, op: p, index: i }); real.wait(flag, 0, 0); } return f.call(t, ta, i, ...r); }; } });
    const make = new Function("Atomics", "return (" + workerData.src + ")")(A);
    const ledger = make(workerData.buf, threadId, 2000, { gen: 7 });
    const t = ledger.beginCopy(workerData.ceiling, workerData.now);
    ledger.endCopy(t, workerData.used, 0, undefined, workerData.now);
    parentPort.postMessage({ done: count, id: threadId });`;
  const CEIL = 3_000_000, USED = 4096, NOW = M0 + 5_000;
  const runK = async (k: number) => {
    const buf = new SharedArrayBuffer(32 * 8), park = new SharedArrayBuffer(4);
    const w = new Worker(SRC, { eval: true, workerData: { buf, park, k, src: checkpointLedger.toString(), ceiling: CEIL, used: USED, now: NOW } });
    const m = await new Promise<{ k?: number; op?: string; index?: number; done?: number }>((resolve, reject) => { w.once("message", resolve); w.once("error", reject); });
    return { w, buf, m };
  };
  const total = await (async () => { const r = await runK(0); await r.w.terminate(); return r.m.done!; })();
  expect(total, "the cycle has a real sequence of stores").toBeGreaterThan(15);
  const rows: string[] = [];
  for (let k = 1; k <= total; k++) {
    const { w, buf, m } = await runK(k);
    expect(m.k).toBe(k);
    const s = new BigInt64Array(buf);
    const owner = s[18]!, bytes = s[19]!, at8 = s[8]!, id = Number((s[0]! >> 32n));
    await w.terminate();
    if (m.op === "store" && m.index === 18 && owner === 0n) {
      expect(s[20], `row k=${k}: the minute is initialized before publishing the owner`).toBe(BigInt(Math.floor(NOW / MIN)));
    }
    const L = checkpointLedger(buf);
    (L as Any).recoverAfterExit?.(id);
    L.lock(); try { L.rotate(NOW); (L as Any).reconcileDead?.(() => false, () => false, L.poisoned()); } finally { L.unlock(); }
    (L as Any).rebuild?.({ writes: 0, bgReserved: 0, debt: 0 });
    const expected8 = at8 + (owner !== 0n && bytes > 0n ? bytes : 0n);
    rows.push(`k=${k} op=${m.op} slot=${m.index} entry(owner=${owner !== 0n},bytes=${bytes}) -> slot8=${s[8]}`);
    expect(s[8], `row k=${k} (${m.op} ${m.index}): the entry is charged once, else nothing`).toBe(expected8);
    expect(s[6], `row k=${k}: slot 6 back to baseline`).toBe(0n);
    expect([18, 21, 24, 27].map(i => s[i]), `row k=${k}: table empty`).toEqual([0n, 0n, 0n, 0n]);
    expect(s[3], `row k=${k}`).toBe(s[11]! + s[8]!);
    expect((L as Any).poisoned?.() ?? false, `row k=${k}: poison cleared by the rebuild`).toBe(false);
  }
  console.log("D6-R7 k -> row map\n" + rows.join("\n"));
});

it("D6-R8 identity: the whole 64-bit owner word; exits of other identities reconcile nothing; the exit flag is O(1) while the CAS is busy", async () => {
  const w = (tid: number, gen: number) => checkpointLedger(new SharedArrayBuffer(256), tid, 2000, { gen }).ownerWord;
  expect(w(9, 0xffffffff)).not.toBe(w(9, 0));
  expect(w(9, 1)).not.toBe(w(10, 1)); expect(w(9, 1)).not.toBe(0n);
  expect(w(9, 0)).not.toBe(w(9, 1));
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const A = checkpointLedger(f.buf, 7001, 2000, { gen: 5 }); A.beginCopy(1000, f.st.at); reg(f, 7001, 5);
  const B = checkpointLedger(f.buf, 7002, 2000, { gen: 5 }); B.beginCopy(2000, f.st.at); reg(f, 7002, 5);
  f.a.checkpointerExited?.(7001, 6); f.a.checkpointerExited?.(8001, 5);
  expect(f.owners().length, "no other identity's exit reconciled these").toBe(2);
  const h = await hold(f.buf);
  const s0 = f.a.liveOwners?.size;
  for (let i = 0; i < 50; i++) { reg(f, 9000 + i, 1); f.a.checkpointerExited?.(9000 + i, 1); }
  expect(f.a.liveOwners?.size, "bounded: nothing grew per exit (no identity queue)").toBe(s0);
  expect(f.a.retryMarks?.size).toBe(0);
  f.a.checkpointerExited?.(7002, 5);
  expect(f.a.rescanOwners, "only a flag was recorded while the CAS was busy").toBe(true);
  expect(f.a.liveOwners?.size).toBe(s0 - 1);
  expect(f.owners().length, "nothing reconciled under the holder").toBe(2);
  await h.release();
  section(f);
  expect(f.owners().length, "one section reconciles exactly the entries of exited owners").toBe(1);
  expect(f.owners()[0]).toBe(A.ownerWord);
  expect(f.a.rescanOwners).toBe(false);
});

it("D6-B1 bounded debt: 10 000 settles over 40 salts and 2 000 with zero debt keep the list at 16 with exact sums; walks are bounded", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  let inserted = 0;
  for (let i = 0; i < 10_000; i++) { const t = f.b.admit("BG", 1000, 100)!; f.b.settle(t, 100, { salt: "s" + (i % 40), frame: i }, 100, 0); inserted += 100; if (i % 500 === 499) { f.st.at += 1; } }
  for (let i = 0; i < 2_000; i++) { const t = f.b.admit("BG", 1000, 100)!; f.b.settle(t, 100, { salt: "z", frame: i }, 0, 0); }
  expect(f.a.copyDebt.length, "list bounded").toBeLessThanOrEqual(16);
  expect(f.a.copyDebt.every((e: Any) => (e.published ?? e.bytes) + (e.pending ?? 0) + (e.pendingMoved ?? 0) > 0), "no zero-byte entries").toBe(true);
  expect(f.a.copyDebt.reduce((n: number, e: Any) => n + (e.published ?? e.bytes) + (e.pending ?? 0) + (e.pendingMoved ?? 0), 0), "sum invariant").toBe(inserted);
  expect(f.n(4), "slot 4 is the published sum").toBe(inserted);
  // walks: 64 open tickets and 4 table entries; every op visits at most RESERVED_MAX + DEBT_MAX + TABLE_N = 84
  const g = fx(); g.st.at = M0 + 5_000; section(g);
  for (let i = 0; i < 64; i++) g.b.admit("FGCOPY", 10);
  for (let i = 0; i < 20; i++) { const t = g.b.admit("BG", 1000, 10); if (t) g.b.settle(t, 10, { salt: "q" + i, frame: 1 }, 10, 0); }
  [1, 2, 3, 4].forEach(i => checkpointLedger(g.buf, 8000 + i, 2000, { gen: 1 }).beginCopy(10, g.st.at));
  let visits = 0;
  const count = <T>(items: Iterable<T>) => (function* () { for (const x of items) { visits++; yield x; } })();
  const wrapMap = () => { const m = g.a.reserved as Map<unknown, unknown>; const it = m[Symbol.iterator].bind(m); (m as Any)[Symbol.iterator] = () => count({ [Symbol.iterator]: it })[Symbol.iterator](); };
  const wrapDebt = () => { const arr = g.a.copyDebt as Any[]; const it = arr[Symbol.iterator].bind(arr); (arr as Any)[Symbol.iterator] = () => count({ [Symbol.iterator]: it })[Symbol.iterator](); };
  const measure = (fn: () => void) => { visits = 0; wrapMap(); wrapDebt(); fn(); return visits + (g.a.admissionShared.entries?.().length ?? 0); };
  g.a.admissionShared.poison();
  expect(measure(() => g.b.rebuildAdmissionIfPoisoned()), "rebuild").toBeLessThanOrEqual(84);
  expect(measure(() => g.b.backfilled({ salt: "q3", frame: 5 })), "backfilled").toBeLessThanOrEqual(84);
  expect(measure(() => (g.a.admissionTick ? g.a.admissionTick() : section(g))), "tick").toBeLessThanOrEqual(84);
  expect(g.a.admissionShared.entries?.().length ?? 0).toBeLessThanOrEqual(4);
});

it("D6-B1b coalescing with a fixed frame per salt: 2 000 settles over 7 salts leave exactly 7 entries with exact sums", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  for (let i = 0; i < 2_000; i++) { const t = f.b.admit("BG", 1000, 10)!; f.b.settle(t, 10, { salt: "k" + (i % 7), frame: 100 }, 10, 0); }
  expect(f.a.copyDebt.length).toBe(7);
  const sums = new Map<string, number>(); for (const e of f.a.copyDebt) sums.set(e.mark.salt, (e.published ?? e.bytes)); 
  for (let k = 0; k < 7; k++) expect(sums.get("k" + k), "per-salt sum exact").toBe(10 * Math.ceil((2000 - k) / 7));
});

it("D6-B1c frame order: a merged entry carries the higher frame; backfill(100) releases none of it, backfill(200) all, also across a rollover", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const put = (salt: string, frame: number, bytes: number) => { const t = f.b.admit("BG", 1000, bytes)!; f.b.settle(t, bytes, { salt, frame }, bytes, 0); };
  put("s", 100, 11);
  put("s", 200, 22); // rule 2 must NOT add it to the frame-100 entry
  expect(f.a.copyDebt.filter((e: Any) => e.mark.salt === "s").length, "two entries, the lower frame did not take the higher").toBe(2);
  for (let i = 0; i < 14; i++) put("o" + i, 1, 1);
  expect(f.a.copyDebt.length).toBe(16);
  put("last", 1, 1); // full: rule 3 merges the two adjacent same-salt entries into one with the HIGHER frame
  const merged = f.a.copyDebt.filter((e: Any) => e.mark.salt === "s");
  expect(merged.length).toBe(1); expect(merged[0].mark.frame).toBe(200); expect(merged[0].published).toBe(33);
  f.st.at = M0 + MIN + 1000; section(f); // across a rollover
  f.b.backfilled({ salt: "s", frame: 100 });
  expect(f.a.copyDebt.filter((e: Any) => e.mark.salt === "s").length, "backfill(100) releases nothing of the frame-200 entry").toBe(1);
  f.b.backfilled({ salt: "s", frame: 200 });
  expect(f.a.copyDebt.filter((e: Any) => e.mark.salt === "s").length, "backfill(200) releases all").toBe(0);
});

it("D6-B2 reserved bound: the 65th ticket is refused and counted", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  for (let i = 0; i < 64; i++) expect(f.b.admit("FGCOPY", 10)).not.toBeNull();
  expect(f.b.admit("FGCOPY", 10), "65th refused").toBeNull();
  expect(f.a.admissionHealth().reservedFull).toBeGreaterThanOrEqual(1);
  expect(f.n(6)).toBe(640);
});

it("D6-B3 mixed publication folding keeps slot 4 = sum(published); pendingMoved goes to slot 2", async () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const pub = () => f.a.copyDebt.reduce((n: number, e: Any) => n + e.published, 0);
  const all = () => f.a.copyDebt.reduce((n: number, e: Any) => n + e.published + e.pending + e.pendingMoved, 0);
  // 18 tickets admitted, then every settlement is deferred: the oldest entries hold PENDING bytes when the list folds
  const tickets = Array.from({ length: 18 }, (_, i) => f.b.admit("BG", 1000, 10 + i)!);
  expect(tickets.every(t => t !== null)).toBe(true);
  const h = await hold(f.buf);
  tickets.slice(0, 17).forEach((t, i) => f.b.settle(t, 10 + i, { salt: "d" + i, frame: 5 }, 10 + i, 0));
  expect(f.a.copyDebt.length, "the 17th insertion folded the two oldest (16 -> 15), then appended").toBe(16);
  const bucket = f.a.copyDebt.find((e: Any) => e.mark.salt === "unreadable");
  expect(bucket, "the unreadable bucket exists").toBeTruthy();
  expect(bucket.pending, "folding kept pending apart from published").toBe(10 + 11);
  expect(bucket.published).toBe(0);
  expect(f.n(4), "slot 4 = sum(published) = 0 while everything is pending").toBe(pub());
  expect(f.n(4)).toBe(0);
  // a pending entry whose frames are copied before the drain becomes pendingMoved
  f.b.backfilled({ salt: "d16", frame: 5 });
  expect(f.a.copyDebt.some((e: Any) => e.pendingMoved > 0), "pendingMoved exists").toBe(true);
  const total = all();
  await h.release();
  const before2 = f.n(2);
  section(f);
  expect(f.n(4), "after the drain slot 4 is the published sum").toBe(pub());
  expect(f.n(4) + (f.n(2) - before2) >= 0).toBe(true);
  expect(pub() + f.a.copyDebt.reduce((n: number, e: Any) => n + e.pending + e.pendingMoved, 0), "nothing left pending").toBe(pub());
  expect(f.n(2), "slot 2 = the settled used bytes of 17 tickets + the moved bytes").toBeGreaterThanOrEqual(total - pub());
  expect(f.n(4) + f.n(2) - tickets.slice(0, 17).reduce((n, _t, i) => n + 10 + i, 0), "debt published + moved = all debt inserted (no loss, no duplication)").toBe(total);
});

it("D6-B3b the oldest entry IS the unreadable bucket: the next-oldest non-unreadable entry merges into it, the length drops by 1, sums exact", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const put = (salt: string, bytes: number) => { const t = f.b.admit("BG", 1000, bytes)!; f.b.settle(t, bytes, { salt, frame: 5 }, bytes, 0); };
  for (let i = 0; i < 16; i++) put("u" + i, 10);
  put("extra1", 7); // folds the two oldest into "unreadable" (now the oldest entry, index 0)
  expect(f.a.copyDebt[0].mark.salt).toBe("unreadable");
  const total = () => f.a.copyDebt.reduce((n: number, e: Any) => n + e.published, 0);
  const before = total();
  put("extra2", 5); // full again: merge the oldest NON-unreadable entry into the bucket
  expect(f.a.copyDebt.length).toBe(16);
  expect(f.a.copyDebt.filter((e: Any) => e.mark.salt === "unreadable").length, "the bucket never merged into itself").toBe(1);
  expect(total(), "sums exact").toBe(before + 5);
  expect(f.n(4)).toBe(total());
});

it("D6-E1 a ticket never settled is converted at its full ceiling and debt after expiry + 60 s, loudly, never early", () => {
  const f = fx(); f.st.at = M0 + 5_000; section(f);
  const t = f.b.admit("BG", 80_000, 30_000)!;
  f.st.at = M0 + MIN + 30_000; section(f);
  expect(f.a.reserved.has(t), "nothing released early").toBe(true);
  f.st.at = M0 + MIN + 62_000; section(f);
  expect(f.a.reserved.has(t)).toBe(false);
  expect(f.a.admissionHealth().expiredTickets).toBe(1);
  expect(f.lines.some(l => /never settled/.test(l)), "loud line").toBe(true);
  expect(f.n(6)).toBe(0); expect(f.n(5)).toBe(0);
  expect(f.n(8), "the full ceiling is charged").toBe(80_000);
  expect(f.n(4), "the full debt is held").toBe(30_000);
  expect(f.a.copyDebt[0].mark.salt).toBe("unreadable");
});
