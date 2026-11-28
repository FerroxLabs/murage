// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy, owed results (owner: routines; the gate side is wal-maintenance.ts assertWalWriteAdmission, unchanged): a foreground write the
// database refuses never drops a routine run's result card. The gate here is the REAL assertWalWriteAdmission on a retained log past the
// admission size (a sparse file), not a stub that throws.
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WAL_ADMISSION_BYTES, assertWalWriteAdmission } from "./wal-maintenance.ts";
import { createOwedDeliveries } from "./routine-owed.ts";
import { resetObserveWindows, setObserveSink } from "./observe.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
let lines: string[] = [];
beforeEach(() => { lines = []; resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => { setObserveSink(); vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

/** A retained log past the admission size with no worker copy: the production refusal (DatabaseBusyError wal-recovery). */
function gate() {
  const dir = mkdtempSync(join(tmpdir(), "murage-busy-")); dirs.push(dir);
  const file = join(dir, "messages.db");
  writeFileSync(file, ""); writeFileSync(`${file}-wal`, "");
  truncateSync(`${file}-wal`, WAL_ADMISSION_BYTES + 4096);
  return { dir, file, calls: 0, check() { this.calls++; assertWalWriteAdmission(file); }, open() { truncateSync(`${file}-wal`, 0); } };
}

function owed(g: ReturnType<typeof gate>, count: number, unsettled = new Set<string>()) {
  let now = 1_000_000;
  const runs = new Map<string, any>(); const delivered: string[] = []; const waiting = new Map<string, boolean>();
  for (let i = 0; i < count; i++) runs.set(`r${i}`, { id: `r${i}`, status: "completed", delivery: { state: "pending" } });
  const owedIds = new Set(runs.keys());
  const deps = createOwedDeliveries({
    now: () => now, runById: id => runs.get(id), isOpen: () => false, publicationUnsettled: run => unsettled.has(run.id),
    deliver: () => g.check(),
    markDelivered: id => { delivered.push(id); runs.get(id).delivery = { state: "sent" }; },
    setWaiting: id => { waiting.set(id, true); }, redact: t => t,
  }, owedIds);
  return { deps, delivered, waiting, runs, owedIds, advance: (ms: number) => { now += ms; } };
}

it("2: refused result writes stay owed: one probe a pass, a growing wait on the direct routes, one log line a minute, a waiting note on every owed run, all written at the first pass once the gate opens", () => {
  const g = gate(); const o = owed(g, 64);
  o.deps.retry(() => false);
  expect(g.calls).toBe(1); // 64 owed runs, one refusal stops the pass
  expect([...o.waiting.values()].filter(w => w)).toHaveLength(64);
  for (let i = 0; i < 10; i++) { o.advance(5_000); o.deps.retry(() => false); }
  expect(g.calls).toBe(11); // one probe a pass, never one per owed run
  // a publication's wake or a run that just settled reaches finish() directly: it waits out the pause, which has grown
  for (const id of ["r0", "r1", "r63"]) expect(o.deps.finish(id)).toBe("busy");
  expect(g.calls).toBe(11);
  expect(lines.filter(l => l.includes("waiting for the database")).length).toBe(1); // one line for 64 runs and 11 refusals
  o.advance(61_000); o.deps.retry(() => false);
  expect(g.calls).toBe(12);
  expect(lines.filter(l => l.includes("waiting for the database")).length).toBe(2); // a line a minute
  o.advance(7 * 60_000);
  expect(o.deps.finish("r5")).toBe("busy"); // the direct routes' wait is past seven minutes now
  expect(g.calls).toBe(12);
  expect(o.delivered).toEqual([]);
  // the gate opens inside that wait: the next pass's probe is written, the pause ends, and every owed result follows in that pass, once
  g.open(); o.advance(5_000); o.deps.retry(() => false); // the pause still has some 45 s to run
  expect(o.delivered).toHaveLength(64);
  expect(new Set(o.delivered).size).toBe(64);
  expect(o.deps.owedCount()).toBe(0);
  // the probe's write ended the pause for the direct routes too: a run that settles now is written at once
  o.runs.set("r64", { id: "r64", status: "completed", delivery: { state: "pending" } }); o.owedIds.add("r64");
  expect(o.deps.finish("r64")).toBe("done");
  expect(o.delivered).toContain("r64");
});

it("3: during the pause a result still waiting for its publication passes the probe on: the next owed result tries the gate and lands", () => {
  const g = gate(); const o = owed(g, 3, new Set(["r0"]));
  o.deps.retry(() => false);
  expect(g.calls).toBe(1); // r1 was refused (r0 waits for its publication without a write)
  g.open(); o.advance(5_000); o.deps.retry(() => false); // still paused: r0 waits again, so r1 probes
  expect(o.delivered).toEqual(["r1", "r2"]);
  expect(o.deps.owedCount()).toBe(1);
});
