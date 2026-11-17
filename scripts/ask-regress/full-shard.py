"""Eight complete Vitest shards; each compares isolated baseline and fixed source."""
import json, os, pathlib, re, shutil, subprocess, sys, tarfile, time
shard = int(sys.argv[1])
assert 1 <= shard <= 8
phases = sys.argv[2:] or ['base', 'head']
assert phases in [['base', 'head'], ['base'], ['head']]
work = pathlib.Path('/work')
inputs = work / os.environ.get('ASK_FULL_EVIDENCE_ROOT', 'evidence/ask-regress/raw')
publish = inputs / 'full'
label = os.environ.get('ASK_FULL_EVIDENCE_LABEL')
if label:
    assert re.fullmatch('[a-z0-9-]+', label)
out = pathlib.Path('/tmp') / f'ask-full-output-{shard}'
out.mkdir(parents=True, exist_ok=True)
for phase in phases:
    root = pathlib.Path('/tmp') / f'ask-full-{phase}-{shard}'
    root.mkdir()
    with tarfile.open(inputs / (phase + '.tar.gz')) as archive:
        archive.extractall(root)
        source_commit=archive.pax_headers.get('comment')
    config = root.parent / f'ask-full-gitconfig-{phase}-{shard}'
    config.write_text('')
    home = root.parent / f'ask-full-home-{phase}-{shard}'
    home.mkdir()
    env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home), 'GIT_CONFIG_GLOBAL': str(config), 'GIT_CONFIG_SYSTEM': str(config)}
    for args in [['init'], ['add', '-f', '.'], ['-c', 'user.name=ci', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Exact source fixture']]:
        subprocess.run(['git', *args], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
    os.symlink('/work/node_modules', root / 'node_modules')
    inventory_path = out / f'{phase}-{shard}.inventory.json'
    with (out / f'{phase}-{shard}.inventory.log').open('w') as log:
        listed = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--shard', f'{shard}/8', '--json', str(inventory_path)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    if listed.returncode or not inventory_path.exists():
        raise RuntimeError(f'Cannot inventory complete {phase} shard {shard}')
    all_path = out / f'{phase}.inventory-all.raw.json'
    with (out / f'{phase}.inventory-all.log').open('w') as log:
        all_listed = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json', str(all_path)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    if all_listed.returncode or not all_path.exists():
        raise RuntimeError(f'Cannot inventory all {phase} files')
    files = [str(pathlib.Path(row['file']).relative_to(root)) for row in json.loads(all_path.read_text())]
    (out / f'{phase}.inventory-all.json').write_text(json.dumps({'sourceCommit': source_commit, 'files': sorted(files)})+'\n')
    start = time.time()
    result_path = out / f'{phase}-{shard}.json'
    with (out / f'{phase}-{shard}.log').open('w') as log:
        result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', '--shard', f'{shard}/8', '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(result_path)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    (out / f'{phase}-{shard}.exit.json').write_text(json.dumps({'sourceCommit': source_commit, 'phase': phase, 'shard': shard, 'exit': result.returncode, 'seconds': time.time()-start, 'report': result_path.exists()}) + '\n')

# Publish once all source uploads are long finished; the container owns every
# report privately throughout execution, so another workspace sync cannot delete it.
destinations = ([work / 'evidence/ask-regress/raw' / label] if label else []) + [publish]
for destination in destinations:
    destination.mkdir(parents=True,exist_ok=True)
    for artifact in out.iterdir():
        shutil.copy2(artifact,destination/artifact.name)
