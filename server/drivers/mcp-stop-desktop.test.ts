// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace R1-R3, R7, R9, T1, T4, U1-U3, V2 (desktop): PROVEN GONE is a direct identity check of EVERY recorded (pid, start) pair, root included, on two
// agreeing full-table passes taken AFTER the kill and after a COMPLETED pre-stop capture. An empty descendant set is never a verdict. The table is a
// double, so each interleaving (fork after the listing, pid reuse, a reparent, an unreadable entry) is forced, not produced by load.
import { describe, expect, it } from "vitest";
import {
  classifyPair, desktopCapture, desktopProof, signalPair, type DesktopEnv, type DesktopRow, type Pair, type PidHandle, type SignalEnv, type StopRecord,
} from "./mcp-stop-proof.ts";
import { DesktopStopTarget } from "./mcp-stop-target.ts";
import { StopRecordStore, type StopRecordFs } from "./mcp-stop-records.ts";

const row = (pid: number, ppid: number, start = `proc:${pid}`, over: Partial<DesktopRow> = {}): DesktopRow => ({ pid, ppid, start, startKind: "proc", state: "S", threads: 1, ...over });
const pair = (pid: number, start = `proc:${pid}`): Pair => ({ pid, start });
const CTX = { bootId: "boot-A", pidns: "pid:[1]", visibility: { hidepid: false, sameNs: true } };
const record = (pairs: Pair[], over: Partial<NonNullable<StopRecord["desktop"]>> = {}, top: Partial<StopRecord> = {}): StopRecord => ({
  version: 1, owner: "bot-1", generation: 1, platform: "desktop", state: "STOPPING",
  desktop: { pairs, rootPair: pairs[0], context: CTX, captureCompleted: true, ...over }, ...top,
});
interface Script { tables: Array<DesktopRow[] | null>; boot?: string | null; ns?: string | null; vis?: { hidepid: boolean; sameNs: boolean } | null; platform?: "linux" | "darwin"; calls: number }
const envOf = (s: Script): DesktopEnv => ({
  platform: s.platform ?? "linux",
  bootId: async () => (s.boot === undefined ? "boot-A" : s.boot),
  pidns: async () => (s.ns === undefined ? "pid:[1]" : s.ns),
  visibility: async () => (s.vis === undefined ? { hidepid: false, sameNs: true } : s.vis),
  table: async () => { const next = s.tables[Math.min(s.calls++, s.tables.length - 1)]; return next === undefined ? null : next; },
});
const script = (...tables: Array<DesktopRow[] | null>): Script => ({ tables, calls: 0 });
const verdictOf = async (rec: StopRecord, s: Script) => (await desktopProof(rec, envOf(s))).verdict.v;

describe("DK: the desktop proof (R1)", () => {
  it("DK1 every recorded pair absent on two agreeing passes, after a completed capture, is PROVEN GONE", async () => {
    expect(await verdictOf(record([pair(10), pair(11)]), script([row(1, 0)]))).toBe("gone");
  });
  it("DK2 a recorded pair still running as itself is alive", async () => {
    expect(await verdictOf(record([pair(10), pair(11)]), script([row(10, 1), row(11, 10)]))).toBe("alive");
  });
  it("DK3 a pid now running with another start identity is a reused pid: that pair is gone", async () => {
    expect(await verdictOf(record([pair(10), pair(11)]), script([row(10, 1, "proc:other"), row(11, 1, "proc:other2")]))).toBe("gone");
  });
  it("DK4 a captured pair with ppid 1 on both post-kill passes is UNKNOWN and is reported REPARENTED (R1, U1)", async () => {
    const result = await desktopProof(record([pair(10), pair(11)]), envOf(script([row(10, 1), row(11, 1)])));
    expect(result.verdict.v).toBe("unknown");
    expect(result.reparented.map((p) => p.pid)).toEqual([11]);
  });
  it("DK5 a pre-stop UNKNOWN (capture not completed) stays UNKNOWN after the kill, even when the later walk is empty (R2)", async () => {
    expect(await verdictOf(record([pair(10)], { captureCompleted: false }), script([row(1, 0)]))).toBe("unknown");
  });
  it("DK6 a restart with a live persisted pair is not gone", async () => {
    const persisted = JSON.parse(JSON.stringify(record([pair(10), pair(11)]))) as StopRecord;
    expect(await verdictOf(persisted, script([row(10, 1), row(11, 10)]))).not.toBe("gone");
  });
  it("DK7 an empty descendant set is NEVER a verdict: a union without its root pair proves nothing", async () => {
    expect(await verdictOf(record([], { rootPair: undefined }), script([row(1, 0)]))).toBe("unknown");
    expect(await verdictOf(record([pair(11)], { rootPair: pair(10) }), script([row(1, 0)]))).toBe("unknown");
  });
  it("DK8 R7: a Linux zombie leader with other threads is alive; with one thread it is gone; a macOS Z is gone", async () => {
    expect(await verdictOf(record([pair(10)]), script([row(10, 1, "proc:10", { state: "Z", threads: 3 })]))).toBe("alive");
    expect(await verdictOf(record([pair(10)]), script([row(10, 1, "proc:10", { state: "Z", threads: 1 })]))).toBe("gone");
    const mac = record([pair(10, "libproc:1.000001")]);
    expect(await verdictOf(mac, { ...script([row(10, 1, "libproc:1.000001", { state: "Z", threads: null, startKind: "libproc" })]), platform: "darwin" })).toBe("gone");
  });
  it("DK9 two passes that disagree on a pair, or on new descendants, are UNKNOWN", async () => {
    expect(await verdictOf(record([pair(10), pair(11)]), script([row(10, 1), row(11, 10)], [row(10, 1)]))).toBe("unknown");
    expect(await verdictOf(record([pair(10)]), script([row(1, 0)], [row(1, 0), row(30, 1)]))).toBe("gone"); // a stranger under init is not ours
  });
  it("DK10 a new descendant of a live recorded pair is alive; a pass that cannot be read is UNKNOWN", async () => {
    expect(await verdictOf(record([pair(10)]), script([row(10, 1), row(50, 10)]))).toBe("alive");
    expect(await verdictOf(record([pair(10)]), script(null))).toBe("unknown");
    expect(await verdictOf(record([pair(10)]), script([row(1, 0)], null))).toBe("unknown");
  });
  it("DK11 T1: a different boot id means every pair is gone; a different pid namespace or lost visibility is UNKNOWN", async () => {
    expect(await verdictOf(record([pair(10)]), { ...script([row(10, 1)]), boot: "boot-B" })).toBe("gone");
    expect(await verdictOf(record([pair(10)]), { ...script([row(1, 0)]), ns: "pid:[2]" })).toBe("unknown");
    expect(await verdictOf(record([pair(10)]), { ...script([row(1, 0)]), vis: { hidepid: true, sameNs: true } })).toBe("unknown");
    expect(await verdictOf(record([pair(10)]), { ...script([row(1, 0)]), vis: { hidepid: false, sameNs: false } })).toBe("unknown");
    expect(await verdictOf(record([pair(10)]), { ...script([row(1, 0)]), boot: null })).toBe("unknown");
  });
  it("DK12 V2: a same-boot PLANNED, SPAWNING or RUNNING record stays UNKNOWN even when every stored pair re-stats gone; a different boot is gone", async () => {
    for (const state of ["PLANNED", "SPAWNING", "RUNNING"] as const) {
      expect(await verdictOf(record([pair(10)], {}, { state }), script([row(1, 0)]))).toBe("unknown");
      expect(await verdictOf(record([pair(10)], {}, { state }), { ...script([row(1, 0)]), boot: "boot-B" })).toBe("gone");
    }
  });
  it("DK13 R9, U2: an lstart-only identity is UNKNOWN for gone", async () => {
    expect(await verdictOf(record([pair(10)]), script([row(10, 1, "lstart:Wed Oct  7 10:00:00 2026", { startKind: "lstart" })]))).toBe("unknown");
    expect(classifyPair(pair(10), row(10, 1, "x", { startKind: "lstart" }), "darwin", () => true, true).cls).toBe("unknown");
  });
  it("DK14 T4: same-second pid reuse on macOS: libproc identities are distinct, so the old pair is gone", async () => {
    const mac = { ...script([row(10, 1, "libproc:100.000002", { startKind: "libproc", threads: null })]), platform: "darwin" as const };
    expect(await verdictOf(record([pair(10, "libproc:100.000001")]), mac)).toBe("gone");
  });
});

describe("DC: the pre-stop capture (R2, B2-B4)", () => {
  it("DC1 T1 a fork after the first listing: the two passes differ, so the capture is UNKNOWN", async () => {
    expect(await desktopCapture(10, envOf(script([row(10, 1), row(11, 10)], [row(10, 1), row(11, 10), row(12, 10)])))).toBeNull();
  });
  it("DC2 T2 an ancestor exits and its pid is reused mid-pass: the same pid has a new start, so UNKNOWN", async () => {
    expect(await desktopCapture(10, envOf(script([row(10, 1), row(11, 10)], [row(10, 1), row(11, 10, "proc:reused")])))).toBeNull();
    expect(await desktopCapture(10, envOf(script([row(10, 1)], [row(10, 1, "proc:reused")])))).toBeNull();
  });
  it("DC3 T3 a child reparented to init between passes drops out of the second set: UNKNOWN", async () => {
    expect(await desktopCapture(10, envOf(script([row(10, 1), row(11, 10)], [row(10, 1), row(11, 1)])))).toBeNull();
  });
  it("DC4 T5 an unreadable table (EACCES on one stat), hidepid, or a foreign namespace make the capture UNKNOWN", async () => {
    expect(await desktopCapture(10, envOf(script(null)))).toBeNull();
    expect(await desktopCapture(10, { ...envOf(script([row(10, 1)])), visibility: async () => ({ hidepid: true, sameNs: true }) })).toBeNull();
    expect(await desktopCapture(10, { ...envOf(script([row(10, 1)])), visibility: async () => ({ hidepid: false, sameNs: false }) })).toBeNull();
  });
  it("DC5 a stable capture returns the root and every descendant with the identity context recorded before the kill", async () => {
    const table = [row(10, 1), row(11, 10), row(12, 11), row(99, 1)];
    const found = await desktopCapture(10, envOf(script(table)));
    expect(found?.pairs.map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    expect(found?.root.pid).toBe(10);
    expect(found?.context).toEqual({ bootId: "boot-A", pidns: "pid:[1]", visibility: { hidepid: false, sameNs: true } });
  });
  it("DC6 an lstart-grade identity in a capture is no identity: UNKNOWN", async () => {
    expect(await desktopCapture(10, envOf(script([row(10, 1, "x", { startKind: "lstart" })])))).toBeNull();
  });
});

const memFs = (): StopRecordFs & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return { files, write: (path, data) => { files.set(path, data); }, read: (path) => { const v = files.get(path); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; }, list: () => [...files.keys()].map((p) => p.split("/").pop()!), remove: (path) => { files.delete(path); }, mkdirp: () => {} };
};
describe("DN nlrace4a: post-kill discoveries join the persisted union (Astra 2)", () => {
  it("DN1 a descendant first observed by a post-kill pass is ALIVE, is persisted, and stays not-GONE after the root dies and it reparents", async () => {
    const phase = { rows: [row(10, 1), row(20, 10)] as DesktopRow[] };
    const env = (): DesktopEnv => ({ ...envOf(script([])), table: async () => phase.rows });
    const target = new DesktopStopTarget(record([pair(10)]), 10, "linux", { store: null, desktopEnv: () => env() });
    expect((await target.prove()).v).toBe("alive");
    expect(target.record.desktop?.pairs.map((p) => p.pid).sort()).toEqual([10, 20]);
    phase.rows = [row(20, 1)]; // the root died, the observed descendant reparented to init and still lives
    expect((await target.prove()).v).not.toBe("gone");
  });
});

describe("DU: the U1 union and REPARENTED across turns and restarts", () => {
  const planned = (): StopRecord => ({ version: 1, owner: "bot-1", generation: 5, platform: "desktop", state: "RUNNING", desktop: { pairs: [], captureCompleted: false } });
  it("DU1 a grandchild seen only at a mid-RUNNING walk and then reparented before STOPPING stays in the set and keeps UNKNOWN; restart keeps the REPARENTED flag; killed then re-stat gone releases", async () => {
    const fs = memFs();
    const store = new StopRecordStore("/rec", fs);
    store.plan({ ...planned(), state: "PLANNED" });
    const phase = { rows: [row(10, 1), row(11, 10), row(12, 11)] as DesktopRow[] };
    const env = (): DesktopEnv => ({ ...envOf(script([])), table: async () => phase.rows });
    const target = new DesktopStopTarget(planned(), 10, "linux", { store, desktopEnv: () => env() });
    await target.track(); // a mid-RUNNING turn walk sees the grandchild 12
    expect(target.record.desktop?.pairs.map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    phase.rows = [row(10, 1), row(11, 10), row(12, 1)]; // 12 is reparented to init before the stop
    await target.track();
    expect(target.record.desktop?.pairs.find((p) => p.pid === 12)?.reparented).toBe(true);
    phase.rows = [row(10, 1), row(11, 10)]; // by the stop the capture no longer finds 12 under the root
    expect(await target.capture()).toBe(true);
    expect(target.record.desktop?.pairs.map((p) => p.pid).sort()).toEqual([10, 11, 12]); // the union kept it
    phase.rows = [row(12, 1)]; // 10 and 11 died; the orphan 12 still lives
    expect((await target.prove()).v).toBe("unknown");
    // restart: a fresh target from the persisted record keeps the flag and the UNKNOWN while the pair lives
    const persisted = store.list().records[0]!;
    expect(persisted.desktop?.pairs.find((p) => p.pid === 12)?.reparented).toBe(true);
    const restarted = new DesktopStopTarget(persisted, 10, "linux", { store: null, desktopEnv: () => env() });
    expect((await restarted.prove()).v).toBe("unknown");
    phase.rows = []; // the orphan dies; the re-stat of that exact pair proves it gone
    expect((await restarted.prove()).v).toBe("gone");
  });
});

describe("DS: signalling is bound to identity; never a process group (U3, S3, B8)", () => {
  const kills: Array<[number, string]> = [];
  const sigEnv = (identities: Array<{ start: string; kind: "proc" | "libproc" | "lstart" } | "absent" | null>, extra: Partial<SignalEnv> = {}): SignalEnv & { events: string[] } => {
    const events: string[] = [];
    return { events, platform: "linux", identity: async () => (identities.length > 1 ? identities.shift()! : identities[0]!), kill: (pid, sig) => { kills.push([pid, sig]); }, residual: (e) => events.push(e), ...extra };
  };
  const handle = (start: string, log: string[]): PidHandle => ({ start: async () => start, send: (sig) => { log.push(`send ${sig}`); }, close: () => { log.push("close"); } });
  it("DS1 pidfd path: a start that no longer matches sends nothing and closes the handle; a match signals through that handle", async () => {
    kills.length = 0;
    const log: string[] = [];
    expect(await signalPair(pair(10), "SIGKILL", sigEnv([{ start: "proc:10", kind: "proc" }], { openHandle: async () => handle("proc:other", log) }))).toBe("skipped");
    expect(log).toEqual(["close"]);
    log.length = 0;
    expect(await signalPair(pair(10), "SIGKILL", sigEnv([{ start: "proc:10", kind: "proc" }], { openHandle: async () => handle("proc:10", log) }))).toBe("sent");
    expect(log).toEqual(["send SIGKILL", "close"]);
    expect(kills).toEqual([]); // never a numeric kill when a handle exists
  });
  it("DS2 T13 pid reuse: a pid whose start changed receives no signal (without pidfd)", async () => {
    kills.length = 0;
    expect(await signalPair(pair(10), "SIGKILL", sigEnv([{ start: "proc:new", kind: "proc" }]))).toBe("skipped");
    expect(await signalPair(pair(10), "SIGKILL", sigEnv(["absent"]))).toBe("skipped");
    expect(kills).toEqual([]);
  });
  it("DS3 U2: the same scenario given lstart-only input yields no signal", async () => {
    kills.length = 0;
    expect(await signalPair(pair(10, "libproc:1"), "SIGKILL", { ...sigEnv([{ start: "libproc:1", kind: "lstart" }]), platform: "darwin" })).toBe("skipped");
    expect(kills).toEqual([]);
  });
  it("DS4 the check-then-signal window: identity re-read before and after; a change after the kill is a residual event, never proof", async () => {
    kills.length = 0;
    const env = sigEnv([{ start: "proc:10", kind: "proc" }, { start: "proc:other", kind: "proc" }]);
    expect(await signalPair(pair(10), "SIGKILL", env)).toBe("residual");
    expect(kills).toEqual([[10, "SIGKILL"]]);
    expect(env.events.length).toBe(1);
    const same = sigEnv([{ start: "proc:10", kind: "proc" }]);
    expect(await signalPair(pair(10), "SIGKILL", same)).toBe("sent");
    expect(same.events).toEqual([]);
  });
  it("DS5 no process-group signal on any desktop path: the signalling source never builds a negative pid or a killpg call", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["./mcp-stop-proof.ts", "./mcp-stop-target.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/killpg|process\.kill\(\s*-|kill\(-/);
    }
  });
});
