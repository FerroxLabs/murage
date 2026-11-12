#!/usr/bin/env bash
# Invoke ONLY inside it-remote.sh's --network none test container.
set -euo pipefail
label=${1:?base-or-tip}
case "$label" in
 base) pin=292df98d80a1c55db3e6f232166fc05162b632ab ;;
 tip) pin=aaa0e298e8c3abc8dc4156a7b3b4b48d5bba0157 ;;
 *) exit 2 ;;
esac
root=/work
evidence="$root/.nolim-evidence/bld3"
source="$evidence/pins/$label"
ln -sfn "$root/node_modules" "$source/node_modules"
cd "$source"
export NOLIM_MEASURED_SHA="$pin"
NOLIM_CHARACTERIZATION="$evidence/$label-judge.json" node --experimental-strip-types server/testing/nolim-replay/characterize.ts > "$evidence/$label-judge.log" 2>&1
NOLIM_SYNTHETIC_RESULTS="$evidence/$label" node node_modules/vitest/vitest.mjs run server/no-limits-replay-bld3-api.test.ts --maxWorkers=1 > "$evidence/$label.log" 2>&1
if [[ "$label" == base ]]; then
 cd "$root"
 python3 scripts/nolim-replay/extract.test.py > "$evidence/python-final.log" 2>&1
 python3 scripts/nolim-replay/runner.test.py >> "$evidence/python-final.log" 2>&1
 node node_modules/vitest/vitest.mjs run server/nolim-transport-bld3.test.ts server/nolim-containment-bld3.test.ts server/nolim-r13b-oracle-bld3.test.ts server/no-limits-replay-1019.test.ts server/no-limits-replay-1019-api.test.ts -t 'No limits replay admission|independent literal oracle|append-only replay observer|inert transport isolation|separately declared synthetic fault controls|replays structured|Claude raw|process-wide|clean owner run' --maxWorkers=1 > "$evidence/unit-final.log" 2>&1
 NOLIM_TEST_CONTAINMENT=1 NOLIM_CONTAINMENT_EVIDENCE="$evidence/containment-final.jsonl" node node_modules/vitest/vitest.mjs run server/nolim-containment-bld3.test.ts server/no-limits-replay-bld3-api.test.ts -t 'process-wide|acp key-read' --maxWorkers=1 > "$evidence/containment-final.log" 2>&1
fi
