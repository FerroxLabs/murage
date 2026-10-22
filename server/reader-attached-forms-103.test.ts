// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 A-b1-1 and G-b3-1: the command reader reads the attached spellings.
// An interpreter's inline-code option with its code attached
// (`node --eval=<code>`, `perl -e<code>`, `python3 -Ic<code>`) is read as
// the spaced form is, by the POSIX and PowerShell readers alike, as are
// PowerShell's `-Command:<text>` and cmd's `/c<text>`. Every PowerShell
// assignment operator (`+= -= *= /= %= ??=`) reads its right side as `=`
// does, so the stop line sees the command there. Fixture strings are inert
// data, never executed.
import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");
const { autoVerdict, isCommandTool } = await import("./auto-approve.ts");
const { classifyStopLine } = await import("./stop-line.ts");
type StopLinePlace = import("./stop-line.ts").StopLinePlace;
type AutoContext = import("./auto-approve.ts").AutoContext;

const CWD = "/work/project";
const posixRule = (cmd: string) => alwaysAskCommand(cmd, CWD)?.rule ?? null;

const WIN_HOME = "C:\\Users\\owner";
const WIN_CWD = "C:\\Users\\owner\\Projects\\site";
const win = (): StopLinePlace => ({
  cwd: WIN_CWD,
  roots: [WIN_CWD, "C:\\app\\data\\workspaces\\ws-1", "C:\\Users\\owner\\AppData\\Local\\Temp"],
  home: WIN_HOME,
  knownRecipients: new Set(),
  realpath: (p: string) => (/^[A-Za-z]:\\|^\\\\/.test(p) ? win32.normalize(p) : posix.normalize(p)),
});
const pwshRule = (cmd: string) => alwaysAskCommand(cmd, WIN_CWD, "command", "pwsh")?.rule ?? null;
const stop = (command: string) => classifyStopLine("PowerShell", { command }, "", win());
const powershellAsk = (command: string): AutoContext => ({
  stopLine: classifyStopLine("PowerShell", { command }, command, win()),
  ...(isCommandTool("PowerShell") ? { commandText: command, commandCwd: WIN_CWD } : {}),
});
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };

/** [attached, spaced twin]: the attached spelling reads as its twin does. */
const POSIX_HELD: Array<[string, string]> = [
  ["node --eval=\"require('fs').rmSync('/', {recursive: true})\"", "node --eval \"require('fs').rmSync('/', {recursive: true})\""],
  ["node --eval='require(\"child_process\").execSync(\"rm -rf ~\")'", "node --eval 'require(\"child_process\").execSync(\"rm -rf ~\")'"],
  ["node --print=\"require('child_process').execSync('rm -rf ~')\"", "node --print \"require('child_process').execSync('rm -rf ~')\""],
  ["node -e\"require('fs').rmSync('/', {recursive: true})\"", "node -e \"require('fs').rmSync('/', {recursive: true})\""],
  ["node -p\"require('child_process').execSync('rm -rf ~')\"", "node -p \"require('child_process').execSync('rm -rf ~')\""],
  ["node -pe \"require('child_process').execSync('rm -rf ~')\"", "node -p \"require('child_process').execSync('rm -rf ~')\""],
  ["bun --eval=\"require('fs').rmSync('/', {recursive: true})\"", "bun --eval \"require('fs').rmSync('/', {recursive: true})\""],
  ["bun -e\"require('fs').rmSync('/', {recursive: true})\"", "bun -e \"require('fs').rmSync('/', {recursive: true})\""],
  ["perl -e'system(\"rm -rf ~\")'", "perl -e 'system(\"rm -rf ~\")'"],
  ["perl -lne'system(\"rm -rf ~\")'", "perl -lne 'system(\"rm -rf ~\")'"],
  ["perl -e'print 1' -e'system(\"rm -rf ~\")'", "perl -e 'print 1' -e 'system(\"rm -rf ~\")'"],
  ["ruby -e'FileUtils.rm_rf(Dir.home)'", "ruby -e 'FileUtils.rm_rf(Dir.home)'"],
  ["python3 -c\"import shutil, os; shutil.rmtree(os.environ['HOME'])\"", "python3 -c \"import shutil, os; shutil.rmtree(os.environ['HOME'])\""],
  ["python3 -Ic\"import shutil, os; shutil.rmtree(os.environ['HOME'])\"", "python3 -Ic \"import shutil, os; shutil.rmtree(os.environ['HOME'])\""],
  ["php -r'system(\"rm -rf ~\");'", "php -r 'system(\"rm -rf ~\");'"],
  ["lua -e'io.popen(\"rm -rf ~\")'", "lua -e 'io.popen(\"rm -rf ~\")'"],
  ["osascript -e'do shell script \"rm -rf ~\"'", "osascript -e 'do shell script \"rm -rf ~\"'"],
  ["node --eval=\"$CODE\"", "node --eval \"$CODE\""],
  ["perl -e\"$CODE\"", "perl -e \"$CODE\""],
  // a file this text wrote is still read after a value-taking option
  ["printf 'import shutil\\nshutil.rmtree(\"/\")\\n' > x.py && python3 -Wonce x.py", "printf 'import shutil\\nshutil.rmtree(\"/\")\\n' > x.py && python3 x.py"],
];

const POSIX_ORDINARY = [
  "node --eval=\"console.log(1)\"",
  "node --print=process.version",
  "node -pe 'process.version'",
  "node -e'console.log(1)'",
  "perl -le'print 1'",
  "python3 -c'print(1)'",
  "python3 -Wonce build.py",
  "python3 -m http.server",
  "ruby -rjson -e 'puts 1'",
  "npm run x -- --eval=1",
  "npx tsc --eval=1",
  "grep -e'foo' src/a.ts",
];

describe("A-b1-1: attached inline code, POSIX reader", () => {
  it.each(POSIX_HELD)("%s reads as its spaced twin", (attached, spaced) => {
    const twin = posixRule(spaced);
    expect(twin, spaced).not.toBeNull();
    expect(posixRule(attached)).toBe(twin);
  });
  it.each(POSIX_ORDINARY)("%s stays ordinary", (cmd) => {
    expect(posixRule(cmd)).toBeNull();
  });
});

/** [with a flag that takes no word, without it]: perl's `-l` takes only
 * attached digits, ruby's `-l` and python's `-I` nothing; the code or script
 * after them is read as it is without them. */
const FLAG_HELD: Array<[string, string]> = [
  ["perl -l -e 'system(\"rm -rf ~\")'", "perl -e 'system(\"rm -rf ~\")'"],
  ["perl -l -ne 'system(\"rm -rf ~\")'", "perl -ne 'system(\"rm -rf ~\")'"],
  ["perl -l015 -e 'system(\"rm -rf ~\")'", "perl -e 'system(\"rm -rf ~\")'"],
  ["perl -l -e \"$CODE\"", "perl -e \"$CODE\""],
  ["ruby -l -e 'FileUtils.rm_rf(Dir.home)'", "ruby -e 'FileUtils.rm_rf(Dir.home)'"],
  ["printf 'import shutil\\nshutil.rmtree(\"/\")\\n' > x.py && python3 -I x.py", "printf 'import shutil\\nshutil.rmtree(\"/\")\\n' > x.py && python3 x.py"],
];

describe("perl -l takes no word: the code after it is read", () => {
  it.each(FLAG_HELD)("%s reads as %s", (flagged, plain) => {
    const twin = posixRule(plain);
    expect(twin, plain).not.toBeNull();
    expect(posixRule(flagged)).toBe(twin);
  });
  it.each(["perl -l -e 'print 1'", "perl -l -ne 'print'", "ruby -l -e 'puts 1'", "lua -l socket -e 'print(1)'"])("%s stays ordinary", (cmd) => {
    expect(posixRule(cmd)).toBeNull();
  });
  it("PowerShell reads `perl -l -e <code>` as inline code too", () => {
    expect(pwshRule("perl -l -e 'print 1'")).toBe(pwshRule("perl -e 'print 1'"));
    expect(pwshRule("perl -l -e 'print 1'")).not.toBeNull();
  });
});

const PWSH_HELD: Array<[string, string]> = [
  ["node --eval=console.log(1)", "node --eval console.log(1)"],
  ["node --eval='console.log(1)'", "node --eval 'console.log(1)'"],
  ["node -econsole.log(1)", "node -e console.log(1)"],
  ["bun --print=1", "bun --print 1"],
  ["perl -e'print 1'", "perl -e 'print 1'"],
  ["perl -lne'print'", "perl -lne 'print'"],
  ["ruby -e'puts 1'", "ruby -e 'puts 1'"],
  ["php -r'echo 1;'", "php -r 'echo 1;'"],
  ["python -c'print(1)'", "python -c 'print(1)'"],
  ["pwsh -Command:'Remove-Item -Recurse -Force ~'", "pwsh -Command 'Remove-Item -Recurse -Force ~'"],
  ["pwsh -c:'Remove-Item -Recurse -Force ~'", "pwsh -c 'Remove-Item -Recurse -Force ~'"],
  ["cmd /c\"rd /s /q C:\\Users\\owner\"", "cmd /c \"rd /s /q C:\\Users\\owner\""],
];

const PWSH_ORDINARY = [
  "npm run x -- --eval=1",
  "git log --format=%H -e",
  "Get-ChildItem -Force",
  "pwsh -Command:'Get-ChildItem'",
];

describe("A-b1-1: attached inline code, PowerShell reader", () => {
  it.each(PWSH_HELD)("%s reads as its spaced twin", (attached, spaced) => {
    const twin = pwshRule(spaced);
    expect(twin, spaced).not.toBeNull();
    expect(pwshRule(attached)).toBe(twin);
  });
  it.each(PWSH_ORDINARY)("%s stays ordinary", (cmd) => {
    expect(pwshRule(cmd)).toBeNull();
  });
});

const OPERATORS = ["+=", "-=", "*=", "/=", "%=", "??="];

describe("G-b3-1: every PowerShell assignment operator reads its right side", () => {
  it.each(OPERATORS)("`$x %s Remove-Item -Recurse -Force ~` is a stop line, spaced and glued", (op) => {
    for (const command of [`$x ${op} Remove-Item -Recurse -Force ~`, `$x${op}Remove-Item -Recurse -Force ~`, `[int]$x ${op} Remove-Item -Recurse -Force ~`]) {
      expect(stop(command), command).toMatchObject({ kind: "delete" });
    }
  });

  it.each(OPERATORS)("`$x %s <one outside file>` reads as `=` does", (op) => {
    const twin = stop("$x = Remove-Item C:\\Users\\owner\\Documents\\old.txt");
    expect(twin).not.toBeNull();
    expect(stop(`$x ${op} Remove-Item C:\\Users\\owner\\Documents\\old.txt`)).toEqual(twin);
  });

  it.each(OPERATORS)("`$x %s git push --force` reads as `=` does", (op) => {
    const twin = stop("$x = git push --force origin main");
    expect(twin).not.toBeNull();
    expect(stop(`$x ${op} git push --force origin main`)).toMatchObject({ kind: twin!.kind, place: (twin as { place?: string }).place });
  });

  it.each(OPERATORS)("`$x %s Remove-Item -Recurse -Force ~` asks under Full access and No limits", (op) => {
    const command = `$x ${op} Remove-Item -Recurse -Force ~`;
    for (const [label, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
      expect(autoVerdict(bot, "PowerShell", command, powershellAsk(command)).approve, label).toBeNull();
    }
  });

  it("a compound value leaves the variable unknown; a plain one is still followed", () => {
    expect(stop("$p = 'C:\\Users\\owner\\Documents\\x.txt'; Remove-Item $p")).toMatchObject({ kind: "delete" });
    expect(stop("$p = 'C:\\Users\\owner\\Documents\\x.txt'; $p += '.bak'; Remove-Item $p")).not.toBeNull();
  });

  it("ordinary compound assignments stay ordinary", () => {
    for (const command of ["$n += 1", "$n = 0; $n += 1; Write-Output $n", "$list += Get-ChildItem", "$s ??= 'x'", "$t -= 2"]) {
      expect(stop(command), command).toBeNull();
    }
  });
});
