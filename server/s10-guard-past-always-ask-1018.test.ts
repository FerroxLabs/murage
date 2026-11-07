// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 smoothness S10, allow-by-shape: only `node` or `bun`, an eval flag and one quoted argument, as the whole
// command, leaves the key-file glob read. Some calls that miss the shape are carded by the always-ask reader before the
// key guard is reached, so a row that sees "a card" can't tell which of the two raised it. Here the always-ask reader
// finds nothing, at Auto, so the only thing left that can hold these calls is the key guard itself.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

vi.mock("./always-ask.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./always-ask.ts")>();
  return { ...real, alwaysAskCommand: () => null, alwaysAskRoutineCommand: () => ({ hit: null }) };
});

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");

const AUTO = { autoApprove: true };

const OFF_SHAPE = [
  // not one quoted argument
  `node script.js ?`,
  `node -e a ? b`,
  `node -e 'a ? b`,
  `node -e 'console.log(1)' ?`,
  `node -e 'a ? b' extra`,
  `node -e 'a ? b' ;`,
  `node -e 'a ? b' # note`,
  // adjacent pieces (Astra r2)
  `node -e 'const cmd="cat ?"; '"require('child_process').execSync(cmd,{stdio:'inherit'})"`,
  `node -e 'a ? b'"c"`,
  `node -e 'a ? b'c`,
  `node -e "a ? b"'c'`,
  // Astra r3: the lexer folds these into one piece
  `node -e 'console.log(1 ? 2 : 3)'';'`,
  `node -e "a ? b""c"`,
  `node -e 'a'' ? b'`,
  `node -e $"cat ?"`,
  `node -e $'a ? b'`,
  // expansion in or around the argument
  `node -e "$(cat ?)"`,
  `node -e "console.log(\`cat ?\`)"`,
  `node -e "$X ? b"`,
  // more than the one command
  `node -e 'x'; cat ?`,
  `cd src && node -e 'a ? b : c'`,
  `node -e 'a ? b' | cat`,
  `node -e 'a ? b' > out.txt`,
  `node -e 'a ? b'\ncat ?`,
  `FOO=1 node -e 'a ? b'`,
  `(node -e 'a ? b')`,
  // quotes that don't pair as they look
  `echo ' node -e ' ? ' x'`,
  `cat ' node -e ' ? ' '`,
  `echo $'\\' node -e ' ? ' x'`,
  `echo ok # it's\ncat ' node -e ' ? ' '`,
  `cat <<EOF\nit's\nEOF\ncat ' node -e ' ? ' '`,
  `node --x=' -e ' ? '`,
  `echo \\' node -e ' ? '`,
  // not exactly the program and the flag
  `/usr/bin/node -e 'a ? b'`,
  `nodejs -e 'a ? b'`,
  `mynode -e 'cat ?'`,
  `'node' -e 'a ? b'`,
  `node '-e' 'a ? b'`,
  `node --input-type=module -e 'a ? b'`,
  `node -x 'a ? b'`,
  // code that names a way to start a shell or expand a glob
  `node -e 'require("child_process").execSync("cat ?")'`,
  `node -e 'require("child"+"_process")["ex"+"ecSync"]("cat ?")'`,
  `node -e 'import("node:ch"+"ild_process").then(x => x ? 1 : 2)'`,
  `node -e 'process.binding("spawn_sync") ? 1 : 2'`,
  `node -e 'Function("return 1")() ? 1 : 2'`,
  `node -e 'a.spawn("cat ?")'`,
  `node -e 'a.fork("cat ?")'`,
  `node -e 'fs.globSync("?")'`,
  `bun -e 'Bun.spawn(["sh", "-c", "cat ?"])'`,
];

describe("the key guard alone holds every `?` call off the shape", () => {
  it.each(OFF_SHAPE)("`%s`, card text only", (cmd) => {
    const verdict = autoVerdict(AUTO, "shell", cmd);
    expect(verdict.approve, JSON.stringify(verdict)).toBeNull();
    expect(verdict.source, JSON.stringify(verdict)).toBe("sensitive-guard");
  });
  it.each(OFF_SHAPE)("`%s`, the engine's own command", (cmd) => {
    const verdict = autoVerdict(AUTO, "shell", cmd, { ownerStarted: true, exactCommand: { command: cmd } as never });
    expect(verdict.approve, JSON.stringify(verdict)).toBeNull();
    expect(verdict.source, JSON.stringify(verdict)).toBe("sensitive-guard");
  });
  // PowerShell ends a string at a curly quote and a backslash escapes nothing there, so what bash reads as one quoted
  // argument PowerShell may not. The bash reading of each row is the shape; on the PowerShell tool it keeps the glob read.
  it.each([`node -e 'a’ ? b'`, `node -e 'a‘ ? b'`, `node -e "a” ? b"`, `node -e "a“ ? b"`, `node -e "a\\" ? b"`])("`%s` is the shape in bash and holds on PowerShell", (cmd) => {
    expect(autoVerdict(AUTO, "shell", cmd).source, cmd).not.toBe("sensitive-guard");
    for (const context of [undefined, { ownerStarted: true, exactCommand: { command: cmd } as never }]) {
      const verdict = autoVerdict(AUTO, "PowerShell", cmd, context);
      expect(verdict.approve, JSON.stringify(verdict)).toBeNull();
      expect(verdict.source, JSON.stringify(verdict)).toBe("sensitive-guard");
    }
  });
  it("the same shape with no such character passes the guard on PowerShell too", () => {
    const verdict = autoVerdict(AUTO, "PowerShell", `node -e 'a ? b'`);
    expect(verdict.source, JSON.stringify(verdict)).not.toBe("sensitive-guard");
  });
  it("the shape itself passes the guard, so the rows above are the shape's edge and not a guard that always holds", () => {
    const verdict = autoVerdict(AUTO, "shell", `node -e 'a ? b'`);
    expect(verdict.source, JSON.stringify(verdict)).not.toBe("sensitive-guard");
    expect(verdict.approve, JSON.stringify(verdict)).not.toBeNull();
  });
});
