#!/bin/bash
# Isolated offline containers only, through the job's it-remote.sh.
set -u
out=evidence/cfix3-busyA22
mkdir -p "$out/workflows"
: > "$out/summary.txt"
run_check() {
  name=$1
  shift
  "$@" > "$out/$name.log" 2>&1
  printf '%s=%s\n' "$name" "$?" >> "$out/summary.txt"
}
run_check reference env PYTHONDONTWRITEBYTECODE=1 python3 server/__fixtures__/flux-refusals/spec/busyloop_check.py server/__fixtures__/flux-refusals/prod-00000000
run_check fixtures env PYTHONDONTWRITEBYTECODE=1 python3 scripts/busyloop-review-fixtures.py
run_check parity env BUSYLOOP_EVIDENCE_DIR="$out/workflows" node_modules/.bin/vitest run server/busyloop-parity.test.ts server/drivers/busyloop-transport.test.ts server/drivers/busyloop-review.test.ts server/drivers/busyloop-sites.test.ts server/drivers/flux-json-reader.test.ts server/flux-refusal-integrity.test.ts
run_check workflows env BUSYLOOP_EVIDENCE_DIR="$out/workflows" node_modules/.bin/vitest run server/busyloop-room-goal.test.ts server/fuigo-captured-busyloop-api.test.ts server/gateway-busy-api.test.ts
run_check drivers node_modules/.bin/vitest run server/drivers/openai-chat.test.ts server/drivers/openai-compat.test.ts server/drivers/http-text-only.test.ts server/drivers/local-inject.test.ts server/drivers/codex-catalog.test.ts server/drivers/acp/acp.test.ts server/drivers/acp/fuigo.test.ts server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/headless-text-only.test.ts server/drivers/headless-text-only.flux-schema.test.ts server/drivers/cli-flux-budget.test.ts server/drivers/retry.test.ts
run_check added-drivers node_modules/.bin/vitest run server/drivers/antigravity.test.ts server/drivers/pi.test.ts server/drivers/muse-code.test.ts server/drivers/chat-mcp-client.test.ts server/drivers/pi-mcp-extension.test.ts server/plan-usage.test.ts
run_check neighbours node_modules/.bin/vitest run server/limit-continuation.test.ts server/memory/extract.test.ts server/memory/extraction-outcomes.test.ts server/gateway-busy.test.ts server/gateway-busy-repeat.test.ts server/harness/bus-sign-in.test.ts src/components/gateway-busy-hourly-ui.test.ts src/components/gateway-busy-recovery.dom.test.ts server/drivers/claude-auth.test.ts
run_check destination-and-background node_modules/.bin/vitest run server/drivers/acp/effective-destination.test.ts server/opencode-destination.test.ts server/local-tool-probe.test.ts server/voice/flux-voice.test.ts server/voice/dictation-cleanup.test.ts
run_check headers node_modules/.bin/vitest run server/flux-memory-headers.test.ts server/flux-memory-headers.lint.test.ts
run_check stop-gate node_modules/.bin/vitest run server/drivers/stop-gate.rules.test.ts
run_check server-types node_modules/.bin/tsc -p tsconfig.server.json --noEmit
run_check client-types node_modules/.bin/tsc -p tsconfig.json --noEmit
run_check stream-types node_modules/.bin/tsc -p tools/flux-stream-conformance/tsconfig.json --noEmit
run_check gates node scripts/ci-test-tiers.mjs check
run_check sinks node scripts/busyloop-sinks.mjs
node scripts/busyloop-sites.mjs > "$out/final-sites.json"
printf 'sites=%s\n' "$?" >> "$out/summary.txt"
cat "$out/summary.txt"
if grep -Eq '=[1-9][0-9]*$' "$out/summary.txt"; then exit 1; fi
