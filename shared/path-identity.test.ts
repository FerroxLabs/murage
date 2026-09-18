// The spelling contract every path guard in the app leans on. These run on
// every platform, with process.platform stubbed, because a refusal that only
// holds on the reviewer's Mac is no refusal at all — and because the Windows
// spellings cannot otherwise be exercised outside a Windows runner.
//
// Everything here is pure string work: callers canonicalize with
// realpathSync.native first, so by the time these see a path its links, casing
// and 8.3 aliases are already resolved. What is left is case (on Windows),
// slash direction, a trailing separator, and the extended-length prefixes.
import { afterEach, describe, expect, it } from "vitest";

import { oneSpelling, pathOverlaps, pathWithin, samePath } from "./path-identity.mjs";

const realPlatform = process.platform;
function asPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}
afterEach(() => asPlatform(realPlatform));

describe("on Windows", () => {
  it("treats the spellings of one path as one path", () => {
    asPlatform("win32");
    expect(samePath("C:\\Users\\Me", "c:\\users\\me")).toBe(true);
    expect(samePath("C:\\Users\\Me\\Documents", "C:\\USERS\\ME\\DOCUMENTS")).toBe(true);
    expect(samePath("C:\\Users\\Me\\", "C:\\Users\\Me")).toBe(true);
    expect(samePath("C:/Users/Me", "C:\\Users\\Me")).toBe(true);
    expect(samePath("C:\\Users\\Me/", "C:\\Users\\Me")).toBe(true);
    expect(samePath("\\\\?\\C:\\Users\\Me", "C:\\Users\\Me")).toBe(true);
    expect(samePath("\\\\?\\UNC\\server\\share\\me", "\\\\server\\share\\me")).toBe(true);
  });

  it("keeps distinct folders distinct, and a root a root", () => {
    asPlatform("win32");
    // A root shortened to "" would make every path equal to it and every
    // containment check pass.
    expect(oneSpelling("C:\\")).toBe("c:\\");
    expect(oneSpelling("\\\\server\\share\\")).toBe("\\\\server\\share");
    expect(samePath("C:\\", "D:\\")).toBe(false);
    expect(samePath("C:\\", "C:\\Users")).toBe(false);
    // A prefix is not a match.
    expect(samePath("C:\\Users\\Me", "C:\\Users\\Meredith")).toBe(false);
    expect(samePath("C:\\Users\\Me\\Documents", "C:\\Users\\Me\\Downloads")).toBe(false);
  });

  it("contains a child but never a sibling that merely shares a prefix", () => {
    asPlatform("win32");
    expect(pathWithin("C:\\Users\\Me", "C:\\Users\\Me")).toBe(true);
    expect(pathWithin("C:\\Users\\Me", "c:\\users\\me\\Documents\\a.txt")).toBe(true);
    expect(pathWithin("C:\\Users\\Me", "C:\\Users\\Meredith")).toBe(false);
    expect(pathWithin("C:\\Users\\Me\\Documents", "C:\\Users\\Me\\Documents-archive")).toBe(false);
    // the other direction is not containment
    expect(pathWithin("C:\\Users\\Me\\Documents", "C:\\Users\\Me")).toBe(false);
    // a root contains everything on its volume and nothing on another
    expect(pathWithin("C:\\", "C:\\Users")).toBe(true);
    expect(pathWithin("C:\\", "D:\\Users")).toBe(false);
  });

  it("overlaps in either direction", () => {
    asPlatform("win32");
    expect(pathOverlaps("C:\\work", "C:\\work\\repo")).toBe(true);
    expect(pathOverlaps("C:\\work\\repo", "C:\\work")).toBe(true);
    expect(pathOverlaps("C:\\work", "c:\\WORK")).toBe(true);
    expect(pathOverlaps("C:\\work", "C:\\workshop")).toBe(false);
    expect(pathOverlaps("C:\\work", "D:\\repo")).toBe(false);
  });
});

describe("off Windows", () => {
  it("keeps case significant, where a volume may be case-sensitive", () => {
    asPlatform("linux");
    expect(samePath("/home/me", "/home/ME")).toBe(false);
    expect(samePath("/home/me/", "/home/me")).toBe(true);
    expect(samePath("/", "/")).toBe(true);
    expect(samePath("/", "/home")).toBe(false);
    expect(oneSpelling("/")).toBe("/");
    // a backslash is an ordinary filename character here, never a separator
    expect(samePath("/home/a\\b", "/home/a/b")).toBe(false);
  });

  it("contains a child but never a sibling that merely shares a prefix", () => {
    asPlatform("darwin");
    expect(pathWithin("/home/me", "/home/me")).toBe(true);
    expect(pathWithin("/home/me", "/home/me/Documents/a.txt")).toBe(true);
    expect(pathWithin("/home/me", "/home/meredith")).toBe(false);
    expect(pathWithin("/work", "/workshop")).toBe(false);
    expect(pathWithin("/", "/home")).toBe(true);
    expect(pathOverlaps("/work", "/work/repo")).toBe(true);
    expect(pathOverlaps("/work/repo", "/work")).toBe(true);
    expect(pathOverlaps("/work", "/workshop")).toBe(false);
  });

  it("answers about the platform it is told, not the one it is running on", () => {
    // protected-folders.ts builds a Windows list on a Mac, so the rules have to
    // be selectable. Deliberately stubbed to the WRONG platform here: if the
    // argument were ignored these would all fall back to POSIX rules and fail.
    asPlatform("darwin");
    expect(samePath("C:\\Users\\Me", "c:\\users\\me", "win32")).toBe(true);
    expect(samePath("C:/Users/Me", "C:\\Users\\Me", "win32")).toBe(true);
    expect(oneSpelling("C:\\Users\\Me\\", "win32")).toBe("c:\\users\\me");
    expect(pathWithin("C:\\Users\\Me", "c:\\users\\me\\Documents", "win32")).toBe(true);
    expect(pathWithin("C:\\Users\\Me", "C:\\Users\\Meredith", "win32")).toBe(false);
    expect(pathOverlaps("c:\\work\\repo", "C:\\Work", "win32")).toBe(true);
    asPlatform("win32");
    // ...and the other way: a POSIX answer on a Windows host stays case-sensitive
    expect(samePath("/home/Me", "/home/me", "darwin")).toBe(false);
    expect(pathWithin("/home/Me", "/home/Me/Documents", "linux")).toBe(true);
  });

  it("refuses to treat an empty or relative path as containing anything", () => {
    asPlatform("linux");
    expect(pathWithin("", "/home")).toBe(false);
    expect(pathWithin("/home", "")).toBe(false);
    expect(oneSpelling("relative/path/")).toBe("relative/path");
  });
});
