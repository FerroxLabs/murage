// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, W4 low-disk recovery (MEMORY-V2-DESIGN 4.8 B2, 4.9 W4; owners: the worker clock and this witness = memv2-D).
// The checkpointer refreshes its disk verdict (free space under 64 MiB) only when it reads the log header. Since W4 the worker waits on the
// commit notice and reads the header only after a commit, a size change or an owed pass. A low-disk verdict refuses every guarded write, so
// no commit comes: once the owner frees space the verdict must still clear by itself, with the log unchanged and nothing committing.
// Real path: a real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA), the real checkpointer worker on its event-driven clock
// (a commit notice is handed in and bumped only when this test commits), the real write gate. Only the idle check is lengthened, so it
// cannot stand in. Skipped where /strict is not a real mount (as low-disk-strict.test.ts).
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as wal from "./wal-maintenance.ts";

const STRICT = "/strict";
const MiB = 1024 * 1024;
const onStrictMount = (() => { try { return readFileSync("/proc/mounts", "utf8").split("\n").some(line => line.split(" ")[1] === STRICT); } catch { return false; } })();
const free = () => { const s = statfsSync(STRICT); return s.bavail * s.bsize; };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(25); }
  return check();
}
function fillTo(file: string, targetFree: number): void {
  const fd = openSync(file, "a"), buf = Buffer.alloc(MiB, 1);
  try { while (free() - targetFree > 0) writeSync(fd, buf, 0, Math.min(MiB, free() - targetFree)); } finally { closeSync(fd); }
}
const refusal = (file: string): unknown => { try { wal.assertWalWriteAdmission(file); return null; } catch (error) { return error; } };
// base f6ae52c670 has no idle check (its worker polls every 25 ms): the witness still runs there
const idleCheck = (wal as unknown as { WAL_IDLE_CHECK?: { ms: number } }).WAL_IDLE_CHECK, idle0 = idleCheck?.ms;
let dir: string | null = null, db: DatabaseSync | null = null;
afterEach(async () => {
  await wal.stopWalMaintenance();
  if (idleCheck && idle0 !== undefined) idleCheck.ms = idle0;
  try { db?.close(); } catch { /* closed */ }
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

// R19 (FABLE 1817 Medium): a gate run that sets MURAGE_REQUIRE_STRICT=1 (memv2-D run.sh STRICT=1, the remote gate with --tmpfs /strict)
// fails here when /strict is missing, instead of passing the witness vacuously; elsewhere the skip is printed, never silent.
it("W4 the small-filesystem rig is present where a gate run requires it", () => {
  if (!onStrictMount) console.warn("[W4-DISK] SKIPPED: no /strict mount (the W4 witnesses below did not run)");
  if (process.env.MURAGE_REQUIRE_STRICT === "1") expect(onStrictMount, "MURAGE_REQUIRE_STRICT=1 but /strict is not a mount: the W4 witness would pass vacuously").toBe(true);
});

describe.skipIf(!onStrictMount)("W4 a freed disk clears the low-disk refusal with no commit (lane D)", { timeout: 60_000 }, () => {
  /** The real worker on a small filesystem, on its event-driven clock; `commit` is the only thing that bumps its commit notice. */
  async function rig(tag: string) {
    dir = join(STRICT, `w4-recovery-${tag}-${process.pid}`); mkdirSync(dir, { recursive: true });
    const file = join(dir, "messages.db");
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=0; PRAGMA wal_autocheckpoint=0; CREATE TABLE w4_probe(v BLOB)");
    // the commit notice the wake bus hands the worker: bumped here at each commit this test makes, never otherwise
    const notice = new SharedArrayBuffer(8), cell = new Int32Array(notice);
    const commit = () => { db!.prepare("INSERT INTO w4_probe VALUES (randomblob(4096))").run(); Atomics.add(cell, 0, 1); Atomics.notify(cell, 0); };
    if (idleCheck) idleCheck.ms = 20_000; // neither the idle check nor its size look can stand in inside this test
    wal.startWalMaintenance(file, { setAutocheckpoint: pages => db!.exec(`PRAGMA wal_autocheckpoint=${pages}`), nudge: async () => false, commitNotice: () => notice });
    expect(await until(() => wal.walMaintenanceReady(), 10_000), "the checkpointer is up").toBe(true);
    if (idleCheck) expect((wal.walMaintenanceCounters() as { eventDriven?: boolean } | null)?.eventDriven, "the worker runs on the commit notice").toBe(true);
    commit(); await sleep(400);
    expect(wal.diskFloorRefusing()).toBe(false);
    return { file, commit, ballast: join(dir, "ballast") };
  }
  /** The owner frees space; from here nothing commits (every guarded write is refused) and the log keeps its size. */
  async function freeAndExpectCleared(file: string, ballast: string, commit: () => void, label: string) {
    expect((refusal(file) as Error | null)?.constructor?.name, "the owner's writes are refused at the floor").toBe("DiskFloorRefusal");
    await sleep(300);
    const walBytes = statSync(file + "-wal").size;
    rmSync(ballast, { force: true });
    const freedAt = Date.now(), polls0 = wal.walMaintenanceCounters()?.polls ?? 0;
    // r2 69ba57eb21: the verdict stayed refusing until an unrelated commit, a 30 s size change or a restart (ASTRA 69ba57eb21 High 1)
    const cleared = await until(() => !wal.diskFloorRefusing(), 4_000);
    console.log(`[W4-DISK] ${label}: refusal cleared ${cleared ? Date.now() - freedAt : "never"} ms after the disk was freed (log ${walBytes} bytes, unchanged; worker polls since ${(wal.walMaintenanceCounters()?.polls ?? 0) - polls0})`);
    expect(cleared, "a freed disk clears the refusal without a commit").toBe(true);
    expect(refusal(file), "the owner's write is admitted again").toBeNull();
    expect(statSync(file + "-wal").size, "no commit happened while it cleared").toBe(walBytes);
    commit(); // and it commits
  }

  it("low disk seen by the worker's own poll after a commit: the verdict is refreshed while nothing commits", async () => {
    const { file, commit, ballast } = await rig("poll");
    fillTo(ballast, 40 * MiB);
    // the next commits let the worker see it (its disk sample is at most once a second)
    expect(await until(() => { if (!wal.diskFloorRefusing()) commit(); return wal.diskFloorRefusing(); }, 6_000), "low disk is seen after a commit").toBe(true);
    await freeAndExpectCleared(file, ballast, commit, "poll");
  });

  it("low disk seen by a pass the main thread requested (no commit at all): the parked clock is woken and the verdict clears", async () => {
    const { file, commit, ballast } = await rig("requested");
    await sleep(1_100); // past the worker's 1 s disk sample, so the requested pass samples the disk; the clock is parked on its 20 s idle wait
    fillTo(ballast, 40 * MiB);
    const polls0 = wal.walMaintenanceCounters()?.polls ?? 0;
    // the main thread's own passes (a delete scrub, settleWal): no commit, no notice. One already in flight may have sampled the disk before
    // the fill, so ask again until a pass samples it (the worker samples at most once a second)
    const end = Date.now() + 5_000;
    while (!wal.diskFloorRefusing() && Date.now() < end) { await wal.checkpointPassive(); await sleep(50); }
    expect(wal.diskFloorRefusing(), "a requested pass saw the low disk").toBe(true);
    if (idleCheck) expect((wal.walMaintenanceCounters()?.polls ?? 0) - polls0, "the verdict came from the requested pass, not the clock's poll").toBe(0);
    await freeAndExpectCleared(file, ballast, commit, "requested");
  });
});
