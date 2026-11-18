# ci-reds-r2 verification

Base: b45d7db77897a5ae38bc6f0356c3048998799a3d (product code identical to the supplied 5138c3ed).

All runtime checks used `/workspace/tools/it-remote.sh`, `IT_JOB=ci-reds-r2`, the requested worktree and generic fallback, with network none. Four sequential containers were used, on fixture-runner and murage-build3. No Windows, Mac, live user profile or billable engine was accessed.

1. Before editing the scripts: `node_modules/.bin/vitest run server/powershell-json-array.test.ts`. Exit 1, expected RED: the test names both Signal parsers. Full receipt: array-red.log.
2. `node_modules/.bin/vitest run server/powershell-json-array.test.ts server/no-powershell-spawn.test.ts server/channels/signal`. Exit 1: 664 passed, 12 failed, 13 existing platform skips. Full receipt: signal-green.log (the filename was chosen before the run; its failures are preserved).
3. `bash lane-evidence/ci-reds-r2/final-check.sh`. Exit 0. Final touched Vitest suite: 209 passed, 13 existing platform skips; Windows tooling node tests: 40 passed; isolated Doctor fixture passed and cleaned up. Then baseline-check.mjs reruns the original assertions against final and starting product source, preserving identical 12 failed names. Full logs and source snapshots retained; temporary source restoration completed in finally.
4. `bash lane-evidence/ci-reds-r2/static-check.sh`. Exit 0. CI test-tier registration and exact Signal source/invocation pins passed.

`fixture-info.json` records the owned launch URL, PID, isolated data directory and original persistent log path; `fixture-doctor.json`, `fixture-server.log` and `fixture-smoke.log` record the result and cleanup. Only the documented verification launcher and shared control adapter were used.

No test was removed, newly skipped or weakened. The permitted win32 symlink expectation retains the no-spawn assertion. Real Windows reader qualification tests remain in place, including T-MODES and full/CLM reader tests, and their platform requirements remain unchanged. This Linux run cannot qualify native Windows behavior.

The broad guard remains red due to pre-existing names-only drift and non-Signal shell-option findings; the two transport fixtures remain red on custody before child spawn. Their baseline/current complete receipts and comparison.json are the evidence. No globally green release claim is made.

See SWEEP.md for all eight fixed array readers and the fixture-only ACL assessment.
