// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2522 (Apache-2.0).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PersistedStateRecoveryError } from "./persisted-state.ts";
import { RoutineManager } from "./routines.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
