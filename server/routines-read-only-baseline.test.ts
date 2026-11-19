// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance, write authority: the routine manager's first-run commit baseline is a create-when-missing file write. A read-only start does not
// make it: the manager still loads, holds the baseline in memory, names the step, and the next normal start writes the file.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { enterReadOnly, isReadOnly, skippedAtStart, startMode } from "./read-only-start.ts";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const normalDir = join(DATA_DIR, "baseline-normal");
const heldDir = join(DATA_DIR, "baseline-held");
const manager = (dir: string) => new RoutineManager({ file: join(dir, "routines.json"), now: () => 1, botState: () => "ready",
  createTask: () => ({ threadId: "thread" }), startTurn: async () => {} });

beforeAll(() => {
  removeTempDirSync(DATA_DIR); mkdirSync(normalDir, { recursive: true }); mkdirSync(heldDir, { recursive: true });
  expect(startMode(DATA_DIR)).toBe("normal");
});
afterAll(() => { removeTempDirSync(normalDir); removeTempDirSync(heldDir); });

it("control: a normal start writes the missing baseline file", () => {
  expect(manager(normalDir).listRoutines()).toEqual([]);
  expect(Number.isSafeInteger(JSON.parse(readFileSync(join(normalDir, "routines.json"), "utf8")).runsCommit)).toBe(true);
  expect(skippedAtStart).toEqual([]);
});

it("W9 a read-only start loads the routine manager without writing the missing baseline file, and names the step", () => {
  enterReadOnly("baseline-test");
  expect(isReadOnly()).toBe(true);
  const listing = readdirSync(heldDir);
  let loaded: RoutineManager | undefined;
  expect(() => { loaded = manager(heldDir); }).not.toThrow();
  expect(loaded!.listRoutines()).toEqual([]);
  expect(existsSync(join(heldDir, "routines.json"))).toBe(false);
  expect(readdirSync(heldDir)).toEqual(listing);                    // no temp file either
  expect(skippedAtStart).toEqual(["routines.commitBaseline", "routines.restartRecovery"]);
});
