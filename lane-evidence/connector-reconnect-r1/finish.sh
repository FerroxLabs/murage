#!/bin/bash
set -u
E=lane-evidence/connector-reconnect-r1
cat /proc/loadavg > "$E/final-load-start.txt"
[ "$(cut -d. -f1 /proc/loadavg)" -lt 85 ] || exit 75
node_modules/.bin/vitest run server/connected-app-health.test.ts server/connector-health-store.test.ts server/connector-health-workflow.test.ts server/connector-health-scheduled-workflow.test.ts server/composio-identity.test.ts server/composio-inventory-cache.test.ts electron/managed-composio.test.mjs electron/flux-composio-token.test.mjs > "$E/final-regressions.log" 2>&1
V=$?
node --import ./server/testing/safe-wipe-preload.mjs --test electron/mcp-signin.node-test.mjs electron/attention-delivery.node-test.mjs electron/connector-notice-receipts.node-test.mjs > "$E/final-electron.log" 2>&1
N=$?
node_modules/.bin/tsc -p tsconfig.server.json --noEmit > "$E/final-types.log" 2>&1
S=$?
printf 'vitest=%s\nelectron=%s\nserver-types=%s\n' "$V" "$N" "$S" > "$E/final-status.txt"
cat "$E/final-status.txt"
[ "$V" = 0 ] && [ "$N" = 0 ] && [ "$S" = 0 ] || exit 1
python3 "$E/mutants.py"
