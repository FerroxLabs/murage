// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Codex PreToolUse gate, Rules 67 and 68 (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md): T91 (the per-version policy),
// T100 a..g on the pieces, T86 and T103 for Codex deliveries. The driver-level half runs in codex.test.ts against the fake app-server.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_FLOORS, CODEX_GATE_MIN, CODEX_HOOK_SCRIPT, CODEX_LOCAL_ORDINARY, CODEX_SHELL_FORM_FEATURES, CODEX_UNTRUSTED_RETIRED_MIN,
  CODEX_HOOK_LAUNCH_ENV, CodexHookGate, HOOK_ASK_BOUND_MS, HOOK_SCRIPT_DEADLINE_MS, HOOK_TIMEOUT_SEC, HookDecisionTable, codexGatePlan, codexHooksJson, codexShellFormArgs,
  codexHookWindowsCommand, hookConfigOf, hookEnvPathOf, hookLaunchLine, hookLivenessBound, hookLivenessSetting, hookSocketPath, hookWindowsLauncher, hookWindowsLaunchValue, HOOK_LAUNCHER_FILE, CODEX_HOOK_EXE_ENV, HOOK_LIVENESS_MS, HOOK_LIVENESS_WIN32_MS, windowsCmdPath, parseApplyPatch, sweepHookEnv, sweepAllHookEnv, HOOK_ENV_VAR, routeDelivery, stripOwnerHooks, tripwireLine, trustHooks, writeHookFiles, HOOKS_LIST_MS, HOOKS_LIST_RETRY_MS, hooksListBounds,
  type HookAnswer, type HookDelivery, type RouteContext,
} from "./codex-hook.ts";
import { codexTurnPolicy } from "./codex-isolation.ts";
import { OWN_UNASKED } from "../../shared/own-servers.ts";
import { ABSENT_PINS } from "../../shared/arg-vocabulary.ts";
import { removeTempDir } from "../testing/cleanup.ts";

let dir: string;
let project: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-codex-hook-"))); // Windows CI: the long name of RUNNER~1, as the gate reads it
  project = join(dir, "project");
  mkdirSync(project);
});
afterEach(async () => { await removeTempDir(dir); });

describe("T91: the approval policy per Codex version", () => {
  it("records the probed retirement version and keeps the gate floor below it", () => {
    expect(CODEX_UNTRUSTED_RETIRED_MIN).toEqual([0, 149, 0]);
    expect(CODEX_GATE_MIN).toEqual([0, 129, 0]);
    expect(CODEX_FLOORS.gate[1]!).toBeLessThan(CODEX_FLOORS.retired[1]!);
  });

  it("keeps the retired policy only below the retirement and gates from there", () => {
    expect(codexGatePlan("codex-cli 0.148.0")).toEqual({ mode: "legacy" });
    expect(codexGatePlan("codex-cli 0.129.0")).toEqual({ mode: "legacy" });
    expect(codexGatePlan("codex-cli 0.56.0")).toEqual({ mode: "legacy" });
    expect(codexGatePlan("codex-cli 0.149.0")).toEqual({ mode: "gated" });
    expect(codexGatePlan("codex-cli 0.163.0")).toEqual({ mode: "gated" });
    expect(codexGatePlan("codex-cli 1.2.3")).toEqual({ mode: "gated" });
    // an unknown version is never legacy: the handshake decides
    expect(codexGatePlan(undefined)).toEqual({ mode: "gated" });
  });

  it("refuses a retired build that cannot carry the gate", () => {
    // no real build sits between the floors; a floor pair that leaves one shows the rule
    expect(codexGatePlan("codex-cli 0.110.0", { retired: [0, 100, 0], gate: [0, 129, 0] })).toEqual({ mode: "refuse", why: "update-codex" });
    expect(codexGatePlan("codex-cli 0.129.0", { retired: [0, 100, 0], gate: [0, 129, 0] })).toEqual({ mode: "gated" });
  });

  it("sends exactly what the driver sent before the pin below the retirement, and on-request from it", () => {
    const retired = ["un", "trusted"].join("");
    const base = { proposalOnly: false };
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: false, enforceApproval: true }).approvalPolicy).toBe(retired);
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: true, enforceApproval: true }).approvalPolicy).toBe(retired);
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: true, enforceApproval: false }).approvalPolicy).toBe("never");
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: false, enforceApproval: false }).approvalPolicy).toBe("on-request");
    expect(codexTurnPolicy("codex-cli 0.147.0", { proposalOnly: true, fullAuto: true, enforceApproval: false })).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    for (const fullAuto of [false, true]) for (const enforceApproval of [false, true]) {
      expect(codexTurnPolicy("codex-cli 0.149.0", { ...base, fullAuto, enforceApproval }).approvalPolicy).toBe("on-request");
      expect(codexTurnPolicy("codex-cli 0.163.0", { ...base, fullAuto, enforceApproval }).approvalPolicy).toBe("on-request");
    }
    // the spelling follows the version below 0.69 as before
    expect(codexTurnPolicy("codex-cli 0.60.0", { ...base, fullAuto: false, enforceApproval: false })).toEqual({ approvalPolicy: "onRequest", sandbox: "workspaceWrite" });
    expect(codexTurnPolicy("codex-cli 0.163.0", { ...base, fullAuto: true })).toEqual({ approvalPolicy: "on-request", sandbox: "danger-full-access" });
  });
});

describe("T100a: what Murage writes into the scoped home", () => {
  it("writes hooks.json with one matcher-free PreToolUse and one SessionStart handler and nothing secret", () => {
    const home = join(dir, "scope");
    const files = writeHookFiles(home, hookSocketPath("abc"), "tok-123", hookEnvPathOf(home, "abc"), "/usr/bin/node");
    // 03-1: the env file is this process's own, under the scope's hook-env/
    expect(files.envFile).toBe(join(home, "hook-env", `${process.pid}-abc.env`));
    const json = JSON.parse(readFileSync(files.hooksJson, "utf8"));
    expect(Object.keys(json.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    for (const event of ["PreToolUse", "SessionStart"]) {
      expect(json.hooks[event]).toHaveLength(1);
      expect(json.hooks[event][0]).not.toHaveProperty("matcher");
      expect(json.hooks[event][0].hooks).toHaveLength(1);
      const handler = json.hooks[event][0].hooks[0];
      expect(handler.type).toBe("command");
      expect(handler.command).toBe(`/usr/bin/env ELECTRON_RUN_AS_NODE=1 "/usr/bin/node" "${files.script}"`);
      // Windows: the command names no quote and no spaced path (Codex escapes inner quotes, rig 0.153.3) and reads the same in cmd and
      // PowerShell (F3: Codex 0.163.0 runs it under `powershell -NoProfile -Command`); the launch line rides in the environment.
      expect(handler.command_windows).toBe(codexHookWindowsCommand());
      expect(handler.command_windows).not.toMatch(/"/);
      expect(handler.timeout).toBe(HOOK_TIMEOUT_SEC);
    }
    expect(HOOK_TIMEOUT_SEC).toBe(Math.ceil(HOOK_ASK_BOUND_MS / 1000) + 30);
    // the token and the socket are in the 0600 env file and nowhere else
    expect(readFileSync(files.hooksJson, "utf8")).not.toContain("tok-123");
    expect(readFileSync(files.script, "utf8")).not.toContain("tok-123");
    expect(readFileSync(files.envFile, "utf8")).toBe(`SOCKET=${hookSocketPath("abc")}\nTOKEN=tok-123\n`);
    if (process.platform !== "win32") expect(statMode(files.envFile)).toBe(0o600);
    // hooks.json is identical on the next turn, so the hash and the trust hold
    const before = readFileSync(files.hooksJson, "utf8");
    writeHookFiles(home, hookSocketPath("abc"), "tok-456", hookEnvPathOf(home, "abc"), "/usr/bin/node");
    expect(readFileSync(files.hooksJson, "utf8")).toBe(before);
    expect(readFileSync(files.envFile, "utf8")).toContain("tok-456");
    expect(codexHooksJson("/usr/bin/node", files.script)).toBe(before);
    expect(hookLaunchLine("/usr/bin/node", files.script)).toBe(`/usr/bin/env ELECTRON_RUN_AS_NODE=1 "/usr/bin/node" "${files.script}"`);
    expect(files.launcher).toBe(join(home, HOOK_LAUNCHER_FILE));
    expect(readFileSync(files.launcher, "utf8")).toBe(hookWindowsLauncher());
    // the launch line is part of the hook configuration, so a kept process whose node or script moved waits for a fresh proof
    expect(hookConfigOf(home, "/usr/bin/node")).not.toBe(hookConfigOf(home, "/opt/node/bin/node"));
  });

  // F3 (1.0.3 Windows gate): Codex picks the hook's shell (PowerShell `-NoProfile -Command`, cmd `/c`, or `%COMSPEC% /C "<command>"`;
  // codex-rs hooks/src/engine/command_runner.rs build_command). A string is shell-independent when its program is a bare absolute path
  // (no space, quote or variable: both shells run it the same way) and its arguments hold nothing special to PowerShell's argument
  // mode or to cmd outside quotes, except the one launch variable, which PowerShell passes on unread and the inner cmd expands.
  const shellIndependent = (command: string): boolean => {
    const [program, ...args] = command.split(" ");
    if (!program || !/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+\.exe$/i.test(program)) return false;
    const launch = `%${CODEX_HOOK_LAUNCH_ENV}%`;
    if (!args.every((arg) => arg === launch || /^[A-Za-z0-9_/:.\\-]+$/.test(arg))) return false;
    // the variable is read by an explicit inner cmd (`/c` right before it), never by whichever shell Codex picked
    return /\\cmd\.exe$/i.test(program) && args.at(-1) === launch && args.at(-2)?.toLowerCase() === "/c" && args.includes("/d");
  };

  it("hands Codex a Windows hook command that means the same in cmd and in PowerShell (F3)", () => {
    // the 1.0.3-rc command: cmd expanded it, PowerShell ran `%` (ForEach-Object) and the hook never started
    expect(shellIndependent(`%${CODEX_HOOK_LAUNCH_ENV}%`)).toBe(false);
    expect(shellIndependent(`& "C:\\Program Files\\nodejs\\node.exe" "x.mjs"`)).toBe(false);
    expect(shellIndependent(`"C:\\Program Files\\nodejs\\node.exe" "x.mjs"`)).toBe(false);
    const written = JSON.parse(codexHooksJson("C:\\Users\\Jo Smith\\node.exe", "C:\\Users\\Jo Smith\\scope\\murage-hook.mjs")).hooks;
    for (const event of ["PreToolUse", "SessionStart"]) expect(shellIndependent(written[event][0].hooks[0].command_windows)).toBe(true);
    expect(codexHookWindowsCommand("D:\\WINNT")).toBe(`D:\\WINNT\\System32\\cmd.exe /d /v:off /c %${CODEX_HOOK_LAUNCH_ENV}%`);
    // a system folder that is not a plain path never reaches the command
    for (const odd of ["C:\\Win dows", "C:\\W\"in", "%SystemRoot%", "C:\\$x", "relative", ""]) {
      expect(windowsCmdPath(odd)).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(shellIndependent(codexHookWindowsCommand(odd))).toBe(true);
    }
    // the launch line never starts with a quote, so the inner cmd's /c rule cannot strip its first and last quote when an outer cmd
    // expanded the variable first
    const value = hookWindowsLaunchValue("C:\\Users\\Jo Smith\\scope\\murage-hook.cmd");
    expect(value).toBe(`@"C:\\Users\\Jo Smith\\scope\\murage-hook.cmd"`);
    expect(value.startsWith("\"")).toBe(false);
  });

  it.runIf(process.platform === "win32")("runs the Windows command under cmd.exe /C both ways Codex quotes it and under PowerShell -NoProfile -Command, from a node path with a space", async () => {
    const home = join(dir, "scope win");
    const gate = new CodexHookGate(hookSocketPath());
    await gate.listen();
    try {
      const files = writeHookFiles(home, gate.path, "win-token", hookEnvPathOf(home, gate.id));
      const sessions: string[] = [];
      gate.arm({ token: "win-token", onSession: (id) => { sessions.push(id); }, onPreTool: async () => ({ decision: "allow" }) });
      const command = JSON.parse(readFileSync(files.hooksJson, "utf8")).hooks.SessionStart[0].hooks[0].command_windows as string;
      const env: NodeJS.ProcessEnv = { ...process.env, [CODEX_HOOK_LAUNCH_ENV]: hookWindowsLaunchValue(files.launcher), [CODEX_HOOK_EXE_ENV]: process.execPath, [HOOK_ENV_VAR]: files.envFile };
      delete env.ELECTRON_RUN_AS_NODE;
      const comspec = process.env.COMSPEC ?? "cmd.exe";
      const runCmd = (args: string[], verbatim: boolean, id: string, program = comspec) => new Promise<number | null>((resolve) => {
        const child = spawn(program, args, { env, windowsVerbatimArguments: verbatim, stdio: ["pipe", "ignore", "ignore"] });
        child.on("close", (code) => resolve(code));
        child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: id, source: "startup" }));
      });
      // Codex 0.153.3 (std arg escaping) and the raw `"<command>"` form of later builds
      expect(await runCmd(["/C", command], false, "escaped")).toBe(0);
      expect(await runCmd(["/C", `"${command}"`], true, "raw")).toBe(0);
      // Codex 0.163.0 with PowerShell as the user shell (F3)
      expect(await runCmd(["-NoProfile", "-Command", command], false, "powershell", "powershell.exe")).toBe(0);
      expect(sessions).toEqual(["escaped", "raw", "powershell"]);
    } finally { gate.close(); }
  });

  // 1.0.3 packaged gate (Windows, Codex 0.163.0): process.execPath is the Murage binary (Electron), which runs a script only with
  // ELECTRON_RUN_AS_NODE=1. The server (a utilityProcess) does not carry it and Codex hands hooks Murage's env, so every launch form
  // sets it itself.
  const PACKAGED_WIN = "C:\\Users\\Jo Smith\\AppData\\Local\\Programs\\Murage\\Murage.exe";
  const SCOPE_WIN = "C:\\Users\\Jo Smith\\AppData\\Roaming\\Murage\\scopes\\codex\\b1\\murage-hook.mjs";
  it("runs the packaged Murage binary in node mode from every launch form (exact command and launcher)", () => {
    expect(hookLaunchLine("/Applications/Murage.app/Contents/MacOS/Murage", "/Users/alex/Library/Application Support/Murage/s/murage-hook.mjs"))
      .toBe(`/usr/bin/env ELECTRON_RUN_AS_NODE=1 "/Applications/Murage.app/Contents/MacOS/Murage" "/Users/alex/Library/Application Support/Murage/s/murage-hook.mjs"`);
    expect(hookWindowsLauncher()).toBe(
      `@echo off\r\nif not defined MURAGE_CODEX_EXE exit /b 2\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%MURAGE_CODEX_EXE%" "%~dp0murage-hook.mjs"\r\nexit /b %ERRORLEVEL%\r\n`);
    expect(CODEX_HOOK_EXE_ENV).toBe("MURAGE_CODEX_EXE");
    // cmd reads a batch file in the OEM code page: the file is pure ASCII and names no path, whatever the user's name
    const home = join(dir, "scope Jos\u00e9 M\u00fcller \u6771\u4eac");
    const files = writeHookFiles(home, hookSocketPath("abc"), "tok", hookEnvPathOf(home, "abc"), join(dir, "Murage Jos\u00e9", "Murage.exe"));
    const bytes = readFileSync(files.launcher);
    expect(bytes.length).toBeGreaterThan(0);
    expect([...bytes].every((b) => b < 0x80)).toBe(true);
    expect(bytes.toString("latin1")).toBe(hookWindowsLauncher());
    // the variable holds only a quoted path behind `@`: no operator an outer cmd could act on after expanding it
    const value = hookWindowsLaunchValue("C:\\Users\\Jo Smith\\AppData\\Roaming\\Murage\\scopes\\codex\\b1\\murage-hook.cmd");
    expect(value).not.toMatch(/[&|<>^%]/);
    // the hooks.json Windows command is unchanged and still names no quote
    const written = JSON.parse(codexHooksJson(PACKAGED_WIN, SCOPE_WIN)).hooks.SessionStart[0].hooks[0];
    expect(written.command_windows).toBe(codexHookWindowsCommand());
    // a moved binary is a new hook configuration (the launcher is part of it)
    expect(hookConfigOf(join(dir, "s"), PACKAGED_WIN)).not.toBe(hookConfigOf(join(dir, "s"), "C:\\Other\\Murage.exe"));
  });

  it("gives a cold packaged start on Windows a wider SessionStart bound, and honours the override", () => {
    expect(HOOK_LIVENESS_MS).toBe(10_000);
    expect(hookLivenessBound("linux", {})).toBe(HOOK_LIVENESS_MS);
    expect(hookLivenessBound("darwin", {})).toBe(HOOK_LIVENESS_MS);
    expect(hookLivenessBound("win32", {})).toBe(HOOK_LIVENESS_WIN32_MS);
    expect(HOOK_LIVENESS_WIN32_MS).toBe(45_000);
    // RUN B: Codex's PowerShell wrapper started 10 s in; a hook that starts at 12 s or 40 s is inside the Windows bound
    for (const startsAt of [12_000, 40_000]) expect(startsAt).toBeLessThan(hookLivenessBound("win32", {}));
    expect(12_000).toBeGreaterThan(hookLivenessBound("linux", {}));
    expect(hookLivenessBound("win32", { MURAGE_CODEX_HOOK_LIVENESS_MS: "400" })).toBe(400);
    expect(hookLivenessSetting("win32", { MURAGE_CODEX_HOOK_LIVENESS_MS: "3000" })).toEqual({ ms: 3000, source: "env" });
    expect(hookLivenessSetting("linux", { MURAGE_CODEX_HOOK_LIVENESS_MS: "3000" })).toEqual({ ms: 3000, source: "env" });
    expect(hookLivenessSetting("win32", {})).toEqual({ ms: 45_000, source: "win32" });
    expect(hookLivenessSetting("darwin", {})).toEqual({ ms: 10_000, source: "default" });
    // not a positive number: the platform's bound
    for (const bad of ["0", "-5", "abc", ""]) expect(hookLivenessSetting("win32", { MURAGE_CODEX_HOOK_LIVENESS_MS: bad })).toEqual({ ms: 45_000, source: "win32" });
  });

  it.runIf(process.platform !== "win32")("proves SessionStart through a packaged-style binary (spaced path, refuses to run a script without ELECTRON_RUN_AS_NODE)", async () => {
    const home = join(dir, "scope pkg");
    const app = join(dir, "Murage Pkg", "Murage");
    mkdirSync(join(dir, "Murage Pkg"));
    // stands in for Electron: without the variable it starts "as the app" (exit 86, like the launch guard), with it it is node
    writeFileSync(app, `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] || { echo "started as the app" >&2; exit 86; }\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    const gate = new CodexHookGate(hookSocketPath());
    await gate.listen();
    try {
      const files = writeHookFiles(home, gate.path, "pkg-token", hookEnvPathOf(home, gate.id), app);
      const sessions: string[] = [];
      gate.arm({ token: "pkg-token", onSession: (id) => { sessions.push(id); }, onPreTool: async () => ({ decision: "allow" }) });
      const command = JSON.parse(readFileSync(files.hooksJson, "utf8")).hooks.SessionStart[0].hooks[0].command as string;
      const env: NodeJS.ProcessEnv = { ...process.env, [HOOK_ENV_VAR]: files.envFile };
      delete env.ELECTRON_RUN_AS_NODE;
      const run = (program: string, args: string[], id: string) => new Promise<number | null>((resolve) => {
        const child = spawn(program, args, { env, stdio: ["pipe", "ignore", "ignore"] });
        child.on("close", (code) => resolve(code));
        child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: id, source: "startup" }));
      });
      expect(await run("sh", ["-c", command], "sh")).toBe(0);
      // a Codex build that splits the line into argv instead of a shell
      expect(await run("/usr/bin/env", ["ELECTRON_RUN_AS_NODE=1", app, files.script], "argv")).toBe(0);
      expect(sessions).toEqual(["sh", "argv"]);
      // control: the 1.0.3-rc line (no variable) never reaches the script
      expect(await run("sh", ["-c", `"${app}" "${files.script}"`], "old")).toBe(86);
      expect(sessions).toEqual(["sh", "argv"]);
    } finally { gate.close(); }
  });

  it.runIf(process.platform === "win32")("the Windows launcher hands the runtime ELECTRON_RUN_AS_NODE=1 under cmd both ways and PowerShell, from spaced non-ASCII exe and scope paths", async () => {
    const pkg = join(dir, "Murage Pkg Jos\u00e9");
    mkdirSync(pkg);
    const exe = join(pkg, "Murage.exe");
    writeFileSync(exe, readFileSync(process.execPath));
    const scope = join(dir, "scope pkg M\u00fcller \u6771\u4eac");
    mkdirSync(scope);
    const probe = join(scope, "murage-hook.mjs");
    const out = join(dir, "out.txt");
    writeFileSync(probe, `import { appendFileSync } from "node:fs"; let s = ""; for await (const c of process.stdin) s += c; appendFileSync(${JSON.stringify(out)}, String(process.env.ELECTRON_RUN_AS_NODE) + ":" + JSON.parse(s).session_id + "\\n");`);
    const launcher = join(scope, HOOK_LAUNCHER_FILE);
    writeFileSync(launcher, hookWindowsLauncher());
    const env: NodeJS.ProcessEnv = { ...process.env, [CODEX_HOOK_LAUNCH_ENV]: hookWindowsLaunchValue(launcher), [CODEX_HOOK_EXE_ENV]: exe };
    delete env.ELECTRON_RUN_AS_NODE;
    const command = codexHookWindowsCommand();
    const comspec = process.env.COMSPEC ?? "cmd.exe";
    const run = (program: string, args: string[], verbatim: boolean, id: string) => new Promise<number | null>((resolve) => {
      const child = spawn(program, args, { env, windowsVerbatimArguments: verbatim, stdio: ["pipe", "ignore", "ignore"] });
      child.on("close", (code) => resolve(code));
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: id }));
    });
    expect(await run(comspec, ["/C", command], false, "escaped")).toBe(0);
    expect(await run(comspec, ["/C", `"${command}"`], true, "raw")).toBe(0);
    expect(await run("powershell.exe", ["-NoProfile", "-Command", command], false, "powershell")).toBe(0);
    expect(readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean)).toEqual(["1:escaped", "1:raw", "1:powershell"]);
  });

  it("gives the script a deadline shorter than the handler timeout and no way to print ask", () => {
    expect(HOOK_SCRIPT_DEADLINE_MS / 1000).toBeLessThan(HOOK_TIMEOUT_SEC);
    expect(CODEX_HOOK_SCRIPT).not.toMatch(/"ask"|'ask'|permissionDecision: "ask"/);
    expect(CODEX_HOOK_SCRIPT).not.toContain("process.argv");
    expect(CODEX_HOOK_SCRIPT.match(/process\.exit\(2\)/g)?.length).toBe(1); // hardBlock(), the one exit 2
  });

  it("drops the owner's hooks table and its trust records from the config copy and keeps the rest", () => {
    const owner = [
      'model = "gpt-x"',
      'hooks.state = { "a" = { trusted_hash = "x" } }',
      "[mcp_servers.files]",
      'command = "files"',
      "[hooks]",
      'something = "owner hook"',
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      "[hooks.state]",
      '"/home/o/.codex/hooks.json:pre_tool_use:0:0" = { trusted_hash = "sha256:aa" }',
      "[projects.\"/work\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const kept = stripOwnerHooks(owner);
    expect(kept).not.toMatch(/hooks/);
    expect(kept).not.toContain("trusted_hash");
    expect(kept).toContain('model = "gpt-x"');
    expect(kept).toContain("[mcp_servers.files]");
    expect(kept).toContain('command = "files"');
    expect(kept).toContain('trust_level = "trusted"');
    // a name that only starts like it is another key
    expect(stripOwnerHooks('hooks_note = "x"\n[hookstore]\na = 1\n')).toContain("[hookstore]");
    // a multi-line inline value is dropped whole
    expect(stripOwnerHooks('hooks = {\n  state = { a = 1 }\n}\nmodel = "m"\n')).toBe('model = "m"\n');
  });

  it("pins the shell form: no login shell, the pins as policy, the shell-form features off", () => {
    const pins = new Map([["PAGER", "cat"], ["GIT_ASKPASS", ""], ["GIT_SSH_COMMAND", "'/opt/ssh' '-o' 'BatchMode=yes' '-p' '2222'"]]);
    const args = codexShellFormArgs(pins).join(" ");
    // the handed pin map, resolved values included, is the policy's `set`
    expect(args).toContain(`GIT_SSH_COMMAND=${JSON.stringify("'/opt/ssh' '-o' 'BatchMode=yes' '-p' '2222'")}`);
    expect(args).toContain('GIT_ASKPASS=""');
    expect(args).toContain("allow_login_shell=false");
    expect(args).toContain('shell_environment_policy.inherit="all"');
    expect(args).toMatch(/shell_environment_policy\.set=\{[^}]*PAGER="cat"/);
    for (const name of ABSENT_PINS) expect(args).toContain(JSON.stringify(name));
    for (const feature of CODEX_SHELL_FORM_FEATURES) expect(args).toContain(`features.${feature}=false`);
  });
});

describe("T100b: trust through hooks/list and config/batchWrite", () => {
  const hooksJson = "/scope/hooks.json";
  const listing = (trust: { pre: string; start: string }, extra: unknown[] = []) => ({
    data: [{ cwd: "/work", errors: [], warnings: [], hooks: [
      { key: `${hooksJson}:pre_tool_use:0:0`, eventName: "preToolUse", trustStatus: trust.pre, enabled: true, isManaged: false, sourcePath: hooksJson, currentHash: "sha256:p" },
      { key: `${hooksJson}:session_start:0:0`, eventName: "sessionStart", trustStatus: trust.start, enabled: true, isManaged: false, sourcePath: hooksJson, currentHash: "sha256:s" },
      ...extra,
    ] }],
  });

  it("trusts both handlers that list untrusted or modified, then requires both trusted and enabled", async () => {
    const writes: any[] = [];
    let trusted = false;
    const rpc = async (method: string, params: any) => {
      if (method === "config/batchWrite") { writes.push(params); trusted = true; return { status: "ok" }; }
      return trusted ? listing({ pre: "trusted", start: "trusted" }) : listing({ pre: "untrusted", start: "modified" });
    };
    await expect(trustHooks(rpc, hooksJson, "/work")).resolves.toEqual({ ok: true, managed: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ reloadUserConfig: true, edits: [{ keyPath: "hooks.state", mergeStrategy: "upsert" }] });
    expect(writes[0].edits[0].value).toEqual({ [`${hooksJson}:pre_tool_use:0:0`]: { trusted_hash: "sha256:p" }, [`${hooksJson}:session_start:0:0`]: { trusted_hash: "sha256:s" } });
  });

  it("writes nothing when both are already trusted, and counts a managed hook without blocking on it", async () => {
    const managed = { key: "m", eventName: "preToolUse", trustStatus: "managed", enabled: true, isManaged: true, sourcePath: "/etc/codex/hooks.json", currentHash: "sha256:m" };
    const calls: string[] = [];
    const rpc = async (method: string) => { calls.push(method); return listing({ pre: "trusted", start: "trusted" }, [managed]); };
    await expect(trustHooks(rpc, hooksJson, "/work")).resolves.toEqual({ ok: true, managed: 1 });
    expect(calls).toEqual(["hooks/list"]);
  });

  it("refuses a missing method, a trust write that did not take, and another runnable hook", async () => {
    const missing = async () => { throw new Error("method not found"); };
    expect(await trustHooks(missing, hooksJson, "/work")).toMatchObject({ ok: false, why: expect.stringContaining("hooks/list") });
    const stays = async (method: string) => (method === "config/batchWrite" ? { status: "ok" } : listing({ pre: "untrusted", start: "untrusted" }));
    expect(await trustHooks(stays, hooksJson, "/work")).toMatchObject({ ok: false, why: "Murage's handlers are not trusted and enabled" });
    const other = { key: "o", eventName: "preToolUse", trustStatus: "trusted", enabled: true, isManaged: false, sourcePath: "/proj/.codex/hooks.json", currentHash: "sha256:o" };
    const crowded = async () => listing({ pre: "trusted", start: "trusted" }, [other]);
    expect(await trustHooks(crowded, hooksJson, "/work")).toMatchObject({ ok: false, why: "another hook would run in this scope" });
    const absent = async () => ({ data: [{ cwd: "/work", errors: [], warnings: [], hooks: [] }] });
    expect(await trustHooks(absent, hooksJson, "/work")).toMatchObject({ ok: false });
    const disabled = async () => { const l = listing({ pre: "trusted", start: "trusted" }); (l.data[0]!.hooks[0] as any).enabled = false; return l; };
    expect(await trustHooks(disabled, hooksJson, "/work")).toMatchObject({ ok: false });
  });

  // B13: only "not a method" is a version fact; no answer is waited for once more with the wider bound, then reported as slow
  it("B13: waits once more, longer, for a hooks/list that gave no answer, and only a missing method reads as an old build", async () => {
    const noAnswer = () => Object.assign(new Error("Codex timed out (no answer for 15 seconds)."), { noAnswer: true });
    const bounds: (number | undefined)[] = [];
    let calls = 0;
    const slowOnce = async (_method: string, _params: unknown, ms?: number) => { bounds.push(ms); if (calls++ === 0) throw noAnswer(); return listing({ pre: "trusted", start: "trusted" }); };
    const waits: [number, number][] = [];
    await expect(trustHooks(slowOnce, hooksJson, "/work", { onWait: (waited, next) => waits.push([waited, next]) })).resolves.toEqual({ ok: true, managed: 0 });
    expect(bounds[0]).toBe(HOOKS_LIST_MS);
    expect(bounds[1]).toBeGreaterThan(HOOKS_LIST_RETRY_MS - 1_000);
    expect(bounds[1]).toBeLessThanOrEqual(HOOKS_LIST_RETRY_MS);
    // Fable r1 High: the wait is announced once, when the first bound runs out, with the wait still to come
    expect(waits).toHaveLength(1);
    expect(Math.abs(waits[0]![1] - bounds[1]!)).toBeLessThanOrEqual(50);
    const cause = noAnswer();
    let tries = 0;
    const slowAlways = async () => { tries++; throw cause; };
    expect(await trustHooks(slowAlways, hooksJson, "/work")).toMatchObject({ ok: false, kind: "slow", cause });
    expect(tries).toBe(2);
    const notAMethod = async () => { throw Object.assign(new Error("Invalid request"), { rpcCode: -32601 }); };
    expect(await trustHooks(notAMethod, hooksJson, "/work")).toMatchObject({ ok: false, kind: "absent" });
    // Fable r1 Low: a params error on a current build is an answer, never "no hook list"
    const badParams = async () => { throw Object.assign(new Error("Invalid params: unknown variant `cwdz`, expected `cwds`"), { rpcCode: -32602 }); };
    expect(await trustHooks(badParams, hooksJson, "/work")).toMatchObject({ ok: false, kind: "refused" });
    const plainAbsent = async () => { throw new Error("unknown variant `hooks/list`, expected one of `initialize`"); };
    expect(await trustHooks(plainAbsent, hooksJson, "/work")).toMatchObject({ ok: false, kind: "absent" });
    let answered = 0;
    const errorAnswer = async () => { answered++; throw Object.assign(new Error("internal error"), { rpcCode: -32603 }); };
    expect(await trustHooks(errorAnswer, hooksJson, "/work")).toMatchObject({ ok: false, kind: "refused" });
    expect(answered).toBe(1);
    expect(await trustHooks(async () => ({ data: "?" }), hooksJson, "/work")).toMatchObject({ ok: false, kind: "refused" });
    expect(hooksListBounds({ MURAGE_CODEX_HOOKS_LIST_MS: "200" })).toEqual({ first: 200, retry: 600 });
    expect(hooksListBounds({})).toEqual({ first: 15_000, retry: 45_000 });
  });

  // Fable r1 Medium: both listings and the trust write of one attempt share ONE deadline (first + retry), never 60 s each
  it("B13: one handshake deadline covers both listings and the trust write", async () => {
    const saved = process.env.MURAGE_CODEX_HOOKS_LIST_MS;
    process.env.MURAGE_CODEX_HOOKS_LIST_MS = "100"; // first 100, retry 300: a 400 ms deadline
    try {
      const noAnswer = () => Object.assign(new Error("Codex timed out (no answer)."), { noAnswer: true });
      const calls: { method: string; ms?: number }[] = [];
      let lists = 0;
      const startedAt = Date.now();
      const slowStart = async (method: string, _params: unknown, ms?: number) => {
        calls.push({ method, ms });
        if (method === "config/batchWrite") return { status: "ok" };
        lists++;
        if (lists === 1) { await new Promise((r) => setTimeout(r, ms)); throw noAnswer(); }
        if (lists === 2) { await new Promise((r) => setTimeout(r, 200)); return listing({ pre: "untrusted", start: "untrusted" }); }
        await new Promise((r) => setTimeout(r, ms)); throw noAnswer();
      };
      const result = await trustHooks(slowStart, hooksJson, "/work");
      expect(result).toMatchObject({ ok: false, kind: "slow" });
      expect(calls.map((c) => c.method)).toEqual(["hooks/list", "hooks/list", "config/batchWrite", "hooks/list"]);
      // the write and the second listing get only what is left of the 400 ms, not 15 s and 100 ms + 300 ms of their own
      expect(calls[2]!.ms!).toBeLessThanOrEqual(200);
      expect(calls[3]!.ms!).toBeLessThanOrEqual(200);
      expect(Date.now() - startedAt).toBeLessThan(700);
      // a write Codex never answers is a slow start too, not a refusal
      const silentWrite = async (method: string) => { if (method === "config/batchWrite") throw noAnswer(); return listing({ pre: "untrusted", start: "untrusted" }); };
      expect(await trustHooks(silentWrite, hooksJson, "/work")).toMatchObject({ ok: false, kind: "slow" });
      // the turn's startup cap shortens the handshake deadline further
      const capped: (number | undefined)[] = [];
      await trustHooks(async (_m: string, _p: unknown, ms?: number) => { capped.push(ms); return listing({ pre: "trusted", start: "trusted" }); }, hooksJson, "/work", { notAfter: Date.now() + 50 });
      expect(capped[0]!).toBeLessThanOrEqual(50);
    } finally {
      if (saved === undefined) delete process.env.MURAGE_CODEX_HOOKS_LIST_MS; else process.env.MURAGE_CODEX_HOOKS_LIST_MS = saved;
    }
  });

  // Astra BLOCK 10 (Rules 2, 68b): only an explicit true is enabled; another handler that is not explicitly off may still run
  it("reads a missing, null or unknown enabled as not enabled for Murage's handlers and as runnable for another", async () => {
    for (const value of [undefined, null, "true", 1]) {
      const odd = async () => { const l = listing({ pre: "trusted", start: "trusted" }); const h = l.data[0]!.hooks[1] as any; if (value === undefined) delete h.enabled; else h.enabled = value; return l; };
      expect(await trustHooks(odd, hooksJson, "/work")).toMatchObject({ ok: false, why: "Murage's handlers are not trusted and enabled" });
      const other = { key: "o", eventName: "preToolUse", trustStatus: "trusted", isManaged: false, sourcePath: "/proj/.codex/hooks.json", currentHash: "sha256:o", ...(value === undefined ? {} : { enabled: value }) };
      expect(await trustHooks(async () => listing({ pre: "trusted", start: "trusted" }, [other]), hooksJson, "/work")).toMatchObject({ ok: false, why: "another hook would run in this scope" });
    }
  });
});

describe("T100d: the script can only allow, deny or exit 2", () => {
  let envPath: string;
  const run = (home: string, input: unknown, env: NodeJS.ProcessEnv = { ...process.env, [HOOK_ENV_VAR]: envPath }) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(home, "murage-hook.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
  const pre = (extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call-1", turn_id: "t1", cwd: "/work", ...extra });
  let gate: CodexHookGate;
  let home: string;
  beforeEach(async () => {
    home = join(dir, "scope");
    gate = new CodexHookGate(hookSocketPath());
    await gate.listen();
    envPath = hookEnvPathOf(home, gate.id);
    writeHookFiles(home, gate.path, "good-token", envPath);
  });
  afterEach(() => { gate.close(); });
  const arm = (answer: HookAnswer, seen: HookDelivery[] = [], sessions: string[] = []) =>
    gate.arm({ token: "good-token", onSession: (id) => { sessions.push(id); }, onPreTool: async (d) => { seen.push(d); return answer; } });

  it("prints allow and deny as the documented hook output and delivers the call whole", async () => {
    const seen: HookDelivery[] = [];
    arm({ decision: "allow" }, seen);
    const allowed = await run(home, pre());
    // rig, Codex 0.163.0: a printed allow is "unsupported" and fails the run; a silent clean exit lets the call proceed
    expect(allowed).toMatchObject({ code: 0, stdout: "" });
    expect(seen[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call-1", turn_id: "t1", cwd: "/work" });
    arm({ decision: "deny", reason: "narrow it: use find with a path" });
    const denied = await run(home, pre());
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "narrow it: use find with a path" } });
    arm({ decision: "allow", updatedInput: { command: "ls -a" }, additionalContext: "excluded .git" });
    expect(JSON.parse((await run(home, pre())).stdout).hookSpecificOutput).toMatchObject({ updatedInput: { command: "ls -a" }, additionalContext: "excluded .git" });
  });

  it("posts the SessionStart liveness with the session id and prints nothing", async () => {
    const sessions: string[] = [];
    arm({ decision: "allow" }, [], sessions);
    const started = await run(home, { hook_event_name: "SessionStart", session_id: "thread-9", source: "startup" });
    expect(started).toMatchObject({ code: 0, stdout: "" });
    expect(sessions).toEqual(["thread-9"]);
  });

  // Codex 0.163.0 reads a printed decision only on exit 0 (hooks/src/events/pre_tool_use.rs:213-244) and Windows' PowerShell wrapper
  // turns exit 2 into 1 (a non-blocking failure), so every failure of a call is the printed deny with a clean exit
  const blocked = (r: { code: number | null; stdout: string; stderr: string }) => {
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Murage blocked this call");
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.permissionDecisionReason).toMatch(/^Murage blocked this call: /);
  };
  it("answers every other outcome of a call with the printed deny and a clean exit, and a SessionStart that cannot post exits 2", async () => {
    // no turn armed: the token is refused
    gate.disarm();
    blocked(await run(home, pre()));
    // a wrong token in the env file
    writeFileSync(envPath, `SOCKET=${gate.path}\nTOKEN=other\n`);
    arm({ decision: "allow" });
    blocked(await run(home, pre()));
    // socket refused
    writeFileSync(envPath, `SOCKET=${hookSocketPath("nobody-listens")}\nTOKEN=good-token\n`);
    blocked(await run(home, pre()));
    // a SessionStart that cannot post: exit 2, nothing printed (no proof reaches Murage, so the turn is refused at the bound)
    const session = await run(home, { hook_event_name: "SessionStart", session_id: "s1", source: "startup" });
    expect(session.code).toBe(2);
    expect(session.stdout).toBe("");
    expect(session.stderr).toContain("Murage blocked this call");
    // no env file, malformed stdin, an unknown event
    writeHookFiles(home, gate.path, "good-token", envPath);
    blocked(await run(home, "not json"));
    blocked(await run(home, { hook_event_name: "Stop" }));
    // a malformed answer from the gate
    gate.arm({ token: "good-token", onSession: () => {}, onPreTool: async () => ({ decision: "ask" } as never) });
    blocked(await run(home, pre()));
    // a gate that throws answers deny, never silence
    gate.arm({ token: "good-token", onSession: () => {}, onPreTool: async () => { throw new Error("boom"); } });
    const thrown = await run(home, pre());
    expect(thrown.code).toBe(0);
    expect(JSON.parse(thrown.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    // a link in place of the env file does not matter to the script: it only reads its own folder
    symlinkSync(envPath, join(home, "link.env"));
  });

  // F4 design 2c (03-1)
  it("F12: a hook run without its process's env file name, or with a name outside the scope's hook-env/, is blocked", async () => {
    arm({ decision: "allow" });
    // the shared file of 1.0.3 and earlier, valid in every field, is never read
    writeFileSync(join(home, "murage-hook.env"), `SOCKET=${gate.path}\nTOKEN=good-token\n`);
    const { [HOOK_ENV_VAR]: _drop, ...without } = { ...process.env, [HOOK_ENV_VAR]: "" };
    for (const env of [without, { ...process.env, [HOOK_ENV_VAR]: "" }, { ...process.env, [HOOK_ENV_VAR]: join(home, "murage-hook.env") },
      { ...process.env, [HOOK_ENV_VAR]: join(dir, "elsewhere", "hook-env", "x.env") }]) {
      // U18: a call is blocked by the printed deny with a clean exit (exit 2 reaches Codex as 1 under Windows PowerShell)
      const out = await run(home, pre(), env);
      blocked(out);
      expect(out.stderr).toContain("Murage blocked this call: no socket");
    }
    const allowed = await run(home, pre());
    expect(allowed).toMatchObject({ code: 0, stdout: "" });
  });

  it("F12: the env file's folder is matched by its real name: another spelling of hook-env/ is the same folder, a case-sensitive sibling is not", async () => {
    arm({ decision: "allow" });
    const sibling = join(home, "HOOK-ENV");
    const otherSpelling = join(sibling, basename(envPath));
    if (existsSync(otherSpelling)) {
      // a case-insensitive file system (Windows, macOS by default): HOOK-ENV is hook-env itself. Where the native real path gives the
      // folder's own name (always on Windows), its own file is read; where it does not, the call stays blocked (fails closed).
      const sameName = realpathSync.native(sibling) === realpathSync.native(join(home, "hook-env"));
      if (process.platform === "win32") expect(sameName).toBe(true);
      const out = await run(home, pre(), { ...process.env, [HOOK_ENV_VAR]: otherSpelling });
      if (sameName) expect(out).toMatchObject({ code: 0, stdout: "" });
      else { blocked(out); expect(out.stderr).toContain("Murage blocked this call: no socket"); }
    } else {
      // a case-sensitive one: HOOK-ENV is another folder, and a file there is never read, valid in every field or not
      mkdirSync(sibling);
      writeFileSync(otherSpelling, `SOCKET=${gate.path}\nTOKEN=good-token\n`);
      const out = await run(home, pre(), { ...process.env, [HOOK_ENV_VAR]: otherSpelling });
      blocked(out);
      expect(out.stderr).toContain("Murage blocked this call: no socket");
    }
  });

  it("F12: a link in hook-env/ to an env file outside it is followed and blocked, valid in every field or not", async () => {
    arm({ decision: "allow" });
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "valid.env"), `SOCKET=${gate.path}\nTOKEN=good-token\n`);
    const link = join(home, "hook-env", "link.env");
    symlinkSync(join(outside, "valid.env"), link);
    const out = await run(home, pre(), { ...process.env, [HOOK_ENV_VAR]: link });
    blocked(out);
    expect(out.stderr).toContain("Murage blocked this call: no socket");
    expect(await run(home, pre())).toMatchObject({ code: 0, stdout: "" });
  });

  it("F12 r3: an env file swapped for a link out of hook-env/ between the path check and the read is refused, never read", async () => {
    arm({ decision: "allow" });
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "valid.env"), `SOCKET=${gate.path}\nTOKEN=good-token\n`);
    // a preload that swaps the file the moment the script has resolved its real path: the checked name now links outside
    const preload = join(dir, "swap-after-check.cjs");
    writeFileSync(preload, `const fs = require("node:fs");
const original = fs.realpathSync.native;
const target = ${JSON.stringify(envPath)}, outside = ${JSON.stringify(join(outside, "valid.env"))};
let swapped = false;
fs.realpathSync.native = function (path, ...rest) {
  const out = original.call(this, path, ...rest);
  if (!swapped && out === target) { swapped = true; fs.renameSync(target, target + ".moved"); fs.symlinkSync(outside, target); }
  return out;
};
`);
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--require", preload, join(home, "murage-hook.mjs")], { env: { ...process.env, [HOOK_ENV_VAR]: envPath }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(pre()));
    });
    expect(existsSync(envPath + ".moved")).toBe(true); // the swap happened inside the script, after its check
    blocked(out);
    expect(out.stderr).toContain("Murage blocked this call: no socket");
  });

  it("U18: a deny that cannot be written (stdout gone) exits 2, so POSIX still blocks; a written deny always exits 0", async () => {
    gate.disarm();
    const child = spawn(process.execPath, [join(home, "murage-hook.mjs")], { env: { ...process.env, [HOOK_ENV_VAR]: envPath }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.destroy(); // the reader is gone before the hook writes anything
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => { child.on("close", resolve); child.stdin.end(JSON.stringify(pre())); });
    expect(code).toBe(2);
    expect(stderr).toContain("Murage blocked this call");
  });

  it("F18: a decision that resolves allow after its turn was disarmed, or after a newer turn armed, reaches the hook as deny", async () => {
    for (const after of ["disarm", "rearm"] as const) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let delivered!: () => void;
      const arrived = new Promise<void>((resolve) => { delivered = resolve; });
      gate.arm({ token: "good-token", onSession: () => {}, onPreTool: async () => { delivered(); await held; return { decision: "allow" }; } });
      const pending = run(home, pre());
      await arrived;
      if (after === "disarm") gate.disarm("good-token");
      else gate.arm({ token: "good-token", onSession: () => {}, onPreTool: async () => ({ decision: "allow" }) });
      release();
      const out = await pending;
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "Murage: the turn ended" });
    }
  });
});

describe("F4 03-1: hook env files are swept by ownership", () => {
  it("F14/F19/F21: removes only files no live owner holds; a released gate's file goes, a live gate's and a live other process's stay", async () => {
    const home = join(dir, "sweep-scope");
    const live = new CodexHookGate(hookSocketPath());
    live.envPath = hookEnvPathOf(home, live.id);
    writeHookFiles(home, live.path, "t", live.envPath);
    const deadOther = join(home, "hook-env", "999999-0abc.env");
    const liveOther = join(home, "hook-env", "424242-0abd.env");
    const mineGone = hookEnvPathOf(home, "0abe");
    for (const f of [deadOther, mineGone]) writeFileSync(f, "SOCKET=x\nTOKEN=y\n");
    writeFileSync(liveOther, "SOCKET=/live/other.sock\nTOKEN=y\n");
    sweepHookEnv(home, (pid) => pid === 424242, (p) => p === "/live/other.sock");
    expect(existsSync(live.envPath)).toBe(true);
    expect(existsSync(liveOther)).toBe(true);
    expect(existsSync(deadOther)).toBe(false);
    expect(existsSync(mineGone)).toBe(false);
    live.release();
    expect(existsSync(live.envPath)).toBe(false);
  });
});

describe("F4 03-1: the app-start sweep covers every bot scope and checks the gate, not just the pid", () => {
  it("removes dead files of scopes never launched again, a reused pid with no gate, and touches nothing else", () => {
    const root = join(dir, "all-scopes");
    const mk = (scope: string, file: string, body = "SOCKET=x\nTOKEN=y\n") => {
      const f = join(root, scope, "hook-env", file);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, body);
      return f;
    };
    const deadA = mk("bot-a", "999999-0aaa.env");
    const deadGen = mk(join("bot-b", "login-g2"), "999999-0bbb.env");
    const reused = mk("bot-c", "424242-0ccc.env", "SOCKET=/gone/murage-hk-0ccc.sock\nTOKEN=y\n");
    const liveGate = mk("bot-d", "424242-0ddd.env", "SOCKET=/live/murage-hk-0ddd.sock\nTOKEN=y\n");
    const odd = mk("bot-e", "notes.txt");
    const outside = join(root, "bot-a", "999999-0aaa.env");
    writeFileSync(outside, "keep");
    expect(sweepAllHookEnv(root, (pid) => pid === 424242, (p) => p === "/live/murage-hk-0ddd.sock")).toBeGreaterThan(0);
    expect(existsSync(deadA)).toBe(false);
    expect(existsSync(deadGen)).toBe(false);
    expect(existsSync(reused)).toBe(false);
    expect(existsSync(liveGate)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(sweepAllHookEnv(join(dir, "no-such-root"))).toBe(0);
  });
});

describe("T86 and T103: a Codex delivery as a decision", () => {
  const ctx = (extra: Partial<RouteContext> = {}): RouteContext => ({ project, home: dir, mounts: [
    { engineName: "agents", mountId: "own:agents", provenance: "own" },
    { engineName: "murage-memory", mountId: "own:memory", provenance: "own" },
    { engineName: "crm", mountId: "custom:crm", provenance: "custom" },
    { engineName: "gh", mountId: `external:codex:${"0".repeat(16)}:gh`, provenance: "external" },
  ], ...extra });
  const delivery = (tool_name: unknown, tool_input: unknown, more: Partial<HookDelivery> = {}): HookDelivery => ({ tool_name, tool_input, tool_use_id: "u1", turn_id: "t1", cwd: project, ...more });

  it("sends a Bash or exec_command call to the verdict as a shell ask, with the command and the folder as written", () => {
    expect(routeDelivery(delivery("Bash", { command: "ls -la" }), ctx())).toMatchObject({ route: "ask", tool: "shell", command: "ls -la", cwd: project, toolCall: { name: "shell", input: { command: "ls -la", cwd: project } } });
    expect(routeDelivery(delivery("exec_command", { cmd: "git status", workdir: join(project, "sub") }), ctx())).toMatchObject({ route: "ask", tool: "shell", command: "git status", cwd: join(project, "sub") });
    // F5: a missing command is stated missing and never replaced
    const missing = routeDelivery(delivery("Bash", {}), ctx());
    expect(missing).toMatchObject({ route: "ask", tool: "shell", toolInputMissing: "command", toolCall: { name: "shell" } });
    expect((missing as any).toolCall).not.toHaveProperty("input");
  });

  it("reads apply_patch destinations from the headers and allows only in-project, non-sensitive ones", () => {
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    const inside = patch("*** Add File: notes/a.md", "+hello", "*** Update File: src/b.ts", "@@", "-x", "+y", "*** Move to: src/c.ts");
    expect(parseApplyPatch(inside)?.destinations).toEqual(["notes/a.md", "src/b.ts", "src/c.ts"]);
    mkdirSync(join(project, "src"));
    // the allow carries each destination by its real path (APP-GRANT-FIXPLAN-r6 (b), Rule 67)
    expect(routeDelivery(delivery("apply_patch", { command: inside }), ctx())).toEqual({ route: "allow", final: true, why: "own-workspace", destinations: [join(project, "notes", "a.md"), join(project, "src", "b.ts"), join(project, "src", "c.ts")], cwd: project });
    expect(routeDelivery(delivery("apply_patch", inside), ctx())).toMatchObject({ route: "allow", final: true, why: "own-workspace" });
    for (const bad of ["*** Add File: .env", "*** Delete File: ../outside.txt", "*** Add File: ~/.ssh/authorized_keys", "*** Add File: .git/hooks/pre-commit"]) {
      const out = routeDelivery(delivery("apply_patch", { command: patch(bad, "+x") }), ctx());
      expect(out).toMatchObject({ route: "ask", tool: "edit", destinations: [bad.split(": ")[1]] });
    }
    // a patch that is not one whole envelope is unread: a card, never an allow
    for (const unread of ["", "*** Begin Patch\n*** Add File: a\n+x", "*** Begin Patch\nnonsense line\n*** End Patch", "*** Begin Patch\n*** End Patch", 7, undefined]) {
      expect(parseApplyPatch(unread)).toBeNull();
      expect(routeDelivery(delivery("apply_patch", { command: unread }), ctx())).toMatchObject({ route: "ask", tool: "edit", toolInputMissing: "patch" });
    }
    // a link out of the project is placed by its real path
    symlinkSync(dir, join(project, "out"));
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: out/x.txt", "+x") }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
  });

  // Astra BLOCK 3 (Rules 63.2, 75d): `link/..` climbs from the link's real target, never collapsed before the link resolves
  it("places link/../x from the link's target, never lexically", () => {
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    mkdirSync(join(dir, "elsewhere", "deep"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "deep"), join(project, "jump"));
    // lexically project/x.txt (inside); really elsewhere/x.txt (outside)
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: jump/../x.txt", "+x") }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
    writeFileSync(join(dir, "elsewhere", "x.png"), "x");
    expect(routeDelivery(delivery("view_image", { path: "jump/../x.png" }), ctx())).toMatchObject({ route: "ask", tool: "view_image" });
  });

  // Astra BLOCK 4 (Rules 63.5, 64): a template file's body is read by the secret-shape rules, added or updated
  it("asks for an in-project template file whose body carries a real secret, and allows a placeholder", () => {
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    const key = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: .env.example", "+OPENAI_API_KEY=") }), ctx())).toMatchObject({ route: "allow" });
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: .env.example", `+OPENAI_API_KEY=${key}`) }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
    writeFileSync(join(project, ".env.sample"), "A=\n");
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Update File: .env.sample", "@@", "-A=", `+A=${key}`) }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Update File: notes.md", "@@", "-A", "+B", "*** Move to: .env.dist") }), ctx())).toMatchObject({ route: "allow" });
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Update File: notes.md", "@@", "-A", "+-----BEGIN OPENSSH PRIVATE KEY-----", "*** Move to: .env.dist") }), ctx())).toMatchObject({ route: "ask" });
  });

  it("judges an MCP call against the mounts: own unasked rows run, other own tools and unproven names are asked, custom and external pass to the approval path", () => {
    const row = OWN_UNASKED.find((r) => r.mount === "own:agents")!;
    expect(routeDelivery(delivery(`mcp__agents__${row.tools[0]}`, {}), ctx())).toEqual({ route: "allow", final: true, why: "own-unasked" });
    expect(routeDelivery(delivery("mcp__murage-memory__memory_search", { q: "x" }), ctx())).toEqual({ route: "allow", final: true, why: "own-unasked" });
    expect(routeDelivery(delivery("mcp__agents__publish_site", { x: 1 }), ctx())).toMatchObject({ route: "ask", tool: "publish_site", toolCall: { name: "mcp__agents__publish_site", input: { x: 1 } } });
    expect(routeDelivery(delivery("mcp__agents__not_in_any_row", {}), ctx())).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__crm__lookup", {}), ctx())).toEqual({ route: "allow", final: false, why: "custom" });
    expect(routeDelivery(delivery("mcp__gh__issues", {}), ctx())).toEqual({ route: "allow", final: false, why: "external" });
    // no record, no mount list, a missing tool part, a name that fits no record: unproven, so asked
    expect(routeDelivery(delivery("mcp__ghost__tool", {}), ctx())).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__agents__list_bots", {}), ctx({ mounts: undefined }))).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__agents__", {}), ctx())).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__agents__list_bots", undefined), ctx())).toMatchObject({ route: "allow" });
    expect(routeDelivery(delivery("mcp__agents__publish_site", undefined), ctx())).toMatchObject({ route: "ask", toolInputMissing: "tool_input" });
  });

  it("matches the server name the way Codex writes it in a tool name (real codex: a hyphen becomes an underscore)", () => {
    // Real-engine gate (Linux, d612d17e0): the hook got `mcp__murage_memory__memory_search` for the
    // `murage-memory` mount; no record matched, the read was asked as unproven and the turn waited on the card.
    expect(routeDelivery(delivery("mcp__murage_memory__memory_search", { query: "gate" }), ctx())).toEqual({ route: "allow", final: true, why: "own-unasked" });
    // a tool that asks is asked under the mount's own name, so the verdict proves it on this turn's record
    // (thread recall now runs unasked, 1.0.6; a tool in no OWN_UNASKED row still asks)
    expect(routeDelivery(delivery("mcp__murage_memory__thread_read", { x: 1 }), ctx())).toEqual({ route: "allow", final: true, why: "own-unasked" });
    expect(routeDelivery(delivery("mcp__murage_memory__not_in_any_row", { x: 1 }), ctx())).toMatchObject({ route: "ask", tool: "not_in_any_row", toolCall: { name: "mcp__murage-memory__not_in_any_row", input: { x: 1 } } });
    // two mounts that Codex would write the same way prove nothing
    const twin = ctx({ mounts: [
      { engineName: "my-crm", mountId: "custom:my-crm", provenance: "custom" },
      { engineName: "my_crm", mountId: "custom:my_crm", provenance: "custom" },
    ] });
    expect(routeDelivery(delivery("mcp__my_crm__lookup", {}), twin)).toMatchObject({ route: "ask" });
  });

  it("lets exactly update_plan through as an ordinary local tool, judges view_image like a read, and denies the rest", () => {
    expect(CODEX_LOCAL_ORDINARY).toEqual(["update_plan"]);
    expect(routeDelivery(delivery("update_plan", { plan: [] }), ctx())).toEqual({ route: "allow", final: true, why: "local-ordinary" });
    writeFileSync(join(project, "shot.png"), "x");
    writeFileSync(join(project, ".env"), "KEY=1");
    expect(routeDelivery(delivery("view_image", { path: "shot.png" }), ctx())).toEqual({ route: "allow", final: true, why: "own-workspace" });
    expect(routeDelivery(delivery("view_image", { path: join(project, "shot.png") }), ctx())).toMatchObject({ route: "allow" });
    for (const path of [".env", "~/.ssh/id_rsa.png", "../elsewhere.png"]) expect(routeDelivery(delivery("view_image", { path }), ctx())).toMatchObject({ route: "ask", tool: "view_image" });
    symlinkSync(join(dir, "secret.png"), join(project, "link.png"));
    writeFileSync(join(dir, "secret.png"), "x");
    expect(routeDelivery(delivery("view_image", { path: "link.png" }), ctx())).toMatchObject({ route: "ask", tool: "view_image" });
    expect(routeDelivery(delivery("view_image", {}), ctx())).toMatchObject({ route: "ask", toolInputMissing: "path" });
    for (const name of ["web_fetch", "shell_snapshot", "request_user_input", "write_stdin", "", undefined, 7]) {
      expect(routeDelivery(delivery(name, {}), ctx())).toEqual({ route: "deny", reason: "Murage does not know this tool" });
    }
    // native search tools wait for the verdict (the walk of build step 4)
    expect(routeDelivery(delivery("grep_files", { pattern: "x" }), ctx())).toMatchObject({ route: "ask", tool: "grep_files" });
  });
});

describe("Rule 67: the tripwire table", () => {
  const issue = (table: HookDecisionTable, over: Partial<Parameters<HookDecisionTable["record"]>[0]> = {}) =>
    table.record({ toolUseId: "call-1", turnId: "t1", decision: "allow", final: true, command: "ls", cwd: "/work", name: "Bash", ...over });

  it("matches a started call by id and treats an allow as ordinary", () => {
    const table = new HookDecisionTable();
    issue(table);
    expect(table.match({ id: "call-1", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: true });
  });

  it("calls a deny-matched call and an unmatched call incidents", () => {
    const table = new HookDecisionTable();
    issue(table, { decision: "deny" });
    expect(table.match({ id: "call-1", type: "commandExecution", command: "rm -rf x" }, "t1")).toEqual({ ok: false, why: "denied", command: "rm -rf x" });
    expect(table.match({ id: "other", type: "commandExecution", command: "curl evil" }, "t1")).toEqual({ ok: false, why: "unmatched", command: "curl evil" });
    expect(table.match({ id: "f1", type: "fileChange" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
  });

  it("falls back to command and cwd in order of issue, and an ambiguous fallback is a mismatch", () => {
    const table = new HookDecisionTable();
    issue(table, { toolUseId: "a" });
    expect(table.match({ id: "zzz", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: true });
    // consumed: the same started call again is unmatched
    expect(table.match({ id: "zzy", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const twice = new HookDecisionTable();
    issue(twice, { toolUseId: "a" });
    issue(twice, { toolUseId: "b" });
    expect(twice.match({ id: "zzz", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "ambiguous" });
    // another folder or another turn is no match
    const other = new HookDecisionTable();
    issue(other);
    expect(other.match({ id: "q", type: "commandExecution", command: "ls", cwd: "/elsewhere" }, "t1")).toMatchObject({ ok: false });
    expect(other.match({ id: "q", type: "commandExecution", command: "ls", cwd: "/work" }, "t2")).toMatchObject({ ok: false });
  });

  it("matches a file change on its destinations or an MCP call by its one delivery when the ids differ", () => {
    const table = new HookDecisionTable();
    // (a real absolute folder: `/work` names no place on Windows, so its destinations could never be placed there)
    table.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: ["a.md"], cwd: project });
    table.record({ toolUseId: "m1", turnId: "t1", decision: "allow", final: false, name: "mcp__crm__lookup" });
    expect(table.match({ id: "x1", type: "fileChange", changes: [{ path: join(project, "a.md") }] }, "t1")).toMatchObject({ ok: true });
    expect(table.match({ id: "x2", type: "mcpToolCall", server: "crm", tool: "lookup" }, "t1")).toMatchObject({ ok: true });
    expect(table.match({ id: "x3", type: "mcpToolCall", server: "crm", tool: "lookup" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
  });

  // Astra BLOCK 7 (Rule 67): a missing turn id or folder matches nothing, and a file change matches only on its destinations
  it("never treats a missing turn id or cwd as a wildcard, and never matches a file change on its tool name alone", () => {
    const shell = new HookDecisionTable();
    shell.record({ toolUseId: "a", decision: "allow", final: true, command: "ls", cwd: "/work", name: "Bash" });
    expect(shell.match({ id: "z", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const noCwd = new HookDecisionTable();
    noCwd.record({ toolUseId: "a", turnId: "t1", decision: "allow", final: true, command: "ls", name: "Bash" });
    expect(noCwd.match({ id: "z", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const unstated = new HookDecisionTable();
    unstated.record({ toolUseId: "a", turnId: "t1", decision: "allow", final: true, command: "ls", cwd: "/work", name: "Bash" });
    expect(unstated.match({ id: "z", type: "commandExecution", command: "ls" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    expect(unstated.match({ id: "z", type: "commandExecution", command: "ls", cwd: "/work" })).toMatchObject({ ok: false, why: "unmatched" });
    const files = new HookDecisionTable();
    files.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: ["notes.md"], cwd: "/work" });
    expect(files.match({ id: "f1", type: "fileChange", changes: [{ path: "/work/.git/hooks/pre-commit" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    expect(files.match({ id: "f1", type: "fileChange" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const unplaced = new HookDecisionTable();
    unplaced.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch" });
    expect(unplaced.match({ id: "f1", type: "fileChange", changes: [{ path: "/work/a.md" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    // by id, the change must still land where the hook placed it
    expect(files.match({ id: "p1", type: "fileChange", changes: [{ path: "/work/other.md" }] }, "t1")).toMatchObject({ ok: false });
  });

  it("words the owner line as the design says", () => {
    expect(tripwireLine("rm -rf x")).toBe("Codex ran `rm -rf x` without Murage's check; the turn was stopped");
    for (const word of [/\bsafe/i, /unsafe/i, /safety/i, /composio/i, /—/]) expect(tripwireLine("x")).not.toMatch(word);
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
