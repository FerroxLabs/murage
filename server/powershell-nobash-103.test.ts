// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 section 6 (driver-level matrix) and section 11 D2: a Claude 2.1.305 PowerShell ask (tool
// "PowerShell", input `{command}`) on the inherit path, judged as index.ts judges it (handedPinsOf the F12 record, envUnread
// only when the record is unread), gets the verdict the same command gets as a Bash ask whose check passed with nothing
// removed, at Ask, Auto, Full access and No limits; an unread record holds at all four. PowerShell's own spellings of
// setting a pinned name are U19 at all four; a benign `$env:FOO=1` is not.

import { describe, expect, it } from "vitest";
import { ABSENT_PINS, valuePins } from "../shared/arg-vocabulary.ts";
import { autoVerdict, isCommandTool, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { execEnvHanded, handedPinsOf, type HandedEnv } from "./engine-env.ts";
import { pinOverrideIn } from "../shared/prompt-capable.ts";
import type { ExecEnv } from "../shared/mount-identity.ts";

const ASK: AutoApprover = {};
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS: Array<[string, AutoApprover]> = [["Ask", ASK], ["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]];
const CWD = "C:\\Users\\owner\\Projects\\site";
const PS_FORM = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];

function hand(): HandedEnv {
  const env: Record<string, string> = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\owner", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", RSYNC_RSH: "ssh -o BatchMode=yes" };
  for (const [name, value] of valuePins("win32")) env[name] = value;
  return { env, absent: [...ABSENT_PINS], capture: "session", ownerStartup: {}, pins: [] } as unknown as HandedEnv;
}
const inherited = (): ExecEnv => execEnvHanded(hand(), CWD, PS_FORM, { provenance: { kind: "inherited", cli: "2.1.305", adds: ["CLAUDECODE"], unenforceable: ["POSIXLY_CORRECT", "GIT_SSH"] } });
const checked = (): ExecEnv => execEnvHanded(hand(), CWD, ["C:\\Program Files\\Git\\bin\\bash.exe", "-c"]);

/** What index.ts builds for an engine permission ask (index.ts handedPins / envUnread / wholeCommand). */
function contextFor(tool: string, command: string, record: ExecEnv): AutoContext {
  return {
    ...(isCommandTool(tool) ? { commandText: command, commandCwd: CWD } : {}),
    handedPins: handedPinsOf(record, "win32"),
    ...(record.unread && isCommandTool(tool) ? { envUnread: record.unread.cause } : {}),
    call: { toolCall: { name: tool, input: { command } }, engine: "claude" } as never,
  };
}

describe("section 6: a 2.1.305 PowerShell ask on the inherit path, four levels", () => {
  it("gets the verdict of the same command as a Bash ask with a passed check", () => {
    for (const command of ["git status", "Get-ChildItem -Force", "npm test"]) {
      for (const [label, bot] of LEVELS) {
        const ps = autoVerdict(bot, "PowerShell", command, contextFor("PowerShell", command, inherited()));
        const bash = autoVerdict(bot, "Bash", command, contextFor("Bash", command, checked()));
        expect(ps.approve === null, `${label}: ${command}`).toBe(bash.approve === null);
      }
    }
    // Full access raises no card for it (gate turn iii)
    expect(autoVerdict(FULL, "PowerShell", "git status", contextFor("PowerShell", "git status", inherited())).approve).not.toBeNull();
  });

  it("the gate's env listing is not held at Full access (no U19, no U20)", () => {
    const command = 'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }; Get-Location';
    expect(pinOverrideIn(command, valuePins("win32"), "pwsh")).toBeNull();
    for (const [label, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
      expect(autoVerdict(bot, "PowerShell", command, contextFor("PowerShell", command, inherited())).approve, label).not.toBeNull();
    }
  });

  it("an unread record (U20) holds at all four levels (regression guard for 3.5)", () => {
    const unread: ExecEnv = { ...inherited(), env: {}, absent: [], unread: { code: "U20", cause: "the check did not finish" } };
    for (const [label, bot] of LEVELS) {
      expect(autoVerdict(bot, "PowerShell", "git status", contextFor("PowerShell", "git status", unread)).approve, label).toBeNull();
    }
  });
});

describe("section 11 D2: PowerShell spellings of a pinned name are U19 at all four levels", () => {
  const forms = (name: string): string[] => [
    `$env:${name} = 'less'`,
    `$env:${name}='less'`,
    `\${env:${name}} = 'less'`,
    `Set-Item env:${name} 'less'`,
    `Set-Item -Path env:${name} -Value 'less'`,
    `Set-Item -Path Env:\\${name.toLowerCase()} -Value 'less'`,
    `New-Item env:${name} -Value 'less'`,
    `New-Item -Path Env: -Name ${name.toLowerCase()} -Value 'less'`,
    `[Environment]::SetEnvironmentVariable('${name}', 'less')`,
    `[System.Environment]::SetEnvironmentVariable("${name.toLowerCase()}", 'less', 'Process')`,
    `Remove-Item env:${name}`,
    `remove-item ENV:${name}`,
    `Set-Item "env:${name.slice(0, 2)}\`${name.slice(2)}" 'less'`,
  ];
  for (const name of ["PAGER", "GIT_EDITOR", "GIT_SSH_COMMAND"]) {
    it(`${name}: every form`, () => {
      for (const command of forms(name)) {
        expect(pinOverrideIn(command, valuePins("win32"), "pwsh"), command).not.toBeNull();
        for (const [label, bot] of LEVELS) {
          const verdict = autoVerdict(bot, "PowerShell", command, contextFor("PowerShell", command, inherited()));
          expect(verdict.approve, `${label}: ${command}`).toBeNull();
        }
      }
    });
  }

  it("a name only known when it runs, or the bare drive given to a writer, fails closed", () => {
    for (const command of ['$n = "PAGER"; Set-Item "env:$n" less', "Get-ChildItem env: | Remove-Item", "Remove-Item env:*", "Set-Item env:PA* x", "${env:PAGER"]) {
      expect(pinOverrideIn(command, valuePins("win32"), "pwsh"), command).not.toBeNull();
    }
  });

  it("Codex and ACP commands under powershell.exe -Command are read the same way", () => {
    const command = "Set-Item -Path Env: -Name pager -Value less";
    const context: AutoContext = { commandText: command, commandCwd: CWD, handedPins: valuePins("win32"), call: { toolCall: { name: "shell", input: { command } }, engine: "codex", commandShell: "pwsh" } as never };
    expect(autoVerdict(NO_LIMITS, "Bash", command, context).approve).toBeNull();
  });

  it("a benign $env:FOO=1 is not U19", () => {
    for (const command of ["$env:FOO=1", "$env:FOO = 'bar'; npm test", "Set-Item env:MY_FLAG 1", "echo $env:USERPROFILE"]) {
      expect(pinOverrideIn(command, valuePins("win32"), "pwsh"), command).toBeNull();
      expect(autoVerdict(FULL, "PowerShell", command, contextFor("PowerShell", command, inherited())).approve, command).not.toBeNull();
    }
  });
});

describe("Astra #2 and MurageMain's D2 ruling: a name that is not a plain static literal holds at every level", () => {
  const hold = [
    // Astra's exact example: `pa` + `$n` is PAGER when it runs
    `$n='ger'; si -LiteralPath "env:pa$n" -Value less`,
    `Set-Item -Path "env:$name" -Value less`,
    "Set-Item env:PA`GER less",
    `Set-Item -Path ('env:' + 'PAGER') -Value less`,
    `Set-Item -Path ("env:PA" + "GER") -Value less`,
    `Set-Item -Path 'env:PA'+'GER' -Value less`,
    `Set-Item -Path "env:$(Get-Name)" -Value less`,
    `New-Item -Path env:P*R -Value less`,
    `Remove-Item -Path env:PAG?R`,
    `Set-Item -Path env:[P]AGER -Value less`,
    `$p = @{ Path = 'env:' + $n; Value = 'less' }; Set-Item @p`,
    `& { Set-Item "env:pa$n" less }`,
    `$x = { $env:PA$n = 'less' }; & $x`,
    `\${env:PA$n} = 'less'`,
    `[Environment]::SetEnvironmentVariable($n, 'less')`,
    `[System.Environment]::SetEnvironmentVariable("PA$n", 'less')`,
    `[Environment]::SetEnvironmentVariable('PA' + 'GER', 'less')`,
    `$a = 'PAGER','less'; [Environment]::SetEnvironmentVariable.Invoke($a)`,
    `[Environment]::SetEnvironmentVariable(@a)`,
    `Set-Item -Path Microsoft.PowerShell.Core\\Environment::PAGER -Value less`,
  ];
  it("each form holds (U19 class), at Ask, Auto, Full access and No limits", () => {
    for (const command of hold) {
      expect(pinOverrideIn(command, valuePins("win32"), "pwsh"), command).not.toBeNull();
      for (const [label, bot] of LEVELS) {
        expect(autoVerdict(bot, "PowerShell", command, contextFor("PowerShell", command, inherited())).approve, `${label}: ${command}`).toBeNull();
      }
    }
  });

  it("static literal names are parsed: a pinned one holds, a benign one does not", () => {
    for (const command of [`Set-Item -LiteralPath "env:PAGER" -Value less`, `$env:GIT_EDITOR = 'vim'`, `[Environment]::SetEnvironmentVariable('GIT_SSH_COMMAND', 'ssh')`, `\${env:pager} = 'less'`]) {
      expect(pinOverrideIn(command, valuePins("win32"), "pwsh"), command).toMatch(/PAGER|GIT_EDITOR|GIT_SSH_COMMAND/);
    }
    for (const command of [`Set-Item -LiteralPath "env:MY_FLAG" -Value 1`, `$env:FOO = 'bar'`, `$env:PATH += ';C:\\tools'`, `Write-Output "$env:USERPROFILE\\x"`, `Get-ChildItem env: | Sort-Object Name`]) {
      expect(pinOverrideIn(command, valuePins("win32"), "pwsh"), command).toBeNull();
      expect(autoVerdict(FULL, "PowerShell", command, contextFor("PowerShell", command, inherited())).approve, command).not.toBeNull();
    }
  });
});
