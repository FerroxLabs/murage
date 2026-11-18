#!/bin/bash
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
D=server/email/exec-spec/restore
node "$D/clause-mutants/gen.mjs" "$D/invariants.current.ts" "$D/clause-mutants"
CM_RUN=1 CM_STRICT=1 node node_modules/vitest/vitest.mjs run "$D/clause-mutants.test.ts" --testTimeout=600000
