// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 reader gaps, third round:
// - `deno run` / `bun run` options that load code before the script
//   (`--preload`, `--require`, `--import`, bun's `-r`) ask: that code is not
//   in the text.
// - PowerShell: a member named by a variable or literal in parentheses
//   (`$x.($y) = …`) is an assignment target, so the stop line reads the
//   right side as a command.
// Fixture strings are inert data, never executed.
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
const WIN_CWD = "C:\\Users\\owner\\Projects\\site";
const win = (): StopLinePlace => ({
  cwd: WIN_CWD,
  roots: [WIN_CWD, "C:\\app\\data\\workspaces\\ws-1", "C:\\Users\\owner\\AppData\\Local\\Temp"],
  home: "C:\\Users\\owner",
  knownRecipients: new Set(),
  realpath: (p: string) => (/^[A-Za-z]:\\|^\\\\/.test(p) ? win32.normalize(p) : posix.normalize(p)),
});
const stop = (command: string) => classifyStopLine("PowerShell", { command }, "", win());

describe("deno run and bun run options that load code first ask", () => {
  it.each([
    "bun run --require=./evil.ts build",
    "bun run --preload ./evil.ts build",
    "bun run -r ./evil.ts index.ts",
    "bun run --import=./evil.ts dev",
    "printf 'console.log(1)' > ok.ts; deno run --preload=./evil.ts ok.ts",
    "deno run -A --require ./evil.ts dev",
  ])("%s asks", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)?.rule).toBe("unreadable");
  });
  it.each(["deno run -r dev", "bun run --watch dev", "printf 'console.log(1)' > ok.ts; deno run -A ok.ts"])("%s stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
});

describe("PowerShell: `$x.(…)` is an assignment target", () => {
  it.each([
    "$x.($y) = Remove-Item -Recurse -Force ~",
    "$x.($y)=Remove-Item -Recurse -Force ~",
    "$x.('k') = Remove-Item -Recurse -Force ~",
    "$x.(${y}) += Remove-Item -Recurse -Force ~",
    "$a.b.($c) ??= Remove-Item -Recurse -Force ~",
  ])("`%s` is a stop line", (cmd) => {
    expect(stop(cmd), cmd).toMatchObject({ kind: "delete" });
  });
  it("`$x.($y) = git push --force` reads as `$x = git push --force` does", () => {
    const twin = stop("$x = git push --force origin main");
    expect(twin).not.toBeNull();
    expect(stop("$x.($y) = git push --force origin main")).toMatchObject({ kind: twin!.kind });
  });
  it("a command inside the parentheses is still read", () => {
    expect(stop("$x.(Remove-Item -Recurse -Force ~) = 1")).toMatchObject({ kind: "delete" });
  });
  it("`$x.($y) = 1` names nothing", () => {
    expect(stop("$x.($y) = 1")).toBeNull();
  });
});

// reader-gaps r3 (Grok), folded into the 1.0.5 r4 allow-list lane
describe("reader-gaps r3: code loaded first and PowerShell member groups", () => {
  const FULL = { autoApprove: true, fullAccess: true };
  const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
  it.each([
    "printf 'console.log(1)' > ok.ts; bun -r ./evil.ts ok.ts",
    "bun --require ./evil.ts run ok.ts",
    "bun --import=./evil.ts ok.ts",
    "bun -r./evil.ts ok.ts",
  ])("POSIX `%s` asks at Full access and No limits", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)?.rule).toBe("unreadable");
    for (const bot of [FULL, NO_LIMITS]) expect(autoVerdict(bot, "Bash", cmd), cmd).toMatchObject({ approve: null, source: "always-ask" });
  });
  it.each([
    "bun run --preload ./evil.ts build",
    "bun run --require=./evil.ts build",
    "bun run -r ./evil.ts build",
    "bun --preload ./evil.ts run build",
    "deno run --preload=./evil.ts dev",
    "bun run --made-up-option build",
  ])("PowerShell `%s` asks", (cmd) => {
    expect(alwaysAskCommand(cmd, WIN_CWD, "command", "pwsh")?.rule).toBe("unreadable");
  });
  it.each(["bun run --watch dev", "bun run build", "deno run -r dev"])("PowerShell `%s` stays ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, WIN_CWD, "command", "pwsh")).toBeNull();
  });
  it.each([
    ["$x.(1+1) = git push --force origin main", "$x = git push --force origin main"],
    ["$x.(Get-Date) = git reset --hard HEAD~3", "$x = git reset --hard HEAD~3"],
    ["$x.((Get-Date).Day) = git branch -D main", "$x = git branch -D main"],
  ])("`%s`: an expression member group keeps the right side read, as `%s` is", (cmd, twin) => {
    const expected = stop(twin);
    expect(expected, twin).not.toBeNull();
    expect(stop(cmd), cmd).toMatchObject({ kind: expected!.kind });
  });
  it.each(["$x.(Get-Date) = Remove-Item -Recurse -Force ~", "$x.(Remove-Item -Recurse -Force ~) = 1", "$x.('a' + (Remove-Item -Recurse -Force ~)) = 1"])("`%s` is a stop line", (cmd) => {
    expect(stop(cmd), cmd).toMatchObject({ kind: "delete" });
  });
  it.each(["$x.(format) = 1", "$x.(rm) = 1"])("`%s`: a bare word in the group is a command, and still stops", (cmd) => {
    expect(stop(cmd), cmd).not.toBeNull();
  });
  it.each(["$x.(1) = Remove-Item -Recurse -Force ~", "$x.(0x10) = Remove-Item -Recurse -Force ~"])("`%s`: a number member keeps the target, the right side stops", (cmd) => {
    expect(stop(cmd), cmd).toMatchObject({ kind: "delete" });
  });
});
