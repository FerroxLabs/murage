#!/usr/bin/env bash
set -u
set -o pipefail
evidence=docs/verification/rec-pause2
cleanup() {
  local generated_modules=/work/node_modules
  rm -rf "${generated_modules:?}"
}
trap cleanup EXIT

node scripts/copy-review.mjs record "$evidence/sol-bundle.json" --reviewer sol --slug 1019-pause-rereview --date 2026-11-11 > "$evidence/record.log" 2>&1
record_rc=$?
cat "$evidence/record.log"
if [ "$record_rc" -ne 0 ]; then exit "$record_rc"; fi

node docs/verification/rec-pause/verify-record.mjs > "$evidence/verify-record.log" 2>&1
verify_rc=$?
cat "$evidence/verify-record.log"

pnpm exec vitest run scripts/copy-review.test.mjs scripts/generate-locale.test.mjs src/locales/copy-final.test.ts src/lib/i18n.test.ts src/lib/i18n-intl-locale.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile="$evidence/tests.json" > "$evidence/tests.log" 2>&1
tests_rc=$?
tail -15 "$evidence/tests.log"

node scripts/generate-locale.mjs --check > "$evidence/locale-check.log" 2>&1
locale_rc=$?
printf 'record=%s verify=%s tests=%s locale_check=%s\n' "$record_rc" "$verify_rc" "$tests_rc" "$locale_rc" | tee "$evidence/status.log"
if [ "$verify_rc" -ne 0 ]; then exit "$verify_rc"; fi
if [ "$tests_rc" -ne 0 ]; then exit "$tests_rc"; fi
exit "$locale_rc"
