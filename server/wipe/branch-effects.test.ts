// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inert strings; filesystem decisions use neutral fixture ports.
import { expect, it } from 'vitest';
import { wipeBreaker, type WipeContext } from '../wipe-breaker.ts';
const context:WipeContext={platform:'linux',cwd:'/work/project',project:'/work/project',home:'/home/owner',dataDir:'/fixture/data',pathPort:{realpath:p=>p,isBlockDevice:()=>false},mountInventory:{contains:()=>false}};
it.each([
 'D=/usr; true && D=/tmp/x && rm -rf "$D"',
 'D=/usr; true && D=/tmp; rm -rf "$D"',
 'D=/usr; true && D=/tmp && true; rm -rf "$D"',
 'D=/usr; true && D=/tmp || true; rm -rf "$D"',
 'D=/; true || D=/tmp && D=/x; rm -rf "$D"',
 'D=/; if true; then D=/tmp; fi; rm -rf "$D"',
 'D=/; if true; then D=/tmp; else D=/; fi; rm -rf "$D"',
 'D=/; if false; then D=/; else D=/tmp; fi; rm -rf "$D"',
 'false && rm -rf /',
 'true || rm -rf /',
])('literal Boolean flow leaves ordinary work runnable: %s',command=>{
 // MAIN RULING WIPE-GATE-BAR a80c9d550d ASKAPI-10/22: preserve named root alternatives in both conditional state branches.
 // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION (integration train 5): a branch the shell provably skips, and the unselected arm of a conditional, still card; text written in the command is never dropped from inspection.
 const retainsRoot=new Set(['D=/; if true; then D=/tmp; else D=/; fi; rm -rf "$D"','D=/; if false; then D=/; else D=/tmp; fi; rm -rf "$D"','D=/; if true; then D=/tmp; fi; rm -rf "$D"','false && rm -rf /','true || rm -rf /']);
 if(retainsRoot.has(command))expect(wipeBreaker(command,context)).toBeTruthy();
 else expect(wipeBreaker(command,context)).toBeNull();
});
it.each([
 'D=/usr; false && D=/tmp; rm -rf "$D"',
 'true || D=/; rm -rf "$D"',
 'if true; then work(){ ls; }; else work(){ rm -rf /; }; fi; work',
 'D=/tmp; true && D=/; rm -rf "$D"',
 'D=/tmp; false || D=/; rm -rf "$D"',
 'D=/tmp; if true; then D=/; fi; rm -rf "$D"',
 'D=/tmp; if false; then D=/tmp; else D=/; fi; rm -rf "$D"',
 'D=/tmp; if condition; then D=/; fi; rm -rf "$D"',
 'true(){ false; }; D=/usr; true && D=/tmp; rm -rf "$D"',
 'false(){ true; }; D=/tmp; false && D=/; rm -rf "$D"',
 "false(){ true; }; export -f false; bash -c 'false && rm -rf /'",
 "work(){ false && rm -rf /; }; false(){ true; }; work",
 'false(){ true; }; echo "$(false && rm -rf /)"',
])('executed or possible root alternatives keep their cards: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each(['Set-Location C:\\; Remove-Item -Recurse *','& Remove-Item -Recurse -Force C:\\'])('PowerShell invocation retains drive-root evidence: %s',command=>expect(wipeBreaker(command,context)?.rule).toBe('delete-root'));
it('PowerShell invocation keeps its ordinary directory twin',()=>expect(wipeBreaker('& Remove-Item -Recurse /tmp/cache',context)).toBeNull());
it('find execdir preserves a literal absolute wipe when entry cwd is unknown',()=>{
 const unknown={...context,cwd:undefined,project:undefined};
 expect(wipeBreaker('find . -name x -execdir rm -rf / \\;',unknown)?.rule).toBe('delete-root');
 expect(wipeBreaker('find . -name x -execdir rm -rf cache \\;',unknown)).toBeNull();
 expect(wipeBreaker('find . -name x -execdir rm -rf {} \\;',unknown)).toBeNull();
});
it('a possible disk redirection is not lost behind its ordinary first alternative',()=>{
 expect(wipeBreaker('D=/tmp/image; if condition; then D=/dev/sdz9; fi; cat x > "$D"',context)?.rule).toBe('disk-erase');
 expect(wipeBreaker('D=/tmp/image; if condition; then D=/tmp/other; fi; cat x > "$D"',context)).toBeNull();
});
it('cd keeps all possible roots for the following glob',()=>{
 expect(wipeBreaker('D=/tmp; if condition; then D=/; fi; cd "$D" && rm -rf *',context)?.rule).toBe('delete-root');
 expect(wipeBreaker('D=/tmp; if condition; then D=/tmp/other; fi; cd "$D" && rm -rf *',context)).toBeNull();
});

// Review regressions: these commands are inspected, never executed.
it.each([
 ['! false && rm -rf ~', 'delete-home'],
 ['! true || rm -rf ~', 'delete-home'],
 ['! ! true && rm -rf ~', 'delete-home'],
 ['! ! false || rm -rf ~', 'delete-home'],
 ['! unknown-command && rm -rf ~', 'delete-home'],
 ['! false | true || rm -rf ~', 'delete-home'],
 ['false(){ true; }; ! false || rm -rf ~', 'delete-home'],
])('negated Boolean flow retains executable wipe: %s', (command, rule) => {
 expect(wipeBreaker(command, context)?.rule).toBe(rule);
});
// MAIN RULING 1114-WIPE-FIXTURE-DIRECTION: unreachable branches still card, so the lane's runnable rows for them are not carried; only ordinary cleanup stays runnable.
it.each([
 '! false && rm -rf /tmp/cache',
 '! true || rm -rf /tmp/cache',
])('negated Boolean flow keeps ordinary cleanup runnable: %s', command => {
 expect(wipeBreaker(command, context)).toBeNull();
});
it.each([
 'true < /missing-fixture-file || rm -rf ~',
 ': < /missing-fixture-file || rm -rf ~',
 '< /missing-fixture-file true || rm -rf ~',
 'true > /missing-fixture-dir/output || rm -rf ~',
 'true 1>&9 || rm -rf ~',
 '! false < /missing-fixture-file && rm -rf ~',
])('redirected Boolean flow retains a possible wipe after IO failure: %s', command => {
 expect(wipeBreaker(command, context)?.rule).toBe('delete-home');
});
it.each([
 'true < /missing-fixture-file || rm -rf /tmp/cache',
 'false < /missing-fixture-file || rm -rf /tmp/cache',
 'true > /missing-fixture-dir/output || rm -rf /tmp/cache',
])('redirected Boolean flow keeps ordinary cleanup runnable: %s', command => {
 expect(wipeBreaker(command, context)).toBeNull();
});

// REVIEW-FIX (MAIN RULING 2026-11-17T04:54Z): a negated Boolean gives no certainty about the assignment that follows it.
it.each([
 'D=/usr; ! true && D=/tmp; /bin/rm -rf "$D"',
 'D=/usr; ! : && D=/tmp; rm -rf "$D"',
 'D=/usr; ! X=1 && D=/tmp; rm -rf "$D"',
 'D=/usr; ! ! true && D=/tmp; rm -rf "$D"',
])('a negated Boolean keeps the value the skipped assignment would have replaced: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it('a negated Boolean keeps its ordinary directory twin runnable',()=>expect(wipeBreaker('D=/var/tmp/cache; ! true && D=/tmp/x; /bin/rm -rf "$D"',context)).toBeNull());
// REVIEW-FIX: text read under a shell state that already redefines true, false or `:` keeps no Boolean certainty.
it.each([
 "true(){ false; }; export -f true; bash -c 'D=/usr; true && D=/tmp; /bin/rm -rf \"$D\"'",
 ":(){ false; }; export -f :; bash -c 'D=/usr; : && D=/tmp; /bin/rm -rf \"$D\"'",
 "true(){ false; }; export -f true; bash -c 'bash -c \"D=/usr; true && D=/tmp; /bin/rm -rf \\\"\\$D\\\"\"'",
 "true(){ false; }; D=/usr; trap 'true && D=/tmp; /bin/rm -rf \"$D\"' EXIT",
])('a redefined Boolean reaches text parsed later under the same state: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 "true(){ false; }; bash -c 'D=/usr; true && D=/tmp; /bin/rm -rf \"$D\"'",
 "work(){ ls; }; export -f work; bash -c 'D=/usr; true && D=/tmp; /bin/rm -rf \"$D\"'",
])('a child shell without an inherited Boolean keeps its certainty: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
// REVIEW-FIX: only an executable definition or command removes certainty; the same words as inert arguments do not.
it.each([
 'echo source; D=/usr; true && D=/tmp; rm -rf "$D"',
 'echo eval alias; D=/usr; true && D=/tmp; rm -rf "$D"',
 "echo 'true() { false; }'; D=/usr; true && D=/tmp; rm -rf \"$D\"",
 'git commit -m "function true"; D=/usr; true && D=/tmp; rm -rf "$D"',
 'D=/usr; true && D=/tmp; rm -rf "$D" # eval',
])('inert Boolean-shadow words leave ordinary work runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
it.each([
 'eval "$X"; D=/usr; true && D=/tmp; rm -rf "$D"',
 'source ./lib.sh; D=/usr; true && D=/tmp; rm -rf "$D"',
 '. ./lib.sh; D=/usr; true && D=/tmp; rm -rf "$D"',
 'alias true=false; D=/usr; true && D=/tmp; rm -rf "$D"',
 'command eval "$X"; D=/usr; true && D=/tmp; rm -rf "$D"',
 'builtin source ./lib.sh; D=/usr; true && D=/tmp; rm -rf "$D"',
 'X=1 eval "$Y"; D=/usr; true && D=/tmp; rm -rf "$D"',
 'function true { false; }; D=/usr; true && D=/tmp; rm -rf "$D"',
 'true() ( exit 1 ); D=/usr; true && D=/tmp; rm -rf "$D"',
 'true() if :; then false; fi; D=/usr; true && D=/tmp; rm -rf "$D"',
 'setup(){ true(){ false; }; }; setup; D=/usr; true && D=/tmp; rm -rf "$D"',
 'echo ok | source /proc/self/fd/0; D=/usr; true && D=/tmp; rm -rf "$D"',
 'D=/usr; true && D=/tmp; rm -rf "$D"; true(){ false; }',
])('an executable Boolean shadow removes certainty: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());

// REVIEW-FIX (MAIN RULING 2026-11-17T06:40Z): eval text runs in the calling shell, so it keeps no Boolean certainty of its own
// (an earlier function, alias or eval may have redefined true, false or `:`), and an eval that may be skipped only adds alternatives.
it.each([
 "true(){ false; }; D=/usr; eval 'true && D=/tmp'; /bin/rm -rf \"$D\"",
 "alias true=false; D=/usr; eval 'true && D=/tmp'; rm -rf \"$D\"",
 "D=/usr; eval 'true(){ false; }'; eval 'true && D=/tmp'; rm -rf \"$D\"",
])('eval text keeps the value a redefined Boolean would have left in place: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 "D=/usr; false && eval 'D=/tmp'; /bin/rm -rf \"$D\"",
 "D=/usr; if condition; then eval 'D=/tmp'; fi; rm -rf \"$D\"",
 "D=/usr; true || eval 'D=/tmp'; rm -rf \"$D\"",
])('an eval that may be skipped keeps the earlier value: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 "D=/var/tmp/cache; eval 'true && D=/tmp/x'; /bin/rm -rf \"$D\"",
 "true(){ false; }; D=/var/tmp/cache; eval 'true && D=/tmp/x'; rm -rf \"$D\"",
 "D=/var/tmp/cache; false && eval 'D=/tmp/x'; rm -rf \"$D\"",
 "D=/usr; eval 'D=/tmp/x'; rm -rf \"$D\"",
])('eval keeps ordinary cleanup runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
// REVIEW-FIX: a brace group behind an and/or list may be skipped, so its assignments only add alternatives.
it.each([
 'D=/usr; false && { D=/tmp; }; /bin/rm -rf "$D"',
 'D=/usr; true || { D=/tmp; }; rm -rf "$D"',
 'D=/usr; condition && { D=/tmp; }; rm -rf "$D"',
 'D=/usr; condition || { echo skip; D=/tmp; }; rm -rf "$D"',
])('a brace group that may be skipped keeps the earlier value: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'D=/var/tmp/cache; false && { D=/tmp/x; }; /bin/rm -rf "$D"',
 'D=/usr; true && { D=/tmp; }; rm -rf "$D"',
 'D=/usr; { D=/tmp; }; rm -rf "$D"',
])('a brace group keeps ordinary cleanup runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
// REVIEW-FIX: a function definition behind an and/or list may be skipped, so the earlier body stays callable.
it.each([
 'work(){ rm -rf /; }; false && work(){ ls; }; work',
 'work(){ rm -rf /; }; condition || work(){ ls; }; work',
 'work(){ rm -rf /; }; false && function work { ls; }; work',
 // REVIEW-FIX arev-conf-new3g4e-n6: a definition inside a skipped group or eval inherits that uncertainty.
 'work(){ /bin/rm -rf /usr; }; false && { work(){ ls; }; }; work',
 "work(){ /bin/rm -rf /usr; }; false && eval 'work(){ ls; }'; work",
])('a definition that may be skipped keeps the earlier body: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'work(){ rm -rf /tmp/cache; }; false && work(){ ls; }; work',
 'work(){ rm -rf /; }; work(){ ls; }; work',
 'work(){ rm -rf /tmp/cache; }; false && { work(){ ls; }; }; work',
 "work(){ rm -rf /tmp/cache; }; false && eval 'work(){ ls; }'; work",
 'work(){ rm -rf /; }; { work(){ ls; }; }; work',
 "work(){ rm -rf /; }; eval 'work(){ ls; }'; work",
])('a definition keeps ordinary cleanup runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
// REVIEW-FIX: trap text runs in the calling shell as well, so it keeps no Boolean certainty of its own.
it('trap text keeps the value an aliased Boolean would have left in place',()=>expect(wipeBreaker("alias true=false; D=/usr; trap 'true && D=/tmp; /bin/rm -rf \"$D\"' EXIT",context)).toBeTruthy());
it('trap text keeps ordinary cleanup runnable',()=>expect(wipeBreaker("D=/var/tmp/cache; trap 'true && D=/tmp/x; rm -rf \"$D\"' EXIT",context)).toBeNull());
// REVIEW-FIX arev-conf-new3g4e-n7: a builtin that may be skipped (unset, set --, read) only adds alternatives.
it.each([
 'D=/usr; false && unset D; /bin/rm -rf "$D"',
 'D=/usr; condition || unset D; /bin/rm -rf "$D"',
 'D=/usr; false && { unset D; }; /bin/rm -rf "$D"',
 "D=/usr; false && eval 'unset D'; /bin/rm -rf \"$D\"",
 'set -- /usr; false && set -- /tmp/cache; /bin/rm -rf "$1"',
 'set -- /usr; false && { set -- /tmp/cache; }; /bin/rm -rf "$1"',
 'set -- /usr; false && set --; /bin/rm -rf "$1"',
 'D=/usr; false && read D <<< /tmp/cache; /bin/rm -rf "$D"',
 // Every alternative of a positional parameter is read, not only the first.
 'condition && set -- /usr; /bin/rm -rf "$1"',
 'set -- ""; false && set -- /usr; /bin/rm -rf "$1"',
 'set -- /tmp/cache; condition && set -- /usr; /bin/rm -rf "$1"',
])('a builtin that may be skipped keeps the earlier value: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'D=/tmp/cache; false && unset D; /bin/rm -rf "$D"',
 'D=/usr; unset D; /bin/rm -rf "$D"',
 'D=/usr; { unset D; }; /bin/rm -rf "$D"',
 'set -- /tmp/cache; false && set -- /tmp/x; /bin/rm -rf "$1"',
 'set -- /usr; set -- /tmp/cache; /bin/rm -rf "$1"',
 'set -- /usr; { set -- /tmp/cache; }; /bin/rm -rf "$1"',
 'condition && set -- /tmp/x; /bin/rm -rf "$1"',
 'set -- /tmp/cache; condition && set -- /tmp/x; /bin/rm -rf "$1"',
 'D=/usr; read D <<< /tmp/cache; /bin/rm -rf "$D"',
])('a builtin keeps ordinary cleanup runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
// REVIEW-FIX arev-conf-new3g4e-n8 (MAIN RULING 09:59Z): only an alternative that provably aborts is dropped; every
// executable alternative of a variable or of the positional parameters is still read.
it.each([
 'D=/usr; false && unset D; /bin/rm -rf "${D:?}"',
 'D=/usr; condition || unset D; /bin/rm -rf "${D:?}"',
 'D=/usr; false && unset D; /bin/rm -rf "${D?}"',
 'D=/usr; if condition; then unset D; fi; /bin/rm -rf "${D:?}"',
 'D=/usr; case "$1" in x) unset D;; esac; /bin/rm -rf "${D:?}"',
 'D=/usr; condition && D=""; /bin/rm -rf "${D:?}"',
 'set -u; D=/usr; false && unset D; /bin/rm -rf "$D"',
 'set -- /tmp/cache; false || set -- /usr; /bin/rm -rf "$*"',
 'condition && set -- /usr; /bin/rm -rf "$*"',
 'set -- /tmp/cache; condition && set -- /usr; /bin/rm -rf $*',
 'set -- /tmp/cache; condition && set -- /usr; /bin/rm -rf "$@"',
 'set -- /tmp/cache; condition && set -- /usr; /bin/rm -rf "${*}"',
 'set -- tmp/cache; condition && set -- usr; /bin/rm -rf "/$@"',
 'set -- tmp/cache; condition && set -- usr; /bin/rm -rf "/$*"',
 'X=/tmp/cache; condition && X=/usr; read D <<< "$X"; /bin/rm -rf "$D"',
])('an executable alternative is still read: %s',command=>expect(wipeBreaker(command,context)).toBeTruthy());
it.each([
 'D=/tmp/cache; false && unset D; /bin/rm -rf "${D:?}"',
 'D=/usr; unset D; /bin/rm -rf "${D:?}"',
 'D=/tmp/cache; condition && D=""; /bin/rm -rf "${D:?}"',
 'set -- /tmp/cache; condition && set -- /tmp/x; /bin/rm -rf "$*"',
 'set -- /usr; set -- /tmp/cache; /bin/rm -rf "$*"',
 'set -- /tmp/cache; condition && set -- /tmp/x; /bin/rm -rf "$@"',
 'set -- tmp/cache; condition && set -- tmp/x; /bin/rm -rf "/$@"',
 'X=/tmp/cache; condition && X=/tmp/x; read D <<< "$X"; /bin/rm -rf "$D"',
 'D=/usr; read D <<EOF\n/tmp/cache\nEOF\n/bin/rm -rf "$D"',
])('an alternative that aborts or is harmless stays runnable: %s',command=>expect(wipeBreaker(command,context)).toBeNull());
