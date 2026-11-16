#!/usr/bin/env python3
"""Kill the relay-bypass mutant using the isolated, inert HTTP/SSE fixture."""
import json
from pathlib import Path
import subprocess

if not Path('/.dockerenv').exists():
    raise SystemExit('container required')
root = Path.cwd()
target = root / 'server/drivers/antigravity.ts'
original = target.read_text()
anchor = 'if (relayWanted) {'
assert anchor in original
out = root / '.s3-evidence' / 'agy-wipe-mutant'
out.mkdir(parents=True, exist_ok=True)
command = ['node', '--experimental-strip-types', 'scripts/no-limits-live/antigravity-home-wipe.mjs']
try:
    target.write_text(original.replace(anchor, 'if (false && relayWanted) {', 1))
    red_command = command + [str(out / 'red')]
    red = subprocess.run(red_command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    (out / 'red.log').write_bytes(red.stdout)
finally:
    target.write_text(original)
green_command = command + [str(out / 'green')]
green = subprocess.run(green_command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
(out / 'green.log').write_bytes(green.stdout)
red_report = json.loads((out / 'red/result.json').read_text())
green_report = json.loads((out / 'green/result.json').read_text())
killed = (red.returncode == 1 and red_report.get('cardCount') == 0
          and 'exactly one product card' in red_report.get('error', '')
          and green.returncode == 0 and green_report.get('cardCount') == 1)
(out / 'result.json').write_text(json.dumps({
    'mutant': 'Antigravity relay bypass', 'killed': killed,
    'red': {'command': red_command, 'exit': red.returncode},
    'green': {'command': green_command, 'exit': green.returncode},
}, indent=2) + '\n')
print('KILLED' if killed else 'NOT KILLED')
raise SystemExit(0 if killed else 1)
