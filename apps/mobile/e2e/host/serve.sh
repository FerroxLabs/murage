#!/usr/bin/env bash
# Adds ONLY https :8444 -> the isolated door, and on `down` removes it and
# proves the Serve config is byte-for-byte what it was (Phase 0 cleanup rule).
# Sean's own Serve entries are never named here, let alone changed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/tailscale-cli.sh"

# serve_json has F       exit 0 when config F has anything on :8444 (TCP, Web,
#                        Funnel, a foreground session).
# serve_json ours F      exit 0 when everything F has on :8444 is exactly our
#                        HTTPS proxy to http://127.0.0.1:28813, and nothing else.
# serve_json same A B    exit 0 when A minus its :8444 entries is exactly B minus
#                        its :8444 entries, so nothing else moved.
serve_json() {
  python3 - "$@" <<'PY'
import json, sys
def load(path):
    with open(path) as f:
        text = f.read().strip()
    return json.loads(text) if text else {}
def mine(key):
    return key == "8444" or key.endswith(":8444")
def entries(node, path=()):
    if isinstance(node, dict):
        for k, v in node.items():
            if mine(str(k)):
                yield path + (str(k),), v
            else:
                yield from entries(v, path + (str(k),))
    elif isinstance(node, list):
        for v in node:
            yield from entries(v, path)
def strip(node):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if mine(str(k)):
                continue
            v = strip(v)
            if v in ({}, None) and node[k] not in ({}, None):
                continue
            out[k] = v
        return out
    if isinstance(node, list):
        return [strip(v) for v in node]
    return node
def ours(config):
    found = list(entries(config))
    web = [v for p, v in found if p[:1] == ("Web",) and len(p) == 2]
    for p, v in found:
        if p == ("TCP", "8444") and isinstance(v, dict) and v.get("HTTPS") is True:
            continue
        if p[:1] == ("Web",) and len(p) == 2 and v == {"Handlers": {"/": {"Proxy": "http://127.0.0.1:28813"}}}:
            continue
        return False
    return bool(web)
mode, files = sys.argv[1], [load(f) for f in sys.argv[2:]]
if mode == "has":
    sys.exit(0 if list(entries(files[0])) else 1)
if mode == "ours":
    sys.exit(0 if ours(files[0]) else 1)
sys.exit(0 if strip(files[0]) == strip(files[1]) else 1)
PY
}

loud() {
  echo "!!! tailscale serve: $1" >&2
  echo "!!! compare $HERE/serve-before.json with the live 'tailscale serve status --json' by hand." >&2
  exit 1
}

case ${1:?up|down} in
  up)
    # The snapshot is written aside and only moved into place once it is known
    # to be a config without :8444: a refused up never touches the proof.
    "$TS" serve status --json > "$HERE/serve-candidate.json"
    # An open cycle (a snapshot not yet closed by down) is never overwritten:
    # already up, or an up/down that stopped half way. down closes it.
    if [[ -f "$HERE/serve-before.json" ]]; then
      state="an earlier up did not finish"
      serve_json has "$HERE/serve-candidate.json" && state="already up: :8444 is live"
      rm -f "$HERE/serve-candidate.json"
      echo "refusing: $state (serve-before.json exists). Run serve.sh down first. Nothing was changed." >&2
      exit 1
    fi
    if serve_json has "$HERE/serve-candidate.json"; then
      rm -f "$HERE/serve-candidate.json"
      echo "refusing: something already serves :8444. Nothing was changed." >&2
      exit 1
    fi
    mv "$HERE/serve-candidate.json" "$HERE/serve-before.json"
    "$TS" serve --bg --https=8444 http://127.0.0.1:28813
    "$TS" serve status --json > "$HERE/serve-during.json"
    serve_json ours "$HERE/serve-during.json" || loud ":8444 is not exactly our proxy after serve --bg"
    serve_json same "$HERE/serve-during.json" "$HERE/serve-before.json" \
      || { "$TS" serve --https=8444 off || true; loud "entries other than :8444 changed during up; :8444 was removed again"; }
    echo "serving https://:8444 -> http://127.0.0.1:28813 (everything else untouched)"
    ;;
  down)
    "$TS" serve status --json > "$HERE/serve-now.json"
    # Refuse before any change unless :8444 is absent or exactly ours.
    if serve_json has "$HERE/serve-now.json" && ! serve_json ours "$HERE/serve-now.json"; then
      rm -f "$HERE/serve-now.json"
      loud ":8444 is live but is not the isolated door's proxy to 127.0.0.1:28813. Nothing was changed."
    fi
    if [[ ! -f "$HERE/serve-before.json" ]]; then
      rm -f "$HERE/serve-now.json"
      loud "no open cycle (no serve-before.json; run serve.sh up first). Nothing was changed."
    fi
    if serve_json has "$HERE/serve-now.json"; then
      "$TS" serve --https=8444 off
    fi
    rm -f "$HERE/serve-now.json" "$HERE/serve-during.json"
    "$TS" serve status --json > "$HERE/serve-after.json"
    if diff "$HERE/serve-before.json" "$HERE/serve-after.json"; then
      echo "tailscale serve restored exactly"
    elif [[ "$(tr -d ' \t\r\n' < "$HERE/serve-before.json")" == "$(tr -d ' \t\r\n' < "$HERE/serve-after.json")" ]]; then
      echo "tailscale serve restored exactly (whitespace aside)"
    else
      loud "the config after down is NOT the config before up"
    fi
    # Close the cycle: a later down finds no snapshot and refuses.
    mv "$HERE/serve-before.json" "$HERE/serve-restored.json"
    ;;
  *) echo "usage: serve.sh up|down" >&2; exit 2 ;;
esac
