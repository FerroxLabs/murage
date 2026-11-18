#!/bin/bash
set -u
E=lane-evidence/connector-reconnect-r3
node_modules/.bin/vitest run server/connector-reconnect-r3-preflight.test.ts server/connector-reconnect-r3-attribution.test.ts server/connector-reconnect-r3-schedule.test.ts server/connected-app-health.test.ts server/connector-reconnect-r2.test.ts server/connector-health-store.test.ts server/composio-identity.test.ts server/composio-recovery.test.ts server/composio-inventory-cache.test.ts server/composio-flux-broker.test.ts server/composio-retry-1010.test.ts server/connected-app-operations.test.ts server/connected-app-receipts.test.ts server/bot-access.test.ts shared/connected-app-calls.test.ts shared/connected-app-readonly.test.ts src/components/PluginsPanel.test.ts --reporter=verbose > "$E/green.log" 2>&1
V=$?
# These launchVerificationServer workflows use only a fake engine and loopback
# broker. Preserve historical evidence and archive this run under r3.
python3 - <<'PY'
from pathlib import Path
import subprocess
root=Path('lane-evidence/connector-reconnect-r2')
paths=[root/name for name in ['scheduled-workflow.json','scheduled-fixture.log','reactive-workflow.json','reactive-fixture.log']]
original={p:p.read_bytes() if p.exists() else None for p in paths}
try:
 with Path('lane-evidence/connector-reconnect-r3/workflows.log').open('w') as log:
  result=subprocess.run(['node_modules/.bin/vitest','run','server/connector-reconnect-r2-workflow.test.ts','server/connector-reconnect-r2-reactive-workflow.test.ts','--reporter=verbose'],stdout=log,stderr=subprocess.STDOUT)
 for p in paths:
  if p.exists(): (Path('lane-evidence/connector-reconnect-r3')/p.name).write_bytes(p.read_bytes())
 Path('lane-evidence/connector-reconnect-r3/workflow-exit.txt').write_text(str(result.returncode)+'\n')
finally:
 for p,data in original.items():
  if data is not None:p.write_bytes(data)
  elif p.exists():p.unlink()
PY
W=$(cat "$E/workflow-exit.txt")
node_modules/.bin/tsc -b > "$E/types-ui.log" 2>&1
U=$?
node_modules/.bin/tsc -p tsconfig.server.json > "$E/types-server.log" 2>&1
S=$?
node_modules/.bin/tsc -p tools/flux-stream-conformance/tsconfig.json > "$E/types-conformance.log" 2>&1
C=$?
printf 'regressions=%s\nworkflows=%s\nui-types=%s\nserver-types=%s\nconformance-types=%s\n' "$V" "$W" "$U" "$S" "$C" > "$E/final-status.txt"
cat "$E/final-status.txt"
[ "$V" = 0 ] && [ "$W" = 0 ] && [ "$U" = 0 ] && [ "$S" = 0 ] && [ "$C" = 0 ]
