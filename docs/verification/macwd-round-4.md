# MACWD round 4

The startup helper now runs the extracted production continuation in strict mode,
provides `desktopRecoveryMode` and `startupDecisionPending`, and checks both flags
against the paused outcome. The production branch was not changed.

The coordinator can save its validated projection of corrupt optional upgrade
metadata when an interrupted job moves to `needs-review`. Other upgrade writes
still reject corrupt metadata. The previous receipt and archives are preserved,
and the existing Clear review action works. No user-facing words changed.

## Red evidence

Commands ran from the repository root; logs are in `/tmp/macwd-round4`.

- `node --test --test-name-pattern='BF-G1 truly pending' electron/backup-schedule-host.node-test.mjs`
  initially passed because the old VM wrapper was sloppy. Adding `"use strict"`
  before supplying the missing globals failed with
  `ReferenceError: desktopRecoveryMode is not defined` (`scope-red.log`).
- With the corrected scope and assertions, temporarily changing the production
  pending branch to assign `desktopRecoveryMode=false` failed with
  `false !== true` at the new flag assertion (`branch-red.log`). The production
  source was restored before the green run.
- `node --test --test-name-pattern='BF-G1 corrupt' electron/backup-schedule-host.node-test.mjs`
  failed both new cases before the coordinator fix. Each threw
  `BACKUP_UPGRADE_REVIEW_REQUIRED` from `requireWritable` through
  `interruptIncomplete` (`corrupt-red.log`). Both now pass. Each starts at
  `handoff-prepared`, runs startup twice, checks the public review reason and
  workspace continuation, checks stable state and previous receipt, compares
  archive bytes, rules out recapture, and clears review.

## Checks

- Seven BF-G1 cases passed (`final-targeted.log`).
- `MURAGE_BACKUP_TEST_AGE_DIR=/tmp/macwd-round4/age node --import ./server/testing/safe-wipe-preload.mjs --test electron/backup-schedule-host.node-test.mjs electron/installation-recovery*.node-test.mjs electron/preupgrade-continuation.node-test.mjs electron/backup-offline-return.node-test.mjs electron/updater-coordinator.node-test.mjs`
  passed 322 tests; the opt-in native seed was skipped (`electron-green.log`).
  The first run had one missing-tool failure. The pinned tool was staged with
  `node scripts/prepare-backup-test-fixtures.mjs --tool-directory /tmp/macwd-round4/age`.
- The opt-in `native kill seed` test passed separately, using
  `MURAGE_MACWD_SEED=/tmp/macwd-round4/seed-check` (`seed-check.log`).
- `node node_modules/typescript/bin/tsc -b` passed (`tsc-app.log`).
  `pnpm` is not installed in this container.
- `node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.server.json`
  passed (`tsc-server-green.log`). The first attempt exhausted the default 4 GiB heap.
- `node scripts/ci-test-tiers.mjs check` passed: 3474 files, 1986 gate,
  1488 extended.
- Syntax checks passed for both native driver modules; `git diff --check` passed.
- The required isolated server fixture was launched with
  `node --experimental-strip-types scripts/control-murage.ts launch`.
  Its doctor check used `MURAGE_DATA_DIR=/tmp/murage-verify-data-1Fw46H` and
  `node --experimental-strip-types scripts/control-murage.ts doctor --url http://127.0.0.1:20766`.
  Doctor returned `ok: true` (`doctor.json`). The launcher was stopped with Ctrl-C.
  Server log: `/tmp/murage-verification-evidence/server-1794006292122-798.log`.
  This checks fixture health, not native desktop UI behavior.

## Mac qualification, not run here

Run on a Mac with the repository's Node dependencies installed:

```sh
node scripts/macwd/qualify-native.mjs --kill-cases /absolute/path/Murage.app
node scripts/macwd/qualify-native.mjs --kill-cases /absolute/path/dev-tree
```

A dev tree must have its built app under `release/mac-arm64`, `release/mac`,
`dist/mac-arm64`, or `dist/mac`. Unpackaged Electron deliberately does not start
this backup host. Build the normal package prerequisites and then run
`electron-builder --mac dir` before using the dev-tree form.

The driver opens the actual app with fresh home, data and user-data directories.
It seeds the committed job boundary and a previous fixture receipt/archive,
then sends SIGKILL to that exact app process at `handoff-prepared`,
`offline-claimed`, and `capturing`. Each case launches twice, requires review
and a workspace window rather than update pause or startup failure, and checks
the receipt, stable coordinator state, archive inventory and bytes. It reads the
public review state through the workspace IPC and clears review after the second
launch, checking that the receipt and archives remain. Scheduling
is disabled in the seeded record so the test cannot start another backup.
This tests interruption of committed states, not the native encryption tool.
The driver retains its private directory and writes per-case results there.

The native kill cases and native qualification registry generation were not run:
this container is not a Mac. Syntax checks and seed generation do not qualify a
packaged app.
