#!/bin/bash
set -u
E=lane-evidence/connector-reconnect-r2
node_modules/.bin/vitest run server/connector-reconnect-r2.test.ts server/connector-reconnect-r2-workflow.test.ts server/connector-reconnect-r2-reactive-workflow.test.ts server/composio-inventory-cache.test.ts server/connected-app-operations.test.ts server/composio.test.ts server/connected-app-health.test.ts src/components/ReconnectAppsBanner.test.ts > "$E/final-followup.log" 2>&1
V=$?
node_modules/.bin/tsc -p tsconfig.server.json --noEmit > "$E/final-types-server.log" 2>&1
S=$?
node_modules/.bin/tsc -b > "$E/final-types-ui.log" 2>&1
U=$?
python3 "$E/mutants.py" > "$E/mutants-run.log" 2>&1
M=$?
printf 'vitest=%s\nserver-types=%s\nui-types=%s\nmutants=%s\n' "$V" "$S" "$U" "$M" > "$E/followup-status.txt"
cat "$E/followup-status.txt"
[ "$V" = 0 ] && [ "$S" = 0 ] && [ "$U" = 0 ] && [ "$M" = 0 ]
