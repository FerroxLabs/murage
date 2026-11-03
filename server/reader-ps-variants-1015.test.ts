// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READER-PS-VARIANTS round 2, 1.0.15. Text with a CR, vertical tab, form feed or backtick line end is
// read twice: as PowerShell reads it and as the reader did before 1.0.14. Both readings run at the
// engine's own level, so a redirect to $null reads as a discard in both, and ordinary CRLF and CR scripts
// with `2>$null` or `>$null` stay uncarded at Ask, Auto, Full access and No limits. A here-string opens
// and closes on any line end (LF, CRLF or a lone CR), as PowerShell reads it, so a wipe after a lone-CR
// closer cards. A corpus of ordinary Windows PowerShell scripts, in LF, CRLF and CR, gets no card.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { approvalKey, autoVerdict } = await import("./auto-approve.ts");
const { alwaysAskCommand } = await import("./always-ask.ts");

type Context = Parameters<typeof autoVerdict>[3];
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null } as const;
const read = (cmd: string) => alwaysAskCommand(cmd, undefined, "command", "pwsh");

const ENDS = ["\n", "\r\n", "\r"] as const;
const NAMES: Record<string, string> = { "\n": "LF", "\r\n": "CRLF", "\r": "CR" };

function levels(cmd: string): Array<[string, Parameters<typeof autoVerdict>[0], Context]> {
  const remembered = [approvalKey("PowerShell", cmd), "PowerShell"].filter((k): k is string => typeof k === "string");
  return [
    ["Ask", { id: "ask", autoApprove: false, alwaysAllow: remembered }, { commandText: cmd } as Context],
    ["Auto", { id: "auto", autoApprove: true, alwaysAllow: remembered }, { commandText: cmd } as Context],
    ["Full access", { id: "full", autoApprove: true, fullAccess: true }, { ...OWNER, commandText: cmd } as Context],
    ["No limits", { id: "owned", autoApprove: true, fullAccess: true, noLimits: true }, { ...OWNER, commandText: cmd } as Context],
  ];
}

function expectUncarded(cmd: string): void {
  expect(read(cmd), JSON.stringify(cmd)).toBeNull();
  for (const [level, bot, context] of levels(cmd)) {
    expect(autoVerdict(bot, "PowerShell", cmd, context).source, `${level} ${JSON.stringify(cmd)}`).not.toBe("always-ask");
  }
}

function expectCarded(cmd: string): void {
  expect(read(cmd), JSON.stringify(cmd)).not.toBeNull();
  for (const [level, bot, context] of levels(cmd)) {
    expect(autoVerdict(bot, "PowerShell", cmd, context), `${level} ${JSON.stringify(cmd)}`).toMatchObject({ approve: null, source: "always-ask" });
  }
}

/** Ordinary scripts that discard output with a redirect to $null. */
const NULL_REDIRECTS: Array<(end: string) => string> = [
  (end) => `Get-Date 2>$null${end}`,
  (end) => `Get-Date >$null${end}`,
  (end) => `Get-Date *>$null${end}`,
  (end) => `Get-Date 2>$null${end}Get-ChildItem >$null${end}`,
  (end) => `git status 2>$null${end}Get-Date`,
  (end) => `Get-Command node 2>$null${end}Write-Output done >$null`,
  (end) => `Get-ChildItem \`${end}  -Filter *.log 2>$null`,
];

describe("a redirect to $null reads as a discard in both readings", () => {
  it.each(ENDS.flatMap((end) => NULL_REDIRECTS.map((make) => [`${NAMES[end]}: ${JSON.stringify(make(end))}`, make(end)] as const)))(
    "stays uncarded at Ask, Auto, Full access and No limits: %s",
    (_, cmd) => expectUncarded(cmd),
  );
});

/** A wipe after a here-string that PowerShell closes on a lone CR. */
const HERE_STRINGS = [
  `Remove-Item -Recurse -Force @"\r"@\r\nRemove-Item -Recurse -Force C:\\Windows\r\n"@`,
  `Remove-Item -Recurse -Force @"\r"@\nRemove-Item -Recurse -Force C:\\Windows\n"@`,
  `Remove-Item -Recurse -Force @'\r'@\r\nRemove-Item -Recurse -Force C:\\Windows\r\n'@`,
  `$s = @"\rtext\r"@\rRemove-Item -Recurse -Force C:\\Windows\n"@`,
  `$s = @'\rtext\r'@\rRemove-Item -Recurse -Force C:\\Windows\n'@`,
  `$s = @"\r\ntext\r"@\r\nRemove-Item -Recurse -Force C:\\Windows\r\n"@`,
  `$s = @"\ntext\r"@\nRemove-Item -Recurse -Force $env:X\n"@`,
];

describe("a here-string opens and closes on any line end", () => {
  it.each(HERE_STRINGS.map((cmd) => [JSON.stringify(cmd), cmd] as const))("the wipe after a lone-CR closer cards at every level: %s", (_, cmd) => {
    expectCarded(cmd);
  });

  it("ordinary here-strings stay uncarded in LF and CRLF", () => {
    for (const end of ["\n", "\r\n"]) {
      expectUncarded(`$text = @"${end}line one${end}line two${end}"@${end}Write-Output $text`);
      expectUncarded(`$lit = @'${end}C:\\Windows is only text here${end}'@${end}Write-Output $lit`);
    }
  });
});

/** Ordinary Windows PowerShell scripts, one line per entry. */
const CORPUS: Array<{ lines: string[]; noCR?: true }> = [
  { lines: ["Get-ChildItem -Path . -Filter *.log", "Get-Date"] },
  { lines: ["$files = Get-ChildItem -Recurse -File", "$files | Measure-Object -Property Length -Sum"] },
  { lines: ["Get-Process | Sort-Object CPU -Descending | Select-Object -First 5"] },
  // noCR: the reading as before 1.0.14 joins lone-CR lines into one statement and asks, exactly as 1.0.14 does
  { lines: ["$ErrorActionPreference = 'Stop'", "Get-Service | Where-Object { $_.Status -eq 'Running' }"], noCR: true },
  { lines: ["if (Test-Path .\\package.json) {", "  Get-Content .\\package.json", "} else {", "  Write-Host 'no package.json'", "}"] },
  { lines: ["try {", "  Get-Item .\\README.md", "} catch {", "  Write-Warning 'missing'", "}"] },
  { lines: ["$h = @{ Name = 'a'; Value = 1 }", "$h.Keys | ForEach-Object { Write-Output $_ }"] },
  { lines: ["git status 2>$null", "git log --oneline -5"] },
  { lines: ["Get-Command node 2>$null", "node --version"] },
  { lines: ["$env:Path -split ';' | Select-Object -First 3"] },
  { lines: ["Get-ChildItem -Path . `", "  -Recurse `", "  -Filter *.ts | Select-Object -First 10"] },
  { lines: ["Write-Output \"Today is $(Get-Date -Format yyyy-MM-dd)\""] },
  { lines: ["$i = 0", "while ($i -lt 3) {", "  $i++", "  Write-Output $i", "}"], noCR: true },
  { lines: ["Get-Content .\\notes.txt -TotalCount 20"] },
  { lines: ["Select-String -Path .\\*.ts -Pattern 'TODO'"] },
  { lines: ["Get-Location", "Get-ChildItem -Force | Format-Table Name, Length"] },
  { lines: ["$PSVersionTable.PSVersion"] },
  { lines: ["Get-Date > $null", "Get-Date *> $null"] },
  { lines: ["Get-Item .\\missing.txt 2>&1 | Out-Null"] },
  { lines: ["npm --version", "pnpm --version 2>$null"] },
  { lines: ["Get-ChildItem Env: | Sort-Object Name"] },
  { lines: ["Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version"] },
  { lines: ["$json = Get-Content .\\data.json -Raw | ConvertFrom-Json", "$json.items.Count"] },
  { lines: ["Write-Host 'step 1'", "Write-Host 'step 2'"] },
  { lines: ["# list the biggest files", "Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First 5 FullName, Length"] },
  { lines: ["<# a block", "comment #>", "Get-Date"] },
  { lines: ["$name = 'world'", "Write-Output \"hello $name\"", "Write-Output 'done' >$null"], noCR: true },
  { lines: ["Get-ChildItem | Where-Object Length -gt 1kb | Measure-Object"] },
  { lines: ["Test-Connection localhost -Count 1 2>$null"] },
  { lines: ["Get-Content .\\a.txt | Select-Object -Last 5 *>$null"] },
  { lines: ["Write-Output \"a long `", "line\"", "Get-Date"] },
  { lines: ["Get-ChildItem -Directory | Select-Object -ExpandProperty Name"] },
  // the reading as before 1.0.14 never finds a here-string's end on a lone CR, and asks, as it did at 1.0.14
  { lines: ["$text = @\"", "line one", "\"@", "Write-Output $text"], noCR: true },
  { lines: ["$lit = @'", "plain text", "'@", "Write-Output $lit"], noCR: true },
];

describe("ordinary Windows PowerShell scripts get no card, in LF, CRLF and CR", () => {
  it("the corpus has at least 30 scripts", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CORPUS.flatMap(({ lines, noCR }) => ENDS.filter((end) => !(noCR && end === "\r")).map((end) => [`${NAMES[end]}: ${JSON.stringify(lines.join(end))}`, lines.join(end)] as const)))(
    "uncarded at Ask, Auto, Full access and No limits: %s",
    (_, cmd) => expectUncarded(cmd),
  );
});
