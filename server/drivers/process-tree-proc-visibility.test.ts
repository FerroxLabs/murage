// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1020 round 2: the /proc scan is three-valued. A Map (empty included) means gone or the descendants; null means unknown. A scan
// that cannot see every process (unreadable entry, hidepid, another pid namespace) or that ran past its work budget is unknown, and
// unknown never releases a bot. The file system is a double, so each case is forced rather than produced by the host.
import { afterEach, describe, expect, it } from "vitest";
import * as tree_ from "./process-tree.ts";
import type { ProcFs } from "./process-tree.ts";
// a base checkout lacks the scan seam and budgets: its tests fail on an assertion, not on a missing export
const lib = tree_ as Record<string, any>;
const setProcScanSeam = (seam?: { fs?: ProcFs }) => lib.setProcScanSeam?.(seam);
const procRowGone = (row: { state: string; threads: number }): boolean => lib.procRowGone?.(row) ?? false;
const procDescendantsSync = (root: number): Map<number, string> | null => tree_.procDescendantsSync(root);
const procDescendants = (root: number): Promise<Map<number, string> | null> => lib.procDescendants?.(root) ?? Promise.resolve(null);
const PROC_SCAN_SYNC_BUDGET: { entries: number } = lib.PROC_SCAN_SYNC_BUDGET ?? { entries: 0 };

interface Table { pids: Map<number, number>; unreadable: Set<number>; vanished: Set<number>; hidepid: string; ns: Map<number, string>; reads: { stat: number }; pass: number; onPass?: (pass: number) => void; bump: Map<number, number> }
function table(rows: Array<[number, number]>): Table {
  return { pids: new Map(rows), unreadable: new Set(), vanished: new Set(), hidepid: "hidepid=0", ns: new Map(), reads: { stat: 0 }, pass: 0, bump: new Map() };
}
const err = (code: string) => Object.assign(new Error(code), { code });
function fsOf(t: Table): ProcFs {
  return {
    readdir: () => { t.pass++; t.onPass?.(t.pass); return ["self", "cpuinfo", ...[...t.pids.keys(), ...t.vanished].map(String)]; },
    readFile: (path) => {
      if (path === "/proc/self/mountinfo") return `22 1 0:21 / /proc rw,nosuid - proc proc rw,${t.hidepid}\n23 1 0:22 / /sys rw - sysfs sysfs rw\n`;
      const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)![1]);
      t.reads.stat++;
      if (t.vanished.has(pid)) throw err("ENOENT");
      if (t.unreadable.has(pid)) throw err("EACCES");
      const rest = ["S", String(t.pids.get(pid)), ...Array(17).fill("0"), String(1000 + pid + (t.pass >= 2 ? t.bump.get(pid) ?? 0 : 0))];
      return `${pid} (x y) ${rest.join(" ")}`;
    },
    readlink: (path) => {
      if (path === "/proc/self/ns/pid") return "pid:[1]";
      const pid = Number(/^\/proc\/(\d+)\/ns\/pid$/.exec(path)![1]);
      if (!t.pids.has(pid)) throw err("ENOENT");
      return t.ns.get(pid) ?? "pid:[1]";
    },
  };
}
afterEach(() => setProcScanSeam());
const ROOT = 500;
const tree = () => table([[ROOT, 1], [501, ROOT], [502, 501], [7, 1]]);

describe("the /proc scan answers gone or alive only when it could see everything", () => {
  it("V0 full visibility: descendants are found and an empty tree is gone (an empty Map)", () => {
    const t = tree(); setProcScanSeam({ fs: fsOf(t) });
    expect([...procDescendantsSync(ROOT)!.keys()].sort()).toEqual([501, 502]);
    const none = table([[ROOT, 1]]); setProcScanSeam({ fs: fsOf(none) });
    expect(procDescendantsSync(ROOT)?.size).toBe(0);
  });
  it("V1 an unreadable entry is unknown, not gone; a pid that vanished mid-scan is not unreadable", () => {
    const t = tree(); t.unreadable.add(501); setProcScanSeam({ fs: fsOf(t) });
    expect(procDescendantsSync(ROOT)).toBeNull();
    const gone = tree(); gone.vanished.add(900); setProcScanSeam({ fs: fsOf(gone) });
    expect(procDescendantsSync(ROOT)).not.toBeNull();
  });
  it("V2 a hidepid mount is unknown", () => {
    for (const mode of ["hidepid=1", "hidepid=2", "hidepid=invisible"]) {
      const t = tree(); t.hidepid = mode; setProcScanSeam({ fs: fsOf(t) });
      expect(procDescendantsSync(ROOT), mode).toBeNull();
    }
    const open = tree(); open.hidepid = "hidepid=0"; setProcScanSeam({ fs: fsOf(open) });
    expect(procDescendantsSync(ROOT)).not.toBeNull();
  });
  it("V3 a server in another pid namespace is unknown", () => {
    const t = tree(); t.ns.set(ROOT, "pid:[4026531836]"); setProcScanSeam({ fs: fsOf(t) });
    expect(procDescendantsSync(ROOT)).toBeNull();
  });
  it("V4 a 100 000 entry table runs into the entry budget, is unknown, and does not hold the event loop", async () => {
    const rows: Array<[number, number]> = [[ROOT, 1]];
    for (let pid = 1000; pid < 101_000; pid++) rows.push([pid, 1]);
    const t = table(rows); setProcScanSeam({ fs: fsOf(t) });
    const began = Date.now();
    expect(procDescendantsSync(ROOT)).toBeNull();
    expect(Date.now() - began, "the synchronous scan is bounded").toBeLessThan(1_000);
    expect(t.reads.stat, "no more than the entry budget was read").toBeLessThanOrEqual(PROC_SCAN_SYNC_BUDGET.entries);
    // the async (recovery) scan reads the whole table but yields: a timer keeps firing while it runs
    let ticks = 0; let longest = 0; let last = Date.now();
    const timer = setInterval(() => { ticks++; longest = Math.max(longest, Date.now() - last); last = Date.now(); }, 1);
    const found = await procDescendants(ROOT);
    clearInterval(timer);
    expect(found, "within the async budget, the whole table was seen").not.toBeNull();
    expect(ticks, "the event loop ran during the scan").toBeGreaterThan(0);
    expect(longest, "no slice held the loop for long").toBeLessThan(500);
  }, 30_000);
  it("V5 a torn walk is unknown: a descendant that appears between the two passes", () => {
    const t = tree(); t.onPass = (pass) => { if (pass === 2) t.pids.set(503, 502); }; setProcScanSeam({ fs: fsOf(t) });
    expect(procDescendantsSync(ROOT)).toBeNull();
    const calm = tree(); setProcScanSeam({ fs: fsOf(calm) });
    expect(procDescendantsSync(ROOT)).not.toBeNull();
  });
  it("V6 a torn walk is unknown: a tree member that vanished in the second pass; an outsider that vanished is not", () => {
    const t = tree(); t.onPass = (pass) => { if (pass === 2) t.vanished.add(502); }; t.pids.delete(502); t.pids.set(502, 501); setProcScanSeam({ fs: fsOf(t) });
    expect(procDescendantsSync(ROOT)).toBeNull();
    const outsider = tree(); outsider.onPass = (pass) => { if (pass === 2) outsider.vanished.add(7); }; setProcScanSeam({ fs: fsOf(outsider) });
    expect(procDescendantsSync(ROOT)).not.toBeNull();
  });
  it("V7 a torn walk is unknown: the server's own start identity changed between the passes (a reused pid)", () => {
    const t = tree(); t.bump.set(ROOT, 5); setProcScanSeam({ fs: fsOf(t) });
    expect(procDescendantsSync(ROOT)).toBeNull();
  });
  it("V8 a zombie leader is gone only when no other thread still runs", () => {
    expect(procRowGone({ state: "Z", threads: 1 })).toBe(true);
    expect(procRowGone({ state: "Z", threads: 3 }), "the leader exited, other threads run").toBe(false);
    expect(procRowGone({ state: "S", threads: 1 })).toBe(false);
  });
});
