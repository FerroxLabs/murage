// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { NotALinkError, addonTreeRemove, installNoFollowRmSync, noFollowRmSync, nodeTreeFs, removeTreeWithoutFollowing, relinkDirectory, removeLink, removeLinkWithRetry, type LinkFs } from "./link-removal.ts";
import { emulateElectronWindowsRmSync } from "./testing/electron-windows-rmsync.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { forgetExclusionAddon, WINDOWS_NATIVE_FUNCTIONS } from "./engine-exclusion.ts";

const scratch = mkdtempSync(join(tmpdir(), "murage-link-removal-unit-"));
afterAll(() => removeTempDirSync(scratch));
const type = process.platform === "win32" ? "junction" : "dir";
let n = 0;
function linkedSkill() {
  const dir = join(scratch, `case-${++n}`);
  const target = join(dir, "installed-skill");
  mkdirSync(join(target, "scripts"), { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "skill");
  writeFileSync(join(target, "scripts", "run.txt"), "script");
  const discovery = join(dir, "discovery");
  mkdirSync(discovery);
  const link = join(discovery, "my-skill");
  symlinkSync(target, link, type);
  return { dir, target, discovery, link };
}
const intact = (target: string) => existsSync(join(target, "SKILL.md")) && existsSync(join(target, "scripts", "run.txt"));
const gone = (path: string) => !lstatSync(path, { throwIfNoEntry: false });
const errno = (code: string) => Object.assign(new Error(code), { code });
const linkStat = { isSymbolicLink: () => true };
const fakeIo = (over: Partial<LinkFs>, calls: string[]): LinkFs => ({
  lstat: over.lstat ?? (() => linkStat),
  unlink: over.unlink ?? (path => { calls.push(`unlink ${path}`); }),
  rmdir: over.rmdir ?? (path => { calls.push(`rmdir ${path}`); }),
  symlink: over.symlink ?? ((target, path, kind) => { calls.push(`symlink ${kind} ${target} ${path}`); }),
});

describe("removeLink", () => {
  it("removes the link and keeps every file of the folder it points to", () => {
    const c = linkedSkill();
    expect(removeLink(c.link)).toBe(true);
    expect(gone(c.link)).toBe(true);
    expect(intact(c.target)).toBe(true);
    expect(removeLink(c.link)).toBe(false);
  });

  it("refuses a real folder or file and leaves it in place", () => {
    const c = linkedSkill();
    expect(() => removeLink(c.target)).toThrow(NotALinkError);
    writeFileSync(join(c.dir, "plain.txt"), "plain");
    expect(() => removeLink(join(c.dir, "plain.txt"))).toThrow(NotALinkError);
    expect(intact(c.target)).toBe(true);
    expect(readFileSync(join(c.dir, "plain.txt"), "utf8")).toBe("plain");
  });

  it("on Windows falls back to rmdir for a directory link unlink refuses, after checking it is still a link", () => {
    const calls: string[] = [];
    const io = fakeIo({ unlink: () => { throw errno("EPERM"); } }, calls);
    expect(removeLink("C:\\desk\\.claude\\skills\\x", io, "win32")).toBe(true);
    expect(calls).toEqual(["rmdir C:\\desk\\.claude\\skills\\x"]);
    // swapped for a real folder between the two checks: refused, not removed
    let first = true;
    const swapped = fakeIo({ lstat: () => (first ? ((first = false), linkStat) : { isSymbolicLink: () => false }), unlink: () => { throw errno("EPERM"); } }, calls);
    expect(() => removeLink("C:\\x", swapped, "win32")).toThrow(NotALinkError);
    expect(calls).toEqual(["rmdir C:\\desk\\.claude\\skills\\x"]);
    // elsewhere the error stands
    expect(() => removeLink("/x", fakeIo({ unlink: () => { throw errno("EPERM"); } }, calls), "linux")).toThrow("EPERM");
  });

  it("never calls rmSync, so the app's Windows runtime cannot follow the link", () => {
    const restore = emulateElectronWindowsRmSync();
    try {
      const c = linkedSkill();
      // the emulation is real: rmSync on the link deletes the skill's files
      const d = linkedSkill();
      expect(() => rmSync(d.link)).toThrow("Path is a directory");
      rmSync(d.link, { recursive: true, force: true });
      expect(intact(d.target)).toBe(false);
      expect(removeLink(c.link)).toBe(true);
      expect(intact(c.target)).toBe(true);
    } finally { restore(); }
  });
});

describe("relinkDirectory", () => {
  it("moves a link to a new folder and keeps the old folder's files", () => {
    const c = linkedSkill();
    const next = join(c.dir, "next");
    mkdirSync(next);
    writeFileSync(join(next, "SKILL.md"), "next");
    relinkDirectory(c.link, next);
    expect(readFileSync(join(c.link, "SKILL.md"), "utf8")).toBe("next");
    expect(intact(c.target)).toBe(true);
  });

  it("retries once, then throws; a real folder is never retried or replaced", () => {
    const calls: string[] = [];
    let failures = 1;
    const flaky = fakeIo({ symlink: (_target, _path, kind) => { calls.push(`symlink ${kind}`); if (failures-- > 0) throw errno("EBUSY"); } }, calls);
    relinkDirectory("C:\\l", "C:\\t", flaky, "win32");
    expect(calls).toEqual(["unlink C:\\l", "symlink junction", "unlink C:\\l", "symlink junction"]);
    calls.length = 0;
    const broken = fakeIo({ symlink: () => { calls.push("symlink"); throw errno("EPERM"); } }, calls);
    expect(() => relinkDirectory("/l", "/t", broken, "linux")).toThrow("EPERM");
    expect(calls.filter(call => call === "symlink")).toHaveLength(2);
    calls.length = 0;
    expect(() => relinkDirectory("/l", "/t", fakeIo({ lstat: () => ({ isSymbolicLink: () => false }) }, calls), "linux")).toThrow(NotALinkError);
    expect(calls).toEqual([]);
  });

  it("removeLinkWithRetry retries a failed removal once", () => {
    const calls: string[] = [];
    let failures = 1;
    expect(removeLinkWithRetry("/l", fakeIo({ unlink: path => { calls.push(path); if (failures-- > 0) throw errno("EBUSY"); } }, calls), "linux")).toBe(true);
    expect(calls).toEqual(["/l", "/l"]);
  });
});

describe("noFollowRmSync with the addon's removeTree (Windows)", () => {
  const refuse = { ...nodeTreeFs, lstatEntry: (): never => { throw new Error("the path walk ran"); }, readdir: (): never => { throw new Error("the path walk ran"); } };
  const runtime = () => { throw new Error("reached the runtime"); };

  it("hands every recursive remove to removeTree and never walks a path itself", () => {
    const calls: string[] = [];
    const wrapped = noFollowRmSync(runtime, refuse, () => (path) => { calls.push(path); return true; });
    wrapped(join(scratch, "tree"), { recursive: true, force: true });
    wrapped(Buffer.from(join(scratch, "buffer-tree")), { recursive: true });
    expect(calls).toEqual([join(scratch, "tree"), join(scratch, "buffer-tree")]);
  });

  it("keeps rmSync's force, ENOENT, maxRetries and retryDelay", () => {
    const missing = noFollowRmSync(runtime, refuse, () => () => false);
    expect(() => missing(join(scratch, "gone"), { recursive: true, force: true })).not.toThrow();
    expect(() => missing(join(scratch, "gone"), { recursive: true })).toThrow(expect.objectContaining({ code: "ENOENT", syscall: "rm" }));
    let busy = 2;
    const flaky = () => (): boolean => { if (busy-- > 0) throw errno("EBUSY"); return true; };
    expect(() => noFollowRmSync(runtime, refuse, flaky)(join(scratch, "busy"), { recursive: true, maxRetries: 2, retryDelay: 1 })).not.toThrow();
    busy = 2;
    expect(() => noFollowRmSync(runtime, refuse, flaky)(join(scratch, "busy"), { recursive: true, maxRetries: 1, retryDelay: 1 })).toThrow("EBUSY");
    const denied = noFollowRmSync(runtime, refuse, () => () => { throw errno("EINVAL"); });
    expect(() => denied(join(scratch, "x"), { recursive: true, maxRetries: 5, retryDelay: 1 })).toThrow("EINVAL");
  });

  it("hands removeTree the resolved form the data-dir guard compared, so the addon can refuse any path Windows would read as another", () => {
    const calls: string[] = [];
    const wrapped = noFollowRmSync(runtime, refuse, () => (path) => { calls.push(path); return true; });
    wrapped(join(scratch, "tree", "sub", ".."), { recursive: true });
    wrapped(`${join(scratch, "slash-tree")}/`, { recursive: true });
    wrapped("relative-tree", { recursive: true });
    expect(calls).toEqual([join(scratch, "tree"), join(scratch, "slash-tree"), resolve("relative-tree")]);
  });

  it("refuses a path with a segment Windows would drop a trailing dot or space from, on the addon and the path walk alike", () => {
    const calls: string[] = [];
    const byHandle = noFollowRmSync(runtime, refuse, () => (path) => { calls.push(path); return true; });
    const walk = noFollowRmSync(runtime, refuse, () => null);
    const top = join(scratch, "data");
    for (const form of [`${top}.`, `${top} `, `${top}. `, `${top}..`, `${top}...`, `${top}./inner`, Buffer.from(`${top}.`), `\\\\?\\${top}.`]) {
      for (const wrapped of [byHandle, walk]) {
        expect(() => wrapped(form, { recursive: true, force: true })).toThrow(expect.objectContaining({ code: "EINVAL", syscall: "rm" }));
      }
    }
    expect(calls).toEqual([]);
  });

  it("hands a path holding a NUL to the runtime, which refuses it, never to removeTree", () => {
    const calls: string[] = [];
    const c = linkedSkill();
    const wrapped = noFollowRmSync(fs.rmSync, refuse, () => (path) => { calls.push(path); return true; });
    expect(() => wrapped(`${c.discovery}\0suffix`, { recursive: true, force: true })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    expect(() => wrapped(Buffer.from(`${c.discovery}\0suffix`), { recursive: true })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    expect([calls, gone(c.discovery), intact(c.target)]).toEqual([[], false, true]);
  });

  it("leaves a remove without recursive to the link check and the runtime", () => {
    const c = linkedSkill();
    const calls: string[] = [];
    const wrapped = noFollowRmSync(fs.rmSync, nodeTreeFs, () => (path) => { calls.push(path); return true; });
    wrapped(c.link);
    expect([gone(c.link), intact(c.target), calls]).toEqual([true, true, []]);
  });

  it("uses the path walk only when removeTree is missing, and says so once", async () => {
    vi.resetModules();
    const fresh = await import("./link-removal.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const c = linkedSkill(), d = linkedSkill();
      const wrapped = fresh.noFollowRmSync(runtime, fresh.nodeTreeFs, () => null);
      wrapped(c.discovery, { recursive: true });
      wrapped(d.discovery, { recursive: true });
      expect([gone(c.discovery), intact(c.target), gone(d.discovery), intact(d.target)]).toEqual([true, true, true, true]);
      const lines = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.startsWith("link removal:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("removeTree is not available");
    } finally { warn.mockRestore(); }
  });

  it("hands the path-walk line to the sink a process sets (the recovery CLI keeps its stderr for its one JSON line)", async () => {
    vi.resetModules();
    const fresh = await import("./link-removal.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    try {
      fresh.setPathWalkNotice((line) => { seen.push(line); });
      const c = linkedSkill();
      fresh.noFollowRmSync(runtime, fresh.nodeTreeFs, () => null)(c.discovery, { recursive: true });
      expect([gone(c.discovery), intact(c.target)]).toEqual([true, true]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("removeTree is not available");
      expect(warn.mock.calls.filter((args) => String(args[0]).startsWith("link removal:"))).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it("finds no removeTree in an addon build without it", () => {
    // An addon build that loads on this platform but carries no removeTree: the suite's stand-in plus, on Windows, the handle and v9 native
    // functions the loader requires there (without them the loader would pass over it to the real build, which has removeTree).
    const dir = mkdtempSync(join(tmpdir(), "murage-no-remove-tree-"));
    const file = join(dir, "no-remove-tree.cjs");
    const stub = join(import.meta.dirname, "testing", "engine-exclusion-stub.cjs");
    const handles = ["openFile", "handleRead", "handleWrite", "handleSync", "handleLock", "handleMarkDelete", "handleId", "handleSize", "handleClose", ...WINDOWS_NATIVE_FUNCTIONS];
    writeFileSync(file, `const missing = () => { throw new Error("not in this build"); };\nmodule.exports = { ...require(${JSON.stringify(stub)}), ${handles.map((name) => `${name}: missing`).join(", ")} };\n`);
    const before = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
    process.env.MURAGE_ENGINE_EXCLUSION_PATH = file;
    forgetExclusionAddon();
    try {
      expect(addonTreeRemove()).toBeNull();
    } finally {
      process.env.MURAGE_ENGINE_EXCLUSION_PATH = before;
      forgetExclusionAddon();
      removeTempDirSync(dir);
    }
  });
});

describe("noFollowRmSync", () => {
  it("removes a folder holding links without walking into them, even over the Windows runtime's rmSync", () => {
    const restore = emulateElectronWindowsRmSync();
    try {
      // the runtime's recursive remove is never reached for a folder
      const runtime = fs.rmSync;
      const wrapped = noFollowRmSync(function runtimeRmSync(path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) {
        if (options?.recursive && lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error("recursive remove reached the runtime");
        return runtime(path, options);
      });
      const c = linkedSkill();
      writeFileSync(join(c.discovery, "plain.txt"), "plain");
      mkdirSync(join(c.discovery, "nested"));
      symlinkSync(c.target, join(c.discovery, "nested", "deeper"), type);
      wrapped(c.discovery, { recursive: true, force: true });
      expect(gone(c.discovery)).toBe(true);
      expect(intact(c.target)).toBe(true);
      // a link itself, plain or recursive
      const d = linkedSkill();
      wrapped(d.link);
      const e = linkedSkill();
      wrapped(e.link, { recursive: true, force: true });
      expect([gone(d.link), intact(d.target), gone(e.link), intact(e.target)]).toEqual([true, true, true, true]);
      // missing paths and errors stay the runtime's own
      expect(() => wrapped(join(scratch, "missing"), { force: true })).not.toThrow();
      expect(() => wrapped(join(scratch, "missing"))).toThrow();
    } finally { restore(); }
  });

  it("decides each entry when it reaches it, stops on an unreadable folder, and retries a busy entry", () => {
    // a link made after the walk started is still removed as a link
    const c = linkedSkill();
    const late = join(c.discovery, "zz-late");
    let made = false;
    const io = { ...nodeTreeFs, readdir: (path: string) => {
      if (!made && path === c.discovery) { made = true; symlinkSync(c.target, late, type); }
      return nodeTreeFs.readdir(path);
    } };
    removeTreeWithoutFollowing(c.discovery, io);
    expect([gone(c.discovery), intact(c.target)]).toEqual([true, true]);
    // an unreadable folder is an error, never skipped
    const d = linkedSkill();
    expect(() => removeTreeWithoutFollowing(d.discovery, { ...nodeTreeFs, readdir: () => { throw errno("EACCES"); } })).toThrow("EACCES");
    expect(gone(d.discovery)).toBe(false);
    // maxRetries covers a busy entry, as rmSync's own option does
    const e = linkedSkill();
    let busy = 1;
    const flaky = { ...nodeTreeFs, rmdir: (path: string) => { if (busy-- > 0) throw errno("EBUSY"); nodeTreeFs.rmdir(path); } };
    expect(() => noFollowRmSync(fs.rmSync, flaky)(e.discovery, { recursive: true, maxRetries: 1, retryDelay: 1 })).not.toThrow();
    expect([gone(e.discovery), intact(e.target)]).toEqual([true, true]);
    busy = 1;
    const f = linkedSkill();
    expect(() => noFollowRmSync(fs.rmSync, flaky)(f.discovery, { recursive: true })).toThrow("EBUSY");
  });

  it("leaves a folder swapped during the walk in place, and owns force and ENOENT for recursive removes", () => {
    const c = linkedSkill();
    let calls = 0;
    const swapped = { ...nodeTreeFs, lstatEntry: (path: string) => {
      const stat = nodeTreeFs.lstatEntry(path);
      if (path !== c.discovery || ++calls < 2) return stat;
      return { isSymbolicLink: () => false, isDirectory: () => true, dev: stat.dev, ino: (stat.ino ?? 0) + 1 };
    } };
    expect(() => removeTreeWithoutFollowing(c.discovery, swapped)).toThrow("The folder changed");
    expect([gone(c.link), intact(c.target)]).toEqual([false, true]);
    // a recursive remove never reaches the runtime, even for a missing path
    const never = noFollowRmSync(() => { throw new Error("reached the runtime"); });
    expect(() => never(join(scratch, "missing-recursive"), { recursive: true, force: true })).not.toThrow();
    expect(() => never(join(scratch, "missing-recursive"), { recursive: true })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => never(join(scratch, "unreadable"), { recursive: true })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    const d = linkedSkill();
    writeFileSync(join(d.dir, "file.txt"), "x");
    never(join(d.dir, "file.txt"), { recursive: true });
    expect(gone(join(d.dir, "file.txt"))).toBe(true);
    const eaccess = noFollowRmSync(() => { throw new Error("reached the runtime"); }, { ...nodeTreeFs, lstatEntry: () => { throw errno("EACCES"); } });
    expect(() => eaccess(d.dir, { recursive: true, force: true })).toThrow("EACCES");
  });

  it("is installed process-wide only on Windows", () => {
    expect(installNoFollowRmSync("linux")).toBe(false);
    expect(installNoFollowRmSync("darwin")).toBe(false);
  });
});

// Identity must be checked inside the retry, not once around relinkDirectory.
import * as removal from "./link-removal.ts";
it("T12e mismatch at the retry re-read keeps a substituted link",()=>{
  const expected={dev:1,ino:2,size:3,mtimeMs:4,text:"/old",isSymbolicLink:true};
  let reads=0,removes=0;
  const io={lstat:()=>({isSymbolicLink:()=>true}),unlink:()=>{removes++;throw Object.assign(new Error("busy"),{code:"EBUSY"});},rmdir:()=>{},symlink:()=>{}};
  expect(()=>removal.relinkDirectoryChecked("/entry","/new",expected,()=>++reads===1?expected:{...expected,text:"/replacement"},io,"linux")).toThrow(/changed/);
  expect(removes).toBe(1);
});
it("T10 lexical roots and strict stale tails",()=>{
  const options={threadId:"t",name:"skill",target:"C:\\new\\threads\\t\\.murage-procedures\\"+"a".repeat(64)+"\\skills\\skill",platform:"win32" as const};
  const tail="threads\\t\\.murage-procedures\\"+"a".repeat(64)+"\\skills\\skill";
  for(const prefix of ["D:\\Old\\","\\\\?\\D:\\Old\\","\\??\\D:\\Old\\","D:/OLD/","\\\\srv\\share\\","\\\\?\\UNC\\srv\\share\\","\\??\\UNC\\srv\\share\\"])expect(removal.ownLinkTail(prefix+tail,options)).toBe("ours");
  for(const prefix of ["D:old\\","\\old\\","\\\\?\\foo\\","\\\\\\share\\","\\\\srv\\\\x\\"])expect(removal.ownLinkTail(prefix+tail,options)).toBe("foreign");
  expect(removal.ownLinkTail("D:\\Old\\"+tail.replace("threads","THREADS"),options)).toBe("foreign");
  expect(removal.ownLinkTail(options.target.toUpperCase(),options)).toBe("current");
});


import { prefixRebaseLinks, setRelinkNotice, prefixRebaseSeams } from "./link-removal.ts";

describe("S5 prefix-rebase", () => {
  function fixture(kind: "dir" | "file" = "dir", text?: string) {
    const dir = join(scratch, `prefix-${++n}`);
    fs.mkdirSync(dir);
    const dataDir = join(dir, "new");
    fs.mkdirSync(dataDir);
    const old = join(dir, "old");
    const target = join(dataDir, "leaf");
    if (kind === "dir") fs.mkdirSync(target); else fs.writeFileSync(target, "fixture");
    const link = join(dir, "link");
    fs.symlinkSync(text ?? `${old}/leaf`, link, kind);
    const lines: string[] = [];
    setRelinkNotice(line => lines.push(line));
    const options = { site: 4 as const, dataDir, previousRoots: [old], kind,
      create: (target: string, path: string) => fs.symlinkSync(target, path, kind) };
    // Windows rewrites a link's text when it creates it (separators, `..` resolved): compare with the spelling on disk.
    const stored = fs.readlinkSync(link);
    return { dir, dataDir, old, target, link, lines, options, stored };
  }
  afterEach(() => { vi.restoreAllMocks(); setRelinkNotice(line => console.warn(line)); });
  it("S5 prefix-rebase 1 rebases a recorded prefix without reading the old target", () => {
    const c = fixture();
    prefixRebaseLinks.relink(c.link, c.options);
    expect(fs.readlinkSync(c.link)).toBe(c.target);
    expect(c.lines).toEqual([]);
  });
  it.each(["missing", "outside", "kind"] as const)("S5 prefix-rebase 2/4/5 refuses %s byte-identically", reason => {
    const c = fixture();
    if (reason === "missing") fs.rmdirSync(c.target);
    if (reason === "kind") { fs.rmdirSync(c.target); fs.writeFileSync(c.target, "file"); }
    if (reason === "outside") {
      fs.unlinkSync(c.link); fs.symlinkSync(`${c.old}/x/../leaf`, c.link);
      // Windows resolves `..` when it creates a link, so the outside spelling reaches relink through its io seam on every OS.
      const spelled = `${c.old}/x/../leaf`;
      Object.assign(c.options, { io: { readlinkSync: (p: string) => p === c.link ? spelled : fs.readlinkSync(p), lstatSync: (p: string) => fs.lstatSync(p), renameSync: fs.renameSync, unlinkSync: fs.unlinkSync } });
    }
    const text = fs.readlinkSync(c.link), ino = fs.lstatSync(c.link).ino;
    prefixRebaseLinks.relink(c.link, c.options);
    expect(fs.readlinkSync(c.link)).toBe(text);
    expect(fs.lstatSync(c.link).ino).toBe(ino);
    expect(c.lines).toEqual([`relink-skipped site=4 reason=${reason}`]);
  });
  it("S5 prefix-rebase 5 file to directory is refused", () => {
    const c = fixture("file");
    fs.unlinkSync(c.target); fs.mkdirSync(c.target);
    const ino = fs.lstatSync(c.link).ino;
    prefixRebaseLinks.relink(c.link, c.options);
    expect(fs.readlinkSync(c.link)).toBe(c.stored);
    expect(fs.lstatSync(c.link).ino).toBe(ino);
    expect(c.lines).toEqual(["relink-skipped site=4 reason=kind"]);
  });
  it.each(["foreign", "relative", "empty-roots"])("S5 prefix-rebase 3/9 %s is silent", mode => {
    const c = fixture();
    if (mode === "empty-roots") c.options.previousRoots = [];
    else { fs.unlinkSync(c.link); fs.symlinkSync(mode === "relative" ? "old/leaf" : `${c.old}-foreign/leaf`, c.link); }
    const text = fs.readlinkSync(c.link), ino = fs.lstatSync(c.link).ino;
    prefixRebaseLinks.relink(c.link, c.options);
    expect(fs.readlinkSync(c.link)).toBe(text);
    expect(fs.lstatSync(c.link).ino).toBe(ino);
    expect(c.lines).toEqual([]);
  });
  it("S5 prefix-rebase 6 interrupted replace is swept only after ten minutes", () => {
    const c = fixture();
    vi.spyOn(prefixRebaseSeams, "afterCreate").mockImplementation(() => { throw new Error("simulated process interruption"); });
    expect(() => prefixRebaseLinks.relink(c.link, c.options)).toThrow("simulated process interruption");
    const sibling = fs.readdirSync(c.dir).find(x => x.includes(".murage-relink-"))!;
    expect(sibling).toBeTruthy();
    const now = fs.lstatSync(join(c.dir, sibling)).mtimeMs;
    const plain = join(c.dir, "plain.murage-relink-1-1"); fs.writeFileSync(plain, "keep");
    prefixRebaseLinks.sweep(c.dir, now + 5 * 60_000);
    expect(fs.lstatSync(join(c.dir, sibling)).isSymbolicLink()).toBe(true);
    prefixRebaseLinks.sweep(c.dir, now + 11 * 60_000);
    expect(fs.existsSync(join(c.dir, sibling))).toBe(false);
    expect(fs.readFileSync(plain, "utf8")).toBe("keep");
    expect(fs.readlinkSync(c.link)).toBe(c.stored);
  });
  it.each(["ok", "fallback", "restore", "restore-failed", "changed"])("S5 prefix-rebase 8 win32 %s", branch => {
    const c = fixture();
    vi.spyOn(prefixRebaseSeams, "platform").mockReturnValue("win32");
    // Match Windows spellings while using real Linux directory links through the primitive seam.
    const originalText = fs.readlinkSync(c.link);
    let calls = 0;
    vi.spyOn(prefixRebaseSeams, "rename").mockImplementation((a, b) => {
      calls++;
      if (branch !== "ok" && calls === 1) {
        if (branch === "changed") { fs.unlinkSync(c.link); fs.symlinkSync("changed", c.link); }
        throw errno("EPERM");
      }
      if (branch.startsWith("restore")) throw errno("EIO");
      fs.renameSync(a, b);
    });
    if (branch === "restore-failed") c.options.create = (target, path) => {
      if (path === c.link) throw errno("EIO"); fs.symlinkSync(target, path, "dir");
    };
    expect(() => prefixRebaseLinks.relink(c.link, c.options)).not.toThrow();
    if (branch === "ok" || branch === "fallback") expect(fs.readlinkSync(c.link)).toBe(c.target);
    if (branch === "restore") expect(fs.readlinkSync(c.link)).toBe(originalText);
    if (branch === "changed") expect(fs.readlinkSync(c.link)).toBe("changed");
    if (branch === "restore-failed") expect(fs.lstatSync(c.link, { throwIfNoEntry: false })).toBeUndefined();
    expect(c.lines).toEqual(branch === "restore-failed" ? ["relink-failed site=4 reason=restore"] :
      branch === "restore" || branch === "changed" ? [`relink-skipped site=4 reason=${branch === "restore" ? "replace" : "changed"}`] : []);
    expect(fs.readdirSync(c.dir).filter(x => x.includes(".murage-relink-"))).toEqual([]);
  });
});
