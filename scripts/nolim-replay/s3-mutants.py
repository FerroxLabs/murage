#!/usr/bin/env python3
"""Run only through it-remote.sh in an isolated --network none fixture."""
import json
import os
from pathlib import Path
import subprocess

root = Path.cwd()
if not Path('/.dockerenv').exists():
    raise SystemExit('container required')
out = root / '.s3-evidence'
out.mkdir(exist_ok=True)
mutants = [
 ('X6', 'server/drivers/acp/core.ts', 'server/drivers/acp-posture-switch.test.ts',
  lambda s: s.replace('await syncSessionPosture(sessionId);', '/* X6 setup only */;').replace('postureModes = sessionResult?.modes;\n              /* X6 setup only */;', 'postureModes = sessionResult?.modes;\n              await syncSessionPosture(sessionId);')),
 ('claude-mode', 'server/drivers/claude.ts', 'server/drivers/claude-posture-switch.test.ts',
  lambda s: s.replace('const permissionMode = config.permissionMode ===', 'const permissionMode = (turn.permissionNow?.() ?? turn).askLevel ? "default" : config.permissionMode ===')),
 ('agy-captured', 'server/drivers/antigravity.ts', 'server/drivers/antigravity-posture-switch.test.ts',
  lambda s: s.replace('const askStop = () => askFromFolderHooks || ((turn.permissionNow?.() ?? turn).askLevel === true && !skipPermissions);', 'const capturedAsk = (turn.permissionNow?.() ?? turn).askLevel === true;\n      const askStop = () => askFromFolderHooks || (capturedAsk && !skipPermissions);')),
 ('muse-captured', 'server/drivers/muse-code.ts', 'server/drivers/muse-code-posture-switch.test.ts',
  lambda s: s.replace('if ((turn.permissionNow?.() ?? turn).stopLine) return "full";', 'if (turn.stopLine) return "full";')),
 ('release-skip', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/release.test.mjs',
  lambda s: s.replace('if (release &&', 'if (false &&')),
 ('duplicate-card', 'scripts/no-limits-live/counts.mjs', 'scripts/no-limits-live/release.test.mjs',
  lambda s: s.replace("cards.length !== 1", "!cards.length")),
 ('routine-parity', 'scripts/nolim-replay/replay-decide.mjs', 'scripts/nolim-replay/replay-contract.test.mjs',
  lambda s: s.replace("replayActor(row).kind === 'other'", "replayActor(row).kind !== 'owner'")),
]
results = []
for name, path, test, mutate in mutants:
    target = root / path
    original = target.read_text()
    changed = mutate(original)
    if original == changed:
        raise SystemExit('mutant anchor missing: ' + name)
    try:
        target.write_text(changed)
        run = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', test, '--maxWorkers=1'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        log = run.stdout.decode(errors='replace')
        (out / ('mutant-' + name + '.log')).write_text(log)
        results.append({'mutant': name, 'test': test, 'exit': run.returncode, 'killed': run.returncode == 1 and 'AssertionError' in log})
    finally:
        target.write_text(original)
(out / 'mutants.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
raise SystemExit(0 if all(r['killed'] for r in results) else 1)
