#!/usr/bin/env python3
"""Record only synthetic requests; no socket or application is contacted."""
import json
import os
import sys
from pathlib import Path

assert len(sys.argv) == 3 and sys.argv[1] == 'wipe-exec'
request = json.loads(sys.argv[2])
assert request['v'] == 1 and request['kind'] == 'wipe-exec'
assert 'token' not in request
assert request['threadId'] == 'fixture-turn'
with Path(os.environ['WG_CALL_LOG']).open('a') as output:
    output.write(json.dumps(request) + '\n')
# Deliberate protocol noise must never reach a successful tool's output.
print('client protocol noise')
print('client diagnostic noise', file=sys.stderr)
raise SystemExit(int(os.environ.get('WG_CLIENT_EXIT', '10')))
