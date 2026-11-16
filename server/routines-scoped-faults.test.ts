// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutineRun, Routine, RoutineManagerOptions } from "./routines.ts";
import { plainCopy } from "./tracked-state.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const fault = vi.hoisted(() => ({ syncFailures: 0, openFailures: 0, mkdirFailures: 0, torn: false, paths: new Map<number, string>(), order: [] as string[] }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const wrapped = {
    ...real,
    openSync: ((path: unknown, ...args: unknown[]) => {
      if (fault.openFailures && String(path).endsWith(".jsonl")) { fault.openFailures--; throw new Error("injected first open"); }
      const fd = (real.openSync as (...args: unknown[]) => number)(path, ...args); fault.paths.set(fd, String(path)); return fd; }) as typeof real.openSync,
    mkdirSync: ((path: unknown, ...args: unknown[]) => {
      if (fault.mkdirFailures && String(path).endsWith("routine-runs")) { fault.mkdirFailures--; throw new Error("injected first mkdir"); }
      return (real.mkdirSync as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof real.mkdirSync,
    closeSync: ((fd: number) => { fault.paths.delete(fd); real.closeSync(fd); }) as typeof real.closeSync,
    fsyncSync: ((fd: number) => {
      real.fsyncSync(fd);
      if (fault.paths.get(fd)?.endsWith(".jsonl")) {
        fault.order.push("journal-fsync");
        if (fault.syncFailures > 0) { fault.syncFailures--; throw new Error("injected journal fsync"); }
      }
    }) as typeof real.fsyncSync,
  };
  return { ...wrapped, default: wrapped };
});
// MAIN RULING INT-CONFLICT-DEFAULT (c4-misc-d application, "Routine write fault fixtures"): the counted-fs pristine native capture
// bypasses node:fs writeSync mocks, so the torn injection moves to the real counted write entry and still writes the physical prefix.
vi.mock("./counted-fs.ts", async original => {
  const counted = await original<typeof import("./counted-fs.ts")>();
  const { writeJournalPrefix } = await import("./testing/journal-write-fixture.ts");
  return { ...counted, writeSync: (...args: unknown[]) => {
    if (fault.torn && fault.paths.get(args[0] as number)?.endsWith(".jsonl")) {
      fault.torn = false;
      const data = args[1], size = typeof data === "string" ? Buffer.byteLength(data) : (data as Uint8Array).byteLength;
      writeJournalPrefix(counted.writeSync, args, Math.min(size - 1, 97)); throw new Error("injected torn write");
    }
    return (counted.writeSync as (...values: unknown[]) => number)(...args);
  } };
});
const { RoutineManager, routineWorkCounters, RecoveryRequired } = await import("./routines.ts");
const { readRoutinesWithRuns, routineRunsDir, routineRunsFileName } = await import("./routine-runs-journal.ts");
const roots: string[] = [], managers: InstanceType<typeof RoutineManager>[] = [];
const NOW = Date.UTC(2026, 10, 2, 8);
type Internal = {
  runStore: Set<RoutineRun>; runsGeneration: number; routines: Routine[]; indexes: { runsById: Map<string, RoutineRun> };
  unsavedStartTasks: Map<string, string>; watchReads: Map<string, AbortController>; rollbackPending: Set<RoutineRun>;
  journal: { append(input: unknown): number }; save(options?: object): void;
  saveFull(): void; maintenance: { getStore(): unknown };
  commitScoped(scope: { runs?: RoutineRun[]; routines?: Routine[]; append?: RoutineRun }, change: () => void): void;
};
const inside = (m: InstanceType<typeof RoutineManager>) => m as unknown as Internal;
afterEach(() => {
  fault.syncFailures = 0; fault.openFailures = 0; fault.mkdirFailures = 0; fault.torn = false; fault.order.length = 0; vi.restoreAllMocks();
  for (const m of managers.splice(0)) m.stop();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
function fixture(extra: Partial<RoutineManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "s4-fault-")); roots.push(root);
  let now = NOW, task = 0;
  const terminal = vi.fn(), createTask = vi.fn(() => ({ threadId: `thread-${++task}` }));
  const options: RoutineManagerOptions = { file: join(root, "routines.json"), now: () => now, botState: () => "ready", createTask,
    startTurn: async () => {}, interruptTurn: async () => {}, onRoutineRunTerminal: terminal, ...extra };
  const m = new RoutineManager(options); managers.push(m);
  return { root, m, options, terminal, createTask, advance: () => { now += 300000; } };
}
function definition(m: InstanceType<typeof RoutineManager>) {
  return m.create({ name: "Fake", prompt: "Fake", botId: "bot", enabled: false, schedule: { type: "interval", everyMinutes: 5, anchorAt: NOW + 300000 } });
}
async function running() {
  const f = fixture(), r = definition(f.m), queued = f.m.runNow(r.id)!;
  await f.m.tick(); await Promise.resolve();
  return { ...f, run: inside(f.m).indexes.runsById.get(queued.id)! };
}

describe("A4 bounded rollback and crash boundaries", () => {
  for (const kind of ["throw", "torn", "fsync"] as const) it(`P14/P18 C2/C4/C5 cancel ${kind}: canonical identity and terminal maps survive rollback`, async () => {
    const f = await running(), i = inside(f.m), original = f.run, snapshot = plainCopy(original), generation = i.runsGeneration;
    const beforeTerminal = f.terminal.mock.calls.length;
    if (kind === "throw") {
      expect(() => i.commitScoped({ runs: [original] }, () => { original.status = "cancelled"; throw new Error("injected mutate"); })).toThrow("injected mutate");
    } else {
      if (kind === "torn") fault.torn = true; else fault.syncFailures = 1;
      await expect(f.m.cancelRun(original.id)).rejects.toThrow(kind === "torn" ? "write" : "fsync");
    }
    expect(i.indexes.runsById.get(original.id)).toBe(original); expect(i.runsGeneration).toBe(generation);
    expect(plainCopy(original)).toEqual(snapshot); expect(f.terminal).toHaveBeenCalledTimes(beforeTerminal);
    const raw = readRoutinesWithRuns(f.options.file!);
    expect(raw.runs.find((run: RoutineRun) => run.id === original.id).status).toBe(snapshot.status);
    expect(f.m.verifyRunIndexes()).toEqual([]);
  });
  for (const failCount of [1, 2]) it(`P18 C5/C12: failed append reconciles a durable tombstone before removing membership (${failCount} failing fsyncs)`, async () => {
    const f = fixture({ dispatchOpen: () => false }), i = inside(f.m), generation = i.runsGeneration;
    let id: string | undefined;
    const realAppend = i.journal.append.bind(i.journal);
    vi.spyOn(i.journal, "append").mockImplementation(input => { const typed = input as { runs: RoutineRun[] }; if (typed.runs[0]) id ??= typed.runs[0].id; return realAppend(input); });
    fault.syncFailures = failCount;
    expect(() => f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Fake", deliveryId: "one", prompt: "Fake", botId: "bot", runOn: "ember", receivedAt: NOW })).toThrow("fsync");
    expect(i.runsGeneration).toBe(generation); expect(id).toBeDefined(); expect(f.m.runById(id!)).toBeNull();
    if (failCount === 2) { expect(i.runStore.size).toBe(1); expect(i.rollbackPending.size).toBe(1); }
    else { expect(i.runStore.size).toBe(0); expect(readRoutinesWithRuns(f.options.file!).runs).toHaveLength(0); }
    await f.m.tick(); expect(f.m.hasLiveRuns()).toBe(false);
    expect(() => definition(f.m), "Owner full transactions must not publish quarantined appends").toThrow(RecoveryRequired);
    expect(() => f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Fake", deliveryId: "two", prompt: "Fake", botId: "bot", runOn: "ember", receivedAt: NOW })).toThrow(RecoveryRequired);
    f.m.recoverPersistence();
    expect(i.runStore.size).toBe(0); expect(i.rollbackPending.size).toBe(0); expect(readRoutinesWithRuns(f.options.file!).runs).toHaveLength(0);
    const reloaded = new RoutineManager(f.options); managers.push(reloaded); expect(reloaded.listRuns()).toHaveLength(0);
  });
  for (const failCount of [1, 2]) it(`owner push reconciles a batch after ${failCount} failing fsyncs`, async () => {
    const f = await running(), i = inside(f.m), rows = f.m.runs, size = rows.length;
    const additions = ["owner-add-one", "owner-add-two"].map(id => ({ ...plainCopy(f.run), id }));
    fault.syncFailures = failCount;
    expect(() => rows.push(...additions)).toThrow("fsync");
    expect(rows).toHaveLength(size);
    for (const run of additions) expect(f.m.runById(run.id)).toBeNull();
    expect(i.runStore.size).toBe(size + (failCount === 2 ? additions.length : 0));
    expect(i.rollbackPending.size).toBe(failCount === 2 ? additions.length : 0);
    expect(f.m.verifyRunIndexes()).toEqual([]);
    f.m.recoverPersistence();
    expect(i.rollbackPending.size).toBe(0); expect(i.runStore.size).toBe(size);
    const reloaded = new RoutineManager(f.options); managers.push(reloaded);
    for (const run of additions) expect(reloaded.runById(run.id)).toBeNull();
    expect(f.m.runs.push(...additions)).toBe(size + additions.length);
    expect(readRoutinesWithRuns(f.options.file!).runs.map((run: RoutineRun) => run.id)).toEqual(expect.arrayContaining(additions.map(run => run.id)));
  });
  it("owner push rejects duplicates within a batch before any write or membership change", async () => {
    const f = await running(), i = inside(f.m), rows = f.m.runs, snapshot = f.m.listRuns();
    const append = vi.spyOn(i.journal, "append"), donor = plainCopy(f.run);
    expect(() => rows.push({ ...donor, id: "owner-duplicate" }, { ...donor, id: "owner-duplicate" })).toThrow("Append ID is already present");
    expect(append).not.toHaveBeenCalled(); expect(f.m.listRuns()).toEqual(snapshot);
    expect(rows.push()).toBe(snapshot.length); expect(append).not.toHaveBeenCalled();
    expect(f.m.verifyRunIndexes()).toEqual([]);
  });
  it("P14: failed start retains its real task through failed cancel and reuses it after lifecycle recovery", async () => {
    const f = fixture(), routine = definition(f.m), i = inside(f.m);
    const queued = f.m.runNow(routine.id)!;
    // Let the run-start append fail; failRun is a separate policy, so keep the queued receipt exactly as that catch restored it.
    const realAppend = i.journal.append.bind(i.journal);
    const diskFull = vi.spyOn(i.journal, "append").mockImplementation(input => {
      const rows = (input as { runs: RoutineRun[] }).runs;
      if (rows.some(run => run.status === "running")) throw Object.assign(new Error("database busy"), { errcode: 5 });
      return realAppend(input);
    });
    await f.m.tick(); await Promise.resolve(); diskFull.mockRestore();
    const run = i.indexes.runsById.get(queued.id)!;
    expect(run.status).toBe("queued"); const task = i.unsavedStartTasks.get(run.id); expect(task).toBeDefined();
    f.m.recoverPersistence();
    fault.syncFailures = 1;
    await expect(f.m.cancelRun(run.id)).rejects.toThrow("fsync");
    expect(i.unsavedStartTasks.get(run.id)).toBe(task); expect(i.indexes.runsById.get(run.id)).toBe(run);
    f.m.recoverPersistence(); const created = f.createTask.mock.calls.length;
    await f.m.tick(); expect(f.createTask).toHaveBeenCalledTimes(created); expect(run.threadId).toBe(task); expect(run.status).toBe("running");
  });
  it("P14/P11: a watched cancellation scopes both canonical records and aborts only after durable success", async () => {
    let release!: () => void;
    const read = vi.fn(async (_owner: string, _bot: string, _source: unknown, signal: AbortSignal) => new Promise<{ fingerprint: string }>(resolve => {
      release = () => resolve({ fingerprint: "a".repeat(64) });
      signal.addEventListener("abort", () => { fault.order.push("abort"); release(); });
    }));
    const f = fixture({ validateWatchSource: () => {}, readWatchSource: read });
    const routine = f.m.create({ name: "Watch", prompt: "Fake", botId: "bot", enabled: true, schedule: { type: "interval", everyMinutes: 5, anchorAt: NOW + 300000 },
      watch: { source: { adapterId: "file", sourceId: "fixture", scopeId: "c".repeat(64) }, expiresAt: NOW + 86400000, maxChecks: 5 } },
      { requestId: "watch-request", messageId: "fixture", botId: "owner", threadId: "owner-thread", action: "create", fingerprintVersion: 1, fingerprint: "b".repeat(64) });
    f.advance(); const tick = f.m.tick(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const i = inside(f.m), run = [...i.runStore][0]!, current = i.routines.find(r => r.id === routine.id)!, controller = i.watchReads.get(routine.id)!;
    const beforeRun = plainCopy(run), beforeRoutine = plainCopy(current);
    fault.order.length = 0; fault.syncFailures = 1;
    await expect(f.m.cancelRun(run.id)).rejects.toThrow("fsync");
    expect(i.indexes.runsById.get(run.id)).toBe(run); expect(i.routines.find(r => r.id === routine.id)).toBe(current);
    expect(plainCopy(run)).toEqual(beforeRun); expect(plainCopy(current)).toEqual(beforeRoutine);
    expect(i.watchReads.get(routine.id)).toBe(controller); expect(controller.signal.aborted).toBe(false); expect(fault.order).not.toContain("abort");
    const raw = readRoutinesWithRuns(f.options.file!);
    expect(raw.routines.find((r: Routine) => r.id === routine.id).watch).toEqual(beforeRoutine.watch);
    expect(raw.runs.find((r: RoutineRun) => r.id === run.id).status).toBe("running");
    f.m.recoverPersistence(); fault.order.length = 0;
    await f.m.cancelRun(run.id); await tick;
    expect(fault.order.indexOf("journal-fsync")).toBeLessThan(fault.order.indexOf("abort"));
    expect(controller.signal.aborted).toBe(true); expect(run.status).toBe("cancelled");
    expect(f.m.verifyIndexes()).toEqual([]);
  });
  it("P18 C1/C2: mutate failure never attempts IO or changes generation", async () => {
    const f = await running(), i = inside(f.m), append = vi.spyOn(i.journal, "append");
    const generation = i.runsGeneration;
    expect(() => i.commitScoped({ runs: [f.run] }, () => { f.run.error = "temporary"; throw new Error("ordinary mutation failure"); })).toThrow("ordinary mutation failure");
    expect(append).toHaveBeenCalledTimes(0); expect(i.runsGeneration).toBe(generation); expect(f.run.error).toBeUndefined();
    expect(routineWorkCounters.fullVerifiers).toBeGreaterThanOrEqual(0);
  });
});

it("P14 successful watched cancellation commits both records without a scope escape", async () => {
  let release!: () => void;
  const read = vi.fn(async (_owner: string, _bot: string, _source: unknown, signal: AbortSignal) => new Promise<{ fingerprint: string }>(resolve => {
    release = () => resolve({ fingerprint: "a".repeat(64) }); signal.addEventListener("abort", release);
  }));
  const f = fixture({ validateWatchSource: () => {}, readWatchSource: read });
  const routine = f.m.create({ name: "Watch", prompt: "Fake", botId: "bot", schedule: { type: "interval", everyMinutes: 5, anchorAt: NOW + 300000 },
    watch: { source: { adapterId: "file", sourceId: "fixture", scopeId: "c".repeat(64) }, expiresAt: NOW + 86400000, maxChecks: 5 } },
    { requestId: "watch-request", messageId: "fixture", botId: "owner", threadId: "owner-thread", action: "create", fingerprintVersion: 1, fingerprint: "b".repeat(64) });
  f.advance(); const tick = f.m.tick(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const run = [...inside(f.m).runStore][0]!;
  await expect(f.m.cancelRun(run.id)).resolves.toMatchObject({ id: run.id, status: "cancelled" }); await tick;
  const raw = readRoutinesWithRuns(f.options.file!);
  expect(raw.runs.find((r: RoutineRun) => r.id === run.id).status).toBe("cancelled");
  expect(raw.routines.find((r: Routine) => r.id === routine.id).watch.state.checks[0].outcome).toBe("abandoned");
});
it("P18 recovery is requested outside the initiating tick/turn and resumes after the lifecycle barrier", async () => {
  const f = await running(), i = inside(f.m), run = f.run;
  const real = i.saveFull.bind(i);
  const recovery = vi.spyOn(i, "saveFull").mockImplementation(() => {
    expect(i.maintenance.getStore(), "full recovery inherited a tick/turn token").toBeUndefined(); real();
  });
  fault.syncFailures = 1;
  await expect(f.m.cancelRun(run.id)).rejects.toThrow("fsync");
  expect(recovery).toHaveBeenCalledTimes(0); expect(f.m.schedulerStatus().stalled).toBe(true);
  expect(i.indexes.runsById.get(run.id)).toBe(run); expect(run.status).toBe("running");
  await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 50 });
  expect(f.m.schedulerStatus().stalled).toBe(false); expect(f.m.verifyIndexes()).toEqual([]);
});
for (const stage of ["open", "mkdir"] as const) it(`P18 C3 first-file ${stage} failure reconciles deletion without publishing or dispatching the append`, () => {
  const f = fixture({ dispatchOpen: () => false }), i = inside(f.m);
  if (stage === "open") fault.openFailures = 1; else fault.mkdirFailures = 1;
  expect(() => f.m.enqueueWebhook({ webhookId: "first-file", webhookName: "Fake", deliveryId: "one", prompt: "Fake", botId: "bot", runOn: "ember", receivedAt: NOW })).toThrow(stage);
  expect(i.runStore.size).toBe(0); expect(f.terminal).toHaveBeenCalledTimes(0);
  expect(readRoutinesWithRuns(f.options.file!).runs).toHaveLength(0); expect(f.m.hasLiveRuns()).toBe(false);
});

const crashSource = String.raw`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [root, mode, moduleUrl] = process.argv.slice(1);
const paths = new Map(); let armed = false;
const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
fs.openSync = function(path, ...args) { const fd = open(path, ...args); paths.set(fd, String(path)); return fd; };
fs.closeSync = function(fd) { paths.delete(fd); return close(fd); };
fs.fsyncSync = function(fd) {
  sync(fd);
  if (!armed || !paths.get(fd)?.endsWith('.jsonl')) return;
  if (mode.startsWith('C7')) throw new Error('injected post-fsync uncertainty');
  process.exit(66); // complete fsync, before the scoped writer or manager returns
};
syncBuiltinESMExports();
const { RoutineManager } = await import(moduleUrl);
const now = Date.UTC(2026, 10, 2, 8);
const m = new RoutineManager({ file: join(root, 'routines.json'), now: () => now, dispatchOpen: () => false,
  botState: () => 'ready', createTask: () => ({ threadId: 'fake' }), startTurn: async () => {},
  validateWatchSource: () => {}, readWatchSource: async () => ({ fingerprint: 'a'.repeat(64) }) });
if (mode.startsWith('C7')) {
  const append = m.journal.append.bind(m.journal);
  m.journal.append = input => {
    if (mode === 'C7-append') fs.writeFileSync(join(root, 'scope.json'), JSON.stringify({ id: input.runs[0]?.id }));
    try { return append(input); } catch { process.exit(67); } // no manager reconciliation ran
  };
}
if (mode === 'C7-append') {
  armed = true;
  m.enqueueWebhook({ webhookId: 'hook', webhookName: 'Fake', deliveryId: 'one', prompt: 'Fake', botId: 'bot', runOn: 'ember', receivedAt: now });
} else {
  const input = { name: 'Fake', prompt: 'Fake', botId: 'bot', enabled: false, schedule: { type: 'interval', everyMinutes: 5, anchorAt: now + 300000 } };
  if (mode === 'C8') input.enabled = true;
  if (mode === 'C8') input.watch = { source: { adapterId: 'file', sourceId: 'fixture', scopeId: 'c'.repeat(64) }, expiresAt: now + 86400000, maxChecks: 5 };
  const request = mode === 'C8' ? { requestId: 'watch-request', messageId: 'fixture', botId: 'owner', threadId: 'owner-thread', action: 'create', fingerprintVersion: 1, fingerprint: 'b'.repeat(64) } : undefined;
  const definition = m.create(input, request), queued = m.runNow(definition.id);
  const run = m.indexes.runsById.get(queued.id), routine = m.routines.find(r => r.id === definition.id);
  fs.writeFileSync(join(root, 'scope.json'), JSON.stringify({ id: run.id, routineId: routine.id }));
  armed = true;
  m.commitScoped({ runs: [run], routines: mode === 'C8' ? [routine] : [] }, () => {
    if (mode === 'C8') { routine.watch.state.paused = true; run.status = 'cancelled'; run.watch.outcome = 'abandoned'; run.finishedAt = now; }
    else { run.status = 'needs-you'; run.needsYouAt = now; }
  });
}
throw new Error('crash boundary was not reached');
`;
function crashFixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "s4-process-crash-")); roots.push(root);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", crashSource, root, mode, new URL("./routines.ts", import.meta.url).href], { encoding: "utf8", timeout: 30000 });
  expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(mode.startsWith("C7") ? 67 : 66);
  const info = JSON.parse(readFileSync(join(root, "scope.json"), "utf8")) as { id: string; routineId: string };
  return { root, file: join(root, "routines.json"), info };
}
it("P18 C6 process loss after scope fsync exposes durable needs-you, then constructor restart recovery", () => {
  const f = crashFixture("C6");
  expect(readRoutinesWithRuns(f.file).runs.find((r: RoutineRun) => r.id === f.info.id).status).toBe("needs-you");
  const reloaded = new RoutineManager({ file: f.file, now: () => NOW, dispatchOpen: () => false, botState: () => "ready", createTask: () => ({ threadId: "fake" }), startTurn: async () => {} }); managers.push(reloaded);
  expect(reloaded.runById(f.info.id)?.status).toBe("failed"); expect(reloaded.runById(f.info.id)?.error).toMatch(/restarted/);
});
for (const mode of ["C7", "C7-append"]) it(`P18 ${mode} process loss before reconciliation keeps the documented uncertainty window`, () => {
  const f = crashFixture(mode), raw = readRoutinesWithRuns(f.file);
  const run = raw.runs.find((r: RoutineRun) => r.id === f.info.id);
  expect(run).toBeDefined();
  expect(mode === "C7-append" ? ["queued"] : ["queued", "needs-you"]).toContain(run.status);
});
it("P18 C8 a scoped watch pair shares one atomic line; tags gate both parts and generation gates the definition", () => {
  const f = crashFixture("C8"), path = join(routineRunsDir(f.root), routineRunsFileName(f.info.routineId));
  const original = readFileSync(path, "utf8"), rows = original.trimEnd().split("\n"), last = JSON.parse(rows.at(-1)!);
  expect(last.$routine.id).toBe(f.info.routineId); expect(last.$runs[0].id).toBe(f.info.id);
  let raw = readRoutinesWithRuns(f.file);
  expect(raw.routines[0].watch.state.paused).toBe(true); expect(raw.runs.find((r: RoutineRun) => r.id === f.info.id).status).toBe("cancelled");
  const prefix = rows.slice(0, -1).join("\n") + "\n", tail = rows.at(-1)!;
  writeFileSync(path, prefix + tail.slice(0, Math.floor(tail.length / 2)));
  raw = readRoutinesWithRuns(f.file); expect(raw.routines[0].watch.state.paused).toBe(false); expect(raw.runs.find((r: RoutineRun) => r.id === f.info.id).status).toBe("queued");
  const disk = JSON.parse(readFileSync(f.file, "utf8"));
  writeFileSync(path, prefix + JSON.stringify({ ...last, $c: disk.runsCommit + 1 }) + "\n");
  raw = readRoutinesWithRuns(f.file); expect(raw.routines[0].watch.state.paused).toBe(false); expect(raw.runs.find((r: RoutineRun) => r.id === f.info.id).status).toBe("queued");
  writeFileSync(path, prefix + JSON.stringify({ ...last, $gen: "other-generation" }) + "\n");
  raw = readRoutinesWithRuns(f.file); expect(raw.routines[0].watch.state.paused).toBe(false); expect(raw.runs.find((r: RoutineRun) => r.id === f.info.id).status).toBe("cancelled");
});
