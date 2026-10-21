// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 sections 1, 3.4, 3.5 and 11 D1: a Claude turn on Windows with no Git Bash runs on the CLI's own
// PowerShell tool (powershell-inherit) with the curated hand; with Git Bash it runs through Murage's wrapper and the PowerShell
// tool is off; each mode denies the other's shell tool; the isolation overlay restates the hand over every settings `env`.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABSENT_PINS, valuePins } from "../../shared/arg-vocabulary.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as claude from "./claude.ts";

// The module's own exports, read loosely so this file fails as a test (not as a type error) at a base without them.
const mod = claude as unknown as Record<string, (...args: unknown[]) => any>;

const WIN_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PREFIX = "C:/Users/o/AppData/Roaming/Murage/murage-exec-abc";
const ARGS = ["-p", "--tools", "Read,Edit,Bash,PowerShell", "--disallowedTools", "WebFetch"];

function winHand(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: "C:\\Windows\\System32;C:\\Windows", USERPROFILE: "C:\\Users\\o", PSModulePath: "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", RSYNC_RSH: "ssh -o BatchMode=yes", ...extra };
  for (const [name, value] of valuePins("win32")) env[name] = value;
  return env;
}

describe("section 1: two modes, each enforcing its tools", () => {
  it("Windows with no Git Bash is powershell-inherit, never refused", () => {
    expect(claude.claudeShellRefusal("win32", null)).toBeNull();
    expect(mod.claudeShellMode("win32", { bash: null, reason: "no-git-bash" })).toEqual({ kind: "powershell-inherit", reason: "no-git-bash" });
    expect(mod.claudeShellMode("win32", { bash: null, reason: "override-not-bash" })).toEqual({ kind: "powershell-inherit", reason: "override-not-bash" });
    expect(mod.claudeShellMode("win32", { bash: WIN_BASH })).toEqual({ kind: "murage-exec", shell: WIN_BASH });
    expect(mod.claudeShellMode("linux", { bash: null })).toBeNull();
  });

  it("POSIX with no bash or zsh refuses with fix-it copy (Q6)", () => {
    const refusal = claude.claudeShellRefusal("linux", null);
    expect(refusal?.refused).toBe(true);
    expect(refusal?.cause).toContain("/bin/bash, /usr/bin/bash or /bin/zsh");
    expect(claude.claudeShellRefusal("darwin", null)?.refused).toBe(true);
  });

  it("inherit: PowerShell tool on, launcher off, no wrapper names, override removed, Bash denied, owner lists kept", () => {
    const hand = winHand({ CLAUDE_CODE_GIT_BASH_PATH: "E:\\sh.exe", claude_code_use_powershell_tool: "0", CLAUDE_CODE_SHELL_PREFIX: "x", MURAGE_EXEC_ENV_FILE: "y" });
    const setup = mod.claudeShellSetup("win32", { kind: "powershell-inherit", reason: "override-not-bash" }, hand, ARGS, "", { tools: ["Read", "Edit", "Bash", "PowerShell"], disallowedTools: ["WebFetch"] });
    expect(setup.env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe("1");
    expect(setup.env.CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER).toBe("1");
    for (const name of ["CLAUDE_CODE_SHELL_PREFIX", "CLAUDE_CODE_SHELL", "MURAGE_EXEC_ENV_FILE", "CLAUDE_CODE_GIT_BASH_PATH", "claude_code_use_powershell_tool"]) expect(setup.env[name], name).toBeUndefined();
    expect(setup.args.slice(0, 3)).toEqual(["-p", "--tools", "Read,Edit,Bash,PowerShell"]);
    expect(setup.args[setup.args.indexOf("--disallowedTools") + 1]).toBe("WebFetch,Bash");
    expect(setup.dispatch).toBe("shell=powershell-inherit reason=override-not-bash");
    // the CLI spawns the servers itself: no MURAGE_EXEC_KEEP
    const servers = { s: { command: "node", args: [], env: { A: "1" } } };
    expect(mod.claudeShellServers({ kind: "powershell-inherit", reason: "no-git-bash" }, servers)).toEqual(servers);
  });

  it("bash on Windows: today's names plus USE_POWERSHELL_TOOL=0 (an owner 1 overridden, logged) and PowerShell denied", () => {
    const hand = winHand({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" });
    const setup = mod.claudeShellSetup("win32", { kind: "murage-exec", shell: WIN_BASH }, hand, ["-p"], PREFIX);
    expect(setup.env).toEqual({ ...hand, CLAUDE_CODE_SHELL_PREFIX: PREFIX, CLAUDE_CODE_SHELL: WIN_BASH, MURAGE_EXEC_ENV_FILE: "", CLAUDE_CODE_GIT_BASH_PATH: WIN_BASH, CLAUDE_CODE_USE_POWERSHELL_TOOL: "0" });
    expect(setup.args).toEqual(["-p", "--disallowedTools", "PowerShell"]);
    expect(setup.logs.join("\n")).toContain("powershell-tool=off reason=bash-wrapped");
    expect(setup.dispatch).toBe(`shell=murage-exec:${WIN_BASH} powershell-tool=off`);
    const servers = { s: { command: "node", args: [], env: { A: "1" } } };
    expect(mod.claudeShellServers({ kind: "murage-exec", shell: WIN_BASH }, servers)).toEqual({ s: { command: "node", args: [], env: { A: "1", MURAGE_EXEC_KEEP: "A" } } });
  });

  it("bash on POSIX: byte-identical to today (three names, argv untouched)", () => {
    const hand = { PATH: "/usr/bin:/bin", PAGER: "cat" };
    const setup = mod.claudeShellSetup("linux", { kind: "murage-exec", shell: "/bin/bash" }, hand, ARGS, "/tmp/murage-exec-1");
    expect(setup.env).toEqual({ ...hand, CLAUDE_CODE_SHELL_PREFIX: "/tmp/murage-exec-1", CLAUDE_CODE_SHELL: "/bin/bash", MURAGE_EXEC_ENV_FILE: "" });
    expect(setup.args).toEqual(ARGS);
    expect(setup.logs).toEqual([]);
    expect(setup.dispatch).toBe("shell=murage-exec:/bin/bash");
  });

  it("an owner list that leaves the mode's tool off runs with no command tool, said on the dispatch line", () => {
    const inherit = mod.claudeShellSetup("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, winHand(), ["--tools", "Read,Bash"], "", { tools: ["Read", "Bash"] });
    expect(inherit.dispatch).toBe("shell=powershell-inherit reason=no-git-bash command-tool=none reason=owner-tools");
    expect(inherit.args).toEqual(["--tools", "Read,Bash", "--disallowedTools", "Bash"]);
    const denied = mod.claudeShellSetup("linux", { kind: "murage-exec", shell: "/bin/bash" }, {}, [], "/p", { disallowedTools: ["Bash"] });
    expect(denied.dispatch).toContain("command-tool=none reason=owner-tools");
  });
});

describe("3.4 / 11 D1: the overlay env restates the hand over every settings env", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-nobash-"))); });
  afterEach(() => removeTempDirSync(dir));

  it("restates every value pin, PATH, the mode's names, NODE_OPTIONS, PSModulePath, and \"\" for four absent pins only", () => {
    const hand = winHand({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER: "1" });
    const overlay = mod.claudeOverlayEnv("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, hand, []);
    expect("refusal" in overlay).toBe(false);
    for (const [name, value] of valuePins("win32")) expect(overlay.env[name], name).toBe(value);
    expect(overlay.env.GIT_SSH_COMMAND).toBe(hand.GIT_SSH_COMMAND);
    expect(overlay.env.PATH).toBe(hand.PATH);
    expect(overlay.env.PSModulePath).toBe(hand.PSModulePath);
    expect(overlay.env.NODE_OPTIONS).toBe("");
    expect(overlay.env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe("1");
    expect(overlay.env.CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER).toBe("1");
    expect(overlay.env.CLAUDE_CODE_SHELL_PREFIX).toBe("");
    expect(overlay.env.CLAUDE_CODE_PLUGIN_DIRS).toBe("");
    for (const name of ["BASH_ENV", "ENV", "CLAUDE_ENV_FILE", "PYTHONINSPECT"]) expect(overlay.env[name], name).toBe("");
    for (const name of ["POSIXLY_CORRECT", "GIT_SSH"]) expect(name in overlay.env, name).toBe(false);
    expect(ABSENT_PINS.length).toBe(6);
    // the Bash path restates its own names
    const bash = mod.claudeOverlayEnv("win32", { kind: "murage-exec", shell: WIN_BASH }, { ...hand, CLAUDE_CODE_SHELL_PREFIX: PREFIX, CLAUDE_CODE_SHELL: WIN_BASH, CLAUDE_CODE_GIT_BASH_PATH: WIN_BASH, MURAGE_EXEC_ENV_FILE: "C:\\env" }, []);
    expect(bash.env).toMatchObject({ CLAUDE_CODE_SHELL_PREFIX: PREFIX, CLAUDE_CODE_SHELL: WIN_BASH, CLAUDE_CODE_GIT_BASH_PATH: WIN_BASH, MURAGE_EXEC_ENV_FILE: "C:\\env" });
  });

  it("every user, project and local settings env key is in the overlay: the handed value, else \"\"", () => {
    const config = join(dir, "config");
    const cwd = join(dir, "work");
    mkdirSync(config, { recursive: true });
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ env: { MURAGE_CANARY_USER: "1" } }));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { MURAGE_CANARY_PROJ: "1", PAGER: "evil", BASH_ENV: "C:\\evil" } }));
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { MURAGE_CANARY_PROJ: "1", USERPROFILE: "C:\\evil" } }));
    const files = mod.claudeSettingsEnvFiles({ CLAUDE_CONFIG_DIR: config }, cwd);
    expect(files).toEqual(expect.arrayContaining([{ path: join(config, "settings.json"), source: "user" }, { path: join(cwd, ".claude", "settings.json"), source: "project" }, { path: join(cwd, ".claude", "settings.local.json"), source: "local" }]));
    const overlay = mod.claudeOverlayEnv("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, winHand(), files);
    expect(overlay.env.MURAGE_CANARY_USER).toBe("");
    expect(overlay.env.MURAGE_CANARY_PROJ).toBe("");
    expect(overlay.env.PAGER).toBe("cat");
    expect(overlay.env.BASH_ENV).toBe("");
    expect(overlay.env.USERPROFILE).toBe("C:\\Users\\o");
    // the isolation settings carry it, the plugin directory variable still empty
    const settings = claude.claudeIsolationSettings({ CLAUDE_CONFIG_DIR: config }, cwd, "win32", overlay.env) as { env: Record<string, string> };
    expect(settings.env).toEqual({ ...overlay.env, CLAUDE_CODE_PLUGIN_DIRS: "" });
  });

  it("a settings file that cannot be parsed refuses the turn (fail closed)", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "{ not json");
    const overlay = mod.claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin" }, [{ path: file, source: "project" }]);
    expect(overlay.refusal).toContain(file);
    expect(overlay.refusal).toMatch(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ env: ["PAGER"] }));
    expect(mod.claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/bin" }, [{ path: file, source: "user" }]).refusal).toContain(file);
  });

  it("POSIXLY_CORRECT or GIT_SSH in a settings env refuses with copy naming the file and key", () => {
    const file = join(dir, "settings.json");
    for (const name of ["POSIXLY_CORRECT", "GIT_SSH"]) {
      writeFileSync(file, JSON.stringify({ env: { [name]: "1" } }));
      const overlay = mod.claudeOverlayEnv("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, winHand(), [{ path: file, source: "local" }]);
      expect(overlay.refusal).toContain(file);
      expect(overlay.refusal).toContain(name);
    }
  });

  it("managed settings that redefine a pinned or canary-class name are named, not fought", () => {
    const managed = join(dir, "managed-settings.json");
    writeFileSync(managed, JSON.stringify({ env: { PAGER: "less", MURAGE_CANARY_MANAGED: "1", HARMLESS: "1" } }));
    const overlay = mod.claudeOverlayEnv("win32", { kind: "powershell-inherit", reason: "no-git-bash" }, winHand(), [], [managed]);
    expect(overlay.managed).toEqual(["MURAGE_CANARY_MANAGED", "PAGER"]);
    expect(overlay.env.PAGER).toBe("cat");
  });
});

describe("3.5: the inherit path's record", () => {
  it("the PowerShell form and the provisional 2.1.305 additions list", () => {
    expect(mod.CLAUDE_POWERSHELL_FORM).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
    expect((mod.CLAUDE_INHERIT_ADDS as unknown as Record<string, string[]>)["2.1.305"]).toEqual(expect.arrayContaining(["CLAUDECODE", "PYTHONIOENCODING", "NO_COLOR"]));
    expect(mod.CLAUDE_UNENFORCEABLE_ABSENT).toEqual(["POSIXLY_CORRECT", "GIT_SSH"]);
  });
});

describe("5.4: the gate's hashed record of the hand (MURAGE_GATE_MCP_RECORD)", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-gate-record-"))); });
  afterEach(() => removeTempDirSync(dir));
  const SENTINEL = "MURAGE-SENTINEL-4f1c-ANTHROPIC_API_KEY";
  const handed = { PATH: "/usr/bin", ANTHROPIC_API_KEY: SENTINEL, PAGER: "cat", A_FIRST: "x" };

  it("holds no value, only salted hashes and lengths, names sorted, one line per turn", () => {
    const file = join(dir, "record.jsonl");
    expect(mod.writeClaudeGateRecord(file, handed, "powershell-inherit")).toBe(true);
    expect(mod.writeClaudeGateRecord(file, handed, "murage-exec")).toBe(true);
    const bytes = readFileSync(file, "utf8");
    for (const value of Object.values(handed)) if (value.length > 3) expect(bytes.includes(value), value).toBe(false);
    expect(bytes.includes("MURAGE-SENTINEL")).toBe(false);
    const lines = bytes.trim().split("\n").map((line) => JSON.parse(line) as { v: number; salt: string; handed: Record<string, { sha256: string; len: number }>; mode: string });
    expect(lines.map((line) => line.mode)).toEqual(["powershell-inherit", "murage-exec"]);
    const [first] = lines;
    expect(first!.v).toBe(1);
    expect(first!.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(first!.handed)).toEqual(Object.keys(handed).sort());
    for (const [name, value] of Object.entries(handed)) {
      expect(first!.handed[name]).toEqual({ sha256: createHash("sha256").update(first!.salt + value).digest("hex"), len: value.length });
    }
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("an unset variable writes nothing; a symlink at the path is unlinked and replaced, its target never written", () => {
    expect(mod.writeClaudeGateRecord(undefined, handed, "murage-exec")).toBe(false);
    expect(mod.writeClaudeGateRecord("", handed, "murage-exec")).toBe(false);
    const target = join(dir, "target");
    writeFileSync(target, "keep\n");
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);
    expect(mod.writeClaudeGateRecord(link, handed, "murage-exec")).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).not.toContain("keep");
    expect(existsSync(join(dir, "never.jsonl"))).toBe(false);
  });

  it("CLAUDE_INHERIT_ADDS is exported, keyed by CLI version", () => {
    expect(Object.keys(claude.CLAUDE_INHERIT_ADDS)).toContain("2.1.305");
  });
});
