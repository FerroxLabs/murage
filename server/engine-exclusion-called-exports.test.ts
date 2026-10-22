// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A live run of an older build logged "the native addon's removeTree is not available here": the addon the package shipped did not
// export a call the code makes. The after-pack check (scripts/engine-exclusion-resource.mjs) must refuse such a package, so its list
// is DERIVED here from the code: every addon call server/ and electron/ make must be on it, and the addon source must export it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POSIX_ADDON_FUNCTIONS, WINDOWS_ADDON_FUNCTIONS, loadEngineExclusionResource, requiredAddonFunctions } from "../scripts/engine-exclusion-resource.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const COMMON = ["lock", "processes", "renameNoReplace", "version"]; // answered for on every platform by the load check itself
const SKIP = new Set(["node_modules", "testing", "testdata", "fixtures", "dist", "dist-native", "vendor"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) sources(join(dir, entry.name), out); continue; }
    if (/\.(?:ts|mjs|js|cjs)$/.test(entry.name) && !/\.(?:test|node-test|spec)\./.test(entry.name) && !/\.d\.m?ts$/.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

/** The members of the ExclusionAddon interface, and which of them the shipped code calls (obj.name(, obj?.name(, name?.(, name.call). */
function calledExports() {
  const declaration = readFileSync(join(root, "server", "engine-exclusion.ts"), "utf8");
  const body = declaration.slice(declaration.indexOf("export interface ExclusionAddon"));
  const members = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/^\s{2}(\w+)\??\(/gm)].map(match => match[1]!);
  const code = [...sources(join(root, "server")), ...sources(join(root, "electron"))].map(file => [relative(root, file), readFileSync(file, "utf8")] as const);
  const called = members.filter(name => code.some(([, text]) => new RegExp(`(?:\\.|\\?\\.)${name}\\??\\(|\\b${name}\\?\\.\\(|\\b${name}\\.call\\(|(?:\\.|\\?\\.)${name}\\.call\\(`).test(text)));
  return { members, called };
}

/** Which names native/engine-exclusion/exclusion.c exports on Windows and elsewhere (add(env, exports, "name", ...) under its #ifdef _WIN32). */
function exportedBySource() {
  const win = new Set<string>(), posix = new Set<string>();
  let branch: "both" | "win" | "posix" = "both";
  const stack: Array<"both" | "win" | "posix"> = [];
  for (const line of readFileSync(join(root, "native", "engine-exclusion", "exclusion.c"), "utf8").split("\n")) {
    const text = line.trim();
    if (/^#ifdef _WIN32\b/.test(text)) { stack.push(branch); branch = "win"; } else if (/^#ifndef _WIN32\b/.test(text)) { stack.push(branch); branch = "posix"; }
    else if (/^#if(?:def|ndef)?\b/.test(text)) stack.push(branch);
    else if (/^#else\b/.test(text) && stack.length && (branch === "win" || branch === "posix")) branch = branch === "win" ? "posix" : "win";
    else if (/^#endif\b/.test(text)) branch = stack.pop() ?? "both";
    const added = /^add\(env, exports, "(\w+)"/.exec(text);
    if (!added) continue;
    if (branch !== "posix") win.add(added[1]!);
    if (branch !== "win") posix.add(added[1]!);
  }
  return { win, posix };
}

describe("the packaged-addon check covers every export the code calls", () => {
  const { members, called } = calledExports();
  const covered = new Set([...COMMON, ...WINDOWS_ADDON_FUNCTIONS, ...POSIX_ADDON_FUNCTIONS]);
  it("reads the interface and finds the calls (so the comparison below is not vacuous)", () => {
    expect(members.length).toBeGreaterThan(25);
    for (const name of ["removeTree", "writers", "fullSync", "bootId", "authenticode", "driveInfo", "processStart", "openFile", "speechVoices"]) expect(called, name).toContain(name);
  });
  it("every addon call server/ and electron/ make is on the check's list (or answered for on every platform)", () => {
    expect(called.filter(name => !covered.has(name)), "called but not asserted in scripts/engine-exclusion-resource.mjs").toEqual([]);
  });
  it("removeTree and every Windows-only call the code makes are on the Windows list; writers, fullSync and bootId on the other one", () => {
    expect(WINDOWS_ADDON_FUNCTIONS).toContain("removeTree");
    expect(called.filter(name => !COMMON.includes(name) && !POSIX_ADDON_FUNCTIONS.includes(name) && !WINDOWS_ADDON_FUNCTIONS.includes(name))).toEqual([]);
    for (const name of ["writers", "fullSync", "bootId"]) expect(requiredAddonFunctions("darwin")).toContain(name);
    expect(requiredAddonFunctions("linux")).toEqual(requiredAddonFunctions("darwin"));
  });
  it("the addon source exports removeTree on Windows, and everything each platform's list names", () => {
    const { win, posix } = exportedBySource();
    expect(win.has("removeTree")).toBe(true);
    expect(WINDOWS_ADDON_FUNCTIONS.filter(name => !win.has(name)), "listed for Windows, not exported by exclusion.c there").toEqual([]);
    expect(POSIX_ADDON_FUNCTIONS.filter(name => !posix.has(name)), "listed for macOS/Linux, not exported by exclusion.c there").toEqual([]);
    expect(COMMON.filter(name => !win.has(name) || !posix.has(name))).toEqual([]);
  });
});

describe("a package whose addon lacks a called export is refused (fixture addon, run for real)", () => {
  const fixture = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "murage-addon-fixture-"));
    const file = join(dir, "engine-exclusion.cjs");
    const members = names.map(name => `${JSON.stringify(name)}: () => {}`).join(", ");
    writeFileSync(file, `module.exports = { version: () => 9, lock: () => {}, renameNoReplace: () => 0, processes: () => [{ pid: process.pid }], ${members} };\n`);
    return { dir, file };
  };
  const check = (names: string[], platform: "win32" | "darwin" | "linux") => {
    const { dir, file } = fixture(names);
    try {
      return loadEngineExclusionResource(file, platform, process.arch, 9, (command, args, env) => {
        const run = spawnSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8" });
        if (run.status !== 0) throw Object.assign(new Error("run failed"), { status: run.status, stderr: run.stderr });
        return run.stdout;
      }, process.execPath, { platform, arch: process.arch });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it.each(["win32", "darwin", "linux"] as const)("%s: the complete fixture loads; each missing export fails the check", platform => {
    const all = [...requiredAddonFunctions(platform)];
    expect(check(all, platform)).toBe("loaded");
    for (const missing of all) expect(() => check(all.filter(name => name !== missing), platform), `without ${missing}`).toThrow("ENGINE_EXCLUSION_RESOURCE_FUNCTIONS");
  });
});
