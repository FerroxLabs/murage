#!/usr/bin/env bash
# One pairing window on the isolated door's loopback control page. The code
# and token are single-use and only open this throwaway host. The reply goes
# to Python on stdin (never argv), and a failure never echoes it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/host.env"
curl -s -w '\n%{http_code}' -X POST -H 'Origin: http://127.0.0.1:28811' -H 'Content-Type: application/json' http://127.0.0.1:28811/pairing |
  python3 -c '
import json, sys
body, _, status = sys.stdin.read().rpartition("\n")
host = sys.argv[1]
try:
    reply = json.loads(body)
except ValueError:
    reply = None
if not isinstance(reply, dict) or not reply.get("code") or not reply.get("token"):
    error = reply.get("error") if isinstance(reply, dict) else None
    detail = f": {error}" if isinstance(error, str) and len(error) < 200 else ""
    sys.exit(f"mint failed: HTTP {status}{detail}")
token = reply["token"]
print(json.dumps({"address": f"{host}:8444", "code": reply["code"], "url": f"https://{host}:8444/enter#{token}"}))
' "$TS_HOST"
