// SPDX-License-Identifier: AGPL-3.0-or-later
// Strings are inert. Recovery classification never executes the command.
import {expect,it} from 'vitest';
import {recoveryExecutesScript} from './no-limits-wipe-scripts.ts';
import {MountInventory} from './wipe/mounts.ts';
// Fixture repair: the ordinary /tmp Git cleanup is outside this caller's
// home/data/project roots, rather than above the runner's throwaway home.
const context={cwd:'/work',project:'/work',home:'/home/fixture',dataDir:'/home/fixture/.murage',mountInventory:new MountInventory(()=>[])};

it.each([
 "rg --pre=./cleanup.sh x README.md",
 "rg --pre ./cleanup.sh x README.md",
 "rg --pre-glob=*.md x README.md",
 "eval 'python3 -c \"exec(input())\"' < cleanup.py",
 "cat cleanup.py | eval 'python3 -c \"exec(input())\"' ",
 "ls >;",
 "git status",
 "grep ok README.md",
 "rg ok README.md",
 "cp a b",
 "mv a b",
 "file file",
 "which bash",
 "sort file",
 "cut -f1 file",
 "diff a b",
 "git diff",
 "git reset --soft",
 "git checkout branch",
 "git -C work status",
 "cat < README.md",
 "command -v bash",
 "command -V pypy3",
 "command ls -la",
 "builtin echo ok",
 "env ls -la",
 "sudo ls -la",
 "nice ls -la",
 "nohup ls -la",
 "timeout 5 ls -la",
 "time ls -la",
 "exec ls -la",
 "eval 'ls -la'",
 "rg --pre=./cleanup.sh x f",
 "rg --pre ./cleanup.sh x f",
 "git -c core.pager=./x log",
 "sort --compress-program=./x f",
 "find . -exec sh x \\;",
 "eval 'python3 -c \"exec(input())\"' < cleanup.py",
 "cat cleanup.py | eval 'python3 -c \"exec(input())\"' ",
 "eval \"eval 'python3 -c \\\"exec(input())\\\"'\" < cleanup.py",
 "ls >;",
 "ls --pre foo",
 "cat --exec foo",
 "echo --cmd ok",
 "printf --command ok",
 "ls --program foo",
 "ls --compress foo",
 "cat --config foo",
 "ls --hook foo",
 "ls --color=auto",
 "ls -l1",
 "cat -- foo",
 "cat < README.md",
 "cat <<< ok",
 "cat <<EOF\nok\nEOF",
 "echo ok | sh -c 'echo ok'",
 "bash -c 'echo ok' > out",
 "python3 -c 'print(1)' 2> err",
 "env bash -c 'echo ok'",
 "nohup bash -c 'echo ok'",
 "source README.md",
 ". README.md",

 'find . -exec bash cleanup.sh \\;', 'find . -execdir bash cleanup.sh \\;',
 'find . -ok bash cleanup.sh \\;', 'find . -okdir bash cleanup.sh \\;',
 'pypy3 cleanup.py', 'builtin source cleanup.sh', 'builtin . cleanup.sh',
 'xargs sh < list', './anything', 'bash -e cleanup.sh', 'ksh -e cleanup.sh',
 'bash -se < cleanup.sh', 'unknown cleanup.src', '/tmp/ls', './ls', 'LS',
 'env unknown cleanup.src', 'command unknown cleanup.src', 'exec unknown cleanup.src',
 'sudo unknown cleanup.src', 'nice unknown cleanup.src', 'nohup unknown cleanup.src',
 'timeout 5 unknown cleanup.src', 'time unknown cleanup.src',
 `eval 'unknown cleanup.src'`, `bash -c 'unknown cleanup.src'`,
 `bash -c 'builtin source cleanup.sh'`, `env -S 'pypy3 cleanup.py'`,
 'git clean -fd', 'git rm file', 'git reset --hard', 'git checkout -- .',
 'git -C /tmp clean -fd', 'git -c alias.foo=!cleanup.sh foo',
 'git --exec-path=/tmp status', 'git status; unknown',
 'cat "$FILE"', '$PROGRAM', 'echo $(unknown)', 'cat < "$FILE"',
 `bash -c 'echo ok' < list`, `cat list | bash -c 'echo ok'`,
 `xargs bash -c 'echo ok'`, `bash -c 'echo ok' cleanup.sh`,
 `BASH_ENV=cleanup.sh bash -c 'echo ok'`, `env BASH_ENV=cleanup.sh bash -c 'echo ok'`,
 `bash -c "$PROGRAM"`, `bash -c 'echo ok`, 'ls >', 'ls &&', '(ls',
 '&& ls', '| ls', '; ls', 'ls ; ; cat README.md', 'ls &; cat README.md',
 `BASH_ENV=cleanup.sh\nbash -c 'echo ok'`,
 'ls )', 'ls || || cat README.md', 'ls\0',
])(// MAIN RULING 2026-11-13 narrow-wipe (Sean)
'R6 recovery holds unclassified execution: %s',command=>expect(recoveryExecutesScript(command,context)).toBe(false));

it.each([
 'ls -la', 'cat README.md', 'echo ok', `bash -c 'echo ok'`,
 'head README.md', 'tail README.md', 'wc README.md',
 'pwd', 'cd work', 'mkdir work', 'touch file', 'stat file', 'date',
 'uniq file', 'tr a b', 'cut -f 1 file', 'cat foo=bar',
 'cat > ""', 'ls -la && cat README.md | head',
 `bash -c 'cat README.md'`, `python3 -c 'print("ok")'`,
 `node -e 'console.log("ok")'`, `node -e 'console.log(1)' | cat`,
])('R6 recovery permits classified commands: %s',command=>expect(recoveryExecutesScript(command,context)).toBe(false));

it.each(['printf \"%s\" ok','ls --all'])("R6 final excludes printf and long flags: %s",command=>{
 // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: ordinary printf and long flags
 // contain no wipe; the compatibility probe is no longer an exec allowlist.
 expect(recoveryExecutesScript(command,context)).toBe(false);
});

it('a real root wipe still stops recovery',()=>expect(recoveryExecutesScript('rm -rf /',context)).toBe(true));
