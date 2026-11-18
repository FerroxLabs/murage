// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows quality gates ran link-removal.electron.test.ts, which bundles
// link-removal.ts to CommonJS (esbuild format "cjs"). esbuild leaves
// import.meta empty there, and electron/windows-native.mjs (reached through
// engine-exclusion.ts -> data-dir-lease) called fileURLToPath(import.meta.url)
// at load, so the bundle threw ERR_INVALID_ARG_TYPE before the fixture ran.
// This runs the same CommonJS bundles on any OS under plain Node, with a
// preload that reports win32 so the Windows-only addon loaders run too.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "murage-cjs-bundle-"));
afterAll(async () => { await removeTempDir(work); });

function bundle(entry: string, name: string): string {
  const outfile = join(work, name);
  buildSync({ entryPoints: [join(root, entry)], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
  return outfile;
}

function probe(script: string, fakeWin32: boolean): { status: number | null; out: string; diagnostics: string } {
  const preload = join(work, "fake-win32.cjs");
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, MURAGE_RESOURCES_PATH: join(work, "no-resources") };
  const args = [...(fakeWin32 ? ["-r", preload] : []), "-e", script];
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000, windowsHide: true, cwd: work });
  const out = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  return { status: result.status, out, diagnostics: `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

describe("addon loaders survive a CommonJS bundle (empty import.meta)", () => {
  it("link-removal.ts bundled to cjs loads and removes a link", () => {
    const file = bundle("server/link-removal.ts", "link-removal.cjs");
    const script = `
      const fs = require("node:fs"), path = require("node:path");
      const h = require(${JSON.stringify(file)});
      const dir = fs.mkdtempSync(path.join(${JSON.stringify(work)}, "case-"));
      const target = path.join(dir, "target"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "keep.txt"), "k");
      const link = path.join(dir, "link"); fs.symlinkSync(target, link, "dir");
      console.log(JSON.stringify({ removed: h.removeLink(link), kept: fs.existsSync(path.join(target, "keep.txt")) }));`;
    const r = probe(script, false);
    expect(r.status, r.diagnostics).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ removed: true, kept: true });
  });

  it("windowsNative() on win32 returns null for a missing addon instead of throwing", () => {
    const file = bundle("electron/windows-native.mjs", "windows-native.cjs");
    const script = `
      const m = require(${JSON.stringify(file)});
      let addon, error = null;
      try { addon = m.windowsNative(); } catch (e) { error = String(e && e.code || e); }
      console.log(JSON.stringify({ platform: process.platform, addon: addon ?? null, error }));`;
    const r = probe(script, true);
    expect(r.status, r.diagnostics).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ platform: "win32", addon: null, error: null });
  });

  it("loadExclusionAddon() on win32 returns null for a missing addon instead of throwing", () => {
    const file = bundle("server/engine-exclusion.ts", "engine-exclusion.cjs");
    const script = `
      const m = require(${JSON.stringify(file)});
      let addon, error = null;
      try { addon = m.loadExclusionAddon(); } catch (e) { error = String(e && e.code || e); }
      console.log(JSON.stringify({ platform: process.platform, addon: addon ?? null, error }));`;
    const r = probe(script, true);
    expect(r.status, r.diagnostics).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ platform: "win32", addon: null, error: null });
  });
});
