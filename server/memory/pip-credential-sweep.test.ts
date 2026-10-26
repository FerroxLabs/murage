// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUDE-SCOPE.md Part B F5': the reaper removes the `.credentials.json` copies 1.0.3's text-only Claude runs left in pip-tmp roots, on
// every platform, and never anything outside: a linked root or home (a junction on Windows), a realpath mismatch, or a folder at the file
// name is skipped and logged. maintainPip runs it at startup before the orphan sweep. Fixtures only; no real credential is read.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase } = await import("../database.ts");
const { maintainPip } = await import("./pip-reflect.ts");
const { sweepStaleCredentialCopies } = await import("./pip-reaper.ts");
type ReflectDeps = import("./pip-reflect.ts").ReflectDeps;
type ReaperDeps = import("./pip-reaper.ts").ReaperDeps;

const win32 = process.platform === "win32";
const SECRET = '{"claudeAiOauth":{"accessToken":"fixture-not-a-token"}}';
let work: string, base: string, outside: string, logs: string[];
const log = (line: string) => { logs.push(line); };
beforeEach(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "pip-credsweep-")));
  base = join(work, "pip-tmp"); outside = join(work, "outside");
  mkdirSync(base); mkdirSync(outside); logs = [];
});
afterEach(() => removeTempDirSync(work));

const root = (name: string) => { const r = join(base, name); mkdirSync(join(r, "home"), { recursive: true }); mkdirSync(join(r, "work")); return r; };
const copy = (name: string) => { const r = root(name); writeFileSync(join(r, "home", ".credentials.json"), SECRET); return join(r, "home", ".credentials.json"); };
const outsideFile = (name = "target.json") => { const f = join(outside, name); writeFileSync(f, SECRET); return f; };
const dirLink = (target: string, path: string) => symlinkSync(target, path, win32 ? "junction" : "dir");
const there = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

describe("F5': sweepStaleCredentialCopies", () => {
  it("(a) a copied file is removed; (c0) a root with nothing is left alone; every root still exists", () => {
    const a = copy("r1-1-aaaa"); root("r0-1-empty");
    const out = sweepStaleCredentialCopies(base, { log });
    expect(out.removed).toEqual([a]);
    expect(there(a)).toBe(false);
    expect(readdirSync(base).sort()).toEqual(["r0-1-empty", "r1-1-aaaa"]);
    expect(existsSync(join(base, "r1-1-aaaa", "home"))).toBe(true);
  });

  it.skipIf(win32)("(b) a symlink at the file name: the link is removed, its target stays byte-identical", () => {
    const target = outsideFile(); const r = root("r2-1-bbbb");
    const link = join(r, "home", ".credentials.json"); symlinkSync(target, link, "file");
    expect(sweepStaleCredentialCopies(base, { log }).removed).toEqual([link]);
    expect(there(link)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(SECRET);
  });

  it("(c) home is a link (Windows: a junction) to an outside folder: skipped, the outside file byte-identical, redirected logged", () => {
    const r = join(base, "r3-1-cccc"); mkdirSync(r);
    const folder = join(outside, "victim"); mkdirSync(folder); writeFileSync(join(folder, ".credentials.json"), SECRET);
    dirLink(folder, join(r, "home"));
    const out = sweepStaleCredentialCopies(base, { log });
    expect(out.removed).toEqual([]);
    expect(readFileSync(join(folder, ".credentials.json"), "utf8")).toBe(SECRET);
    expect(logs.some((l) => l.includes("redirected") && l.includes(join(r, "home")))).toBe(true);
    expect(there(join(r, "home"))).toBe(true);
  });

  it("(d) the root itself is a link to an outside folder: skipped, nothing outside touched", () => {
    const folder = join(outside, "rootvictim"); mkdirSync(join(folder, "home"), { recursive: true });
    writeFileSync(join(folder, "home", ".credentials.json"), SECRET);
    dirLink(folder, join(base, "r4-1-dddd"));
    const out = sweepStaleCredentialCopies(base, { log });
    expect(out.removed).toEqual([]);
    expect(readFileSync(join(folder, "home", ".credentials.json"), "utf8")).toBe(SECRET);
    expect(logs.some((l) => l.includes("redirected"))).toBe(true);
  });

  it("(e) base reached through a linked parent: the real path is walked, only the copies inside are removed", () => {
    const a = copy("r5-1-eeee"); const keep = outsideFile("keep.json");
    const via = join(work, "via"); dirLink(work, via);
    const out = sweepStaleCredentialCopies(join(via, "pip-tmp"), { log });
    expect(out.removed).toEqual([a]);
    expect(there(a)).toBe(false);
    expect(readFileSync(keep, "utf8")).toBe(SECRET);
  });

  it("(e2) a realpath mismatch on home is a redirect: skipped and logged", () => {
    const a = copy("r8-1-hhhh");
    const realpath = (p: string) => p.endsWith(join("r8-1-hhhh", "home")) ? join(outside, "elsewhere") : realpathSync.native(p);
    const out = sweepStaleCredentialCopies(base, { log, realpath });
    expect(out.removed).toEqual([]);
    expect(out.kept).toEqual([a]);
    expect(readFileSync(a, "utf8")).toBe(SECRET);
    expect(logs.some((l) => l.includes("redirected"))).toBe(true);
  });

  it("(f) a folder named .credentials.json is skipped; names outside the root pattern are not walked", () => {
    const r = root("r6-1-ffff"); mkdirSync(join(r, "home", ".credentials.json"));
    const odd = join(base, "Not A Root"); mkdirSync(join(odd, "home"), { recursive: true }); writeFileSync(join(odd, "home", ".credentials.json"), SECRET);
    const out = sweepStaleCredentialCopies(base, { log });
    expect(out.removed).toEqual([]);
    expect(lstatSync(join(r, "home", ".credentials.json")).isDirectory()).toBe(true);
    expect(readFileSync(join(odd, "home", ".credentials.json"), "utf8")).toBe(SECRET);
  });

  it("a missing base is nothing to do; a remove that fails (EBUSY) keeps the path, logged once, retried", () => {
    expect(sweepStaleCredentialCopies(join(work, "absent"), { log })).toEqual({ removed: [], kept: [] });
    const a = copy("r7-1-gggg");
    const busy = () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
    expect(sweepStaleCredentialCopies(base, { log, removeEntry: busy }).kept).toEqual([a]);
    expect(sweepStaleCredentialCopies(base, { log, removeEntry: busy }).kept).toEqual([a]);
    expect(logs.filter((l) => l.includes(a))).toHaveLength(1);
    expect(sweepStaleCredentialCopies(base, { log }).removed).toEqual([a]);
  });

  it("runs on win32: the entry goes through the no-follow remover", () => {
    const a = copy("r9-1-iiii");
    const seen: string[] = [];
    const out = sweepStaleCredentialCopies(base, { log, platform: "win32", removeEntry: (p) => { seen.push(p); removeTempDirSync(p); } });
    expect(seen).toEqual([a]);
    expect(out.removed).toEqual([a]);
  });
});

describe("F5': maintainPip at startup", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  const depsWith = (reaper: ReaperDeps): ReflectDeps => ({
    now: () => 1_760_000_000_000, bootEpoch: { pid: 2, startedAt: 2 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [], memoryMode: () => "active",
    resolveRoute: async () => { throw new Error("not used"); }, reaper,
  });
  const plant = () => {
    const r = join(DATA_DIR, "pip-tmp", "old-1-abcd"); mkdirSync(join(r, "home"), { recursive: true });
    writeFileSync(join(r, "home", ".credentials.json"), SECRET);
    return r;
  };
  it("removes the copy BEFORE the orphan sweep looks at the root (a root a process names is kept, its copy gone)", async () => {
    const r = plant();
    const seen: boolean[] = [];
    await maintainPip(depsWith({ platform: "linux", sweep: async (dir) => { seen.push(there(join(dir, "home", ".credentials.json"))); return [4242]; } }), { startup: true });
    expect(seen).toEqual([false]);
    expect(there(r)).toBe(true);
    expect(there(join(r, "home", ".credentials.json"))).toBe(false);
  });
  it("on win32, where the orphan sweep keeps every root, the copy is still removed", async () => {
    const r = plant();
    await maintainPip(depsWith({ platform: "win32", sweep: async () => [] }), { startup: true });
    expect(there(r)).toBe(true);
    expect(there(join(r, "home", ".credentials.json"))).toBe(false);
  });
});
