// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: this witness and the helper's relief write (helper-admission.ts helperHasGrant/helperReliefRoom/helperReliefPlan, index-wal.ts
// write, memw-steps.ts formGroup) = lane q1022-bgstarve-fable; the minute's grant ledger = io-budget.ts (scperf-p1); rulings = MAIN.
//
// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T11:49:12Z, idle DO LESS 05:54:59Z; owner of the rewrite = q1022-idlequiet-opus): on an IDLE
// minute the relief door stays closed (io-budget.ts bgDoorsClosed/idleQuiet), so the batch is refused there: no relief grant, no ticket,
// nothing committed or stored. On the next ACTIVE minutes (the other writers still spend the whole background minute first) the SAME
// original assert holds, and every record lands EXACTLY once (one row per record id, none lost, none doubled).
//
// W-HELPER-RELIEF (reviews of 1c98f1b0fb: the helper's side of an index batch on relief had no witness on the real path). Everything the
// helper runs is real here: MemoryIndex.applyBatch (the worker's entry for an "index" message, worker.ts) -> formGroup ->
// IndexWalWriter.admit/write -> helperHasGrant/withHelperGrant -> the native byte meter (built from native/), on a real index file. The
// gate is a real IoBudget on an idle minute. The test stands in for the PARENT only: it names the index lane for the minute's grant and
// cuts the helper's ticket the way worker-controller.ts does (the batch's own grant and the answer to a helper's ask: what is left of
// the grant, 1 MiB at least, stepBytes = the cut, relief: true).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { IoBudget } from "../io-budget.ts";
import { checkpointCeiling, commitCeiling, ioGrantSnapshot, resetIoMeterForTest, withBgGrant } from "../io-meter.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { isBgDeferred } from "../bg-admission.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { configureHelperAdmission, acceptHelperTicket, stopHelperAdmission, type HelperTicket } from "./helper-admission.ts";
import { walTestHooks, indexStepFrames } from "./index-wal.ts";

const root = mkdtempSync(join(tmpdir(), "helper-index-relief-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let serial = 0;
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
});
afterEach(() => { configureHelperAdmission(undefined); for (const key of Object.keys(walTestHooks)) delete (walTestHooks as Record<string, unknown>)[key]; });
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

const MiB = 1024 * 1024;
const RELIEF_CAP_BYTES = 4 * MiB;
/** worker-controller.ts HELPER_RELIEF_STEP_MIN_BYTES: the smallest cut the parent sends. */
const PARENT_STEP_MIN_BYTES = MiB;
// (optional members: the base has no relief door at all, so nothing is granted there and the batch never commits)
type Gate = IoBudget & { grantBgRelief?(lane: string, waitedMs?: number): boolean; bgReliefGrantRoom?(): number; withBgReliefLane?<T>(lane: string, run: () => T): T; bgReliefLog?: Array<{ minute: number; lane: string; written: number; peak: number }>; bgReliefStats?: { grants: number; written: number } };
/** `words` distinct words a record (each is a postings row of its own in the record's worst-case reserve). */
const record = (n: number, words: number, filler = 0): IndexedMemory => ({ id: `record-${n}`, version: 1, scopeId: "fixture-scope", text: Array.from({ length: words }, (_, i) => `w${n}x${i}`).join(" ") + (filler ? " " + "x".repeat(filler) : ""), deleted: false });

interface Row {
  name: string;
  /** What the parent cuts a ticket to, minute by minute (the last entry repeats): the grant left when the index asks. */
  cuts: number[];
  records: () => IndexedMemory[];
  /** A write of this row is over half of what is left of its ticket at some point (the copy it owes would not fit the same grant): the
   *  meter refuses that write, it is rolled back, and it commits under a later ticket. */
  overHalf: boolean;
}
const ROWS: Row[] = [
  // the index lane holds the whole minute's grant: 16 records of 200 distinct words (worst-case reserve of ONE of them: over the cut step)
  { name: "whole-grant", cuts: [RELIEF_CAP_BYTES], records: () => Array.from({ length: 16 }, (_, n) => record(n, 200)), overHalf: false },
  // the smallest cut the parent sends: 16 short records (the reserve of any insert is over this cut's step)
  { name: "smallest-cut", cuts: [PARENT_STEP_MIN_BYTES], records: () => Array.from({ length: 16 }, (_, n) => record(n, 3, 2048)), overHalf: false },
  // records of 900 distinct words on the smallest cut: once part of a ticket is spent, the next record's write is over half of what is left
  { name: "over-half-waits", cuts: [PARENT_STEP_MIN_BYTES], records: () => Array.from({ length: 4 }, (_, n) => record(n, 900)), overHalf: true },
];

for (const row of ROWS) {
  it(`W-HELPER-RELIEF ${row.name}: an index batch sent to the real helper index with a relief ticket cut below its step's worst-case ceilings commits under that ticket (the records and their words are in the index file), on relief tickets only, never over a ticket or over the minute's grant; a write over half of what is left of a ticket is refused and commits under a later one`, async () => {
    const state = { at: 3_600_000 * 48 + 1_000, idle: false };
    const budget = new IoBudget({ read: () => ({ at: state.at, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {}, isIdle: () => state.idle }) as Gate;
    const tickets = new Map<string, NonNullable<ReturnType<IoBudget["admit"]>>>();
    const seen = { tickets: 0, cutTickets: 0, overTicket: 0 };
    let sequence = 0, cut = row.cuts[0]!;
    const lane = <T,>(run: () => T): T => budget.withBgReliefLane ? budget.withBgReliefLane("index", run) : run();
    const issue = (ticket: NonNullable<ReturnType<IoBudget["admit"]>>, extra: Partial<HelperTicket>): HelperTicket => { const id = `permit-${++sequence}`; tickets.set(id, ticket); return { ...ticket, id, ...extra }; };
    // the parent's cut (worker-controller.ts, the batch's grant and relieved()): what is left of the minute's grant, never under 1 MiB
    const cutTicket = (ceiling: number): HelperTicket | null => lane(() => {
      const need = Math.min(ceiling, cut, budget.bgReliefGrantRoom?.() ?? 0);
      if (need < PARENT_STEP_MIN_BYTES) return null;
      const ticket = budget.admit("BG", need, 0, { relief: true });
      if (!ticket) return null;
      seen.tickets++; seen.cutTickets++;
      return issue(ticket, { stepBytes: need, purpose: "bg", relief: true });
    });
    configureHelperAdmission({
      // the parent's answer to a helper's ask: the whole ceiling if the gate gives it (to the holder of the minute's grant it does, out
      // of that grant, when it fits what is left: every ticket is counted against the gate's own count of relief tickets below), else the cut
      request: ceiling => {
        const whole = lane(() => budget.admit("BG", ceiling));
        if (whole) { seen.tickets++; acceptHelperTicket(issue(whole, {})); return; }
        acceptHelperTicket(cutTicket(ceiling), 1);
      },
      settle: (receipt, used) => {
        const ticket = tickets.get(receipt.id)!; tickets.delete(receipt.id);
        if (used > ticket.bytes) seen.overTicket++;
        budget.settle(ticket, used);
      },
    });
    const file = join(root, `index-${++serial}.db`);
    // (setup, by the gate's own rules on an active minute: the index file is opened and checked)
    const boot = budget.admit("BG", MiB)!;
    const index = withBgGrant(boot, () => new MemoryIndex(file, { charge: async () => true }));
    budget.settle(boot, ioGrantSnapshot().usedBytes);
    try {
      for (let n = 0; n < 2000 && !index.opened(); n++) { try { await index.init(); } catch (error) { if (!isBgDeferred(error)) throw error; } await new Promise<void>(done => setImmediate(done)); }
      // (the setup's minute is over: the helper hands back what it still held of the setup's tickets, so nothing below runs on them)
      stopHelperAdmission();
      const opened = index.opened(), setupTickets = seen.tickets;
      // (the field minute: the other writers spend the whole background minute before the index asks)
      const othersSpendTheMinute = () => { for (let i = 0; i < 8; i++) { const s = budget.admissionState(), left = Math.min(12 * MiB - s.bg - s.debt - s.reserved, 49 * MiB - s.total - s.reserved); if (left <= 0) break; const ticket = budget.withSource("other-writer", () => budget.admit("BG", left)); if (!ticket) break; budget.settle(ticket, left); } };
      const page = ioGrantSnapshot().pageSize, frames = indexStepFrames(4096, page), maximum = commitCeiling(frames, 4096, page) + checkpointCeiling(frames, 4096, page) + 4 * page;
      const records = row.records();
      let pending = records, committed = 0, done = false, minutes = 0;
      const storedRows = () => { const r = new DatabaseSync(file, { readOnly: true }); try { return Number(r.prepare("SELECT count(*) n FROM entries").get()?.n ?? 0); } finally { r.close(); } };
      // (a) the owner is away: IDLE minutes. DO LESS keeps the relief door closed, so the same batch, the same dispatcher call and the same
      // parent cut get nothing: no relief grant, no ticket, nothing committed, no row in the index file.
      state.idle = true; budget.setIsIdle(() => true);
      const idleSeen = { reliefGrants: 0, tickets: 0, committed: 0, done: false };
      for (let m = 0; m < 3; m++) {
        state.at += 60_000; budget.admissionState(); othersSpendTheMinute();
        cut = row.cuts[0]!;
        if (budget.grantBgRelief?.("index", 600_000)) idleSeen.reliefGrants++;
        const grant = cutTicket(maximum);
        if (grant) acceptHelperTicket(grant);
        for (let attempt = 0; attempt < 8; attempt++) {
          const result = await index.applyBatch(pending);
          if (result.status === "done") { idleSeen.done = true; break; }
          idleSeen.committed += result.committed;
          try { await index.maintenanceStep(); } catch (error) { if (!isBgDeferred(error)) throw error; }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      idleSeen.tickets = seen.tickets - setupTickets;
      expect({ ...idleSeen, stored: storedRows() }, `${row.name}: on an idle minute relief carries nothing (DO LESS)`).toEqual({ reliefGrants: 0, tickets: 0, committed: 0, done: false, stored: 0 });
      stopHelperAdmission();
      // (b) the owner is back: ACTIVE minutes. The other writers still spend the whole background minute first, so the gate's own rules
      // refuse every index step and only relief can carry the batch, as in the original row.
      state.idle = false; budget.setIsIdle(() => false);
      const refusedBefore = ioGrantSnapshot().refusedWrites;
      for (; minutes < 12 && !done; minutes++) {
        state.at += 60_000; budget.admissionState(); othersSpendTheMinute();
        cut = row.cuts[Math.min(minutes, row.cuts.length - 1)]!;
        // the dispatcher names the index lane for this minute; the batch goes to the helper with its cut grant (worker.ts "index")
        budget.grantBgRelief?.("index", 600_000);
        const grant = cutTicket(maximum);
        if (grant) acceptHelperTicket(grant);
        // the worker's loop for a batch: write what the grant holds, run the maintenance step (the copy it owes), try again
        for (let attempt = 0, idle = 0; attempt < 400 && idle < 8 && !done; attempt++) {
          const result = await index.applyBatch(pending);
          if (result.status === "done") { committed = records.length; done = true; break; }
          committed += result.committed; pending = pending.slice(result.committed);
          idle = result.committed ? 0 : idle + 1;
          try { await index.maintenanceStep(); } catch (error) { if (!isBgDeferred(error)) throw error; }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      // what landed, read from the index file on a connection of its own, and found by the words of each record
      const reader = new DatabaseSync(file, { readOnly: true });
      const stored = Number(reader.prepare("SELECT count(*) n FROM entries").get()?.n ?? 0);
      // exactly once: one row per record id
      const distinct = Number(reader.prepare("SELECT count(DISTINCT id) n FROM entries").get()?.n ?? 0); reader.close();
      const found = records.filter((r, n) => index.search(`w${n}x1`, records.map(x => ({ id: x.id, version: x.version })), null, "fixture").hits.some(hit => hit.id === r.id)).length;
      const log = budget.bgReliefLog ?? [], refused = ioGrantSnapshot().refusedWrites - refusedBefore;
      const observed = {
        opened, done, committed, stored, distinct, found,
        // the over-half row: the meter refused a write (and the batch still committed)
        refusedOverHalf: row.overHalf ? refused > 0 : false,
        // nothing ran by the gate's own rules after the setup (every ticket is one of the gate's relief tickets), cut tickets carried it,
        // none was overdrawn, no minute went over the grant
        offRelief: seen.tickets - setupTickets - (budget.bgReliefStats?.grants ?? 0), onRelief: seen.cutTickets > 0 && (budget.bgReliefStats?.written ?? 0) > 0, overTicket: seen.overTicket,
        minutesOverGrant: log.filter(minute => minute.written > RELIEF_CAP_BYTES || minute.peak > RELIEF_CAP_BYTES).length, otherLanes: log.filter(minute => minute.lane !== "index").length,
      };
      console.log(`[W-HELPER-RELIEF] ${row.name} minutes=${minutes} tickets=${seen.tickets - setupTickets} cutTickets=${seen.cutTickets} reliefWritten=${budget.bgReliefStats?.written} refusedWrites=${refused} ${JSON.stringify(observed)}`);
      expect(observed, `${row.name}: the batch commits under relief tickets and its records land`).toEqual({
        opened: true, done: true, committed: records.length, stored: records.length, distinct: records.length, found: records.length,
        refusedOverHalf: row.overHalf,
        offRelief: 0, onRelief: true, overTicket: 0, minutesOverGrant: 0, otherLanes: 0,
      });
    } finally { index.close(); }
  }, 120_000);
}
