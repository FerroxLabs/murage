#!/bin/bash
set -u
E=lane-evidence/connector-reconnect-r2
node_modules/.bin/vitest run server/connector-reconnect-r2.test.ts server/connector-reconnect-r2-workflow.test.ts server/connector-reconnect-r2-reactive-workflow.test.ts server/connector-health-scheduled-workflow.test.ts server/connector-health-workflow.test.ts server/connected-app-health.test.ts server/connector-health-store.test.ts server/composio-identity.test.ts server/composio-recovery.test.ts server/composio-inventory-cache.test.ts server/composio-flux-broker.test.ts server/composio-retry-1010.test.ts server/connected-app-operations.test.ts server/connected-app-receipts.test.ts server/bot-access.test.ts server/notify.test.ts server/tray-summary.test.ts server/route-policy.test.ts src/components/ReconnectAppsBanner.test.ts src/lib/deep-link.test.ts shared/connected-app-readonly.test.ts > "$E/final-regressions.log" 2>&1
V=$?
node --import ./server/testing/safe-wipe-preload.mjs --test electron/mcp-signin.node-test.mjs electron/connector-notice-receipts.node-test.mjs > "$E/final-electron.log" 2>&1
N=$?
node_modules/.bin/tsc -p tsconfig.server.json --noEmit > "$E/final-types-server.log" 2>&1
S=$?
node_modules/.bin/tsc -b > "$E/final-types-ui.log" 2>&1
U=$?
printf 'vitest=%s\nelectron=%s\nserver-types=%s\nui-types=%s\n' "$V" "$N" "$S" "$U" > "$E/final-status.txt"
cat "$E/final-status.txt"
[ "$V" = 0 ] && [ "$N" = 0 ] && [ "$S" = 0 ] && [ "$U" = 0 ]
