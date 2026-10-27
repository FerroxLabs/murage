// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 reader gaps, second round. The command reader now also reads:
// - `deno run` and `bun run` with options before the script: the script is
//   read (a file this text wrote is scanned, one on disk asks); an option the
//   reader does not know asks, since it may take the next word.
// - `bash --rcfile X` and `--init-file X`: a startup file this text wrote is
//   walked; one on disk, or a value, asks.
// - `source X` and `. X` read a file on disk the way `bash X` does.
// - Lua: `os["execute"]`, `os . execute`, long strings (`[[…]]`) and string
//   calls are read as `os.execute("…")`; other ways to reach `os` ask.
// - PowerShell: a `$…` assignment target with a dynamic member (`$x.$y =`,
//   `${env:X}=`) has its right side read as a command by the stop line.
// The sweep at the end holds every corpus command that asked before this lane
// (on its base and on its first round) to asking still.
// Fixture strings are inert data, never executed.
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");
const { autoVerdict } = await import("./auto-approve.ts");
const { classifyStopLine } = await import("./stop-line.ts");
type StopLinePlace = import("./stop-line.ts").StopLinePlace;

const CWD = "/work/project";
const posixRule = (cmd: string) => alwaysAskCommand(cmd, CWD)?.rule ?? null;
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };

const WIN_CWD = "C:\\Users\\owner\\Projects\\site";
const win = (): StopLinePlace => ({
  cwd: WIN_CWD,
  roots: [WIN_CWD, "C:\\app\\data\\workspaces\\ws-1", "C:\\Users\\owner\\AppData\\Local\\Temp"],
  home: "C:\\Users\\owner",
  knownRecipients: new Set(),
  realpath: (p: string) => (/^[A-Za-z]:\\|^\\\\/.test(p) ? win32.normalize(p) : posix.normalize(p)),
});
const stop = (command: string) => classifyStopLine("PowerShell", { command }, "", win());
const nix = (): StopLinePlace => ({ cwd: CWD, roots: [CWD, "/tmp"], home: "/home/tester", knownRecipients: new Set(), realpath: (p: string) => posix.normalize(p) });

const asksEverywhere = (cmd: string) => {
  expect(posixRule(cmd), cmd).not.toBeNull();
  for (const bot of [FULL, NO_LIMITS]) expect(autoVerdict(bot, "Bash", cmd), cmd).toMatchObject({ approve: null, source: "always-ask" });
};
/** 1.0.5: a script file on disk, named literally and not written by this
 * text, asks at Auto; Full access and No limits run it on the owner's turn. */
const asksBelowFull = (cmd: string) => {
  expect(alwaysAskCommand(cmd, CWD), cmd).toMatchObject({ rule: "unreadable", unseenScript: true });
  expect(autoVerdict(AUTO, "Bash", cmd), cmd).toMatchObject({ approve: null, source: "always-ask" });
  // 1.0.5 r6: placed from the command's folder (every local turn has one)
  for (const bot of [FULL, NO_LIMITS]) expect(autoVerdict(bot, "Bash", cmd, { commandText: cmd, commandCwd: CWD }).approve, cmd).toBeTruthy();
};

describe("deno run and bun run read the script after their options", () => {
  it.each([
    "deno run -A evil.ts",
    "deno run --allow-read=. --allow-net main.ts",
    "deno run -A --config deno.json main.ts",
    "bun run --watch evil.ts",
    "bun run --hot --cwd app server.ts",
    "bun run -- evil.ts",
    // a runner is outside the allowed shape (1.0.5 r4): it asks at every level
    // an option the reader does not know may take the next word
    "deno run --made-up-option x evil.ts",
    "bun run --made-up-option build",
  ])("%s asks", (cmd) => {
    expect(posixRule(cmd)).toBe("unreadable");
    asksEverywhere(cmd);
  });
  it.each([
    "printf 'os.execute(\"rm -rf ~\")' > build; deno run build",
    "printf 'os.execute(\"rm -rf ~\")' > build; bun run build",
    "printf 'os.execute(\"rm -rf ~\")' > build; deno run -A build",
    "printf 'require(\"child_process\").execSync(\"ls\")' > build; bun build",
  ])("a file this text wrote, run by its bare name, is scanned: %s", asksEverywhere);
  it.each(["deno run dev", "bun run build", "bun run --watch dev", "deno run -A dev", "deno task build", "bun install", "bun test", "deno test",
    "printf 'console.log(1)' > a.ts; deno run -A a.ts"])("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
});

describe("bash --rcfile and --init-file read the startup file", () => {
  it.each([
    "bash --init-file evil.sh -i",
    "bash --rcfile evil.sh -i",
    "bash --rcfile ~/.evilrc",
    "bash --rcfile \"$RC\" -i",
    "env bash --init-file evil.sh -i",
  ])("%s asks", (cmd) => {
    expect(posixRule(cmd)).toBe("unreadable");
    asksEverywhere(cmd);
  });
  it("a startup file this text wrote is walked", () => {
    asksEverywhere("printf 'rm -rf ~' > rc.sh; bash --rcfile rc.sh -i");
    asksEverywhere("printf 'rm -rf ~' > rc.sh; bash --init-file rc.sh -c 'echo hi'");
  });
  it.each(["printf 'echo hi' > rc.sh; bash --rcfile rc.sh -i", "bash --rcfile /dev/null -i", "bash --norc -i"])("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
});

describe("source and . read a file on disk as bash does", () => {
  it.each([
    "source evil.sh",
    ". evil.sh",
    ". ./env.sh",
    "cd sub && . ./evil.sh",
  ])("%s asks below Full access", (cmd) => {
    expect(posixRule(cmd)).toBe("unreadable");
    asksBelowFull(cmd);
  });
  it.each([
    "source -- evil.sh",
    "source \"$F\"",
    ". $F",
  ])("%s asks", (cmd) => {
    expect(posixRule(cmd)).toBe("unreadable");
    asksEverywhere(cmd);
  });
  it("a sourced file this text wrote is walked", () => {
    asksEverywhere("printf 'rm -rf ~' > a.sh; source a.sh");
    asksEverywhere("printf 'rm -rf ~' > a.sh; . ./a.sh");
  });
  it.each(["printf 'echo hi' > a.sh; source a.sh", "source /dev/null"])("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
});

describe("Lua reaches os.execute only in forms the reader reads", () => {
  it.each([
    "lua -e 'os[\"execute\"](\"rm -rf ~\")'",
    "lua -e \"os['execute']('rm -rf ~')\"",
    "lua -e 'os . execute(\"rm -rf ~\")'",
    "lua -e 'os.execute([[rm -rf ~]])'",
    // a long string in code that runs a program asks whatever it holds
    "lua -e 'os.execute([[ls -la]])'",
    "lua -e 'os.execute([==[rm -rf ~]==])'",
    "lua -e 'os.execute[[rm -rf ~]]'",
    "lua -e 'os.execute\"rm -rf ~\"'",
    "lua -e 'local o = os; o.execute(\"rm -rf ~\")'",
    "lua -e 'os[\"exe\"..\"cute\"](\"rm -rf ~\")'",
    "lua -e 'load(\"os.execute(1)\")()'",
    "lua -e 'require(\"os\").execute(\"rm -rf ~\")'",
    "lua -e 'os.execute{\"rm -rf ~\"}'",
    "lua -e 'os.execute(\"ls\") --[[ ]] os.execute([[rm -rf ~]])'",
    "printf 'os[\"execute\"](\"ls\")' > a.lua; lua a.lua",
    "printf 'local o = os; o[\"exe\"..\"cute\"](\"ls\")' > a.lua; lua a.lua",
    "printf 'os[\"execute\"](\"rm -rf ~\")' | lua -",
  ])("%s asks", asksEverywhere);
  it.each(["lua -e 'print(os.time())'", "lua -e 'os.execute(\"ls -la\")'", "lua -e 'print([[hello]])'",
    "lua -e 'print(\"a--b\") -- a comment'"])("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
});

describe("PowerShell: any `$…` assignment target reads its right side as a command", () => {
  it.each([
    "$x.$y = Remove-Item -Recurse -Force ~",
    "$x.$y=Remove-Item -Recurse -Force ~",
    "$x.${y} = Remove-Item -Recurse -Force ~",
    "${env:X}=Remove-Item -Recurse -Force ~",
    "${env:X}+=Remove-Item -Recurse -Force ~",
    "${x}.y = Remove-Item -Recurse -Force ~",
    "$a.$b.$c ??= Remove-Item -Recurse -Force ~",
    "[string]$x.$y = Remove-Item -Recurse -Force ~",
  ])("`%s` is a stop line", (cmd) => {
    expect(stop(cmd), cmd).toMatchObject({ kind: "delete" });
  });
  it("`$x.$y = git push --force` reads as `$x = git push --force` does", () => {
    const twin = stop("$x = git push --force origin main");
    expect(twin).not.toBeNull();
    expect(stop("$x.$y = git push --force origin main")).toMatchObject({ kind: twin!.kind });
    expect(stop("${env:X}=git push --force origin main")).toMatchObject({ kind: twin!.kind });
  });
  it("`$x.$y = 1` and `${env:X}='a'` name nothing", () => {
    expect(stop("$x.$y = 1")).toBeNull();
    expect(stop("${env:X}='a'")).toBeNull();
  });
});

// Every command of the test corpus (string literals of server/**/*.test.ts)
// that asked, or was a stop line, on the lane's base (d12c102b6) or its first
// round (d1f894b00), dumped by running both trees over the corpus. None may
// be auto-allowed now on Bash: this lane only adds asks.
//
// 1.0.8 (KEEP decision): PowerShell and cmd hand inline code (`python -c`,
// `node -e`, ...) to the same scanner Bash uses, so a PowerShell line no longer
// asks just for holding inline code. These are the corpus rows that read
// through that way, each with why it is harmless; each must read as Bash reads
// it (a), and PowerShell may never allow at a level where Bash asks (b).
// A row that reads through and is not listed here fails the sweep.
const BASH_SYNTAX = "Bash cannot read the bare `(`";
const INLINE_PARITY: ReadonlyArray<readonly [string, string]> = [
  ["bun --print 1", "prints or computes only; touches no file, secret or network"],
  ["bun --print=1", "prints or computes only; touches no file, secret or network"],
  ["lua -e 'os.execute(\"ls -la\")'", "runs `ls -la` through os.execute, read as a command: a listing"],
  ["lua -e 'print(\"a--b\") -- a comment'", "prints or computes only; touches no file, secret or network"],
  ["lua -e 'print([[hello]])'", "prints or computes only; touches no file, secret or network"],
  ["lua -e 'print(os.time())'", "prints or computes only; touches no file, secret or network"],
  ["node --eval 'console.log(1)'", "prints or computes only; touches no file, secret or network"],
  ["node --eval console.log(1)", "Bash cannot read the bare `(` and asks; PowerShell hands `console.log(1)` over as one word, which only prints"],
  ["node --eval=\"console.log(1)\"", "prints or computes only; touches no file, secret or network"],
  ["node --eval='console.log(1)'", "prints or computes only; touches no file, secret or network"],
  ["node --eval=console.log(1)", "Bash cannot read the bare `(` and asks; PowerShell hands `console.log(1)` over as one word, which only prints"],
  ["node --print=process.version", "prints or computes only; touches no file, secret or network"],
  ["node -e \"console.log('never run rm -rf on', '/')\"", "names a wipe in its text: the destructive guard asks at Auto, as on Bash (Full access reads it as Bash does)"],
  ["node -e \"console.log(JSON.parse(process.argv[1]).a)\" '{\"a\":1}'", "prints or computes only; touches no file, secret or network"],
  ["node -e \"console.log(require('os').homedir())\"", "prints or computes only; touches no file, secret or network"],
  ["node -e \"const fs = require('fs'); fs.rmSync('dist', { recursive: true }); console.log('a/b'.split('/'))\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["node -e \"require('child_process').execSync('npm test', {stdio: 'inherit'})\"", "runs a fixed read-only command (git status, ls, npm test), read as a command"],
  ["node -e \"require('fs').rmSync('build/x'.split('/').join('-'))\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["node -e 'console.log(1)'", "prints or computes only; touches no file, secret or network"],
  ["node -e 'console.log(`v${process.version}`)'", "a template string the reader cannot place: the prompt guard asks at Auto, as on Bash (Full access reads it as Bash does)"],
  ["node -e 'process.exit(0)'", "prints or computes only; touches no file, secret or network"],
  ["node -e 'require(\"fs\").writeFileSync(require(\"path\").join(\".agents\", \"hooks.json\"), \"{}\")'", "names a secret or an agent hook file: the sensitive guard asks, as on Bash"],
  ["node -e console.log(1)", "Bash cannot read the bare `(` and asks; PowerShell hands `console.log(1)` over as one word, which only prints"],
  ["node -e'console.log(1)'", "prints or computes only; touches no file, secret or network"],
  ["node -econsole.log(1)", "Bash cannot read the bare `(` and asks; PowerShell hands `console.log(1)` over as one word, which only prints"],
  ["node -pe 'process.version'", "prints or computes only; touches no file, secret or network"],
  ["node.exe -e 'console.log(1)'", "prints or computes only; touches no file, secret or network"],
  ["osascript -e 'display notification \"done\"'", "shows a notification only"],
  ["perl -0777pe 'print'", "filters text to the screen (no -i), writes nothing"],
  ["perl -0777pe 's/a/b/g' notes.txt", "filters text to the screen (no -i), writes nothing"],
  ["perl -0ne 'print' notes.txt", "filters text to the screen (no -i), writes nothing"],
  ["perl -e 'print 1'", "prints or computes only; touches no file, secret or network"],
  ["perl -e 'unlink \"/etc/passwd\"'", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["perl -e'print 1'", "prints or computes only; touches no file, secret or network"],
  ["perl -l -e 'print 1'", "prints or computes only; touches no file, secret or network"],
  ["perl -l -ne 'print'", "filters text to the screen (no -i), writes nothing"],
  ["perl -l0e 'print 1'", "prints or computes only; touches no file, secret or network"],
  ["perl -le'print 1'", "prints or computes only; touches no file, secret or network"],
  ["perl -lne 'print'", "filters text to the screen (no -i), writes nothing"],
  ["perl -lne'print'", "filters text to the screen (no -i), writes nothing"],
  ["perl -pe 'print'", "filters text to the screen (no -i), writes nothing"],
  ["php -r 'echo 1;'", "prints or computes only; touches no file, secret or network"],
  ["php -r'echo 1;'", "prints or computes only; touches no file, secret or network"],
  ["python -c 'print(1)'", "prints or computes only; touches no file, secret or network"],
  ["python -c'print(1)'", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"a = [1, 2]; a.remove(1); print(a)\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"d = {}; d.clear(); print('/')\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"import json; d=json.load(open('/Users/me/.codex/auth.json')); print(list(d))\"", "names a secret or an agent hook file: the sensitive guard asks, as on Bash"],
  ["python3 -c \"import os, subprocess; print(os.environ.get('X')); subprocess.run(['git', 'status'])\"", "runs a fixed read-only command (git status, ls, npm test), read as a command"],
  ["python3 -c \"import os; os.remove('/'.join(['build', 'x.o']))\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import os; os.remove('build/out.txt')\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import os; os.remove(os.path.expanduser('~/.cache/x'))\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import os; os.unlink('x.txt', dir_fd=os.O_RDONLY)\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import os; print(os.path.expanduser('~/.config'))\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"import os; print(os.path.join('/', 'tmp'))\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"import platform; print(platform.machine(), '/')\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"import shutil, os; shutil.rmtree(os.path.expanduser('~/.cache/pip'))\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import shutil; shutil.rmtree('/Users/ada/Documents')\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import shutil; shutil.rmtree('build'); print('/'.join(['a', 'b']))\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import shutil; shutil.rmtree('dist')\"", "a delete in code: the stop line reads its paths and asks, as on Bash"],
  ["python3 -c \"import subprocess; print(subprocess.run(['ls'], capture_output=True).stdout)\"", "runs a fixed read-only command (git status, ls, npm test), read as a command"],
  ["python3 -c \"import subprocess; subprocess.run(['git', 'status'])\"", "runs a fixed read-only command (git status, ls, npm test), read as a command"],
  ["python3 -c \"import sys; print(sys.platform, '/')\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"import sys; print(sys.version)\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"model = 'x'; print(model, '~')\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"open('/home/me/dev/out.txt', 'w').write('x')\"", "writes one named file outside every startup or secret place, as Bash allows"],
  ["python3 -c \"print('see /dev/null.'); open('a', 'w')\"", "writes one named file outside every startup or secret place, as Bash allows"],
  ["python3 -c \"print('{}'.format(1)); print('~')\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c \"print('{}/{}'.format('a', 'b'), '/')\"", "prints or computes only; touches no file, secret or network"],
  ["python3 -c 'import os; os.chdir(\".agents\"); open(\"hooks.json\", \"w\").write(\"{}\")'", "names a secret or an agent hook file: the sensitive guard asks, as on Bash"],
  ["python3 -c 'print(1)'", "prints or computes only; touches no file, secret or network"],
  ["python3 -c'print(1)'", "prints or computes only; touches no file, secret or network"],
  ["python3.12.exe -c 'print(1)'", "prints or computes only; touches no file, secret or network"],
  ["python3.exe -c 'print(1)'", "prints or computes only; touches no file, secret or network"],
  ["ruby -e 'puts \"/usr\"'", "prints or computes only; touches no file, secret or network"],
  ["ruby -e 'puts 1'", "prints or computes only; touches no file, secret or network"],
  ["ruby -e'puts 1'", "prints or computes only; touches no file, secret or network"],
  ["ruby -l -e 'puts 1'", "prints or computes only; touches no file, secret or network"],
  ["ruby -rjson -e 'puts 1'", "prints or computes only; touches no file, secret or network"],
];
const PARITY_BOTS = [AUTO, FULL, NO_LIMITS];
const verdictOn = (tool: "PowerShell" | "Bash", cmd: string, bot: Parameters<typeof autoVerdict>[0]) => {
  const place = tool === "PowerShell" ? win() : nix();
  return autoVerdict(bot, tool, cmd, { stopLine: classifyStopLine(tool, { command: cmd }, cmd, place), commandText: cmd, commandCwd: place.cwd, fullAccessOrigin: "owner" } as never);
};

describe("the sweep: nothing that asked before is allowed now", () => {
  const before = JSON.parse(readFileSync(new URL("./testing/reader-gaps-104-asked-before.json", import.meta.url), "utf8")) as Record<"bash" | "pwsh" | "psStop" | "bashStop", string[]>;
  it("the corpus is not empty", () => {
    expect(before.bash.length).toBeGreaterThan(500);
    expect(before.psStop.length).toBeGreaterThan(100);
  });
  it("every command that asked still asks on Bash; on PowerShell only the reviewed inline-code rows read through", () => {
    expect(before.bash.filter((cmd) => alwaysAskCommand(cmd, CWD) === null)).toEqual([]);
    const through = before.pwsh.filter((cmd) => alwaysAskCommand(cmd, WIN_CWD, "command", "pwsh") === null);
    expect([...through].sort()).toEqual(INLINE_PARITY.map(([cmd]) => cmd).sort());
  });
  it.each(INLINE_PARITY)("%s reads as Bash reads it: %s", (cmd, why) => {
    if (why.startsWith(BASH_SYNTAX)) {
      expect(posixRule(cmd), cmd).toBe("unreadable");
      expect(cmd).toMatch(/ --?e(val)?[= ]?console\.log\(1\)$/);
      return;
    }
    expect(posixRule(cmd), cmd).toBeNull();
    for (const bot of PARITY_BOTS) {
      if (verdictOn("PowerShell", cmd, bot).approve) expect(verdictOn("Bash", cmd, bot).approve, `${cmd} at ${JSON.stringify(bot)}`).toBeTruthy();
    }
    if (/ asks, as on Bash$/.test(why)) for (const bot of [AUTO, FULL]) expect(verdictOn("PowerShell", cmd, bot).approve, cmd).toBeFalsy();
    if (/ asks at Auto, as on Bash /.test(why)) {
      expect(verdictOn("PowerShell", cmd, AUTO).approve, cmd).toBeFalsy();
      for (const bot of PARITY_BOTS) expect(Boolean(verdictOn("PowerShell", cmd, bot).approve), `${cmd} at ${JSON.stringify(bot)}`).toBe(Boolean(verdictOn("Bash", cmd, bot).approve));
    }
  });
  it("every stop line is still a stop line", () => {
    expect(before.psStop.filter((cmd) => stop(cmd) === null)).toEqual([]);
    expect(before.bashStop.filter((cmd) => classifyStopLine("Bash", { command: cmd }, "", nix()) === null)).toEqual([]);
  });
});

// 1.0.8: the PowerShell and cmd stop line reads a delete written as code the
// way the Bash one does, by the paths it names (drive spellings too).
describe("PowerShell and cmd: a delete in inline code is a stop line", () => {
  it.each([
    `python3 -c "import shutil; shutil.rmtree('C:\\Users\\owner\\Documents')"`,
    `node -e "require('fs').rmSync('~/notes', { recursive: true })"`,
    `perl -e 'unlink "C:/Users/owner/.ssh/id_ed25519"'`,
    `cmd /c python -c "import shutil; shutil.rmtree('C:/Users/owner/Documents')"`,
    `python -c "import shutil; shutil.rmtree('dist')"`,
    // a drive-relative name, beside one in the project, is still unplaced
    `python -c "import os; os.remove('./notes.txt'); os.remove('C:secret')"`,
    // `~` alone is the home folder, beside a name in the project
    `python -c "import shutil, os; shutil.rmtree(os.path.expanduser('~')); print('./x')"`,
  ])("%s", (cmd) => {
    expect(stop(cmd), cmd).not.toBeNull();
  });
  it("code that deletes nothing is no stop line", () => {
    expect(stop(`python -c "print('/')"`)).toBeNull();
  });
});

// 1.0.8: a file written inside a block, an assignment's right side, a nested
// shell or a cmd branch stays written, so inline code that runs it asks.
describe("PowerShell and cmd: inline code that runs a file this text wrote asks", () => {
  const RUN = `python3 -c "import os; os.system(open('c.txt').read())"`;
  it.each([
    `Set-Content c.txt 'rm -rf ~'; ${RUN}`,
    `$null = Set-Content c.txt 'rm -rf ~'; ${RUN}`,
    `& { Set-Content c.txt 'rm -rf ~' }; ${RUN}`,
    `& { 'rm -rf ~' > c.txt }; ${RUN}`,
    `pwsh -Command "Set-Content c.txt 'rm -rf ~'"; ${RUN}`,
    `cmd /c "echo rm -rf ~ > c.txt"; ${RUN}`,
    `cmd /c "if 1==1 echo rm -rf ~ > c.txt"; ${RUN}`,
    `cmd /c "for %i in (a) do echo rm -rf ~ > c.txt"; ${RUN}`,
  ])("%s", (cmd) => {
    expect(alwaysAskCommand(cmd, WIN_CWD, "command", "pwsh"), cmd).not.toBeNull();
  });
});
