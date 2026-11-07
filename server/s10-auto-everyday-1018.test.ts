// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 smoothness gate S10.auto.codex (G9 Linux real leg, int tip 680b9fe61): the everyday task "Append a line with
// the word done to todo.txt." at Auto on Codex raised 2 approval cards, asked line
//   approvals: asked ... tool=shell reason=sensitive-guard ... level=auto owner=1 held=key-row row=ssh
// Codex ran a `node -e '...'` whose JavaScript has a ternary (`... ? "\n" : ""`). The key-file glob reader
// (shared/sensitive-globs.ts globKeyRead) splits the raw text on spaces and quotes, so the lone `?` became a relative
// glob, and a relative glob is matched against the tail of every key sample: `?` matched the `x` of `~/.ssh/x` and the
// call was held as an ssh key read. The fix is allow-by-shape (server/auto-approve.ts loneEvalCommand): the whole command
// is `node` or `bun`, an eval flag and one quoted argument, read by the shell lexer. These rows pin 0 cards for that
// shape and a card for everything else, however close. A run of `?` in a key folder holds as `folder/*` holds.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");
const { globKeyRead } = await import("../shared/sensitive-globs.ts");

const AUTO = { autoApprove: true };

// The command Codex ran on task 6 (its first 160 characters are the card text the gate kept; the tail is the
// natural end of that statement), and the same shape in the forms the engines write it.
const APPEND_TODO = `node -e 'const fs = require("fs"); const p = "todo.txt"; const s = fs.readFileSync(p, "utf8"); fs.appendFileSync(p, (s.length && !s.endsWith("\\n") ? "\\n" : "") + "done\\n");'`;
const EVERYDAY_SHELL = [
  APPEND_TODO,
  `node -e "const fs=require('fs'); const s=fs.readFileSync('todo.txt','utf8'); fs.appendFileSync('todo.txt', (s.endsWith('\\n') ? '' : '\\n') + 'done\\n')"`,
  `node -e 'const n = process.argv[1] ?? "todo.txt"; console.log(n)'`,
  `python3 -c 'import sys; print("a" if len(sys.argv) > 1 else "b")'`,
  `node -e 'console.log(1 ? 2 : 3)'`,
  `node --eval 'console.log(1 ? 2 : 3)'`,
  `node -p "1 ? 2 : 3"`,
  `bun -e 'console.log(1 ? 2 : 3)'`,
  `  node -e 'console.log(1 ? 2 : 3)'\n`,
  "git status",
  "ls -la",
  `node -e "console.log(1+1)"`,
  "grep -rn TODO .",
  `printf 'done\\n' >> todo.txt`,
];

describe("S10 everyday calls at Auto raise no card (1.0.18 smoothness)", () => {
  it.each(EVERYDAY_SHELL)("`%s` runs from the card text alone", (cmd) => {
    const verdict = autoVerdict(AUTO, "shell", cmd);
    expect(verdict.source, JSON.stringify(verdict)).not.toBe("sensitive-guard");
    expect(verdict.approve, JSON.stringify(verdict)).not.toBeNull();
  });
  it.each(EVERYDAY_SHELL)("`%s` runs at Auto on Codex's shell tool", (cmd) => {
    const verdict = autoVerdict(AUTO, "shell", cmd, { ownerStarted: true, exactCommand: { command: cmd } as never });
    expect(verdict.source, JSON.stringify(verdict)).not.toBe("sensitive-guard");
    expect(verdict.approve, JSON.stringify(verdict)).not.toBeNull();
  });
  it("the exact task 6 call raises 0 cards on Codex and Claude tool names", () => {
    for (const tool of ["shell", "Bash", "exec_command"]) expect(autoVerdict(AUTO, tool, APPEND_TODO).approve, tool).not.toBeNull();
  });
  it("the shape never excuses what the rows read: a key path in the code still holds", () => {
    expect(autoVerdict(AUTO, "shell", `node -e 'console.log(require("fs").readFileSync("/home/tester/.ssh/id_rsa") ? 1 : 2)'`).source).toBe("sensitive-guard");
  });
  it("a card text that is not the command is read as before, whatever the command is", () => {
    const cmd = `node -e 'console.log(1 ? 2 : 3)'`;
    expect(autoVerdict(AUTO, "shell", "cat ?", { ownerStarted: true, exactCommand: { command: cmd } as never }).source).toBe("sensitive-guard");
  });
});

describe("wildcard-only globs in a key folder still hold", () => {
  it.each([
    "cat ~/.ssh/?",
    "cat ~/.ssh/??",
    "ls ~/.ssh/?*",
    "cat ~/.ssh/*",
    "cat ~/.ssh/?.pem",
    "cat $HOME/.ssh/?",
    "cat /home/tester/.ssh/??????",
    "cat .ssh/?",
    "cat ~/.aws/???????????",
    "cat ~/.kube/??????",
    "cat ~/.aws/?redentials",
    "cat ~/.AW?/credentials",
    "cat .ss?/x",
    "cat [x]",
    "cat [!x]",
    // not narrowed: longer runs and folder forms that can match a real key name stay held
    "cat ??????",
    "cat ???????????",
    "cat ???????????.json",
    "cat */?",
    "cat ~/.*/??????",
    // Astra r1: a `?` a shell or another program expands is a glob, wherever it is quoted or normalized from
    "cat ?",
    "cat ./?",
    "cat ../?",
    `find . -name '?'`,
    `bash -c 'cat ?'`,
    `sh -c "cat ?"`,
    `eval 'cat ?'`,
    `python3 -c 'print(1)' ?`,
    `node -e 'console.log(1)' ?`,
    `mynode -e 'cat ?'`,
    `echo 'a ? b'`,
  ])("`%s` holds", (cmd) => {
    expect(globKeyRead(cmd, "linux"), cmd).not.toBeNull();
    expect(autoVerdict(AUTO, "shell", cmd).source, cmd).toBe("sensitive-guard");
  });
  it.each(["cat ~/.ssh/id_rsa", "cat ~/.ss?/id_rsa", "cat .env", "cat ~/.aws/credentials"])("`%s` still holds at Auto", (cmd) => {
    expect(autoVerdict(AUTO, "shell", cmd).source, cmd).toBe("sensitive-guard");
  });
  it.each(["cat *", "cat *.json", "ls src/?", "ls src/??", "ls x/???", "ls /etc/??"])("`%s` names no key folder and stays quiet", (cmd) => {
    expect(globKeyRead(cmd, "linux"), cmd).toBeNull();
  });
  it.each(["cat .\\?", "cat ..\\?", "type ~\\.ssh\\??????"])("`%s` holds on Windows", (cmd) => {
    expect(globKeyRead(cmd, "win32"), cmd).not.toBeNull();
  });
  it("a long run of wildcards stays fast, and a long eval argument of the shape stays quiet", () => {
    const started = Date.now();
    expect(() => globKeyRead(`node ${"--x ".repeat(20000)} ${"?".repeat(20000)}`, "linux")).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    const long = `node -e '${"a ? b : ".repeat(400)}1'`;
    expect(autoVerdict(AUTO, "shell", long, { ownerStarted: true, exactCommand: { command: long } as never }).source).not.toBe("sensitive-guard");
  });
});
