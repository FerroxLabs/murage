from pathlib import Path
import os, subprocess
files = ['server/contracts.ts', 'server/drivers/pi.ts', 'server/drivers/codex.ts', 'server/drivers/acp/core.ts', 'server/index.ts', 'server/reply-action-guard.ts', 'shared/reply-action-claims.ts']
current = {p: Path(p).read_bytes() for p in files}
try:
    for p in files:
        Path(p).write_bytes(subprocess.check_output(['git', 'show', 'HEAD:' + p]))
    with open('.audit3/before-final.log', 'w') as log:
        result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', '.audit3/vitest.config.mjs', 'server/engine-swap-round3.test.ts', 'server/engine-swap-fold.test.ts', '-t', 'N9|N10|N11|N12'], stdout=log, stderr=subprocess.STDOUT)
    print('Old-code regression exit:', result.returncode)
finally:
    for p, data in current.items():
        Path(p).write_bytes(data)
