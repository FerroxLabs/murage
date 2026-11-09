// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5 r8: code an interpreter or a shell loads before its own program, from
// a folder or a variable the text names (`ruby -I`, `NODE_OPTIONS`, `RUBYOPT`,
// `PERL5OPT`, `PYTHONSTARTUP`, `BASH_ENV`), is a file the reader does not see.
// It asks at every level, whatever the program is, an empty one included, and
// the same under the POSIX and the PowerShell reader (server/shell/loaders.ts).
// A `cd` that may have failed leaves the folder unknown to what follows it.
// Fixture strings are inert data, never executed.
import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nlh0 } from "./testing/marks-nlh0.ts";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");
const { withoutDoubts, ownerMarks } = await import("./shell/marks.ts");
const { autoVerdict } = await import("./auto-approve.ts");
const { classifyStopLine } = await import("./stop-line.ts");

const CWD = "/work/project";
const ASK = { autoApprove: false };
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS = { Ask: ASK, Auto: AUTO, "Full access": FULL, "No limits": NO_LIMITS } as const;
type Level = keyof typeof LEVELS;

// 1.0.9 (NOLIMITS-NODE-109-CUT section 9): every named path an ordinary file and every `cd` target a folder; the
// on-disk cases are server/nolimits-node-109.test.ts
const STUB = { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => true }) };
const nix = (cwd: string) => ({ cwd, roots: [cwd, "/tmp"], home: "/home/tester", knownRecipients: new Set<string>(), realpath: (p: string) => posix.normalize(p) });
// r13 owner-started proof (auto-approve.ts ownerOwnTurn) plus a clean outside read (outsideRead null, as CLEAN in nolimits-means-it-1020): the helpers mean the owners own clean turn
const OWNER_TURN = { fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null } as const;
const verdict = (level: Level, cmd: string, cwd = CWD, proof: object = OWNER_TURN) =>
  autoVerdict(LEVELS[level], "Bash", cmd, { ...proof, commandText: cmd, commandCwd: cwd, stopLine: classifyStopLine("Bash", { command: cmd }, "", nix(cwd)), unseen: { fs: STUB, platform: "posix" } });
const pwshVerdict = (level: Level, cmd: string) =>
  autoVerdict(LEVELS[level], "PowerShell", cmd, { commandText: cmd, commandCwd: "C:\\work" });
const everywhere = (cmd: string, cwd = CWD) => {
  for (const level of Object.keys(LEVELS) as Level[]) expect(verdict(level, cmd, cwd), `${level}: ${cmd}`).toMatchObject({ approve: null });
};

// MARKS r14: the dummy script operand is ./noop, not /dev/null: a system device named as a script is a protected path now (D2-b), and these rows test the loader finding
describe("code an interpreter loads first from a folder or a variable asks at every level (POSIX)", () => {
  it.each([
    // Grok r7 High 1: ruby -I, and RUBYLIB
    "ruby -I./evil -rjson ./noop",
    "ruby -I ./evil -rjson ./noop",
    "ruby -I./evil ./noop",
    "RUBYLIB=./evil ruby -rjson ./noop",
    // Grok r7 High 2: loader variables on the command
    "NODE_OPTIONS=--require=./evil.js node ./noop",
    "RUBYOPT=-r./evil.rb ruby ./noop",
    "PERL5OPT=-MEvil perl ./noop",
    "PYTHONSTARTUP=./evil.py python ./noop",
    "BASH_ENV=./evil.sh bash ./noop",
    // the same variables set before, exported, through env, or by a name a value gives
    "export NODE_OPTIONS=--require=./evil.js; node ./noop",
    "NODE_OPTIONS=--require=./evil.js; export NODE_OPTIONS; node -e 1",
    "env PYTHONPATH=./evil python -c 'print(1)'",
    "export BASH_ENV=./evil.sh && bash -c 'echo hi'",
    "declare -x PERL5OPT=-MEvil; perl -e 1",
    "n=NODE_OPTIONS; export \"$n=--require=./evil.js\"; node ./noop",
    "LD_PRELOAD=./evil.so python3 ./noop",
    "ZDOTDIR=./evil zsh -c 'echo hi'",
    "PHPRC=./evil php -r 'echo 1;'",
    // a loader variable set after the call is still read as set
    "node -e 1; export NODE_OPTIONS=--require=./evil.js",
    // Grok r8 design round 1
    "HOME=./evil zsh -c 'echo hi'",
    "HOME=./evil python3 -c 'print(1)'",
    "XDG_CONFIG_HOME=./evil fish -c 'echo hi'",
    "LUA_INIT=@./evil.lua lua -e 'print(1)'",
    "R_PROFILE_USER=./evil.R Rscript -e '1'",
    "Rscript -e '1'",
    "python3 -m runpy tool.py",
    "python3 -m pdb tool.py",
    "python3 -mtrace --run tool.py",
    "perl -wMEvil ./noop",
    "ruby -wI./evil -rjson ./noop",
    "ruby -wr./evil.rb ./noop",
    "php -ndauto_prepend_file=./evil.php -r 'echo 1;'",
    "export $'NODE_OPT\\x49ONS'=--require=./evil.js; node ./noop",
    "env $'NODE_OPT\\x49ONS=--require=./evil.js' node ./noop",
    "node -e 1 -r ./evil.js",
    // a startup file the text itself writes, then a shell or an interpreter that reads it
    "printf 'rm -rf ~' > ~/.zshenv; zsh -c 'echo hi'",
    "echo 'x' >> ~/.bashrc && bash -ic 'echo hi'",
    "cp ./evil.py ~/.local/lib/python3.12/site-packages/usercustomize.py; python3 -c 'print(1)'",
    // Grok r8 design round 2
    "echo 'echo PWNED' > ~/.zshe\\nv; zsh -c 'echo hi'",
    "echo 'echo PWNED' > ~/.bash_pro'file'; bash -lc 'echo hi'",
    "echo 'echo PWNED' > ~/.config/fish/confi\\g.fish; bash -c 'echo hi'",
    "lua -l evil -e 'print(1)'",
    "luajit -levil",
    "php -r 'echo 1;' --define auto_prepend_file=./evil.php",
    "php --php-ini=./evil.ini -r 'echo 1;'",
    "bun -e 'console.log(1)' -r ./evil.js",
    // Grok lanereview r8
    "ruby -wI./evil -rjson -e 'puts 1'",
    "ruby -wr./evil.rb -e 'puts 1'",
    "php -B 'echo 1;'",
    "echo x > \"$HOME/.zshe\"nv; zsh -c true",
    "PS0='$(touch /tmp/owned)' bash -ic 'echo hi'",
    "PS1='$(touch /tmp/owned)' zsh -ic 'echo hi'",
    // 1.0.5 r8c: any ruby bundle with I or r asks
    "ruby -WI./evil -rjson -e 'puts 1'",
    "ruby -W2r./x.rb -e 'puts 1'",
    "ruby -T1I./evil -e 'puts 1'",
    "ruby -KuI./evil -e 'puts 1'",
    "ruby -wI./evil -e 'puts 1'",
  ])("`%s`", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toMatchObject({ rule: "unreadable" });
    expect(alwaysAskCommand(cmd, CWD)?.unseenScript).toBeUndefined();
    everywhere(cmd);
  });
});

describe("code an interpreter loads first asks at every level (PowerShell)", () => {
  it.each([
    // Grok r7 High 3: the PowerShell reader skipped these flags
    "node --require=./evil.js",
    "node -r ./evil.js",
    "ruby -r ./evil.rb",
    "ruby -I./evil -rjson",
    "perl -MEvil",
    "php -dauto_prepend_file=./evil.php",
    "python -m runpy tool.py",
    "Rscript -e 1",
    "perl -wMEvil",
    "lua -l evil",
    "$env:NODE_OPT`IONS='--require=./evil.js'; node",
    // a loader variable set in PowerShell
    "$env:NODE_OPTIONS = '--require=./evil.js'; node -v",
    "$n = 'NODE_OPTIONS'; [Environment]::SetEnvironmentVariable($n, '--require=./evil.js'); node -v",
  ])("`%s`", (cmd) => {
    expect(alwaysAskCommand(cmd, "C:\\work", "command", "pwsh")).toMatchObject({ rule: "unreadable" });
    for (const level of Object.keys(LEVELS) as Level[]) expect(pwshVerdict(level, cmd), `${level}: ${cmd}`).toMatchObject({ approve: null });
  });
});

describe("a cd that may have failed leaves the folder unknown", () => {
  // Grok r7 Medium: a failed `cd` leaves the shell where it was (`/`), and
  // `proc/self/fd/0` is then the shell's own input
  it.each(["cd /no/such; bash proc/self/fd/0", "cd /no/such || bash proc/self/fd/0", "cd /no/such\nbash proc/self/fd/0", "cd /no/such; . proc/self/fd/0"])("`%s` from / asks at every level", (cmd) => {
    expect(alwaysAskCommand(cmd, "/")?.unseenScript).toBeUndefined();
    everywhere(cmd, "/");
  });
});

describe("what stays as it was", () => {
  it.each([
    "ruby -rjson -e 'puts 1'",
    "node -v",
    "python3 -c 'print(1)'",
    "PYTHONPATH=src pytest -q",
    "echo $NODE_OPTIONS",
    "export NODE_ENV=production && npm run build",
    "cd /tmp && rm -rf build",
    "python3 -m venv .venv",
    "python -m http.server 8000",
    "Rscript --vanilla -e 1",
    "perl -we 'print 1'",
    "echo $HOME && python3 -c 'print(1)'",
    "python3 -c 'print(1)'; python3 -c 'print(2)'",
    "ruby -w -e 'puts 1'",
  ])("`%s` is an ordinary command", (cmd) => {
    // MARKS r11: the doubt-free read (Full access, and the owner's own No limits turn) is b18's; the strict read may only add a
    // closed-list doubt, never a named rule
    expect(withoutDoubts(() => alwaysAskCommand(cmd, CWD))).toBeNull();
    const strict = alwaysAskCommand(cmd, CWD);
    if (strict) expect(strict, cmd).toMatchObject({ rule: "unreadable", doubt: expect.any(String) });
  });
  // Sean's relief: one script on disk, and the venv shapes, after a cd joined by `;` too
  // 1.0.9: the `cd` names its folder `./…` and is joined with `&&` (NOLIMITS-NODE-109-CUT R3)
  it.each(["cd ./app && python manage.py runserver", "cd ./app && bash ./build.sh", "cd ./app && source .venv/bin/activate && python -m pytest", "bash ./build.sh"])("`%s` runs at Full access and No limits", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD, "command", undefined, undefined, undefined, { fs: STUB, platform: "posix" })).toMatchObject({ rule: "unreadable", unseenScript: true });
    expect(verdict("Full access", cmd).approve).toBeTruthy();
    expect(verdict("No limits", cmd).approve).toBeTruthy();
  });
  // integration of reader-hang with the wrapper read: an unseen script in the outer text never hides the command a wrapper carries
  it("an unseen script outside never covers a wipe inside Fuigo's use_tool wrapper", () => {
    const wrapped = (command: string) => ({
      tool: "other",
      summary: "bash ./build.sh",
      toolKind: "other",
      toolIdentity: { namespace: "fuigo_build", name: "use_tool", kind: "use_tool" },
      toolCall: { name: "bash ./build.sh", input: { variant: "UseTool", tool_name: "computer__computer_exec", tool_input: { command } } },
      mcpMounts: [{ engineName: "computer", mountId: "own:computer", provenance: "own" as const }],
    });
    for (const level of ["Full access", "No limits"] as const) {
      const held = autoVerdict(LEVELS[level], "other", "bash ./build.sh", { commandText: "bash ./build.sh", commandCwd: CWD, call: wrapped("sudo rm -rf /home") });
      expect(held, level).toMatchObject({ approve: null, source: "always-ask" });
      expect(held.rule, level).not.toBe("unreadable");
      const ok = autoVerdict(LEVELS[level], "other", "bash ./build.sh", { ...OWNER_TURN, commandText: "bash ./build.sh", commandCwd: CWD, call: wrapped("ls -la"), unseen: { fs: STUB, platform: "posix" } });
      expect(ok.source, level).not.toBe("always-ask");
    }
  });
});

describe("MARKS r13 owner-started proof (fail-closed)", () => {
  it("an unseen script runs at No limits on an owner-started turn and asks without the proof", () => {
    expect(verdict("No limits", "bash ./build.sh").approve).toBeTruthy();
    for (const missing of [{}, { fullAccessOrigin: "owner", ownerStarted: true }, { ownerStarted: false, fullAccessOrigin: "owner" }, { ownerStarted: true, fullAccessOrigin: "other" }]) {
      expect(verdict("No limits", "bash ./build.sh", CWD, missing).approve).toBeNull();
    }
  });
});

// MARKS r14: two rows that used to ask now deny, by authorised spec rows (MARKS-r14 section 3): FD4 (a write target the
// code computes cannot be read, unsupported executable code is a hard finding) and D1-a (an unresolved write target is
// no fixed binding). A deny never runs at any level and never shows an Allow card; they stay in this file as the
// fail-closed pair of the loader rows above.
describe("a computed or unresolved write target before a startup-file reader is a hard deny (FD4, D1-a)", () => {
  it.each([
    "python3 -c 'open(__import__(\"os\").path.expanduser(\"~\")+\"/.zshe\"+\"nv\",\"w\").write(\"x\")'; zsh -c true",
    "f=$(mktemp); echo x > \"$f\"; bash -lc true",
  ])("`%s`", (cmd) => {
    // R1 (G5): outside the owner's clean No limits turn the plain read is NLH0's (pinned); the rows below state the owner's read
    nlh0(`reader-loaders-105|${cmd}|read`, alwaysAskCommand(cmd, CWD));
    if (cmd.startsWith("f=$(mktemp)")) {
      // FIX A migration (ruling (ii), coordinator 11-08): a plain write to a value-only temp path is no delete/disk/mirror verb and
      // names no protected path: a could-not-read (card at Full access and elsewhere), waived on the owner's clean No limits turn
      expect(ownerMarks(() => alwaysAskCommand(cmd, CWD))).toMatchObject({ classification: "ask", couldNotRead: true });
      const at = (bot: Record<string, unknown>) => autoVerdict(bot as never, "Bash", cmd, { commandText: cmd, commandCwd: CWD, workFolder: CWD, fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as never);
      expect(at({ id: "x", autoApprove: true, fullAccess: true })).toMatchObject({ approve: null, source: "always-ask" });
      expect(at({ id: "x", autoApprove: true, fullAccess: true, noLimits: true }).approve).toBeTruthy();
      return;
    }
    expect(ownerMarks(() => alwaysAskCommand(cmd, CWD))).toMatchObject({ classification: "deny" });
    everywhere(cmd);
  });
});
