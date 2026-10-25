// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 F1 (audit screen 09-2, G09-1, G09-2, G09-3, 09-1, 09-3): PowerShell is
// a command tool. Pi and Claude Code on Windows both file their PowerShell tool
// as `PowerShell`; it is read whole in command mode, its "Always allow" is
// keyed by program like Bash, and an older bare `PowerShell` grant answers
// nothing. A symlink to a key file is judged by where it lands, and the
// arguments a connected-app card carries are redacted like its title.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvalKey,
  autoVerdict,
  exactCommandForRequest,
  isBareCommandGrant,
  isCommandTool,
  isPowerShellTool,
  looksSensitive,
  realKeyPaths,
  withoutBareCommandGrants,
  type AutoApprover,
  type AutoContext,
} from "./auto-approve.ts";
import { classifyStopLine, type StopLinePlace } from "./stop-line.ts";
import { grantRequestFor } from "./approval-grant-request.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ASK: AutoApprover = {};
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS: Array<[string, AutoApprover]> = [["Ask", ASK], ["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]];

const WIN_HOME = "C:\\Users\\owner";
const WIN_CWD = "C:\\Users\\owner\\Projects\\site";
const madeUpRealpath = (p: string) => (/^[A-Za-z]:\\|^\\\\/.test(p) ? win32.normalize(p) : posix.normalize(p));
const win = (): StopLinePlace => ({
  cwd: WIN_CWD,
  roots: [WIN_CWD, "C:\\app\\data\\workspaces\\ws-1", "C:\\Users\\owner\\AppData\\Local\\Temp"],
  home: WIN_HOME,
  knownRecipients: new Set(),
  realpath: madeUpRealpath,
});

/** What index.ts hands the verdict for an engine's PowerShell ask on Windows:
 * the stop line read from the engine's own input, and (now that PowerShell is
 * a command tool) its whole command from the folder it runs in. */
const powershellAsk = (command: string, tool = "PowerShell"): AutoContext => ({
  stopLine: classifyStopLine(tool, { command }, command, win()),
  ...(isCommandTool(tool) ? { commandText: command, commandCwd: WIN_CWD } : {}),
});

describe("09-2 / G09-1 / G09-2: a PowerShell command is read in command mode", () => {
  it("PowerShell, in every spelling an engine files it under, is a command tool", () => {
    for (const tool of ["PowerShell", "powershell", "POWERSHELL", "pwsh", "Pwsh", "mcp__srv__powershell"]) {
      expect(isCommandTool(tool), tool).toBe(true);
      expect(isPowerShellTool(tool), tool).toBe(true);
    }
    expect(isPowerShellTool("Bash")).toBe(false);
  });

  it("the engine's own PowerShell command is handed on whole, as Bash's is", () => {
    const exact = exactCommandForRequest({ tool: "PowerShell", toolCall: { name: "powershell", input: { command: "Get-ChildItem -Force" } }, engine: "pi", turnCwd: WIN_CWD });
    expect(exact).toEqual({ engine: "pi", cwd: WIN_CWD, command: "Get-ChildItem -Force" });
  });

  it("G09-1: `$x = Remove-Item -Recurse -Force ~` asks under Full access and No limits", () => {
    const command = "$x = Remove-Item -Recurse -Force ~";
    for (const [label, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
      expect(autoVerdict(bot, "PowerShell", command, powershellAsk(command)).approve, label).toBeNull();
      // the card text alone (no engine command) is read in command mode too
      expect(autoVerdict(bot, "PowerShell", command, {}).approve, `${label} summary only`).toBeNull();
    }
  });

  it("G09-1: the stop line reads the command on the right of a PowerShell assignment", () => {
    const home = classifyStopLine("PowerShell", { command: "$x = Remove-Item -Recurse -Force ~" }, "", win());
    expect(home).toMatchObject({ kind: "delete" });
    const docs = classifyStopLine("PowerShell", { command: "$r = Remove-Item -Recurse C:\\Users\\owner\\Documents\\old" }, "", win());
    expect(docs).toMatchObject({ kind: "delete", what: expect.stringContaining("Documents") });
    // a literal value bound and used later is still followed
    expect(classifyStopLine("PowerShell", { command: "$p = 'C:\\Users\\owner\\Documents\\x.txt'; Remove-Item $p" }, "", win())).toMatchObject({ kind: "delete" });
  });

  it("G09-2: `[IO.Directory]::Delete(\"$HOME\", $true)` asks under No limits", () => {
    const command = "[IO.Directory]::Delete(\"$HOME\", $true)";
    for (const [label, bot] of LEVELS) {
      const verdict = autoVerdict(bot, "PowerShell", command, powershellAsk(command));
      expect(verdict.approve, label).toBeNull();
    }
    expect(autoVerdict(NO_LIMITS, "PowerShell", command, {}).source).toBe("always-ask");
  });

  it("09-2: Pi's computed home delete asks under No limits", () => {
    const command = "$target = Join-Path $env:USERPROFILE '*'; Remove-Item -Path $target -Recurse -Force";
    expect(autoVerdict(NO_LIMITS, "PowerShell", command, powershellAsk(command)).approve).toBeNull();
  });

  it("a PowerShell tool's text is read as PowerShell, not as a POSIX line", () => {
    // `ri` is Remove-Item to PowerShell; a POSIX reader sees an unknown program
    const command = "echo hi; ri -Recurse -Force ~";
    expect(autoVerdict(NO_LIMITS, "PowerShell", command, powershellAsk(command)).source).toBe("always-ask");
  });

  it("every way to start PowerShell inside the call is read, and an encoded one asks", () => {
    const wipes = [
      "pwsh -Command Remove-Item -Recurse -Force ~",
      "PWSH.EXE -c Remove-Item -Recurse -Force ~",
      "powershell.exe -NoProfile -Command Remove-Item -Recurse -Force ~",
      "PowerShell -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALQBSAGUAYwB1AHIAcwBlACAAfgA=",
      "powershell -ec UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==",
      "cmd /c powershell -Command Remove-Item -Recurse -Force ~",
      "CMD.EXE /C pwsh -Command Remove-Item -Recurse -Force ~",
    ];
    for (const command of wipes) {
      expect(autoVerdict(NO_LIMITS, "PowerShell", command, powershellAsk(command)).source, command).toBe("always-ask");
      expect(autoVerdict(NO_LIMITS, "PowerShell", command, {}).source, `${command} (summary)`).toBe("always-ask");
    }
  });
});

describe("G09-3: a PowerShell \"Always allow\" is scoped like Bash's", () => {
  it("is keyed by the program, never the bare tool", () => {
    expect(approvalKey("PowerShell", "Get-ChildItem -Force")).toBe("PowerShell:Get-ChildItem");
    expect(approvalKey("PowerShell", "git status")).toBe("PowerShell:git");
    expect(approvalKey("pwsh", "git status")).toBe("pwsh:git");
    expect(approvalKey("PowerShell", "git status", "local-computer")).toBe("local-computer:PowerShell:git");
  });

  it("offers no remembered key for anything that starts PowerShell, cmd or another runner", () => {
    const runners = [
      "pwsh -Command Get-ChildItem", "PWSH -c Get-ChildItem", "powershell.exe -EncodedCommand ZQBjAGgAbwA=", "PowerShell.EXE -File x.ps1",
      "cmd /c powershell -Command Get-ChildItem", "cmd.exe /c dir",
      "iex 'Remove-Item x'", "Invoke-Expression 'Remove-Item x'", "Start-Process pwsh", "saps pwsh", "start pwsh",
      "Invoke-Command -FilePath x.ps1", "icm -FilePath x.ps1", "Invoke-Item x.ps1", "ii x.ps1", "Start-Job -FilePath x.ps1",
      "wsl rm -rf ~", "return Remove-Item x", "throw Remove-Item x", "X=1 git status", "sudo -n git status",
      "Get-ChildItem; Remove-Item x", "Get-ChildItem | Remove-Item", "Remove-Item $HOME", "Get-ChildItem `", "& git status", ". ./x.ps1",
    ];
    for (const command of runners) {
      expect(approvalKey("PowerShell", command), command).toBeUndefined();
    }
    // the same runners reached through Bash are already dispatchers
    for (const command of ["pwsh -Command Get-ChildItem", "PowerShell.exe -c x", "cmd /c powershell -c x"]) {
      expect(approvalKey("Bash", command), command).toBeUndefined();
    }
  });

  it("a grant from a Get-ChildItem card does not approve `Remove-Item -Recurse .\\src`", () => {
    const key = approvalKey("PowerShell", "Get-ChildItem -Force")!;
    const command = "Remove-Item -Recurse .\\src";
    expect(autoVerdict({ alwaysAllow: [key] }, "PowerShell", command, powershellAsk(command)).approve).toBeNull();
    expect(autoVerdict({ alwaysAllow: [key] }, "PowerShell", "Get-ChildItem -Force", powershellAsk("Get-ChildItem -Force")).approve).not.toBeNull();
  });

  it("an older bare `PowerShell` grant answers nothing", () => {
    const command = "Remove-Item -Recurse -Force .\\src";
    for (const held of ["PowerShell", "powershell", "pwsh"]) {
      expect(autoVerdict({ alwaysAllow: [held] }, "PowerShell", command, powershellAsk(command)).approve, held).toBeNull();
    }
  });

  it("a stored bare command-tool grant is dropped and refused", () => {
    for (const key of ["PowerShell", "local-computer:PowerShell", "pwsh", "Bash", "shell", "mcp__srv__powershell"]) {
      expect(isBareCommandGrant(key), key).toBe(true);
    }
    for (const key of ["PowerShell:Get-ChildItem", "Bash:git", "Read", "local-computer:PowerShell:git", "Edit"]) {
      expect(isBareCommandGrant(key), key).toBe(false);
    }
    expect(withoutBareCommandGrants(["PowerShell", "Bash:git", "local-computer:PowerShell", "PowerShell:Get-ChildItem", "Read"])).toEqual(["Bash:git", "PowerShell:Get-ChildItem", "Read"]);
  });

  it("Ask mode still asks for every PowerShell command, with no grant held", () => {
    for (const command of ["Get-ChildItem", "git status", "Remove-Item -Recurse .\\src", "$x = Get-Date"]) {
      expect(autoVerdict(ASK, "PowerShell", command, powershellAsk(command)).approve, command).toBeNull();
    }
  });
});

// realKeyPaths reads a Windows spelling with its backslashes as `/` too (the way the in-project check reads it),
// so on Windows each real place is listed in both spellings; elsewhere the two are one.
const spellings = (path: string) => [...new Set([path, path.replace(/\\/g, "/")])];

describe("09-1: a key file reached through a link is judged where it lands", () => {
  let root = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "f1-link-")));
    mkdirSync(join(root, "home", ".aws"), { recursive: true });
    mkdirSync(join(root, "project"), { recursive: true });
    writeFileSync(join(root, "home", ".aws", "credentials"), "[default]\n");
    symlinkSync(join(root, "home", ".aws", "credentials"), join(root, "project", "config-link"));
    writeFileSync(join(root, "project", "notes.txt"), "plain\n");
  });
  afterEach(() => removeTempDirSync(root));

  it("Windows spellings of the credential files are key files", () => {
    for (const path of ["C:\\Users\\Alice\\.aws\\credentials", "C:\\Users\\Alice\\.ssh\\id_ed25519", "C:\\Users\\Alice\\.docker\\config.json", "C:\\Users\\Alice\\.codex\\auth.json"]) {
      expect(looksSensitive(path), path).toBe(true);
    }
  });

  it("resolves the paths a call names, relative to its folder", () => {
    const project = join(root, "project");
    const creds = join(root, "home", ".aws", "credentials");
    expect(realKeyPaths({ path: "config-link" }, undefined, project)).toEqual({ paths: spellings(creds), cannot: null });
    expect(realKeyPaths({ file_path: join(project, "config-link") }, undefined, undefined)).toEqual({ paths: spellings(creds), cannot: null });
    expect(realKeyPaths(undefined, [join(project, "config-link")], project)).toEqual({ paths: spellings(creds), cannot: null });
    // a plain file reads as itself, and a missing one is kept as written beneath its real folder: neither is a key file nor an error
    expect(realKeyPaths({ path: "notes.txt" }, undefined, project)).toEqual({ paths: spellings(join(project, "notes.txt")), cannot: null });
    expect(realKeyPaths({ path: join(project, "notes.txt") }, undefined, project)).toEqual({ paths: [], cannot: null });
    expect(realKeyPaths({ path: "missing" }, undefined, project)).toEqual({ paths: spellings(join(project, "missing")), cannot: null });
    for (const path of realKeyPaths({ paths: ["notes.txt", "missing"] }, undefined, project).paths) expect(looksSensitive(path), path).toBe(false);
  });

  it("a link to a key file inside a linked folder is still found", () => {
    const project = join(root, "project");
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "home", ".aws", "credentials"), join(root, "elsewhere", "key-link"));
    symlinkSync(join(root, "elsewhere"), join(project, "conf"));
    const creds = join(root, "home", ".aws", "credentials");
    expect(realKeyPaths({ path: "conf/key-link" }, undefined, project)).toEqual({ paths: spellings(creds), cannot: null });
    // a climb through the linked folder starts from where it points
    expect(realKeyPaths({ path: "conf/../home/.aws/credentials" }, undefined, project)).toEqual({ paths: spellings(creds), cannot: null });
    const input = { path: "conf/key-link" };
    const { paths } = realKeyPaths(input, undefined, project);
    expect(autoVerdict(AUTO, "read", "pi wants to use read", { call: { toolCall: { name: "read", input } }, realPaths: paths })).toMatchObject({ approve: null, source: "sensitive-guard" });
  });

  it("a path that cannot be followed is held as a key read", () => {
    const project = join(root, "project");
    symlinkSync(join(project, "loop-b"), join(project, "loop-a"));
    symlinkSync(join(project, "loop-a"), join(project, "loop-b"));
    for (const [input, cwd] of [[{ path: "loop-a/x" }, project], [{ path: "gone/../x" }, project], [{ path: "notes.txt" }, undefined]] as const) {
      const found = realKeyPaths(input, undefined, cwd);
      expect(found.cannot, JSON.stringify(input)).toEqual(expect.any(String));
      const context: AutoContext = { call: { toolCall: { name: "read", input } }, realPathCannot: found.cannot! };
      expect(autoVerdict(AUTO, "read", "pi wants to use read", context)).toMatchObject({ approve: null, source: "sensitive-guard" });
      expect(autoVerdict(NO_LIMITS, "read", "pi wants to use read", context).approve).toBeNull();
    }
  });

  it("Auto asks for a read of a link to ~/.aws/credentials", () => {
    const project = join(root, "project");
    const input = { path: "config-link" };
    const context: AutoContext = { call: { toolCall: { name: "read", input } }, realPaths: realKeyPaths(input, undefined, project).paths };
    const verdict = autoVerdict(AUTO, "read", "pi wants to use read", context);
    expect(verdict.approve).toBeNull();
    expect(verdict.source).toBe("sensitive-guard");
    expect(autoVerdict(FULL, "read", "pi wants to use read", context).approve).toBeNull();
  });

  it("Auto asks when the engine's own gate held the call as a key file", () => {
    const context: AutoContext = { call: { toolCall: { name: "read", input: { path: "config-link" } } }, localHold: "credential-files" };
    expect(autoVerdict(AUTO, "read", "pi wants to use read", context)).toMatchObject({ approve: null, source: "sensitive-guard" });
    expect(autoVerdict(NO_LIMITS, "read", "pi wants to use read", context).approve).toBeNull();
  });
});

describe("09-3: a connected-app card's arguments are redacted", () => {
  it("a token in a row's arguments arrives masked", () => {
    const token = "ghp_0123456789abcdefABCDEF0123456789abcd"; // secret-scan: fixture
    const input = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "bob@example.com", body: `the key is ${token}` } }] };
    const request = grantRequestFor({
      ask: { tool: "other", summary: "Run app tools", toolKind: "other", engine: "acp", toolIdentity: { namespace: "mcp", name: "murage_connectors__APPS_MULTI_EXECUTE_TOOL" }, toolCall: { name: "Run app tools", input }, mcpMounts: [{ engineName: "murage_connectors", mountId: "own:connector", provenance: "own" }] },
      stopHit: null,
      inputCut: false,
      routine: null,
    })!;
    const shown = JSON.stringify(request.rows[0]!.arguments);
    expect(shown).not.toContain(token);
    expect(shown).toContain("bob@example.com");
  });
});
