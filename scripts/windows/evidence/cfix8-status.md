# cfix8-winscen — approved wrapper change verified

Baseline: `6efb9becdd94b874904d928d13938138a67493d9` on `dev/1019-winscen`.
The user approved cfix7's proposed assertion-wrapper patch. All cfix7 scanner,
scope, regression tests, mutant harness, and historical evidence are preserved.
This result closes the scope question in `cfix7-status.md`.

`packaged-scenario.mjs` contains exactly the approved patch and no other changes
(`cfix8-driver-scope.log`). Direct wrappers replace the counting Proxy for
`assert()`, `assert.equal()`, and `assert.match()`.

- `cfix8-tests.log`: **22/22 pass**, zero failures or skips, including both
  recursive whole-tree scanner tests (p11b and p11c).
- `cfix8-assertion-check.log`: **6/6 successes** increment exactly once and
  **6/6 failures** throw without incrementing, executing declarations extracted
  from the patched driver. The driver itself is not launched.
- `cfix8-assertion-inventory.log`: full `rg -n '\b(nodeAssert|assert)\b'`
  inventory. All 45 scenario assertion call sites use wrappers: 17 `assert`,
  21 `assert.equal`, 7 `assert.match`. Direct nodeAssert calls at lines 5–7 are
  wrapper implementations. The only other direct call is the unchanged
  `nodeAssert(passed>0)` at line 122, a group-accounting invariant intentionally
  excluded from scenario counts. This lists the remaining direct use as allowed
  by the user's instruction; the approved patch leaves it unchanged.
- `cfix8-mutants.log` and `cfix8-mutant-constructor.log`: **RED**, constructor-ban
  removal fails the exact crev6 assertion with exit **1**, one failed test.
  The retained mutant fixture changes only import/source/output locations to
  preserve cfix7's historical log.
- `cfix8-source-restoration.log`: scanner and patched driver hashes match
  `cfix8-source.sha256` after the mutation run.

Reproduction: `cfix8-run-command.txt`, `cfix8-assertion-check.txt`, and
`cfix8-mutant-fixture.txt`. The parser was PowerShell 7.4.2. All test execution
used the required `it-remote.sh`, job `cfix8-winscen`, in one isolated container
on murage-vt1. Host and runner loads were below 85 (`cfix8-test-run.log`).
Fixtures operate on temporary data, with no live app or user data mutation.
No Windows runtime or packaged app behavior is claimed by these static tests.
No credentials, billable services, or vtq were used.

`cfix8-cleanup.log` records removal of job-created node_modules, parser tooling,
temporary fixtures, and the downloaded archive. No build output was created;
the auto-removed test container is gone. Original raw logs are retained under
`/work/fuigo-builds/swarm-b/cfix8-winscen/raw-logs/`. Push verification is recorded
at `/work/fuigo-builds/swarm-b/cfix8-winscen/push-verification.log`.
