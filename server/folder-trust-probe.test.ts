// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 N3: every file call folderTrustForTurn makes for a registry-managed worktree on a warm trust cache is in the turn's snapshot. The
// computation replays after the disk moved on: a call family the probe misses is read live (the serving-thread call that froze the app),
// sees the new disk, and answers differently.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { folderTrustKey } from "./folder-trust.ts";
import { upstreamTrustForTurn } from "./folder-trust-upstream-cache.ts";
import { probeFolderTrustFs } from "./folder-trust-probe.ts";
import { DatabaseSync } from "./sqlite-open.ts";
import { answerFromTrustFs, snapshotTrustFs } from "./trust-fs.ts";

let root: string, home: string, worktree: string, source: string;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "trust-probe-")));
  home = join(root, "fuigohome"); worktree = join(home, "worktrees", "repo", "w1"); source = join(root, "source");
  mkdirSync(join(source, ".git/worktrees/w1"), { recursive: true }); mkdirSync(worktree, { recursive: true });
  // the worktree is also a linked git worktree of the source: its own git key reads its .git file, the gitdir's commondir and gitdir files
  writeFileSync(join(source, ".git/worktrees/w1/commondir"), "../..\n");
  writeFileSync(join(source, ".git/worktrees/w1/gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(source, ".git/worktrees/w1")}\n`);
  const db = new DatabaseSync(join(home, "worktrees.db"));
  db.exec("CREATE TABLE worktrees (path TEXT, source_repo TEXT)");
  db.prepare("INSERT INTO worktrees (path, source_repo) VALUES (?, ?)").run(worktree, source);
  db.close();
  writeFileSync(join(home, "trusted_folders.toml"), `[folders.${JSON.stringify(source)}]\ntrusted = true\n`);
  upstreamTrustForTurn(home, source, 1); // cold: unknown, read off the thread
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(upstreamTrustForTurn(home, source, 1).state).toBe("readable");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

it("the engine key, the folder's own git key and the warm upstream answer all come from the probe's snapshot, not the later disk", async () => {
  const live = { engine: folderTrustKey(worktree, { fuigoHome: home }), own: folderTrustKey(worktree), upstream: upstreamTrustForTurn(home, source, 1) };
  expect(live.engine).toBe(source);
  expect(live.own).toBe(source);
  expect(live.upstream).toMatchObject({ state: "readable", trusted: true });
  const snapshot = await snapshotTrustFs(() => probeFolderTrustFs(worktree, home, 1, null));
  // the disk moves on after the snapshot: a repository appears above the worktree, the registry, the worktree's .git file and the engine's trust file go away
  mkdirSync(join(home, "worktrees", ".git"));
  rmSync(join(home, "worktrees.db")); rmSync(join(worktree, ".git")); rmSync(join(home, "trusted_folders.toml"));
  const replayed = await answerFromTrustFs(snapshot, () => ({ engine: folderTrustKey(worktree, { fuigoHome: home }), own: folderTrustKey(worktree), upstream: upstreamTrustForTurn(home, source, 1) }));
  expect(replayed.engine, "the engine key (registry, then git)").toBe(live.engine);
  expect(replayed.own, "the folder's own git key").toBe(live.own);
  expect(replayed.upstream, "the warm upstream cache lookup").toEqual(live.upstream);
});
