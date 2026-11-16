from pathlib import Path
import subprocess
out = Path('lane-evidence/connector-reconnect-r1')
path = Path('server/composio.ts')
original = path.read_bytes()
artifacts = {name: (out / name).read_bytes() for name in ['scheduled-workflow.json', 'scheduled-fixture.log'] if (out / name).exists()}
try:
    path.write_bytes((out / 'base-composio.source').read_bytes())
    with (out / 'red-workflow-base.log').open('w') as log:
        result = subprocess.run(['node_modules/.bin/vitest', 'run', 'server/connector-health-scheduled-workflow.test.ts'], stdout=log, stderr=subprocess.STDOUT, timeout=120)
    log = (out / 'red-workflow-base.log').read_text()
    assert result.returncode != 0 and 'expected +0 to be 1' in log, log[-4000:]
    print('baseline c9f99951c composio: RED expected +0 to be 1')
finally:
    path.write_bytes(original)
    for name in ['scheduled-workflow.json', 'scheduled-fixture.log']:
        if (out / name).exists(): (out / name).rename(out / f'base-{name}')
        if name in artifacts: (out / name).write_bytes(artifacts[name])
