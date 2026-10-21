// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 section 14 and Astra #3/#4/#5 (astra-nobash-code/OUT.txt): the overlay that holds restated values lives
// in a private folder (0700, this user's; the owner-only ACL on Windows), is 0600, is held by each CLI process launched with it
// and removed when the last one goes, and a folder a dead process left is swept at boot. Files are written by an exclusive
// temp whose identity is checked, then renamed; a prior entry is never read, followed or copied.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ClaudeOverlayStore, claudePrivateRoot, ensurePrivateDir, sweepClaudePrivate, writePrivateFile, type PrivateFs } from "./claude-private.ts";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "claude-private-"))); });
afterEach(() => removeTempDirSync(base));
const posix = process.platform !== "win32";

describe("the overlay store", () => {
  it.skipIf(!posix)("writes the overlay 0600 in a 0700 folder of a 0700 root, and removes it when the last holder releases", () => {
    const root = join(base, "root");
    const store = new ClaudeOverlayStore(() => root);
    const text = JSON.stringify({ env: { MURAGE_CANARY_PROJ: "", ANTHROPIC_BASE_URL: "https://owner.example" } });
    const path = store.acquire(text);
    expect(path).toBe(store.pathFor(text));
    expect(path.startsWith(store.dir())).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(store.dir()).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(text);
    // a second launch with the same overlay shares it; the file goes with the last one
    expect(store.acquire(text)).toBe(path);
    expect(store.holds().get(path)).toBe(2);
    store.release(path);
    expect(existsSync(path)).toBe(true);
    store.release(path);
    expect(existsSync(path)).toBe(false);
    expect(store.holds().size).toBe(0);
    expect(readdirSync(store.dir())).toEqual([]);
  });

  it.skipIf(!posix)("a root another user could open, or a link put in its place, is refused (never repaired or followed)", () => {
    const open = join(base, "open");
    mkdirSync(open, { mode: 0o755 });
    expect(() => new ClaudeOverlayStore(() => open).acquire("{}")).toThrow(/private folder refused/);
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    const link = join(base, "link");
    symlinkSync(elsewhere, link);
    expect(() => new ClaudeOverlayStore(() => link).acquire("{}")).toThrow(/private folder refused/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("on Windows the root and the process folder get the native helper's owner-only ACL, the file its owner-only write", () => {
    const calls: string[] = [];
    const fs: PrivateFs = {
      platform: "win32",
      makeWindowsDir: (path) => { calls.push(`dir ${path}`); mkdirSync(path, { recursive: true }); },
      writeWindowsFile: (path, data) => { calls.push(`file ${path}`); writeFileSync(path, data); },
      uid: () => undefined,
    };
    const root = join(base, "root");
    const store = new ClaudeOverlayStore(() => root, fs);
    const path = store.acquire("{\"env\":{}}");
    expect(calls).toEqual([`dir ${root}`, `dir ${store.dir()}`, `file ${path}`]);
    expect(claudePrivateRoot("C:\\Temp", fs)).toBe(join("C:\\Temp", "murage-claude-private"));
    store.release(path);
    expect(existsSync(path)).toBe(false);
    // a helper that cannot make the folder private stops the launch (fail closed)
    const refusing = new ClaudeOverlayStore(() => join(base, "r2"), { ...fs, makeWindowsDir: () => { throw new Error("windows_browser_private_storage_unavailable"); } });
    expect(() => refusing.acquire("{}")).toThrow();
  });
});

describe("boot crash recovery", () => {
  it.skipIf(!posix)("removes the folders of processes that are gone, keeps a live one's and this process's", () => {
    const root = join(base, "root");
    ensurePrivateDir(root);
    const dead = join(root, "p-999999-0123456789ab");
    const live = join(root, "p-424242-0123456789ab");
    const mine = join(root, `p-${process.pid}-0123456789ab`);
    const other = join(root, "unrelated");
    for (const path of [dead, live, mine, other]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(dead, "abc.json"), "{\"env\":{\"X\":\"secret\"}}", { mode: 0o600 });
    const removed = sweepClaudePrivate(root, (pid) => pid === 424242);
    expect(removed).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    for (const path of [live, mine, other]) expect(existsSync(path), path).toBe(true);
  });

  it("a missing root is a no-op", () => {
    expect(sweepClaudePrivate(join(base, "none"))).toEqual([]);
  });
});

describe("writePrivateFile", () => {
  it.skipIf(!posix)("unlinks a link at the path (its target untouched) and writes a fresh 0600 file by rename", () => {
    const dir = join(base, "d");
    ensurePrivateDir(dir);
    const target = join(base, "target");
    writeFileSync(target, "keep");
    const path = join(dir, "f.json");
    symlinkSync(target, path);
    writePrivateFile(path, "new");
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["f.json"]);
  });
});

describe("no app-spawned PowerShell (Q4)", () => {
  it("the private-file module and the native helper's wrapper spawn no PowerShell: Windows privacy is the helper's, by handle", () => {
    for (const file of [new URL("./claude-private.ts", import.meta.url), new URL("../../electron/browser-extension-windows.mjs", import.meta.url)]) {
      const source = readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
      expect(source, String(file)).not.toMatch(/powershell|pwsh|icacls|Get-Acl|Set-Acl/i);
    }
  });
});
