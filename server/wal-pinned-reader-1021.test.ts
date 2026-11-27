// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, B5-W (gate G-PRODUCER, pinned reader; MEMORY-V2-DESIGN 4.8 B5, AF-H8, F21; owners: the reader registry, the
// half-gate release and this witness = memv2-D; the helper child's registration = lane E, CONTRACT-REQ E).
// A reader that keeps a read snapshot pins the log: no pass can copy past it, the log grows to the 512 MiB hard gate and the owner's send is
// refused although only memory's own reader holds it. Before 1.0.21 nothing told the reader to let go. Now, at 256 MiB un-copied, memory's
// own readers are asked once to end their snapshot and one that has not within 5 s is restarted; a reader memory does not own is never
// ended by memory: background memory writes stop at the half gate, the hard gate stays, and its refusal names the reader.
// Real path: the real server connection, the real checkpointer worker and its 1 s main-thread watch, a real second connection holding a
// real read transaction on the real log. Nothing is shortened.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "./database.ts";
import { DATA_DIR } from "./config.ts";
import { ioBudget } from "./io-budget.ts";
import { freshDataDir } from "./memory/testing/recall-fixture.ts";
import { TranscriptReader } from "./transcript-read.ts";
import * as wal from "./wal-maintenance.ts";

const MiB = 1024 * 1024;
/** The half gate (io-budget WAL_HALF_GATE_BYTES, half the 512 MiB hard gate), as a literal so a base without it still runs the witness. */
const WAL_HALF_GATE_BYTES = 256 * MiB;
type Reader = { name: string; memory: boolean; release?: (done: () => void) => void; restart?: () => void };
const register = (wal as unknown as { registerWalReader?: (r: Reader) => () => void }).registerWalReader;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(50); }
  return check();
}
const backlog = () => wal.walBacklog()?.backlog ?? 0;
const open: DatabaseSync[] = [], unregister: Array<() => void> = [];
afterEach(() => {
  for (const u of unregister.splice(0)) u();
  for (const d of open.splice(0)) { try { if (d.isTransaction) d.exec("ROLLBACK"); d.close(); } catch { /* closed */ } }
  closeDatabase();
});

async function start() {
  freshDataDir();
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS b5_probe(v BLOB)");
  expect(await until(() => wal.walMaintenanceReady(), 10_000), "the checkpointer is up").toBe(true);
  await sleep(500);
  return db;
}
/** A second real connection holding a read snapshot (BEGIN + a read: SQLite keeps its read mark until the transaction ends). */
function pinned(): DatabaseSync {
  const r = new DatabaseSync(join(DATA_DIR, "messages.db")); open.push(r);
  r.exec("BEGIN"); r.prepare("SELECT count(*) AS n FROM b5_probe").get();
  return r;
}
/** Grow the log by `mib` MiB of committed 1 MiB rows on `w` (one commit each). Synchronous: the 1 s watch looks only after it. */
function grow(w: DatabaseSync, mib: number) {
  const ins = w.prepare("INSERT INTO b5_probe VALUES (randomblob(1048576))");
  for (let i = 0; i < mib; i++) ins.run();
}

describe("B5-W a pinned reader never pushes the owner into the hard gate (lane D)", { timeout: 240_000 }, () => {
  it("memory's own pinned reader is told at 256 MiB, lets go, the log is copied and an owner send commits", async () => {
    const db = await start();
    const reader = pinned();
    let releasedAt = 0, reachedAt = 0;
    if (register) unregister.push(register({ name: "fixture memory reader", memory: true, release: done => { releasedAt = Date.now(); reader.exec("COMMIT"); done(); } }));
    grow(db, 272);
    reachedAt = Date.now();
    expect(backlog(), "the pinned snapshot kept the log from being copied").toBeGreaterThanOrEqual(WAL_HALF_GATE_BYTES);
    const bgAtHalf = ioBudget.admit("BG", 4096);
    // base f6ae52c670: no one asks the reader; the backlog stays above the half gate for ever
    expect(await until(() => backlog() < WAL_HALF_GATE_BYTES, 8_000), `backlog ${Math.round(backlog() / MiB)} MiB after release`).toBe(true);
    expect(bgAtHalf, "background memory work was stopped at the half gate").toBeNull();
    expect(releasedAt, "asked by the 1 s watch").toBeGreaterThan(0);
    expect(releasedAt - reachedAt).toBeLessThanOrEqual(2_500);
    expect(() => wal.assertWalWriteAdmission()).not.toThrow();
    db.prepare("INSERT INTO b5_probe VALUES (randomblob(4096))").run(); // the owner's send commits
  });

  // ASTRA 69ba57eb21 High 2: the case above checks the owner only after the release, when the log is already under the hard gate. Here the
  // owner keeps sending (1 MiB a send, about 10 MiB/s: from the half gate it reaches the 512 MiB hard gate in about 25 s if nothing lets go)
  // and background memory writers keep asking (each a 1 MiB write, admitted through the real ledger) the whole time, from below the half
  // gate, while memory's own reader holds its snapshot. Every owner send is checked at the real write gate before it commits.
  it("owner sends under sustained background pressure are never refused while memory's own reader pins the log", async () => {
    const db = await start();
    const reader = pinned();
    let releasedAt = 0;
    if (register) unregister.push(register({ name: "fixture memory reader", memory: true, release: done => { releasedAt = Date.now(); reader.exec("COMMIT"); done(); } }));
    grow(db, 230); // just under the half gate, so background writers are still admitted when the run starts
    const send = db.prepare("INSERT INTO b5_probe VALUES (randomblob(1048576))");
    const owner = { sent: 0, refused: [] as string[] }, bg = { asked: 0, granted: 0, grantedAtHalf: 0 }, halfRefused0 = ioBudget.halfGateRefusals;
    let maxBacklog = 0, crossedAt = 0;
    const stopAt = Date.now() + 120_000; // the run ends at 360 sends; the bound only stops a stuck run (base: refusals never end)
    const background = (async () => {
      while (Date.now() < stopAt && owner.sent < 360) {
        // a grant counts as past the half gate only when the log was past it both before and after the ask (a release can land in between)
        const before = backlog() >= WAL_HALF_GATE_BYTES, ticket = ioBudget.admit("BG", MiB), after = backlog() >= WAL_HALF_GATE_BYTES;
        bg.asked++;
        if (ticket) { bg.granted++; if (before && after) bg.grantedAtHalf++; send.run(); ioBudget.settle(ticket, 0); }
        await sleep(20);
      }
    })();
    while (Date.now() < stopAt && owner.sent < 360) {
      const b = backlog(); maxBacklog = Math.max(maxBacklog, b);
      if (!crossedAt && b >= WAL_HALF_GATE_BYTES) crossedAt = Date.now();
      try { wal.assertWalWriteAdmission(); send.run(); owner.sent++; }
      catch (error) { owner.refused.push(`${(error as { op?: string }).op ?? (error as Error).name} at ${Math.round(backlog() / MiB)} MiB`); }
      await sleep(100);
    }
    await background;
    console.log(`[B5-W-SUSTAINED] owner sent ${owner.sent}, refused ${owner.refused.length}; bg asked ${bg.asked}, granted ${bg.granted} (past the half gate ${bg.grantedAtHalf}), refused by the half gate ${ioBudget.halfGateRefusals - halfRefused0}; max backlog ${Math.round(maxBacklog / MiB)} MiB; released ${releasedAt ? releasedAt - crossedAt : "never"} ms after the half gate`);
    expect(crossedAt, "the pinned log reached the half gate under the load").toBeGreaterThan(0);
    // base f6ae52c670 and a release that never asks: the log stays pinned and the owner meets the 512 MiB hard gate ("wal-recovery")
    expect(owner.refused, "no owner send is refused while only memory's own reader pins the log").toEqual([]);
    expect(owner.sent, "the owner kept sending for the whole run").toBe(360);
    expect(ioBudget.halfGateRefusals - halfRefused0, "background writers were stopped by the half gate").toBeGreaterThan(0);
    expect(bg.grantedAtHalf, "no background write was admitted at or past the half gate").toBe(0);
    expect(releasedAt, "the reader was released after the log reached the half gate").toBeGreaterThanOrEqual(crossedAt);
    expect(releasedAt - crossedAt, "the reader was released within 5 s of the half gate").toBeLessThanOrEqual(wal.WAL_READER_RELEASE_MS);
    expect(maxBacklog, "the log never reached the hard gate").toBeLessThan(2 * WAL_HALF_GATE_BYTES);
  });

  it("a memory reader that does not let go within 5 s is restarted (its snapshot ends with it)", async () => {
    const db = await start();
    const reader = pinned();
    let askedAt = 0, restartedAt = 0;
    if (register) unregister.push(register({ name: "fixture stuck helper", memory: true, release: () => { askedAt = Date.now(); }, restart: () => { restartedAt = Date.now(); reader.close(); } }));
    grow(db, 272);
    expect(await until(() => askedAt > 0, 3_000), "asked at the half gate").toBe(true);
    expect(wal.walReaderHolders?.() ?? [], "while it holds on, it is named").toContain("fixture stuck helper");
    // a memory reader that starts during the episode (a new worker) is asked at the next look, not left holding
    let lateAskedAt = 0;
    if (register) unregister.push(register({ name: "fixture late reader", memory: true, release: done => { lateAskedAt = Date.now(); done(); } }));
    expect(await until(() => lateAskedAt > 0, 2_500), "a reader registered during the episode is asked").toBe(true);
    expect(await until(() => restartedAt > 0, 9_000), "restarted").toBe(true);
    expect(restartedAt - askedAt).toBeGreaterThanOrEqual(wal.WAL_READER_RELEASE_MS - 100);
    expect(restartedAt - askedAt).toBeLessThanOrEqual(wal.WAL_READER_RELEASE_MS + 2_500);
    expect(await until(() => backlog() < WAL_HALF_GATE_BYTES, 8_000)).toBe(true);
  });

  it("a reader memory does not own is never ended: background stops at the half gate and the owner's refusal names the reader", async () => {
    await start();
    const reader = pinned();
    let touched = false;
    if (register) unregister.push(register({ name: "fixture export", memory: false, release: () => { touched = true; }, restart: () => { touched = true; } }));
    const w = new DatabaseSync(join(DATA_DIR, "messages.db")); open.push(w); // an uninstrumented writer: it grows the log past the hard gate
    grow(w, 300);
    expect(ioBudget.admit("BG", 4096), "background stops first").toBeNull();
    await sleep(6_500);
    expect(touched, "memory never ends a reader it does not own").toBe(false);
    expect(reader.isTransaction, "its snapshot is still open").toBe(true);
    expect(backlog()).toBeGreaterThanOrEqual(WAL_HALF_GATE_BYTES);
    grow(w, 230);
    let refusal: unknown;
    try { wal.assertWalWriteAdmission(); } catch (error) { refusal = error; }
    expect((refusal as { op?: string })?.op, "the hard gate stays for it (disk safety)").toBe("wal-recovery");
    // base f6ae52c670: "Busy for a moment, try again" with no reader named
    expect(String((refusal as Error).message)).toContain("fixture export");
  });

  it("the transcript reader (registered by its worker) is waited for, never ended: its read in flight completes on the worker", async () => {
    const db = await start();
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const tr = new TranscriptReader(join(DATA_DIR, "messages.db"), { gate: gate.buffer as SharedArrayBuffer });
    let settled = false;
    const outcome = tr.forgotten(0).then(() => "resolved", (error: Error) => String(error.message)).finally(() => { settled = true; });
    try {
      expect(await until(() => Atomics.load(gate, 1) === 1, 5_000), "the worker is inside its read").toBe(true);
      pinned(); // a reader memory does not own keeps the log past the half gate for the whole test (the episode stays open)
      if (register) unregister.push(register({ name: "fixture export", memory: false }));
      grow(db, 272);
      expect(await until(() => (wal.walReaderHolders?.() ?? []).includes("transcript-read"), 3_000), "asked, and named while its read runs").toBe(true);
      await sleep(1_000);
      expect(settled, "the read in flight is not ended by the release").toBe(false);
      Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
      // base / an ending release: "Transcript reader exited", and the prune falls back to main-thread reads for good
      expect(await outcome).not.toMatch(/exited|stopped/);
      expect(await until(() => !(wal.walReaderHolders?.() ?? []).includes("transcript-read"), 3_000), "released once its read ended").toBe(true);
      expect(tr.isStopped).toBe(false);
    } finally { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); await tr.close(); }
  });
});
