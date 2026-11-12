#!/bin/bash
# Run only through the isolated job container wrapper.
set -u
out=evidence/cfix-busyA22
mkdir -p "$out/final-room"
: > "$out/summary.txt"
run_check() {
  name=$1
  shift
  "$@" > "$out/$name.log" 2>&1
  printf '%s=%s\n' "$name" "$?" >> "$out/summary.txt"
}
run_check fixtures env PYTHONDONTWRITEBYTECODE=1 python3 scripts/busyloop-review-fixtures.py
run_check parity node_modules/.bin/vitest run server/busyloop-parity.test.ts server/drivers/busyloop-transport.test.ts server/drivers/busyloop-review.test.ts server/drivers/busyloop-sites.test.ts server/drivers/flux-json-reader.test.ts server/flux-refusal-integrity.test.ts
run_check workflows env BUSYLOOP_EVIDENCE_DIR="$out/final-room" node_modules/.bin/vitest run server/busyloop-room-goal.test.ts server/fuigo-captured-busyloop-api.test.ts server/gateway-busy-api.test.ts
run_check neighbours node_modules/.bin/vitest run server/drivers/openai-chat.test.ts server/drivers/openai-compat.test.ts server/drivers/http-text-only.test.ts server/drivers/local-inject.test.ts server/drivers/codex-catalog.test.ts server/drivers/acp/acp.test.ts server/drivers/acp/fuigo.test.ts server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/headless-text-only.test.ts server/drivers/cli-flux-budget.test.ts server/drivers/retry.test.ts server/limit-continuation.test.ts server/memory/extract.test.ts server/memory/extraction-outcomes.test.ts
run_check stop-gate node_modules/.bin/vitest run server/drivers/stop-gate.rules.test.ts
run_check server-types node_modules/.bin/tsc -p tsconfig.server.json --noEmit
run_check client-types node_modules/.bin/tsc -p tsconfig.json --noEmit
run_check gates node scripts/ci-test-tiers.mjs check
node scripts/busyloop-sites.mjs > "$out/final-sites.json"
printf 'sites=%s\n' "$?" >> "$out/summary.txt"
cat "$out/summary.txt"
if grep -Eq '=[1-9][0-9]*$' "$out/summary.txt"; then exit 1; fi
