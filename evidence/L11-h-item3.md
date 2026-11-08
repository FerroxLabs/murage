# L11 relay 6: phone-call step-up label and verification

Cause: server/route-policy.ts:161 added the wildcard phone-call owner route without
an Electron label or coverage sample. On unchanged 8f30212c28 the Vitest coverage
assertion failed for exactly that route (../evidence/L11-h-initial.log).

Added the shipped string "Manage bot phone calls" in
electron/cloud-step-up-label.mjs:118, key STEP_UP_LABELS entry with methods "*"
and path /^\/api\/phone-calls(?:\/|$)/, field label. This module uses inline labels;
there is no new en.json key. scripts/copy-review.mjs does not exist at starting HEAD.
Samples at electron/cloud-step-up-label.test.mjs:50 cover setup, settings, cancel,
share and the collection. A further assertion checks that the displayed message
contains neither credentials nor call contents. Existing checks are unchanged.

## Commands and results

Commands ran from the repository with Node 24.21.0. pnpm was absent from PATH;
the installed node_modules/.bin executables were used directly.

- Initial reproduction: node_modules/.bin/vitest run server/attachment-read-gate.test.ts server/write-tx.structure.test.ts electron/cloud-step-up-label.test.mjs
  Two server files passed, Electron failed: 18 passed tests and 1 failed.
- Neighbours: node_modules/.bin/vitest run server/attachment-read-gate.test.ts server/write-tx.structure.test.ts server/write-tx.test.ts server/attachment-read.test.ts server/attachment-read-callers.test.ts server/attachment-read-http.test.ts server/downgrade-102-schema.test.ts server/downgrade-102-data-dir.test.ts server/phone-downgrade-atomic.test.ts server/phone-calls-downgrade.test.ts server/phone-calls-backup.test.ts server/phone-calls electron/cloud-step-up-label.test.mjs
  Passed: 18 files, 179 tests. Log: ../evidence/L11-h-neighbours.log.
- node_modules/.bin/vitest run server/store-engine-cas.test.ts
  Ran alone once: 20 tests passed. No changes. Log: ../evidence/L11-h-store-alone.log.
- NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -b
  Passed, no diagnostics. Log: ../evidence/L11-h-tsc-app.log.
- NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
  Passed, no diagnostics. Log: ../evidence/L11-h-tsc-server.log.
- node scripts/ci-test-tiers.mjs check
  Passed: 3484 files, 1996 gate, 1488 extended. Log: ../evidence/L11-h-tiers.log.
- node --test electron/cloud-step-up-label.test.mjs
  Executed before and after the edit. Both fail before assertions because this file
  imports Vitest: TypeError reading runner.config in @vitest/runner. This file is
  included by vite.config.ts. The Vitest run passed all 14 tests after the edit.
  Logs: ../evidence/L11-h-node-label-before.log and L11-h-node-label-after.log.
- git diff --check passed.

## Isolated fixture

Launched node --experimental-strip-types scripts/control-murage.ts launch.
URL http://127.0.0.1:22313; PID 306; dataDir /tmp/murage-verify-data-gunFja;
persistent log /tmp/murage-verification-evidence/server-1794008325430-285.log.
All drive commands used MURAGE_DATA_DIR=/tmp/murage-verify-data-gunFja and
node --experimental-strip-types scripts/control-murage.ts with that explicit URL:
doctor; new-bot --name L11Relay6; send --bot ac710b1b-9ec6-4d73-9e87-fdc0734b5316
--text hello; wait --bot ac710b1b-9ec6-4d73-9e87-fdc0734b5316 --timeout 30;
messages --bot ac710b1b-9ec6-4d73-9e87-fdc0734b5316 --limit 10.
Evidence JSON is in ../evidence/L11-h-{doctor,new-bot,send,wait,messages}.json.
Wait returned settled and messages contained "hello from fake claude".
Sent SIGINT to the exact launcher PID 285; exit 0 and data-directory removal
confirmed. No live app data was used. This verifies fixture chat, not a real
phone call or a native Electron confirmation dialog.

## Not run

The entire 10-shard rig, base replay, real phone-provider calls, and native Electron
UI interaction were not run. No copy-review command was available or needed for an
en.json key. The requested Node test was run and failed; it is not a skipped check.

## Reproducible source identity

These files still match git show 8f30212c28:<path> byte for byte:

- server/attachment-read-gate.inventory.json: SHA-256 a152e708032cb18e2e42ddbe6bdb918ae735be2f2f9a840d51306b75e485a66e
- server/attachment-read-gate.test.ts: SHA-256 9d8cc6ac8d808ff411e6650a9839b2423e04019b0d5e30d737da32ed47f44459
- server/write-tx.structure.test.ts: SHA-256 bd0cec3723a3a1aa44f983ceb41deeb631057f36c2df6ecee8ba3a9c2b144565
- server/installation-app-schema-downgrade.ts: SHA-256 f24755468536aff2c0efcca810876bca7fd2384c972c07caa554d1049ed45118

## Full server structural set

After the neighbour run, selected every server/**/*.structure.test.ts and every
server/**/*-gate.test.ts with pathlib.rglob, then invoked node_modules/.bin/vitest
run with all 14 paths. All 14 files and 304 tests passed (178.02 seconds).
Exact selection: ../evidence/L11-h-structural-files.txt.
Log: ../evidence/L11-h-structural.log.
Both unchanged gates passed again in this full structural selection.

Files run:

- server/attachment-read-gate.test.ts
- server/data-writers-gate.test.ts
- server/drivers/pi-permission-gate.test.ts
- server/drivers/turn-refusal.structure.test.ts
- server/env-fence.structure.test.ts
- server/handoff-dispatch.structure.test.ts
- server/launch-no-tty.structure.test.ts
- server/lee-phantom-gate.test.ts
- server/memory/branch-read-gate.test.ts
- server/memory/candidate-gate.test.ts
- server/memory/memory-gate.test.ts
- server/path-resolution.structure.test.ts
- server/screen-frame-gate.test.ts
- server/write-tx.structure.test.ts
