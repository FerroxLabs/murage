// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace S2, V2: durable ownership BEFORE launch. A record per (owner, generation) moves PLANNED -> SPAWNING -> RUNNING -> STOPPING and is deleted only
// after PROVEN GONE. Startup reconciliation quarantines every undeleted record BEFORE any turn is admitted, then proves it. The file system is a
// double with cut points, so each crash window is forced.
import { afterEach, describe, expect, it } from "vitest";
import { StopRecordStore, type StopRecordFs } from "./mcp-stop-records.ts";
import { McpStopLifecycle, configureMcpStop, planMcpSpawn, reconcileMcpStopRecords, resetMcpStopForTests, spawnPlanned } from "./mcp-stop-runtime.ts";
import type { StopRecord } from "./mcp-stop-proof.ts";
import type { ProbeHandle, ProbeOutcome, RecoveryClock } from "./mcp-stop-recovery.ts";

interface Mem extends StopRecordFs { files: Map<string, string>; log: string[]; failNextWrite?: boolean }
const mem = (files = new Map<string, string>()): Mem => {
  const m: Mem = {
    files, log: [],
    write: (path, data) => { if (m.failNextWrite) { m.failNextWrite = false; throw new Error("EIO"); } m.log.push(`write ${JSON.parse(data).state}`); files.set(path, data); },
    read: (path) => { const v = files.get(path); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    list: () => [...files.keys()].map((p) => p.split("/").pop()!),
    remove: (path) => { m.log.push("remove"); files.delete(path); },
    mkdirp: () => {},
  };
  return m;
};
const cloud = { unit: "murage-mcp-0123456789abcdef.scope", cgroupPath: "/sys/fs/cgroup/murage.slice/murage-turns.slice/murage-mcp-0123456789abcdef.scope" };
const base = (over: Partial<StopRecord> = {}): StopRecord => ({ version: 1, owner: "bot-1", generation: 7, platform: "cloud", state: "PLANNED", cloud: { ...cloud, contained: false }, ...over });

afterEach(() => resetMcpStopForTests());

const manualClock = (): RecoveryClock & { run(ms: number): Promise<void>; now_: number } => {
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const c = { now_: 0, now: () => c.now_, setTimeout: (fn: () => void, ms: number) => { const t = { at: c.now_ + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
    async run(ms: number) { const end = c.now_ + ms; for (;;) { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; next.live = false; c.now_ = Math.max(c.now_, next.at); next.fn(); } c.now_ = end; for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); } };
  return c;
};
const scripted = (verdicts: ProbeOutcome[]) => (_rec: StopRecord, signal: AbortSignal): ProbeHandle => {
  const outcome = verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!;
  void signal;
  return { result: Promise.resolve(outcome), kill() {}, alive: () => false, exited: Promise.resolve() };
};

describe("RS: records and startup reconciliation (S2, V2)", () => {
  it("RS1 SPAWNING is written durably BEFORE the exec runs; a spawn that throws keeps its record", () => {
    const fs = mem();
    const store = new StopRecordStore("/rec", fs);
    configureMcpStop({ store });
    const plan = planMcpSpawn("bot-1", { platform: "linux", cloud: false });
    expect(fs.log).toEqual(["write PLANNED"]);
    let sawAtExec: string[] = [];
    expect(() => spawnPlanned(plan, () => { sawAtExec = [...fs.log]; throw new Error("exec failed"); })).toThrow("exec failed");
    expect(sawAtExec).toEqual(["write PLANNED", "write SPAWNING"]);
    expect(store.list().records[0]?.state).toBe("SPAWNING");
  });
  it("RS2 a SPAWNING record that cannot be made durable stops the spawn: the exec never runs", () => {
    const fs = mem();
    configureMcpStop({ store: new StopRecordStore("/rec", fs) });
    const plan = planMcpSpawn("bot-1", { platform: "linux", cloud: false });
    fs.failNextWrite = true;
    let ran = false;
    expect(() => spawnPlanned(plan, () => { ran = true; throw new Error("x"); })).toThrow("EIO");
    expect(ran).toBe(false);
  });
  it("RS3 a record never moves back and is deleted only by delete()", () => {
    const store = new StopRecordStore("/rec", mem());
    store.plan(base());
    const running = store.advance(store.advance(base(), "SPAWNING"), "RUNNING");
    expect(() => store.advance(running, "SPAWNING")).toThrow();
    expect(store.list().records).toHaveLength(1);
    store.delete(running);
    expect(store.list().records).toHaveLength(0);
  });
  it("RS4 an unreadable record file is reported, never deleted, never silently dropped", () => {
    const fs = mem();
    fs.files.set("/rec/garbage.json", "{not json");
    fs.files.set("/rec/wrong.json", JSON.stringify({ version: 1, owner: "", generation: 1, state: "PLANNED", platform: "cloud" }));
    const listed = new StopRecordStore("/rec", fs).list();
    expect(listed.records).toHaveLength(0);
    expect(listed.corrupt.sort()).toEqual(["garbage.json", "wrong.json"]);
    expect(fs.files.size).toBe(2);
  });
  const crashCuts: Array<[string, StopRecord, ProbeOutcome[]]> = [
    ["after PLANNED, before spawn: proven by the platform rule on the planned identity", base(), [{ v: "gone" }]],
    ["after spawn, before RUNNING: SPAWNING stays unknown until a proof exists", base({ state: "SPAWNING" }), [{ v: "unknown", why: "no containment record" }, { v: "unknown", why: "x" }, { v: "gone" }]],
    ["during STOPPING, before the kill: alive until killed", base({ state: "STOPPING", cloud: { ...cloud, contained: true } }), [{ v: "alive", why: "x" }, { v: "gone" }]],
    ["after the kill, before the proof", base({ state: "STOPPING", cloud: { ...cloud, contained: true } }), [{ v: "gone" }]],
    ["after PROVEN GONE, before the delete: the surviving record is re-proved and then deleted", base({ state: "STOPPING", cloud: { ...cloud, contained: true } }), [{ v: "gone" }]],
  ];
  it.each(crashCuts)("RS5 crash %s: the restart quarantines the bot before any turn, then proves it; the bot is never admitted early and never forgotten", async (_label, record, verdicts) => {
    const fs = mem();
    new StopRecordStore("/rec", fs).plan({ ...record, state: "PLANNED" });
    if (record.state !== "PLANNED") new StopRecordStore("/rec", fs).save(record);
    // the process restarts: a fresh store over the same files, a fresh runtime
    const held: string[] = []; const released: string[] = []; const clock = manualClock(); const kills: string[] = [];
    configureMcpStop({
      store: new StopRecordStore("/rec", fs), ownerHeld: (owner) => held.push(owner), ownerReleased: (owner) => released.push(owner),
      recoveryDeps: { clock, launch: scripted(verdicts), reKill: async (rec) => { kills.push(rec.owner); } },
    });
    const result = reconcileMcpStopRecords();
    expect(result.owners).toEqual(["bot-1"]);
    expect(held, "quarantined synchronously, before reconcile returned").toEqual(["bot-1"]);
    expect(released).toEqual([]);
    expect(new StopRecordStore("/rec", fs).list().records, "the record is not forgotten").toHaveLength(1);
    await clock.run(120_000);
    await result.settled;
    expect(released).toEqual(["bot-1"]);
    expect(new StopRecordStore("/rec", fs).list().records, "deleted only after PROVEN GONE").toHaveLength(0);
    if (verdicts[0]!.v === "alive") expect(kills).toEqual(["bot-1"]);
  });
  it("RS6 any undeleted record for an owner keeps the owner quarantined: two generations, one proof releases only that one", async () => {
    const fs = mem();
    const seed = new StopRecordStore("/rec", fs);
    seed.plan(base({ generation: 1 })); seed.plan(base({ generation: 2 }));
    const held: string[] = []; const released: string[] = []; const clock = manualClock();
    configureMcpStop({
      store: new StopRecordStore("/rec", fs), ownerHeld: (_o, key) => held.push(key), ownerReleased: (_o, key) => released.push(key),
      recoveryDeps: { clock, launch: (rec) => ({ result: Promise.resolve<ProbeOutcome>(rec.generation === 1 ? { v: "gone" } : { v: "unknown", why: "x" }), kill() {}, alive: () => false, exited: Promise.resolve() }) },
    });
    reconcileMcpStopRecords();
    expect(held).toHaveLength(2);
    await clock.run(60_000);
    expect(released).toEqual(["bot-1\u00001"]);
    expect(new StopRecordStore("/rec", fs).list().records.map((r) => r.generation)).toEqual([2]);
  });
  it("RS9 nlrace4a: a corrupt or unreadable record file quarantines its owner at startup (fail closed) and is never deleted; a foreign file name holds nobody", () => {
    const fs = mem();
    const name = (owner: string, generation: number) => `${Buffer.from(owner, "utf8").toString("base64url")}.${generation}.json`;
    fs.files.set(`/rec/${name("bot-corrupt", 3)}`, "{not json");
    fs.files.set(`/rec/${name("bot-invalid", 4)}`, JSON.stringify({ version: 1, owner: "bot-invalid" }));
    fs.files.set("/rec/stray.json", "x");
    const held: string[] = [];
    configureMcpStop({ store: new StopRecordStore("/rec", fs), ownerHeld: (owner) => held.push(owner), ownerReleased: () => {} });
    const result = reconcileMcpStopRecords();
    expect(held.sort(), "quarantined synchronously, before reconcile returned").toEqual(["bot-corrupt", "bot-invalid"]);
    expect(result.corrupt).toHaveLength(3);
    expect([...fs.files.keys()], "never deleted").toHaveLength(3);
  });
  it("RS7 with no store configured nothing is reconciled and nothing throws", () => {
    expect(reconcileMcpStopRecords().owners).toEqual([]);
  });
  it("RS8 a lifecycle is PLANNED before the spawn (owner key, platform, planned identity) and its Windows facts are written before the child runs", () => {
    const fs = mem();
    const store = new StopRecordStore("/rec", fs);
    const life = McpStopLifecycle.plan({ owner: "thread-9", platform: "windows", jobName: "Local\\murage-pip-eng-aaaa" }, { store });
    expect(life.record).toMatchObject({ owner: "thread-9", platform: "windows", state: "PLANNED", windows: { jobName: "Local\\murage-pip-eng-aaaa" } });
    life.spawning();
    life.windowsCreated({ source: "live-query", killOnClose: true, breakawayClear: true, silentBreakawayClear: true, inheritable: false, queriedAt: 5, contained: false });
    expect(store.list().records[0]?.windows?.containment?.contained).toBe(false);
    life.windowsContained();
    expect(store.list().records[0]?.windows?.containment?.contained).toBe(true);
    life.running();
    expect(store.list().records[0]?.state).toBe("RUNNING");
  });
});
