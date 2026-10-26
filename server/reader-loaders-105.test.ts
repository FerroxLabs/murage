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

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");
const { autoVerdict } = await import("./auto-approve.ts");
const { classifyStopLine } = await import("./stop-line.ts");

const CWD = "/work/project";
const ASK = { autoApprove: false };
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS = { Ask: ASK, Auto: AUTO, "Full access": FULL, "No limits": NO_LIMITS } as const;
type Level = keyof typeof LEVELS;

const nix = (cwd: string) => ({ cwd, roots: [cwd, "/tmp"], home: "/home/tester", knownRecipients: new Set<string>(), realpath: (p: string) => posix.normalize(p) });
const verdict = (level: Level, cmd: string, cwd = CWD) =>
  autoVerdict(LEVELS[level], "Bash", cmd, { commandText: cmd, commandCwd: cwd, stopLine: classifyStopLine("Bash", { command: cmd }, "", nix(cwd)) });
const pwshVerdict = (level: Level, cmd: string) =>
  autoVerdict(LEVELS[level], "PowerShell", cmd, { commandText: cmd, commandCwd: "C:\\work" });
const everywhere = (cmd: string, cwd = CWD) => {
  for (const level of Object.keys(LEVELS) as Level[]) expect(verdict(level, cmd, cwd), `${level}: ${cmd}`).toMatchObject({ approve: null });
};

describe("code an interpreter loads first from a folder or a variable asks at every level (POSIX)", () => {
  it.each([
    // Grok r7 High 1: ruby -I, and RUBYLIB
    "ruby -I./evil -rjson /dev/null",
    "ruby -I ./evil -rjson /dev/null",
    "ruby -I./evil /dev/null",
    "RUBYLIB=./evil ruby -rjson /dev/null",
    // Grok r7 High 2: loader variables on the command
    "NODE_OPTIONS=--require=./evil.js node /dev/null",
    "RUBYOPT=-r./evil.rb ruby /dev/null",
    "PERL5OPT=-MEvil perl /dev/null",
    "PYTHONSTARTUP=./evil.py python /dev/null",
    "BASH_ENV=./evil.sh bash /dev/null",
    // the same variables set before, exported, through env, or by a name a value gives
    "export NODE_OPTIONS=--require=./evil.js; node /dev/null",
    "NODE_OPTIONS=--require=./evil.js; export NODE_OPTIONS; node -e 1",
    "env PYTHONPATH=./evil python -c 'print(1)'",
    "export BASH_ENV=./evil.sh && bash -c 'echo hi'",
    "declare -x PERL5OPT=-MEvil; perl -e 1",
    "n=NODE_OPTIONS; export \"$n=--require=./evil.js\"; node /dev/null",
    "LD_PRELOAD=./evil.so python3 /dev/null",
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
    "perl -wMEvil /dev/null",
    "ruby -wI./evil -rjson /dev/null",
    "ruby -wr./evil.rb /dev/null",
    "php -ndauto_prepend_file=./evil.php -r 'echo 1;'",
    "export $'NODE_OPT\\x49ONS'=--require=./evil.js; node /dev/null",
    "env $'NODE_OPT\\x49ONS=--require=./evil.js' node /dev/null",
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
    "python3 -c 'open(__import__(\"os\").path.expanduser(\"~\")+\"/.zshe\"+\"nv\",\"w\").write(\"x\")'; zsh -c true",
    "echo x > \"$HOME/.zshe\"nv; zsh -c true",
    "f=$(mktemp); echo x > \"$f\"; bash -lc true",
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
    expect(alwaysAskCommand(cmd, CWD)).toBeNull();
  });
  // Sean's relief: one script on disk, and the venv shapes, after a cd joined by `;` too
  it.each(["cd app; python manage.py runserver", "cd app && bash build.sh", "cd app; source .venv/bin/activate && python -m pytest", "bash build.sh"])("`%s` runs at Full access and No limits", (cmd) => {
    expect(alwaysAskCommand(cmd, CWD)).toMatchObject({ rule: "unreadable", unseenScript: true });
    expect(verdict("Full access", cmd).approve).toBeTruthy();
    expect(verdict("No limits", cmd).approve).toBeTruthy();
  });
  // integration of reader-hang with the wrapper read: an unseen script in the outer text never hides the command a wrapper carries
  it("an unseen script outside never covers a wipe inside Fuigo's use_tool wrapper", () => {
    const wrapped = (command: string) => ({
      tool: "other",
      summary: "bash build.sh",
      toolKind: "other",
      toolIdentity: { namespace: "fuigo_build", name: "use_tool", kind: "use_tool" },
      toolCall: { name: "bash build.sh", input: { variant: "UseTool", tool_name: "computer__computer_exec", tool_input: { command } } },
      mcpMounts: [{ engineName: "computer", mountId: "own:computer", provenance: "own" as const }],
    });
    for (const level of ["Full access", "No limits"] as const) {
      const held = autoVerdict(LEVELS[level], "other", "bash build.sh", { commandText: "bash build.sh", commandCwd: CWD, call: wrapped("sudo rm -rf /home") });
      expect(held, level).toMatchObject({ approve: null, source: "always-ask" });
      expect(held.rule, level).not.toBe("unreadable");
      const ok = autoVerdict(LEVELS[level], "other", "bash build.sh", { commandText: "bash build.sh", commandCwd: CWD, call: wrapped("ls -la") });
      expect(ok.source, level).not.toBe("always-ask");
    }
  });
});
