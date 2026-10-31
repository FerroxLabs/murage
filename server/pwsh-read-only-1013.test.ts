// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.13 NOLIMITS-PWSH-READONLY: ordinary PowerShell reads run, whatever they
// name, and a read never carries a wipe. Fixture strings are inert data, never
// executed. The reader's own rule holds at every level, so the wipe table reads
// `alwaysAskCommand` as well as the verdict.
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { alwaysAskCommand } from "./always-ask.ts";
import { autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { Unreadable } from "./shell/lex.ts";
import { walkPwsh } from "./shell/pwsh.ts";
import { newContext } from "./shell/walk.ts";
import { classifyAsk, type StopLinePlace } from "./stop-line.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";

const r = String.raw;
const CWD = "C:\\Users\\owner\\repo";
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS: Array<[string, AutoApprover]> = [["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]];

const verdict = (bot: AutoApprover, command: string) => {
  const call: GrantCall = { toolCall: { name: "shell", input: { command } }, toolKind: "execute", engine: "codex", commandShell: "pwsh" };
  const place: StopLinePlace = { cwd: CWD, home: "C:\\Users\\owner", roots: [CWD], knownRecipients: new Set(), realpath: (path) => (/^[a-z]:[\\/]|^\\\\/i.test(path) ? win32.normalize(path) : posix.normalize(path)) };
  const context: AutoContext = { commandText: command, commandCwd: CWD, call, handedPins: new Map(), stopLine: classifyAsk({ ...call, tool: "shell", summary: command }, place) };
  return autoVerdict(bot, "shell", command, context);
};
const rule = (command: string) => alwaysAskCommand(command, CWD, "command", "pwsh")?.rule ?? null;
const walked = (command: string): string | null => {
  try {
    walkPwsh(command, { ...newContext(CWD), pwshStamped: true }, { command: () => null, redirect: () => null, forkBomb: () => null, readOnly: () => true });
    return null;
  } catch (error) {
    if (error instanceof Unreadable) return error.message;
    throw error;
  }
};

/** The Windows Apply proof's lines this row clears, 1.0.11, Codex 0.164.0 and
 * Fuigo. The third, `python -c`, stays held: see the test below. */
const PYTHON_LINE = `python -c "import sys; print('quote ok', len(sys.argv))"`;
const PROOF = [
  r`Get-ChildItem C:\Windows | Select-String win`,
  `"marker" | ForEach-Object { $_.ToUpper() }`,
];

const READS = [
  ...PROOF,
  // named read commands on a protected path, alone and in a read pipeline
  r`gci C:\Windows | sls win`,
  r`dir C:\Windows`,
  r`Get-Item C:\Windows`,
  r`Test-Path C:\Windows`,
  r`Resolve-Path C:\Windows`,
  r`Get-Acl C:\Windows`,
  r`Get-ItemProperty C:\Windows`,
  r`Join-Path C:\Windows system32`,
  r`Split-Path C:\Windows`,
  r`Get-ChildItem C:\Windows -Recurse -Filter *.dll | Select-Object -First 5`,
  r`Get-ChildItem C:\Windows | Where-Object Name -like 'win*' | Select-Object Name`,
  r`Get-ChildItem C:\Windows | ForEach-Object { $_.Name }`,
  r`Get-ChildItem C:\Windows | more`,
  r`Get-ChildItem C:\Windows | Sort-Object Length | Measure-Object`,
  r`Get-ChildItem C:\Windows | Out-Null`,
  r`Get-ChildItem C:\Windows | findstr win`,
  // a quoted word is never a computed call
  `echo 'a.('`,
  `Write-Output 'use .$m()'`,
  // output thrown away
  r`Get-ChildItem src 2>$null`,
  r`Get-ChildItem C:\Windows 2>$null`,
  r`Get-ChildItem C:\Windows *>$null`,
  r`Get-ChildItem C:\Windows > NUL`,
  r`Get-ChildItem C:\Windows 2>&1`,
  // string methods
  `'a,b'.Split(',')`,
  `"abc".Substring(1).ToUpper()`,
  `Get-ChildItem | ForEach-Object { $_.Name.Trim().ToLower() }`,
  `Get-ChildItem | Where-Object { $_.Name.StartsWith('a') }`,
  `Write-Output $env:PATH.Split(';')`,
];

describe("ordinary PowerShell reads run", () => {
  it.each(READS)("%s", (command) => {
    expect(rule(command)).toBeNull();
    // Full access and No limits run it. Auto keeps its own prompt guard, which
    // reads a block with the POSIX reader (row NOLIMITS-PWSH-AUTO-PROMPT): the
    // always-ask card is what this row clears at every level
    for (const bot of [FULL, NO_LIMITS]) expect(verdict(bot, command).approve, command).toBeTruthy();
    expect(verdict(AUTO, command).source).not.toBe("always-ask");
  });

  it("at Auto the plain reads run as well", () => {
    for (const command of [PROOF[0]!, r`Test-Path C:\Windows`, r`Get-ChildItem C:\Windows 2>$null`]) expect(verdict(AUTO, command).approve, command).toBeTruthy();
  });

  it("`python -c` with quotes: the quoting parses, and the interpreter rule holds it (NOLIMITS-PWSH-INLINE)", () => {
    // `"…'…'…"` is one double-quoted word holding single quotes, no value:
    // the message is the interpreter check's, never the lexer's
    expect(walked(PYTHON_LINE)).toBe("pwsh: python: inline code");
    expect(walked(`python -c "print('no member call')"`)).toBe("pwsh: python: inline code");
    expect(walked(`python -c "print('never closed)"`)).toBe("pwsh: python: inline code");
    expect(walked(`python -c "print('never closed)`)).toMatch(/^quote/);
    expect(rule(PYTHON_LINE)).toBe("unreadable");
  });

  it("Bash on Mac and Linux reads the three as it did", () => {
    expect(alwaysAskCommand(PYTHON_LINE, "/home/o/repo")).toBeNull();
    expect(alwaysAskCommand(`ls /etc | grep win`, "/home/o/repo")).toBeNull();
  });
});

const MUST_CARD: Array<[string, string]> = [
  // deletes through a read
  ["delete", r`Remove-Item C:\Windows -Recurse -Force`],
  ["delete", r`Get-ChildItem C:\Windows | Remove-Item -Recurse -Force`],
  ["delete", r`gci C:\Windows | ri -r -fo`],
  ["delete", r`gci ~ | rm -r -fo`],
  ["delete", r`Get-ChildItem C:\Windows | Select-Object -First 5 | Remove-Item`],
  ["delete", r`Get-ChildItem C:\Windows | Where-Object { $_.Name } | Remove-Item -Recurse`],
  ["delete", r`Get-ChildItem C:\Windows | Select-String x | Remove-Item`],
  ["delete", r`Get-ChildItem C:\Windows | ForEach-Object { $_.Delete() }`],
  ["delete", r`Get-ChildItem C:\Windows | ForEach-Object { Remove-Item $_ -Recurse }`],
  ["delete", r`del /s /q C:\*`],
  ["delete", "rd /s /q C:\\"],
  // a command the reader calls ordinary, fed by a read
  ["fed", r`Get-ChildItem C:\Windows | Clear-Content`],
  ["fed", r`ls C:\Windows | Clear-Content`],
  ["fed", r`Get-ChildItem C:\Windows | Clear-Item`],
  ["fed", r`Get-ChildItem C:\Windows | Set-ItemProperty -Name IsReadOnly -Value $false`],
  ["fed", r`Get-ChildItem C:\Windows | Set-Content -Value x`],
  ["fed", r`Get-ChildItem C:\Windows | Unblock-File`],
  ["fed", r`Get-ChildItem C:\Windows | git hash-object --stdin-paths`],
  ["fed", r`Get-ChildItem C:\Windows | ForEach-Object { Clear-Item $_ }`],
  ["fed", r`Get-ChildItem C:\Windows | ForEach-Object { $_.IsReadOnly = $false }`],
  ["fed", r`Get-ChildItem C:\Windows | Where-Object { Clear-Item $_; $true }`],
  ["fed", r`Get-ChildItem C:\Windows | Sort-Object { Clear-Item $_ }`],
  ["fed", r`Where-Object { Clear-Item $_ } C:\Windows`],
  // a read kept for a later statement
  ["kept", r`$f = Get-ChildItem C:\Windows; $f | Clear-Content`],
  ["kept", r`Clear-Item (Get-ChildItem C:\Windows)`],
  ["kept", r`Clear-Item @(Get-ChildItem C:\Windows)`],
  ["kept", r`foreach ($f in Get-ChildItem C:\Windows) { Clear-Item $f }`],
  ["kept", r`Get-ChildItem C:\Windows -OutVariable f; $f | Clear-Content`],
  ["kept", r`Get-ChildItem C:\Windows -ov f; $f | Clear-Content`],
  ["kept", r`Get-ChildItem C:\Windows -OutVar:f; $f | Clear-Content`],
  ["kept", r`Get-ChildItem C:\Windows -PipelineVariable f | ForEach-Object { 1 }`],
  ["kept", r`Get-ChildItem C:\Windows > variable:f; $f | Clear-Content`],
  ["kept", r`powershell -Command "Get-ChildItem C:\Windows" | Clear-Content`],
  // output to a file takes a command off the list, as it does on Bash
  ["file", r`Get-ChildItem C:\Windows > out.txt`],
  ["file", r`Get-ChildItem C:\Windows >out.txt`],
  ["file", r`Get-ChildItem C:\Windows *> out.txt`],
  // a read-only name that is not the read-only command
  ["shadow", r`function Get-Content { Clear-Item $args }; Get-Content C:\Windows`],
  ["shadow", r`filter gci { Clear-Item $_ }; gci C:\Windows`],
  ["shadow", r`Set-Item function:gci { Clear-Item $args }; gci C:\Windows`],
  ["shadow", r`Set-Item alias:gc Clear-Item; gc C:\Windows`],
  ["shadow", r`C:\tools\Get-ChildItem.exe C:\Windows`],
  ["shadow", r`Get-ChildItem.exe C:\Windows`],
  // disks and the Format family
  ["format", r`Format-Volume -DriveLetter C`],
  ["format", r`Get-Volume | Format-Volume`],
  ["format", r`format C: /q`],
  ["format", r`Clear-Disk -Number 0`],
  ["format", r`Format-Table C:\Windows`],
  ["format", r`Format-List C:\Windows`],
  ["format", r`Get-ChildItem C:\Windows | Format-Table Name`],
  ["format", r`Get-ChildItem C:\Windows | Format-Volume`],
  // writes to a protected place
  ["write", r`Set-Content C:\Windows hi`],
  ["write", r`Add-Content C:\Windows hi`],
  ["write", r`Out-File C:\Windows`],
  ["write", r`Copy-Item evil.dll C:\Windows`],
  ["write", r`Move-Item evil.dll C:\Users`],
  ["write", r`Get-Content a.txt | Set-Content C:\Windows`],
  ["write", r`Get-Content a.txt | Out-File C:\Windows`],
  ["write", r`Get-Content a.txt | Tee-Object C:\Windows`],
  ["write", r`Get-Content a.txt | Add-Content C:\Windows`],
  // members
  ["member", `$x.Delete()`],
  ["member", `$_.Replace('a', 'b')`],
  ["member", `$x.ToUpper().Delete()`],
  ["member", `$x.Delete().ToUpper()`],
  ["member", `$x.Trim((Remove-Item ~ -Recurse))`],
  ["member", `$x.Trim($y)`],
  ["member", `$x.'Delete'()`],
  ["member", `$x."Delete"()`],
  ["member", `[IO.File]::Delete('x')`],
  ["member", r`[IO.Directory]::Delete('C:\Windows', $true).ToString()`],
  ["member", `(Get-Item x).Delete()`],
  ["member", `Remove-Item $_.ToUpper()`],
  ["member", `Clear-Item $_.Trim()`],
  ["member", `Start-Process $x.Trim()`],
  ["member", `& $x.Trim()`],
  ["member", `& "x.Delete()"`],
  ["member", r`powershell -Command "[IO.Directory]::Delete('C:\x')"`],
  ["member", `Write-Output "$($x.Delete())"`],
  ["member", `iex "abc".ToLower()`],
  // r2 review: quoted code stays read as a call; inline code stays held
  ["r2", String.raw`Set-Item Function:zap 'Get-ChildItem "$env:USERPROFILE\Documents" -Recurse -File | ForEach-Object { [IO.File]::WriteAllText($_.FullName, "") }'; zap`],
  ["r2", String.raw`function python { param($c); Get-ChildItem ($c -replace "'", "") -Recurse -File | Clear-Content }; python -c "'C:/Users/owner'"`],
  // inline code
  ["inline", `python -c 'print(1)'`],
  ["inline", `node -e "console.log('hello developer')"`],
  ["inline", `python -c "import os; os.system('rm -rf ~')"`],
  ["inline", `python -c "import shutil; shutil.rmtree('dist')"`],
  ["inline", `python -c "import subprocess; print(subprocess.run(['ls']))"`],
  ["inline", `python -c "print(open('x').read())"`],
  ["inline", `python -c "open('x', 'w').write('y')"`],
  ["inline", `python -c "print(__import__('os').system('x'))"`],
  ["inline", `python -c "print(''.__class__.__mro__)"`],
  ["inline", `python -c "exec('import os')"`],
  ["inline", `python -c "print(eval('1'))"`],
  ["inline", `python -c "print(f'{1}')"`],
  ["inline", `python -c "print(rb'a')"`],
  ["inline", `python -c "import os as o; print(o.getcwd())"`],
  ["inline", `python -c "from os import system"`],
  ["inline", `python -c "import json; print(1)"`],
  ["inline", `python -c "import sys; print(sys.modules)"`],
  ["inline", `python -c "import os; print(os.environ)"`],
  ["inline", `python -c "import os; x = os.system; x('y')"`],
  ["inline", `python -c "import os; print(getattr(os, 'system'))"`],
  ["inline", `python -c "print('{0.x}'.format(1))"`],
  ["inline", `python -c "print('''a'b''')"`],
  ["inline", `python -c "print(1) # '"`],
  ["inline", `python -c 'print("a")'`],
  ["inline", `python -c "print('$x')"`],
  ["inline", `python -c "print('$(Remove-Item ~ -Recurse)')"`],
  ["inline", `python -c print(1)`],
  ["inline", `python -cprint(1)`],
  ["inline", `python -c'print(1)'`],
  ["inline", `python -i -c "print(1)"`],
  ["inline", `python -c "print(1)" $x`],
  ["inline", r`.\python.exe -c "print(1)"`],
  ["inline", r`C:\tools\python.exe -c "print(1)"`],
  ["inline", `Set-Content os.py 'x'; python -c "print(1)"`],
  ["inline", `'code' | python -c "print(1)"`],
  ["inline", r`Get-ChildItem C:\Windows | python -c "print(1)"`],
  ["inline", `sudo python -c "print(1)"`],
  ["inline", `env python -c "print(1)"`],
  ["inline", "python -c \"print(1)\nprint(2)\""],
  ["inline", `node -e "require('fs').rmSync('x')"`],
  ["inline", `node -e "process.exit(1)"`],
  ["inline", `node -e "console.log(process.env)"`],
  ["inline", `node -e "console['log'](1)"`],
  ["inline", `node -e "x = 1"`],
  ["inline", "node -e 'console.log(`a`)'"],
  ["inline", `node -e "/'/;process.exit(1);/'/"`],
  ["inline", `node -e "console.log(1)" -r ./x.js`],
  ["inline", `ruby -e "puts 1"`],
  ["inline", `perl -e "print 1"`],
  // a quoted word kept where something runs it later is not text
  ["kept code", `printf 'os.execute("rm -rf ~")' > build; bun run build`],
  ["kept code", `printf 'os.execute("rm -rf ~")' > build; deno run -A build`],
  ["kept code", `printf 'require("child_process").execSync("ls")' > build; bun build`],
  ["kept code", `Set-Content build 'Deno.remove(1)'; deno run -A build`],
  ["kept code", `printf 'x.y()' | Out-File build; bun run build`],
  ["kept code", `printf 'no call here' > build; bun run build`],
  ["kept code", `CMD=x python3 -c "import os; os.system(os.environ['CMD'])"`],
  // r1 reviews: a read beside anything else keeps its card
  ["r1", r`$m = 'Delete'; Get-ChildItem C:\Windows -Recurse -File | ForEach-Object { $_.$m() }`],
  ["r1", r`Get-ChildItem C:\Windows -Directory | ForEach-Object { $_.('Delete')($true) }`],
  ["r1", `Get-ChildItem src | ForEach-Object { $_.('Delete')() }`],
  ["r1", `$m = 'Delete'; Get-ChildItem src | ForEach-Object { $_.$m() }`],
  ["r1", "function`\nGet-ChildItem { param($p) (Get-Item $p).('Delete')($true) }\nGet-ChildItem C:\\Windows"],
  ["r1", r`Get-ChildItem C:\Windows 2>&1>notes.txt`],
  ["r1", r`Get-ChildItem C:\Windows 2>&1>\\.\PhysicalDrive0`],
  ["r1", r`Get-Content a.txt 2>&1>\\.\PhysicalDrive0`],
  ["r1", r`Get-ChildItem C:\Windows 2>&1>>notes.txt`],
  ["r1", String.raw`$x = New-Object PSObject; Add-Member -InputObject $x -MemberType ScriptMethod -Name Trim -Value ([scriptblock]'Get-ChildItem C:\Users\owner -Recurse -File | Clear-Content'); $x.Trim()`],
  ["r1", String.raw`Get-Item C:\Users\owner | ForEach-Object { $global:d = $_ }; Get-ChildItem $d -Recurse -File | Clear-Content`],
  ["r1", String.raw`$o = @{ OutVariable = 'f' }; Get-ChildItem C:\Users\owner -Recurse -File @o; $f | Clear-Content`],
  ["r1", String.raw`Set-Item -Path ('Func' + 'tion:Get-Item') -Value { Get-ChildItem $args -Recurse -File | Clear-Content }; Get-Item C:\Users\owner`],
  ["r1", String.raw`cmd /c 'powershell -NoProfile -Command "Get-ChildItem C:\Users\owner -Recurse -File | Select-Object -ExpandProperty FullName" | powershell -NoProfile -Command "$input | Clear-Content"'`],
  ["r1", `$x = 'abc'; $x.Trim()`],
  ["r1", r`Get-ChildItem C:\Windows | ForEach-Object { $n = $_.Name; $n }`],
  ["r3", `$m = 'Delete'; Get-ChildItem .\\src | ForEach-Object { $_.$($m)() }`],
  ["r4", r`Get-ChildItem C:\Users\owner -Recurse -File | ForEach-Object { $_.FullName -as 'System.IO.StreamWriter' }`],
  ["r4", r`Get-ChildItem C:\Windows | Where-Object { $_.Name -like 'win*' }`],
  ["r5", "Get-ChildItem C:\\Windows `n Remove-Item C:\\Windows -Recurse -Force"],
  ["r5", "dir C:\\Windows `r Remove-Item C:\\Users\\owner -Recurse -Force"],
  ["r5", "Get-ChildItem C:\\ `n Format-Volume -DriveLetter C"],
  ["r5", "Get-Content C:\\Windows `n Set-Content C:\\Windows owned"],
  // r3 review: a read that is not provably one line
  ["r3", "Get-Item C:\\Windows #\rRemove-Item C:\\Users\\owner\\Documents -Recurse -Force"],
  ["r3", "Get-Item C:\\Windows \rClear-Item C:\\Users\\owner\\Documents"],
  ["r3", "Get-Item C:\\Windows\r\nClear-Item x"],
  ["r3", "Get-ChildItem C:\\Windows\n| Clear-Content"],
  ["r3", "Get-ChildItem C:\\Windows <# x #> | Select-String y"],
  ["r3", "Get-Item C:\\Windows # note"],
  ["r3", "Get-Item \u2018C:\\Windows\u2019"],
  // the key guard still reads the text
  ["key", r`Get-Content ~\.ssh\id_rsa`],
  ["key", `Get-Content .env`],
  ["key", `python -c "print('~/.ssh/id_rsa')"`],
];

describe("a read never carries a wipe", () => {
  it.each(MUST_CARD)("%s: %s", (_family, command) => {
    for (const [level, bot] of LEVELS) expect(verdict(bot, command).approve, `${level}: ${command}`).toBeNull();
  });

  // reader-level: holds at every level, whatever a later waiver does with the verdict
  it.each(MUST_CARD.filter(([family]) => family !== "key"))("reader holds %s: %s", (_family, command) => {
    expect(rule(command)).not.toBeNull();
  });

  it("text that only starts like a cmdlet keeps its card: a POSIX shell would run it", () => {
    expect(alwaysAskCommand("Get-Item /etc `truncate -s 0 /home/owner/report.txt`", "/home/owner")?.rule).toBe("protected-path");
    expect(alwaysAskCommand("Get-ChildItem /etc", "/home/owner")?.rule).toBe("protected-path");
  });

  it("`$null` is a discard only in text PowerShell runs: a POSIX shell can name a file with it", () => {
    const command = 'Get-Item; for null in "$HOME"/Documents/*; do : >"$null"; done';
    expect(alwaysAskCommand(command, CWD, "command")).not.toBeNull();
  });

  it("the wipes keep their own card, not the read's", () => {
    expect(rule(r`Get-ChildItem C:\Windows | Remove-Item -Recurse -Force`)).toBe("delete-system-folder");
    expect(rule(r`Format-Volume -DriveLetter C`)).toBe("disk-erase");
    expect(rule(r`Get-ChildItem C:\Windows | Clear-Content`)).toBe("protected-path");
  });
});
