// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fault = vi.hoisted(() => ({ short: false, failOpen: false, failMkdir: false, writes: 0, observeOpen: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => { if (fault.failMkdir) { fault.observeOpen?.(); throw new Error("mkdir fault"); } return fs.mkdirSync(...args); },
    openSync: (...args: Parameters<typeof fs.openSync>) => { if (fault.failOpen && String(args[0]).endsWith(".jsonl")) { fault.observeOpen?.(); throw new Error("open fault"); } return fs.openSync(...args); },
  };
});
vi.mock("./counted-fs.ts", async original => {
  const fs = await original<typeof import("./counted-fs.ts")>();
  const { writeJournalPrefix } = await import("./testing/journal-write-fixture.ts");
  return { ...fs, writeSync: (...args: unknown[]) => {
      fault.writes++;
      if (fault.short) return writeJournalPrefix(fs.writeSync, args, 7);
      return (fs.writeSync as (...values: unknown[]) => number)(...args);
    },
  };
});
const { RoutineRunsJournal, readRoutineRuns, routineRunsDir, routineRunsFileName } = await import("./routine-runs-journal.ts");
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "murage-journal-bound-")); roots.push(root); return root; }
afterEach(() => { fault.short = fault.failOpen = fault.failMkdir = false; fault.writes = 0; fault.observeOpen = undefined; for (const root of roots.splice(0)) removeTempDirSync(root); });
const run = (id = "one", routineId = "r") => ({ id, routineId, status: "completed", output: "héllo 🌊" });

for (const writer of ["append", "sync"] as const) it(`P30/P36 ${writer}: short successful UTF-8 writes persist the whole run`, () => {
  const root = fixture(), journal = new RoutineRunsJournal(root); journal.load(0, "g");
  fault.short = true;
  if (writer === "sync") journal.sync([run()], 1); else journal.append({ runs: [run()], routines: [], removed: [] });
  expect(readRoutineRuns(root, 1), "short-write raw replay").toEqual([run()]);
  expect(fault.writes).toBeGreaterThan(1);
  expect(fault.writes).toBeLessThanOrEqual(Buffer.byteLength(readFileSync(join(routineRunsDir(root), routineRunsFileName("r")), "utf8")));
});

it("P30 first-file failure registers unclean file and uncertain new ID before open", () => {
  const root = fixture(), journal = new RoutineRunsJournal(root); journal.load(0, "g");
  let registeredAtOpen = false;
  fault.observeOpen = () => { registeredAtOpen = (journal as unknown as { files: Map<string, unknown> }).files.has(routineRunsFileName("r")); };
  fault.failOpen = true;
  expect(() => journal.append({ runs: [run()], routines: [], removed: [] })).toThrow();
  const internals = journal as unknown as { files: Map<string, { clean: boolean }>; persisted: Map<string, unknown> };
  expect(registeredAtOpen, "registered before open").toBe(true);
  expect(internals.files.get(routineRunsFileName("r")), "attempted file registered").toMatchObject({ clean: false });
  expect(internals.persisted.has("one"), "attempted new ID uncertain placeholder").toBe(true);
});

it("P3 compaction never traverses global persisted or state membership", () => {
  const root = fixture(), journal = new RoutineRunsJournal(root); journal.load(0, "g");
  journal.append({ runs: [run()], routines: [], removed: [] });
  const internals = journal as unknown as { persisted: Map<string, unknown>; routineLines: Map<string, unknown> };
  const visits = { runs: 0, states: 0 };
  const original = internals.persisted.values.bind(internals.persisted);
  vi.spyOn(internals.persisted, "values").mockImplementation(function* () { for (const value of original()) { visits.runs++; yield value; } return undefined; });
  const originalStates = internals.routineLines[Symbol.iterator].bind(internals.routineLines);
  vi.spyOn(internals.routineLines, Symbol.iterator).mockImplementation(function* () { for (const value of originalStates()) { visits.states++; yield value; } return undefined; });
  for (let i = 0; i < 60; i++) { const changed = { ...run(), output: String(i) }; journal.append({ runs: [changed], routines: [{ id: "r", nextRunAt: i } as { id: string }], removed: [] }); }
  expect(visits, "global history visits").toEqual({ runs: 0, states: 0 });
});

for (const commit of [undefined, "invalid"]) it(`P36 legacy ${String(commit)} pins exact baseline before first tagged write`, () => {
  const root = fixture(); mkdirSync(routineRunsDir(root), { recursive: true });
  const legacy = { routines: [{ id: "r" }], runs: [{ ...run(), output: "embedded wins" }], stateGeneration: "g", unknown: { keep: true }, ...(commit === undefined ? {} : { runsCommit: commit }) };
  writeFileSync(join(root, "routines.json"), JSON.stringify(legacy));
  writeFileSync(join(routineRunsDir(root), routineRunsFileName("r")), `${JSON.stringify({ ...run(), $c: 7 })}\n`);
  const journal = new RoutineRunsJournal(root); journal.load(undefined, "g");
  expect(JSON.parse(readFileSync(join(root, "routines.json"), "utf8")), "legacy marker exact projection").toEqual({ ...legacy, runsCommit: 7 });
});

it("P30 first-file mkdir observer sees registered attempted metadata before IO", () => {
  const root = fixture(), journal = new RoutineRunsJournal(root); journal.load(0, "g");
  let registered = false;
  fault.observeOpen = () => { registered = (journal as unknown as { files: Map<string, unknown> }).files.has(routineRunsFileName("r")); };
  fault.failMkdir = true;
  expect(() => journal.append({ runs: [run()], routines: [], removed: [] })).toThrow();
  expect(registered, "registered before mkdir").toBe(true);
});

it("P36 C9a established mixed run/state baseline survives a short tagged recovery sync and generation publication", async () => {
  const { readRoutineStates } = await import("./routine-runs-journal.ts");
  const root = fixture(), journal = new RoutineRunsJournal(root); journal.load(4, "old");
  const carried = run("carried"), before = run(), changed = { ...before, output: "new héllo 🌊" }, routine = { id: "r", nextRunAt: 50 };
  journal.append({ runs: [before, carried], routines: [routine], removed: [] });
  writeFileSync(join(root, "routines.json"), JSON.stringify({ runsCommit: 4, stateGeneration: "old", routines: [{ id: "r", nextRunAt: 1 }] }));
  fault.short = true; journal.sync([changed, carried], 5);
  expect(readRoutineRuns(root, 4), "established mixed baseline before publication").toEqual([before, carried]);
  writeFileSync(join(root, "routines.json"), JSON.stringify({ runsCommit: 5, stateGeneration: "new", routines: [routine] }));
  expect(readRoutineRuns(root, 5), "short-write established recovery publication").toEqual([changed, carried]);
  expect(readRoutineStates(root, 5, "new").size).toBe(0);
  expect(JSON.parse(readFileSync(join(root, "routines.json"), "utf8")).routines).toEqual([routine]);
  journal.markCommitted(5); journal.setGeneration("new"); journal.compact();
  expect(readRoutineRuns(root, 5)).toEqual([changed, carried]);
  expect(journal.verifyFileIndexes()).toEqual([]);
});
