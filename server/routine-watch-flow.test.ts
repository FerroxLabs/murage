import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestOptionCard } from "./routine-requests.ts";
import { createRoutineWatchFileAdapter } from "./routine-watch-file.ts";
import { listRoutineWatchFiles, routineWatchFileScope, selectRoutineWatchFile } from "./routine-watch-integration.ts";
import type { RoutineWatchSource } from "../shared/routine-watch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-watch-flow-")); roots.push(root);
  const folder = join(root, "work"); mkdirSync(folder); writeFileSync(join(folder, "status.txt"), "first");
  let currentFolder: string | undefined = folder, now = Date.parse("2026-09-10T00:00:00Z"), paused = false;
  const scope = () => routineWatchFileScope("worker", currentFolder);
  const validate = (owner: string, bot: string, source: RoutineWatchSource) => {
    if (owner !== "chief" || bot !== "worker") throw new Error("Wrong watch authority");
    const current = selectRoutineWatchFile(scope(), source.sourceId);
    if (source.scopeId !== current.scopeId) throw new Error("Scope revoked");
  };
  const adapter = createRoutineWatchFileAdapter(id => scope()?.workspaceId === id ? scope() : null);
  const startTurn = vi.fn(async () => {}), createTask = vi.fn(() => ({ threadId: "must-not-create" }));
  const projections: RoutineRun[] = [];
  const read = vi.fn(async (_owner: string, _bot: string, source: RoutineWatchSource, signal: AbortSignal) => {
    const disk = JSON.parse(readFileSync(join(root, "routines.json"), "utf8"));
    expect(disk.routines[0].watch.state.checks.at(-1).outcome).toBe("pending");
    return adapter.read(source, signal);
  });
  const options = { file: join(root, "routines.json"), now: () => now, automaticPaused: () => paused,
    botState: () => "ready" as const, createTask, startTurn, validateWatchSource: validate, readWatchSource: read,
    onRunChanged: (run: RoutineRun) => {
      if (run.watch?.outcome === "changed") {
        const disk = JSON.parse(readFileSync(join(root, "routines.json"), "utf8"));
        expect(disk.routines[0].watch.state.checks.find((item: { id: string }) => item.id === run.id).outcome).toBe("changed");
      }
      projections.push(run);
    },
  };
  let manager = new RoutineManager(options);
  const messages: RoutineRequestMessage[] = [];
  const store = {
    messagesFor: () => messages,
    appendMessage: (_thread: string, message: { card: RoutineRequestOptionCard }) => { const stored = { id: `m-${messages.length}`, card: message.card }; messages.push(stored); return stored; },
    patchMessage: (_thread: string, id: string, patch: { card: RoutineRequestOptionCard }) => { const message = messages.find(item => item.id === id); if (!message) return null; message.card = patch.card; return message; },
  };
  const service = () => new RoutineRequestService({ store, routines: manager, now: () => now, timeZone: () => "UTC",
    validateTarget: (owner, target) => owner === "chief" && target.botId === "worker" ? null : "Wrong target",
    resolveWatchSource: (owner, bot, relativePath) => { const source = selectRoutineWatchFile(scope(), relativePath); validate(owner, bot, source); return source; },
  });
  const propose = (maxChecks = 5, expiresAt = now + 86400000) => service().propose({ botId: "chief", threadId: "chief-thread", proposal: {
    action: "create", forBot: { botId: "worker", name: "Worker" }, routine: { name: "File status", instructions: "Report changes", schedule: { type: "interval", everyMinutes: 5 },
      watch: { relativePath: "status.txt", expiresAt: new Date(expiresAt).toISOString(), maxChecks } },
  } });
  const confirm = (requestId: string) => service().resolve({ botId: "chief", threadId: "chief-thread", requestId, behavior: "allow" });
  return { root, folder, scope, read, startTurn, createTask, projections, messages, propose, confirm,
    get manager() { return manager; }, service,
    advance: (ms = 300000) => { now += ms; }, setPaused: (value: boolean) => { paused = value; }, revoke: () => { currentFolder = undefined; },
    restart: () => { manager.stop(); manager = new RoutineManager(options); return manager; },
  };
}

it("requires confirmation and joins durable admission, real file changes, Chief ownership and restart dedupe", async () => {
  const f = fixture(), proposal = await f.propose();
  expect(proposal.detail).toContain("Selected file: status.txt"); expect(proposal.detail).toContain("Maximum checks: 5");
  expect(f.manager.listRoutines()).toHaveLength(0); expect(f.read).not.toHaveBeenCalled();
  expect(f.confirm(proposal.requestId).state).toBe("applied"); expect(f.confirm(proposal.requestId).state).toBe("already_settled");
  expect(f.manager.listRoutines()[0].watch?.ownerBotId).toBe("chief");
  f.advance(); await f.manager.tick(); expect(f.manager.listRuns()[0].watch?.outcome).toBe("baseline");
  f.advance(); await f.manager.tick(); expect(f.manager.listRuns()[0].watch?.outcome).toBe("unchanged");
  writeFileSync(join(f.folder, "status.txt"), "second"); f.advance(); await f.manager.tick();
  expect(f.manager.listRuns()[0].watch?.outcome).toBe("changed");
  expect(f.manager.listRuns()[0].sourceThreadId).toBe("chief-thread");
  const checks = f.read.mock.calls.length; f.restart(); await f.manager.tick(); expect(f.read).toHaveBeenCalledTimes(checks);
  f.advance(); await f.manager.tick(); expect(f.manager.listRuns()[0].watch?.outcome).toBe("unchanged");
  expect(f.startTurn).not.toHaveBeenCalled(); expect(f.createTask).not.toHaveBeenCalled();
  expect(f.manager.listRuns().every(run => run.eventBudget?.closed === true)).toBe(true);
});

it("retains usage/checkpoints across pause and restart, enforces caps on manual checks and refuses source reset", async () => {
  const f = fixture(), p = await f.propose(2); f.confirm(p.requestId); const id = f.manager.listRoutines()[0].id;
  f.advance(); await f.manager.tick(); const checkpoint = f.manager.listRoutines()[0].watch?.state.checkpoint;
  f.manager.update(id, { enabled: false }); f.advance(); await f.manager.tick(); expect(f.read).toHaveBeenCalledTimes(1);
  f.restart(); f.manager.update(id, { enabled: true }); f.advance(); await f.manager.tick();
  expect(f.manager.listRoutines()[0].watch?.state.checkpoint).toBe(checkpoint);
  expect(f.manager.listRoutines()[0].watch?.state.checks).toHaveLength(2);
  expect(() => f.manager.runNow(id)).toThrow(/limit/); expect(() => f.manager.update(id, { enabled: true })).toThrow(/limit/);
  expect(() => f.manager.update(id, { watch: { source: { adapterId: "file", sourceId: "status.txt", scopeId: f.scope()!.workspaceId }, expiresAt: Date.now() + 100000, maxChecks: 999 } })).toThrow(/new file watch/);
  expect(f.startTurn).not.toHaveBeenCalled();
});

it("lets the proposing Chief confirm pause and resume for a watch of another bot's file", async () => {
  const f = fixture(), p = await f.propose(); f.confirm(p.requestId); const id = f.manager.listRoutines()[0].id;
  for (const action of ["pause", "resume"] as const) {
    const proposed = await f.service().propose({ botId: "chief", threadId: "chief-thread", proposal: { action, routineId: id } });
    expect(f.confirm(proposed.requestId).state).toBe("applied");
    expect(f.manager.listRoutines()[0].enabled).toBe(action === "resume");
  }
  await expect(f.service().propose({ botId: "worker", threadId: "worker-thread", proposal: { action: "pause", routineId: id } })).rejects.toThrow(/does not exist/);
});

it("global automatic pause and expiry prevent scheduled reads; revocation before confirmation prevents creation", async () => {
  const f = fixture(), p = await f.propose(10, Date.parse("2026-09-10T00:12:00Z")); f.confirm(p.requestId);
  f.setPaused(true); f.advance(); await f.manager.tick(); expect(f.read).not.toHaveBeenCalled();
  f.setPaused(false); await f.manager.tick(); expect(f.read).toHaveBeenCalledTimes(1);
  f.advance(8 * 60000); await f.manager.tick(); expect(f.read).toHaveBeenCalledTimes(1); expect(f.manager.listRoutines()[0].enabled).toBe(false);
  const other = fixture(), pending = await other.propose(); other.revoke(); expect(other.confirm(pending.requestId).state).toBe("invalid"); expect(other.manager.listRoutines()).toHaveLength(0);
});

it("charges failed reads while preserving the checkpoint and never dispatches a provider after source revocation", async () => {
  const f = fixture(), p = await f.propose(); f.confirm(p.requestId); f.advance(); await f.manager.tick();
  const baseline = f.manager.listRoutines()[0].watch?.state.checkpoint;
  f.revoke(); f.advance(); await f.manager.tick();
  expect(f.manager.listRuns()[0].watch?.outcome).toBe("failed");
  expect(f.manager.listRoutines()[0].watch?.state.checkpoint).toBe(baseline);
  expect(f.manager.listRoutines()[0].watch?.state.checks).toHaveLength(2); expect(f.startTurn).not.toHaveBeenCalled();
});

it("fences an in-flight result on pause and abandons restart reservations without resetting the cap", async () => {
  const f = fixture(), p = await f.propose(); f.confirm(p.requestId); const id = f.manager.listRoutines()[0].id;
  let release: (() => void) | undefined;
  f.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { fingerprint: "a".repeat(64) }; });
  f.advance(); const ticking = f.manager.tick(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.manager.update(id, { enabled: false }); release!(); await ticking;
  expect(f.manager.listRuns()[0].status).toBe("cancelled"); expect(f.manager.listRoutines()[0].watch?.state.checkpoint).toBeUndefined();
  f.manager.update(id, { enabled: true });
  f.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { fingerprint: "b".repeat(64) }; });
  release = undefined; f.advance(); const oldManager = f.manager, pending = oldManager.tick(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const stranded = readFileSync(join(f.root, "routines.json"));
  oldManager.stop(); release!(); await pending;
  // A real restart cannot leave an old process writing the same state file.
  // Restore the exact durable in-flight snapshot only after that writer ends.
  writeFileSync(join(f.root, "routines.json"), stranded); f.restart();
  expect(f.manager.listRoutines()[0].watch?.state.checks.map(check => check.outcome)).toEqual(["abandoned", "abandoned"]);
  expect(f.manager.listRoutines()[0].watch?.state.checkpoint).toBeUndefined(); expect(f.startTurn).not.toHaveBeenCalled();
});

it("never reads before a failed atomic reservation save and never publishes a failed completion save", async () => {
  const f = fixture(), p = await f.propose(); f.confirm(p.requestId);
  const file = join(f.root, "routines.json"), preserved = join(f.root, "preserved-routines.json");
  f.advance(); renameSync(file, preserved); mkdirSync(file);
  await expect(f.manager.tick()).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  rmSync(file, { recursive: true }); renameSync(preserved, file);
  f.restart(); await f.manager.tick(); writeFileSync(join(f.folder, "status.txt"), "changed");
  const normalRead = f.read.getMockImplementation()!;
  f.read.mockImplementationOnce(async (...args) => { const result = await normalRead(...args); renameSync(file, preserved); mkdirSync(file); return result; });
  f.advance(); await expect(f.manager.tick()).rejects.toThrow();
  expect(f.projections.some(run => run.watch?.outcome === "changed")).toBe(false);
  rmSync(file, { recursive: true }); renameSync(preserved, file);
});

it("lists only bounded safe sources and refuses missing working folders or absolute paths", () => {
  const f = fixture(); writeFileSync(join(f.folder, "secret-token.txt"), "never list"); mkdirSync(join(f.folder, "reports"));
  expect(listRoutineWatchFiles(f.scope()).entries.map(entry => entry.name)).toEqual(["reports", "status.txt"]);
  expect(() => selectRoutineWatchFile(f.scope(), join(f.folder, "status.txt"))).toThrow();
  expect(() => selectRoutineWatchFile(f.scope(), "../status.txt")).toThrow();
  f.revoke(); expect(() => listRoutineWatchFiles(f.scope())).toThrow(/existing working folder/);
});

it("keeps malformed saved watch runs out of ordinary provider dispatch", async () => {
  const f = fixture(), p = await f.propose(); f.confirm(p.requestId);
  const file = join(f.root, "routines.json"), disk = JSON.parse(readFileSync(file, "utf8"));
  const routine = f.manager.listRoutines()[0];
  disk.runs = [{ id: "corrupt-run", routineId: routine.id, routineName: routine.name, botId: "worker", target: "bot", runOn: "ember", scheduledFor: routine.createdAt, createdAt: routine.createdAt, manual: true, status: "queued" }];
  writeFileSync(file, JSON.stringify(disk));
  f.restart(); await f.manager.tick(); expect(f.startTurn).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  expect(f.manager.listRuns()[0].status).toBe("failed");
});
