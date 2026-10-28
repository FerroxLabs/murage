// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 sections 1, 3.4, 3.5 and 11 D1: a Claude turn on Windows with no Git Bash runs on the CLI's own
// PowerShell tool (powershell-inherit) with the curated hand; with Git Bash it runs through Murage's wrapper and the PowerShell
// tool is off; each mode denies the other's shell tool; the isolation overlay restates the hand over every settings `env`.

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ABSENT_PINS, valuePins } from "../../shared/arg-vocabulary.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as claude from "./claude.ts";
import { ClaudeGateRecord } from "./claude-private.ts";

// The module's own exports, read loosely so this file fails as a test (not as a type error) at a base without them.
const mod = claude as unknown as Record<string, (...args: unknown[]) => any>;
/** Windows: the owner-only ACL comes from the native murage-browser-host.exe, which vitest does not build; a stand-in fs keeps the
 * real record logic under test (the native helper itself is covered in electron/browser-extension-windows tests). */
function gateRecordFor(): ClaudeGateRecord | undefined {
  if (process.platform !== "win32") return undefined;
  return new ClaudeGateRecord({ platform: "win32", makeWindowsDir: () => undefined, writeWindowsFile: (path, data) => writeFileSync(path, data), uid: () => undefined });
}


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
    expect(mod.claudeShellServers({ kind: "murage-exec", shell: WIN_BASH }, servers, "win32", hand)).toEqual({ s: { command: "node", args: [], env: { A: "1", MURAGE_EXEC_KEEP: "A", PATH: `C:\\Program Files\\Git\\bin;${hand.Path ?? hand.PATH}` } } });
  });

  // 1.0.3.1 Critical: the CLI starts every stdio server as `<murage-exec> "<command>"` through cross-spawn, which reads the
  // wrapper's `#!/bin/bash` and looks `bash` up on the server's PATH. A stock Git for Windows install puts only Git\cmd on
  // PATH, so muragebox (and every other server) failed and the first approval ended the CLI with exit 1.
  it("bash on Windows: every stdio server's PATH starts with the found bash's folder, which the wrapper does not carry", () => {
    const hand = { Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd", SystemRoot: "C:\\Windows" };
    const mode = { kind: "murage-exec", shell: WIN_BASH };
    const servers = {
      muragebox: { command: "C:\\Murage\\Murage.exe", args: ["proxy.js", "//./pipe/x"], env: { ELECTRON_RUN_AS_NODE: "1" } },
      bare: { command: "node", args: [] },
      owner: { command: "tool.exe", args: [], env: { Path: "D:\\tools", K: "v" } },
      remote: { type: "http", url: "https://example.test/mcp" },
    };
    const out = mod.claudeShellServers(mode, servers, "win32", hand);
    // the upper-case name is the one the CLI's lookup reads; the found bash comes first, so no other bash (WSL's) wins
    expect(out.muragebox.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", MURAGE_EXEC_KEEP: "ELECTRON_RUN_AS_NODE", PATH: "C:\\Program Files\\Git\\bin;C:\\Windows\\system32;C:\\Program Files\\Git\\cmd" });
    expect(out.bare.env).toEqual({ PATH: "C:\\Program Files\\Git\\bin;C:\\Windows\\system32;C:\\Program Files\\Git\\cmd" });
    // an owner's own PATH is kept (and still carried by the wrapper), with the folder in front
    expect(out.owner.env).toEqual({ K: "v", MURAGE_EXEC_KEEP: "PATH,K", PATH: "C:\\Program Files\\Git\\bin;D:\\tools" });
    expect(out.remote).toEqual(servers.remote);
    // a bash found under usr\\bin puts that folder first, once
    const usr = mod.claudeShellServers({ kind: "murage-exec", shell: "C:\\Git\\usr\\bin\\bash.exe" }, { s: { command: "node", args: [] } }, "win32", { PATH: "C:\\Git\\usr\\bin;C:\\x" });
    expect(usr.s.env.PATH).toBe("C:\\Git\\usr\\bin;C:\\x");
    // POSIX is untouched: no PATH is added
    expect(mod.claudeShellServers({ kind: "murage-exec", shell: "/bin/bash" }, { s: { command: "node", args: [], env: { A: "1" } } }, "linux", { PATH: "/usr/bin" })).toEqual({ s: { command: "node", args: [], env: { A: "1", MURAGE_EXEC_KEEP: "A" } } });
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
    // 14.6: a value pin with an empty value is left out (LESS, SSH_ASKPASS) unless pending (GIT_ASKPASS)
    for (const [name, value] of valuePins("win32")) expect(overlay.env[name], name).toBe(value === "" && !(mod.CLAUDE_OVERLAY_EMPTY_ALLOWED as unknown as string[]).includes(name) ? undefined : value);
    expect(overlay.env.GIT_SSH_COMMAND).toBe(hand.GIT_SSH_COMMAND);
    expect(overlay.env.PATH).toBe(hand.PATH);
    expect(overlay.env.PSModulePath).toBe(hand.PSModulePath);
    expect(overlay.env.NODE_OPTIONS).toBe("");
    expect(overlay.env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe("1");
    expect(overlay.env.CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER).toBe("1");
    expect(overlay.env.CLAUDE_CODE_SHELL_PREFIX).toBe("");
    expect(overlay.env.CLAUDE_CODE_PLUGIN_DIRS).toBe("");
    // 14.6: BASH_ENV takes the neutral /dev/null; ENV (1.0.4 U19), CLAUDE_ENV_FILE and PYTHONINSPECT stay "" (ruled, CLAUDE_OVERLAY_EMPTY_ALLOWED)
    expect(overlay.env.BASH_ENV).toBe("/dev/null");
    for (const name of ["ENV", "CLAUDE_ENV_FILE", "PYTHONINSPECT"]) expect(overlay.env[name], name).toBe("");
    for (const name of ["POSIXLY_CORRECT", "GIT_SSH"]) expect(name in overlay.env, name).toBe(false);
    expect(ABSENT_PINS.length).toBe(8);
    // the Bash path restates its own names
    const bash = mod.claudeOverlayEnv("win32", { kind: "murage-exec", shell: WIN_BASH }, { ...hand, CLAUDE_CODE_SHELL_PREFIX: PREFIX, CLAUDE_CODE_SHELL: WIN_BASH, CLAUDE_CODE_GIT_BASH_PATH: WIN_BASH, MURAGE_EXEC_ENV_FILE: "C:\\env" }, []);
    expect(bash.env).toMatchObject({ CLAUDE_CODE_SHELL_PREFIX: PREFIX, CLAUDE_CODE_SHELL: WIN_BASH, CLAUDE_CODE_GIT_BASH_PATH: WIN_BASH, MURAGE_EXEC_ENV_FILE: "C:\\env" });
  });

  it("every user, project and local settings env key: the non-empty handed value, else left out (14.6)", () => {
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
    expect(overlay.env.MURAGE_CANARY_USER).toBeUndefined();
    expect(overlay.env.MURAGE_CANARY_PROJ).toBeUndefined();
    expect(overlay.env.PAGER).toBe("cat");
    expect(overlay.env.BASH_ENV).toBe("/dev/null");
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
  it("the PowerShell form and the 2.1.305 additions list, as measured live (plus CLAUDE_EFFORT, added when a turn has an effort)", () => {
    expect(mod.CLAUDE_POWERSHELL_FORM).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
    expect([...(mod.CLAUDE_INHERIT_ADDS as unknown as Record<string, string[]>)["2.1.305"]!].sort()).toEqual(["AI_AGENT", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID", "COREPACK_ENABLE_AUTO_PIN", "NO_COLOR", "NoDefaultCurrentDirectoryInExePath", "PSExecutionPolicyPreference", "PYTHONIOENCODING"].sort());
    expect((mod.CLAUDE_INHERIT_ADDS as unknown as Record<string, string[]>)["2.1.305"]).not.toContain("CLAUDE_CODE_SSE_PORT");
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
    const record = gateRecordFor();
    expect(mod.writeClaudeGateRecord(file, handed, "powershell-inherit", record)).toBe(true);
    expect(mod.writeClaudeGateRecord(file, handed, "murage-exec", record)).toBe(true);
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
    expect(mod.writeClaudeGateRecord(link, handed, "murage-exec", gateRecordFor())).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).not.toContain("keep");
    expect(existsSync(join(dir, "never.jsonl"))).toBe(false);
  });

  it("CLAUDE_INHERIT_ADDS is exported, keyed by CLI version", () => {
    expect(Object.keys(claude.CLAUDE_INHERIT_ADDS)).toContain("2.1.305");
  });
});

// 1.0.5 (Chip, Windows): every built-in MCP server is started through the murage-exec wrapper, so a wrapper that cannot run on
// the machine left every one of them "Connection closed" with no reason. A found Git Bash is used only after a pre-flight
// start through the wrapper passes; otherwise the turn runs powershell-inherit and says why.
describe("1.0.5: the wrapper pre-flight decides murage-exec on Windows", () => {
  const found = async () => ({ bash: WIN_BASH });
  it("a failed pre-flight runs the turn on powershell-inherit with the reason", async () => {
    const out = await mod.claudeShellDiscovery("win32", winHand(), 1, { gitBash: found, launchCheck: async () => ({ ok: false, detail: "exit=126 stderr=\"murage-exec: cygpath is not available\"" }) });
    expect(out).toEqual({ bash: null, reason: "wrapper-failed", detail: "exit=126 stderr=\"murage-exec: cygpath is not available\"" });
    expect(claude.claudeShellMode("win32", out)).toEqual({ kind: "powershell-inherit", reason: "wrapper-failed" });
  });
  it("a pre-flight that throws counts as failed", async () => {
    const out = await mod.claudeShellDiscovery("win32", winHand(), 1, { gitBash: found, launchCheck: async () => { throw new Error("spawn EPERM sk-ant-SECRET"); } });
    expect(out.bash).toBeNull();
    expect(out.reason).toBe("wrapper-failed");
    // r2 (Grok High): a fixed reason only, never the error's message
    expect(out.detail).toBe("reason=check-error");
  });
  it("a passed pre-flight keeps the found Git Bash", async () => {
    const seen: string[] = [];
    const out = await mod.claudeShellDiscovery("win32", winHand(), 1, { gitBash: found, launchCheck: async (shell: string) => { seen.push(shell); return { ok: true }; } });
    expect(out).toEqual({ bash: WIN_BASH });
    expect(seen).toEqual([WIN_BASH]);
  });
  it("no Git Bash runs no pre-flight", async () => {
    let calls = 0;
    const out = await mod.claudeShellDiscovery("win32", winHand(), 1, { gitBash: async () => ({ bash: null, reason: "no-git-bash" }), launchCheck: async () => { calls++; return { ok: true }; } });
    expect(out).toEqual({ bash: null, reason: "no-git-bash" });
    expect(calls).toBe(0);
  });
});

describe.skipIf(process.platform === "win32" || !existsSync("/bin/bash"))("1.0.5: claudeExecLaunchCheck starts a server through the real wrapper", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "launch-check-")); mod.resetClaudeExecLaunchCheckForTests?.(); });
  afterEach(() => { removeTempDirSync(dir); });
  const hand = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir });
  it("passes when the wrapper runs the command and the marker comes back", async () => {
    expect(await mod.claudeExecLaunchCheck("/bin/bash", hand(), dir, 7, { platform: process.platform })).toEqual({ ok: true });
  });
  it("fails with the wrapper's own exit status when it cannot start the command", async () => {
    const out = await mod.claudeExecLaunchCheck("/bin/bash", hand(), join(dir, "missing"), 7, { platform: process.platform });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/^exit=126/);
  });
  it("fails when the command never prints the marker", async () => {
    const out = await mod.claudeExecLaunchCheck("/bin/bash", hand(), dir, 7, { platform: process.platform, runtime: join(dir, "no-such-runtime") });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/^exit=127/);
  });
  it("keeps a pass for the generation and checks again in a new one", async () => {
    expect(await mod.claudeExecLaunchCheck("/bin/bash", hand(), dir, 8, { platform: process.platform })).toEqual({ ok: true });
    expect(await mod.claudeExecLaunchCheck("/bin/bash", hand(), dir, 8, { platform: process.platform, runtime: join(dir, "no-such-runtime") })).toEqual({ ok: true });
    expect((await mod.claudeExecLaunchCheck("/bin/bash", hand(), dir, 9, { platform: process.platform, runtime: join(dir, "no-such-runtime") })).ok).toBe(false);
  });
});

// r2 (Grok High, Astra HIGH): the pre-flight runs with the pinned environment the engine run gets, logs only an exit status and a
// fixed reason, and checks again when the shell is replaced at the same path.
describe.skipIf(process.platform === "win32" || !existsSync("/bin/bash"))("1.0.5 r2: the pre-flight's pinned environment, log line and cache", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "launch-check-r2-")); mod.resetClaudeExecLaunchCheckForTests?.(); });
  afterEach(() => { removeTempDirSync(dir); });
  const hand = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...extra });
  it("a handed NODE_OPTIONS --require runs nothing inside the pre-flight", async () => {
    const ran = join(dir, "required-ran");
    const hook = join(dir, "hook.cjs");
    writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "x");`);
    expect(await mod.claudeExecLaunchCheck("/bin/bash", hand({ NODE_OPTIONS: `--require ${hook}` }), dir, 21, { platform: process.platform })).toEqual({ ok: true });
    expect(existsSync(ran)).toBe(false);
  });
  it("a handed BASH_ENV or ENV is not sourced by the pre-flight's shell", async () => {
    const ran = join(dir, "sourced-ran");
    const rc = join(dir, "rc.sh");
    writeFileSync(rc, `echo x > ${JSON.stringify(ran)}\n`);
    expect(await mod.claudeExecLaunchCheck("/bin/bash", hand({ BASH_ENV: rc, ENV: rc }), dir, 22, { platform: process.platform })).toEqual({ ok: true });
    expect(existsSync(ran)).toBe(false);
  });
  it("a failure's detail is the exit status and a fixed reason, never the child's stderr", async () => {
    const out = await mod.claudeExecLaunchCheck("/bin/bash", hand(), dir, 23, { platform: process.platform, runtime: join(dir, "sk-ant-SECRET-runtime") });
    expect(out).toEqual({ ok: false, detail: "exit=127 reason=wrapper-exit" });
  });
  it("a shell replaced at the same path is checked again in the same generation", async () => {
    const shell = join(dir, "bash");
    copyFileSync("/bin/bash", shell);
    chmodSync(shell, 0o755);
    expect(await mod.claudeExecLaunchCheck(shell, hand(), dir, 24, { platform: process.platform })).toEqual({ ok: true });
    writeFileSync(shell, "#!/bin/sh\nexit 3\n");
    chmodSync(shell, 0o755);
    expect(await mod.claudeExecLaunchCheck(shell, hand(), dir, 24, { platform: process.platform })).toEqual({ ok: false, detail: "exit=3 reason=wrapper-exit" });
  });
});
