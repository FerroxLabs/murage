// secret-scan: fixture
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 A SIMPLE r4.5 (ad31a481), direct-wrapper rows on POSIX: the KEEP class decision (B3), the reserved env-file entries
// (B3/B5), the per-spawn nonce (B1/B2), the overlay pin and restate (B0/B1/B4) and the managed refusal (B5). Each row
// names the mutant that turns it red. The real-CLI legs (S4p classes, S4p-static, S4p-reload, S10 on Mac and Windows)
// are the engine-gate rows; these run the REAL wrapper script with bash, as the CLI's shell prefix does.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeOverlayEnv, claudeShellServers } from "./claude.ts";
import { EXEC_KEEP, EXEC_NONCE, execDiagCount, execDiagPath, execEnvFileText, snapshotPathMissing, execFlagPath, execKeepHead, installMurageExec, newExecNonce, withExecKeep, writeExecEnvFile } from "./murage-exec.ts";

const BASH = process.platform === "win32" ? null : existsSync("/bin/bash") ? "/bin/bash" : null;
const hex = (c: string) => c.repeat(32);

describe.skipIf(!BASH)("X3 r4.5 wrapper class decision (direct wrapper, POSIX)", () => {
  let proj: string;
  let home: string;
  let snap: string;
  let wrapper: string;
  let n = 0;
  beforeEach(() => {
    proj = realpathSync.native(mkdtempSync(join(tmpdir(), "x3r4-w-")));
    home = join(proj, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    // the hostile snapshot: under Bash class W3 removes its `source`, so the builtin shopt runs and the cwd stays
    snap = join(proj, "snapshot.sh");
    writeFileSync(snap, `shopt(){ builtin cd ${home}/.ssh; }\n`);
    wrapper = installMurageExec();
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  const map = (extra: Record<string, string> = {}) => ({ HOME: home, PATH: "/usr/bin:/bin", ...extra });
  const envFileFor = (proven: boolean, extra: Record<string, string> = {}) => writeExecEnvFile(`x3r4-w-${process.pid}-${++n}`, map(extra), proj, BASH!, proven);
  /** The CLI's Bash tool command form (2.1.309 builder), with the snapshot `source` at the front. */
  const cliForm = (inner: string, out: string) => `source ${snap} 2>/dev/null || true && { shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true && eval '${inner}' < /dev/null && pwd -P >| ${out}`;
  const run = (command: string, envFile: string, env: Record<string, string> = {}) =>
    spawnSync(BASH!, [wrapper, command], { env: { HOME: home, PATH: "/usr/bin:/bin", MURAGE_EXEC_ENV_FILE: envFile, ...env }, encoding: "utf8" });
  const flagOf = (envFile: string) => (existsSync(execFlagPath(envFile)) ? readFileSync(execFlagPath(envFile), "utf8") : "");
  const diagOf = (envFile: string) => (existsSync(execDiagPath(envFile)) ? readFileSync(execDiagPath(envFile), "utf8") : "");

  it("Bash class (no KEEP): the snapshot is not sourced, `pwd -P` prints the turn folder, no flag, no .diag", () => {
    const file = envFileFor(true);
    const out = run(cliForm("pwd -P", join(proj, "cwd")), file, { [EXEC_NONCE]: hex("a") });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(proj);
    expect(flagOf(file)).toBe("");
    expect(diagOf(file)).toBe("");
  });

  it("MCP class needs the CLI's own nonce: with it the snapshot runs (the oracle MK2/MK4 lean on)", () => {
    const z = newExecNonce();
    const file = envFileFor(true);
    const out = run(`source ${snap} 2>/dev/null || true && shopt; pwd -P`, file, { [EXEC_NONCE]: z, [EXEC_KEEP]: execKeepHead(z) });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(join(home, ".ssh"));
    expect(diagOf(file)).toBe("");
  });

  it("S4p-forge (b) [MK2, MK2b]: KEEP with another nonce is Bash class: /w, one keep-mismatch .diag line, no flag; the next S4(b) call still refuses at PROVEN=1", () => {
    const z = newExecNonce();
    const file = envFileFor(true);
    const out = run(cliForm("pwd -P", join(proj, "cwd")), file, { [EXEC_NONCE]: z, [EXEC_KEEP]: execKeepHead(hex("0")) });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(proj);
    expect(diagOf(file)).toBe("keep-mismatch\n");
    expect(flagOf(file)).toBe("");
    // S4(b): no snapshot segment at PROVEN=1: refused, flagged
    const next = run("cd ~/.ssh && pwd -P", file, { [EXEC_NONCE]: z });
    expect(next.status).toBe(126);
    expect(next.stdout).toBe("");
    expect(flagOf(file)).toMatch(/^reason=no-snapshot shape=[0-9]+\n$/);
  });

  it("S4p-forge (c) [MK4]: spawn 1's nonce in spawn 2 is Bash class", () => {
    const one = newExecNonce();
    const two = newExecNonce();
    expect(two).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    const file = envFileFor(true);
    const out = run(cliForm("pwd -P", join(proj, "cwd")), file, { [EXEC_NONCE]: two, [EXEC_KEEP]: execKeepHead(one) });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(proj);
  });

  it("MK3b: Bash class keeps no name: KEEP=mcp:<wrong>:SECRETX with SECRETX set prints unset", () => {
    const file = envFileFor(true);
    const out = run(cliForm('printf "%s" "${SECRETX-unset}"', join(proj, "cwd")), file, { [EXEC_NONCE]: hex("b"), [EXEC_KEEP]: `${execKeepHead(hex("c"))}SECRETX`, SECRETX: "leak" });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("unset");
  });

  it("S4p-rewrite (a) [MH2c]: a file entry MURAGE_EXEC_NONCE=Y exits 126 'could not be read' and runs nothing", () => {
    const y = hex("d");
    const file = envFileFor(true);
    writeFileSync(file, `${readFileSync(file, "utf8")}MURAGE_EXEC_NONCE=${y}\0`);
    const marker = join(proj, "ran");
    const out = run(cliForm(`touch ${marker}`, join(proj, "cwd")), file, { [EXEC_NONCE]: hex("e"), [EXEC_KEEP]: execKeepHead(y) });
    expect(out.status).toBe(126);
    expect(out.stderr).toContain("could not be read");
    expect(existsSync(marker)).toBe(false);
    // (d): a file that could not be read floors the thread
    expect(flagOf(file)).toMatch(/reason=unreadable/);
  });

  it("S4p-rewrite (b): KEEP=mcp:Y:, file untouched, env nonce Z: Bash class, the turn folder", () => {
    const file = envFileFor(true);
    const out = run(cliForm("pwd -P", join(proj, "cwd")), file, { [EXEC_NONCE]: hex("1"), [EXEC_KEEP]: execKeepHead(hex("2")) });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(proj);
  });

  it("S4p-rewrite (c) and (c') [MH2b]: no env nonce: with the file entry 126; without it Bash class", () => {
    const y = hex("3");
    const file = envFileFor(true);
    const plain = run(cliForm("pwd -P", join(proj, "cwd")), file, { [EXEC_KEEP]: execKeepHead(y) });
    expect(plain.status).toBe(0);
    expect(plain.stdout.trim()).toBe(proj);
    writeFileSync(file, `${readFileSync(file, "utf8")}MURAGE_EXEC_NONCE=${y}\0`);
    const rewritten = run(cliForm("pwd -P", join(proj, "cwd")), file, { [EXEC_KEEP]: execKeepHead(y) });
    expect(rewritten.status).toBe(126);
  });

  it("S4p-rewrite (e) [MH2d]: PROVEN=0 runs an unlisted call on the floor and no command sees the name; PROVEN=2 is 126", () => {
    const file = envFileFor(false);
    const out = run('printf "%s|%s" "$(pwd -P)" "${MURAGE_EXEC_PROVEN-gone}"', file);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`${proj}|gone`);
    expect(flagOf(file)).toBe("");
    writeFileSync(file, readFileSync(file, "utf8").replace("MURAGE_EXEC_PROVEN=0\0", "MURAGE_EXEC_PROVEN=2\0"));
    expect(run("true", file).status).toBe(126);
  });

  it("S4p-rewrite (f) [MH2]: the reference is the wrapper's env: nonce Z, KEEP=mcp:Z:FOO, no file entry keeps FOO", () => {
    const z = newExecNonce();
    const file = envFileFor(true);
    const out = run(`printf '%s' "\${FOO-unset}"`, file, { [EXEC_NONCE]: z, [EXEC_KEEP]: `${execKeepHead(z)}FOO`, FOO: "fx" });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("fx");
  });

  it("an upper-case nonce is malformed (B3: 32 lower-case hex), so the call is Bash class", () => {
    const z = newExecNonce().toUpperCase();
    const file = envFileFor(true);
    const out = run(cliForm('printf "%s" "${FOO-unset}"', join(proj, "cwd")), file, { [EXEC_NONCE]: z, [EXEC_KEEP]: `mcp:${z}:FOO`, FOO: "fx" });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("unset");
  });
});

describe("X3 r4.5 B2/B5 marker and file text", () => {
  it("[MK1] every stanza with a string command carries mcp:<nonce>:<names>: env absent, {}, unkeepable only, set", () => {
    const z = newExecNonce();
    const out = withExecKeep({
      absent: { command: "x" }, empty: { command: "x", env: {} }, unkeepable: { command: "x", env: { "a-b": "x" } },
      set: { command: "x", env: { FOO: "x", MURAGE_EXEC_NONCE: "y", MURAGE_EXEC_KEEP: "z" } }, http: { type: "http", url: "https://example.invalid" },
    }, z) as Record<string, { env?: Record<string, string> }>;
    expect(out.absent!.env![EXEC_KEEP]).toBe(`mcp:${z}:`);
    expect(out.empty!.env![EXEC_KEEP]).toBe(`mcp:${z}:`);
    expect(out.unkeepable!.env![EXEC_KEEP]).toBe(`mcp:${z}:`);
    expect(out.set!.env).toEqual({ FOO: "x", [EXEC_KEEP]: `mcp:${z}:FOO` });
    expect(out.http!.env).toBeUndefined();
  });

  it("[MK3] the Windows own-Path rename touches the names part only; the head stays whole", () => {
    const z = newExecNonce();
    const out = claudeShellServers({ kind: "murage-exec", shell: "C:\\Git\\bin\\bash.exe" }, { s: { command: "x", env: { Path: "C:\\own", FOO: "1" } } }, "win32", { PATH: "C:\\hand" }, z) as Record<string, { env: Record<string, string> }>;
    expect(out.s!.env[EXEC_KEEP]).toBe(`mcp:${z}:PATH,FOO`);
    expect(out.s!.env.PATH!.startsWith("C:\\Git\\bin")).toBe(true);
  });

  it("B5: the env file holds the three reserved entries and drops every other MURAGE_EXEC_* name of the map", () => {
    const text = execEnvFileText({ A: "1", MURAGE_EXEC_NONCE: "n", MURAGE_EXEC_KEEP: "k", murage_exec_x: "y", MURAGE_EXEC_PROVEN: "1" }, "/w", "/bin/bash", true);
    expect(text.split("\0").filter(Boolean)).toEqual(["MURAGE_EXEC_CWD=/w", "MURAGE_EXEC_SHELL=/bin/bash", "MURAGE_EXEC_PROVEN=1", "A=1"]);
  });
});

describe("X3 r4.5 A5 engine-check counters", () => {
  it("[MA5] the snapshot's export PATH entries missing from the bot PATH are counted, value-free", () => {
    const snap = "shopt -s expand_aliases\nexport PATH='/old:/x'\nalias ll='ls -l'\nexport PATH='/home/u/br/bin:/usr/bin:/home/u/.cargo/bin/'\n";
    expect(snapshotPathMissing(snap, "/usr/bin:/home/u/.cargo/bin:/bin", "linux")).toBe(1);
    expect(snapshotPathMissing(snap, "/home/u/br/bin:/usr/bin:/home/u/.cargo/bin", "linux")).toBe(0);
    expect(snapshotPathMissing("alias x=y\n", "/usr/bin", "linux")).toBeNull();
    // Windows: the snapshot is MSYS, the bot PATH is the Windows spelling
    expect(snapshotPathMissing('export PATH="/c/Users/u/.cargo/bin:/usr/bin:/c/Tools"\n', "C:\\Users\\u\\.cargo\\bin;C:\\tools", "win32")).toBe(1);
  });

  it("the .diag count reads only keep-mismatch lines", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "x3r4-diag-")));
    try {
      const env = join(dir, "e");
      expect(execDiagCount(env)).toBe(0);
      writeFileSync(execDiagPath(env), "keep-mismatch\nkeep-mismatch\nother\n");
      expect(execDiagCount(env)).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("X3 r4.5 B0/B1/B4/B5 overlay", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync.native(mkdtempSync(join(tmpdir(), "x3r4-ov-"))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const settings = (env: Record<string, string>) => { const file = join(dir, `s${Math.random().toString(16).slice(2)}.json`); writeFileSync(file, JSON.stringify({ env })); return file; };

  it("S4p-static [MH1, MH1b]: a user KEEP=mcp:H: and NONCE=H are pinned \"\" and restated to the spawn's nonce, named in one line each", () => {
    const h = hex("f");
    const z = newExecNonce();
    const file = settings({ MURAGE_EXEC_KEEP: `mcp:${h}:`, MURAGE_EXEC_NONCE: h });
    const overlay = claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin", MURAGE_EXEC_ENV_FILE: "/p/env/x", [EXEC_NONCE]: z }, [{ path: file, source: "user" }]);
    expect("refusal" in overlay).toBe(false);
    if ("refusal" in overlay) return;
    expect(overlay.env[EXEC_KEEP]).toBe("");
    expect(overlay.env[EXEC_NONCE]).toBe(z);
    expect(overlay.logs).toEqual(expect.arrayContaining([`claude settings name MURAGE_EXEC_KEEP restated file=${file}`, `claude settings name MURAGE_EXEC_NONCE restated file=${file}`]));
  });

  it("with no settings file the overlay still pins KEEP to \"\" and restates the nonce", () => {
    const z = newExecNonce();
    const overlay = claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin", [EXEC_NONCE]: z }, []);
    if ("refusal" in overlay) throw new Error(overlay.refusal);
    expect(overlay.env[EXEC_KEEP]).toBe("");
    expect(overlay.env[EXEC_NONCE]).toBe(z);
  });

  it("[MK5] a MANAGED settings env naming any MURAGE_EXEC_* refuses the turn with the named line", () => {
    const managed = settings({ MURAGE_EXEC_ENV_FILE: "/tmp/x" });
    const overlay = claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin", [EXEC_NONCE]: newExecNonce() }, [], [managed]);
    expect("refusal" in overlay).toBe(true);
    if (!("refusal" in overlay)) return;
    expect(overlay.refusal).toContain(managed);
    expect(overlay.refusal).toContain("MURAGE_EXEC_ENV_FILE");
  });
});
