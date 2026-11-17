#!/bin/bash
set -u
E=lane-evidence/connector-reconnect-r1
cat /proc/loadavg > "$E/load-start.txt"
[ "$(cut -d. -f1 /proc/loadavg)" -lt 85 ] || exit 75
node_modules/.bin/vitest run server/connector-health-scheduled-workflow.test.ts server/connector-health-workflow.test.ts server/connected-app-health.test.ts server/connector-health-store.test.ts electron/managed-composio.test.mjs electron/flux-composio-token.test.mjs server/composio-identity.test.ts server/composio-recovery.test.ts server/composio-inventory-cache.test.ts server/composio-flux-broker.test.ts server/notify.test.ts server/notification-preferences.test.ts server/mobile-push-outbox.test.ts server/mobile-push-detail.test.ts server/mobile-push-routes.test.ts server/tray-summary.test.ts server/route-policy.test.ts src/components/ReconnectAppsBanner.test.ts src/lib/deep-link.test.ts src/lib/notify.test.ts > "$E/acceptance-vitest.log" 2>&1
V=$?
node --import ./server/testing/safe-wipe-preload.mjs --test electron/mcp-signin.node-test.mjs electron/connector-notice-receipts.node-test.mjs electron/attention-router.node-test.mjs electron/attention-main.node-test.mjs electron/attention-delivery.node-test.mjs electron/attention-items.node-test.mjs electron/attention-window-host.node-test.mjs electron/attention-surfaces.node-test.mjs electron/background-lifecycle.node-test.mjs > "$E/acceptance-electron.log" 2>&1
N=$?
node_modules/.bin/tsc -p tsconfig.server.json --noEmit > "$E/acceptance-types-server.log" 2>&1
S=$?
node_modules/.bin/tsc -b > "$E/acceptance-types-ui.log" 2>&1
U=$?
printf 'vitest=%s\nelectron=%s\nserver-types=%s\nui-types=%s\n' "$V" "$N" "$S" "$U" > "$E/acceptance-status.txt"
cat "$E/acceptance-status.txt"
[ "$V" = 0 ] && [ "$N" = 0 ] && [ "$S" = 0 ] && [ "$U" = 0 ]
