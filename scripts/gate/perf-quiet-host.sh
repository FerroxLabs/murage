#!/usr/bin/env bash
# C6: run in the candidate's prepared, isolated Linux test container. Bind the
# host's timing-lock directory at the same path so flock is shared by all legs.
# MAIN RULING 1115-PUB-HYGIENE: lock path comes from MURAGE_TIMING_LOCK.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
sha=unknown
load=unknown
result=FAIL
receipt() { printf 'PERF-QUIET-HOST sha=%s load=%s result=%s\n' "$sha" "$load" "$result"; }
trap receipt EXIT
# No positional filters/extra CLI options: a C6 receipt covers the entire tag.
[[ $# == 0 ]] || { echo 'REFUSED: perf-quiet-host.sh takes no filters or arguments' >&2; exit 2; }
sha=$(git rev-parse HEAD)
exec 9>"${MURAGE_TIMING_LOCK:-/tmp/murage-timing.lock}"
flock -x 9
export MURAGE_PERF_QUIET_HOST=1
check_load() {
  load=$(node --input-type=module -e 'import { loadavg } from "node:os"; console.log(loadavg()[0]);')
  node --input-type=module - "$load" <<'JS'
import { perfBudgetDecision } from "./scripts/gate/perf-budget.mjs";
const decision = perfBudgetDecision(process.env, Number(process.argv[2]));
if (decision.mode !== "enforced") { console.error(decision.message); process.exit(1); }
JS
}
check_load
mkdir -p node_modules/.cache
report_dir=$(mktemp -d "$root/node_modules/.cache/perf-quiet-host.XXXXXX")
# Keep the JSON as reviewable evidence (including a failed or skipped bound).
echo "C6 report: $report_dir/results.json"
node node_modules/vitest/vitest.mjs run --tags-filter=perf-budget --no-file-parallelism \
  --reporter=default --reporter=json --outputFile.json="$report_dir/results.json"
check_load
node --input-type=module - "$report_dir/results.json" <<'JS'
import { readFileSync } from "node:fs";
import { assertPerfReport } from "./scripts/gate/perf-budget.mjs";
const count = assertPerfReport(JSON.parse(readFileSync(process.argv[2], "utf8")));
console.log(`C6: ${count} perf-budget tests enforced and green`);
JS
result=PASS
