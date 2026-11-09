// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan: fixture (fake owner paths such as /Users/o/tmp, a comment-only marker; no test change)
//
// ENGINE-CHECK-FOLDER-1018: the set-up check runs in one private folder outside the owner's home, validated before every check.
// The system root is injected as a temp dir; Windows is a fake platform (paths, predicate and ACL reading only).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { aclWritersOutside, checkEngineReply, ENGINE_CHECK_FOLDER_FAILURE, engineCheckBasePath, engineCheckFolder, engineCheckHost, EngineCheckFolderError, isEngineCheckFolder, type EngineCheckFs } from "./engine-reply-check.ts";

const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
const posixOnly = process.platform === "win32" ? describe.skip : describe;
const posixIt = process.platform === "win32" ? it.skip : it;
let scratch = "";
let root = "";
let home = "";
let dataDir = "";
const opts = (extra: Record<string, unknown> = {}) => ({ platform: "linux" as const, root, user: uid, home, dataDir, ...extra });
const baseOf = () => engineCheckBasePath("linux", uid, root);

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "engchk-")));
  root = join(scratch, "sys-tmp"); home = join(scratch, "home"); dataDir = join(home, ".murage");
  for (const dir of [root, home, dataDir]) mkdirSync(dir, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); removeTempDirSync(scratch); });

describe("where the check folder is", () => {
  it("is a fixed system path per platform and never follows TMPDIR or TEMP", () => {
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, SystemDrive: process.env.SystemDrive };
    try {
      process.env.TMPDIR = "/Users/o/tmp"; process.env.TEMP = "C:\\Users\\o\\AppData\\Local\\Temp"; process.env.TMP = process.env.TEMP; delete process.env.SystemDrive;
      expect(engineCheckBasePath("darwin", 501)).toBe("/private/tmp/murage-engine-check-501");
      expect(engineCheckBasePath("linux", 1000)).toBe("/tmp/murage-engine-check-1000");
      expect(engineCheckBasePath("win32", "S-1-5-21-7")).toBe("C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-7");
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

posixOnly("the folder is prepared and proven before every check", () => {
  it("is created 0700, empty, canonical, and reused as it is", () => {
    const run = engineCheckFolder(opts());
    expect(run).toBe(join(realpathSync(baseOf()), "run"));
    expect(lstatSync(baseOf()).mode & 0o777).toBe(0o700);
    expect(lstatSync(run).mode & 0o777).toBe(0o700);
    expect(readdirSync(run)).toEqual([]);
    expect(engineCheckFolder(opts())).toBe(run);
  });

  it("refuses a base that is a link, and a run that is a link", () => {
    const elsewhere = join(scratch, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, baseOf(), "dir");
    expect(() => engineCheckFolder(opts())).toThrow(EngineCheckFolderError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  it("refuses a run that is a link at any level", () => {
    mkdirSync(baseOf(), { mode: 0o700 });
    const elsewhere = join(scratch, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(baseOf(), "run"), "dir");
    expect(() => engineCheckFolder(opts())).toThrow(EngineCheckFolderError);
  });
  it("refuses a folder this user does not own", () => {
    expect(() => engineCheckFolder(opts())).not.toThrow();
    // the same folder under a different expected user: not owned by them
    const other = uid + 1;
    mkdirSync(engineCheckBasePath("linux", other, root), { mode: 0o700 });
    expect(() => engineCheckFolder(opts({ user: other }))).toThrow(EngineCheckFolderError);
  });
  it("refuses a folder inside the home folder or the data folder, as written or through a link", () => {
    expect(() => engineCheckFolder(opts({ home: root }))).toThrow(EngineCheckFolderError);
    expect(() => engineCheckFolder(opts({ dataDir: root }))).toThrow(EngineCheckFolderError);
    expect(() => engineCheckFolder(opts({ dataDir: baseOf() }))).toThrow(EngineCheckFolderError);
    const alias = join(scratch, "home-alias");
    symlinkSync(root, alias, "dir");
    expect(() => engineCheckFolder(opts({ home: alias }))).toThrow(EngineCheckFolderError);
    // and the real home next to it is fine
    expect(() => engineCheckFolder(opts())).not.toThrow();
  });
  it("refuses a run that is not empty, and any file beside run in the base", () => {
    const run = engineCheckFolder(opts());
    writeFileSync(join(run, "left-behind"), "x");
    expect(() => engineCheckFolder(opts())).toThrow(EngineCheckFolderError);
    expect(existsSync(join(run, "left-behind"))).toBe(true); // never deleted by Murage
    unlinkSync(join(run, "left-behind"));
    expect(() => engineCheckFolder(opts())).not.toThrow();
    writeFileSync(join(baseOf(), "stray"), "x");
    expect(() => engineCheckFolder(opts())).toThrow(EngineCheckFolderError);
  });
  it("refuses a base or run that is group- or world-writable", () => {
    const run = engineCheckFolder(opts());
    chmodSync(run, 0o770);
    expect(() => engineCheckFolder(opts())).toThrow(EngineCheckFolderError);
    chmodSync(run, 0o700); chmodSync(baseOf(), 0o757);
    expect(() => engineCheckFolder(opts())).toThrow(EngineCheckFolderError);
    chmodSync(baseOf(), 0o700);
    expect(() => engineCheckFolder(opts())).not.toThrow();
  });
  it("refuses when the system root is missing, rather than falling back to a home folder", () => {
    expect(() => engineCheckFolder(opts({ root: join(scratch, "no-such-root") }))).toThrow(EngineCheckFolderError);
    expect(existsSync(join(home, "engine-check")) || existsSync(join(dataDir, "engine-check"))).toBe(false);
  });
});

posixOnly("a refused folder launches nothing; a timed-out check leaves the folder", () => {
  it("answers with the private-folder line and never touches the engine", async () => {
    mkdirSync(baseOf(), { mode: 0o700 });
    writeFileSync(join(baseOf(), "stray"), "x");
    const checkReply = vi.fn(async () => "ready");
    const generateText = vi.fn(async () => "ready");
    const folderFor = () => engineCheckFolder(opts());
    expect(await checkEngineReply({ instanceId: "p1", checkReply }, undefined, folderFor)).toEqual({ result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE });
    expect(await checkEngineReply({ instanceId: "p2", generateText }, undefined, folderFor)).toEqual({ result: "refused", line: "Murage could not prepare a private folder for this check." });
    expect(checkReply).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
  it("hands the proven folder to the engine, and leaves it in place after a timeout so the next check still runs", async () => {
    const folderFor = () => engineCheckFolder(opts());
    const seen: string[] = [];
    const stuck = { instanceId: "t1", displayName: "Pi", generateText: (_p: string, _b?: string, cwd?: string) => { seen.push(cwd!); return new Promise<string>(() => {}); } };
    expect(await checkEngineReply(stuck, 20, folderFor)).toEqual({ result: "refused", line: "Pi did not answer in time. Try again." });
    const run = seen[0]!;
    expect(run).toBe(join(realpathSync(baseOf()), "run"));
    expect(existsSync(run)).toBe(true);
    const next = vi.fn(async (_signal: AbortSignal, _cwd?: string) => "ready");
    expect(await checkEngineReply({ instanceId: "t2", checkReply: next }, undefined, folderFor)).toEqual({ result: "ready" });
    expect(next.mock.calls[0]![1]).toBe(run);
  });
});

describe("isEngineCheckFolder", () => {
  posixIt("is true for run and below,false for the base, sibling prefixes, escapes and other folders", () => {
    const run = engineCheckFolder(opts());
    const base = realpathSync(baseOf());
    const o = { platform: "linux" as const, root, user: uid };
    expect(isEngineCheckFolder(run, o)).toBe(true);
    expect(isEngineCheckFolder(join(run, "sub", "deeper"), o)).toBe(true);
    expect(isEngineCheckFolder(base, o)).toBe(false);
    expect(isEngineCheckFolder(`${base}x`, o)).toBe(false);
    expect(isEngineCheckFolder(join(`${base}x`, "run"), o)).toBe(false);
    expect(isEngineCheckFolder(join(run, "..", ".."), o)).toBe(false);
    expect(isEngineCheckFolder(join(run, "..", "..", "elsewhere"), o)).toBe(false);
    expect(isEngineCheckFolder(root, o)).toBe(false);
    expect(isEngineCheckFolder(home, o)).toBe(false);
    expect(isEngineCheckFolder("", o)).toBe(false);
  });
  posixIt("sees through symlink aliases of the run folder", () => {
    const run = engineCheckFolder(opts());
    const base = realpathSync(baseOf());
    const o = { platform: "linux" as const, root, user: uid };
    const toRun = join(scratch, "to-run"); symlinkSync(run, toRun, "dir");
    const toBase = join(scratch, "to-base"); symlinkSync(base, toBase, "dir");
    expect(isEngineCheckFolder(toRun, o)).toBe(true);
    expect(isEngineCheckFolder(join(toRun, "sub"), o)).toBe(true);
    expect(isEngineCheckFolder(join(toBase, "run"), o)).toBe(true);
    expect(isEngineCheckFolder(toBase, o)).toBe(false);
  });
  it("answers on Windows spellings: drive letter case, slashes, and not another user or drive", () => {
    const o = { platform: "win32" as const, user: "S-1-5-21-1", realpath: (path: string) => path };
    const run = "C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-1\\run";
    expect(isEngineCheckFolder(run, o)).toBe(true);
    expect(isEngineCheckFolder(`${run}\\sub`, o)).toBe(true);
    expect(isEngineCheckFolder("C:/ProgramData/Murage/engine-check/S-1-5-21-1/run", o)).toBe(true);
    expect(isEngineCheckFolder("c:\\programdata\\murage\\engine-check\\s-1-5-21-1\\run\\x", o)).toBe(true);
    expect(isEngineCheckFolder("C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-1", o)).toBe(false);
    expect(isEngineCheckFolder("C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-1x\\run", o)).toBe(false);
    expect(isEngineCheckFolder(`${run}\\..\\..\\other`, o)).toBe(false);
    expect(isEngineCheckFolder("D:\\ProgramData\\Murage\\engine-check\\S-1-5-21-1\\run", o)).toBe(false);
    expect(isEngineCheckFolder("C:\\Users\\o\\AppData\\Local\\Temp\\run", o)).toBe(false);
  });
  it("is false when the user cannot be identified (no check folder could have been made)", () => {
    vi.spyOn(engineCheckHost, "windowsUser").mockReturnValue(null);
    expect(isEngineCheckFolder("C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-1\\run", { platform: "win32" })).toBe(false);
  });
});

describe("Windows ACL reading", () => {
  const folder = "C:\\ProgramData\\Murage\\engine-check\\S-1-5-21-1";
  const allowed = ["pc\\owner", "s-1-5-21-1", "nt authority\\system", "s-1-5-18"];
  it("accepts an owner-and-SYSTEM-only listing", () => {
    const listing = `${folder} PC\\owner:(OI)(CI)(F)\n${" ".repeat(folder.length)} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
    expect(aclWritersOutside(listing, folder, allowed)).toEqual([]);
  });
  it("treats every right beyond read as write, an unknown right too, and an entry it cannot read as outside", () => {
    for (const rights of ["WA", "WEA", "WA,WEA", "DC", "DE", "WDAC", "WO", "GA", "GW", "ZZ", "RX,WA"]) {
      expect(aclWritersOutside(`${folder} PC\\owner:(OI)(CI)(F)\n PC\\guest:(${rights})\n`, folder, allowed), rights).toEqual(["PC\\guest"]);
    }
    expect(aclWritersOutside(`${folder} PC\\owner:(OI)(CI)(F)\n PC\\guest:(R)(RX)(S)(RC)(N)(REA)(RA)(RD)(X)(GR)(GE)(GX)\n`, folder, allowed)).toEqual([]);
    expect(aclWritersOutside(`${folder} PC\\owner:(OI)(CI)(F)\n broken line :(\n`, folder, allowed)).toHaveLength(1);
  });
  it("fails closed on a null DACL, empty output and unrecognized output, and needs an entry for the current user", () => {
    const user = ["pc\\owner", "s-1-5-21-1"];
    const nullDacl = `${folder} No permissions are set. All users have full control.\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
    expect(aclWritersOutside(nullDacl, folder, allowed, user)).not.toEqual([]);
    expect(aclWritersOutside("No permissions are set. All users have full control.", folder, allowed)).not.toEqual([]);
    for (const listing of ["", "\n\n", "Successfully processed 1 files; Failed processing 0 files\n", "something unexpected\n"]) expect(aclWritersOutside(listing, folder, allowed, user), JSON.stringify(listing)).not.toEqual([]);
    expect(aclWritersOutside(`${folder} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n`, folder, allowed, user)).not.toEqual([]);
    expect(aclWritersOutside(`${folder} PC\\owner:(DENY)(F)\n`, folder, allowed, user)).not.toEqual([]);
    expect(aclWritersOutside(`${folder} PC\\owner:(OI)(CI)(N)\n NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n`, folder, allowed, user)).not.toEqual([]);
    expect(aclWritersOutside(`${folder} PC\\owner:(OI)(CI)(F)\n NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n`, folder, allowed, user)).toEqual([]);
    expect(aclWritersOutside(`${folder} *S-1-5-21-1:(OI)(CI)(F)\n`.replace("*", ""), folder, allowed, user)).toEqual([]);
  });
  it("names anyone else granted write, and ignores read-only and deny entries", () => {
    const listing = `${folder} PC\\owner:(OI)(CI)(F)\n BUILTIN\\Users:(OI)(CI)(RX)\n Everyone:(OI)(CI)(M)\n PC\\guest:(DENY)(W)\n BUILTIN\\Administrators:(I)(OI)(CI)(WD,AD)\n`;
    expect(aclWritersOutside(listing, folder, allowed)).toEqual(["Everyone", "BUILTIN\\Administrators"]);
  });
});

// ---- Windows preparation and reuse, on a fake file system and fake security calls ----
interface FakeEntry { kind: "dir" | "link"; target?: string; uid: number; mode: number }
function fakeWindowsFs(seed: Record<string, FakeEntry["kind"] | { link: string }>) {
  const key = (path: string) => win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase();
  const names = new Map<string, string>();
  const entries = new Map<string, FakeEntry>();
  const put = (path: string, entry: FakeEntry) => { entries.set(key(path), entry); names.set(key(path), win32.basename(path)); };
  for (const [path, what] of Object.entries(seed)) put(path, typeof what === "string" ? { kind: what, uid: 0, mode: 0o777 } : { kind: "link", target: what.link, uid: 0, mode: 0o777 });
  const fs: EngineCheckFs = {
    lstat: (path) => { const e = entries.get(key(path)); return e ? { isDirectory: () => e.kind === "dir", isSymbolicLink: () => e.kind === "link", uid: e.uid, mode: e.mode } : null; },
    mkdir: (path, mode) => { if (!entries.has(key(win32.dirname(path)))) throw new Error("ENOENT"); if (entries.has(key(path))) throw new Error("EEXIST"); put(path, { kind: "dir", uid: 0, mode }); },
    chmod: () => undefined,
    readdir: (path) => [...entries.keys()].filter((k) => win32.dirname(k) === key(path) && k !== key(path)).map((k) => names.get(k)!),
    realpath: (path) => {
      let at = win32.parse(win32.normalize(path)).root;
      for (const part of win32.normalize(path).slice(at.length).split("\\").filter(Boolean)) {
        at = win32.join(at, part);
        const e = entries.get(key(at));
        if (!e) throw new Error("ENOENT");
        if (e.kind === "link") at = e.target!;
      }
      return at;
    },
  };
  return { fs, put, entries, key };
}

describe("Windows preparation and reuse (fake file system)", () => {
  const SID = "S-1-5-21-9";
  const ROOT = "C:\\ProgramData";
  const BASE = `${ROOT}\\Murage\\engine-check\\${SID}`;
  const RUN = `${BASE}\\run`;
  let owners: Record<string, string>;
  let acl: (dir: string) => string;
  let icacls: { mock: { calls: unknown[][] } };
  const goodAcl = (dir: string) => `${dir} PC\\owner:(OI)(CI)(F)\n NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  beforeEach(() => {
    owners = {};
    acl = goodAcl;
    vi.spyOn(engineCheckHost, "windowsUser").mockReturnValue({ name: "PC\\owner", sid: SID });
    vi.spyOn(engineCheckHost, "owner").mockImplementation((dir: string) => owners[dir.toLowerCase()] ?? SID);
    icacls = vi.spyOn(engineCheckHost, "icacls").mockImplementation((args: string[]) => (args.length === 1 ? acl(args[0]!) : ""));
  });
  const win = (fs: EngineCheckFs, extra: Record<string, unknown> = {}) => ({ platform: "win32" as const, root: ROOT, user: SID, home: "C:\\Users\\owner", dataDir: "C:\\Users\\owner\\AppData\\Roaming\\Murage", fs, ...extra });

  it("creates every level, puts an owner-only ACL on the base, and reuses the folder", () => {
    const { fs, entries, key } = fakeWindowsFs({ "C:\\ProgramData": "dir", "C:\\Users": "dir" });
    expect(engineCheckFolder(win(fs))).toBe(RUN);
    for (const level of [`${ROOT}\\Murage`, `${ROOT}\\Murage\\engine-check`, BASE, RUN]) expect(entries.get(key(level))?.kind).toBe("dir");
    expect(icacls.mock.calls.find((call: unknown[]) => (call[0] as string[]).includes("/inheritance:r"))?.[0]).toEqual([BASE, "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
    expect(engineCheckFolder(win(fs))).toBe(RUN);
  });
  it("refuses a link or junction at the Murage level and at the engine-check level, and launches nothing", async () => {
    for (const level of [`${ROOT}\\Murage`, `${ROOT}\\Murage\\engine-check`]) {
      const seed: Record<string, FakeEntry["kind"] | { link: string }> = { "C:\\ProgramData": "dir", "C:\\Elsewhere": "dir" };
      if (level.endsWith("engine-check")) seed[`${ROOT}\\Murage`] = "dir";
      seed[level] = { link: "C:\\Elsewhere" };
      const { fs } = fakeWindowsFs(seed);
      expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
      const checkReply = vi.fn(async () => "ready");
      expect(await checkEngineReply({ instanceId: `wl-${level}`, checkReply }, undefined, () => engineCheckFolder(win(fs)))).toEqual({ result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE });
      expect(checkReply).not.toHaveBeenCalled();
    }
  });
  it("refuses a base or run that is a link", () => {
    for (const [base, run] of [[{ link: "C:\\Elsewhere" }, "dir"], ["dir", { link: "C:\\Elsewhere" }]] as const) {
      const { fs } = fakeWindowsFs({ "C:\\ProgramData": "dir", "C:\\Elsewhere": "dir", [`${ROOT}\\Murage`]: "dir", [`${ROOT}\\Murage\\engine-check`]: "dir", [BASE]: base, [RUN]: run });
      expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
    }
  });
  it("refuses a base or run owned by someone else, or whose owner cannot be read", () => {
    const { fs } = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    expect(engineCheckFolder(win(fs))).toBe(RUN);
    owners[BASE.toLowerCase()] = "S-1-5-21-777";
    expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
    delete owners[BASE.toLowerCase()];
    owners[RUN.toLowerCase()] = "S-1-5-32-544";
    expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
    owners[RUN.toLowerCase()] = SID.toLowerCase();
    expect(() => engineCheckFolder(win(fs))).not.toThrow();
    vi.spyOn(engineCheckHost, "owner").mockReturnValue(null);
    expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
  });
  it("refuses when anyone but this user and SYSTEM may write, on the base or on run", async () => {
    const { fs } = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    expect(engineCheckFolder(win(fs))).toBe(RUN);
    acl = (dir) => (dir === RUN ? `${dir} PC\\owner:(OI)(CI)(F)\n Everyone:(OI)(CI)(M)\n` : goodAcl(dir));
    expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
    acl = (dir) => (dir === BASE ? `${dir} PC\\owner:(OI)(CI)(F)\n BUILTIN\\Users:(OI)(CI)(WD,AD)\n` : goodAcl(dir));
    expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
    for (const rights of ["WA", "WEA", "WA,WEA", "DC", "ZZ"]) {
      for (const target of [BASE, RUN]) {
        acl = (dir) => (dir === target ? `${dir} PC\\owner:(OI)(CI)(F)\n PC\\guest:(${rights})\n` : goodAcl(dir));
        const checkReply = vi.fn(async () => "ready");
        const generateText = vi.fn(async () => "ready");
        const folderFor = () => engineCheckFolder(win(fs));
        expect(await checkEngineReply({ instanceId: `acl-a-${rights}-${target}`, checkReply }, undefined, folderFor)).toEqual({ result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE });
        expect(await checkEngineReply({ instanceId: `acl-b-${rights}-${target}`, generateText }, undefined, folderFor)).toEqual({ result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE });
        expect(checkReply).not.toHaveBeenCalled();
        expect(generateText).not.toHaveBeenCalled();
      }
    }
    acl = goodAcl;
    expect(() => engineCheckFolder(win(fs))).not.toThrow();
  });
  it("refuses a null DACL and empty or unrecognized ACL output, on base and run, through both reply paths", async () => {
    const { fs } = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    expect(engineCheckFolder(win(fs))).toBe(RUN);
    const bad = [(dir: string) => `${dir} No permissions are set. All users have full control.\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, () => "", () => "\n", () => "Successfully processed 1 files; Failed processing 0 files\n", () => "unrecognized output"];
    for (const [i, listing] of bad.entries()) {
      for (const target of [BASE, RUN]) {
        acl = (dir) => (dir === target ? listing(dir) : goodAcl(dir));
        const checkReply = vi.fn(async () => "ready");
        const generateText = vi.fn(async () => "ready");
        const folderFor = () => engineCheckFolder(win(fs));
        expect(() => folderFor()).toThrow(EngineCheckFolderError);
        expect(await checkEngineReply({ instanceId: `null-a-${i}-${target}`, checkReply }, undefined, folderFor)).toEqual({ result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE });
        expect(await checkEngineReply({ instanceId: `null-b-${i}-${target}`, generateText }, undefined, folderFor)).toEqual({ result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE });
        expect(checkReply).not.toHaveBeenCalled();
        expect(generateText).not.toHaveBeenCalled();
      }
    }
    acl = goodAcl;
    expect(() => engineCheckFolder(win(fs))).not.toThrow();
  });
  it("refuses a non-empty run, a file beside run, a folder inside home, and a missing ProgramData", () => {
    const { fs, put } = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    expect(engineCheckFolder(win(fs))).toBe(RUN);
    put(`${RUN}\\left`, { kind: "dir", uid: 0, mode: 0o700 });
    expect(() => engineCheckFolder(win(fs))).toThrow(EngineCheckFolderError);
    const second = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    engineCheckFolder(win(second.fs));
    second.put(`${BASE}\\stray`, { kind: "dir", uid: 0, mode: 0o700 });
    expect(() => engineCheckFolder(win(second.fs))).toThrow(EngineCheckFolderError);
    const third = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    expect(() => engineCheckFolder(win(third.fs, { home: `${ROOT}\\Murage` }))).toThrow(EngineCheckFolderError);
    expect(() => engineCheckFolder(win(fakeWindowsFs({}).fs))).toThrow(EngineCheckFolderError);
  });
  it("refuses when the Windows user cannot be identified", () => {
    vi.spyOn(engineCheckHost, "windowsUser").mockReturnValue(null);
    const { fs } = fakeWindowsFs({ "C:\\ProgramData": "dir" });
    expect(() => engineCheckFolder({ platform: "win32", root: ROOT, home: "C:\\Users\\o", dataDir: "C:\\Users\\o\\d", fs })).toThrow(EngineCheckFolderError);
  });
});
