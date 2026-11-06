#!/usr/bin/env bash
# UX-L-FB-TABLE: both feedback tables must match, every train.
#   app copy    shared/feedback-fixed.json
#   Worker copy cloudflare/control-plane/src/feedback-fixed.json
# usage: feedback-table-check.sh <app> <worker>
#   each side is a file path, or "ref:<git-ref>" (read from the current repo with git show).
# exit 0 = identical JSON; 1 = differ (prints which keys); 2 = a side is missing or not JSON.
# Read-only. Needs git (only for ref:) and python3.
set -uo pipefail
APP_PATH="shared/feedback-fixed.json"
WORKER_PATH="cloudflare/control-plane/src/feedback-fixed.json"
[ $# -eq 2 ] || { echo "usage: $0 <app-file|ref:REF> <worker-file|ref:REF>" >&2; exit 2; }
tmp="$(mktemp -d)"; trap 'rm -rf "${tmp:?}"' EXIT
fetch() { # side-name spec path-in-repo out
  case "$2" in
    ref:*) git show "${2#ref:}:$3" > "$4" 2>/dev/null || { echo "MISSING: $1 copy not found at ${2#ref:}:$3" >&2; return 2; } ;;
    *) [ -f "$2" ] && cp "$2" "$4" || { echo "MISSING: $1 copy not found at $2" >&2; return 2; } ;;
  esac
}
fetch app "$1" "$APP_PATH" "$tmp/app.json" || exit 2
fetch worker "$2" "$WORKER_PATH" "$tmp/worker.json" || exit 2
python3 -I - "$tmp/app.json" "$tmp/worker.json" <<'PY'
import json, sys
def load(p, name):
    try:
        return json.load(open(p))
    except Exception as e:
        print(f"NOT JSON: {name} copy: {e}", file=sys.stderr); sys.exit(2)
a, w = load(sys.argv[1], "app"), load(sys.argv[2], "worker")
if a == w:
    print("FEEDBACK-TABLES MATCH"); sys.exit(0)
print("FEEDBACK-TABLES DIFFER (Worker must be deployed first; the server refuses what is not in its table)")
if isinstance(a, dict) and isinstance(w, dict):
    for k in sorted(set(a) | set(w)):
        if a.get(k) == w.get(k) and (k in a) == (k in w): continue
        if k not in w: print(f"  key {k!r}: only in app")
        elif k not in a: print(f"  key {k!r}: only in Worker")
        elif isinstance(a[k], dict) and isinstance(w[k], dict):
            for s in sorted(set(a[k]) | set(w[k])):
                if a[k].get(s) != w[k].get(s) or (s in a[k]) != (s in w[k]):
                    print(f"  {k}.{s}: app={a[k].get(s, '<absent>')!r} worker={w[k].get(s, '<absent>')!r}")
        else: print(f"  key {k!r}: values differ")
sys.exit(1)
PY
