# cfix7-winscen — OPEN assertion-wrapper scope clarification

Baseline HEAD and hub dev/1019-winscen both verified as 6efb9becdd94b874904d928d13938138a67493d9. No commit or push yet.

The binding p11f MAIN Scope section is copied verbatim into scripts/windows/SCANNER-SCOPE.md and linked from the scanner header. The scanner adds constructor and Reflect member bans plus computed-function call/apply/bind checks, including local variable aliases with lexical symbol identity. No existing source other than scan-native.mjs has been edited.

RED first: cfix7-red-crev6.log shows the exact `(()=>{}).constructor('process.kill(123)')();` input in isolated nested/test.mjs failing its rejection assertion against the original scanner. Hostile input is parsed as data, never executed.

GREEN focused: cfix7-scanner-tests.log records 12/12 passing tests: crev6 exact input, 81/81 new banned cases across JS/MJS/CJS, 15/15 new allowed cases, 94/94 p11e and 57/57 p11d hostile fixtures, 45/45 p11e allowed cases, earlier exact reviewer inputs, and malformed/missing-parser fail-closed checks. Valid hostile fixtures have zero parse failures.

Mutant: cfix7-mutants.log and cfix7-mutant-constructor.log prove one real mutant removes only the constructor ban and goes RED on the exact crev6 assertion, exit 1. cfix7-source-restoration.log verifies restoration against cfix7-scanner.sha256.

OPEN: cfix7-first-tree-check.log (also cfix7-tests.log) records 20/22 passing tests. The two whole-tree tests fail because packaged-scenario.mjs lines 6 and 7 contain pre-existing Reflect.apply calls in its assertion-counting proxy. The required Reflect ban flags both. The user's instruction to keep everything else unchanged requires clarification before editing that driver; an asynchronous question is pending. No exemption or acceptance assertion was weakened.

A concrete proposed patch is at /work/build/cfix7-winscen/assertion-wrapper.patch. It replaces the proxy with direct wrappers for the only three used forms: assert(), assert.equal(), assert.match(). The proposed code was verified in an isolated container fixture: each success increments once, each failure throws without incrementing, and the proposed driver has zero JavaScript scanner findings (cfix7-proposed-wrappers.log). This patch has NOT been applied to packaged-scenario.mjs. The fixture source is retained at /work/build/cfix7-winscen/preview-assertions.mjs.

All test execution used /work/fuigo-builds/tools/it-remote.sh with IT_JOB=cfix7-winscen, IT_W=/work/build/winscen/wt, IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh. One container at a time on murage-vt1; measured host and runner loads remained below 85. PowerShell 7.4.2 was used as parser tooling. No live app or Windows runtime verification is claimed. Launcher, ownership, deadlines, Desktop NEVER list, and PowerShell/batch parser sources are unchanged. No credentials, billable services, or vtq were used.

Cleanup is recorded in cfix7-cleanup.log. Job-created node_modules and PowerShell tooling were removed; all containers used --rm. Raw logs are retained in /work/build/cfix7-winscen/raw-logs/. Working changes and reviewable evidence remain pending the scope answer.
