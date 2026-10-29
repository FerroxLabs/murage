// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 reader gaps (U17, U19, U21). The command reader now asks for what it
// cannot see, as the PowerShell reader already did:
// - U17: a shell or an interpreter given a script on disk that this text did
//   not write (`bash x.sh`, `node x.js`, `cat x.sh | bash`), or a script a
//   value names, asks at every level. Literal and written scripts are still
//   read as before; `python3 -m`, `bun install`, `node --version` stay ordinary.
// - U19: the overlay pins ENV to "" (unset to every shell that reads it), so a
//   repository's `$ENV` readers see no value; BASH_ENV keeps /dev/null.
// - U21: lua's `os.execute` runs a program; `$env:X += …`, `$x.y = …` read
//   their right side as a command; `cmd /r` is `/c` to the stop line too.
// Fixture strings are inert data, never executed.
import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");
const { autoVerdict } = await import("./auto-approve.ts");
const { classifyStopLine } = await import("./stop-line.ts");
const claude = (await import("./drivers/claude.ts")) as unknown as Record<string, any>;
type StopLinePlace = import("./stop-line.ts").StopLinePlace;

const CWD = "/work/project";
const posixRule = (cmd: string) => alwaysAskCommand(cmd, CWD)?.rule ?? null;
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };

const WIN_HOME = "C:\\Users\\owner";
const WIN_CWD = "C:\\Users\\owner\\Projects\\site";
const win = (): StopLinePlace => ({
  cwd: WIN_CWD,
  roots: [WIN_CWD, "C:\\app\\data\\workspaces\\ws-1", "C:\\Users\\owner\\AppData\\Local\\Temp"],
  home: WIN_HOME,
  knownRecipients: new Set(),
  realpath: (p: string) => (/^[A-Za-z]:\\|^\\\\/.test(p) ? win32.normalize(p) : posix.normalize(p)),
});
const stop = (command: string) => classifyStopLine("PowerShell", { command }, "", win());

// 1.0.9 (NOLIMITS-NODE-109-CUT section 9): every named path an ordinary file and every `cd` target a folder; the
// on-disk cases are server/nolimits-node-109.test.ts
const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => true }) };
describe("U17: a script on disk the reader does not see asks, as under PowerShell", () => {
  const ASKS = [
    "bash ./script.sh",
    "bash -x ./deploy.sh",
    "sh ./deploy.sh",
    "zsh tools/run.zsh",
    "bash ./script.sh arg1 arg2",
    "node scripts/gen.js",
    "node x.js",
    "cd tools && python3 build.py --fast",
    "python3 -u manage.py migrate",
    "ruby tool.rb",
    "perl tool.pl",
    "php artisan migrate",
    "lua init.lua",
    "deno run main.ts",
    "deno run ./main.ts",
    "bun ./x.ts",
    "bun run scripts/build.ts",
    "node -- x.js",
    // its input is the script
    "bash < setup.sh",
    "cat script.sh | bash",
    "cat install.sh | tr -d '\\r' | bash",
    "node < x.js",
    "cat x.py | python3",
    // a script a value names
    "bash \"$SCRIPT\"",
    "node \"$ENTRY\"",
    "python3 $TOOL",
    // a copy of a script on disk, run by a shell
    "cp x.sh y.sh; bash y.sh",
  ];
  it.each(ASKS)("%s asks (unreadable)", (cmd) => {
    expect(posixRule(cmd)).toBe("unreadable");
  });
  // 1.0.5: a script on disk named literally asks at Auto; Full access and No
  // limits run it on the owner's own turn when the whole text is of the
  // allowed shape (server/always-ask.ts unseenShapeAdmits, r4): a shell or an
  // interpreter with no option before the script, `cd`, nothing else. Every
  // other row still asks at every level: an option, another shell or runner,
  // script bytes on its input, a value, a copy.
  const BELOW_FULL = new Set(["bash ./script.sh", "sh ./deploy.sh", "bash ./script.sh arg1 arg2", "node scripts/gen.js", "node x.js", "ruby tool.rb", "perl tool.pl"]);
  // 1.0.9 (NOLIMITS-NODE-109-CUT): `cd tools` (a bare `cd`) and `php artisan` (no extension) now ask at every level
  it.each(ASKS)("%s raises a card at Auto, and under Full access and No limits outside the allowed shape", (cmd) => {
    expect(autoVerdict(AUTO, "Bash", cmd)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    for (const bot of [FULL, NO_LIMITS]) {
      // 1.0.5 r6: the script path is placed from the command's folder (every
      // local turn has one); with no folder a relative path asks
      if (BELOW_FULL.has(cmd)) {
        expect(autoVerdict(bot, "Bash", cmd, { commandText: cmd, commandCwd: "/work/project", unseen: { fs: STUB, platform: "posix" } }).approve, cmd).toBeTruthy();
        expect(autoVerdict(bot, "Bash", cmd)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
      } else expect(autoVerdict(bot, "Bash", cmd)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    }
  });

  const ORDINARY = [
    "bash",
    "bash -c 'echo hi'",
    "printf 'echo hi' > a.sh; bash a.sh",
    "printf 'print(1)' > a.py; python3 a.py",
    "echo 'echo hi' | bash",
    "bash < /dev/null",
    "python3 -m pytest -q",
    "python3 -c 'print(1)'",
    "node --version",
    "node -e 'console.log(1)'",
    "bun install",
    "bun test",
    "bun run build",
    "deno test",
    "deno run dev",
    "npm run build",
    "make && ./run.sh",
    "git status",
  ];
  it.each(ORDINARY)("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
});

describe("U19: ENV is pinned to \"\", BASH_ENV to /dev/null", () => {
  const SHAPES = [["linux", { kind: "murage-exec", shell: "/bin/bash" }], ["darwin", { kind: "murage-exec", shell: "/bin/bash" }], ["win32", { kind: "murage-exec", shell: "C:\\Program Files\\Git\\bin\\bash.exe" }], ["win32", { kind: "powershell-inherit", reason: "no-git-bash" }]] as const;
  it("the overlay carries ENV as \"\" on every shape, so a `$ENV` reader sees no value", () => {
    expect(claude.CLAUDE_OVERLAY_NEUTRAL).toEqual({ BASH_ENV: "/dev/null" });
    expect(claude.CLAUDE_OVERLAY_EMPTY_ALLOWED).toContain("ENV");
    for (const [platform, shell] of SHAPES) {
      const handed = { PATH: platform === "win32" ? "C:\\Windows\\system32" : "/usr/bin", NODE_OPTIONS: "" };
      const overlay = claude.claudeOverlayEnv(platform, shell, handed, []);
      expect("refusal" in overlay, `${platform} ${shell.kind}`).toBe(false);
      expect(overlay.env.ENV, `${platform} ${shell.kind}`).toBe("");
      expect(overlay.env.BASH_ENV, `${platform} ${shell.kind}`).toBe("/dev/null");
    }
  });
});

describe("U21: lua os.execute, PowerShell member and scope assignments, cmd /r", () => {
  it.each([
    "lua -e 'os.execute(\"rm -rf ~\")'",
    "luajit -e 'os.execute(\"rm -rf /\")'",
    "lua -e 'os.execute(os.getenv(\"CMD\"))'",
    "printf 'os.execute(\"ls\")' > a.lua; lua a.lua",
  ])("%s asks", (cmd) => {
    expect(posixRule(cmd)).not.toBeNull();
  });
  it.each(["lua -e 'print(os.time())'", "lua -e 'os.execute(\"ls -la\")'"])("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });

  it.each([
    "$env:X += Remove-Item -Recurse -Force ~",
    "$env:X = Remove-Item -Recurse -Force ~",
    "$env:X+=Remove-Item -Recurse -Force ~",
    "$x.y += Remove-Item -Recurse -Force ~",
    "$x.y = Remove-Item -Recurse -Force ~",
    "$x.y+=Remove-Item -Recurse -Force ~",
    "$x.y.z ??= Remove-Item -Recurse -Force ~",
    "$x[0] = Remove-Item -Recurse -Force ~",
    "[string]$env:X += Remove-Item -Recurse -Force ~",
  ])("`%s` is a stop line", (cmd) => {
    expect(stop(cmd), cmd).toMatchObject({ kind: "delete" });
  });
  it("`$env:X += git push --force` reads as `$x = git push --force` does", () => {
    const twin = stop("$x = git push --force origin main");
    expect(twin).not.toBeNull();
    expect(stop("$env:X += git push --force origin main")).toMatchObject({ kind: twin!.kind });
    expect(stop("$x.y = git push --force origin main")).toMatchObject({ kind: twin!.kind });
  });
  it("`$env:X += 'a'` and `$x.y = 1` name nothing", () => {
    expect(stop("$env:PATH += ';C:\\tools'")).toBeNull();
    expect(stop("$x.y = 1")).toBeNull();
  });

  it.each([
    ["cmd /r rd /s /q C:\\Users\\owner\\Documents\\old", "cmd /c rd /s /q C:\\Users\\owner\\Documents\\old"],
    ["cmd.exe /R rd /s /q C:\\Users\\owner\\Documents\\old", "cmd.exe /C rd /s /q C:\\Users\\owner\\Documents\\old"],
    ["cmd /rrd /s /q C:\\Users\\owner\\Documents\\old", "cmd /crd /s /q C:\\Users\\owner\\Documents\\old"],
  ])("%s is the stop line `%s` is", (r, c) => {
    const twin = stop(c);
    expect(twin, c).not.toBeNull();
    expect(stop(r)).toEqual(twin);
  });
  it("cmd /r echo hi has no stop line", () => {
    expect(stop("cmd /r echo hi")).toBeNull();
  });
});
