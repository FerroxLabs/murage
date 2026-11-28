// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 N3: the folder-trust step's file calls are answered from a snapshot read off the serving thread (trust-fs.ts). The snapshot must be
// the answer the live code would give, must be what the computation reads (not the disk a moment later), and must never guess.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "./sqlite-open.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalFolder, folderTrustKey, scanFolderTrustSources } from "./folder-trust.ts";
import { probeUpstreamTrustFs, upstreamTrustForTurn } from "./folder-trust-upstream-cache.ts";
import { managedDeskQualifies } from "./managed-workspace-trust.ts";
import { answerFromTrustFs, snapshotTrustFs, trustFs, TrustFsUnsettled } from "./trust-fs.ts";

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "trust-fs-")));
  mkdirSync(join(root, "repo/.git"), { recursive: true });
  mkdirSync(join(root, "repo/deep/er/work"), { recursive: true });
  writeFileSync(join(root, "repo/AGENTS.md"), "x");
  mkdirSync(join(root, "repo/deep/.claude/skills"), { recursive: true });
  symlinkSync(join(root, "repo/deep/er"), join(root, "link"));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

it("the snapshot answers the folder scan exactly as the live code does, through a symlink and a git root", async () => {
  const folder = join(root, "link/work");
  const live = scanFolderTrustSources(folder);
  const snapshot = await snapshotTrustFs(() => scanFolderTrustSources(folder));
  expect(live.sources).toEqual(expect.arrayContaining(["AGENTS.md"]));
  rmSync(join(root, "repo/AGENTS.md")); // the disk moves on after the snapshot; the answer is the snapshot's
  expect(await answerFromTrustFs(snapshot, () => scanFolderTrustSources(folder))).toEqual(live);
  writeFileSync(join(root, "repo/AGENTS.md"), "x");
});

it("the computation reads the snapshot, not the disk a moment later", async () => {
  const folder = join(root, "repo/deep/er/work");
  const snapshot = await snapshotTrustFs(() => scanFolderTrustSources(folder));
  writeFileSync(join(root, "repo/.mcp.json"), "{}");
  expect((await answerFromTrustFs(snapshot, () => scanFolderTrustSources(folder))).sources).not.toContain(".mcp.json");
  expect(scanFolderTrustSources(folder).sources).toContain(".mcp.json");
  rmSync(join(root, "repo/.mcp.json"));
});

it("a call the snapshot does not hold is answered off the serving thread and the computation runs again: the answer is never guessed", async () => {
  const snapshot = await snapshotTrustFs(() => trustFs.existsSync(join(root, "repo/AGENTS.md")));
  expect(await answerFromTrustFs(snapshot, () => trustFs.existsSync(join(root, "repo/AGENTS.md")))).toBe(true);
  expect(await answerFromTrustFs(snapshot, () => trustFs.existsSync(join(root, "repo/.git")))).toBe(true); // not probed: answered off the thread, then run again
  expect(await answerFromTrustFs(snapshot, () => trustFs.existsSync(join(root, "repo/missing")))).toBe(false);
});

it("a recorded failure is thrown with its code, and a path that only exists after a placeholder resolves converges", async () => {
  const dangling = join(root, "dangling");
  symlinkSync(join(root, "gone"), dangling);
  const snapshot = await snapshotTrustFs(() => {
    try { trustFs.statSync(dangling); } catch { /* recorded */ }
    const real = canonicalFolder(join(root, "link")); // a placeholder realpath is the path itself; the next round holds the real one
    trustFs.existsSync(join(real, "work"));
  });
  rmSync(dangling); writeFileSync(dangling, "x"); // the disk moves on: the recorded failure stays the snapshot's answer
  await expect(answerFromTrustFs(snapshot, () => trustFs.statSync(dangling))).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
  expect(await answerFromTrustFs(snapshot, () => canonicalFolder(join(root, "link")))).toBe(join(root, "repo/deep/er"));
  expect(await answerFromTrustFs(snapshot, () => trustFs.existsSync(join(root, "repo/deep/er/work")))).toBe(true);
});

it("the desk checks are answered from the snapshot too", async () => {
  const data = join(root, "data");
  const desk = join(data, "workspaces", "botone", "threads", "threadone");
  mkdirSync(desk, { recursive: true });
  const input = { dataDir: data, botId: "botone", threadId: "threadone", bundleIds: [] as string[], desk };
  const scan = scanFolderTrustSources(desk);
  const live = managedDeskQualifies(desk, scan, input);
  const snapshot = await snapshotTrustFs(() => managedDeskQualifies(desk, scan, input));
  mkdirSync(join(desk, ".claude/skills"), { recursive: true });
  expect(await answerFromTrustFs(snapshot, () => managedDeskQualifies(desk, scan, input))).toBe(live);
  expect(live).toBe("bare");
  expect(managedDeskQualifies(desk, scan, input)).toBeNull();
});

it("the engine's worktree registry is read off the serving thread and answered from the snapshot", async () => {
  const home = join(root, "fuigohome"), worktree = join(home, "worktrees", "repo", "w1"), source = join(root, "repo");
  mkdirSync(worktree, { recursive: true });
  const db = new DatabaseSync(join(home, "worktrees.db"));
  db.exec("CREATE TABLE worktrees (path TEXT, source_repo TEXT)");
  db.prepare("INSERT INTO worktrees (path, source_repo) VALUES (?, ?)").run(canonicalFolder(worktree), source);
  db.close();
  const live = folderTrustKey(worktree, { fuigoHome: home });
  expect(live).toBe(source);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const snapshot = await snapshotTrustFs(() => folderTrustKey(worktree, { fuigoHome: home }));
  clearInterval(timer);
  expect(ticks, "the loop kept turning while the registry was read").toBeGreaterThan(0);
  rmSync(join(home, "worktrees.db"));
  expect(await answerFromTrustFs(snapshot, () => folderTrustKey(worktree, { fuigoHome: home }))).toBe(source);
  expect(folderTrustKey(worktree, { fuigoHome: home })).toBe(worktree);
});

it("the saved-decision lookup's own git key (a linked worktree's .git file) is answered from the snapshot", async () => {
  const main = join(root, "lw-main"), wt = join(root, "lw-tree");
  mkdirSync(join(main, ".git/worktrees/lw-tree"), { recursive: true });
  mkdirSync(wt);
  writeFileSync(join(main, ".git/worktrees/lw-tree/commondir"), "../..\n");
  writeFileSync(join(main, ".git/worktrees/lw-tree/gitdir"), `${join(wt, ".git")}\n`);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git/worktrees/lw-tree")}\n`);
  const live = folderTrustKey(wt);
  expect(live).toBe(main);
  const snapshot = await snapshotTrustFs(() => folderTrustKey(wt));
  rmSync(join(wt, ".git"));
  expect(await answerFromTrustFs(snapshot, () => folderTrustKey(wt))).toBe(main);
  expect(folderTrustKey(wt)).toBe(wt);
});

it("a warm upstream trust cache answers its ancestor lookups from the snapshot, and a cold one is read without a synchronous read", async () => {
  const home = join(root, "uphome"), project = join(root, "up-project");
  mkdirSync(home, { recursive: true }); mkdirSync(join(project, "sub"), { recursive: true });
  writeFileSync(join(home, "trusted_folders.toml"), `[folders.${JSON.stringify(project)}]\ntrusted = true\n`);
  const key = folderTrustKey(join(project, "sub"), { fuigoHome: home });
  expect(upstreamTrustForTurn(home, key, 2).readable, "a cold cache says unknown first").toBe(false);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(upstreamTrustForTurn(home, key, 2).state).toBe("readable");
  const snapshot = await snapshotTrustFs(() => probeUpstreamTrustFs(home, key, 2));
  rmSync(project, { recursive: true });
  expect(await answerFromTrustFs(snapshot, () => upstreamTrustForTurn(home, key, 2))).toMatchObject({ state: "readable", declined: false });
});

// 1.0.24 (Astra 5fb348f5bf C): an upstream cache entry that was still being read when the snapshot was taken and is ready when the answer is
// computed makes ancestor lookups the probe never saw. They are answered off the serving thread into the snapshot, never made live.
it("an upstream entry that turns ready after the snapshot has its ancestor lookups answered off the thread, not live", async () => {
  const home = join(root, "pendhome"), project = join(root, "pend-project"), sub = join(project, "sub");
  mkdirSync(home, { recursive: true }); mkdirSync(sub, { recursive: true });
  writeFileSync(join(home, "trusted_folders.toml"), `[folders.${JSON.stringify(project)}]\ntrusted = true\n`);
  const key = folderTrustKey(sub, { fuigoHome: home });
  expect(upstreamTrustForTurn(home, key, 2).readable, "the entry is pending: being read off the thread").toBe(false);
  const snapshot = await snapshotTrustFs(() => probeUpstreamTrustFs(home, key, 2));
  expect([...snapshot.keys()].filter(entry => entry.endsWith(`\0${project}`)), "the probe saw a pending entry: no ancestor lookup").toEqual([]);
  await expect.poll(() => upstreamTrustForTurn(home, key, 2).state, { timeout: 2000 }).toBe("readable");
  const answer = await answerFromTrustFs(snapshot, () => upstreamTrustForTurn(home, key, 2));
  expect(answer, "the answer is the live code's").toEqual(upstreamTrustForTurn(home, key, 2));
  expect(answer.state).toBe("readable");
  expect([...snapshot.keys()].filter(entry => entry.endsWith(`\0${project}`)).length, "the ancestor lookup was answered off the thread into the snapshot").toBeGreaterThan(0);
});

it("a chain of file calls that never settles refuses the answer: never a guess, never a live call", async () => {
  let n = 0;
  await expect(answerFromTrustFs(new Map(), () => trustFs.existsSync(join(root, `never-${n++}`)), 3)).rejects.toThrow(TrustFsUnsettled);
  expect(n, "three rounds, then refused").toBe(3);
});
