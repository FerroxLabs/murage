#!/bin/bash
# Runs every sign-image test. Meant for a container with node, python3 and bash (no network needed).
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rc=0
echo "== node tests"; node --test "$here/sign-image.test.mjs" || rc=1
echo "== console-type tests"; python3 -I "$here/console_type_test.py" || rc=1
echo "== release check tests"; bash "$here/release-check-test.sh" || rc=1
echo "== boot closure tests"; bash "$here/boot-closure-test.sh" || rc=1
echo "== dry-run tests"; bash "$here/dry-run-test.sh" || rc=1
# sign-image.sh runs on the signing Mac, whose /bin/bash is 3.2: refuse bash-4-only features.
echo "== bash 3.2 features"
if grep -nE 'declare -[aAgilnrtux]*[An]|local -n|\b(mapfile|readarray|coproc)\b|\$\{[A-Za-z_][A-Za-z0-9_]*(\^|,)|\|&|&>>|wait -n|;;&' "$here/../../sign-image.sh"; then
    echo "FAIL: sign-image.sh uses a feature macOS bash 3.2 lacks (lines above)"; rc=1
else
    echo "ok   sign-image.sh uses no bash-4-only feature"
fi
if command -v shellcheck >/dev/null 2>&1; then
    echo "== shellcheck"; shellcheck -x "$here/../../sign-image.sh" "$here/../../image-release-check.sh" "$here"/*.sh "$here/mocks/curl" "$here/mocks/aws" "$here/mocks/ssh" || rc=1
else
    echo "== shellcheck: not installed here (skipped)"
fi
exit "$rc"
