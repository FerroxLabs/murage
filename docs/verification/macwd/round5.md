# MACWD round 5

Item 1: `node --test --test-name-pattern='T27 restart with changed artifact' electron/backup-schedule-host.node-test.mjs`
failed with `ReferenceError: desktopRecoveryMode is not defined` in the strict
wrapper with both seeds removed (1 failed). Adding the two false seeds passed
(1 passed), including assertions that both resulting flags are true.

Item 2: replaced state seeding with setup/configure/run-now IPC and the app's
real offline relaunch arguments. A disposable app copy wraps the original
coordinator save, stops only after its durable write, and records the exact PID,
file and phase. The supplied app is never modified. The copy retains the original executable signatures and changes only external
JavaScript resources; it qualifies interruption behavior, not release signing. The driver supports a
built development tree or a `.app` path. `node --check` passed.

`Mac kill boundary observes real durable coordinator operations` runs the real
coordinator through all three transitions and checks the on-disk phase at each
stop. Removing the commit observer made that test fail; restoring it passed.
The portable argument test passed. The new Node suite has a gate wrapper and
both files have tier rows. The Mac GUI case itself has not been run here.

Item 3: the driver snapshots PID/PPID relationships, freezes descendants until
no more appear, then SIGKILLs that exact tree. It records killed PIDs, checks a
live child lease holder belongs to that tree, and waits for all holders to die
before relaunch. Recovery's data-code is checked for LEASE_CHILD_BUSY. A pure
PID-list test covers unordered grandchildren and unrelated applications.
Replacing collection with only the root PID failed that test; restored
collection passed (2 portable tests). Syntax check passed. GUI behavior remains
unrun here.

Item 4: setup selects a real profile backup destination, and the app's first
capture writes and verifies the archive there. The driver ties its baseline to
the configured destination reference and receipt name/size/SHA-256, then
compares destination bytes after each restart and review clearing. Case-folder
archive copies are gone. The portable test deliberately deletes the destination
archive while keeping an intact case copy, then changes its bytes; both must
fail comparison. Reverting the comparator to read the case copy made the test
red (`Missing expected exception`); destination reads passed (3 tests). Syntax
check passed. No claim is made that the Mac GUI run passed.

Item 5: restart polling reads `#error.dataset.code` and classifies the actual
`recovery/index.html` URL, including a pause-only page with no error code.
Checks run while waiting for coordinator reconciliation as well as workspace
opening. STARTUP_FAILED and LEASE_CHILD_BUSY are diagnostic failures even if
body text never contains them. Restoring the old URL-only detection made the
portable classifier test fail; the corrected classifier passed (4 tests).
Syntax check passed.

Final local verification:

- Touched Node tests and immediate neighbours: 315 tests, 312 passed, 3
  skipped, zero failed. Command: `node --import ./server/testing/safe-wipe-preload.mjs --test electron/backup-schedule-host.node-test.mjs electron/macwd-kill.node-test.mjs electron/mac-install-guard.node-test.mjs electron/update-start-gate.node-test.mjs electron/data-dir-lease.node-test.mjs electron/backup-failure-notice.node-test.mjs electron/installation-recovery-window.node-test.mjs`.
- Broader backup, Mac, updater, recovery and lease suites under the non-root
  container user: 781 tests, 767 passed, 13 skipped, one Git ownership-check
  failure in backup-size-ceiling. That file passed when rerun as the checkout
  owner (4 tests). Earlier root runs hit intentional UID-zero refusals; a
  TMPDIR override also conflicted with lease fixtures using literal `/tmp`.
  The final runs use the normal OS temp directory and the existing verified
  `scratch/age-tools` through `MURAGE_BACKUP_TEST_AGE_DIR`. Temporary traversal
  access for the non-root run was restored in the runner's finally block.
- `tsc -b` passed. `tsc -p tsconfig.server.json` passed with
  `NODE_OPTIONS=--max-old-space-size=12288` after the default heap ran out.
- `vitest run electron/macwd-kill.test.mjs` passed.
- `node --check` passed for kill-cases, kill-support and qualification-hook.
- `node scripts/ci-test-tiers.mjs check` passed: 3475 files, 1987 gate,
  1488 extended. `git diff --check` passed.

Not run: Mac GUI kill qualification (`node scripts/macwd/qualify-native.mjs --kill-cases
/path/to/Murage.app`), including native relaunch, native process-tree killing,
and destination preservation in that GUI run. The portable checks above do
not claim those native operations passed. Platform-only suites and the old
opt-in seed fixture retain their normal skips.
