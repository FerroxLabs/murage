#!/bin/bash
# Source preparation only. Invoke from the worktree before the container runner.
set -eu
mkdir -p .r13-baseline
 git archive abc0a5ea2fdd1e172f62f66868e44e88433c81ab server shared electron package.json | tar -x -C .r13-baseline
cp server/no-limits-r13.test.ts .r13-baseline/server/
cp server/testing/fixtures/no-limits-r13.json .r13-baseline/server/testing/fixtures/
ln -sfn /work/node_modules .r13-baseline/node_modules
cat > .r13-baseline/vitest.config.mjs <<'CONFIG'
export default { test: { environment: 'node', include: ['server/no-limits-r13.test.ts'], fileParallelism: false, maxWorkers: 1 } };
CONFIG
