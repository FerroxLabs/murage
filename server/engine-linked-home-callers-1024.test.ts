// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An engine's history folders may be links (a dotfiles folder, another disk), as it was on v1.0.20. Every removal that confines its cut to
// the home must still work through such a link: the empty-folder cut (Qwen's chats and project folders, rmdirIfEmpty) and the pasted-text
// cut (Claude's paste-cache, removeUnlessReferenced). Entered through removeEngineHistoryFiles, the call conversation deletion makes.
import { existsSync, mkdtempSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { qwenProjectKey } from "./engine-history-deletion.ts";
import { removeEngineHistoryFiles } from "./engine-history-run.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { buildFixture, canaryHits } from "./testing/engine-history-fixtures.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-linked-callers-")));
afterAll(() => removeTempDirSync(scratch));

/** One folder of the engine home (the cut's own root) moved aside and a link left in its place: a person's folder on another disk. */
function linkFolder(home: string, name: string): void {
  const real = join(home, `${name}-elsewhere`);
  renameSync(join(home, name), real);
  symlinkSync(real, join(home, name));
}

it("Qwen: the chats and project folders are cut as empty folders when its own root folder is a link", () => {
  const fx = buildFixture("qwen", scratch);
  const home = fx.homes[0]!.home;
  linkFolder(home, "projects");
  const project = join(home, "projects", qwenProjectKey(fx.folders[0]!));
  expect(existsSync(project)).toBe(true);
  const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
  expect(whole.failed).toEqual([]);
  expect(existsSync(project)).toBe(false);
  expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
});

it("Claude: a pasted text that no remaining history row names is cut when its own root folder is a link", () => {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  linkFolder(home, "paste-cache");
  const paste = join(home, "paste-cache", "ab12cd34ef56ab12.txt");
  expect(existsSync(paste)).toBe(true);
  const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
  expect(whole.failed).toEqual([]);
  expect(existsSync(paste)).toBe(false);
  expect(existsSync(join(home, "paste-cache", "1122334455667788.txt"))).toBe(true); // still named by the other session
  expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
});
