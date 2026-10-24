// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The REAL native addon (built by scripts/build-engine-exclusion.mjs; skipped where it is not built) reads back the home-deciding
// variables of a real second process, and only the names asked for (designs/ENGINE-CLOSED-SCOPE.md). With that, a real process that
// is "claude" on another home leaves this home closed, and the same process on this home makes it open.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { engineState } from "./engine-closed.ts";
import { exclOps } from "./engine-fs.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const built = builtAddonPath();
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-home-scope-real-")));
afterAll(() => removeTempDirSync(scratch));

const children: ChildProcess[] = [];
let restore: (() => void) | undefined;
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  restore?.();
  restore = undefined;
});
const sleepMs = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A real second process that sleeps, with exactly this environment (plus PATH and SystemRoot, which Windows needs to start). */
function start(env: Record<string, string>, argv0?: string): ChildProcess {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT"]) if (process.env[name]) base[name] = process.env[name]!;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...base, ...env }, stdio: "ignore", ...(argv0 ? { argv0 } : {}) });
  children.push(child);
  return child;
}

describe.skipIf(!built)("the real addon reads a process's home-deciding variables", () => {
  it("returns the asked-for names the process has, never the others; a process that is gone answers null", async () => {
    restore = useRealExclusion(built!);
    const config = join(scratch, "claude-config");
    const child = start({ CLAUDE_CONFIG_DIR: config, MURAGE_TEST_SECRET: "never-copied-4471" });
    let got: Record<string, string> | null = null;
    for (let tries = 0; tries < 200 && !got?.CLAUDE_CONFIG_DIR; tries++) { got = exclOps.environment(child.pid!, ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]); sleepMs(10); }
    expect(got).toEqual({ CLAUDE_CONFIG_DIR: config });
    expect(JSON.stringify(exclOps.environment(child.pid!, ["CLAUDE_CONFIG_DIR"]))).not.toContain("never-copied-4471");
    if (process.platform === "win32") expect(exclOps.environment(child.pid!, ["claude_config_dir"])).toEqual({ claude_config_dir: config });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    sleepMs(50);
    expect(exclOps.environment(child.pid!, ["CLAUDE_CONFIG_DIR"])).toBeNull();
  });

  // argv[0] is what the process list shows on macOS and Linux; Windows has no separate argv[0] to set
  it.skipIf(process.platform === "win32")("a real `claude` on another home leaves the home closed; on this home it is open", () => {
    restore = useRealExclusion(built!);
    const home = join(scratch, "account"), other = join(scratch, "owner");
    mkdirSync(home, { recursive: true });
    mkdirSync(other, { recursive: true });
    const seen = (want: string) => { for (let tries = 0; tries < 200; tries++) { if (engineState("claude", home).state === want) return true; sleepMs(10); } return false; };
    const outside = start({ HOME: other }, "claude");
    for (let tries = 0; tries < 200 && !exclOps.environment(outside.pid!, ["HOME"])?.HOME; tries++) sleepMs(10);
    expect(seen("closed")).toBe(true);
    start({ HOME: other, CLAUDE_CONFIG_DIR: home }, "claude");
    expect(seen("open")).toBe(true);
  });
});
