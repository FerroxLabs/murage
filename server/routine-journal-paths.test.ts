import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { RoutineRunsJournal, readRoutineRuns, readRoutineStates, routineRunsDir, routineRunsFileName } from "./routine-runs-journal.ts";
import { RoutineManager } from "./routines.ts";

const old = join(DATA_DIR, "previous");
const path = join(old, "attachments", "brief.pdf");
const next = join(DATA_DIR, "attachments", "brief.pdf");
const file = join(DATA_DIR, "routines.json");
const manager = () => new RoutineManager({ file, botState: () => "ready", createTask: () => ({ threadId: "t" }), startTurn: async () => {} });
function setup(refused: boolean) {
  rmSync(file, { force: true });
  rmSync(routineRunsDir(DATA_DIR), { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: old, previous: [] }));
  bootDataRoots();
  const first = manager();
  const routine = first.create({ name: "Brief", prompt: path, botId: "bot", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60000 } });
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const attachments = [{ id: "a", name: "Brief", kind: "file", size: 10, path }, ...(refused ? [{ id: "b", name: "Other", kind: "file", size: 2, path: join(old, "other", "brief.pdf") }] : [])];
  const snapshot = { ...routine, attachments };
  const run = { id: "run", routineId: routine.id, attachments, prompt: path, createdAt: 1, status: "done", target: "bot", botId: "bot" };
  const journalFile = join(routineRunsDir(DATA_DIR), routineRunsFileName(routine.id));
  mkdirSync(routineRunsDir(DATA_DIR), { recursive: true });
  writeFileSync(journalFile, JSON.stringify({ $routine: snapshot, $gen: doc.stateGeneration, $runs: [run] }) + "\n");
  return { snapshot, run, journalFile, doc };
}
it.each([false, true])("S5 site 17 reads current-generation snapshots in memory, preserves refusal and journal bytes (refused=%s)", refused => {
  const { snapshot, run, journalFile, doc } = setup(refused);
  const before = readFileSync(journalFile);
  const expected = refused ? snapshot.attachments : [{ ...snapshot.attachments[0], path: next }];
  const journal = new RoutineRunsJournal(DATA_DIR);
  expect(journal.load(doc.runsCommit, doc.stateGeneration)).toEqual([{ ...run, attachments: expected }]);
  expect(journal.routineStates.get(snapshot.id)).toEqual({ ...snapshot, attachments: expected });
  expect(readRoutineStates(DATA_DIR, doc.runsCommit, doc.stateGeneration).get(snapshot.id)).toEqual({ ...snapshot, attachments: expected });
  expect(readRoutineStates(DATA_DIR, doc.runsCommit, "stale").size).toBe(0);
  expect(readRoutineRuns(DATA_DIR, doc.runsCommit)).toEqual([{ ...run, attachments: expected }]);
  const loaded = manager();
  expect(loaded.listRoutines()[0]).toMatchObject({ prompt: path, attachments: expected });
  expect(loaded.listRuns()[0]).toMatchObject({ attachments: expected });
  expect(readFileSync(journalFile)).toEqual(before);
  // A later ordinary save folds the in-memory routine into routines.json.
  loaded.update(snapshot.id, { name: "Saved after move" });
  expect(JSON.parse(readFileSync(file, "utf8")).routines[0]).toMatchObject({ attachments: expected });
});
