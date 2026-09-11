// A workspace file revision names the bytes, not only the metadata.
//
// On Linux a timestamp comes from the kernel tick, and HFS+, ext3, FAT and many
// network shares keep whole seconds: an equal-length rewrite made inside one
// tick keeps size, inode, mtime and ctime. This file holds those timestamps
// still for chosen inodes (every lstat/fstat of that inode reports them), so
// the collision happens on every machine instead of only on a busy Linux
// runner, and every surface that issues or checks a revision is asked about it.
import type { Stats } from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactSourceFingerprint, initializeArtifacts, readArtifact } from "./artifacts.ts";
import { mediaWorkspaceRevision } from "./media-assets.ts";
import { ProjectFolderLeases } from "./project-folder-leases.ts";
import {
  WorkspaceFileError, listWorkspaceDirectory, nativeWorkspaceFile, readWorkspaceFile, saveWorkspaceVersion, writeWorkspaceMarkdown, type WorkspaceFilesDeps,
} from "./workspace-files.ts";
import {
  VOLUME_CLOCK_RETRY_MS, WORKSPACE_REVISION_CONTENT_MAX_BYTES, WORKSPACE_REVISION_SETTLE_MS, __resetWorkspaceRevisionCacheForTests, __setVolumeClockForTests,
  canRememberDigest, probeVolumeClock, sha256Hex, workspaceRevisionOf, workspaceStatFingerprint,
} from "./workspace-revision.ts";
import type { WorkspaceScopeRef } from "../shared/workspace-files.ts";

// `held` pins the stamps of chosen inodes; `volume.shape` reshapes every
// stamp the way a whole mount would (a mirror mount, whole seconds, a clock
// that runs ahead), which is what the clock probe has to catch; `probes`
// records every probe file the module wrote.
const { held, opened, probes, volume } = vi.hoisted(() => ({
  held: new Map<string, { mtimeMs: number; ctimeMs: number }>(), opened: [] as string[], probes: [] as string[],
  volume: { shape: undefined as ((stat: Stats) => void) | undefined },
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const hold = <T extends Stats | undefined>(stat: T): T => {
    const pinned = stat && held.get(`${stat.dev}:${stat.ino}`);
    if (stat && pinned) { stat.mtimeMs = pinned.mtimeMs; stat.ctimeMs = pinned.ctimeMs; }
    if (stat && volume.shape) volume.shape(stat);
    return stat;
  };
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => hold(fs.lstatSync(...args) as Stats | undefined)) as typeof fs.lstatSync,
    fstatSync: ((...args: Parameters<typeof fs.fstatSync>) => hold(fs.fstatSync(...args) as Stats)) as typeof fs.fstatSync,
    openSync: ((...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return fs.openSync(...args); }) as typeof fs.openSync,
    writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes("/.murage-clock-probe-")) probes.push(String(args[0]));
      return fs.writeFileSync(...args);
    }) as typeof fs.writeFileSync,
  };
});

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  held.clear(); opened.length = 0; probes.length = 0; volume.shape = undefined; vi.restoreAllMocks(); __resetWorkspaceRevisionCacheForTests();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const inode = (stat: Stats) => `${stat.dev}:${stat.ino}`;

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-workspace-revision-"))); roots.push(base);
  const dataDir = join(base, "data"), taskRoot = join(dataDir, "workspaces", "bot", "threads", "thread");
  mkdirSync(taskRoot, { recursive: true });
  const bot = { id: "bot", name: "Research bot", threadId: "thread", resumeCursors: {}, tasks: [{ threadId: "thread", cwd: taskRoot, resumeCursors: {} }] };
  const db = new DatabaseSync(join(base, "messages.db")); initializeArtifacts(db); databases.push(db);
  const deps: WorkspaceFilesDeps = {
    dataDir, database: () => db, store: { bots: [bot], groups: [] } as never,
    artifactScopes: () => [{ botId: bot.id, botName: bot.name, threadId: "thread", workspaceRoot: taskRoot }],
    projectFolders: new ProjectFolderLeases(),
  };
  const scope: WorkspaceScopeRef = { botId: "bot", threadId: "thread" };
  const put = (relative: string, content: string | Uint8Array) => {
    const path = join(taskRoot, ...relative.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  const storage = join(dataDir, "artifact-files");
  const access = { owner: true, scopes: [{ botId: "bot", botName: bot.name, threadId: "thread", workspaceRoot: taskRoot }] };
  const artifactCount = () => Number((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n);
  return { taskRoot, deps, scope, put, db, storage, access, artifactCount };
}

function refusal(action: () => unknown): WorkspaceFileError {
  try { action(); } catch (error) { if (error instanceof WorkspaceFileError) return error; throw error; }
  throw new Error("expected a refusal");
}

describe("an equal-length rewrite inside one timestamp tick", () => {
  it("gets a new revision from every surface and is never saved or written over as the old one", () => {
    const f = fixture();
    const path = f.put("notes/a.md", "one");
    const now = Date.now();
    held.set(inode(lstatSync(path)), { mtimeMs: now, ctimeMs: now });
    const pinned = lstatSync(path);
    const listed = () => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "notes" }).entries.find(entry => entry.name === "a.md")!.revision;

    const revision = readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "notes/a.md" }).revision;
    expect(listed()).toBe(revision);
    expect(nativeWorkspaceFile(f.deps, { scope: f.scope, relativePath: "notes/a.md" }).revision).toBe(revision);
    expect(mediaWorkspaceRevision(f.taskRoot, "notes/a.md", pinned)).toBe(revision);

    writeFileSync(path, "two");
    const rewritten = lstatSync(path);
    // The collision is real: nothing metadata can see has changed.
    expect(artifactSourceFingerprint(rewritten)).toBe(artifactSourceFingerprint(pinned));

    const current = readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "notes/a.md" }).revision;
    expect(current).not.toBe(revision);
    expect(listed()).toBe(current);
    expect(nativeWorkspaceFile(f.deps, { scope: f.scope, relativePath: "notes/a.md" }).revision).toBe(current);
    expect(mediaWorkspaceRevision(f.taskRoot, "notes/a.md", rewritten)).toBe(current);

    const version = refusal(() => saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "notes/a.md", revision }));
    expect([version.code, version.currentRevision]).toEqual(["revision-conflict", current]);
    expect(f.artifactCount()).toBe(0);

    const write = refusal(() => writeWorkspaceMarkdown(f.deps, { scope: f.scope, relativePath: "notes/a.md", baseRevision: revision, requestId: "req-1", content: "one", bom: false }));
    expect([write.code, write.currentRevision]).toEqual(["revision-conflict", current]);
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(f.artifactCount()).toBe(0);

    // The state that is really there saves as exactly its own bytes.
    const { artifact } = saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "notes/a.md", revision: current });
    expect(readArtifact(f.db, f.storage, artifact.id, f.access).bytes.toString("utf8")).toBe("two");
  });

  it("refuses the commit when the file is rewritten in the same tick after the save checked it", () => {
    const f = fixture();
    const path = f.put("b.md", "# base\n");
    const now = Date.now();
    held.set(inode(lstatSync(path)), { mtimeMs: now, ctimeMs: now });
    const revision = readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "b.md" }).revision;
    const error = refusal(() => writeWorkspaceMarkdown(f.deps, { scope: f.scope, relativePath: "b.md", baseRevision: revision, requestId: "req-2", content: "# mine\n", bom: false },
      { beforeCommit: () => writeFileSync(path, "# tool\n") }));
    expect(error.code).toBe("revision-conflict");
    expect(error.currentRevision).toBe(readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "b.md" }).revision);
    expect(readFileSync(path, "utf8")).toBe("# tool\n");
  });

  it("never keeps a same-tick rewrite as the previous version, even one flipped back before the commit", () => {
    // Base check sees A; a tool writes B while the previous version is
    // copied into Files; it writes A back before the pre-commit recheck.
    // Every stamp is the same all along, so the recheck alone would pass and
    // B would be kept as the version the person "replaced".
    const f = fixture();
    const path = f.put("flip.md", "# A\n");
    const now = Date.now();
    held.set(inode(lstatSync(path)), { mtimeMs: now, ctimeMs: now });
    const revision = readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "flip.md" }).revision;
    let flippedBack = false;
    const error = refusal(() => writeWorkspaceMarkdown(f.deps, { scope: f.scope, relativePath: "flip.md", baseRevision: revision, requestId: "req-3", content: "# mine\n", bom: false },
      { beforeKeep: () => writeFileSync(path, "# B\n"), beforeCommit: () => { flippedBack = true; writeFileSync(path, "# A\n"); } }));
    expect(error.code).toBe("revision-conflict");
    // Refused at the copy, before the flip back could hide the change.
    expect(flippedBack).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# B\n");
    expect(error.currentRevision).toBe(readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "flip.md" }).revision);
    // Nothing kept, nothing staged left behind.
    expect(f.artifactCount()).toBe(0);
    expect(readdirSync(f.taskRoot)).toEqual(["flip.md"]);
    // The recheck by itself could not have refused: A flipped back is the base revision again.
    writeFileSync(path, "# A\n");
    expect(readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "flip.md" }).revision).toBe(revision);
  });

  it("leaves no Files entry when the file is rewritten in the same tick after Save version checked it", () => {
    const f = fixture();
    const path = f.put("v.md", "one");
    const now = Date.now();
    held.set(inode(lstatSync(path)), { mtimeMs: now, ctimeMs: now });
    const revision = readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "v.md" }).revision;
    const error = refusal(() => saveWorkspaceVersion(f.deps, { scope: f.scope, relativePath: "v.md", revision }, { beforeKeep: () => writeFileSync(path, "two") }));
    expect([error.code, error.currentRevision]).toEqual(["revision-conflict", readWorkspaceFile(f.deps, { scope: f.scope, relativePath: "v.md" }).revision]);
    expect(f.artifactCount()).toBe(0);
    expect(existsSync(f.storage) ? readdirSync(f.storage) : []).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("two");
  });
});

describe("remembered digests", () => {
  it("reuses a digest only for a settled state, and the next write is read again", () => {
    const f = fixture();
    const path = f.put("c.md", "settled");
    const key = inode(lstatSync(path)), old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    // ctime of its own, as after a rename or chmod (a plain write leaves it
    // equal to mtime, and such a state is never remembered: see below).
    held.set(key, { mtimeMs: old, ctimeMs: old + 1 });
    const opens = () => opened.filter(item => item === path).length;

    const first = workspaceRevisionOf(f.taskRoot, "c.md", lstatSync(path));
    expect(first.ok).toBe(true);
    expect(opens()).toBe(1);
    expect(workspaceRevisionOf(f.taskRoot, "c.md", lstatSync(path))).toEqual(first);
    expect(opens()).toBe(1);

    // A write moves ctime, which no caller can set; the tool puts mtime back.
    writeFileSync(path, "changed");
    held.set(key, { mtimeMs: old, ctimeMs: Date.now() });
    const second = workspaceRevisionOf(f.taskRoot, "c.md", lstatSync(path));
    expect(second.ok && first.ok && second.revision !== first.revision).toBe(true);
    expect(opens()).toBe(2);
    // Still settling: read again on every observation.
    expect(workspaceRevisionOf(f.taskRoot, "c.md", lstatSync(path))).toEqual(second);
    expect(opens()).toBe(3);
  });

  it("hashes each file of a settled listing once", () => {
    const f = fixture();
    const old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    for (let index = 0; index < 20; index++) {
      const path = f.put(`many/f${String(index).padStart(2, "0")}.md`, `file ${index}\n`);
      held.set(inode(lstatSync(path)), { mtimeMs: old, ctimeMs: old + 1 });
    }
    const list = () => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "many" }).entries.map(entry => entry.revision);
    const first = list();
    expect(first).toHaveLength(20);
    expect(first.every(Boolean)).toBe(true);
    expect(opened.filter(item => item.includes("/many/")).length).toBe(20);
    expect(list()).toEqual(first);
    expect(opened.filter(item => item.includes("/many/")).length).toBe(20);
  });

  it("never remembers a state whose ctime equals mtime on a volume that failed the clock probe, so a rewrite that puts mtime back is read again", () => {
    // A plain write sets both stamps from one clock reading; a mount without
    // a change time of its own mirrors mtime into ctime. They look the same,
    // and only on the second does a rewrite that restores mtime move nothing.
    __setVolumeClockForTests(false);
    const f = fixture();
    const path = f.put("d.md", "settled!");
    const key = inode(lstatSync(path)), old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    held.set(key, { mtimeMs: old, ctimeMs: old });
    const opens = () => opened.filter(item => item === path).length;
    const first = workspaceRevisionOf(f.taskRoot, "d.md", lstatSync(path));
    expect(first.ok).toBe(true);
    expect(opens()).toBe(1);
    expect(workspaceRevisionOf(f.taskRoot, "d.md", lstatSync(path))).toEqual(first);
    expect(opens()).toBe(2);
    // Equal-length rewrite; every stamp held: the fingerprint is unchanged.
    writeFileSync(path, "changed!");
    const rewritten = lstatSync(path);
    expect(artifactSourceFingerprint(rewritten)).toBe(artifactSourceFingerprint(lstatSync(path)));
    const second = workspaceRevisionOf(f.taskRoot, "d.md", rewritten);
    expect(second.ok && first.ok && second.revision !== first.revision).toBe(true);
    expect(opens()).toBe(3);
    // A state with a ctime of its own is still remembered there.
    held.set(key, { mtimeMs: old, ctimeMs: old + 1 });
    const own = workspaceRevisionOf(f.taskRoot, "d.md", lstatSync(path));
    expect(workspaceRevisionOf(f.taskRoot, "d.md", lstatSync(path))).toEqual(own);
    expect(opens()).toBe(4);
  });

  it("remembers a settled ctime-equals-mtime state on a volume that passed the clock probe, and any change to it is read again", () => {
    // On a volume whose ctime is the kernel's own, equal stamps are exactly
    // "written once, never changed since": a plain write moves both, a
    // rewrite that restores mtime still moves ctime.
    __setVolumeClockForTests(true);
    const f = fixture();
    const path = f.put("e.md", "settled!");
    const key = inode(lstatSync(path)), old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    held.set(key, { mtimeMs: old, ctimeMs: old });
    const opens = () => opened.filter(item => item === path).length;
    const first = workspaceRevisionOf(f.taskRoot, "e.md", lstatSync(path));
    expect(first.ok).toBe(true);
    expect(opens()).toBe(1);
    expect(workspaceRevisionOf(f.taskRoot, "e.md", lstatSync(path))).toEqual(first);
    expect(opens()).toBe(1);

    // Rewrite that puts mtime back: ctime moves on such a volume.
    writeFileSync(path, "changed!");
    held.set(key, { mtimeMs: old, ctimeMs: old + 2 * WORKSPACE_REVISION_SETTLE_MS });
    const second = workspaceRevisionOf(f.taskRoot, "e.md", lstatSync(path));
    expect(second.ok && first.ok && second.revision !== first.revision).toBe(true);
    expect(second.ok && second.sha256).toBe(sha256Hex(Buffer.from("changed!")));
    expect(opens()).toBe(2);
    expect(workspaceRevisionOf(f.taskRoot, "e.md", lstatSync(path))).toEqual(second);
    expect(opens()).toBe(2);

    // Plain rewrite: both stamps move, and while it settles it is read every time.
    writeFileSync(path, "settled?");
    const now = Date.now();
    held.set(key, { mtimeMs: now, ctimeMs: now });
    const third = workspaceRevisionOf(f.taskRoot, "e.md", lstatSync(path));
    expect(third.ok && second.ok && third.revision !== second.revision).toBe(true);
    expect(opens()).toBe(3);
    expect(workspaceRevisionOf(f.taskRoot, "e.md", lstatSync(path))).toEqual(third);
    expect(opens()).toBe(4);
  });

  it("hashes each plain-written file of a settled listing on every page on an untrusted volume, once on a trusted one", () => {
    const f = fixture();
    const old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    for (let index = 0; index < 20; index++) {
      const path = f.put(`plain/f${String(index).padStart(2, "0")}.md`, `file ${index}\n`);
      held.set(inode(lstatSync(path)), { mtimeMs: old, ctimeMs: old });
    }
    const list = () => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "plain" }).entries.map(entry => entry.revision);
    const opens = () => opened.filter(item => item.includes("/plain/")).length;
    __setVolumeClockForTests(false);
    const first = list();
    expect(first).toHaveLength(20);
    expect(first.every(Boolean)).toBe(true);
    expect(opens()).toBe(20);
    expect(list()).toEqual(first);
    expect(opens()).toBe(40);
    __setVolumeClockForTests(true);
    expect(list()).toEqual(first);
    expect(opens()).toBe(60);
    expect(list()).toEqual(first);
    expect(opens()).toBe(60);
  });

  it("never remembers whole-second stamps or a stamp ahead of the clock", () => {
    const f = fixture();
    const opens = (path: string) => opened.filter(item => item === path).length;
    const old = Math.floor((Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS) / 1000) * 1000;

    const coarse = f.put("coarse.md", "whole seconds");
    held.set(inode(lstatSync(coarse)), { mtimeMs: old, ctimeMs: old + 1000 });
    const first = workspaceRevisionOf(f.taskRoot, "coarse.md", lstatSync(coarse));
    expect(workspaceRevisionOf(f.taskRoot, "coarse.md", lstatSync(coarse))).toEqual(first);
    expect(opens(coarse)).toBe(2);

    const ahead = f.put("ahead.md", "future ctime");
    held.set(inode(lstatSync(ahead)), { mtimeMs: old + 1, ctimeMs: Date.now() + 60_000 });
    const early = workspaceRevisionOf(f.taskRoot, "ahead.md", lstatSync(ahead));
    expect(workspaceRevisionOf(f.taskRoot, "ahead.md", lstatSync(ahead))).toEqual(early);
    expect(opens(ahead)).toBe(2);
  });

  it("decides from the stamps and the volume verdict alone", () => {
    const now = 1_800_000_000_000.5, settled = now - 2 * WORKSPACE_REVISION_SETTLE_MS;
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: settled + 0.001 }, now)).toBe(true);
    expect(canRememberDigest({ mtimeMs: settled + 0.001, ctimeMs: settled }, now)).toBe(true);
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: settled }, now)).toBe(false);
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: settled }, now, false)).toBe(false);
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: settled }, now, true)).toBe(true);
    // The verdict lifts only the equal-stamps rule.
    expect(canRememberDigest({ mtimeMs: 1_799_999_990_000, ctimeMs: 1_799_999_990_000 }, now, true)).toBe(false);
    expect(canRememberDigest({ mtimeMs: now + 1, ctimeMs: now + 1 }, now, true)).toBe(false);
    expect(canRememberDigest({ mtimeMs: now - 1, ctimeMs: now - 1 }, now, true)).toBe(false);
    expect(canRememberDigest({ mtimeMs: 1_799_999_990_000, ctimeMs: 1_799_999_991_000 }, now)).toBe(false);
    expect(canRememberDigest({ mtimeMs: 1_799_999_990_000, ctimeMs: 1_799_999_990_000.5 }, now)).toBe(true);
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: now + 1 }, now)).toBe(false);
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: now - WORKSPACE_REVISION_SETTLE_MS + 1 }, now)).toBe(false);
    expect(canRememberDigest({ mtimeMs: settled, ctimeMs: now - WORKSPACE_REVISION_SETTLE_MS }, now)).toBe(true);
    expect(canRememberDigest({ mtimeMs: Number.NaN, ctimeMs: settled }, now)).toBe(false);
  });

  it("keeps the metadata identity above the text limit without reading the file", () => {
    const f = fixture();
    const path = f.put("big.bin", Buffer.alloc(WORKSPACE_REVISION_CONTENT_MAX_BYTES + 1));
    const result = workspaceRevisionOf(f.taskRoot, "big.bin", lstatSync(path));
    expect(result).toMatchObject({ ok: true, sha256: null });
    expect(opened.filter(item => item === path)).toEqual([]);
  });
});

describe("the volume clock probe", () => {
  const settledPlain = (f: ReturnType<typeof fixture>, name: string) => {
    const path = f.put(name, `plain ${name}`);
    const old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    held.set(inode(lstatSync(path)), { mtimeMs: old, ctimeMs: old });
    return path;
  };
  const leftovers = (dir: string) => readdirSync(dir).filter(name => name.startsWith(".murage-clock-probe-"));

  it("passes on this machine's temp volume with one hidden file that is gone afterwards", () => {
    // The build Mac (APFS) and the Linux runners (ext4, overlay) keep a
    // change time of their own with sub-second stamps.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-clock-probe-"))); roots.push(dir);
    expect(probeVolumeClock(dir)).toBe(true);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.startsWith(`${dir}/.murage-clock-probe-`)).toBe(true);
    expect(leftovers(dir)).toEqual([]);
  });

  it("is asked once per volume, only for a settled ctime-equals-mtime state, and the verdict then serves every file", () => {
    const f = fixture();
    const own = f.put("own.md", "renamed or chmod'ed");
    const old = Date.now() - 10 * WORKSPACE_REVISION_SETTLE_MS;
    held.set(inode(lstatSync(own)), { mtimeMs: old, ctimeMs: old + 1 });
    workspaceRevisionOf(f.taskRoot, "own.md", lstatSync(own));
    const fresh = f.put("fresh.md", "still settling");
    workspaceRevisionOf(f.taskRoot, "fresh.md", lstatSync(fresh));
    // Neither state needed the volume's word.
    expect(probes).toEqual([]);

    const a = settledPlain(f, "a.md"), b = settledPlain(f, "sub/b.md");
    const opens = (path: string) => opened.filter(item => item === path).length;
    const first = workspaceRevisionOf(f.taskRoot, "a.md", lstatSync(a));
    expect(probes).toHaveLength(1);
    expect(workspaceRevisionOf(f.taskRoot, "a.md", lstatSync(a))).toEqual(first);
    expect(opens(a)).toBe(1);
    const second = workspaceRevisionOf(f.taskRoot, "sub/b.md", lstatSync(b));
    expect(workspaceRevisionOf(f.taskRoot, "sub/b.md", lstatSync(b))).toEqual(second);
    expect(opens(b)).toBe(1);
    expect(probes).toHaveLength(1);
    expect(leftovers(f.taskRoot)).toEqual([]);
    // Discovery pages ride on the same verdict.
    const list = () => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "sub" }).entries.map(entry => entry.revision);
    expect(list()).toEqual(list());
    expect(opens(b)).toBe(1);
    expect(probes).toHaveLength(1);
  });

  it("never lends the root's verdict to a volume mounted inside it: a file on another device is hashed on every observation", () => {
    // A listing descends into mount points. The root (APFS, ext4) passes the
    // probe, but a file on an image or share mounted below it reports that
    // volume's device number, which nobody probed; there ctime may mirror
    // mtime, and a rewrite that restores mtime keeps every field.
    const f = fixture();
    const own = settledPlain(f, "own.md");
    const first = workspaceRevisionOf(f.taskRoot, "own.md", lstatSync(own));
    expect(probes).toHaveLength(1);
    expect(workspaceRevisionOf(f.taskRoot, "own.md", lstatSync(own))).toEqual(first);
    expect(opened.filter(item => item === own)).toHaveLength(1);

    const nested = settledPlain(f, "mnt/foreign.md");
    const foreignDev = lstatSync(f.taskRoot).dev + 6, foreignIno = lstatSync(nested).ino;
    volume.shape = stat => { if (stat.ino === foreignIno) { stat.dev = foreignDev; stat.ctimeMs = stat.mtimeMs; } };
    expect(lstatSync(nested).dev).toBe(foreignDev);
    const opens = () => opened.filter(item => item === nested).length;
    const observed = workspaceRevisionOf(f.taskRoot, "mnt/foreign.md", lstatSync(nested));
    expect(observed.ok && observed.sha256).toBe(sha256Hex(Buffer.from("plain mnt/foreign.md")));
    expect(workspaceRevisionOf(f.taskRoot, "mnt/foreign.md", lstatSync(nested))).toEqual(observed);
    expect(opens()).toBe(2);
    // The root's pass did not carry over, and no probe file was written for
    // the foreign device, in the root or under mnt/.
    expect(probes).toHaveLength(1);
    expect(leftovers(f.taskRoot)).toEqual([]);
    expect(leftovers(join(f.taskRoot, "mnt"))).toEqual([]);
    // An equal-length in-place rewrite that puts mtime back keeps the
    // fingerprint; the bytes are read again and the new digest is issued.
    const before = lstatSync(nested);
    writeFileSync(nested, "PLAIN MNT/FOREIGN.MD");
    const after = lstatSync(nested);
    expect(workspaceStatFingerprint(after)).toBe(workspaceStatFingerprint(before));
    const rewritten = workspaceRevisionOf(f.taskRoot, "mnt/foreign.md", after);
    expect(rewritten.ok && rewritten.sha256).toBe(sha256Hex(Buffer.from("PLAIN MNT/FOREIGN.MD")));
    expect(rewritten).not.toEqual(observed);
    expect(opens()).toBe(3);
    // Discovery under mnt/ pays the same: every page reads the file again.
    const list = () => listWorkspaceDirectory(f.deps, { scope: f.scope, directory: "mnt" }).entries.map(entry => entry.revision);
    expect(list()).toEqual(list());
    expect(opens()).toBe(5);
    expect(probes).toHaveLength(1);
    // The root's own files still ride on its verdict.
    expect(workspaceRevisionOf(f.taskRoot, "own.md", lstatSync(own))).toEqual(first);
    expect(opened.filter(item => item === own)).toHaveLength(1);
  });

  it("fails a mount that mirrors mtime into ctime, and such a volume keeps hashing on every observation", () => {
    volume.shape = stat => { stat.ctimeMs = stat.mtimeMs; };
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-clock-probe-"))); roots.push(dir);
    expect(probeVolumeClock(dir)).toBe(false);
    expect(leftovers(dir)).toEqual([]);

    const f = fixture();
    const path = settledPlain(f, "m.md");
    const opens = () => opened.filter(item => item === path).length;
    const first = workspaceRevisionOf(f.taskRoot, "m.md", lstatSync(path));
    expect(first.ok).toBe(true);
    expect(workspaceRevisionOf(f.taskRoot, "m.md", lstatSync(path))).toEqual(first);
    expect(opens()).toBe(2);
    // The failure is held: no new probe file per observation.
    expect(probes.filter(item => item.startsWith(f.taskRoot))).toHaveLength(1);
    // A rewrite that restores mtime moves nothing on such a mount, and the
    // bytes are still read: no remembered digest names them.
    writeFileSync(path, "m.md rewritten");
    held.set(inode(lstatSync(path)), { mtimeMs: lstatSync(path).mtimeMs - 10 * WORKSPACE_REVISION_SETTLE_MS, ctimeMs: 0 });
    const rewritten = workspaceRevisionOf(f.taskRoot, "m.md", lstatSync(path));
    expect(rewritten.ok && rewritten.sha256).toBe(sha256Hex(Buffer.from("m.md rewritten")));
  });

  it("fails whole-second stamps and a clock that runs ahead", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-clock-probe-"))); roots.push(dir);
    volume.shape = stat => { stat.mtimeMs = Math.floor(stat.mtimeMs / 1000) * 1000; stat.ctimeMs = Math.floor(stat.ctimeMs / 1000) * 1000; };
    expect(probeVolumeClock(dir)).toBe(false);
    volume.shape = stat => { stat.mtimeMs += 30_000; stat.ctimeMs += 30_000; };
    expect(probeVolumeClock(dir)).toBe(false);
    volume.shape = stat => { stat.ctimeMs += 30_000; };
    expect(probeVolumeClock(dir)).toBe(false);
    // ctime that never moves (a mount reporting the birth time as ctime).
    let birth: number | undefined;
    volume.shape = stat => { birth ??= stat.ctimeMs; stat.ctimeMs = birth; };
    expect(probeVolumeClock(dir)).toBe(false);
    expect(leftovers(dir)).toEqual([]);
  });

  it("fails where the root cannot be written, leaves nothing behind, and is asked again after the retry window", () => {
    const f = fixture();
    const path = settledPlain(f, "ro.md");
    chmodSync(f.taskRoot, 0o500);
    try {
      const opens = () => opened.filter(item => item === path).length;
      const first = workspaceRevisionOf(f.taskRoot, "ro.md", lstatSync(path));
      expect(first.ok).toBe(true);
      expect(probes).toHaveLength(1);
      expect(workspaceRevisionOf(f.taskRoot, "ro.md", lstatSync(path))).toEqual(first);
      expect(opens()).toBe(2);
      expect(probes).toHaveLength(1);
      expect(leftovers(f.taskRoot)).toEqual([]);
    } finally { chmodSync(f.taskRoot, 0o700); }
    const later = Date.now() + VOLUME_CLOCK_RETRY_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const again = workspaceRevisionOf(f.taskRoot, "ro.md", lstatSync(path));
    expect(probes).toHaveLength(2);
    // Writable again, the volume passes and the state is remembered.
    expect(workspaceRevisionOf(f.taskRoot, "ro.md", lstatSync(path))).toEqual(again);
    expect(opened.filter(item => item === path)).toHaveLength(3);
    expect(probes).toHaveLength(2);
  });
});
