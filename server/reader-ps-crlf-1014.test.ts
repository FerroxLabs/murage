// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// READER-PS-CRLF, 1.0.14: the PowerShell reader continues a line on a backtick before CRLF, as it does before LF.
// `Remove-Item -Recurse -Force` + backtick + CRLF + `$env:X` is one statement with an unreadable target, so it cards at
// Ask, Auto, Full access and No limits. Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { approvalKey, autoVerdict } = await import("./auto-approve.ts");
const { alwaysAskCommand } = await import("./always-ask.ts");

type Context = Parameters<typeof autoVerdict>[3];
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null } as const;

const ENDS = ["\n", "\r\n"] as const;
const CASES = ENDS.flatMap((end) => [
  `Remove-Item -Recurse -Force \`${end}$env:X`,
  `Remove-Item -Recurse -Force \`${end}$env:USERPROFILE`,
  `Remove-Item -Force -Recurse \`${end}"$env:X"`,
]);

function levels(cmd: string): Array<[string, Parameters<typeof autoVerdict>[0], Context]> {
  const remembered = [approvalKey("PowerShell", cmd), "PowerShell"].filter((k): k is string => typeof k === "string");
  return [
    ["Ask", { id: "ask", autoApprove: false, alwaysAllow: remembered }, { commandText: cmd } as Context],
    ["Auto", { id: "auto", autoApprove: true, alwaysAllow: remembered }, { commandText: cmd } as Context],
    ["Full access", { id: "full", autoApprove: true, fullAccess: true }, { ...OWNER, commandText: cmd } as Context],
    ["No limits", { id: "owned", autoApprove: true, fullAccess: true, noLimits: true }, { ...OWNER, commandText: cmd } as Context],
  ];
}

describe("a backtick before CRLF continues a PowerShell line, as before LF", () => {
  it.each(CASES.map((cmd) => [JSON.stringify(cmd), cmd]))("the reader finds the delete: %s", (_, cmd) => {
    expect(alwaysAskCommand(cmd, undefined, "command", "pwsh"), cmd).not.toBeNull();
  });

  it("an $env:X target is unreadable on CRLF as on LF", () => {
    for (const end of ENDS) expect(alwaysAskCommand(`Remove-Item -Recurse -Force \`${end}$env:X`, undefined, "command", "pwsh"), JSON.stringify(end)).toMatchObject({ rule: "unreadable" });
  });

  it.each(CASES.map((cmd) => [JSON.stringify(cmd), cmd]))("it cards at Ask, Auto, Full access and No limits: %s", (_, cmd) => {
    for (const [level, bot, context] of levels(cmd)) {
      expect(autoVerdict(bot, "PowerShell", cmd, context), level).toMatchObject({ approve: null, source: "always-ask" });
    }
  });

  it("CRLF and LF give the same reader verdict", () => {
    for (const target of ["$env:X", "$env:USERPROFILE", "C:\\", "$HOME"]) {
      const lf = alwaysAskCommand(`Remove-Item -Recurse -Force \`\n${target}`, undefined, "command", "pwsh");
      const crlf = alwaysAskCommand(`Remove-Item -Recurse -Force \`\r\n${target}`, undefined, "command", "pwsh");
      expect(crlf?.rule, target).toBe(lf?.rule);
    }
  });

  it("a plain CRLF still ends the statement, and a backtick CRLF inside double quotes stays literal", () => {
    expect(alwaysAskCommand("Get-ChildItem\r\nGet-Date", undefined, "command", "pwsh")).toBeNull();
    expect(alwaysAskCommand('Write-Output "a`\r\nb"', undefined, "command", "pwsh")).toBeNull();
  });
});
