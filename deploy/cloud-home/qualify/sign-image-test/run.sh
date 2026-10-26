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
if command -v shellcheck >/dev/null 2>&1; then
    echo "== shellcheck"; shellcheck -x "$here/../../sign-image.sh" "$here/../../image-release-check.sh" "$here"/*.sh "$here/mocks/curl" "$here/mocks/aws" "$here/mocks/ssh" || rc=1
else
    echo "== shellcheck: not installed here (skipped)"
fi
exit "$rc"
