// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F6 (designs/NOLIMITS-V1-CUT.md) under Windows path semantics, on every host. outside-wire.ts builds every folder it lists
// with node:path, so on Windows the paths it hands the disk carry a drive and backslashes. This file loads outside-wire.ts
// with node:path replaced by path.win32 and a disk in memory keyed by the exact Windows spelling a real disk answers to
// (drive letter, backslashes, names compared without case), so the same marks the POSIX rows of nolimits-v1-v5.test.ts
// prove are proved for a Windows folder too. Every value here is fake.
import nodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FsHooks } from "./download-registry.ts";
import type { DlScan, ListDir } from "./outside-wire.ts";

type Wire = typeof import("./outside-wire.ts");
type Registry = typeof import("./download-registry.ts");
let wire: Wire;
let reg: Registry;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("node:path", () => ({ ...nodePath.win32, default: nodePath.win32 }));
  wire = await import("./outside-wire.ts");
  reg = await import("./download-registry.ts");
});
afterAll(() => { vi.doUnmock("node:path"); vi.resetModules(); });

interface Node { dir?: boolean; ctime: number }
const win = nodePath.win32;
/** A Windows disk in memory. A path is found only in a spelling Windows itself resolves: `/` and `\` both separate, names
 *  compare without case, and a path with no drive (`\w\a`) or a drive with no root (`C:a`) is NOT this disk's `C:\...`. */
function winDisk(nodes: Record<string, Node>, broken: readonly string[] = []) {
  const key = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() || "\\";
  const table = new Map(Object.entries(nodes).map(([p, n]) => [key(p), { path: p, node: n }]));
  const bad = new Set(broken.map(key));
  const asked: string[] = [];
  const find = (p: string) => { asked.push(p); if (bad.has(key(p))) throw new Error("EIO"); return table.get(key(p)); };
  const fs: FsHooks = {
    lstat: (p) => { const hit = find(p); return hit ? { dir: hit.node.dir === true, ctime: hit.node.ctime } : null; },
    realpath: (p) => find(p)?.path ?? null,
  };
  const listDir: ListDir = (p) => {
    const hit = find(p);
    if (!hit?.node.dir) return null;
    return [...table.values()].filter((e) => e.path !== hit.path && key(win.dirname(e.path)) === key(hit.path)).map((e) => ({ name: win.basename(e.path), dir: e.node.dir === true }));
  };
  return { fs, listDir, asked };
}
const folders = (...paths: string[]): Record<string, Node> => Object.fromEntries(paths.map((p) => [p, { dir: true, ctime: 1 }]));
const spanned = (since: number, until: number) => { const r = new reg.DownloadRegistry(); r.add([{ path: "C:\\", kind: "span", since, until }]); return r; };

describe("F6 on a Windows folder (drive cwd, win32 path rules): instruction files below the working folder", () => {
  const deep = () => ({ ...folders("C:\\w", "C:\\w\\.git", "C:\\w\\a", "C:\\w\\a\\b", "C:\\w\\a\\b\\c", "C:\\w\\a\\b\\c\\d"), "C:\\w\\a\\b\\c\\d\\GEMINI.md": { ctime: 1500 } });
  it("the module under test resolves with the Windows path rules (a drive path is absolute, a backslash separates)", async () => {
    const mocked = await import("node:path");
    expect(mocked.sep).toBe("\\");
    expect(mocked.isAbsolute("C:\\w")).toBe(true);
    expect(mocked.join("C:\\w", "a")).toBe("C:\\w\\a");
  });
  it("C:\\w\\a\\b\\c\\d\\GEMINI.md written inside a span marks, with no depth cutoff; every folder is asked for by its drive path", () => {
    const { fs, listDir, asked } = winDisk(deep());
    expect(wire.cwdOutsideMark("C:\\w", spanned(1000, 2000), fs, "geminiAgent", listDir)).toBe("cloned folder");
    expect(asked).toContain("C:\\w\\a\\b\\c\\d");
    expect(asked.filter((p) => !/^C:[\\/]/.test(p))).toEqual([]);
  });
  it("the same file written outside every span is clean (the listing reaches it: it is not the fail-closed mark of a missed folder)", () => {
    const { fs, listDir, asked } = winDisk(deep());
    expect(wire.cwdOutsideMark("C:\\w", spanned(3000, 4000), fs, "geminiAgent", listDir)).toBeNull();
    expect(asked).toContain("C:\\w\\a\\b\\c\\d\\GEMINI.md");
  });
  it("a forward-slash and a lower-case spelling of the same cwd give the same marks", () => {
    for (const cwd of ["C:/w", "c:\\W", "C:\\w\\"]) {
      const marked = winDisk(deep()), clean = winDisk(deep());
      expect(wire.cwdOutsideMark(cwd, spanned(1000, 2000), marked.fs, "geminiAgent", marked.listDir), cwd).toBe("cloned folder");
      expect(wire.cwdOutsideMark(cwd, spanned(3000, 4000), clean.fs, "geminiAgent", clean.listDir), cwd).toBeNull();
    }
  });
  it("a listing that reaches the engine's folder bound marks; one under it is clean", () => {
    const many: Record<string, Node> = folders("C:\\w", "C:\\w\\.git");
    for (let i = 0; i < wire.BELOW_CWD_MAX_DIRS + 5; i++) many[`C:\\w\\f${i}`] = { dir: true, ctime: 1 };
    const big = winDisk(many);
    expect(wire.cwdOutsideMark("C:\\w", spanned(1000, 2000), big.fs, "geminiAgent", big.listDir)).toBe("cloned folder");
    const few: Record<string, Node> = folders("C:\\w", "C:\\w\\.git");
    for (let i = 0; i < 20; i++) few[`C:\\w\\f${i}`] = { dir: true, ctime: 1 };
    const small = winDisk(few);
    expect(wire.cwdOutsideMark("C:\\w", spanned(1000, 2000), small.fs, "geminiAgent", small.listDir)).toBeNull();
  });
  it("a folder that cannot be listed marks", () => {
    const { fs, listDir } = winDisk(deep(), ["C:\\w\\a\\b"]);
    expect(wire.cwdOutsideMark("C:\\w", spanned(3000, 4000), fs, "geminiAgent", listDir)).toBe("cloned folder");
  });
});

describe("F6 on a Windows folder: a Claude read loads CLAUDE.md beside the read path", () => {
  const disk = (nested: string | null, root = "C:\\w") => winDisk({
    ...folders(root, win.join(root, "a"), win.join(root, "a", "b")), [win.join(root, "a", "b", "x.ts")]: { ctime: 1 },
    ...(nested ? { [nested]: { ctime: 1500 } } : {}),
  });
  const scan = (d: ReturnType<typeof winDisk>, cwd = "C:\\w"): DlScan => ({ registry: spanned(1000, 2000), cwd, home: "C:\\h", budget: new reg.TextBudget(d.fs), pathFolders: [], listDir: d.listDir });
  const read = (file_path: string) => ({ origin: "engine" as const, title: "Read", input: { file_path } });
  it("a nested instruction file from the cwd down to the read path, written in a span, marks; none: clean", () => {
    expect(wire.toolStartOutside(read("C:\\w\\a\\b\\x.ts"), scan(disk("C:\\w\\a\\CLAUDE.md")))).toBe("cloned folder");
    expect(wire.toolStartOutside(read("C:\\w\\a\\b\\x.ts"), scan(disk("C:\\w\\a\\b\\CLAUDE.md")))).toBe("cloned folder");
    expect(wire.toolStartOutside(read("C:\\w\\a\\b\\x.ts"), scan(disk(null)))).toBeNull();
  });
  it("the read path in forward slashes or another case, and a cwd with a trailing separator, mark the same", () => {
    for (const [file, cwd] of [["C:/w/a/b/x.ts", "C:\\w"], ["c:\\W\\A\\b\\x.ts", "C:\\w"], ["C:\\w\\a\\b\\x.ts", "C:\\w\\"], ["C:\\w\\a\\b\\x.ts", "c:/w/"]] as const) {
      expect(wire.toolStartOutside(read(file), scan(disk("C:\\w\\a\\CLAUDE.md"), cwd)), `${file} in ${cwd}`).toBe("cloned folder");
      expect(wire.toolStartOutside(read(file), scan(disk(null), cwd)), `${file} in ${cwd}`).toBeNull();
    }
  });
  it("a folder on the way that cannot be listed marks", () => {
    const d = winDisk({ ...folders("C:\\w", "C:\\w\\a", "C:\\w\\a\\b"), "C:\\w\\a\\b\\x.ts": { ctime: 1 } }, ["C:\\w\\a"]);
    expect(wire.toolStartOutside(read("C:\\w\\a\\b\\x.ts"), scan(d))).not.toBeNull();
  });
  it("a working folder that is a drive root: every folder from the root down to the read path is still checked", () => {
    for (const cwd of ["C:\\", "C:/", "c:\\"]) {
      const d = disk("C:\\a\\CLAUDE.md", "C:\\");
      expect(wire.toolStartOutside(read("C:\\a\\b\\x.ts"), scan(d, cwd)), cwd).toBe("cloned folder");
      expect(d.asked.map((p) => p.toLowerCase()), cwd).toContain("c:\\a");
      expect(d.asked.filter((p) => !/^C:[\\/]/i.test(p)), cwd).toEqual([]);
      expect(wire.toolStartOutside(read("C:\\a\\b\\x.ts"), scan(disk(null, "C:\\"), cwd)), cwd).toBeNull();
    }
  });
  it("a read on another drive checks its own folder", () => {
    const d = winDisk({ ...folders("C:\\w", "D:\\p"), "D:\\p\\x.ts": { ctime: 1 }, "D:\\p\\CLAUDE.md": { ctime: 1500 } });
    expect(wire.toolStartOutside(read("D:\\p\\x.ts"), scan(d))).toBe("cloned folder");
  });
});
