#!/bin/bash
# Isolated, offline container only; launch through it-remote.sh.
set -u
out=evidence/busyloop-a21
mkdir -p "$out/http"
node_modules/.bin/vitest run server/busyloop-parity.test.ts server/drivers/busyloop-transport.test.ts server/flux-refusal-integrity.test.ts > "$out/green-parity.log" 2>&1
printf 'parity=%s\n' "$?" > "$out/validation-summary.txt"
BUSYLOOP_EVIDENCE_DIR="$out/http" node_modules/.bin/vitest run server/fuigo-captured-busyloop-api.test.ts server/gateway-busy-api.test.ts > "$out/http.log" 2>&1
printf 'http=%s\n' "$?" >> "$out/validation-summary.txt"
node_modules/.bin/vitest run server/drivers/openai-chat.test.ts server/drivers/acp/acp.test.ts server/drivers/acp/fuigo.test.ts server/drivers/claude.test.ts server/drivers/claude-auth.test.ts server/drivers/cli-flux-budget.test.ts server/drivers/retry.test.ts server/gateway-busy.test.ts server/gateway-busy-repeat.test.ts server/harness/bus-sign-in.test.ts server/limit-continuation.test.ts src/components/gateway-busy-hourly-ui.test.ts src/components/gateway-busy-recovery.dom.test.ts > "$out/neighbours.log" 2>&1
printf 'neighbours=%s\n' "$?" >> "$out/validation-summary.txt"
for config in tsconfig.json tsconfig.server.json tools/flux-stream-conformance/tsconfig.json; do
  tag=$(printf %s "$config" | tr / _)
  node_modules/.bin/tsc -p "$config" --noEmit > "$out/$tag.log" 2>&1
  printf '%s=%s\n' "$config" "$?" >> "$out/validation-summary.txt"
done
node scripts/ci-test-tiers.mjs check > "$out/gate-rows.log" 2>&1
printf 'gate_rows=%s\n' "$?" >> "$out/validation-summary.txt"
cat "$out/validation-summary.txt"

if grep -Eq "=[1-9][0-9]*$" "$out/validation-summary.txt"; then exit 1; fi
