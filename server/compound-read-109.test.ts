// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.9 D2 (simplified): the reader now reads four more shapes, each the
// same as a shape it already read. Classification only: no command runs.
// No loosening: at every level and in every dialect, a new spelling is never
// allowed where its existing twin asks, and a catastrophe keeps its rule
// name (it may ask more: Auto's prompt and destructive guards read the raw
// text). Shapes outside the four keep asking.
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { classifyAsk, type StopLinePlace } from "./stop-line.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";

const r = String.raw;
const LEVELS: Array<[string, AutoApprover]> = [
  ["Ask", {}],
  ["Auto", { autoApprove: true }],
  ["Full access", { autoApprove: true, fullAccess: true }],
  ["No limits", { autoApprove: true, fullAccess: true, noLimits: true }],
];
const DIALECTS = {
  "posix-bash": { cwd: "/home/corpus-owner/repo", home: "/home/corpus-owner", commandShell: undefined },
  "windows-pwsh": { cwd: "C:\\Users\\corpus-owner\\repo", home: "C:\\Users\\corpus-owner", commandShell: "pwsh" as const },
  "windows-git-bash": { cwd: "C:/Users/owner/repo", home: "C:/Users/owner", commandShell: undefined },
} as const;
type Dialect = keyof typeof DIALECTS;

function verdict(command: string, bot: AutoApprover, dialect: Dialect) {
  const d = DIALECTS[dialect];
  const tool = "shell";
  const call: GrantCall = { toolCall: { name: tool, input: { command } }, toolKind: "execute", engine: "acp", commandShell: d.commandShell };
  const place: StopLinePlace = {
    cwd: d.cwd, home: d.home, roots: [d.cwd], knownRecipients: new Set(),
    realpath: (path) => /^[a-z]:[\\/]|^\\\\/i.test(path) ? win32.normalize(path) : posix.normalize(path),
  };
  const context: AutoContext = {
    fullAccessOrigin: "owner", unattended: false, automated: false, commandText: command, commandCwd: d.cwd, call,
    stopLine: classifyAsk({ ...call, tool, summary: command }, place),
    handedPins: new Map([["GIT_TERMINAL_PROMPT", "0"], ["GCM_INTERACTIVE", "never"], ["PAGER", "cat"]]),
  };
  const v = autoVerdict(bot, tool, command, context);
  return { approve: v.approve, source: v.source, rule: v.rule ?? null };
}

type Verdict = ReturnType<typeof verdict>;
/** The new spelling is allowed where its twin asks (or allowed differently). */
const looser = (fresh: Verdict, twin: Verdict) => fresh.approve !== null && fresh.approve !== twin.approve;
/** The twin names a catastrophe and the new spelling names something else. */
const renamed = (fresh: Verdict, twin: Verdict) => twin.source === "always-ask" && twin.rule !== "unreadable" && fresh.rule !== twin.rule;

const unreadable = (command: string, bot: AutoApprover, dialect: Dialect) => {
  const v = verdict(command, bot, dialect);
  return v.approve === null && (v.rule === "unreadable" || v.source === "unread-call");
};

// [new spelling, the spelling the reader already read]
const PWSH_TWINS: Array<[string, string]> = [
  [r`'hello developer' > greeting.txt`, r`Write-Output 'hello developer' > greeting.txt`],
  [r`'hello' >> notes.txt`, r`Write-Output 'hello' >> notes.txt`],
  [r`'x' > C:\Windows\System32\drivers\etc\hosts`, r`Write-Output 'x' > C:\Windows\System32\drivers\etc\hosts`],
  [r`'x' > ~\.ssh\authorized_keys`, r`Write-Output 'x' > ~\.ssh\authorized_keys`],
  [r`'x' > .git\hooks\pre-commit`, r`Write-Output 'x' > .git\hooks\pre-commit`],
  [r`'x' > $target`, r`Write-Output 'x' > $target`],
  [r`"$env:OPENAI_API_KEY" > key.txt`, r`Write-Output "$env:OPENAI_API_KEY" > key.txt`],
  ["@\"\nBuild label: $env:BUILD_LABEL\n\"@ | Out-File label.txt", r`Write-Output "Build label: $env:BUILD_LABEL" | Out-File label.txt`],
  ["@\"\nkey: $env:AWS_SECRET_ACCESS_KEY\n\"@ | Out-File C:\\Users\\Public\\k.txt", r`Write-Output "key: $env:AWS_SECRET_ACCESS_KEY" | Out-File C:\Users\Public\k.txt`],
  [r`'rm -rf ~' | bash`, r`Write-Output 'rm -rf ~' | bash`],
  [r`'Remove-Item -Recurse -Force ~' | Invoke-Expression`, r`Write-Output 'Remove-Item -Recurse -Force ~' | Invoke-Expression`],
  [r`& { git status --short; git diff --stat }`, r`git status --short; git diff --stat`],
  [r`& { Remove-Item -Recurse -Force ~ }`, r`Remove-Item -Recurse -Force ~`],
  [r`& { Remove-Item -Recurse -Force C:\Users\corpus-owner\Documents\old }`, r`Remove-Item -Recurse -Force C:\Users\corpus-owner\Documents\old`],
  [r`& { Set-Location C:\Windows; Remove-Item -Recurse -Force System32 }`, r`Set-Location C:\Windows; Remove-Item -Recurse -Force System32`],
  [r`& { Get-Content .env }`, r`Get-Content .env`],
  [r`& { Get-Content ~\.ssh\id_rsa }`, r`Get-Content ~\.ssh\id_rsa`],
  [r`& { cmd /c "rd /s /q C:\" }`, r`cmd /c "rd /s /q C:\"`],
  [r`& { curl.exe -X POST https://api.stripe.com/v1/charges -d amount=100 -d currency=usd }`, r`curl.exe -X POST https://api.stripe.com/v1/charges -d amount=100 -d currency=usd`],
  [r`& { .\build.ps1 }`, r`.\build.ps1`],
  [r`& { $env:PAGER = 'less'; git log }`, r`$env:PAGER = 'less'; git log`],
];

// cmd text, read the same way from all three outer shells
const CMD_TWINS: Array<[string, string]> = [
  [r`cmd.exe /d /c "set NODE_ENV=test&& npm test"`, r`cmd.exe /d /c "npm test"`],
  [r`cmd.exe /d /c "set CI=1&& pnpm exec vitest run"`, r`cmd.exe /d /c "pnpm exec vitest run"`],
  [r`cmd.exe /d /c "set CI=1 & git status"`, r`cmd.exe /d /c "git status"`],
  [r`cmd.exe /d /c "set N^ODE_ENV=test&& npm test"`, r`cmd.exe /d /c "npm test"`],
  [r`cmd.exe /d /c "set CI=1&& rd /s /q C:\"`, r`cmd.exe /d /c "rd /s /q C:\"`],
  [r`cmd.exe /d /c "set CI=1&& del /s /q C:\*"`, r`cmd.exe /d /c "del /s /q C:\*"`],
  [r`cmd.exe /d /c "set CI=1&& rd /s /q C:\Users\corpus-owner\Documents"`, r`cmd.exe /d /c "rd /s /q C:\Users\corpus-owner\Documents"`],
  [r`cmd.exe /d /c "set CI=1&& type %USERPROFILE%\.ssh\id_rsa"`, r`cmd.exe /d /c "type %USERPROFILE%\.ssh\id_rsa"`],
  [r`cmd.exe /d /c "set CI=1&& type .env"`, r`cmd.exe /d /c "type .env"`],
  [r`cmd.exe /d /c "set CI=1&& curl.exe -X POST https://api.stripe.com/v1/charges -d amount=100"`, r`cmd.exe /d /c "curl.exe -X POST https://api.stripe.com/v1/charges -d amount=100"`],
  [r`cmd.exe /d /c "set CI=1&& format C: /q"`, r`cmd.exe /d /c "format C: /q"`],
  [r`cmd.exe /d /c "set CI=1&& build.bat"`, r`cmd.exe /d /c "build.bat"`],
];

// still asks at every level, as int/108 did
const STILL_ASK: Array<[Dialect[], string]> = [
  [["windows-pwsh"], r`& { git status }; git diff`],
  [["windows-pwsh"], r`git diff; & { git status }`],
  [["windows-pwsh"], r`. { git status }`],
  [["windows-pwsh"], r`& { git status } | Out-File x.txt`],
  [["windows-pwsh"], r`& (Get-Command git) status`],
  [["windows-pwsh"], r`'x' < in.txt`],
  [["windows-pwsh"], r`"$x.Delete()" > f.txt`],
  [["windows-pwsh"], r`'git' status`],
  ...(["set PATH=C:\\evil&& git status", "set PATHEXT=.TXT&& git status", "set COMSPEC=C:\\evil.exe&& git status",
    "set NODE_OPTIONS=--require x&& node app.js", "set USERPROFILE=C:\\x&& npm test", "set GIT_TERMINAL_PROMPT=1&& git fetch",
    "set /a X=1&& npm test", "set /p X=name&& npm test", "set", "set X", "set X=%OTHER%&& npm test", "set X=a b&& npm test",
    "for /f %i in ('git rev-parse --short HEAD') do echo %i",
    // Grok r1: caret spellings of pinned names, and names that pick the program a command runs
    "set P^AGER=calc.exe&& git log", "set GIT_^CONFIG_COUNT=1&& set GIT_^CONFIG_KEY_0=core.fsmonitor&& set GIT_^CONFIG_VALUE_0=calc.exe&& git status",
    "set GIT_EXTERNAL_DIFF=calc.exe&& git diff", "set npm_config_script_shell=calc.exe&& npm test", "set PSModulePath=C:\\x&& npm test",
    "set GIT_EXEC_PATH=C:\\x&& git status", "set MY_TOOL=1&& npm test"]
    .map((inner): [Dialect[], string] => [["posix-bash", "windows-pwsh", "windows-git-bash"], `cmd.exe /d /c "${inner}"`])),
];

describe("1.0.9 D2 simplified compound reads", () => {
  it("no new pwsh spelling is allowed where its twin asks, and catastrophes keep their names", () => {
    const differ: string[] = [];
    for (const [fresh, twin] of PWSH_TWINS) for (const [level, bot] of LEVELS) {
      const a = verdict(fresh, bot, "windows-pwsh"), b = verdict(twin, bot, "windows-pwsh");
      if (looser(a, b) || renamed(a, b)) differ.push(`${level}: ${fresh} ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    expect(differ).toEqual([]);
  });

  it("cmd set before a command is never allowed where the command alone asks, from every outer shell", () => {
    const differ: string[] = [];
    for (const [fresh, twin] of CMD_TWINS) for (const dialect of Object.keys(DIALECTS) as Dialect[]) for (const [level, bot] of LEVELS) {
      const a = verdict(fresh, bot, dialect), b = verdict(twin, bot, dialect);
      if (looser(a, b) || renamed(a, b)) differ.push(`${dialect} ${level}: ${fresh} ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    expect(differ).toEqual([]);
  });

  it("named catastrophes keep their rule names inside the new shapes", () => {
    const full = LEVELS[2]![1];
    expect(verdict(r`& { Remove-Item -Recurse -Force ~ }`, full, "windows-pwsh")).toMatchObject({ approve: null, rule: "delete-home" });
    expect(verdict(r`"$(Remove-Item -Recurse -Force ~)" > f.txt`, full, "windows-pwsh")).toMatchObject({ approve: null, rule: "delete-home" });
    expect(verdict(r`cmd.exe /d /c "set CI=1&& rd /s /q C:\"`, full, "windows-pwsh")).toMatchObject({ approve: null });
    expect(verdict(r`cmd.exe /d /c "set CI=1&& rd /s /q C:\"`, full, "windows-pwsh").rule).not.toBe("unreadable");
  });

  it("shapes outside the four still ask at every level", () => {
    const allowed: string[] = [];
    for (const [dialects, command] of STILL_ASK) for (const dialect of dialects) for (const [level, bot] of LEVELS) {
      if (verdict(command, bot, dialect).approve !== null) allowed.push(`${dialect} ${level}: ${command}`);
    }
    expect(allowed).toEqual([]);
  });

  it("the corpus rows these shapes cover no longer ask at Full access or No limits", () => {
    const rows: Array<[Dialect[], string]> = [
      [["windows-pwsh"], r`'hello developer' > greeting.txt`],
      [["windows-pwsh"], "@\"\nBuild label: $env:BUILD_LABEL\n\"@ | Out-File label.txt"],
      [["windows-pwsh"], r`& { git status --short; git diff --stat }`],
      [["posix-bash", "windows-pwsh", "windows-git-bash"], r`cmd.exe /d /c "set NODE_ENV=test&& npm test"`],
      [["posix-bash", "windows-pwsh", "windows-git-bash"], r`cmd.exe /d /c "set CI=1&& pnpm exec vitest run"`],
    ];
    for (const [dialects, command] of rows) for (const dialect of dialects) for (const [level, bot] of LEVELS.slice(2)) {
      expect(unreadable(command, bot, dialect), `${dialect} ${level}: ${command}`).toBe(false);
      expect(verdict(command, bot, dialect).approve, `${dialect} ${level}: ${command}`).not.toBeNull();
    }
  });

  it("ordinary POSIX compounds stay readable (int/108 behaviour)", () => {
    for (const command of [r`pnpm run build 2>&1 | tee build.log`, r`npm test || true`, r`for c in ls pwd; do "$c"; done`, r`npm run lint && npm test`, r`git status; git diff --stat`]) {
      for (const dialect of ["posix-bash", "windows-git-bash"] as const) for (const [level, bot] of LEVELS.slice(2)) {
        expect(verdict(command, bot, dialect).approve, `${dialect} ${level}: ${command}`).not.toBeNull();
      }
    }
  });
});
