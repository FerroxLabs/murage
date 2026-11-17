// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RoutineRequestCommit, Routine, RoutineRun } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const fault = vi.hoisted(() => ({ syncFailures: 0, torn: false, paths: new Map<number, string>() }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const wrapped = { ...real,
    openSync: ((path: unknown, ...args: unknown[]) => { const fd = (real.openSync as (...args: unknown[]) => number)(path, ...args); fault.paths.set(fd, String(path)); return fd; }) as typeof real.openSync,
    closeSync: ((fd: number) => { fault.paths.delete(fd); real.closeSync(fd); }) as typeof real.closeSync,
    fsyncSync: ((fd: number) => { real.fsyncSync(fd); if (fault.paths.get(fd)?.endsWith(".jsonl") && fault.syncFailures > 0) { fault.syncFailures--; throw new Error("proposal fsync fault"); } }) as typeof real.fsyncSync,
  }; return { ...wrapped, default: wrapped };
});
vi.mock("./counted-fs.ts", async original => {
  const real = await original<typeof import("./counted-fs.ts")>();
  const { writeJournalPrefix } = await import("./testing/journal-write-fixture.ts");
  return { ...real, writeSync: (...args: unknown[]) => {
    if (fault.torn && fault.paths.get(args[0] as number)?.endsWith(".jsonl")) {
      fault.torn = false; writeJournalPrefix(real.writeSync, args, 37); throw new Error("proposal torn fault");
    }
    return Reflect.apply(real.writeSync, undefined, args);
  } };
});
const { RoutineManager, RecoveryRequired } = await import("./routines.ts");
const { readRoutinesWithRuns } = await import("./routine-runs-journal.ts");
const roots: string[] = [], managers: InstanceType<typeof RoutineManager>[] = [];
afterEach(() => { fault.syncFailures = 0; fault.torn = false; vi.restoreAllMocks(); managers.splice(0).forEach(m => m.stop()); roots.splice(0).forEach(root => removeTempDirSync(root)); });
const NOW = 1_800_000_000_000;
const input = { name: "Fake", prompt: "Fake only", botId: "bot", enabled: false, schedule: { type: "interval" as const, everyMinutes: 5, anchorAt: NOW } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-proposal-crash-")); roots.push(root);
  const emitted = vi.fn(), options = { file: join(root, "routines.json"), now: () => NOW, dispatchOpen: () => false, botState: () => "busy" as const, createTask: () => null, startTurn: async () => {}, emit: emitted };
  const m = new RoutineManager(options); managers.push(m); const routine = m.create(input); emitted.mockClear();
  return { m, routine, emitted, file: options.file, reload: () => { const m = new RoutineManager(options); managers.push(m); return m; } };
}
function request(action: RoutineRequestCommit["action"]): RoutineRequestCommit { return { requestId: action, messageId: "card", botId: "bot", threadId: "thread", action, fingerprintVersion: 1, fingerprint: "a".repeat(64) }; }
for (const boundary of ["intent", "create", "update", "delete", "run_now", "result", "cleanup"] as const) for (const mode of ["torn", "fsync"] as const) it(`P35 ${boundary} ${mode}: reconciliation is durable before returning failure`, () => {
  const f = fixture(), action = ["intent", "result", "cleanup"].includes(boundary) ? "create" : boundary as RoutineRequestCommit["action"], commit = request(action);
  if (boundary !== "intent") f.m.beginRoutineRequest(commit, { before: { absent: true }, routineId: boundary === "create" ? undefined : f.routine.id, ...(boundary === "result" || boundary === "cleanup" ? { kind: "webhook" as const } : {}) });
  if (boundary === "cleanup") f.m.completeRoutineRequest(commit, "hook", NOW);
  const inside = f.m as unknown as { routines: Routine[]; runStore: Set<RoutineRun> };
  const canonical = inside.routines.find(r => r.id === f.routine.id), beforeRuns = inside.runStore.size;
  if (mode === "torn") fault.torn = true; else fault.syncFailures = 1;
  expect(() => {
    if (boundary === "intent") f.m.beginRoutineRequest(commit, { before: { absent: true } });
    if (boundary === "create") f.m.create(input, commit as never);
    if (boundary === "update") f.m.update(f.routine.id, { name: "Changed" }, commit as never);
    if (boundary === "delete") f.m.remove(f.routine.id, commit as never);
    if (boundary === "run_now") f.m.runNow(f.routine.id, commit as never);
    if (boundary === "result") f.m.completeRoutineRequest(commit, "hook", NOW);
    if (boundary === "cleanup") f.m.forgetRoutineRequestReceipt(commit);
  }).toThrow(mode === "torn" ? "write" : "fsync");
  expect(inside.routines.find(r => r.id === f.routine.id)).toBe(canonical); expect(canonical?.name).toBe("Fake"); expect(inside.runStore.size).toBe(beforeRuns); expect(f.emitted).not.toHaveBeenCalled();
  const raw = readRoutinesWithRuns(f.file); expect(raw.routines).toHaveLength(1); expect(raw.runs).toHaveLength(0);
  const receipt = f.reload().routineRequestReceipt(action);
  if (boundary === "intent") expect(receipt).toBeNull();
  else if (boundary === "cleanup") expect(receipt?.resultId).toBe("hook");
  else { expect(receipt).not.toBeNull(); expect(receipt?.resultId).toBeUndefined(); }
});
it("P35 failed append and reconciliation quarantine the run until lifecycle durability", () => {
  const f = fixture(), commit = request("run_now"); f.m.beginRoutineRequest(commit, { before: null, routineId: f.routine.id });
  fault.syncFailures = 2; expect(() => f.m.runNow(f.routine.id, commit as never)).toThrow("fsync");
  expect(f.m.hasLiveRuns()).toBe(false); expect(() => f.m.beginRoutineRequest(request("update"), { before: null })).toThrow(RecoveryRequired);
  f.m.recoverPersistence(); const again = f.reload(); expect(again.listRuns()).toHaveLength(0); expect(again.routineRequestReceipt("run_now")?.resultId).toBeUndefined();
});
const childSource = `
import {join} from 'node:path';
const [root, mode, moduleUrl] = process.argv.slice(1); const {RoutineManager} = await import(moduleUrl);
const now=1800000000000, m=new RoutineManager({file:join(root,'routines.json'), now:()=>now, dispatchOpen:()=>false, botState:()=> 'busy',createTask:()=>null,startTurn:async()=>{}});
const input={name:'Fake',prompt:'Fake',botId:'bot',enabled:false,schedule:{type:'interval',everyMinutes:5,anchorAt:now}};
const request={requestId:'create',messageId:'card',botId:'bot',threadId:'thread',action:'create',fingerprintVersion:1,fingerprint:'a'.repeat(64)};
m.beginRoutineRequest(request,{before:{absent:true}});
const real=m.journal.proposal.bind(m.journal);m.journal.proposal=input=>{real(input);process.exit(66)};
m.create(input,request);throw Error('crash boundary missed');`;
it("P35 process loss after action fsync exposes definition and result together and duplicate retry creates nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-proposal-process-")); roots.push(root);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childSource, root, "action", new URL("./routines.ts", import.meta.url).href], { encoding: "utf8", timeout: 30000 });
  expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(66);
  const file = join(root, "routines.json"), raw = readRoutinesWithRuns(file), receipt = raw.routineRequestReceipts.find((r: { requestId: string }) => r.requestId === "create");
  expect(raw.routines).toHaveLength(1); expect(receipt.resultId).toBe(raw.routines[0].id);
  const m = new RoutineManager({ file, now: () => NOW, dispatchOpen: () => false, botState: () => "busy", createTask: () => null, startTurn: async () => {} }); managers.push(m);
  expect(m.create(input, request("create") as never).id).toBe(receipt.resultId); expect(m.listRoutines()).toHaveLength(1);
});
