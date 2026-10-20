// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 68f, row kind "prompt-capable": the one reader over PROMPT_ROWS (APP-GRANT-FIXPLAN-r6 (e)+(h) (c)).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIRECT_SSH_REASON, PROMPT_ROWS, WRAPPER_PREFIXES } from "./arg-vocabulary.ts";
import { pinOverrideIn, promptVerdict, type PromptFacts } from "./prompt-capable.ts";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

let base: string;
let home: string;
let repo: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8",
  }).trim();

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "prompt-capable-")));
  home = join(base, "home");
  repo = join(base, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q");
});

afterEach(() => removeTempDirSync(base));

const facts = (): PromptFacts => ({ cwd: repo, home, systemConfig: join(base, "no-system-config") });
const rule = (text: string, f: PromptFacts = facts()) => promptVerdict(text, f)?.rule ?? null;
/** with no facts at all */
const bare = (text: string) => promptVerdict(text, undefined)?.rule ?? null;

describe("the table", () => {
  it("PROMPT_ROWS is the whole list, each row with its reason", () => {
    expect(PROMPT_ROWS.map((row) => row.rule)).toEqual([
      "ssh-add", "sudo", "doas", "su", "pkexec", "gpg", "git-signing", "pty", "ssh-tty", "new-console", "repo-ssh-command", "direct-ssh", "unreadable",
    ]);
    for (const row of PROMPT_ROWS) expect(row.reason.length, row.rule).toBeGreaterThan(0);
    expect(PROMPT_ROWS.find((row) => row.rule === "direct-ssh")?.reason).toBe(DIRECT_SSH_REASON);
  });

  it("the stop line reads the same wrapper list, with no private copy", () => {
    const source = readFileSync(new URL("../server/stop-line.ts", import.meta.url), "utf8");
    expect(source).toMatch(/WRAPPER_PREFIXES/);
    expect(source).not.toMatch(/new Set\(\["sudo"/);
    expect(WRAPPER_PREFIXES.has("sudo") && WRAPPER_PREFIXES.has("unbuffer")).toBe(true);
  });

  it("auto-approve reads promptVerdict, and the reader keeps no program list of its own", () => {
    const auto = readFileSync(new URL("../server/auto-approve.ts", import.meta.url), "utf8");
    expect(auto).toMatch(/promptVerdict\(/);
    const reader = readFileSync(new URL("./prompt-capable.ts", import.meta.url), "utf8");
    expect(reader).not.toMatch(/"tmux"|"runas"|"socat"|"gpg2"|"scp"|"--batch"|"commit.gpgsign"/);
  });
});

describe("splitting and wrappers", () => {
  it.each([
    "echo a; sudo x", "a && sudo x", "a || sudo x", "a | sudo x", "a & sudo x", "a\nsudo x", "(sudo x)", "echo $(sudo x)", "echo `sudo x`",
    "{ sudo x; }", "x=$(sudo y)", "FOO=1 sudo x", "/usr/bin/sudo x", "sudo.exe x", "nohup sudo x", "timeout 5 sudo x", "env FOO=1 sudo x",
    "nice -n 5 sudo x", "command sudo x", "bash -c 'sudo x'", "sh -lc \"sudo x\"", "eval 'sudo x'", "xargs sudo x", "find . -exec sudo x {} \\;",
    "echo \"$(sudo x)\"", "cat <(sudo x)", "rtk proxy sudo x",
  ])("finds sudo in %j", (text) => {
    expect(rule(text)).toBe("sudo");
  });

  it.each(["echo sudo", "X=1 git status", "ls -la", "echo \"$HOME\"", "git log --format='%h'", "printf '%s' x"])("finds nothing in %j", (text) => {
    expect(rule(text)).toBeNull();
  });

  it("a wrapper's own row is judged first, then what it wraps", () => {
    expect(rule("sudo unbuffer x")).toBe("sudo");
    expect(rule("sudo -n unbuffer x")).toBe("pty");
    expect(rule("sudo -n sudo x")).toBe("sudo");
    expect(rule("unbuffer -p sudo -n x")).toBe("pty");
    expect(rule("timeout 5 sudo -n ls")).toBeNull();
  });

  it("text it cannot split, or a dynamic program word, holds", () => {
    for (const text of ["echo 'unterminated", "echo \"x", "$P x", "${P} x", "`which sudo` x", "echo $(sudo", "*sudo x"]) expect(rule(text), text).toBe("unreadable");
  });
});

describe("rows", () => {
  it("ssh-add asks unless its only option is -l, -L or -D", () => {
    expect(rule("ssh-add k")).toBe("ssh-add");
    expect(rule("ssh-add")).toBe("ssh-add");
    expect(rule("ssh-add -l -E md5")).toBe("ssh-add");
    for (const ok of ["ssh-add -l", "ssh-add -L", "ssh-add -D"]) expect(rule(ok)).toBeNull();
  });

  it("sudo and doas read their option clusters with their argument letters", () => {
    for (const ok of ["sudo -n x", "sudo --non-interactive x", "sudo -u bob -n x", "sudo -nu bob x", "sudo -n -u bob x", "doas -n x", "doas -nu bob x"]) expect(rule(ok), ok).toBeNull();
    for (const held of ["sudo x", "sudo -un x", "sudo -u n x", "sudo -S x", "sudo -- -n x", "sudo -v"]) expect(rule(held), held).toBe("sudo");
    for (const held of ["doas x", "doas -u n x", "doas -C n x"]) expect(rule(held), held).toBe("doas");
    expect(rule("su -c ls")).toBe("su");
    expect(rule("pkexec ls")).toBe("pkexec");
  });

  it("gpg: the read-only commands, or effective batch and pinentry-mode error", () => {
    for (const ok of ["gpg --version", "gpg -k", "gpg --list-keys", "gpg -K", "gpg --list-secret-keys", "gpg --verify f.sig", "gpg --fingerprint x", "gpg2 --export x",
      "gpg --batch --pinentry-mode error --sign f", "gpg --batch --pinentry-mode=error -d f", "gpg --pinentry-mode ask --pinentry-mode error --no-batch --batch -d f"]) expect(rule(ok), ok).toBeNull();
    for (const held of ["gpg --sign f", "gpg -d f", "gpg f", "gpg --export-secret-keys x", "gpg --batch --pinentry-mode error --no-batch --pinentry-mode ask --sign f",
      "gpg --batch --pinentry-mode error --homedir /x -d f", "gpg --batch --pinentry-mode error --options o -d f", "gpg --no-options --batch --pinentry-mode error -d f",
      "gpg --batc --pinentry-mode error -d f", "gpg --batch --pinentry-mode -d f", "GNUPGHOME=/x gpg --batch --pinentry-mode error -d f", "gpg.exe --sign f"]) expect(rule(held), held).toBe("gpg");
  });

  it("git signing: line flags, -c, GIT_CONFIG_*, the repository chain, and missing facts", () => {
    expect(rule("git commit -m x")).toBeNull();
    expect(rule("git status")).toBeNull();
    for (const held of ["git commit -S -m x", "git commit --gpg-sign=k -m x", "git -c commit.gpgsign=true commit -m x", "git -c commit.gpgSign commit -m x",
      "git -c commit.gpgsign=yes merge b", "GIT_CONFIG_COUNT=1 git commit -m x", "git tag -s v1", "git tag -u k v1", "git push --signed", "git rebase -S main",
      "git commit --no-gpg-sign -S -m x"]) expect(rule(held), held).toBe("git-signing");
    for (const ok of ["git commit -S --no-gpg-sign -m x", "git -c commit.gpgsign=false commit -m x", "git tag v1", "git push"]) expect(rule(ok), ok).toBeNull();
    git(repo, "config", "tag.gpgSign", "true");
    expect(rule("git tag v1")).toBe("git-signing");
    expect(rule("git tag --no-sign v1")).toBeNull();
    expect(bare("git commit -m x")).toBe("git-signing");
    expect(bare("git fetch")).toBe("repo-ssh-command");
    expect(bare("git status")).toBeNull();
    expect(bare("sudo -n ls")).toBeNull();
  });

  it("PTY makers and ssh -t", () => {
    for (const held of ["script -q /dev/null ls", "expect x.exp", "unbuffer ls", "tmux new -d", "screen -dm x", "socat - pty,raw,echo=0", "socat PTY,link=/tmp/x -"]) expect(rule(held), held).toBe("pty");
    expect(rule("socat - tcp:host:80")).toBeNull();
    const batch = "-o BatchMode=yes -o ProxyCommand=none";
    for (const held of [`ssh -t ${batch} h ls`, `ssh -tt ${batch} h`, `ssh -vt ${batch} h`, `ssh -T -t ${batch} h`, `ssh -o RequestTTY=yes ${batch} h`, `ssh -o RequestTTY=force ${batch} h`]) expect(rule(held), held).toBe("ssh-tty");
    for (const ok of [`ssh ${batch} h ls`, `ssh -t -T ${batch} h`, `ssh -o RequestTTY=no ${batch} h`]) expect(rule(ok), ok).toBeNull();
  });

  it("the direct ssh row, with its reason", () => {
    expect(promptVerdict("ssh h ls", facts())).toEqual({ rule: "direct-ssh", note: DIRECT_SSH_REASON });
    expect(rule("scp a h:b")).toBe("direct-ssh");
    expect(rule("rsync -e 'ssh -p 2' a h:b")).toBe("direct-ssh");
    expect(rule("rsync -a a h:b")).toBeNull();
  });

  it("Windows new-console launchers", () => {
    for (const held of ["start notepad", "cmd /c start x", "cmd.exe /C start x", "Start-Process notepad", "powershell -Command Start-Process x", "runas /user:x y"]) expect(rule(held), held).toBe("new-console");
  });

  it("the repository's own core.sshCommand", () => {
    git(repo, "config", "core.sshCommand", "ssh -i ~/.ssh/repo");
    expect(promptVerdict("git fetch", facts())).toEqual({ rule: "repo-ssh-command", note: "this repository sets its own core.sshCommand, which engines do not use; they use plain ssh" });
    expect(rule("git fetch", { ...facts(), ssh: { source: { setting: "GIT_SSH_COMMAND", value: "ssh" }, kept: true } })).toBeNull();
    expect(rule("git status")).toBeNull();
  });
});

// A shell's code body is code: a dynamic program word or text it cannot split holds there, as at the top level. Only an
// ordinary quoted argument is re-read leniently.
describe("a shell's code body is judged strictly", () => {
  it.each([
    ["bash -c '$P x'"],
    ["sh -c \"`id` y\""],
    ["sh -c '`id` y'"],
    ["zsh -c '$(printf sudo) x'"],
    ["dash -c '${P} x'"],
    ["ksh -c 'echo \"unterminated'"],
    ["fish -c '$P x'"],
    ["bash -c 'true; $P x'"],
    ["bash -lc '$P x'"],
    ["bash $OPT -c 'echo x'"],
    ["bash $OPT 'echo x'"],
    ["cmd /c $P x"],
    ["cmd /c \"%P% x\""],
    ["powershell -Command '$P x'"],
    ["powershell -Command '& $P x'"],
    ["pwsh -c '`id` x'"],
    ["eval '$P x'"],
    ["eval 'echo \"unterminated'"],
    ["nohup bash -c '$P x'"],
    ["sudo -n bash -c '$P x'"],
    ["echo \"$(bash -c '$P x')\""],
  ])("%s holds", (text) => {
    expect(rule(text), text).not.toBeNull();
  });

  it("an ordinary quoted argument stays lenient", () => {
    expect(rule("echo \"$P x\"")).toBeNull();
    expect(rule("printf '%s' '`id`'")).toBeNull();
    expect(rule("echo 'say \"unterminated'")).toBeNull();
    expect(rule("bash -c 'echo \"$P x\"'")).toBeNull();
  });
});

describe("build re-review r6 (Astra items 1 to 3)", () => {
  it("a -c signing key in git's attached form, and the config-equivalent forms, hold like the separated -c", () => {
    for (const held of ["git -ccommit.gpgsign=true commit -m x", "git -ccommit.gpgSign commit -m x", "git -cCommit.GpgSign=YES commit -m x",
      "git -ctag.gpgsign=true tag v1", "git -c x.y=1 -ccommit.gpgsign=on merge b", "git --config-env=commit.gpgsign=V commit -m x",
      "git --config-env commit.gpgsign=V commit -m x", "GIT_CONFIG_PARAMETERS=x git commit -m x"]) expect(rule(held), held).toBe("git-signing");
    for (const ok of ["git -ccommit.gpgsign=false commit -m x", "git -ctag.gpgsign=false -ctag.forcesignannotated=false tag v1"]) expect(rule(ok), ok).toBeNull();
    // the attached form pins signing off for a repository that signs, as the separated one does
    git(repo, "config", "commit.gpgsign", "true");
    expect(rule("git -ccommit.gpgsign=false commit -m x")).toBeNull();
    expect(rule("git -c commit.gpgsign=false commit -m x")).toBeNull();
  });

  it("git -C is placed with real folder semantics: link/.. climbs from where the link points", () => {
    const other = join(base, "other");
    mkdirSync(join(other, "inner"), { recursive: true });
    git(other, "init", "-q");
    git(other, "config", "commit.gpgsign", "true");
    symlinkSync(join(other, "inner"), join(repo, "link"));
    // lexically `repo/link/..` is the unsigned repo; git itself runs in `other`, which signs
    expect(rule("git -C link/.. commit -m x")).toBe("git-signing");
    expect(rule("git -C link -C .. commit -m x")).toBe("git-signing");
    // a -C that does not resolve is an unresolved chain: it holds
    expect(rule("git -C nope commit -m x")).toBe("git-signing");
    expect(rule("git -C nope fetch")).toBe("repo-ssh-command");
    // and the per-repository core.sshCommand row reads the same placed folder
    git(other, "config", "core.sshCommand", "ssh -i k");
    expect(rule("git -C link/.. fetch")).toBe("repo-ssh-command");
    expect(rule("git fetch")).toBeNull();
  });

  it("a per-command value other than its pin is U19, wherever the command stands", () => {
    const pins = new Map([["GIT_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"]]);
    for (const held of ["GIT_ASKPASS=/x git fetch", "git -c core.sshCommand=x fetch", "git -ccore.sshCommand=x fetch", "env GIT_ASKPASS=/x git fetch",
      "bash -c 'GIT_ASKPASS=/x git fetch'", "true && GIT_SSH_COMMAND=ssh git push", "sudo -n GIT_ASKPASS=/x git fetch", "PAGER=less git log",
      "echo $(GIT_ASKPASS=/x git fetch)", "GIT_SSH=/x git fetch"]) expect(pinOverrideIn(held, pins), held).toMatch(/^(GIT_|PAGER|-c )/);
    for (const ok of ["git log", "git fetch", "GIT_ASKPASS= git fetch", "PAGER=cat git log", "FOO=1 git log", "ls -c core.sshCommand=x"]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });
});

describe("build re-review r7 (Astra item 1): the effective value reaches the wrapped command", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"]]);

  it("an assignment before a wrapper, or carried by one, is U19 at the wrapped command", () => {
    for (const held of [
      "GIT_ASKPASS=/tmp/askpass env git fetch", "GIT_ASKPASS=/x nice git fetch", "GIT_ASKPASS=/x nice -n 5 git fetch",
      "GIT_ASKPASS=/x timeout 5 git fetch", "GIT_ASKPASS=/x nohup git fetch", "GIT_ASKPASS=/x env nice timeout 5 git fetch",
      "PAGER=less env nice git log", "GIT_ASKPASS=/x bash -c 'git fetch'", "GIT_ASKPASS=/x bash -c 'env git fetch'",
      "GIT_ASKPASS=/x sh -c \"nohup git fetch\"", "echo $(GIT_ASKPASS=/x env git fetch)", "echo $(GIT_ASKPASS=/x nice git fetch)",
      "GIT_ASKPASS=/x sudo -n git fetch", "sudo -n GIT_ASKPASS=/x nice git fetch",
    ]) expect(pinOverrideIn(held, pins), held).toMatch(/GIT_ASKPASS|PAGER/);
  });

  it("env -u, env -i and a user switch remove or hide a value pin", () => {
    for (const held of [
      "env -u GIT_ASKPASS git fetch", "env --unset=GIT_ASKPASS git fetch", "env --unset GIT_ASKPASS git fetch", "env -uGIT_ASKPASS git fetch",
      "env -i git fetch", "env - git fetch", "env -i PATH=/usr/bin git fetch", "nice env -i git fetch", "timeout 5 env -u PAGER git log",
      "bash -c 'env -i git fetch'", "sudo -n git fetch", "doas -n git log",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("export, a bare assignment, unset and eval earlier on the line reach later commands", () => {
    for (const held of [
      "export GIT_ASKPASS=/x; git fetch", "export GIT_ASKPASS=/x && env git fetch", "GIT_ASKPASS=/x; git fetch", "unset GIT_ASKPASS; git fetch",
      "export -n GIT_ASKPASS; git fetch", "declare -x PAGER=less; git log", "eval 'export GIT_ASKPASS=/x'; git fetch",
      "GIT_ASKPASS=/x; echo $(git fetch)", "export GIT_ASKPASS=/x; bash -c 'git fetch'",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("the handed value, another name, or a pinned value passes", () => {
    for (const ok of [
      "env git fetch", "nice git fetch", "nohup git fetch", "timeout 5 git log", "env GIT_ASKPASS= git fetch", "env -u FOO git fetch",
      "FOO=1 env git log", "export FOO=1; git log", "PAGER=cat; git log", "sudo -n ls", "bash -c 'git log'",
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  it("the prompt rows read the inherited names too", () => {
    expect(rule("gpg --batch --pinentry-mode error --sign f")).toBeNull();
    expect(rule("GNUPGHOME=/x env gpg --batch --pinentry-mode error --sign f")).toBe("gpg");
    expect(rule("GNUPGHOME=/x nice gpg --batch --pinentry-mode error --sign f")).toBe("gpg");
    expect(rule("export GNUPGHOME=/x; gpg --batch --pinentry-mode error --sign f")).toBe("gpg");
  });
});

// Astra build r8, the second BLOCK on item 1: the conservative design. Any touch of a pinned name anywhere on the line holds
// (U19), in any form and regardless of order, subshells or branches; the one exception is a plain assignment of a pinned name
// to exactly its pin, standing before a command or alone at the line's top level.
describe("build re-review r8 (Astra item 1, second BLOCK): any touch of a pinned name holds", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["SSH_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"],
    ["GIT_TERMINAL_PROMPT", "0"], ["DEBIAN_FRONTEND", "noninteractive"], ["TERM", "dumb"]]);

  it("the five r8 P1 lines hold", () => {
    for (const held of [
      "export GIT_ASKPASS=/tmp/a; (export GIT_ASKPASS=); env git fetch", "export GIT_ASKPASS=/tmp/a || export GIT_ASKPASS=; git fetch",
      "export GIT_ASKPASS=/tmp/a; echo $(git fetch); export GIT_ASKPASS=", "builtin export GIT_ASKPASS=/tmp/a; env git fetch",
      "env -S '-u GIT_ASKPASS git fetch'", "exec -c git fetch",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("every form of setting, removing or clearing holds, wherever it stands", () => {
    for (const held of [
      // assignments, export and its kin, unset, in any order and any branch
      "git fetch; export GIT_ASKPASS=/x", "true || GIT_ASKPASS=/x", "(GIT_ASKPASS=/x); git fetch", "if true; then export GIT_SSH=/x; fi; git fetch",
      "declare -x GIT_SSH_COMMAND=x; ls", "typeset GIT_SSH=x; ls", "local GIT_CONFIG_COUNT=1", "readonly SSH_ASKPASS=/x", "unset GIT_ASKPASS",
      "export -n PAGER; git log", "declare +x GIT_ASKPASS=; git fetch", "GIT_ASKPASS+= git fetch",
      // GIT_CONFIG_* and every ENV_PINS name, whatever the program
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.askPass GIT_CONFIG_VALUE_0=/x git fetch", "GIT_CONFIG_PARAMETERS=x git fetch", "GIT_CONFIG_GLOBAL=/x ls",
      "TERM=xterm ls", "BASH_ENV=/x bash -c 'git log'", "ZDOTDIR=/tmp zsh -c 'git log'", "PAGER=less ls", "LESS=-R ls", "POSIXLY_CORRECT=1 ls",
      // env's clearing and splitting options, exec -c
      "env -i ls", "env - ls", "env --ignore-environment ls", "env --ign ls", "env -iC /tmp ls", "env -S 'git fetch'", "env --split-string='git fetch'",
      "env -u GIT_SSH_COMMAND ls", "GIT_ASKPASS=/x env -u GIT_ASKPASS ls", "exec -cl git fetch", "exec -a x -c git fetch",
      "nice env -i git fetch", "command exec -c git fetch",
      // names the line spells statically, split by quotes or escapes
      "eval \"export GIT_ASK\"\"PASS=/x\"; git fetch", "export \"GIT_ASK\"\"PASS=/x\"; git fetch", "export GIT_ASK\\PASS=/x; git fetch",
      "export GIT_$'ASKPASS'=/x; git fetch", "read -r GIT_ASKPASS < f; git fetch", "printf -v GIT_ASKPASS /x; git fetch",
      ": ${GIT_ASKPASS:=/x}; git fetch", "echo ${GIT_ASKPASS=/x}; git fetch", "declare -n r=GIT_ASKPASS; r=/x; git fetch",
      // bodies: eval, sh -c, substitutions, heredoc-fed shells
      "eval 'export GIT_ASKPASS=/x'; git fetch", "sh -c 'env -i git fetch'", "bash -c 'unset GIT_ASKPASS; git fetch'", "echo $(env -u PAGER git log)",
      "echo `export PAGER=less`", "bash <<EOF\nexport GIT_ASKPASS=/x\ngit fetch\nEOF", "bash <<'EOF'\nenv -i git fetch\nEOF",
      "bash -c \"bash -c 'exec -c git fetch'\"",
      // Windows spellings: names have no case there
      "$env:GIT_ASKPASS='C:\\x'; git fetch", "$env:git_askpass='x'; git fetch", "set git_askpass=x& git fetch", "Remove-Item Env:\\GIT_ASKPASS; git fetch",
      "[Environment]::SetEnvironmentVariable('X', 'y'); git fetch", "Start-Process git -UseNewEnvironment",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("a plain assignment to exactly the pin, before a command or alone, passes (the r8 P2)", () => {
    for (const ok of [
      "GIT_ASKPASS= bash -c 'git status'", "GIT_ASKPASS= git fetch", "PAGER=cat git log", "PAGER=cat; git log", "env GIT_ASKPASS= git fetch",
      "GIT_TERMINAL_PROMPT=0 git fetch", "DEBIAN_FRONTEND=noninteractive apt-get install -y x", "TERM=dumb ls", "GIT_ASKPASS= SSH_ASKPASS= git fetch",
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  it("lines that name no pin pass", () => {
    for (const ok of [
      "git fetch", "env -u FOO git fetch", "env FOO=1 git log", "env -C /tmp git log", "env -v git log",
      "read -r line < f", "git commit -m \"don't stop\"", "export FOO=1; unset FOO; git log", "local x=1", "declare -a arr",
      "exec git fetch", "eval 'git log'", "bash -c 'git log'", "FOO=$(date) git log", "git log --format=%H",
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  // Astra build r9, items 1-3, under ship rule S (threat verdict 2026-10-19): a name only known when it runs is a program the engine
  // chose to run, bounded by the approval that ran the line, so these reproductions stay unheld.
  it("a name-setting builtin with a dynamic argument stays unheld under S (Astra r9 reproductions)", () => {
    for (const ok of [
      "n=GIT_; n+=ASKPASS; o=-v; printf \"$o\" \"$n\" /tmp/askpass; git fetch", "n=GIT_; n+=ASKPASS; read -pPrompt \"$n\" <<< /tmp/askpass; git fetch",
      "n=GIT_; n+=ASKPASS; declare \"-n\" ref=$n; ref=/tmp/askpass; git fetch", "printf \"$o\" x", "printf -- -v \"$n\" x", "printf '%s' \"$x\"",
      "read -r -p \"$P\" line", "read -t1 \"$n\"", "read -u3 -a \"$n\"", "declare '-n' r=$n", "typeset -n r=\"$n\"", "local -n r=$n", "local \"$o\" r=x",
      "export \"$o\" x=1", "readonly -n r=$n", "declare -gn r=$n", "unset -n \"$n\"", "mapfile -t -O 0 \"$n\" < f", "readarray -C \"$c\" arr < f",
      "getopts \"$spec\" opt", "let n=$x", "eval x$y=1", "source \"$f\"", ". \"$f\"", ". $f; git fetch", "source ./*.sh", "export PATH=\"$PATH:/x\"; git fetch",
      "command printf -v \"$n\" x", "builtin read \"$n\"", "true && declare -n r=$n; r=/x; git fetch", "( read \"$n\" ); git fetch", "echo $(printf -v \"$n\" x)",
      "bash -c 'read \"$n\"'", "p=printf; $p -v \"$n\" x", "builtin $p \"$n\"", "command \"$p\" -v \"$n\" x",
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
    for (const ok of ["read -r line < f", "printf '%s\\n' x", "declare -a arr", "local x=1", "source ./env.sh", "export FOO=1", "FOO=$(date) git log"]) {
      expect(pinOverrideIn(ok, pins), ok).toBeNull();
    }
  });

  it("the touch reads its name in the note", () => {
    expect(pinOverrideIn("export GIT_ASKPASS=/x; git fetch", pins)).toMatch(/^GIT_ASKPASS /);
    expect(pinOverrideIn("env -i git fetch", pins)).toMatch(/^env -i /);
    expect(pinOverrideIn("exec -c git fetch", pins)).toMatch(/^exec -c /);
  });
});

// Astra build r10 High: a wrapper's option word hid the program word ("$p" after command -p). Every word from the start through
// the wrappers, their options and the words after an option, up to the first static program name, is a possible program.
describe("build re-review r10 under S: a dynamic program behind a wrapper stays unheld", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["PAGER", "cat"]]);
  it("a dynamic word anywhere in the possible-program prefix stays unheld (Astra r10/r11 reproductions)", () => {
    for (const ok of [
      'p=printf; command -p "$p" -v "$n" /tmp/askpass; git fetch', 'command "$p" -v x', 'exec -a "$y" "$p" x',
      'nice -n 5 "$p" x', 'timeout 5 "$p" x', 'sudo -u root "$p" x', 'env FOO=1 "$p" x', 'nohup stdbuf -o0 "$p" x', 'xargs -I{} "$p" x',
      'timeout 1e3 "$p" x', 'timeout --kill-after=1 5 "$p"', 'stdbuf -oL "$p"', 'n=GIT_; n+=ASKPASS; p=env; timeout 1e3 "$p" "$n=/tmp/askpass" git fetch',
      'setsid "$p" x', 'chrt -f 1 "$p" x', 'ionice -c 3 "$p" x', 'taskset 0x1 "$p" x',
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
    // the static clearing beside the dynamic program still holds
    expect(pinOverrideIn('env -i "$p" -v x', pins)).toMatch(/^env -i /);
  });
  it("ordinary lines are unchanged", () => {
    for (const ok of ["git status", "command -v git", "env FOO=1 make", "nice -n 5 make", "timeout 5 git fetch", "setsid git fetch", 'git log "$x"', "exec git fetch"])
      expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });
});

// Ship rule S (APP-GRANT-U19-THREAT-VERDICT.md, 2026-10-19): U19 reads the line statically. Builder change 2: the r8..r12
// dynamic reproductions and ordinary computed updates stay unheld; each removed rule's static twin still holds.
describe("ship rule S: the static reading", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["SSH_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"],
    ["GIT_TERMINAL_PROMPT", "0"], ["TERM", "dumb"]]);

  it("the r8..r12 dynamic reproductions stay unheld", () => {
    for (const ok of [
      "env -u $N git fetch", "export $N; git fetch", "env -u $N ls", "env \"$X\" git fetch", "export ${P}ASKPASS=/x; git fetch", "unset $N; git fetch",
      "unset -v \"$N\"", "read -r \"$N\" < f", "read -a \"$N\" < f", "printf -v \"$n\" /x", "declare -n r=\"$n\"; r=/x; git fetch", "eval \"$X\"; git fetch",
      "let \"$n=1\"", "mapfile -t \"$n\" < f", "getopts ab \"$n\"", 'n=GIT_; n+=ASKPASS; p=env; "$p" "$n=/x" git fetch',
      'n=GIT_; n+=ASKPASS; p=env; timeout 1e3 "$p" "$n=/tmp/askpass" git fetch',
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  it("ordinary computed updates stay unheld", () => {
    for (const ok of ['export FOO="$x"; git fetch', 'unset "$n"; git log', 'env -u "$n" git status', 'eval "$cmd"; git fetch', "export PATH=\"$PATH:/x\"; git fetch"])
      expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  it("each removed rule's static twin still holds", () => {
    expect(pinOverrideIn("GIT_ASKPASS=/x git fetch", pins)).toMatch(/^GIT_ASKPASS /);
    expect(pinOverrideIn("env -i git fetch", pins)).toMatch(/^env -i /);
    expect(pinOverrideIn("export SSH_ASKPASS=/x", pins)).toMatch(/^SSH_ASKPASS /);
    expect(pinOverrideIn("git -c core.askPass=/x fetch", pins)).toMatch(/^-c core\.askPass /);
    expect(pinOverrideIn("sudo git fetch", pins)).toMatch(/is not known for this command/);
    expect(pinOverrideIn('$env:GIT_ASKPASS="x"', pins)).not.toBeNull();
  });

  it("literal pin overrides still hold", () => {
    for (const held of [
      "PAGER=less git log", "export GIT_ASKPASS=/x; git fetch", "unset GIT_ASKPASS; git fetch", "env -u GIT_ASKPASS git fetch", "exec -c git fetch",
      "git -c core.pager=less log", "git -p log", "GIT_SSH_COMMAND=ssh git push", "bash -c 'GIT_ASKPASS=/x git fetch'", "echo $(GIT_ASKPASS=/x git fetch)",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });
});

// Astra design round 2 (astra-app-grant-u19-threat-r2), REVISE items 1-3, folded into the verdict doc as the r2 amendment.
/** A line that names a pinned name somewhere (build r19 fallback: such a line always holds). */
const PIN_MENTION = /GIT_ASKPASS|SSH_ASKPASS|GIT_SSH_COMMAND|PAGER|TERM|DEBIAN_FRONTEND|GIT_TERMINAL_PROMPT/;

describe("r2 amendment: data versus code, mixed static and dynamic, any wrapper", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["SSH_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"],
    ["GIT_TERMINAL_PROMPT", "0"], ["TERM", "dumb"], ["DEBIAN_FRONTEND", "noninteractive"]]);

  it("build r19 fallback: no data excusal; a pinned name named anywhere holds, a line naming none passes", () => {
    for (const ok of [
      // searches
      "grep -rn GIT_ASKPASS src", "rg 'GIT_SSH_COMMAND|SSH_ASKPASS' server", "git grep -n PAGER -- shared", "grep -c \"export GIT_ASKPASS=\" notes.md",
      // documentation mentions
      "cat docs/GIT_ASKPASS.md", "echo 'set GIT_ASKPASS=/x before git fetch'", "printf '%s\\n' 'PAGER=less git log'", "sed -n 1,20p docs/TERM.md",
      "echo \"use env -u PAGER git log\"",
      // commit messages
      'git commit -m "engine pins GIT_ASKPASS and PAGER"', "git commit -m 'export GIT_ASKPASS=/x; git -c core.pager=less log'", "git log --grep=GIT_SSH_COMMAND",
    ]) expect(pinOverrideIn(ok, pins) === null, ok).toBe(!PIN_MENTION.test(ok));
  });

  it("item 1: a value equal to the handed pin is not an override", () => {
    for (const ok of [
      'GIT_ASKPASS="" git fetch', "export GIT_ASKPASS=; git fetch", "export PAGER=cat TERM=dumb; git log", "declare -x GIT_TERMINAL_PROMPT=0; git fetch",
      "unset GIT_SSH; git fetch", "unset BASH_ENV ENV", "env GIT_ASKPASS= PAGER=cat git log",
      // Astra build r13 Medium: quoted, after env's --, and with clustered keeping options
      'export "PAGER=cat"; git log', "env -- PAGER=cat git log", "declare -xr PAGER=cat; git log", 'unset "BASH_ENV"',
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  it("item 1: text run as shell is still read, and data next to code is not a hiding place", () => {
    for (const held of [
      "sh -c 'export GIT_ASKPASS=/x; git fetch'", "eval 'GIT_ASKPASS=/x git fetch'", "bash <<EOF\nexport GIT_ASKPASS=/x\ngit fetch\nEOF",
      "echo \"$(GIT_ASKPASS=/x git fetch)\"", "grep x f; export GIT_ASKPASS=/x; git fetch", "grep GIT_ASKPASS f && GIT_ASKPASS=/x git fetch",
      "echo ${GIT_ASKPASS:=/x}; git fetch", "echo $((GIT_TERMINAL_PROMPT=1)); git fetch", "python3 -c 'import os; os.environ[\"GIT_ASKPASS\"]=\"/x\"'",
      "time GIT_ASKPASS=/x git fetch", "sudo GIT_ASKPASS=/x git fetch", "make GIT_ASKPASS=/x", "printf -v PAGER less; git log",
      "export GIT_ASKPASS=/y; git fetch", "export -n GIT_ASKPASS=; git fetch", "unset GIT_ASKPASS",
      // Astra build r13 High: a substitution a data command's quoted word or here-document still runs
      'echo "${x:-$(GIT_ASKPASS=/x git fetch)}"', "echo ${x:-$(env -i git fetch)}", "cat <<EOF\n$(env -i git fetch)\nEOF",
      "cat <<EOF\n$(GIT_ASKPASS=/x git fetch)\nEOF", "cat <<EOF\ndon't $(git -c core.pager=less log)\nEOF", 'echo "${x:-`git -p log`}"',
      "cat <<EOF\nGIT_ASKPASS `id`\nEOF",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("item 2: a dynamic operand does not hide the static effects before or after it", () => {
    for (const held of [
      'env -u "$n" -i git fetch', 'env "$x" -i git fetch', 'env -u "$n" -u GIT_ASKPASS git fetch', 'env --unset "$n" --ignore-environment git fetch',
      'unset "$n" GIT_ASKPASS; git fetch', 'export "$o" GIT_ASKPASS=/x; git fetch', 'export -n "$n" PAGER; git log',
      'env -u "$n" git -c core.askPass=/x fetch', 'unset "$n"; export PAGER=less; git log', 'export FOO="$x" PAGER=less; git log',
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
    // exec's dynamic word is its program; what follows is that program's own options
    for (const ok of ['exec "$x" -c git fetch', 'env -u "$n" -u FOO git fetch', 'export "$o" FOO=1; git fetch', 'unset "$n" FOO; git log']) expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });

  it("item 3: a listed option holds behind a wrapper missing from WRAPPER_PREFIXES", () => {
    for (const held of [
      "setsid git -c core.askPass=/x fetch", "chrt -f 1 git -c core.pager=less log", "ionice -c 3 git -p log", "taskset 0x1 git -c core.sshCommand=x fetch",
      "chronic git -c core.editor=vim commit", "rtk git -c core.pager=less log", "nice -n 5 git --paginate log", "setsid -w man -P less ls",
      "numactl -N 0 psql --pset=pager=always -c x", "stdbuf -oL setsid git -ccore.askPass=/x fetch", "caffeinate -i timeout 9 git -c credential.interactive=always fetch",
      '"$p" git -p log', '"$w" -n 5 git -c core.pager=less log',
    ]) expect(pinOverrideIn(held, pins), held).toMatch(/overrides a pin/);
    for (const ok of ["setsid git fetch", "chrt -f 1 git log", "taskset 0x1 git commit -p", "ionice -c 3 ssh -T host ls", "chronic rsync -a x y"])
      expect(pinOverrideIn(ok, pins), ok).toBeNull();
  });
});

describe("build r14: a region that runs code is never data, at any depth", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["SSH_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"],
    ["GIT_TERMINAL_PROMPT", "0"], ["TERM", "dumb"], ["DEBIAN_FRONTEND", "noninteractive"]]);
  const runs = ["GIT_ASKPASS=/x git fetch", "env -i git fetch", "git -p log"];

  it("Astra r14 High: a process substitution in a replacement string", () => {
    for (const body of runs) expect(pinOverrideIn(`x=x; echo \${x/x/<(${body})}`, pins), body).not.toBeNull();
  });

  it("<( and >( inside every ${} operator kind, bare and in double quotes", () => {
    const ops = ["x/x/", "x//x/", "x/#x/", "x:-", "x-", "x:=", "x:+", "x+", "x#", "x##", "x%", "x%%", "x:?"];
    for (const op of ops) for (const sub of ["<(", ">("]) for (const body of runs) {
      for (const line of [`echo \${${op}${sub}${body})}`, `echo "\${${op}${sub}${body})}"`, `printf '%s' \${${op}${sub}${body})} > f`])
        expect(pinOverrideIn(line, pins), line).not.toBeNull();
    }
  });

  it("nested expansions are read again as shell", () => {
    for (const held of [
      "echo $(cat <(git -p log))", 'echo "$(cat <(env -i git fetch))"', "echo ${x:-$(cat <(GIT_ASKPASS=/x git fetch))}",
      "echo ${x:-${y:-<(git -p log)}}", 'echo "${x:-${y:->(env -i git fetch)}}"', "echo `cat <(git -p log)`",
      "echo $(echo $(echo <(GIT_ASKPASS=/x git fetch)))", "cat <(echo ${x:-<(git -p log)})", "echo $\"${x:-$(git -p log)}\"",
      "grep x <(env -i git fetch)", "echo ${x:-'}'<(git -p log)}",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("every here-document is checked as text, quoted delimiter or not (over-holding a quoted one is accepted)", () => {
    for (const held of [
      "cat <<EOF\n${x:-$(git -p log)}\nEOF", "cat <<EOF\n$(cat <(GIT_ASKPASS=/x git fetch))\nEOF", "cat <<EOF\n`env -i git fetch`\nEOF",
      "cat <<EOF\nGIT_ASKPASS $(true)\nEOF", "bash <<'EOF'\nGIT_ASKPASS=/x git fetch\nEOF", "sh <<'EOF'\ngit -p log\nEOF",
      "cat <<'EOF'\n$(GIT_ASKPASS=/x git fetch)\nEOF", 'cat <<"EOF"\n${x:-$(env -i git fetch)}\nEOF', "cat <<\\EOF\n`git -p log` GIT_ASKPASS\nEOF",
      "cat > notes.md <<'EOF'\nexport GIT_ASKPASS=/x; echo $(git -c core.pager=less log)\nEOF",
      // Astra build r15 High: a delimiter misread must not hide the code after it
      "cat <<\"E'OF\"\ntext\nE'OF\necho $(GIT_ASKPASS=/x git fetch)",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("Astra r14 Medium: env's quoted assignments and keeping options read like plain ones", () => {
    for (const ok of [
      'env "PAGER=cat" git log', "env -v PAGER=cat git log", 'env -v "PAGER=cat" git log', "env -0v PAGER=cat git log", "env --debug PAGER=cat git log",
      "env -C /tmp PAGER=cat git log", "env --chdir=/tmp TERM=dumb git log", "env -u FOO PAGER=cat git log", "env -v -- PAGER=cat git log",
      'env "GIT_ASKPASS=" "PAGER=cat" git fetch',
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
    for (const held of [
      'env "PAGER=less" git log', "env -v PAGER=less git log", 'env -v "GIT_ASKPASS=/x" git fetch', "env -i PAGER=cat git log",
      'env "PAGER=cat" GIT_ASKPASS=/x git fetch', "env -u PAGER git log",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("build r19 fallback: data mentions of a pin hold, lines with none pass", () => {
    for (const ok of [
      "grep -rn GIT_ASKPASS src", "echo 'set GIT_ASKPASS=/x before git fetch'", 'git commit -m "engine pins GIT_ASKPASS and PAGER"',
      "echo ${x:-plain} GIT_ASKPASS", "echo ${x/a/b}", "diff <(sort a) <(sort b)", "cat <(git log)",
    ]) expect(pinOverrideIn(ok, pins) === null, ok).toBe(!PIN_MENTION.test(ok));
  });
});

describe("build r17 (Fable's two Highs): data excusal narrowed, not more parsing", () => {
  const pins = new Map([["GIT_ASKPASS", ""], ["SSH_ASKPASS", ""], ["GIT_SSH_COMMAND", "'ssh' '-o' 'BatchMode=yes'"], ["PAGER", "cat"],
    ["GIT_TERMINAL_PROMPT", "0"], ["TERM", "dumb"], ["DEBIAN_FRONTEND", "noninteractive"]]);

  it("Fable High 1: a here-document piped into a shell is code", () => {
    for (const held of [
      "cat <<'EOF' | sh\nGIT_ASKPASS=/x git fetch\nEOF", "cat <<'EOF' | sh\nenv -i git fetch\nEOF", "cat <<'EOF' | sh\ngit -p log\nEOF",
      "cat <<EOF | bash -s\nexport PAGER=less\nEOF",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("Fable High 2: a quoted delimiter keeps the characters inside its quotes", () => {
    for (const held of [
      "cat <<\"E'OF\"\ntext\nEOF\nGIT_ASKPASS=/x git fetch\nE'OF", "cat <<\"E'OF\"\ntext\nE'OF\nGIT_ASKPASS=/x git fetch",
      "cat <<'E\"OF'\ntext\nE\"OF\nenv -i git fetch", "cat <<\"E'OF\"\ntext\nE'OF\ngit -p log",
      // a delimiter that cannot be read with certainty holds
      "cat <<\"EOF\nGIT_ASKPASS docs\nEOF", "cat <<$'EOF'\nGIT_ASKPASS docs\nEOF",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("a pinned name in any here-document body holds, whatever the delimiter", () => {
    for (const held of [
      "cat <<'EOF'\nexport GIT_ASKPASS=/x\nEOF", "cat <<EOF\nGIT_ASKPASS and PAGER docs\nEOF", "cat > notes.md <<EOF\nexport GIT_ASKPASS=/x\nEOF",
      "cat <<\\EOF\nPAGER\nEOF", "cat <<-\"EOF\"\n\tTERM docs\n\tEOF", "x=$(cat <<'EOF'\ngrep GIT_ASKPASS f\nEOF\n)",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("quoted text fed to a program that may run it is code", () => {
    for (const held of [
      'echo "GIT_ASKPASS=/x git fetch" | sh', 'echo "GIT_ASKPASS=/x git fetch" | bash -s', 'echo "GIT_ASKPASS=/x git fetch" | xargs env',
      'echo "GIT_ASKPASS=/x git fetch" |& sh', "printf '%s' 'export PAGER=less' | cat | sh", 'echo "env -i git fetch" | sh', 'echo "git -p log" | sh',
      'echo "GIT_ASKPASS=/x git fetch" | (sh)', 'echo "GIT_ASKPASS=/x git fetch" | { sh; }', 'echo "GIT_ASKPASS=/x git fetch" |\nsh',
      'echo "GIT_ASKPASS=/x git fetch" | while read l; do eval "$l"; done',
      'sh <<< "GIT_ASKPASS=/x git fetch"', "bash <<< 'env -i git fetch'", 'grep x <<< "GIT_ASKPASS docs" | sh',
      'echo "GIT_ASKPASS=/x git fetch" > >(sh)', "tee >(bash) <<< 'export PAGER=less'", 'echo "git -p log" > >(sh)',
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("Astra r17 High: a here-document on a redirection-only command is still read", () => {
    for (const held of [
      "<<EOF\n$(git -p log)\nEOF", "<<EOF\n$(GIT_ASKPASS=/x git fetch)\nEOF", "<<'EOF'\nGIT_ASKPASS docs\nEOF", "> f <<EOF\n$(env -i git fetch)\nEOF",
      "true; <<EOF\n`git -p log`\nEOF",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("Astra r18 High: an empty delimiter is read, and one that cannot be read holds", () => {
    for (const held of [
      "<<''\n\ngit -p log", "cat <<'' | sh\ngit -p log\n\n", 'cat <<"" | sh\nenv -i git fetch\n\n', "cat <<''\ntext\n\ngit -p log",
      "cat <<$'EOF' | sh\ngit -p log\nEOF", "cat <<\"E$x\" | sh\ngit -p log\nE$x", "cat << | sh\ngit -p log", "x=$(cat <<'E\nOF'\ngit -p log\n)",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
    expect(pinOverrideIn("cat <<''\nplain text\n\necho done", pins)).toBeNull();
  });

  it("Astra r19 High: a body whose end cannot be read with certainty, or that never closes, holds", () => {
    for (const held of [
      // an unquoted delimiter: bash and zsh join a backslash-newline before comparing the line, dash does not, so where the body
      // ends is not known; the reader never guesses
      "cat <<EOF\n'\nEO\\\nF\ngit -p log\n", "cat <<EOF\nEO\\\nF\ngit -p log", "cat <<-EOF\n\tEO\\\n\tF\nenv -i git fetch\n",
      "cat <<EOF | sh\ntext\nEOF\\\n\ngit -p log\n", "cat <<EOF\ntext \\\nEOF\ngit -p log\n", "cat <<EOF\nfoo \\\\\nEOF\ngit -p log\n",
      "cat <<EOF\n\"\nEO\\\nF\nGIT_ASKPASS=/x git fetch\n", "x=$(cat <<EOF\nEO\\\nF\ngit -p log\n)",
      // a body that never closes
      "cat <<EOF\ngit -p log\n", "cat <<'EOF'\ntext\nEOF \ngit -p log", "cat <<EOF\ntext\n  EOF\ngit -p log", "cat <<EOF", "cat <<EOF\n",
      "x=$(cat <<EOF\ntext\n)\ngit -p log", "cat <<EOF\ntext\nEOF\r\ngit -p log\n", "cat <<''\ntext\ngit -p log",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
    // a closed here-document is read as it was: a quoted delimiter ends on its physical line, a backslash in the body or not
    for (const ok of [
      "cat <<EOF\ntext\nEOF\necho done", "cat <<'EOF'\nfoo \\\n  bar\nEOF\necho done", "cat <<\\EOF\nfoo \\\nEOF\necho done",
      "cat <<\"EOF\"\nline \\\\\nEOF", "cat <<-'EOF'\n\tfoo \\\n\tEOF\necho done", "cat <<-EOF\n\ttext\n\tEOF\necho done", "cat <<EOF\ntext\nEOF",
      "cat <<EOF > f\ntext\nEOF\ncat <<'X'\na \\\nX\n", "cat <<''\nplain\n\necho done", "cat <<E'O'F\nfoo \\\nEOF\necho done",
      "x=$(cat <<EOF\ntext\nEOF\n); echo $x", "cat <<A <<B\none\nA\ntwo\nB\necho done",
    ]) expect(pinOverrideIn(ok, pins), ok).toBeNull();
    for (const held of [
      "cat <<'EOF'\nfoo \\\n  bar\nEOF\ngit -p log", "cat <<EOF\ntext\nEOF\nGIT_ASKPASS=/x git fetch", "cat <<'EOF'\nfoo \\\nEOF\nenv -i git fetch",
      "cat <<A <<B\none\nA\ntwo\nB\ngit -p log",
    ]) expect(pinOverrideIn(held, pins), held).not.toBeNull();
  });

  it("build r19 fallback: fed or not, a pin mention holds", () => {
    for (const ok of [
      'echo "GIT_ASKPASS docs" | grep x', 'git commit -m "engine pins GIT_ASKPASS and PAGER"', "echo 'GIT_ASKPASS=/x' | tee notes.md | wc -l",
      'grep -rn GIT_ASKPASS src | head -20', "echo 'set PAGER=less' | cut -c1-5 | tr a-z A-Z", 'git log --grep=GIT_SSH_COMMAND || echo "no TERM"',
      'grep TERM <<< "a b"',
    ]) expect(pinOverrideIn(ok, pins) === null, ok).toBe(!PIN_MENTION.test(ok));
  });
});
