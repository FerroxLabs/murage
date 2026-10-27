// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 F1 round 2: the PowerShell reader FAILS CLOSED. It auto-approves only
// what it models in full; a launcher, a dispatcher, a quoted or computed
// program name, a script file or a native program that runs a command it is
// handed is unreadable and asks, at every level, No limits included. One
// table of every repro (each must ask), one table of ordinary commands that
// must still go through under Full access and No limits, so fail-closed does
// not make PowerShell unusable.
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { approvalKey, autoVerdict, isCommandTool, looksDestructive, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { classifyStopLine, type StopLinePlace } from "./stop-line.ts";
import { powershellRunner, shellDialectOf } from "./shell/pwsh.ts";
import { requestOpenedOut } from "./runtime-event-out.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";

const ASK: AutoApprover = {};
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };

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

/** What index.ts hands the verdict for an engine's command ask on Windows:
 * the stop line from the engine's own input, the whole command from the
 * folder it runs in, and the engine's call as the grant readers take it. */
const ask = (command: string, tool = "PowerShell", call?: GrantCall): AutoContext => ({
  stopLine: classifyStopLine(tool, { command }, command, win()),
  ...(isCommandTool(tool) ? { commandText: command, commandCwd: WIN_CWD } : {}),
  ...(call ? { call } : {}),
});

/** Codex's shell tool and an ACP engine's execute tool on Windows: both run
 * the text under `powershell.exe -Command`, and the driver says so. */
const codexCall = (command: string): GrantCall => ({ toolCall: { name: "shell", input: { command } }, engine: "codex", commandShell: "pwsh" });
const acpCall = (command: string): GrantCall => ({ toolCall: { name: "shell", input: { command } }, toolKind: "execute", engine: "acp", commandShell: "pwsh" });

/** Every repro of the round-2 brief, and the holes found while closing them.
 * Each one auto-approved on 0592e00be under No limits; each must ask. */
const MUST_ASK: Array<[string, string]> = [
  // 1. a quoted or array home operand
  ["1 quoted ~", 'ri -r -fo "~"'],
  ["1 -Path quoted ~", 'Remove-Item -Path "~" -Recurse -Force'],
  ["1 single-quoted ~\\", "Remove-Item '~\\' -Recurse -Force"],
  ["1 array of ~", "ri -r -fo @('~')"],
  ["1 comma list", "ri -r -fo ~, C:\\x"],
  ["1 comma list, glued", "ri -r -fo C:\\x,~"],
  ["1 array bound to a name", "$p = '~', 'C:\\x'; Remove-Item $p -Recurse -Force"],
  // 2. typographic quotes and dashes
  ["2 smart double quotes", "Remove-Item \u201C$HOME\u201D -Recurse -Force"],
  ["2 smart single quotes", "Remove-Item \u2018C:\\Users\\owner\u2019 -Recurse -Force"],
  ["2 en dash parameters", "Remove-Item ~ \u2013Recurse \u2013Force"],
  // 3. a quoted program name
  ["3 \"cmd\"", '"cmd" /c rd /s /q C:\\Users\\owner'],
  ["3 'cmd'", "'cmd' /c rd /s /q C:\\Users\\owner"],
  ["3 \"cmd.exe\"", '"cmd.exe" /c rd /s /q C:\\Users\\owner'],
  ["3 quoted other program", "'git' status"],
  // 4. write then run, and any script file
  ["4 redirect then .\\", "'ri ~ -r -fo' > w.ps1; .\\w.ps1"],
  ["4 redirect then &", "'ri ~ -r -fo' > w.ps1; & .\\w.ps1"],
  ["4 redirect then pwsh", "'ri ~ -r -fo' > w.ps1; pwsh w.ps1"],
  ["4 redirect then powershell -File", "'ri ~ -r -fo' > w.ps1; powershell -File w.ps1"],
  ["4 Set-Content then run", "Set-Content wipe.ps1 'Remove-Item ~ -Recurse -Force'; .\\wipe.ps1"],
  ["4 dot-source", ". .\\w.ps1"],
  ["4 .bat by path", ".\\w.bat"],
  ["4 extensionless by path", ".\\w"],
  ["4 cmd runs a .cmd", "cmd /c w.cmd"],
  ["4 cscript .vbs", "cscript w.vbs"],
  ["4 node .js", "node w.js"],
  ["4 python .py", "python w.py"],
  // 5. launchers
  ["5 Start-Process", "Start-Process cmd -ArgumentList '/c rd /s /q C:\\Users\\owner'"],
  ["5 Start-Process bare", "Start-Process pwsh"],
  ["5 saps", "saps notepad"],
  ["5 Invoke-WmiMethod", "Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'cmd /c rd /s /q C:\\Users\\owner'"],
  ["5 Invoke-CimMethod", "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c rd /s /q C:\\Users\\owner'}"],
  ["5 Register-ScheduledTask", "Register-ScheduledTask -TaskName x -Action (New-ScheduledTaskAction -Execute cmd -Argument '/c rd /s /q C:\\Users\\owner')"],
  ["5 wmic", 'wmic process call create "cmd /c rd /s /q C:\\Users\\owner"'],
  ["5 schtasks", 'schtasks /create /tn x /tr "cmd /c rd /s /q C:\\Users\\owner" /sc once /st 00:00'],
  ["5 at", "at 23:00 cmd /c rd /s /q C:\\Users\\owner"],
  ["5 sc", 'sc.exe create x binPath= "cmd /c rd /s /q C:\\Users\\owner"'],
  ["5 forfiles", 'forfiles /p C:\\Users\\owner /c "cmd /c rd /s /q @path"'],
  ["5 ??= reads its right side", "$x ??= Remove-Item -Recurse -Force ~"],
  ["5 wsl", "wsl rm -rf /mnt/c/Users/owner"],
  ["5 bash", 'bash -c "rm -rf /mnt/c/Users/owner"'],
  ["5 ubuntu2204.exe", "ubuntu2204.exe run rm -rf /mnt/c/Users/owner"],
  ["5 debian", "debian run rm -rf /mnt/c/Users/owner"],
  ["5 py -c", "py -c \"import shutil; shutil.rmtree(r'C:\\Users\\owner')\""],
  ["5 py.exe -c", "py.exe -c \"import shutil; shutil.rmtree(r'C:\\Users\\owner')\""],
  ["5 python -c", "python -c \"import shutil; shutil.rmtree(r'C:\\Users\\owner')\""],
  ["5 node -e", "node -e \"require('fs').rmSync(process.env.USERPROFILE, {recursive: true})\""],
  ["5 pwsh-preview", 'pwsh-preview -c "Remove-Item ~ -Recurse -Force"'],
  ["5 cmd tracks cd /d", 'cmd /c "cd /d C:\\Users\\owner && rd /s /q ."'],
  ["5 Remove-Partition", "Remove-Partition -DiskNumber 0 -PartitionNumber 1 -Confirm:$false"],
  ["5 diskpart /s", "diskpart /s wipe.txt"],
  ["5 Set-Alias", "Set-Alias ls Remove-Item; ls ~ -Recurse -Force"],
  ["5 Invoke-Command", "Invoke-Command -ScriptBlock { Get-Date }"],
  ["5 Import-Module a script", "Import-Module .\\x.psm1"],
  ["5 Invoke-History (r)", "r 12"],
  // holes found while closing the above
  ["x [void](…) runs its body", "[void](Remove-Item ~ -Recurse -Force)"],
  ["x %{…} runs its body", "Get-ChildItem | %{ Remove-Item ~ -Recurse -Force }"],
  ["x a hashtable value runs", "@{a = Remove-Item ~ -Recurse -Force}"],
  ["x return runs its pipeline", "return Remove-Item ~ -Recurse -Force"],
  ["x ForEach-Object calls a member", "Get-ChildItem ~ -Force | ForEach-Object Delete"],
  ["x % -MemberName", "Get-ChildItem ~ | % -MemberName Delete"],
  ["x an = in a command is an argument", "Remove-Item ~ -Recurse -Force =x"],
  ["x a multiple assignment", "$a, $b = Remove-Item ~ -Recurse -Force"],
  ["x a property assignment runs its right side", "$x.Name=Remove-Item ~ -Recurse -Force"],
  ["x for /f runs a command", "cmd /c \"for /f %i in ('rd /s /q C:\\Users\\owner') do echo %i\""],
  ["x array element rebound", "$p = 'C:\\x'; $p[0] = '~'; Remove-Item $p -Recurse -Force"],
];

describe("F1 r2: every repro asks under No limits (PowerShell, Windows fixture)", () => {
  it.each(MUST_ASK)("%s: %s", (_label, command) => {
    const verdict = autoVerdict(NO_LIMITS, "PowerShell", command, ask(command));
    expect(verdict.approve).toBeNull();
    expect(verdict.source).toBe("always-ask");
  });
});

/** 6. Engine parity: Codex's shell and an ACP engine's execute tool run
 * under `powershell.exe -Command` on Windows; their text is PowerShell's. */
const PARITY = [
  "ls ~ -Force | Remove-Item -Recurse -Force",
  "echo hi; cmd /c rd /s /q C:\\Users\\owner",
  "rm -rf C:\\Users\\owner",
  "Remove-Item \u201C$HOME\u201D -Recurse -Force",
  "Start-Process cmd -ArgumentList '/c rd /s /q C:\\Users\\owner'",
];

describe("F1 r2 item 6: every driver's command text is read in the shell it runs in", () => {
  it.each(PARITY)("Codex shell: %s", (command) => {
    const verdict = autoVerdict(NO_LIMITS, "shell", command, ask(command, "shell", codexCall(command)));
    expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
  });
  it.each(PARITY)("ACP execute (Fuigo, OpenCode, Grok Build, every ACP engine): %s", (command) => {
    const verdict = autoVerdict(NO_LIMITS, "shell", command, ask(command, "shell", acpCall(command)));
    expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
  });
  it.each(PARITY)("Claude Code's and Pi's PowerShell tool: %s", (command) => {
    expect(autoVerdict(NO_LIMITS, "PowerShell", command, ask(command))).toMatchObject({ approve: null, source: "always-ask" });
  });
  it("an ordinary command on those engines still goes through", () => {
    for (const command of ["git status", "Get-ChildItem -Force", "npm test"]) {
      expect(autoVerdict(NO_LIMITS, "shell", command, ask(command, "shell", codexCall(command))).approve, `codex ${command}`).not.toBeNull();
      expect(autoVerdict(NO_LIMITS, "shell", command, ask(command, "shell", acpCall(command))).approve, `acp ${command}`).not.toBeNull();
    }
  });
  it("the dialect comes from the driver's pinned shell form", () => {
    expect(shellDialectOf(["powershell.exe", "-NoProfile", "-Command"])).toBe("pwsh");
    expect(shellDialectOf(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command"])).toBe("pwsh");
    expect(shellDialectOf(["/bin/zsh", "-c"])).toBeUndefined();
    expect(shellDialectOf(["bash.exe", "-c"])).toBeUndefined();
    expect(shellDialectOf(undefined)).toBeUndefined();
  });
  it("Codex and the ACP runtime stamp it on every ask from that form; it never leaves the server", () => {
    const codex = readFileSync(new URL("./drivers/codex.ts", import.meta.url), "utf8");
    expect(codex).toContain("const commandShell = shellDialectOf(shellForm);");
    expect(codex.match(/\.\.\.\(commandShell \? \{ commandShell \} : \{\}\)/g)).toHaveLength(2);
    const acp = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
    expect(acp).toContain("const acpCommandShell = shellDialectOf(acpShellForm);");
    expect(acp).toContain("...(acpCommandShell ? { commandShell: acpCommandShell } : {}),");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("...(event.commandShell ? { commandShell: event.commandShell } : {})");
    const out = requestOpenedOut({ type: "request.opened", threadId: "t", requestId: "r", requestType: "permission", tool: "shell", summary: "x", commandShell: "pwsh" } as never);
    expect((out as { commandShell?: string }).commandShell).toBeUndefined();
  });
  it("the same text from a POSIX engine is still read as POSIX", () => {
    // `rm -rf ~` from a Bash tool is the POSIX home; no dialect stamp
    expect(autoVerdict(NO_LIMITS, "Bash", "rm -rf ~", { commandText: "rm -rf ~" }).source).toBe("always-ask");
    expect(autoVerdict(NO_LIMITS, "Bash", "git status", { commandText: "git status" }).approve).not.toBeNull();
  });
});

describe("F1 r2 item 7: Auto cards a PowerShell recursive or forced delete like rm -r", () => {
  it.each([
    "Remove-Item -Recurse -Force .\\src",
    "ri -r -fo src",
    "Remove-Item .\\src -Recurse",
    "rm -Recurse .\\src",
    "Remove-Item -Force .\\x.txt",
    "rd /s /q src",
    "del /s *.log",
    "Remove-Item .\\src \u2013Recurse",
  ])("%s", (command) => {
    expect(looksDestructive(command)).toBe(true);
    expect(autoVerdict(AUTO, "PowerShell", command, ask(command))).toMatchObject({ approve: null, source: "destructive-guard" });
  });
  it("a plain delete of one file, and other commands, still go through under Auto", () => {
    for (const command of ["Remove-Item .\\build\\tmp.txt", "Get-ChildItem -Recurse", "git status", "Get-Content .\\src\\index.ts"]) {
      expect(autoVerdict(AUTO, "PowerShell", command, ask(command)).approve, command).not.toBeNull();
    }
  });
  it("a recursive delete placed inside the bot's own roots is excused as rm -r is", () => {
    const command = "Remove-Item -Recurse -Force .\\build";
    expect(autoVerdict(AUTO, "PowerShell", command, { ...ask(command), deletesInside: true }).approve).not.toBeNull();
  });
});

/** 8. No "Always allow" key for any runner in the one list. */
const NO_KEY = [
  "wmic process list", "schtasks /query", "forfiles /m *.log", "py -3 script.py", "py.exe --version", "pwsh-preview -c x", "ubuntu2204.exe", "ubuntu.exe run ls",
  "at 10:00 x", "sc query", "sc.exe query", "Start-Process notepad", "saps notepad", "Invoke-WmiMethod -Class x", "Invoke-CimMethod -ClassName x", "Register-ScheduledTask -TaskName x",
  "wsl ls", "bash -c ls", "debian", "cscript x.vbs", "wscript x.vbs", "mshta x.hta", "rundll32 x", "regsvr32 x", "msiexec /i x.msi", "Import-Module x", "Set-Alias a b",
  "Invoke-Command -ScriptBlock {x}", "Invoke-Item x", "ForEach-Object Name", "return 1", "'cmd' /c dir", "\"git\" status", "./w.ps1", "./tools/run", "git commit -m \u201Cx\u201D",
  "Remove-Item x \u2013Recurse", "explorer .", "sudo x", "r 1", "node x.js", "python3 x.py", "deno run x.ts",
];

describe("F1 r2 item 8: no grant key for any launcher or runner, from one list", () => {
  it.each(NO_KEY)("PowerShell: %s", (command) => {
    expect(approvalKey("PowerShell", command)).toBeUndefined();
    // the same text on a Codex or ACP engine on Windows
    expect(approvalKey("shell", command, undefined, { commandShell: "pwsh" })).toBeUndefined();
  });
  it("the launcher names are the walker's own list: each asks, each has no key", () => {
    for (const name of ["wmic", "schtasks", "forfiles", "at", "sc", "wsl", "bash", "ubuntu2204.exe", "kali", "pwsh-preview", "Start-Process", "Invoke-WmiMethod", "Invoke-CimMethod", "Register-ScheduledTask", "cscript", "mshta", "rundll32", "msiexec", "Import-Module", "Set-Alias", "Invoke-Command", "Invoke-Item", "runas", "explorer"]) {
      expect(powershellRunner(name), name).toBe("launcher");
      expect(approvalKey("PowerShell", `${name} x`), name).toBeUndefined();
      expect(approvalKey("Bash", `${name} x`), `Bash ${name}`).toBeUndefined();
      expect(autoVerdict(NO_LIMITS, "PowerShell", `${name} x`, ask(`${name} x`)).source, name).toBe("always-ask");
    }
    for (const name of ["py", "py.exe", "python", "python3.12", "pythonw", "node", "ruby", "perl", "deno", "bun"]) {
      expect(powershellRunner(name), name).toBe("interpreter");
      expect(approvalKey("PowerShell", `${name} --version`), name).toBeUndefined();
    }
  });
  it("ordinary programs keep their key, on the PowerShell tool and on a Windows Codex or ACP engine", () => {
    expect(approvalKey("PowerShell", "Get-ChildItem -Force")).toBe("PowerShell:Get-ChildItem");
    expect(approvalKey("PowerShell", "git status")).toBe("PowerShell:git");
    expect(approvalKey("shell", "git status", undefined, { commandShell: "pwsh" })).toBe("shell:git");
    expect(approvalKey("Bash", "git status")).toBe("Bash:git");
  });
});

describe("F1 r2 item 9: a glob that could match a key file is a key read", () => {
  const reads: Array<[string, string]> = [
    ["PowerShell", "Get-Content ~\\.aws\\cred*"],
    ["PowerShell", "Get-Content C:\\Users\\owner\\.aws\\cred*"],
    ["PowerShell", "Get-Content $HOME\\.ssh\\id_*"],
    ["PowerShell", "type ~\\.aw?\\credentials"],
    ["Bash", "cat ~/.aw?/credentials"],
    ["Bash", "cat ~/.aws/cred*"],
    ["Bash", "cat ~/.ssh/*"],
    ["Bash", "cat ~/.ssh/*.pem"],
    ["Bash", "cat .e*"],
    ["Bash", "head -5 ../.aws/credential?"],
    ["Bash", "cat /home/alice/.k?be/config"],
  ];
  it.each(reads)("%s %s asks under Auto and Full access", (tool, command) => {
    for (const [label, bot] of [["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
      const verdict = autoVerdict(bot, tool, command, tool === "PowerShell" ? ask(command) : { commandText: command });
      expect(verdict.approve, label).toBeNull();
      expect(verdict.source, label).toBe("sensitive-guard");
    }
  });
  it("globs that name no key file do not ask", () => {
    for (const command of ["cat *.md", "npx prettier --write \"src/**/*.json\"", "ls *.ts", "Get-ChildItem -Filter *.log", "rg foo src/*", "cat ./docs/*.txt"]) {
      expect(autoVerdict(FULL, "Bash", command, { commandText: command }).approve, command).not.toBeNull();
    }
  });
});

describe("F1 r2 Medium: a PowerShell assignment follows the rule for its right side", () => {
  it("a read-only assignment goes through where its right side would, and not further", () => {
    for (const command of ["$files = Get-ChildItem", "$files = Get-ChildItem -Recurse -Filter *.ts", "$n = (Get-ChildItem).Count", "$s = git status", "$d = Get-Date; $d"]) {
      for (const bot of [FULL, NO_LIMITS]) expect(autoVerdict(bot, "PowerShell", command, ask(command)).approve, command).not.toBeNull();
      // under Auto the always-ask reader no longer holds it; the prompt
      // reader (Rule 68f) keeps its own hold on a statement it reads as a
      // POSIX line, exactly as it does for `Get-ChildItem | Where-Object { $_ }`
      const auto = autoVerdict(AUTO, "PowerShell", command, ask(command));
      expect(auto.source === "auto-mode" || auto.source === "prompt-guard", `${command} (Auto): ${auto.source}`).toBe(true);
      expect(autoVerdict(ASK, "PowerShell", command, ask(command)).approve, `${command} (Ask)`).toBeNull();
    }
  });
  it("a destructive right side asks, and the name it binds is not followed", () => {
    for (const command of ["$x = Remove-Item -Recurse -Force ~", "$files = Get-ChildItem ~; Remove-Item $files -Recurse -Force", "$t = Get-Location; Remove-Item $t -Recurse -Force"]) {
      expect(autoVerdict(NO_LIMITS, "PowerShell", command, ask(command)).source, command).toBe("always-ask");
    }
    // under Auto the same delete cards as a destructive delete
    expect(autoVerdict(AUTO, "PowerShell", "$r = Remove-Item -Recurse -Force .\\src", ask("$r = Remove-Item -Recurse -Force .\\src")).approve).toBeNull();
  });
});

/** Ordinary PowerShell work: fail-closed must not make it unusable. Each goes
 * through under Full access and No limits. */
export const USABLE: readonly string[] = [
  "Get-ChildItem",
  "Get-ChildItem -Force",
  "Get-ChildItem -Recurse -Filter *.ts",
  "ls",
  "dir .\\src",
  "Get-Content README.md",
  "Get-Content .\\src\\index.ts | Select-Object -First 20",
  "cat package.json",
  "Select-String -Path .\\src\\*.ts -Pattern TODO",
  "Get-ChildItem | Where-Object { $_.Length -gt 1mb }",
  "Get-ChildItem | ForEach-Object { $_.Name }",
  "Get-ChildItem -Recurse | Measure-Object",
  "Test-Path .\\dist",
  "New-Item -ItemType Directory -Path .\\build",
  "mkdir build",
  "Copy-Item .\\a.txt .\\b.txt",
  "Move-Item .\\a.txt .\\b.txt",
  "Remove-Item .\\build\\tmp.txt",
  "Remove-Item -Recurse -Force .\\build",
  "Set-Location .\\src",
  "Write-Output \"hello\"",
  "echo done",
  "\"total: {0}\" -f 3",
  "$env:NODE_ENV = 'test'; npm test",
  "$files = Get-ChildItem",
  "git status",
  "git log --oneline -5",
  "git diff",
  "git add -A",
  "git commit -m \"fix: handle empty input\"",
  "npm test",
  "npm run build",
  "npm install",
  "npm.cmd run build",
  "pnpm install",
  "npx tsc --noEmit",
  "node --version",
  "python --version",
  "python -m pytest",
  "pip install -r requirements.txt",
  "dotnet build",
  "cargo test",
  "go test ./...",
  "bun install",
  "Get-Process",
  "Get-Date",
  "Get-Command node",
  "where.exe node",
  "& \"C:\\Program Files\\Git\\bin\\git.exe\" status",
  "Get-Date | Out-File .\\log.txt",
  "cmd /c dir",
  "cmd /c \"cd /d C:\\Users\\owner\\Projects\\site && dir\"",
  "pwsh -NoProfile -Command Get-ChildItem",
  "npm config set registry = https://registry.npmjs.org/",
];

describe("F1 r2: ordinary PowerShell work still goes through", () => {
  it.each(USABLE)("Full access and No limits: %s", (command) => {
    for (const [label, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
      const verdict = autoVerdict(bot, "PowerShell", command, ask(command));
      expect(verdict.approve, `${label}: ${verdict.source} ${verdict.rule ?? ""}`).not.toBeNull();
    }
  });
  it("the list is a real working set", () => {
    expect(USABLE.length).toBeGreaterThanOrEqual(50);
  });
});

describe("108 owner literal Bash launcher boundary", () => {
  const levels = [ASK, AUTO, FULL, NO_LIMITS];
  const origins = ["owner", "routine", "owner-channel", "other"] as const;
  it("unwraps literal Bash only at Full/No limits for an owner turn", () => {
    for (const [index, level] of levels.entries()) for (const fullAccessOrigin of origins) {
      const command = "bash -c 'echo fixture'";
      const verdict = autoVerdict(level, "PowerShell", command, { ...ask(command), fullAccessOrigin });
      expect(verdict.approve !== null, `${index}/${fullAccessOrigin}`).toBe(index >= 2 && fullAccessOrigin === "owner");
    }
  });
  it.each([
    "bash.exe", "C:\\Tools\\bash.exe", "/usr/bin/bash",
    "& 'C:\\Program Files\\Git\\bin\\bash.exe'", "& '\\\\fixture-host\\tools\\bash.exe'",
  ])("unwraps the literal executable %s only for the owner at Full/No limits", executable => {
    const command = `${executable} -c 'echo fixture'`;
    for (const [index, level] of levels.entries()) for (const fullAccessOrigin of origins) {
      expect(autoVerdict(level, "PowerShell", command, { ...ask(command), fullAccessOrigin }).approve !== null,
        `${index}/${fullAccessOrigin}`).toBe(index >= 2 && fullAccessOrigin === "owner");
    }
  });
  it.each([
    "$env:TOOL_DIR/bash.exe -c 'echo fixture'",
    "${env:TOOL_DIR}/bash.exe -c 'echo fixture'",
    "& $env:TOOL_DIR/bash.exe -c 'echo fixture'",
    '& "$env:TOOL_DIR/bash.exe" -c \'echo fixture\'',
    "$exe = 'bash'; $exe -c 'echo fixture'",
    "$exe = 'bash'; & $exe -c 'echo fixture'",
    "$(Join-Path $env:TOOL_DIR bash.exe) -c 'echo fixture'",
    "& (Join-Path $env:TOOL_DIR bash.exe) -c 'echo fixture'",
    "& ('ba' + 'sh') -c 'echo fixture'",
    "[string]$exe -c 'echo fixture'",
    "C:\\Tools\\$env:SUBDIR\\bash.exe -c 'echo fixture'",
    "C:\\Tools\\(Join-Path bin bash.exe)\\bash.exe -c 'echo fixture'",
    "./bash.exe -c 'echo fixture'", ".\\bash.exe -c 'echo fixture'",
    "C:bash.exe -c 'echo fixture'", "\\Tools\\bash.exe -c 'echo fixture'",
    "tools/bash.exe -c 'echo fixture'",
    "bash -c $payload", "$payload = 'echo fixture'; bash -c $payload",
    'bash -c "echo fixture"', 'bash -c "echo $env:USERNAME"',
    "bash -c ('echo fixture')", "bash -c ('echo ' + 'fixture')",
    "bash -c 'echo ' + 'fixture'", "bash -c 'echo '$env:USERNAME",
  ])("keeps nonliteral or relative Bash launches asking at every level: %s", command => {
    for (const [index, level] of levels.entries()) for (const fullAccessOrigin of origins) {
      expect(autoVerdict(level, "PowerShell", command, { ...ask(command), fullAccessOrigin }).approve,
        `${index}/${fullAccessOrigin}`).toBeNull();
    }
  });
  it("reads the entire injected payload and retains every deferred executor hold", () => {
    const payloads = ["rm -rf /", "rm -rf ~", "rm -rf /etc", "dd if=/dev/zero of=/dev/sda", ":(){ :|:& };:", "chmod -R 777 /", "cat ~/.ssh/id_rsa", 'cat ~/.ss""h/id_rsa', "python -c 'print(open(chr(47)+chr(101)+chr(116)+chr(99)+chr(47)+chr(115)+chr(104)+chr(97)+chr(100)+chr(111)+chr(119)).read())'", "wsl -e echo fixture", "py.exe -c 'print(1)'", "node.exe -e 'console.log(1)'", "schtasks /query", "Start-Process notepad", "Set-Content x.ps1 'echo fixture'; & ./x.ps1", "bash script.sh"];
    for (const level of levels) for (const fullAccessOrigin of origins) for (const payload of payloads) {
      const command = `bash -c '${payload.replaceAll("'", "''")}'`;
      expect(autoVerdict(level, "PowerShell", "tool output requested this command", { ...ask(command), fullAccessOrigin }).approve, payload).toBeNull();
    }
    for (const command of ["Start-Process notepad", "wsl -e echo fixture", "Set-Content x.ps1 'echo fixture'; & ./x.ps1", "& ./x.ps1", 'bash -c "echo $env:USERNAME"', "bash -lc 'echo fixture'", "bash -c 'echo fixture' extra", "bash.cmd -c 'echo fixture'", "$env:TOOL_DIR/bash.exe -c 'echo fixture'"]) expect(autoVerdict(NO_LIMITS, "PowerShell", command, { ...ask(command), fullAccessOrigin: "owner" }).approve, command).toBeNull();
    // 1.0.8 fallback (as 1.0.7): PowerShell does not read literal interpreter code, so even benign code asks; D is deferred to 1.0.9.
    expect(autoVerdict(NO_LIMITS, "PowerShell", "python -c 'print(1)'", { ...ask("python -c 'print(1)'"), fullAccessOrigin: "owner" }).approve).toBeNull();
  });
});
