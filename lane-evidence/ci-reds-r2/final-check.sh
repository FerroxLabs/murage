#!/bin/bash
set -euo pipefail
node_modules/.bin/vitest run server/powershell-json-array.test.ts server/channels/signal/process-host.test.ts server/channels/signal/storage.test.ts server/channels/signal/service.test.ts scripts/win-gate/coverage.test.mjs scripts/win-gate/result.test.mjs > lane-evidence/ci-reds-r2/final-touched.log 2>&1
node --import ./server/testing/safe-wipe-preload.mjs --test scripts/windows/winbox-proof-audit.node-test.mjs scripts/windows/winbox-driver.node-test.mjs scripts/windows/ownership.node-test.mjs scripts/windows/safety.node-test.mjs > lane-evidence/ci-reds-r2/windows-tooling.log 2>&1
node --experimental-strip-types lane-evidence/ci-reds-r2/fixture-smoke.mjs > lane-evidence/ci-reds-r2/fixture-smoke.log 2>&1
node lane-evidence/ci-reds-r2/baseline-check.mjs > lane-evidence/ci-reds-r2/baseline-check.log 2>&1
