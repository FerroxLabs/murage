// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS 1.0.18, MurageMain rulings of 11-08 (G3 and the closed RISKS). Named rows for the read changes the owner's clean No limits
// turn needed, each with the mutant that turns it red in marks-owner-reads-mutants (run on hz, results in the commit message):
//   M-LS-F          `ls -f` and `ls -r` are read flags (G3: readOnlyListed rejecting `ls -rf` was a product bug), so `$R -rf ~` with R=ls runs (N6)
//   M-SHELL-C       a shell's `-c` script is read by the walker with `$0` and the positionals bound (G3, N6); the shell's own operands are not a
//                   program's write targets, and a command the script runs on a protected operand still denies by its own position
//   M-STATEMENT     catastropheFirst reads a heredoc's body and a defined function with the statement that holds them (G3 `f /`, the heredoc)
//   M-FUNCTION      a function call is judged by its body (MARKS-r14 rule 8: inner commands are judged on their own), not as an unknown
//                   program named `f` given `/` (RISK c)
//   M-TILDE         a quoted `~` is a literal file name, not the home folder (RISK b)
//   M-WHOLE-TOOL / M-WHOLE-TEXT   server/index.ts's wholeCommand guards, now `wholeCommandOf` (RISK a)
// Every other level and origin reads as NLH0 (R1): the plain read and the Full access verdict of each row are compared with the
// answer NLH0 gave, pinned in testing/marks-nlh0-verdicts.json.
import { describe, expect, it, vi } from "vitest";
import { nlh0, type Added } from "./testing/marks-nlh0.ts";
import { expectNoLimitsOwnerOutcome, expectNoLimitsProtectedWrite } from "./testing/no-limits-1019.ts";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");
const auto = await import("./auto-approve.ts");
const { autoVerdict } = auto;
const marksModule = await import("./shell/marks.ts");
/** The owner's clean No limits read (MARKS R1); a plain call on a tree that has none (NLH0). */
const ownerMarks = <T>(read: () => T): T => ("ownerMarks" in marksModule ? (marksModule as unknown as { ownerMarks: <U>(run: () => U) => U }).ownerMarks(read) : read());

const FULL = { id: "full", autoApprove: true, fullAccess: true };
const NO_LIMITS = { id: "owner", autoApprove: true, fullAccess: true, noLimits: true };
const turn = (command: string, cwd: string | undefined = "/w") => ({ commandText: command, ...(cwd ? { commandCwd: cwd, workFolder: cwd } : {}),
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null }) as unknown as Parameters<typeof autoVerdict>[3];
const read = (command: string, cwd: string | undefined = "/w") => ownerMarks(() => alwaysAskCommand(command, cwd));
const owner = (command: string, cwd?: string) => autoVerdict(NO_LIMITS, "Bash", command, turn(command, cwd));
// T4-E: exact direct Full-access additions, including the confirmed Stage 0 value.
const T4_FULL: Record<string, Added> = {
  "R=ls; R=rm; $R -rf ~": {"reason": "delete-home"},
  "R=rm; $R -rf ~": {"reason": "delete-home"},
  "bash -c 'cp x \"$1\"' y /etc/hosts": {"reason": "protected-path"},
  "bash -c 'exec \"$@\"' x rm -rf /home": {"reason": "delete-system-folder"},
  "bash -c 'mytool \"$0\"' /usr": {"reason": "protected-path"},
  "bash -c 'rm -rf \"$0\"' /usr": {"reason": "delete-system-folder"},
  "cat <<EOF > notes.md\nhi\nEOF\ncat <<EOT\nx\nEOT\nrm -rf /usr": {"reason": "delete-system-folder"},
  "cat <<EOF > notes.md\nhi\nEOF\nrm -rf ~": {"reason": "delete-home"},
  "f(){ mytool \"$1\"; }; f /": {"reason": "protected-path"},
  "f(){ rm -rf \"$1\"; }; f /": {"reason": "delete-root"},
  "f(){ rm -rf \"$1\"; }; touch out; f /": {"reason": "delete-root"},
  "means-it-N5|node -e \"require('child_process').execSync('rm -rf /')\"": {"reason": "unreadable"},
  "means-it-N5|python3 -c \"import os; os.system('rm -rf /')\"": {"reason": "unreadable"},
  "rm -rf ~": {"reason": "delete-home"},
  "unknownprog /": {"reason": "protected-path"},
  "bash -c \"$X\" /usr": {"reason": "value-path"},
};
/** The other levels: NLH0's answer, pinned (R1). */
const asNlh0 = (id: string, command: string) => {
  nlh0(`owner-reads|${id}|read`, alwaysAskCommand(command, "/w"));
  nlh0(`owner-reads|${id}|full`, autoVerdict(FULL, "Bash", command, turn(command)), undefined, T4_FULL[id]);
};
const runs = (command: string, cwd?: string) => { expect(read(command, cwd), command).toBeNull(); expect(owner(command, cwd), command).toMatchObject({ source: "no-limits" }); expect(owner(command, cwd).approve).toBeTruthy(); };
const denies = (command: string, rule: string, cwd?: string) => {
  expect(read(command, cwd), command).toMatchObject({ classification: "deny", rule });
  // NOLIM 1.0.19: the reader's rule is asserted above; the owner's No limits turn runs a non-wipe deny row, a wipe row keeps its card
  expectNoLimitsOwnerOutcome(owner(command, cwd), command, read(command, cwd)?.rule, command);
};

describe("G3 M-LS-F: ls -r and ls -f are read flags (N6)", () => {
  it.each(["ls -rf ~", "ls -fr ~", "ls -f ~", "R=ls; FOO=1 $R -rf ~", "R=ls; (R=rm); $R -rf ~", "R=rm; R=ls; $R -rf ~"])("%s runs on the owner's turn", (command) => {
    asNlh0(command, command);
    runs(command);
    runs(command, undefined);
  });
  it.each([["R=rm; $R -rf ~", "delete-home"], ["R=ls; R=rm; $R -rf ~", "delete-home"], ["rm -rf ~", "delete-home"]])("%s still denies", (command, rule) => {
    asNlh0(command, command);
    denies(command, rule);
  });
});

describe("G3 M-SHELL-C: a shell's -c script is read with its positionals bound (N6)", () => {
  it.each(["bash -c 'echo $0' /usr", "bash -c 'ls \"$HOME\"' -- x", "bash -lc 'ls \"$HOME\"' -- x", "sh -c 'echo \"$1\"' x /etc"])("%s runs", (command) => {
    asNlh0(command, command);
    runs(command);
    runs(command, undefined);
  });
  // a position the script does not read is still the command's own: each of these is judged where it stands
  it.each([
    ["bash -c 'rm -rf \"$0\"' /usr", "delete-system-folder"],
    ["bash -c 'mytool \"$0\"' /usr", "protected-path"],
    ["bash -c 'cp x \"$1\"' y /etc/hosts", "protected-path"],
    ["bash -c 'exec \"$@\"' x rm -rf /home", "delete-system-folder"],
    ["bash -c \"$X\" /usr", "protected-path"],
  ])("%s denies by the command's own position", (command, rule) => {
    asNlh0(command, command);
    if (command === "bash -c 'cp x \"$1\"' y /etc/hosts") {
      expect(read(command), command).toMatchObject({ classification: "deny", rule });
      // S1-B3 RULING (MAIN 2026-11-11 09:30Z): the bound destination is a protected write.
      expectNoLimitsProtectedWrite(owner(command), command);
    } else denies(command, rule);
  });
});

describe("G3 M-STATEMENT: the per-statement recovery keeps a heredoc body and a function with their statement", () => {
  // no folder at all: a relative write is a closed-list doubt, so the recovery re-reads each statement on its own
  const heredoc = "cat <<EOF > cleanup-notes.md\nNever run rm -rf / on a server.\nEOF";
  const fn = "f(){ ls \"$1\"; }; f /; rm -rf build";
  it.each([[heredoc], [fn]])("%s runs with no folder known (the doubt alone is relieved on the owner's turn)", (command) => {
    asNlh0(command, command);
    nlh0(`owner-reads|${command}|nocwd`, alwaysAskCommand(command, undefined));
    expect(read(command, undefined), command).not.toMatchObject({ classification: "deny" });
    expect(owner(command, undefined), command).toMatchObject({ source: "no-limits" });
    runs(command);
  });
  it.each([
    ["cat <<EOF > notes.md\nhi\nEOF\nrm -rf ~", "delete-home"],
    ["cat <<EOF > notes.md\nhi\nEOF\ncat <<EOT\nx\nEOT\nrm -rf /usr", "delete-system-folder"],
    ["f(){ rm -rf \"$1\"; }; touch out; f /", "delete-root"],
  ])("a named catastrophe after them keeps its own name: %s", (command, rule) => {
    asNlh0(command, command);
    denies(command, rule, undefined);
    denies(command, rule);
  });
});

describe("RISK c M-FUNCTION: a function call is judged by its body (MARKS-r14 rule 8)", () => {
  it.each(["f(){ ls \"$1\"; }; f /", "f(){ ls \"$1\"; }; f /; rm -rf build", "g(){ :; }; g /"])("%s runs: the call reads, it writes nothing", (command) => {
    asNlh0(command, command);
    runs(command);
  });
  it.each([
    ["f(){ rm -rf \"$1\"; }; f /", "delete-root"],
    ["f(){ mytool \"$1\"; }; f /", "protected-path"],
    ["unknownprog /", "protected-path"],
  ])("%s denies by what the body or the program does", (command, rule) => {
    asNlh0(command, command);
    denies(command, rule);
  });
});

describe("RISK b M-TILDE: a quoted ~ is a literal file name, not the home folder", () => {
  it.each(["rm -rf '~'", "rm -rf \"~\"", "touch '~'", "rm -rf '~/x'"])("%s is a path in the work folder and runs on the owner's turn", (command) => {
    asNlh0(command, command);
    expect(owner(command), command).toMatchObject({ source: "no-limits" });
    expect(owner(command).approve).toBeTruthy();
    expect(read(command)?.rule, command).not.toBe("delete-home");
  });
  it("an unquoted ~ is the home folder", () => denies("rm -rf ~", "delete-home"));
});

describe("RISK a M-WHOLE-TOOL / M-WHOLE-TEXT: the whole command the reader is given", () => {
  const wholeCommandOf = auto.wholeCommandOf as typeof import("./auto-approve.ts").wholeCommandOf;
  it("a command tool's text and the turn's folder", () => {
    expect(wholeCommandOf("Bash", { command: "ls" }, "/turn")).toEqual({ commandText: "ls", commandCwd: "/turn" });
    expect(wholeCommandOf("Bash", { command: "ls" }, undefined)).toEqual({ commandText: "ls" });
  });
  it("a folder the call names wins; a folder that is not a usable path is invalid and never replaced by the turn's folder", () => {
    expect(wholeCommandOf("Bash", { command: "ls", cwd: "/named" }, "/turn")).toEqual({ commandText: "ls", commandCwd: "/named" });
    expect(wholeCommandOf("Bash", { command: "ls", cwd: 5 }, "/turn")).toEqual({ commandText: "ls", commandCwdInvalid: true });
  });
  it("M-WHOLE-TOOL: a tool that is not a command tool gives nothing, whatever its input holds", () => {
    expect(wholeCommandOf("Write", { command: "rm -rf ~", cwd: "/named" }, "/turn")).toEqual({});
    expect(wholeCommandOf("mcp__x__tool", { command: "rm -rf ~" }, "/turn")).toEqual({});
  });
  it("M-WHOLE-TEXT: a command tool whose input holds no command gives nothing, not an empty text", () => {
    expect(wholeCommandOf("Bash", { description: "no command here", cwd: "/named" }, "/turn")).toEqual({});
    expect(wholeCommandOf("Bash", undefined, "/turn")).toEqual({});
  });
});

describe("MARKS R1 (marks-accepted-additions-1018 rows): the same texts outside the owner's No limits turn read as NLH0", () => {
  it.each([`python3 -c 'open("/et"+"c/cron.d/pwn","w").write("x")'`, `python3 -c 'open("/e"+"tc"+"/passwd","w")'`, 'rm -rf "$X"', 'cp a "$OUT"', "perl -e 'unlink($x); mystery()'"])("%s", (command) => {
    nlh0(`accepted-additions|${command}`, alwaysAskCommand(command, "/w"));
  });
});

describe("MARKS R1 (nolimits-means-it N5 rows): the same texts outside the owner's No limits turn read as NLH0", () => {
  it.each([`python3 -c "import os; os.system('rm -rf /')"`, `node -e "require('child_process').execSync('rm -rf /')"`])("%s", (command) => {
    nlh0(`owner-reads|means-it-N5|${command}|read`, alwaysAskCommand(command, "/w"), undefined, { namedCatastrophe: true });
    nlh0(`owner-reads|means-it-N5|${command}|full`, autoVerdict(FULL, "Bash", command, turn(command)), undefined, T4_FULL[`means-it-N5|${command}`]);
  });
});
