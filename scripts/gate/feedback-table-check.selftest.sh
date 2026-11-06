#!/usr/bin/env bash
# Proves feedback-table-check.sh passes on a match and FAILS on seeded mismatches. Run in a container, not the Mac.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; chk="$here/feedback-table-check.sh"
d="$(mktemp -d)"; trap 'rm -rf "${d:?}"' EXIT
cat > "$d/a.json" <<'J'
{"words":["one","two","three"],"titles":{"today":"Today","chats":"Chats"}}
J
cp "$d/a.json" "$d/same.json"
# key order must not matter
echo '{"titles":{"chats":"Chats","today":"Today"},"words":["one","two","three"]}' > "$d/reordered.json"
echo '{"words":["one","two","three"],"titles":{"today":"Today"}}' > "$d/missing-label.json"
echo '{"words":["one","two","three"],"titles":{"today":"Today","chats":"Chat"}}' > "$d/changed-label.json"
echo 'not json' > "$d/bad.json"
fail=0
expect() { # name want-rc args...
  local n="$1" want="$2"; shift 2; "$chk" "$@" >"$d/out" 2>&1; local rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $n (rc=$rc)"; else echo "FAIL $n: want rc=$want got $rc"; cat "$d/out"; fail=1; fi
}
expect identical            0 "$d/a.json" "$d/same.json"
expect key-order-ignored    0 "$d/a.json" "$d/reordered.json"
expect label-missing-worker 1 "$d/a.json" "$d/missing-label.json"
expect label-changed        1 "$d/a.json" "$d/changed-label.json"
expect worker-file-absent   2 "$d/a.json" "$d/nope.json"
expect worker-not-json      2 "$d/a.json" "$d/bad.json"
grep -q "titles.chats" <(bash "$chk" "$d/a.json" "$d/changed-label.json" 2>&1) && echo "ok   diff names the label" || { echo "FAIL diff did not name the label"; fail=1; }
[ $fail = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"
exit $fail
