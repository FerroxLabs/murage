#!/usr/bin/env bash
# Run only in the job's it-remote.sh --network none container.
set -euo pipefail
base=292df98d80a1c55db3e6f232166fc05162b632ab
tip=${1:?full-tip-sha}
[[ "$tip" =~ ^[a-f0-9]{40}$ ]] || exit 3
root=/work
evidence=$root/.nolim-evidence/bld4
for pin in "$base" "$tip"; do
 source=$evidence/api-pins/$pin
 ln -sfn "$root/node_modules" "$source/node_modules"
 cd "$source"
 NOLIM_MEASURED_SHA="$pin" NOLIM_SYNTHETIC_RESULTS="$evidence/routine-$pin" \
  node node_modules/vitest/vitest.mjs run server/no-limits-replay-bld3-api.test.ts \
  -t 'manual-routine|scheduled-routine' --maxWorkers=1 > "$evidence/routine-$pin.log" 2>&1
done
cd "$root"
python3 - "$evidence" "$base" "$tip" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]);base,tip=sys.argv[2:]
rows=[]
for route in ('manual-routine','scheduled-routine'):
 a,b=[json.loads((root/('routine-'+sha)/('route-'+route+'.json')).read_text()) for sha in (base,tip)]
 assert a['sourceSha']==base and b['sourceSha']==tip
 same=all(a[k]==b[k] for k in ('cards','reasonCounts','decisions'))
 rows.append({'route':route,'baseCards':a['cards'],'tipCards':b['cards'],'baseReasons':a['reasonCounts'],'tipReasons':b['reasonCounts'],'parity':same})
report={'kind':'synthetic','baseSha':base,'tipSha':tip,'rows':rows,'releaseEligible':False}
(root/'routine-parity.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'syntheticRoutes':len(rows),'parityPassed':sum(r['parity'] for r in rows),'parityFailed':sum(not r['parity'] for r in rows),'report':str(root/'routine-parity.json')}))
sys.exit(0 if all(r['parity'] for r in rows) else 2)
PY
