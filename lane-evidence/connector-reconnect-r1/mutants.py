#!/usr/bin/env python3
"""Run inside the network-none test container against the final tree.
Each mutation is restored in finally; diffs, commands and RED output are evidence.
"""
from pathlib import Path
import difflib
import json
import hashlib
import os
import subprocess

out = Path('lane-evidence/connector-reconnect-r1')
vt = ['node_modules/.bin/vitest', 'run']
nt = ['node', '--import', './server/testing/safe-wipe-preload.mjs', '--test']
cases = [
 ('P1-1-expiry', 'server/composio.ts', [
  ('account.expiresAt !== undefined && account.expiresAt <= Date.now()', 'false && account.expiresAt !== undefined && account.expiresAt <= Date.now()')],
  vt + ['server/connected-app-health.test.ts', '-t', 'ACTIVE inventory cannot hide'], 'expected undefined to deeply equal'),
 ('P1-1-mcp', 'electron/mcp-signin/refresher.mjs', [
  ('if (!oauth?.accessToken && !oauth?.refreshToken) { cancelTimer(name); return; }', 'if (!oauth?.refreshToken) { cancelTimer(name); return; }')],
  nt + ['--test-name-pattern=idle access token without refresh', 'electron/mcp-signin.node-test.mjs'], 'known expiry must arm a timer'),
 ('P1-2-renewal', 'server/composio.ts', [
  ('const sameOwner = previousWasFlux', 'const sameOwner = false && previousWasFlux'),
  ('if (access && access === flux && typeof proof', 'if (false && access && access === flux && typeof proof')],
  vt + ['server/connected-app-health.test.ts', '-t', 'verified same-owner proactive renewal'], '// Object.is equality'),
 ('P1-3-attribution', 'server/composio.ts', [
  ('return inventory.filter(a => aliases.includes(a.id) || (a.alias && aliases.includes(a.alias)));', 'return inventory;')],
  vt + ['server/connected-app-health.test.ts', '-t', 'reconnecting A never implicates'], 'expected [ { id:'),
 ('P1-4-receipt', 'electron/attention-main.mjs', [
  ('deps.connectorReceipts?.failed?.(record.home, record.deliveryId);', '/* mutant: keep the failed delivery receipt */')],
  nt + ['--test-name-pattern=receipt requires show confirmation', 'electron/attention-delivery.node-test.mjs'], 'late failure revokes delivery'),
 ('P2-5-unchanged', 'server/connector-health-store.ts', [
  ('if (!mark || (!(patch.accounts && !mark.accountIncidents) && Object.entries(patch).every(([key, value]) => JSON.stringify(mark[key as keyof AppHealthMark]) === JSON.stringify(value)))) return false;', 'if (!mark) return false;')],
  vt + ['server/connected-app-health.test.ts', '-t', 'one inventory check writes once'], 'unchanged 10: expected 1 to be +0'),
 ('P2-6-recovery', 'server/composio.ts', [
  ('      clearNeedsReconnect(owner, slug);\n      if (retire.length)', '      /* mutant: retain the incident after verified recovery */\n      if (retire.length)')],
  vt + ['server/connector-health-scheduled-workflow.test.ts'], 'to deeply equal []'),
]
assert float(Path('/proc/loadavg').read_text().split()[0]) < 85
results = []
sources = sorted({case[1] for case in cases} | {'server/index.ts', 'server/connected-app-health.ts', 'electron/mcp-signin/service.mjs', 'electron/managed-composio.mjs', 'electron/main.mjs'})
hashes = {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in sources}
(out / 'mutant-source-sha256.json').write_text(json.dumps(hashes, indent=2))
for name, file, replacements, command, assertion in cases:
    assert float(Path('/proc/loadavg').read_text().split()[0]) < 85
    path = Path(file)
    original_stat = path.stat()
    original = path.read_text()
    artifacts = {name: (out / name).read_bytes() for name in ['scheduled-workflow.json', 'scheduled-fixture.log'] if (out / name).exists()}
    mutant = original
    for before, after in replacements:
        assert mutant.count(before) == 1, (name, before, mutant.count(before))
        mutant = mutant.replace(before, after)
    (out / f'mutant-{name}.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), mutant.splitlines(True), fromfile=f'a/{file}', tofile=f'b/{file}')))
    (out / f'mutant-{name}.command.json').write_text(json.dumps(command))
    try:
        path.write_text(mutant)
        with (out / f'mutant-{name}.log').open('w') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=260)
        log = (out / f'mutant-{name}.log').read_text()
        killed = result.returncode != 0 and assertion in log
        results.append({'mutant': name, 'exit': result.returncode, 'RED_assertion': assertion, 'killed': killed})
        print(name, 'KILLED' if killed else 'NOT QUALIFIED', flush=True)
    finally:
        path.write_text(original)
        os.utime(path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    # The workflow writes its observation artifact even on failure. Keep its
    # mutant observation separate from the unmutated acceptance observation.
    if name == 'P2-6-recovery':
        for artifact in ['scheduled-workflow.json', 'scheduled-fixture.log']:
            (out / artifact).rename(out / f'mutant-P2-6-{artifact}')
            if artifact in artifacts: (out / artifact).write_bytes(artifacts[artifact])
(out / 'mutant-status.json').write_text(json.dumps(results, indent=2))
assert all(result['killed'] for result in results), results
assert hashes == {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in sources}
