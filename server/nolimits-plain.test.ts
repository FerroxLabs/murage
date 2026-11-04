// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-UNREADABLE r3, 1.0.16 (the structural rule): on a No limits turn the owner started, a command the reader
// could not follow runs only when every command word and every argument that could name a file is a plain literal.
// The rule is structural, so every fixture here is a harmless stand-in (echo, cat, ls of a notes file); none is run.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");
const { narrowHold, runnerShapeIn, unplainIn, unplainScan } = await import("./shell/hiding.ts");
const { wipeWordIn } = await import("./shell/wipe-words.ts");
const { alwaysAskCommand } = await import("./always-ask.ts");

const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null } as const;
const shell = (cmd: string) => autoVerdict(NO_LIMITS, "Bash", cmd, { ...OWNER, commandText: cmd });
const ps = (cmd: string) => autoVerdict(NO_LIMITS, "PowerShell", cmd, { ...OWNER, commandText: cmd });
/** A reader failure that is not itself a hiding construct (indirect expansion in a printed argument). */
const F = "echo ${!x}; ";
const ASKS = { approve: null, source: "always-ask", rule: "unreadable", reader: "hides" };

describe("a command word or a file argument that is not a plain literal asks", () => {
  it.each<[string, string[]]>([
    ["a variable glued into a command word", ["ec$x hello"]],
    ["brace expansion in a command word", ["ca{t,t} notes.txt"]],
    ["a command substitution building a command word", ["$(printf ec)ho hi", "coproc $(printf ec)ho hi"]],
    ["another user's home folder", ["cat ~bob/notes.txt"]],
    ["a glob in a file argument", ["ls [ab]*.txt"]],
    ["the braced self name as the command word", ["${0} hi", "coproc ${0} hi"]],
    ["a file path built from variables", ['cat "$HOME/$f"']],
  ])("%s", (_name, cmds) => {
    for (const cmd of cmds) {
      expect(unplainIn(cmd), cmd).not.toBeNull();
      const verdict = shell(F + cmd);
      expect(verdict, cmd).toMatchObject(ASKS);
      expect(verdict.note, cmd).toContain("written in a way that hides what it runs");
    }
  });
  it("a PowerShell call operator on a built string", () => {
    expect(unplainIn('& ("ec"+"ho") hi', "pwsh")).toBe("pwsh-call");
    // MurageMain ruling (r3d): the rule is POSIX only in 1.0.16; a PowerShell text is read as in 1.0.15
    expect(ps('& ("ec"+"ho") hi')).toMatchObject({ approve: expect.stringContaining("no limits"), rule: "held=unread" });
    expect(shell(F + '"${cmd}ho" hi')).toMatchObject(ASKS);
  });
  it("names what kept the card by a fixed kind", () => {
    expect(unplainIn("ec$x hello")).toBe("unplain-command");
    expect(unplainIn('cat "$HOME/$f"')).toBe("unplain-path");
    expect(unplainIn("cat notes.txt > ~bob/out.txt")).toBe("unplain-path");
    expect(unplainIn("bash -c 'ca{t,t} notes.txt'")).toBe("unplain-command");
    expect(unplainIn("printf '%s\\n' notes.txt | xargs -I@ @ hi")).toBe("data-runner");
  });
});

describe("plain literal commands, and expansions in printed arguments, run", () => {
  it.each(["echo $HOME", "echo ${!x}", "echo {1..3} $(date)", "ls ~/notes && cat notes.txt 2>&1 | head -5", "for f in a b; do echo \"$f\"; done"])("runs: %s", (cmd) => {
    expect(unplainIn(cmd)).toBeNull();
    expect(shell(cmd.startsWith("echo ${!x}") ? cmd : F + cmd)).toMatchObject({ approve: expect.stringContaining("no limits"), rule: "held=unread" });
  });
});

describe("a disk glob reads `^` as `!` inside a bracket class", () => {
  it("`/[^x]ev/` can name the device folder as `/[!x]ev/` can", () => {
    expect(wipeWordIn("ls /[!x]ev/null")).toMatchObject({ kind: "disk" });
    expect(wipeWordIn("ls /[^x]ev/null")).toMatchObject({ kind: "disk" });
    expect(wipeWordIn("ls /^ev/null")).toBeNull();
  });
});

// MurageMain ruling, 1.0.16 r3 ("resolve, then check"): a variable in a file argument is plain when every value it can
// take is known from the same text; each value is substituted and the resolved text gets the existing checks
describe("resolve, then check", () => {
  it.each([
    ["a for-loop over literal words", 'for f in a.md b.md; do cat "$f"; done; echo ${!x}'],
    ["an assignment from a literal", 'D=notes; cat "$D/a.md" > "$D/b.md"; echo ${!x}'],
    ["a function argument every call site passes as a literal", 'show() { cat "$1.md"; }\nshow a\nshow b\necho ${!x}'],
    ["an unchanged $HOME", 'cat "$HOME/notes/a.md"; echo ${!x}'],
    ["an unchanged $PWD", 'cat "$PWD/notes/a.md"; echo ${!x}'],
  ])("runs: %s", (_name, cmd) => {
    expect(unplainIn(cmd), cmd).toBeNull();
    expect(shell(cmd), cmd).toMatchObject({ approve: expect.stringContaining("no limits"), rule: "held=unread" });
  });
  it("builds one text per value, each read replaced", () => {
    expect(unplainScan('for f in a.md b.md; do cat "${f%.md}.txt"; done').resolved).toEqual(['for f in a.md b.md; do cat "a.txt"; done', 'for f in a.md b.md; do cat "b.txt"; done']);
    expect(unplainScan('cat "$HOME/proj/a.md"').resolved).toEqual(['cat "/home/tester/proj/a.md"']);
  });
  it.each([
    ["a variable read from a command's output", 'D=$(pwd); cat "$D/notes.txt"; echo ${!x}'],
    ["a loop over a command's output", 'for f in $(ls); do cat "$f"; done; echo ${!x}'],
    ["a literal the text changes later", 'D=notes.md; read -r D; cat "$D"; echo ${!x}'],
    ["a literal assigned after the start", 'echo ${!x}; D=notes.md; cat "$D"'],
    ["a positional read outside any function", 'cat "$1.md"; echo ${!x}'],
    ["a function called with a variable", 'show() { cat "$1.md"; }\nshow "$y"\necho ${!x}'],
    ["$PWD after a cd", 'cd notes && cat "$PWD/a.md"; echo ${!x}'],
    ["a changed $HOME", 'HOME=/tmp; cat "$HOME/a.md"; echo ${!x}'],
    ["a name a builtin may write at run time", 'D=notes.md; printf -v "$(echo C | tr ABC BCD)" %s x; cat "$D"; echo ${!x}'],
    ["a name arithmetic may write", 'D=notes.md; (( $(echo C | tr ABC BCD)=1 )); cat "$D"; echo ${!x}'],
    ["a sourced file", 'D=notes.md; . ./env.sh; cat "$D"; echo ${!x}'],
  ])("asks: %s", (_name, cmd) => {
    expect(unplainIn(cmd), cmd).not.toBeNull();
    expect(shell(cmd), cmd).toMatchObject(ASKS);
  });
  // stand-in protected paths from the gate fixtures (nolimits-means-it "gate files ask"); `cat` only reads
  it.each([
    'D=.ssh; cat "$HOME/$D/config"; echo ${!x}',
    'for f in notes.md .zshrc; do cat "$HOME/$f"; done; echo ${!x}',
    'show() { cat "$HOME/$1"; }\nshow .zshrc\necho ${!x}',
  ])("a resolved value that names a protected file asks: %s", (cmd) => {
    expect(unplainIn(cmd), cmd).toBeNull();
    expect(shell(cmd).approve, cmd).toBeNull();
  });
});

// MurageMain ruling (a), 1.0.16 r3: a double-quoted `$(…)` as the value of a data option runs when its own commands pass
// the same rule (a literal command word, literal or resolved paths, and the key, startup-file, wipe and disk checks)
describe("a command substitution in a data argument", () => {
  it.each([
    'imagegen create --prompt "$(cat notes/a.txt)" --json > out/a.json',
    'imagegen create --prompt="$(cat notes/a.txt)" --json',
    'run() { imagegen create --prompt "$(cat "notes/$1.txt")" > "out/$1.json"; }\nrun a &\nrun b &\nwait',
    'imagegen create --message "$(head -5 "$HOME/notes/a.txt")"',
  ])("runs: %s", (cmd) => {
    expect(unplainIn(F + cmd), cmd).toBeNull();
    expect(shell(F + cmd), cmd).toMatchObject({ approve: expect.stringContaining("no limits"), rule: "held=unread" });
  });
  it.each([
    ["the inner command reads a protected stand-in", 'imagegen create --prompt "$(cat ~/.ssh/config)"'],
    ["the inner command reads a protected stand-in through a resolved name", 'D=.ssh; imagegen create --prompt "$(cat "$HOME/$D/config")"'],
  ])("asks: %s", (_name, cmd) => {
    expect(shell(F + cmd).approve, cmd).toBeNull();
  });
  it.each([
    ["unquoted, so its output splits into words", "imagegen create --prompt $(cat notes/a.txt)"],
    ["as a file argument", 'cat "$(cat list.txt)"'],
    ["as the value of an option that is not a data option", 'imagegen create --out "$(cat list.txt)"'],
    ["with an inner command word the text does not spell", 'imagegen create --prompt "$(ca$x notes/a.txt)"'],
    ["with an inner path the text does not give", 'imagegen create --prompt "$(cat "$y")"'],
    ["as the command word", '"$(cat list.txt)" --prompt hi'],
  ])("asks: %s", (_name, cmd) => {
    expect(unplainIn(F + cmd), cmd).not.toBeNull();
    expect(shell(F + cmd), cmd).toMatchObject(ASKS);
  });
});

// MurageMain ruling (c): the readable path already checks a protected path reached through a glob or a variable
describe("the readable path checks protected stand-ins behind a glob or a variable", () => {
  it.each(["cat ~/.ssh/*", 'cat "$HOME/.zshrc"', "cat $HOME/.ssh/config", 'for f in .zshrc; do cat ~/"$f"; done'])("asks: %s", (cmd) => {
    expect(alwaysAskCommand(cmd)?.readerFailed, cmd).not.toBe(true);
    expect(shell(cmd).approve, cmd).toBeNull();
  });
  // MurageMain ruling (c): a glob, a brace or a variable in a path asks when it could reach a protected place
  it.each([
    "cat ~/.ss?/config", "cat ~/.zsh*", 'D=.ssh; cat "$HOME/$D/config"', "cat ~/.[s]sh/config",
    "cat .[s]sh/config", "cat .ss?/config", "ls .*", "cat [.]ssh/config", "cat {notes,.ssh}/config", "cat {notes,~}/a.md",
    "ls ~/notes/*.md", 'ls "$HOME"/notes/*.md', "cat /etc/*.conf", "ls /Library/*/a.txt", "cat ../*.txt",
    'cat "$x"', 'cat "notes/$f"', 'cat "a$f"', "cat ~bob/notes.txt > out.txt", "shopt -s dotglob; cat */config",
    "cd ~/.ssh && cat *", "cd / && cat etc/*", "cd && cat */a.txt", 'for f in .z*; do cat "$f"; done',
    'for f in *.md; do cat "$HOME/$f"; done', "cat /[e]tc/*.conf", "ls /?ar/*", "cat //etc/*.conf", "cat /./etc/*.conf",
    "cat /ETC/*.conf", "cat /x/../etc/*.conf", 'for f in a*; do cat "${f#a}/config"; done',
  ])("asks: %s", (cmd) => {
    expect(shell(cmd).approve, cmd).toBeNull();
  });
  it.each(["cat ~/.ss?/config", "cat ~/.zsh*", 'D=.ssh; cat "$HOME/$D/config"', "cat ~/.[s]sh/config", "ls ~/notes/*.md", 'cat "$x"', "cat ../*.txt"])("asks on the readable path: %s", (cmd) => {
    expect(alwaysAskCommand(cmd)?.readerFailed, cmd).not.toBe(true);
    expect(shell(cmd).approve, cmd).toBeNull();
  });
  it.each(["ls *.txt", "cat ./*.txt", "cat src/*.ts", "ls notes/{a,b}.md", "cd src && ls *.ts", 'for f in *.md; do cat "$f"; done', 'D=notes; cat "$D"/*.md'])("runs: %s", (cmd) => {
    expect(alwaysAskCommand(cmd)?.readerFailed, cmd).not.toBe(true);
    expect(shell(cmd).approve, cmd).toContain("no limits");
  });
});

// MurageMain ruling (1), 1.0.16 r3: a cd or pushd reached through any wrapper is a cd; after a cd to a protected place,
// or to one the text does not give, every later relative path counts as under that place
describe("a directory change, however it is reached", () => {
  it.each([
    "command cd /etc && cat *.conf", "builtin cd ~/.ssh; cat *", "exec cd /etc; ls *", "env cd /etc && cat *.conf",
    "nohup cd /etc && cat *.conf", "time cd /etc; cat *.conf", "sudo -u x cd /etc && cat *.conf", "command pushd /etc && cat *.conf",
    "env -i FOO=1 command cd /etc && cat *.conf", "builtin cd .. && cat */config", "env -C ~/.ssh cat config",
    "cd ~/.ssh && cat config", "command cd ~/.ssh && printf x >> config", "cd /etc; printf x >> profile", "cd - && cat notes.txt",
    "popd && cat notes.txt", "pushd +1 && cat notes.txt", "CDPATH=x cd notes && cat a.md", "cd ~ && cat .zshrc",
    "HOME=/x command cd && cat .zshrc", "f() { cat config; }; cd ~/.ssh; f", "~/.ssh; cat config",
  ])("asks: %s", (cmd) => {
    expect(alwaysAskCommand(cmd)?.readerFailed, cmd).not.toBe(true);
    expect(shell(cmd).approve, cmd).toBeNull();
  });
  // zsh's noglob is a word the reader does not model, so this text is unreadable; it asks there
  it("noglob cd is an unreadable text that asks", () => {
    expect(alwaysAskCommand("noglob cd ~/.ssh; cat config")?.readerFailed).toBe(true);
    expect(shell("noglob cd ~/.ssh; cat config").approve).toBeNull();
  });
  it("a wrapped cd to a protected place counts on the unreadable path too", () => {
    expect(unplainIn(F + "command cd ~/.ssh && cat *")).not.toBeNull();
    expect(shell(F + "command cd ~/.ssh && cat config").approve).toBeNull();
  });
  it.each(["command cd src && ls *.ts", "cd notes && cat a.md", "cd ~/proj && npm test", "time cd src; cat a.md"])("runs: %s", (cmd) => {
    expect(alwaysAskCommand(cmd)?.readerFailed, cmd).not.toBe(true);
    expect(shell(cmd).approve, cmd).toContain("no limits");
  });
});

// MurageMain ruling (2), 1.0.16 r3: a glob that could reach a protected place asks in any position
describe("a reaching glob asks wherever it stands", () => {
  it.each([
    'for f in /etc/*; do echo "$f"; done', "for f in ~/.ssh/*; do echo x; done", "select f in ~/.ss?/*; do break; done",
    "X=~/.ssh/*; echo hi", "X=/etc/*.conf echo hi", "echo ~/.ssh/*", "echo x > ~/.ss?/config", "[[ -e ~/.ssh/* ]]",
    'case "$1" in ~/.ssh/*) echo x;; esac',
  ])("asks: %s", (cmd) => {
    expect(alwaysAskCommand(cmd)?.readerFailed, cmd).not.toBe(true);
    expect(shell(cmd).approve, cmd).toBeNull();
    expect(unplainIn(F + cmd), cmd).not.toBeNull();
  });
  it.each(['for f in *.md; do echo "$f"; done', "X=*.txt; echo hi", "echo *.txt", "for i in {1..3}; do echo $i; done"])("runs: %s", (cmd) => {
    expect(shell(cmd).approve, cmd).toContain("no limits");
  });
});

// MurageMain ruling (d): `local x="$1"` / `x="$1"` in a function follows the positional argument to its call sites
describe("a function name bound to its argument", () => {
  const SHAPE_1102 = 'run() {\n  local name="$1" ratio="$2"\n  imagegen create --prompt "$(cat "out/$name.txt")" --aspect "$ratio" --json > "out/$name.json" 2> "out/$name.err"\n  echo "$name exit:$?"\n}\nrun 01-a 3:4 &\nrun 02-b 2:3 &\nwait\nls -la out';
  it.each([
    ["Sean's 11-02 shape, called with literals", SHAPE_1102],
    ["a plain x=\"$1\" binding", 'show() { stem="$1"; cat "notes/$stem.md"; }\nshow a\nshow b'],
  ])("runs: %s", (_name, cmd) => {
    expect(unplainIn(F + cmd), cmd).toBeNull();
    expect(shell(F + cmd), cmd).toMatchObject({ approve: expect.stringContaining("no limits"), rule: "held=unread" });
  });
  it.each([
    ["called with a variable", 'run() { local name="$1"; cat "notes/$name.md"; }\nrun "$y"'],
    ["a local with another value", 'run() { local name="$1" d=$(pwd); cat "$d/$name.md"; }\nrun a'],
    ["a read before the binding", 'show() { cat "notes/$name.md"; local name="$1"; }\nshow a'],
    ["a binding that is not the body's first command", 'show() { [ -n "$2" ] && local name="$1"; cat "notes/$name.md"; }\nshow a b'],
    ["the name set again outside", 'run() { local name="$1"; cat "notes/$name.md"; }\nrun a\nname=x; cat "$name"'],
  ])("asks: %s", (_name, cmd) => {
    expect(shell(F + cmd), cmd).toMatchObject(ASKS);
  });
  it("a path from a variable the text does not give asks on the readable path (POSIX; PowerShell as in 1.0.15)", () => {
    expect(shell("cat $target").approve).toBeNull();
    expect(ps("Get-Content $target").approve).toContain("no limits");
    expect(ps("Get-Content ./notes/*.txt").approve).toContain("no limits");
  });
  it("a bound value that names a protected stand-in asks", () => {
    expect(shell(F + 'run() { local name="$1"; cat "$HOME/$name"; }\nrun .zshrc').approve).toBeNull();
  });
});

// MurageMain ruling, 1.0.16 r3 (fail closed): on the readable and the unreadable path these always ask
describe("a runner fed from data, a process substitution, or a name built from a variable", () => {
  it.each<[string, string, string]>([
    ["xargs", "printf '%s\\n' a.txt | xargs cat", "data-runner"],
    ["xargs from a list file", "xargs -a list.txt -I@ sh -c @", "data-runner"],
    ["parallel", "parallel cat ::: a.txt b.txt", "data-runner"],
    ["find -exec", "find . -name a.txt -exec cat {} \\;", "data-runner"],
    ["find -execdir", "find . -execdir cat a.txt \\;", "data-runner"],
    ["find -ok", "find . -ok cat {} \\;", "data-runner"],
    ["fd -x", "fd a.txt -x cat", "data-runner"],
    ["a wrapped xargs", "printf a.txt | command xargs cat", "data-runner"],
    ["a process substitution", "diff <(cat a.txt) <(cat b.txt)", "process-sub"],
    ["an output process substitution", "cat a.txt > >(cat)", "process-sub"],
    ["a copy from a process substitution", "cp <(cat a.txt) ./b.txt", "process-sub"],
    ["declare with a built name", 'n=D; declare "$n=notes.md"; cat notes.md', "built-name"],
    ["typeset with a built name", 'n=D; typeset "$n"=notes.md', "built-name"],
    ["export with a built name", 'n=D; export "$n=notes.md"', "built-name"],
    ["printf -v with a built name", 'n=D; printf -v "$n" %s notes.md', "built-name"],
    ["read into a built name", 'n=D; read -r "$n" < a.txt', "built-name"],
    ["mapfile into a built name", 'n=D; mapfile -t "$n" < a.txt', "built-name"],
  ])("%s", (_name, cmd, kind) => {
    expect(runnerShapeIn(cmd), cmd).toBe(kind);
    expect(unplainIn(F + cmd), cmd).toBe(kind);
    expect(shell(F + cmd), "unreadable: " + cmd).toMatchObject(ASKS);
    expect(shell(cmd), "readable: " + cmd).toMatchObject({ approve: null, source: "always-ask", reader: "hides" });
  });
  it.each(["cat a.txt | head", "read -r line < a.txt; echo \"$line\"", "declare D=notes.md; echo \"$D\"", "printf -v D %s a; echo x", "echo xargs find -exec"])("runs: %s", (cmd) => {
    expect(runnerShapeIn(cmd), cmd).toBeNull();
    expect(shell(cmd).approve, cmd).toContain("no limits");
  });
  it("a name a builtin writes turns resolving off for the whole text", () => {
    expect(unplainIn('D=notes.md; read -r x < a.txt; cat "$D"; echo ${!x}')).toBe("unplain-path");
    expect(unplainIn('D=notes.md; declare y=1; cat "$D"; echo ${!x}')).toBe("unplain-path");
  });
});

// a value the text does not give, set as a command's environment, can name what that command runs
describe("an environment value the text does not give asks", () => {
  it.each(['EDITOR="$x" git commit', 'export GIT_PAGER="$x"; git log', 'GIT_SSH_COMMAND="$(cat a.txt)" git fetch'])("asks: %s", (cmd) => {
    expect(unplainIn(F + cmd), cmd).toBe("unplain-command");
    expect(shell(F + cmd), cmd).toMatchObject(ASKS);
  });
  it("a literal or resolved value runs", () => {
    expect(unplainIn('EDITOR=vi git commit; echo ${!x}')).toBeNull();
    expect(unplainIn('GIT_DIR="$HOME/proj/.git" git log; echo ${!x}')).toBeNull();
  });
});

// MurageMain re-scope (B), 1.0.16 r3: an unreadable text runs without a card only in the narrow shape (narrowHold); every
// stand-in the round-4 reviews named asks on the unreadable path, and the approved shapes still run
describe("the narrow gate on the unreadable path", () => {
  it.each([
    "c=cd; command $c /etc && printf x >> profile", "env -C/etc sh -c 'printf x >> profile'", "c=find; command $c /etc -exec cat {} \\;",
    'X=/etc/*; for f in $X; do echo "$f"; done', 'cd /etc; for f in *.conf; do echo "$f"; done', "suffix=args; command x$suffix cat notes.md",
    "bash -c 'cd ~/.ssh; cat config'", "cd /; cd etc; cat profile", 'env -C"$HOME/.ssh" cat config', "cd notes; cd ..; cat a.md",
    "sudo -u $u cat notes.md", "exec $run notes.md", "nohup `which cat` notes.md", "time $c notes.md", "xargs $c < list.txt",
    "eval 'cat notes.md'", 'D=notes.sh; source "$D"', "pushd notes && cat a.md", "env --chdir=notes cat a.md", "T=$(date); cat notes.md",
    "python3 -c 'print(1)'", "cat a.md; cd notes", "builtin cd notes && cat a.md", "X=~/.ss?; cat notes.md",
  ])("asks: %s", (cmd) => {
    expect(alwaysAskCommand(F + cmd)?.readerFailed, cmd).toBe(true);
    expect(shell(F + cmd).approve, cmd).toBeNull();
  });
  it.each(['cd "$HOME/proj" && npm run build 2>&1 | tail -20', 'for f in a.md b.md; do cat "$f"; done', 'D=notes; cat "$D/a.md"'])("runs: %s", (cmd) => {
    expect(narrowHold(cmd + "; echo ${!x}"), cmd).toBeNull();
    expect(shell(cmd + "; echo ${!x}").approve, cmd).toContain("no limits");
  });
  it("a negated disk glob the base read as a disk still asks", () => {
    expect(shell("echo ${!x}; echo '/[^!d]ev/null'").approve).toBeNull();
  });
});

// MurageMain ruling 1.0.16 r3d: the PowerShell value skip failed review twice and is cut. Every r3 structural check is
// POSIX only; a PowerShell text gets exactly the release base (e06c54575) verdict. The verdicts below were recorded on
// that base for the GrokBuild and Astra round-1 stand-ins (harmless reads of a notes file); the POSIX analogues still ask.
describe("r3d: PowerShell is read exactly as in the release base", () => {
  const RUN = { approve: "auto-approved PowerShell (no limits)", source: "no-limits" };
  const UNREAD = { ...RUN, rule: "held=unread" };
  const HIDES = {
    approve: null, source: "always-ask", rule: "unreadable", reader: "hides",
    note: "Murage could not read this command, and it is written in a way that hides what it runs, such as encoded text, eval, or code sent straight into a shell or a script runner. Allow once to run it.",
  };
  it.each([
    ["Get-Content ($notes)", RUN], ["Get-Content ($env:NOTES)", RUN], ["Get-Content ($null + $notes)", RUN],
    ["$files | Get-Content", RUN], ["Get-Content $true,.\\notes.txt", RUN], ["Get-Content $true,$notes", RUN],
    ["Get-Content notes.txt,\r$env:NOTES", RUN], ["Get-Content notes.txt,\n$env:NOTES", RUN], ["Get-Content notes.txt,\r\n$env:NOTES", RUN],
    ["$true # marker\riex 'Write-Output ok'", UNREAD], ["Get-Date # marker\riex 'Write-Output ok'", UNREAD],
    ["Get-Content $target", RUN], ["Get-Content $notes", RUN], ["Get-Content $env:NOTES", RUN],
    ["Get-Content \"$env:USERPROFILE\\notes.txt\"", RUN], ["Get-Date > ($out)", UNREAD], ["Get-Date > $out", UNREAD],
    ["$env:Path -split ';'", RUN], ["$files | Measure-Object", RUN], ['& ("ec"+"ho") hi', UNREAD],
    ['$m = "Delete"; Get-ChildItem src | ForEach-Object { $_.$m() }', UNREAD], ["$x = 1\rGet-Content $notes", RUN],
    ["Get-Date\rGet-Content $env:NOTES", RUN], ["Get-Date\rInvoke-Expression $code", HIDES], ["Get-Content ./notes/*.txt", RUN],
  ])("PowerShell %j gets the base verdict", (cmd, base) => {
    expect(ps(cmd)).toEqual(base);
  });
  it.each([
    "cat $notes", 'cat "$notes"', "cat ${notes}", 'cat $(echo "$notes")', 'cat "$(printf %s "$notes")"',
    "printf '%s\\n' \"$files\" | xargs cat", "cat notes.txt \\\n$NOTES", "cat notes.txt,$NOTES", "echo hi > $out",
    'echo hi > "$(echo $out)"', "x=1\rcat $x", "cat notes.txt\r$x", "true\ncat $NOTES", "echo ${!x}; cat $notes",
    "echo ${!x}; eval 'echo ok'",
  ])("the POSIX analogue %j still asks", (cmd) => {
    expect(shell(cmd)).toMatchObject(ASKS);
  });
});
