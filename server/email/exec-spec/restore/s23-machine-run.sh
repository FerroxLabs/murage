#!/bin/bash
# Run through the integration adapter, for example it-remote.sh 'bash server/email/exec-spec/restore/s23-machine-run.sh 4'.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
mkdir -p .test-tmp/restore-model
export MC_RUN=1 EXEC_SPEC_DEPTH=${1:-4} WALKS=${WALKS:-40} MAXV=${MAXV:-5}
export EXEC_SPEC_REPORT=${EXEC_SPEC_REPORT:-.test-tmp/restore-model/mc.out.txt}
exec node node_modules/vitest/vitest.mjs run --testTimeout=6000000 server/email/exec-spec/restore/restore-reducer.test.ts
