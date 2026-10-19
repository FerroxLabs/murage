// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2522 (Apache-2.0).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PersistedStateRecoveryError } from "./persisted-state.ts";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function options(file: string) {
  return { file, botState: () => "ready" as const, createTask: () => ({ threadId: "t" }), startTurn: async () => {} };
}

it("refuses to start on a corrupt routines.json and leaves the file as it was", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-routines-corrupt-")); roots.push(root);
  const file = join(root, "routines.json");
  writeFileSync(file, '{"routines": [ {"id": "kept"');
  expect(() => new RoutineManager(options(file))).toThrow(PersistedStateRecoveryError);
  expect(readFileSync(file, "utf8")).toBe('{"routines": [ {"id": "kept"');
});

it("still starts empty when routines.json does not exist", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-routines-missing-")); roots.push(root);
  expect(new RoutineManager(options(join(root, "routines.json"))).listRoutines()).toEqual([]);
});

it("keeps a routine whose schedule cannot load through every later save, and never runs it", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-routines-unloadable-")); roots.push(root);
  const file = join(root, "routines.json");
  const first = new RoutineManager(options(file));
  const kept = first.create({ name: "Kept", prompt: "Report", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60_000 } });
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const broken = { ...stored.routines[0], id: "broken-schedule", name: "Broken", schedule: { type: "from-a-newer-build", every: "fortnight" } };
  stored.routines.push(broken);
  writeFileSync(file, JSON.stringify(stored, null, 2));

  const second = new RoutineManager(options(file));
  // Loaded routines exclude it, so nothing can schedule or run it.
  expect(second.listRoutines().map((routine) => routine.id)).toEqual([kept.id]);
  expect(second.unloadable()).toEqual([{ id: "broken-schedule", name: "Broken", botId: "bot-a", reason: "schedule" }]);
  await second.tick();
  expect(second.listRuns().some((run) => run.routineId === "broken-schedule")).toBe(false);

  // An unrelated save rewrites routines.json; the broken row is still there, as stored.
  second.create({ name: "Another", prompt: "Report", botId: "bot-b", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() + 60_000 } });
  second.update(kept.id, { name: "Kept, renamed" });
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.routines.find((routine: { id: string }) => routine.id === "broken-schedule")).toEqual(broken);
  expect(after.routines).toHaveLength(3);

  // And it survives the next start too.
  const third = new RoutineManager(options(file));
  expect(third.unloadable()).toEqual([{ id: "broken-schedule", name: "Broken", botId: "bot-a", reason: "schedule" }]);
  expect(third.listRoutines()).toHaveLength(2);

  // The owner can delete it from the app, and only that row goes.
  expect(third.remove("broken-schedule")).toBe(true);
  expect(third.unloadable()).toEqual([]);
  expect(third.remove("broken-schedule")).toBe(false);
  const deleted = JSON.parse(readFileSync(file, "utf8"));
  expect(deleted.routines.map((routine: { id: string }) => routine.id).sort()).toEqual(third.listRoutines().map((routine) => routine.id).sort());
  expect(new RoutineManager(options(file)).unloadable()).toEqual([]);
});

it("keeps two unloadable rows that share an id, both of them, through a save", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-routines-dup-")); roots.push(root);
  const file = join(root, "routines.json");
  const first = new RoutineManager(options(file));
  first.create({ name: "Kept", prompt: "Report", botId: "bot-a", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60_000 } });
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const a = { ...stored.routines[0], id: "twin", name: "Twin A", schedule: { type: "lunar" } };
  const b = { ...stored.routines[0], id: "twin", name: "Twin B", schedule: { type: "tidal" }, extra: { kept: true } };
  stored.routines.push(a, b);
  writeFileSync(file, JSON.stringify(stored, null, 2));
  const second = new RoutineManager(options(file));
  expect(second.unloadable().map((routine) => routine.name)).toEqual(["Twin A", "Twin B"]);
  second.create({ name: "Another", prompt: "Report", botId: "bot-b", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() + 60_000 } });
  const after = JSON.parse(readFileSync(file, "utf8")).routines.filter((routine: { id: string }) => routine.id === "twin");
  expect(after).toEqual([a, b]);
});
