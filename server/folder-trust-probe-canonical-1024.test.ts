// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 (Astra 5fb348f5bf B): the turn's saved-decision lookup (folderTrust.decision(scan.folder)) resolves its keys from the CANONICAL
// folder, while the engine key is taken from the folder as given. For a symlink alias outside the worktrees dir that resolves into a
// registry-managed worktree, only the canonical path is under <fuigo home>/worktrees, so only the canonical lookup reads the registry. The
// probe must collect that registry answer too, or the turn's computation has to fetch it after the snapshot.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalFolder, folderTrustKey } from "./folder-trust.ts";
import { probeFolderTrustFs } from "./folder-trust-probe.ts";
import { DatabaseSync } from "./sqlite-open.ts";
import { snapshotTrustFs } from "./trust-fs.ts";

let root: string, home: string, worktree: string, source: string, alias: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "trust-probe-alias-")));
  home = join(root, "fuigohome"); worktree = join(home, "worktrees", "repo", "w1"); source = join(root, "source"); alias = join(root, "alias-w1");
  mkdirSync(worktree, { recursive: true }); mkdirSync(source);
  symlinkSync(worktree, alias);
  const db = new DatabaseSync(join(home, "worktrees.db"));
  db.exec("CREATE TABLE worktrees (path TEXT, source_repo TEXT)");
  db.prepare("INSERT INTO worktrees (path, source_repo) VALUES (?, ?)").run(worktree, source);
  db.close();
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

it("a symlink alias into a registry-managed worktree: the probe collects the registry answer the canonical saved-decision lookup reads", async () => {
  expect(canonicalFolder(alias)).toBe(worktree);
  expect(folderTrustKey(alias, { fuigoHome: home }), "the engine key, from the folder as given: no registry").toBe(worktree);
  expect(folderTrustKey(canonicalFolder(alias), { fuigoHome: home }), "the saved-decision lookup's key: the registry's source").toBe(source);
  const snapshot = await snapshotTrustFs(() => probeFolderTrustFs(alias, home, 2, null));
  const registry = [...snapshot.entries()].filter(([entry]) => entry.startsWith("worktree\0"));
  expect(registry.map(([entry]) => entry.split("\0").slice(1)), "the registry lookup of the canonical worktree is in the snapshot").toContainEqual([join(home, "worktrees.db"), worktree]);
  expect(registry.map(([, answer]) => answer), "with the source repo it records").toContainEqual({ value: { source } });
});
