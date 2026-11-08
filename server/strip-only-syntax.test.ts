// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server runs its .ts files under Node type stripping, which only erases types. It refuses syntax that needs code
// generated for it: parameter properties (`constructor(readonly x: T)`), enums, namespaces, `import x = require()`.
// One such line in a runtime file keeps the whole server from starting (FLUX-BURN-COPY-1018 found it in flux-refusal.ts).
// This guard strips every runtime .ts file under server/ and shared/, plus every src/ file those files import (the server
// loads a number of src/lib and src/e2e modules under the same loader, followed through their own relative imports),
// the way Node does, and names the files that fail. It is in the gate tier. server/memory/strip-only-syntax.test.ts
// (extended tier) covers server/ and shared/ only and stays as the second guard; this one adds the src/ modules the
// server loads and runs on every gate. The rest of src/ is bundled by the app build, so it is not held to this rule.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src") + sep;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-server", "testing"]);
const RELATIVE_TS_IMPORT = /(?:\bfrom|\bimport\s*\(?)\s*["'](\.{1,2}\/[^"']+\.m?ts)["']/g;

function isRuntimeFile(name: string): boolean {
  return /\.(ts|mts)$/.test(name) && !/\.d\.(ts|mts)$/.test(name) && !/\.(test|spec)\./.test(name);
}

function runtimeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) runtimeFiles(join(dir, entry.name), out);
    } else if (isRuntimeFile(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** The src/ files the given files import by a relative .ts path, followed through the src/ files' own relative imports. */
function srcModulesLoadedBy(files: string[], srcRoot: string = SRC): { loaded: string[]; missing: string[] } {
  const found = new Set<string>();
  const missing = new Set<string>();
  const queue = [...files];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(RELATIVE_TS_IMPORT)) {
      const target = resolve(dirname(file), match[1]);
      if (!target.startsWith(srcRoot) || found.has(target)) continue;
      // an import the server would fail on is a finding, never a skip
      if (!existsSync(target)) { missing.add(`${relative(ROOT, file)} imports ${match[1]}, which does not exist`); continue; }
      if (!isRuntimeFile(target.slice(target.lastIndexOf(sep) + 1))) continue;
      found.add(target);
      queue.push(target);
    }
  }
  return { loaded: [...found].sort(), missing: [...missing].sort() };
}

function refusals(files: string[]): string[] {
  const refused: string[] = [];
  for (const file of files) {
    try { stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }); }
    catch (error) { refused.push(`${relative(ROOT, file)}: ${(error as Error).message}`); }
  }
  return refused;
}

describe("runtime .ts files load under Node type stripping", () => {
  const serverFiles = [...runtimeFiles(join(ROOT, "server")), ...runtimeFiles(join(ROOT, "shared"))];

  it("strips every runtime file in server/ and shared/ in strip-only mode", () => {
    expect(serverFiles.length).toBeGreaterThan(100);
    expect(refusals(serverFiles)).toEqual([]);
  });

  it("strips every src/ module the server loads, through their own imports", () => {
    const { loaded, missing } = srcModulesLoadedBy(serverFiles);
    expect(missing).toEqual([]);
    expect(loaded.length).toBeGreaterThanOrEqual(3);
    expect(loaded.some((file) => file.includes(`${sep}src${sep}lib${sep}`))).toBe(true);
    expect(refusals(loaded)).toEqual([]);
  });

  it("reports a dangling src/ import and follows a side-effect import, so the walker cannot skip silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "strip-walk-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "server"));
      writeFileSync(join(dir, "src", "a.ts"), 'import "./b.ts";\nimport { x } from "./gone.ts";\nexport const a = 1;\n');
      writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
      const entry = join(dir, "server", "s.ts");
      writeFileSync(entry, 'import { a } from "../src/a.ts";\nexport const s = a;\n');
      const { loaded, missing } = srcModulesLoadedBy([entry], join(dir, "src") + sep);
      expect(loaded.map((file) => relative(dir, file))).toEqual([join("src", "a.ts"), join("src", "b.ts")]);
      expect(missing.length).toBe(1);
      expect(missing[0]).toContain("./gone.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a parameter property, so the guard can fail", () => {
    expect(() => stripTypeScriptTypes("class A { constructor(readonly x: string) {} }", { mode: "strip" })).toThrow();
    expect(() => stripTypeScriptTypes("enum E { A }", { mode: "strip" })).toThrow();
    expect(() => stripTypeScriptTypes("class A { x: string; constructor(x: string) { this.x = x; } }", { mode: "strip" })).not.toThrow();
  });
});
