// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, routineWorkCounters, type RoutineRequestCommit, type RoutineRequestReceipt, type RoutineRun, type Routine } from "./routines.ts";
import { readRoutinesWithRuns, foldRoutineStateForDowngrade, routineRunsDir } from "./routine-runs-journal.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const NOW = 1_800_000_000_000, roots: string[] = [], managers: RoutineManager[] = [];
afterEach(() => { vi.restoreAllMocks(); managers.splice(0).forEach(m => m.stop()); roots.splice(0).forEach(root => removeTempDirSync(root)); });
const input = { name: "Fake", prompt: "Fake only", botId: "bot", enabled: false, schedule: { type: "interval" as const, everyMinutes: 5, anchorAt: NOW } };
function request(action: RoutineRequestCommit["action"], id: string = action): RoutineRequestCommit { return { requestId: id, messageId: `message-${id}`, botId: "bot", threadId: "thread", action, fingerprintVersion: 1, fingerprint: "a".repeat(64) }; }
function fixture(size = 0, sameFile = false) {
  const root = mkdtempSync(join(tmpdir(), "murage-proposal-bounded-")); roots.push(root);
  const file = join(root, "routines.json");
  const runs = Array.from({ length: size }, (_, i) => ({ id: `old-${i}`, routineId: sameFile ? "target" : "history", routineName: "Old", botId: "bot", target: "bot", runOn: "ember", manual: true, scheduledFor: NOW - i, createdAt: NOW - i, status: "completed", finishedAt: NOW - i, delivery: { state: "pending" } }));
  const receipts: RoutineRequestReceipt[] = Array.from({ length: size }, (_, i) => ({ ...request("pause", `old-${i}`), resultId: "old", appliedAt: NOW - i }));
  writeFileSync(file, JSON.stringify({ version: 1, routines: sameFile ? [{ id: "target", ...input, target: "bot", runOn: "ember", nextRunAt: null, createdAt: NOW, updatedAt: NOW }] : [], runs, routineRequestReceipts: receipts }));
  const options = { file, now: () => NOW, dispatchOpen: () => false, botState: () => "busy" as const, createTask: () => null, startTurn: async () => {} };
  const m = new RoutineManager(options); managers.push(m);
  const reload = () => { const next = new RoutineManager(options); managers.push(next); return next; };
  return { m, reload, file };
}
type Inside = { runStore: Set<RoutineRun>; journal: { proposal(input: unknown): void }; routines: Routine[]; saveFull(): void; commitMutation(fn: () => void): void };
const inside = (m: RoutineManager) => m as unknown as Inside;
for (const action of ["create", "update", "pause", "resume", "delete", "run_now"] as const) it(`P35 ${action}: begin action result cleanup never visits retained runs or receipts`, async () => {
  const counts = [];
  for (const size of [100, 2_000]) {
    const f = fixture(size, true), routine = f.m.listRoutines()[0]!, commit = request(action);
    const full = vi.spyOn(inside(f.m), "commitMutation"), save = vi.spyOn(inside(f.m), "saveFull");
    const traversal = vi.spyOn(inside(f.m).runStore, Symbol.iterator); const clones = routineWorkCounters.cloneRun;
    const receiptHistory = vi.spyOn(inside(f.m) as unknown as { routineRequestReceipts: RoutineRequestReceipt[] }, "routineRequestReceipts", "get");
    const lines = routineWorkCounters.journalLines;
    f.m.beginRoutineRequest(commit, { routineId: action === "create" ? undefined : routine.id, before: action === "create" ? { absent: true } : null });
    if (action === "create") f.m.create(input, commit as never);
    else if (action === "update") f.m.update(routine.id, { name: "Changed" }, commit as never);
    else if (action === "delete") f.m.remove(routine.id, commit as never);
    else if (action === "run_now") f.m.runNow(routine.id, commit as never);
    else f.m.update(routine.id, { enabled: action === "resume" }, commit as never);
    expect(f.m.routineRequestReceipt(commit.requestId)?.resultId).toBeTruthy();
    f.m.forgetRoutineRequestReceipt(commit); await Promise.resolve();
    counts.push({ full: full.mock.calls.length, saveFull: save.mock.calls.length, history: traversal.mock.calls.length, receipts: receiptHistory.mock.calls.length, clones: routineWorkCounters.cloneRun - clones, lines: routineWorkCounters.journalLines - lines });
    expect(counts.at(-1)).toMatchObject({ full: 0, saveFull: 0, history: 0, receipts: 0 });
    expect(counts.at(-1)!.lines).toBeLessThanOrEqual(action === "run_now" ? 4 : 3);
    full.mockRestore(); save.mockRestore(); traversal.mockRestore(); receiptHistory.mockRestore();
  }
  console.info("P35-measure", JSON.stringify({ action, sizes: [100, 2_000], counts })); expect(counts[0]).toEqual(counts[1]);
});
it("P35 durable intent and atomic create/result survive reload, cleanup and downgrade", () => {
  const f = fixture(), commit = request("create"); f.m.beginRoutineRequest(commit, { before: { absent: true } });
  const pending = f.reload(); expect(pending.routineRequestReceipt("create")?.resultId).toBeUndefined();
  const routine = pending.create(input, commit as never), again = f.reload();
  expect(again.routineRequestReceipt("create")?.resultId).toBe(routine.id); expect(again.routineName(routine.id)).toBe("Fake");
  expect(again.create(input, commit as never).id).toBe(routine.id);
  const raw = readRoutinesWithRuns(f.file); expect(raw.routines.some((r: Routine) => r.id === routine.id)).toBe(true);
  expect(raw.routineRequestReceipts.find((r: RoutineRequestReceipt) => r.requestId === "create")?.resultId).toBe(routine.id);
  again.forgetRoutineRequestReceipt(commit); expect(readRoutinesWithRuns(f.file).routineRequestReceipts.some((r: RoutineRequestReceipt) => r.requestId === "create")).toBe(false);
  foldRoutineStateForDowngrade(f.file); expect(JSON.parse(readFileSync(f.file, "utf8")).routines.some((r: Routine) => r.id === routine.id)).toBe(true);
  const names = readdirSync(routineRunsDir(dirname(f.file)));
  for (const name of names.filter(name => name.endsWith(".jsonl"))) for (const line of readFileSync(join(routineRunsDir(dirname(f.file)), name), "utf8").split("\n").filter(Boolean)) expect(JSON.parse(line).id, "downgrade journals contain only plain run records").toBeTypeOf("string");
});
it("P35 failure restores canonical definition, preserves intent, and never flushes a foreign dirty run", () => {
  const f = fixture(100), routine = f.m.create(input), commit = request("update");
  f.m.beginRoutineRequest(commit, { routineId: routine.id, before: null });
  const canonical = inside(f.m).routines.find(r => r.id === routine.id)!;
  const foreign = inside(f.m).runStore.values().next().value!; foreign.output = "unsaved foreign";
  const journal = inside(f.m).journal, real = journal.proposal.bind(journal);
  vi.spyOn(journal, "proposal").mockImplementationOnce(() => { throw new Error("fixture action failure"); });
  expect(() => f.m.update(routine.id, { name: "Failed" }, commit as never)).toThrow("fixture action failure");
  expect(inside(f.m).routines.find(r => r.id === routine.id)).toBe(canonical); expect(canonical.name).toBe("Fake");
  expect(readRoutinesWithRuns(f.file).runs.find((run: RoutineRun) => run.id === foreign.id)?.output).toBeUndefined();
  expect(f.reload().routineRequestReceipt("update")?.resultId).toBeUndefined(); expect(f.reload().routineName(routine.id)).toBe("Fake");
  expect(real).toBeTypeOf("function");
});
it("P35 webhook result and cleanup failures retain the keyed receipt for idempotent retry", () => {
  const f = fixture(2_000), commit = request("create", "webhook"), journal = inside(f.m).journal;
  f.m.beginRoutineRequest(commit, { kind: "webhook", before: { absent: true } });
  vi.spyOn(journal, "proposal").mockImplementationOnce(() => { throw new Error("fixture result failure"); });
  expect(() => f.m.completeRoutineRequest(commit, "hook", NOW)).toThrow("fixture result failure");
  expect(f.reload().routineRequestReceipt("webhook")).toMatchObject({ kind: "webhook", before: { absent: true } });
  f.m.recoverPersistence(); f.m.completeRoutineRequest(commit, "hook", NOW);
  vi.spyOn(journal, "proposal").mockImplementationOnce(() => { throw new Error("fixture cleanup failure"); });
  expect(() => f.m.forgetRoutineRequestReceipt(commit)).toThrow("fixture cleanup failure");
  expect(f.reload().routineRequestReceipt("webhook")?.resultId).toBe("hook");
});
it("P35 same-file compaction progresses while proposal receipts are retired by key", () => {
  for (const size of [100, 2_000]) {
    const f = fixture(size, true), journal = (f.m as unknown as { journal: { resetWork(): void; work: { journalLines: number; compactCopied: number }; requestReceipts: Map<string, unknown>; cursors: Map<string, unknown>; files: Map<string, { lines: number }>; verifyFileIndexes(): string[] } }).journal;
    let maxLines = 0, maxCopies = 0;
    for (let i = 0; i < 710; i++) {
      const commit = request("update", `compaction-${i}`); journal.resetWork();
      f.m.beginRoutineRequest(commit, { routineId: "target", before: null });
      f.m.update("target", { name: `Name ${i}` }, commit as never); f.m.forgetRoutineRequestReceipt(commit);
      maxLines = Math.max(maxLines, journal.work.journalLines); maxCopies = Math.max(maxCopies, journal.work.compactCopied);
      expect(journal.work.journalLines).toBeLessThanOrEqual(6); expect(journal.work.compactCopied).toBeLessThanOrEqual(3 * 256);
    }
    expect(journal.requestReceipts.size).toBe(0); expect(journal.cursors.size).toBe(0); expect(journal.verifyFileIndexes()).toEqual([]);
    expect(journal.files.get("target.jsonl")!.lines).toBeLessThan(2 * (size + 1) + 50);
    expect(f.reload().routineName("target")).toBe("Name 709");
    console.info("P35-compaction-work", JSON.stringify({ size, maxLines, maxCopies }));
  }
}, 180_000);
it("restored proposal-created definitions are folded before pausing and resetting grants", async () => {
  const f = fixture(), commit = request("create", "restore-create"); f.m.beginRoutineRequest(commit, { before: { absent: true } });
  const routine = f.m.create({ ...input, enabled: true, permissionMode: "unlimited" }, commit as never); f.m.forgetRoutineRequestReceipt(commit); f.m.stop();
  const { dirname } = await import("node:path"), root = dirname(f.file);
  writeFileSync(join(root, "config.json"), "{}"); writeFileSync(join(root, "groups.json"), "[]");
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Fake", autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] }]));
  const { writeInstallationArchive } = await import("./installation-archive.ts"), { restoreInstallation } = await import("./installation-restore.ts");
  const output = mkdtempSync(join(tmpdir(), "murage-proposal-restore-")); roots.push(output);
  const archive = join(output, "backup.zip"), target = join(output, "restored"), saved = await writeInstallationArchive(root, archive);
  await restoreInstallation(target, archive, saved.sha256, { requireNew: true });
  const restored = readRoutinesWithRuns(join(target, "routines.json")).routines.find((r: Routine) => r.id === routine.id);
  expect(restored, "a journal-only definition must survive restore").toBeDefined(); expect(restored.enabled).toBe(false); expect(restored.permissionMode).toBeUndefined(); expect(restored.alwaysAllow).toEqual([]);
});
it("P35 journal-only creates preserve definition order across restart at equal wall-clock times", () => {
  const f = fixture(), first = request("create", "first"), second = request("create", "second");
  f.m.beginRoutineRequest(first, { before: { absent: true }, routineId: "z-first" }); f.m.create({ ...input, name: "First" }, first as never);
  f.m.beginRoutineRequest(second, { before: { absent: true }, routineId: "a-second" }); f.m.create({ ...input, name: "Second" }, second as never);
  expect(f.m.listRoutines().map(r => r.name)).toEqual(["Second", "First"]);
  expect(f.reload().listRoutines().map(r => r.name)).toEqual(["Second", "First"]);
});
