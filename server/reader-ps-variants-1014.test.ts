// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READER-PS-VARIANTS, 1.0.14: the PowerShell reader reads line ends and blanks as PowerShell does.
// A backtick before a lone CR continues the line, a bare CR ends a statement, vertical tab and form feed
// separate words, and a backtick before a line end inside "..." or @"..."@ continues the string. Each
// wipe below cards at Ask, Auto, Full access and No limits, on LF, CRLF and CR alike. Text the reader
// read differently before 1.0.14 is also read that old way, so these readings only add cards.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { approvalKey, autoVerdict } = await import("./auto-approve.ts");
const { alwaysAskCommand } = await import("./always-ask.ts");

type Context = Parameters<typeof autoVerdict>[3];
// 1.0.20: a clean lane turn; PowerShell keeps today's verdicts there (ruling 3)
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const read = (cmd: string) => alwaysAskCommand(cmd, undefined, "command", "pwsh");

const ENDS = ["\n", "\r\n", "\r"] as const;

/** The four variants, each written with every line end. */
const VARIANTS: Record<string, (end: string) => string[]> = {
  "a backtick before a line end continues the line": (end) => [
    `Remove-Item -Recurse -Force \`${end}C:\\Windows`,
    `Remove-Item -Recurse -Force \`${end}$env:X`,
  ],
  "a line end ends the statement": (end) => [
    `Write-Output${end}Format-Volume -DriveLetter C`,
    `Get-Date${end}Remove-Item -Recurse -Force C:\\Windows`,
    `# a note${end}Remove-Item -Recurse -Force C:\\Windows`,
  ],
  "vertical tab and form feed separate words": (end) => [
    `Get-Date${end}Remove-Item -Recurse -Force C:\\Windows\v-Force`,
    `Get-Date${end}Remove-Item -Recurse -Force C:\\Windows\f-Force`,
    `Get-Date${end}Remove-Item\v-Recurse\f-Force\vC:\\Windows`,
  ],
  "a backtick before a line end inside quotes continues the string": (end) => [
    `Remove-Item -Recurse -Force "C:\\Win\`${end}dows"`,
    `Remove-Item -Recurse -Force @"${end}C:\\Win\`${end}dows${end === "\r" ? "\n" : end}"@`,
  ],
};

const CASES = Object.entries(VARIANTS).flatMap(([variant, make]) => ENDS.flatMap((end) => make(end).map((cmd) => [`${variant}: ${JSON.stringify(cmd)}`, cmd] as const)));

function levels(cmd: string): Array<[string, Parameters<typeof autoVerdict>[0], Context]> {
  const remembered = [approvalKey("PowerShell", cmd), "PowerShell"].filter((k): k is string => typeof k === "string");
  return [
    ["Ask", { id: "ask", autoApprove: false, alwaysAllow: remembered }, { commandText: cmd } as Context],
    ["Auto", { id: "auto", autoApprove: true, alwaysAllow: remembered }, { commandText: cmd } as Context],
    ["Full access", { id: "full", autoApprove: true, fullAccess: true }, { ...OWNER, commandText: cmd } as Context],
    ["No limits", { id: "owned", autoApprove: true, fullAccess: true, noLimits: true }, { ...OWNER, commandText: cmd } as Context],
  ];
}

describe("the PowerShell reader reads line ends and blanks as PowerShell does", () => {
  it.each(CASES)("the reader finds the wipe: %s", (_, cmd) => {
    expect(read(cmd), cmd).not.toBeNull();
  });

  it.each(CASES)("it cards at Ask, Auto, Full access and No limits: %s", (_, cmd) => {
    for (const [level, bot, context] of levels(cmd)) {
      expect(autoVerdict(bot, "PowerShell", cmd, context), level).toMatchObject({ approve: null, source: "always-ask" });
    }
  });

  it.each(Object.keys(VARIANTS))("LF, CRLF and CR give the same reader verdict: %s", (variant) => {
    const [lf, crlf, cr] = ENDS.map((end) => VARIANTS[variant]!(end).map((cmd) => read(cmd)?.rule ?? null));
    expect(crlf).toEqual(lf);
    expect(cr).toEqual(lf);
    for (const rule of lf!) expect(rule).not.toBeNull();
  });

  it("the disk erase after a line end is a disk erase, on every line end", () => {
    for (const end of ENDS) expect(read(`Write-Output${end}Format-Volume -DriveLetter C`), JSON.stringify(end)).toMatchObject({ rule: "disk-erase" });
  });

  it("ordinary scripts with these characters stay uncarded", () => {
    for (const end of ENDS) {
      expect(read(`Get-ChildItem${end}Get-Date`), JSON.stringify(end)).toBeNull();
      expect(read(`Write-Output "a\`${end}b"`), JSON.stringify(end)).toBeNull();
      expect(read(`# a note${end}Get-Date`), JSON.stringify(end)).toBeNull();
      expect(read(`Write-Output a \`${end}b`), JSON.stringify(end)).toBeNull();
    }
    expect(read("Write-Output a\vb\fc")).toBeNull();
    expect(read("Get-Date\f| Out-String")).toBeNull();
  });
});
