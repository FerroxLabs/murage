// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Path resolution on approval paths, the win32 rows
// (lanes/release103/APP-GRANT-FIXPLAN-r6.md section (b); Rules 63.2, 63.3,
// 67 and 75d). The tree is a fake Windows disk behind node:fs: drive paths
// (`C:\...`) are served from it with Windows rules (names compare without
// letter case, and a path handed to the system is collapsed lexically before
// any link in it is read, as the Win32 API does), every other path goes to
// the real disk. The posix rows are in server/path-resolution.behaviour.test.ts.

import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Node = { kind: "dir" } | { kind: "file"; text: string } | { kind: "link"; to: string };

const disk = vi.hoisted(() => ({ nodes: new Map<string, { node: Node; shown: string }>() }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const { win32: w } = await import("node:path");
  const isDrive = (path: unknown): path is string => typeof path === "string" && /^[A-Za-z]:[\\/]/.test(path);
  const key = (path: string) => {
    const n = w.normalize(path);
    return (n.length > 3 ? n.replace(/\\+$/, "") : n).toLowerCase();
  };
  const fail = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });
  // Win32: collapse lexically, then walk each part, following links
  const resolve = (path: string, followLast = true, depth = 0): string => {
    if (depth > 20) throw fail("ELOOP", path);
    const n = w.normalize(path);
    const root = w.parse(n).root;
    if (!disk.nodes.has(key(root))) throw fail("ENOENT", path);
    let cur = disk.nodes.get(key(root))!.shown;
    const parts = n.slice(root.length).split("\\").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = w.join(cur, parts[i]!);
      const hit = disk.nodes.get(key(next));
      if (!hit) throw fail("ENOENT", path);
      if (hit.node.kind === "link" && (followLast || i < parts.length - 1)) cur = resolve(hit.node.to, true, depth + 1);
      else cur = hit.shown;
    }
    return cur;
  };
  const stat = (path: string, follow: boolean) => {
    const at = resolve(path, follow);
    const node = disk.nodes.get(key(at))!.node;
    return {
      dev: 1, ino: 1, size: node.kind === "file" ? node.text.length : 0, mtimeMs: 0,
      isDirectory: () => node.kind === "dir", isFile: () => node.kind === "file", isSymbolicLink: () => node.kind === "link",
    };
  };
  const realpath = Object.assign((path: unknown, ...rest: unknown[]) => (isDrive(path) ? resolve(path) : (real.realpathSync as any)(path, ...rest)), {
    native: (path: unknown, ...rest: unknown[]) => (isDrive(path) ? resolve(path) : (real.realpathSync.native as any)(path, ...rest)),
  });
  return {
    ...real,
    lstatSync: (path: unknown, ...rest: unknown[]) => (isDrive(path) ? stat(path, false) : (real.lstatSync as any)(path, ...rest)),
    statSync: (path: unknown, ...rest: unknown[]) => (isDrive(path) ? stat(path, true) : (real.statSync as any)(path, ...rest)),
    existsSync: (path: unknown) => {
      if (!isDrive(path)) return real.existsSync(path as string);
      try { resolve(path); return true; } catch { return false; }
    },
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (!isDrive(path)) return (real.readFileSync as any)(path, ...rest);
      const node = disk.nodes.get(key(resolve(path)))!.node;
      if (node.kind !== "file") throw fail("EISDIR", path);
      return node.text;
    },
    readdirSync: (path: unknown, ...rest: unknown[]) => {
      if (!isDrive(path)) return (real.readdirSync as any)(path, ...rest);
      const at = key(resolve(path));
      return [...disk.nodes.entries()].filter(([k]) => k !== at && w.dirname(k) === at).map(([, v]) => w.basename(v.shown));
    },
    realpathSync: realpath,
  };
});

import type { EnvStateLike } from "./disk-facts.ts";

// The suite's setup file may already have loaded these modules over the real disk; load them again over the fake one.
vi.resetModules();
const inProject = await import("./in-project.ts");
const { diskFacts } = await import("./disk-facts.ts");
const { HookDecisionTable } = await import("../server/drivers/codex-hook.ts");
const stopLineState = await import("../server/stop-line-state.ts");
const { realKeyPaths } = await import("../server/auto-approve.ts");

const dir = (path: string) => {
  const n = win32.normalize(path);
  const shown = n.length > 3 ? n.replace(/\\+$/, "") : n;
  disk.nodes.set(shown.toLowerCase(), { node: { kind: "dir" }, shown });
};
const file = (path: string, text = "") => disk.nodes.set(win32.normalize(path).toLowerCase(), { node: { kind: "file", text }, shown: win32.normalize(path) });
const link = (path: string, to: string) => disk.nodes.set(win32.normalize(path).toLowerCase(), { node: { kind: "link", to }, shown: win32.normalize(path) });

// C:\w\proj\link -> C:\out\sub, so link\.. is C:\out and never C:\w\proj
beforeEach(() => {
  disk.nodes.clear();
  for (const d of ["C:\\", "C:\\w", "C:\\w\\proj", "C:\\out", "C:\\out\\sub", "C:\\out\\g", "C:\\w\\proj\\g", "C:\\h", "C:\\t", "C:\\t\\sub", "C:\\repo", "C:\\repo\\.git"]) dir(d);
  link("C:\\w\\proj\\link", "C:\\out\\sub");
  link("C:\\h\\link", "C:\\t\\sub");
  file("C:\\out\\x", "x");
  file("C:\\w\\proj\\x", "decoy");
  file("C:\\out\\g\\config", "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/ada/real.git\n");
  file("C:\\w\\proj\\g\\config", "[include]\n\tpath = other\n[remote \"origin\"]\n\turl = https://github.com/ada/lexical.git\n");
  file("C:\\w\\proj\\.git", "gitdir: link/../g\n");
  file("C:\\repo\\.git\\config", "[core]\n\tbare = false\n");
  file("C:\\t\\.gitconfig", "[include]\n\tpath = x\n");
});

// The modules that read the running platform (the hook table, the stop-line state) see Windows for one call.
const asWindows = <T>(run: () => T): T => {
  const was = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { return run(); } finally { Object.defineProperty(process, "platform", was); }
};
afterEach(() => disk.nodes.clear());

const W = { platform: "win32" as const };
const facts = (home: string, systemConfig = "C:\\nope\\gitconfig") => diskFacts(new Map([["HOME", home]]), { ...W, systemConfig });
const env: EnvStateLike = new Map([["HOME", { kind: "inherited" }]]);
const toplevel = (cwd: string, home = "C:\\h") => facts(home).substitution({ name: "git", args: ["rev-parse", "--show-toplevel"] }, cwd, env);

describe("realPathInOrder on win32", () => {
  it("climbs from a link's target, keeps a missing tail, and refuses a climb past a missing part", () => {
    expect(inProject.realPathInOrder("link\\..\\x", "C:\\w\\proj", W)).toEqual({ real: "C:\\out\\x", intermediates: ["C:\\out\\sub", "C:\\out", "C:\\out\\x"] });
    expect(inProject.realPathInOrder("LINK/../new.txt", "C:\\w\\proj", W)).toMatchObject({ real: "C:\\out\\new.txt" });
    expect(inProject.realPathInOrder("gone\\..\\x", "C:\\w\\proj", W)).toMatchObject({ cannot: expect.any(String) });
    expect(inProject.realPathInOrder("C:x", "C:\\w\\proj", W)).toMatchObject({ cannot: expect.any(String) });
  });

  it("must-exist mode refuses a missing leaf and a missing ancestor", () => {
    expect(inProject.realPathInOrder("nope", "C:\\w\\proj", { ...W, mustExist: true })).toEqual({ cannot: "missing" });
    expect(inProject.realPathInOrder("gone\\a\\b", "C:\\w\\proj", { ...W, mustExist: true })).toEqual({ cannot: "missing" });
    expect(inProject.realPathInOrder("link\\..\\x", "C:\\w\\proj", { ...W, mustExist: true })).toMatchObject({ real: "C:\\out\\x" });
  });

  it("realDir resolves in order and needs a folder; joinReal takes one name per part", () => {
    expect(inProject.realDir("C:\\h\\link\\..", W)).toBe("C:\\t");
    expect(inProject.realDir("C:\\h\\none", W)).toBeNull();
    expect(inProject.realDir("C:\\out\\x", W)).toBeNull();
    const t = inProject.realDir("C:\\t", W)!;
    expect(inProject.joinReal(t, ".gitconfig")).toEqual({ path: "C:\\t\\.gitconfig" });
    for (const bad of ["a\\b", "a/b", "..", ".", "", "a\u0000b"]) expect(inProject.joinReal(t, bad)).toMatchObject({ cannot: expect.any(String) });
  });

  it("placePath on win32 places link\\..\\x outside the project", () => {
    expect(inProject.placePath("link\\..\\x", "C:\\w\\proj", W)).toMatchObject({ kind: "outside", real: "C:\\out\\x" });
    expect(inProject.placePath("x", "C:\\w\\proj", W)).toMatchObject({ kind: "inside", real: "C:\\w\\proj\\x" });
  });
});

describe("disk facts on win32 (Rule 75d)", () => {
  it("realpath and readlink -f: a missing leaf or ancestor is undefined, link\\..\\x climbs from the link's target", () => {
    const f = facts("C:\\h");
    expect(f.substitution({ name: "realpath", args: ["nope"] }, "C:\\w\\proj", env)).toBeUndefined();
    expect(f.substitution({ name: "realpath", args: ["gone\\a\\b"] }, "C:\\w\\proj", env)).toBeUndefined();
    expect(f.substitution({ name: "readlink", args: ["-f", "gone\\a\\b"] }, "C:\\w\\proj", env)).toBeUndefined();
    expect(f.substitution({ name: "realpath", args: ["link\\..\\x"] }, "C:\\w\\proj", env)).toBe("C:\\out\\x");
    expect(f.substitution({ name: "readlink", args: ["-f", "link\\..\\x"] }, "C:\\w\\proj", env)).toBe("C:\\out\\x");
  });

  it("a `.git` file naming gitdir: link/../g reads the config the link leads to", () => {
    expect(toplevel("C:\\w\\proj")).toBe("C:\\w\\proj");
  });

  it("HOME=C:\\h\\link\\.. reads the chain under the link target's parent; an absent system config is still missing", () => {
    expect(toplevel("C:\\repo", "C:\\h\\link\\..")).toBeUndefined();
    expect(toplevel("C:\\repo", "C:\\h")).toBe("C:\\repo");
    expect(toplevel("C:\\repo", "C:\\no-home")).toBeUndefined();
  });
});

describe("the hook table and the stop-line state on win32", () => {
  it("an allow for C:\\w\\proj\\x does not cover a change naming link\\..\\x", () => {
    asWindows(() => {
      const table = new HookDecisionTable();
      table.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: ["C:\\w\\proj\\x"], cwd: "C:\\w\\proj" });
      expect(table.match({ id: "p1", type: "fileChange", changes: [{ path: "link\\..\\x" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
      const plain = new HookDecisionTable();
      plain.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: ["C:\\w\\proj\\x"], cwd: "C:\\w\\proj" });
      expect(plain.match({ id: "p1", type: "fileChange", changes: [{ path: "c:\\W\\proj\\X" }] }, "t1")).toMatchObject({ ok: true });
    });
  });

  it("the repository a post goes to follows gitdir: link/../g by the link", () => {
    expect(asWindows(() => stopLineState.githubRepoOf("C:\\w\\proj"))).toBe("ada/real");
  });

  it("the stop-line resolver resolves in order, and an unreadable root is dropped", () => {
    expect(asWindows(() => stopLineState.stopLineRealpath("C:\\w\\proj\\link\\..\\y"))).toBe("C:\\out\\y");
    expect(asWindows(() => stopLineState.stopLineRoots(["C:\\w\\proj", "C:\\gone"]))).toEqual(["C:\\w\\proj"]);
  });
});

describe("the link-followed key guard on win32 (1.0.4 F1)", () => {
  it("follows a junction to a key file with either separator, keeps a missing tail, and holds what it cannot follow", () => {
    for (const d of ["C:\\Users", "C:\\Users\\Alice", "C:\\Users\\Alice\\.aws", "C:\\w\\proj\\cfg"]) dir(d);
    file("C:\\Users\\Alice\\.aws\\credentials", "[default]\n");
    link("C:\\w\\proj\\awsdir", "C:\\Users\\Alice\\.aws");
    link("C:\\w\\proj\\cfg\\key", "C:\\Users\\Alice\\.aws\\credentials");
    const opts = { ...W, home: "C:\\Users\\Alice" };
    const creds = "C:\\Users\\Alice\\.aws\\credentials";
    // 0309 A3: each Windows spelling the guard reads is carried with its backslashes as `/` too
    const both = (path: string) => [path, path.replace(/\\/g, "/")];
    expect(realKeyPaths({ path: "awsdir\\credentials" }, undefined, "C:\\w\\proj", opts)).toEqual({ paths: both(creds), cannot: null });
    expect(realKeyPaths({ path: "awsdir/credentials" }, undefined, "C:\\w\\proj", opts)).toEqual({ paths: both(creds), cannot: null });
    expect(realKeyPaths({ file_path: "C:\\w\\proj\\cfg/key" }, undefined, undefined, opts)).toEqual({ paths: both(creds), cannot: null });
    expect(realKeyPaths({ path: "~\\.aws\\credentials" }, undefined, undefined, opts)).toEqual({ paths: both(creds), cannot: null });
    expect(realKeyPaths({ path: "awsdir\\new.txt" }, undefined, "C:\\w\\proj", opts)).toEqual({ paths: both("C:\\Users\\Alice\\.aws\\new.txt"), cannot: null });
    expect(realKeyPaths({ path: "C:awsdir\\credentials" }, undefined, "C:\\w\\proj", opts).cannot).toEqual(expect.any(String));
    expect(realKeyPaths({ path: "gone\\..\\x" }, undefined, "C:\\w\\proj", opts).cannot).toEqual(expect.any(String));
  });
});
