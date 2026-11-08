// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S5-DATADIR-PATHS r4.1 C6: a linked `workspaces` root imports notebooks from its canonical target; a link below the root is still refused.
// This file owns its DATA_DIR (per-file HOME).
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { bootDataRoots, resetDataRootsForTest } from "../data-roots.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { migrateDetectedMemoryNotebooks } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
const WS = join(DATA_DIR, "workspaces");
let elsewhere = "";
function lstatOrNull(path: string) { try { return lstatSync(path); } catch { return null; } }
beforeEach(() => {
  closeDatabase(); if (lstatOrNull(WS)?.isSymbolicLink()) rmSync(WS); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-import-volume-")));
  resetDataRootsForTest(undefined);
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
});
afterEach(() => { closeDatabase(); if (lstatOrNull(WS)?.isSymbolicLink()) rmSync(WS); removeTempDirSync(elsewhere); resetDataRootsForTest(undefined); });
function walk() {
  let cursor: string | undefined, imported = 0;
  do { const result = migrateDetectedMemoryNotebooks(roster, cursor); imported += result.imported; cursor = result.nextCursor; } while (cursor);
  return imported;
}

it("C6: a linked workspaces root imports the bot notebook and its topics from the target", () => {
  const T = join(elsewhere, "ws"); mkdirSync(join(T, "a", "memory"), { recursive: true });
  writeFileSync(join(T, "a", "MEMORY.md"), "- likes green tea\n");
  writeFileSync(join(T, "a", "memory", "travel.md"), "- flies from Miami\n");
  symlinkSync(T, WS, "dir"); bootDataRoots();
  expect(walk()).toBeGreaterThanOrEqual(2);
});

it("C6: a link below the root (the bot memory folder) is still refused; the notebook beside it imports [control]", () => {
  mkdirSync(join(WS, "a"), { recursive: true }); bootDataRoots();
  writeFileSync(join(WS, "a", "MEMORY.md"), "- likes green tea\n");
  const target = join(elsewhere, "topics"); mkdirSync(target); writeFileSync(join(target, "secret.md"), "- not this\n");
  symlinkSync(target, join(WS, "a", "memory"), "dir");
  expect(walk()).toBe(1);
});
