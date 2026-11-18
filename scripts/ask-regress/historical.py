"""Run unchanged product archives with the same fake-engine API approval probe."""
import json, os, pathlib, shutil, subprocess, sys, tarfile, time
phase = sys.argv[1]
work = pathlib.Path('/work')
root = pathlib.Path('/tmp') / ('ask-regress-' + phase)
root.mkdir()
with tarfile.open(work / 'evidence/ask-regress/raw' / (phase + '.tar')) as archive:
    archive.extractall(root)
for name in ['server/askcards-budget-api.test.ts', 'scripts/smoothness/smooth-config.mjs', 'scripts/smoothness/budgets.json']:
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(work / name, target)
config = root.parent / ('ask-regress-gitconfig-' + phase)
config.write_text('')
env = {**os.environ, 'GIT_CONFIG_GLOBAL': str(config), 'GIT_CONFIG_SYSTEM': str(config)}
for args in [['init'], ['add', '-f', '.'], ['-c', 'user.name=ci', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Historical product fixture']]:
    subprocess.run(['git', *args], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
os.symlink('/work/node_modules', root / 'node_modules')
out = work / 'evidence/ask-regress/raw' / phase
out.mkdir(exist_ok=True)
env['ASKCARDS_EVIDENCE_DIR'] = str(out)
start = time.time()
with (out / 'vitest.log').open('w') as log:
    result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'server/askcards-budget-api.test.ts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(out / 'vitest.json')], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
(out / 'exit.json').write_text(json.dumps({'phase': phase, 'exit': result.returncode, 'seconds': time.time()-start}) + '\n')
sys.exit(result.returncode)
